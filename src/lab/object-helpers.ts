import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface StoredObject {
  etag: string;
  versionId?: string;
}

export async function putTextObject(s3: S3Client, bucket: string, key: string, body: string): Promise<StoredObject> {
  const response = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain" }));
  return { etag: response.ETag ?? "", versionId: response.VersionId };
}

export async function headObject(s3: S3Client, bucket: string, key: string, versionId?: string): Promise<StoredObject> {
  const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  return { etag: response.ETag ?? "", versionId: response.VersionId };
}

export async function deleteObject(s3: S3Client, bucket: string, key: string, versionId?: string): Promise<{ deleteMarker: boolean; versionId?: string }> {
  const response = await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  return { deleteMarker: response.DeleteMarker ?? false, versionId: response.VersionId };
}

export async function copyObject(
  s3: S3Client,
  bucket: string,
  sourceKey: string,
  targetKey: string,
  annotationDirective?: "COPY" | "EXCLUDE",
): Promise<StoredObject> {
  const response = await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: targetKey,
      CopySource: `${bucket}/${encodeURIComponent(sourceKey)}`,
      AnnotationDirective: annotationDirective,
    }),
  );
  return { etag: response.CopyObjectResult?.ETag ?? "", versionId: response.VersionId };
}
