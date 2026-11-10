import {
  DeleteObjectAnnotationCommand,
  GetObjectAnnotationCommand,
  ListObjectAnnotationsCommand,
  PutObjectAnnotationCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { AnnotationStore } from "../src/annotations/annotation-store";
import { InvalidAnnotationNameError } from "../src/annotations/annotation-name";
import { InvalidAnnotationPayloadError } from "../src/annotations/annotation-payload";
import { sdkBody } from "./support/fakes";

const s3Mock = mockClient(S3Client);
const store = new AnnotationStore(new S3Client({ region: "us-east-1" }), "lab-bucket");

beforeEach(() => {
  s3Mock.reset();
});

describe("AnnotationStore.put", () => {
  it("sends name, payload, ObjectIfMatch and VersionId", async () => {
    s3Mock.on(PutObjectAnnotationCommand).resolves({ ETag: '"a1"', ObjectVersionId: "v9" });
    const result = await store.put("docs/a.txt", "ai.note", "{}", { objectIfMatch: '"obj"', versionId: "v9" });
    expect(result).toEqual({ etag: '"a1"', objectVersionId: "v9" });
    expect(s3Mock.commandCalls(PutObjectAnnotationCommand)[0]?.args[0].input).toMatchObject({
      Bucket: "lab-bucket",
      Key: "docs/a.txt",
      AnnotationName: "ai.note",
      AnnotationPayload: "{}",
      ObjectIfMatch: '"obj"',
      VersionId: "v9",
    });
  });

  it("rejects bad names and payloads before any request", async () => {
    await expect(store.put("k", "aws.x", "{}")).rejects.toBeInstanceOf(InvalidAnnotationNameError);
    await expect(store.put("k", "ai.x", "")).rejects.toBeInstanceOf(InvalidAnnotationPayloadError);
    expect(s3Mock.commandCalls(PutObjectAnnotationCommand)).toHaveLength(0);
  });

  it("lets experiments bypass local validation", async () => {
    s3Mock.on(PutObjectAnnotationCommand).resolves({});
    await store.put("k", "aws.x", "{}", { validateLocally: false });
    expect(s3Mock.commandCalls(PutObjectAnnotationCommand)).toHaveLength(1);
  });

  it("serializes putJson", async () => {
    s3Mock.on(PutObjectAnnotationCommand).resolves({});
    await store.putJson("k", "ai.x", { a: 1 });
    expect(s3Mock.commandCalls(PutObjectAnnotationCommand)[0]?.args[0].input.AnnotationPayload).toBe('{"a":1}');
  });
});

describe("AnnotationStore.get and getJson", () => {
  it("reads text and metadata for a given version", async () => {
    s3Mock.on(GetObjectAnnotationCommand).resolves({ AnnotationPayload: sdkBody('{"a":1}'), ETag: '"e"' });
    const value = await store.getJson<{ a: number }>({ key: "k", versionId: "v2" }, "ai.x");
    expect(value).toEqual({ value: { a: 1 }, etag: '"e"' });
    expect(s3Mock.commandCalls(GetObjectAnnotationCommand)[0]?.args[0].input).toMatchObject({ VersionId: "v2", AnnotationName: "ai.x" });
  });
});

describe("AnnotationStore.list", () => {
  it("follows continuation tokens", async () => {
    const entry = (name: string) => ({ AnnotationName: name, Size: 3, LastModified: new Date(0) });
    s3Mock
      .on(ListObjectAnnotationsCommand)
      .resolvesOnce({ Annotations: [entry("a")], NextContinuationToken: "t1" })
      .resolvesOnce({ Annotations: [entry("b")] });
    const names = (await store.list({ key: "k" })).map((item) => item.name);
    expect(names).toEqual(["a", "b"]);
    expect(s3Mock.commandCalls(ListObjectAnnotationsCommand)[1]?.args[0].input.ContinuationToken).toBe("t1");
  });
});

describe("AnnotationStore.delete", () => {
  it("passes the conditional ETag", async () => {
    s3Mock.on(DeleteObjectAnnotationCommand).resolves({});
    await store.delete({ key: "k", versionId: "v1" }, "ai.x", '"etag"');
    expect(s3Mock.commandCalls(DeleteObjectAnnotationCommand)[0]?.args[0].input).toMatchObject({ ObjectIfMatch: '"etag"', VersionId: "v1" });
  });
});
