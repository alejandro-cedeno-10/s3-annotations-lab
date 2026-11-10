import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { AnnotationStore } from "../annotations/annotation-store";
import { isPreconditionFailed } from "../aws/error-info";
import { AI_ANNOTATIONS } from "../config/lab-config";
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
  | { status: "skipped-stale"; key: string; stage: "read" | "write" };

export interface EnrichmentDependencies {
  s3: S3Client;
  classifier: DocumentClassifier;
  now: () => Date;
}

type Stage = "read" | "write";

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
  const body = await guardPrecondition("read", () =>
    s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: head.VersionId ?? versionId, IfMatch: etag })),
  );
  const text = (await body.Body?.transformToString("utf-8")) ?? "";
  return { text, etag, versionId: head.VersionId ?? versionId };
}

/**
 * Builds the EventBridge "Object Created" handler.
 *
 * The ETag read at the start is sent as ObjectIfMatch on the write, so a classification is never
 * attached to a version that changed while the model was running; that case is reported as
 * "skipped-stale" because the new upload emits its own event. The condition protects against object
 * replacement only: it does not serialize writers of the same annotation name.
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
      throw error;
    }
  };
}
