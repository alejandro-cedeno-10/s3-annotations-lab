import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { AnnotationStore } from "../annotations/annotation-store";
import { isPreconditionFailed } from "../aws/error-info";
import { AI_ANNOTATIONS, CLASSIFIER_LIMITS } from "../config/lab-config";
import { toClassification } from "./classification-schema";
import type { DocumentClassifier } from "./classifier";

export const objectCreatedEventSchema = z.object({
  "detail-type": z.literal("Object Created"),
  detail: z.object({
    bucket: z.object({ name: z.string().min(1) }),
    object: z.object({ key: z.string().min(1), "version-id": z.string().optional() }),
  }),
});

export type ObjectCreatedEvent = z.infer<typeof objectCreatedEventSchema>;

export type EnrichmentOutcome =
  | { status: "annotated"; key: string; versionId?: string; etag: string }
  | { status: "skipped-stale"; key: string; stage: "read" | "write" }
  | { status: "skipped-too-large"; key: string; bytes: number };

export interface EnrichmentDependencies {
  s3: S3Client;
  classifier: DocumentClassifier;
  now: () => Date;
}

type Stage = "read" | "write";

class ObjectTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Object of ${bytes} bytes exceeds the ${CLASSIFIER_LIMITS.maxObjectBytes} byte limit`);
    this.name = "ObjectTooLargeError";
  }
}

class StaleObjectError extends Error {
  constructor(readonly stage: Stage) {
    super(`Object changed during enrichment (${stage})`);
    this.name = "StaleObjectError";
  }
}

async function guardPrecondition<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw isPreconditionFailed(error) ? new StaleObjectError(stage) : error;
  }
}

async function readObjectText(
  s3: S3Client,
  bucket: string,
  key: string,
  versionId: string | undefined,
): Promise<{ text: string; etag: string; versionId?: string }> {
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  const etag = head.ETag ?? "";
  if ((head.ContentLength ?? 0) > CLASSIFIER_LIMITS.maxObjectBytes) throw new ObjectTooLargeError(head.ContentLength ?? 0);
  const body = await guardPrecondition("read", () =>
    s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: head.VersionId ?? versionId, IfMatch: etag })),
  );
  const text = (await body.Body?.transformToString("utf-8")) ?? "";
  return { text, etag, versionId: head.VersionId ?? versionId };
}

/**
 * Builds the EventBridge "Object Created" handler.
 *
 * The version-id carried by the event is used for the read and the write; without one (unversioned
 * bucket) the handler falls back to the version HeadObject returns. With an explicit VersionId the
 * classification is attached to the version that was read, even if a newer version exists, and
 * ObjectIfMatch compares the ETag of that same version, so it does not detect a newer one. A 412
 * PreconditionFailed on read or write is reported as "skipped-stale". None of this serializes
 * writers of the same annotation name.
 */
export function createEnrichmentHandler(deps: EnrichmentDependencies) {
  return async function handle(rawEvent: unknown): Promise<EnrichmentOutcome> {
    const { detail } = objectCreatedEventSchema.parse(rawEvent);
    const bucket = detail.bucket.name;
    const key = detail.object.key;
    const store = new AnnotationStore(deps.s3, bucket);

    try {
      const source = await readObjectText(deps.s3, bucket, key, detail.object["version-id"]);
      const model = await deps.classifier.classify(source.text);
      const classification = toClassification(model, {
        generatedBy: deps.classifier.modelId,
        generatedAt: deps.now(),
      });
      const written = await guardPrecondition("write", () =>
        store.putJson(key, AI_ANNOTATIONS.classification, classification, {
          objectIfMatch: source.etag,
          versionId: source.versionId,
        }),
      );
      return { status: "annotated", key, versionId: source.versionId, etag: written.etag ?? "" };
    } catch (error) {
      if (error instanceof StaleObjectError) {
        return { status: "skipped-stale", key, stage: error.stage };
      }
      if (error instanceof ObjectTooLargeError) {
        return { status: "skipped-too-large", key, bytes: error.bytes };
      }
      throw error;
    }
  };
}
