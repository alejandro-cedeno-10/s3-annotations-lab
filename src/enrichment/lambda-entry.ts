import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { createBedrockClassifier } from "./classifier";
import { createEnrichmentHandler } from "./handler";

const region = process.env["AWS_REGION"];

export const handler = createEnrichmentHandler({
  s3: new S3Client({ region }),
  classifier: createBedrockClassifier(new BedrockRuntimeClient({ region })),
  now: () => new Date(),
});
