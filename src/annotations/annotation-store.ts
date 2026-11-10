import {
  DeleteObjectAnnotationCommand,
  GetObjectAnnotationCommand,
  ListObjectAnnotationsCommand,
  PutObjectAnnotationCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assertAnnotationName } from "./annotation-name";
import { assertAnnotationPayload, type PayloadInput } from "./annotation-payload";

export interface ObjectRef {
  key: string;
  versionId?: string;
}

export interface PutOptions {
  objectIfMatch?: string;
  versionId?: string;
  validateLocally?: boolean;
}

export interface PutResult {
  etag?: string;
  objectVersionId?: string;
}

export interface AnnotationValue {
  text: string;
  etag?: string;
  lastModified?: Date;
  objectVersionId?: string;
}

export interface AnnotationSummary {
  name: string;
  size: number;
  etag?: string;
  lastModified: Date;
}

/**
 * Typed wrapper over the four annotation operations for a single bucket.
 * Local validation is on by default; experiments switch it off to observe the
 * server verdict for inputs the client would reject.
 */
export class AnnotationStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, name: string, payload: PayloadInput, options: PutOptions = {}): Promise<PutResult> {
    if (options.validateLocally !== false) {
      assertAnnotationName(name);
      assertAnnotationPayload(payload);
    }
    const response = await this.s3.send(
      new PutObjectAnnotationCommand({
        Bucket: this.bucket,
        Key: key,
        AnnotationName: name,
        AnnotationPayload: payload,
        ObjectIfMatch: options.objectIfMatch,
        VersionId: options.versionId,
      }),
    );
    return { etag: response.ETag, objectVersionId: response.ObjectVersionId };
  }

  async putJson(key: string, name: string, value: unknown, options: PutOptions = {}): Promise<PutResult> {
    return this.put(key, name, JSON.stringify(value), options);
  }

  async get(ref: ObjectRef, name: string): Promise<AnnotationValue> {
    const response = await this.s3.send(
      new GetObjectAnnotationCommand({
        Bucket: this.bucket,
        Key: ref.key,
        AnnotationName: name,
        VersionId: ref.versionId,
      }),
    );
    const text = (await response.AnnotationPayload?.transformToString("utf-8")) ?? "";
    return {
      text,
      etag: response.ETag,
      lastModified: response.LastModified,
      objectVersionId: response.ObjectVersionId,
    };
  }

  async getJson<T = unknown>(ref: ObjectRef, name: string): Promise<{ value: T; etag?: string }> {
    const annotation = await this.get(ref, name);
    return { value: JSON.parse(annotation.text) as T, etag: annotation.etag };
  }

  async list(ref: ObjectRef, prefix?: string): Promise<AnnotationSummary[]> {
    const summaries: AnnotationSummary[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectAnnotationsCommand({
          Bucket: this.bucket,
          Key: ref.key,
          VersionId: ref.versionId,
          AnnotationPrefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const entry of page.Annotations ?? []) {
        summaries.push({
          name: entry.AnnotationName ?? "",
          size: entry.Size ?? 0,
          etag: entry.ETag,
          lastModified: entry.LastModified ?? new Date(0),
        });
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
    return summaries;
  }

  async delete(ref: ObjectRef, name: string, objectIfMatch?: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectAnnotationCommand({
        Bucket: this.bucket,
        Key: ref.key,
        AnnotationName: name,
        VersionId: ref.versionId,
        ObjectIfMatch: objectIfMatch,
      }),
    );
  }
}
