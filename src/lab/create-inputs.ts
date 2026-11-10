import type { CreateLogGroupCommandInput } from "@aws-sdk/client-cloudwatch-logs";
import type { PutRuleCommandInput } from "@aws-sdk/client-eventbridge";
import type { CreateRoleCommandInput } from "@aws-sdk/client-iam";
import type { CreateFunctionCommandInput } from "@aws-sdk/client-lambda";
import type { CreateBucketCommandInput } from "@aws-sdk/client-s3";
import { LAMBDA_SETTINGS, type LabNames } from "../config/lab-config";
import { objectCreatedPattern } from "./event-rule";
import type { PolicyDocument } from "./iam-documents";

export type TagMap = Record<string, string>;

export const toTagList = (tags: TagMap): Array<{ Key: string; Value: string }> =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

/**
 * Inputs of every create call that supports tags. Tags travel inside the create call itself
 * because an account may reject untagged creation; tagging afterwards would already be too late.
 */
export function createBucketInput(names: LabNames, tags: TagMap): CreateBucketCommandInput {
  return { Bucket: names.bucket, CreateBucketConfiguration: { Tags: toTagList(tags) } };
}

export function createRoleInput(roleName: string, trust: PolicyDocument, tags: TagMap): CreateRoleCommandInput {
  return { RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify(trust), Tags: toTagList(tags) };
}

export function createLogGroupInput(names: LabNames, tags: TagMap): CreateLogGroupCommandInput {
  return { logGroupName: names.logGroup, tags };
}

export function createFunctionInput(names: LabNames, roleArn: string, zip: Uint8Array, tags: TagMap): CreateFunctionCommandInput {
  return {
    FunctionName: names.functionName,
    Role: roleArn,
    Runtime: LAMBDA_SETTINGS.runtime,
    Architectures: [LAMBDA_SETTINGS.architecture],
    Handler: LAMBDA_SETTINGS.handler,
    Timeout: LAMBDA_SETTINGS.timeoutSeconds,
    MemorySize: LAMBDA_SETTINGS.memoryMb,
    Code: { ZipFile: zip },
    LoggingConfig: { LogGroup: names.logGroup },
    Tags: tags,
  };
}

export function putRuleInput(names: LabNames, tags: TagMap): PutRuleCommandInput {
  return { Name: names.ruleName, EventPattern: objectCreatedPattern(names.bucket), State: "ENABLED", Tags: toTagList(tags) };
}
