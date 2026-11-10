import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetObjectCommand, HeadObjectCommand, PutObjectAnnotationCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createBedrockClassifier } from "../src/enrichment/classifier";
import { classificationSchema } from "../src/enrichment/classification-schema";
import { createEnrichmentHandler } from "../src/enrichment/handler";
import { ModelOutputError } from "../src/enrichment/model-output";
import { FIXED_NOW, FakeS3Error, fencedReply, objectCreatedEvent, sdkBody } from "./support/fakes";

const s3Mock = mockClient(S3Client);
const bedrockMock = mockClient(BedrockRuntimeClient);

const handler = createEnrichmentHandler({
  s3: new S3Client({ region: "us-east-1" }),
  classifier: createBedrockClassifier(new BedrockRuntimeClient({ region: "us-east-1" })),
  now: () => FIXED_NOW,
});

const reply = (text: string) => ({ output: { message: { role: "assistant" as const, content: [{ text }] } } });

beforeEach(() => {
  s3Mock.reset();
  bedrockMock.reset();
  s3Mock.on(HeadObjectCommand).resolves({ ETag: '"etag-1"', VersionId: "v1" });
  s3Mock.on(GetObjectCommand).callsFake(() => ({ Body: sdkBody("contenido del documento") }));
  s3Mock.on(PutObjectAnnotationCommand).resolves({ ETag: '"annotation-etag"' });
  bedrockMock.on(ConverseCommand).resolves(reply(fencedReply()));
});

describe("enrichment handler: happy path", () => {
  it("reads the object, classifies it and writes ai.classification pinned to the read ETag", async () => {
    const outcome = await handler(objectCreatedEvent());
    expect(outcome).toEqual({ status: "annotated", key: "docs/sample.txt", versionId: "v1", etag: '"annotation-etag"' });

    const put = s3Mock.commandCalls(PutObjectAnnotationCommand)[0]?.args[0].input;
    expect(put).toMatchObject({
      Bucket: "lab-bucket",
      Key: "docs/sample.txt",
      AnnotationName: "ai.classification",
      ObjectIfMatch: '"etag-1"',
      VersionId: "v1",
    });
    const stored = classificationSchema.parse(JSON.parse(String(put?.AnnotationPayload)));
    expect(stored).toMatchObject({ doc_type: "invoice", review_required: true, generated_at: "2026-11-10T12:00:00.000Z" });
    expect(stored.generated_by).toBe("us.amazon.nova-lite-v1:0");
  });

  it("conditions the object read on the same ETag", async () => {
    await handler(objectCreatedEvent());
    expect(s3Mock.commandCalls(GetObjectCommand)[0]?.args[0].input.IfMatch).toBe('"etag-1"');
  });
});

describe("enrichment handler: stale ETag", () => {
  it("skips quietly when the annotation write is rejected by ObjectIfMatch", async () => {
    s3Mock.on(PutObjectAnnotationCommand).rejects(new FakeS3Error("PreconditionFailed", 412));
    await expect(handler(objectCreatedEvent())).resolves.toEqual({ status: "skipped-stale", key: "docs/sample.txt", stage: "write" });
  });

  it("skips when the object changes between head and read", async () => {
    s3Mock.on(GetObjectCommand).rejects(new FakeS3Error("PreconditionFailed", 412));
    await expect(handler(objectCreatedEvent())).resolves.toEqual({ status: "skipped-stale", key: "docs/sample.txt", stage: "read" });
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(0);
  });

  it("does not swallow unrelated errors", async () => {
    s3Mock.on(PutObjectAnnotationCommand).rejects(new FakeS3Error("AccessDenied", 403));
    await expect(handler(objectCreatedEvent())).rejects.toMatchObject({ name: "AccessDenied" });
  });
});

describe("enrichment handler: invalid input", () => {
  it("propagates invalid model output so the invocation is retried", async () => {
    bedrockMock.on(ConverseCommand).resolves(reply("no json at all"));
    await expect(handler(objectCreatedEvent())).rejects.toBeInstanceOf(ModelOutputError);
    expect(s3Mock.commandCalls(PutObjectAnnotationCommand)).toHaveLength(0);
  });

  it("rejects events that are not Object Created", async () => {
    await expect(handler({ "detail-type": "Object Deleted", detail: {} })).rejects.toThrow();
  });
});
