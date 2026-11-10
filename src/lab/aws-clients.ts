import { AthenaClient } from "@aws-sdk/client-athena";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { GlueClient } from "@aws-sdk/client-glue";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { S3TablesClient } from "@aws-sdk/client-s3tables";
import { STSClient } from "@aws-sdk/client-sts";
import { REGION } from "../config/lab-config";

export interface LabClients {
  profile: string;
  s3: S3Client;
  iam: IAMClient;
  lambda: LambdaClient;
  events: EventBridgeClient;
  logs: CloudWatchLogsClient;
  s3tables: S3TablesClient;
  sts: STSClient;
  athena: AthenaClient;
  glue: GlueClient;
  bedrock: BedrockRuntimeClient;
}

export function requireProfile(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env["AWS_PROFILE"];
  if (!profile) {
    throw new Error("Set AWS_PROFILE to the profile the lab should use. Default credentials are never used implicitly.");
  }
  return profile;
}

export function createLabClients(profile: string = requireProfile()): LabClients {
  const config = { region: REGION, profile };
  return {
    profile,
    s3: new S3Client(config),
    iam: new IAMClient(config),
    lambda: new LambdaClient(config),
    events: new EventBridgeClient(config),
    logs: new CloudWatchLogsClient(config),
    s3tables: new S3TablesClient(config),
    sts: new STSClient(config),
    athena: new AthenaClient(config),
    glue: new GlueClient(config),
    bedrock: new BedrockRuntimeClient(config),
  };
}
