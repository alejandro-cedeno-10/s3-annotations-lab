import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetObjectCommand, HeadObjectCommand, PutObjectAnnotationCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { createBedrockClassifier } from "../src/enrichment/classifier";
import { createEnrichmentHandler } from "../src/enrichment/handler";
import { fencedReply, objectCreatedEvent, sdkBody } from "../test/support/fakes";

const s3Mock = mockClient(S3Client);
const bedrockMock = mockClient(BedrockRuntimeClient);

s3Mock.on(HeadObjectCommand).resolves({ ETag: '"etag-1"', VersionId: "v1" });
s3Mock.on(GetObjectCommand).resolves({ Body: sdkBody("Factura 0001, cliente ficticio.") });
s3Mock.on(PutObjectAnnotationCommand).resolves({ ETag: '"annotation-etag"' });
bedrockMock.on(ConverseCommand).resolves({ output: { message: { role: "assistant", content: [{ text: fencedReply() }] } } });

const handler = createEnrichmentHandler({
  s3: new S3Client({ region: "us-east-1" }),
  classifier: createBedrockClassifier(new BedrockRuntimeClient({ region: "us-east-1" })),
  now: () => new Date(),
});

const outcome = await handler(objectCreatedEvent());
const put = s3Mock.commandCalls(PutObjectAnnotationCommand)[0]?.args[0].input;

console.log("Outcome:", JSON.stringify(outcome));
console.log("PutObjectAnnotation input:", JSON.stringify({ ...put, AnnotationPayload: JSON.parse(String(put?.AnnotationPayload)) }, null, 2));
