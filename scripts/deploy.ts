import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { CreateLogGroupCommand, PutRetentionPolicyCommand } from "@aws-sdk/client-cloudwatch-logs";
import { PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { CreateRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  AddPermissionCommand,
  CreateFunctionCommand,
  waitUntilFunctionActiveV2,
} from "@aws-sdk/client-lambda";
import {
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import {
  EVENT_RULE,
  labNames,
  labTags,
  LAMBDA_SETTINGS,
  LAMBDA_ZIP_PATH,
  MANIFEST_PATH,
  REGION,
  ROLE_PROPAGATION,
  type LabNames,
} from "../src/config/lab-config";
import { createLabClients, type LabClients } from "../src/lab/aws-clients";
import { createBucketInput, createFunctionInput, createLogGroupInput, createRoleInput, putRuleInput } from "../src/lab/create-inputs";
import { executionPolicy, lambdaTrustPolicy } from "../src/lab/iam-documents";
import { Manifest } from "../src/lab/manifest";
import { callerAccountId, requireValue } from "../src/lab/account-guard";
import { isLambdaRoleNotAssumable, retry } from "../src/lab/retry";

const RUN_ID_BYTES = 4;
const LAMBDA_ACTIVE_WAIT_SECONDS = 120;

interface DeployState {
  clients: LabClients;
  manifest: Manifest;
  names: LabNames;
  tags: Record<string, string>;
  accountId: string;
}

async function createBucket({ clients, manifest, names, tags }: DeployState): Promise<void> {
  manifest.record({ type: "s3-bucket", id: names.bucket });
  const { s3 } = clients;
  await s3.send(new CreateBucketCommand(createBucketInput(names, tags)));
  await s3.send(new PutBucketVersioningCommand({ Bucket: names.bucket, VersioningConfiguration: { Status: "Enabled" } }));
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: names.bucket,
      ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
    }),
  );
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: names.bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: names.bucket,
      NotificationConfiguration: { EventBridgeConfiguration: {} },
    }),
  );
  console.log(`Bucket ready: ${names.bucket}`);
}

async function createExecutionRole(state: DeployState): Promise<string> {
  const { clients, manifest, names, tags, accountId } = state;
  manifest.record({ type: "iam-role", id: names.executionRole });
  const role = await clients.iam.send(
    new CreateRoleCommand(createRoleInput(names.executionRole, lambdaTrustPolicy(), tags)),
  );
  manifest.record({
    type: "iam-role-policy",
    id: `${names.executionRole}/${names.executionPolicy}`,
    details: { roleName: names.executionRole, policyName: names.executionPolicy },
  });
  await clients.iam.send(
    new PutRolePolicyCommand({
      RoleName: names.executionRole,
      PolicyName: names.executionPolicy,
      PolicyDocument: JSON.stringify(executionPolicy({ bucket: names.bucket, accountId, logGroup: names.logGroup })),
    }),
  );
  console.log(`Execution role ready: ${names.executionRole}`);
  return requireValue(role.Role?.Arn, "the execution role ARN");
}

async function createLogGroup({ clients, manifest, names, tags }: DeployState): Promise<void> {
  manifest.record({ type: "log-group", id: names.logGroup });
  await clients.logs.send(new CreateLogGroupCommand(createLogGroupInput(names, tags)));
  await clients.logs.send(
    new PutRetentionPolicyCommand({ logGroupName: names.logGroup, retentionInDays: LAMBDA_SETTINGS.logRetentionDays }),
  );
  console.log(`Log group ready: ${names.logGroup}`);
}

async function createFunction(state: DeployState, roleArn: string): Promise<string> {
  const { clients, manifest, names, tags } = state;
  if (!existsSync(LAMBDA_ZIP_PATH)) {
    throw new Error(`${LAMBDA_ZIP_PATH} not found. Run "pnpm build:lambda" first.`);
  }
  const zip = readFileSync(LAMBDA_ZIP_PATH);
  manifest.record({ type: "lambda-function", id: names.functionName });
  const created = await retry(
    () =>
      clients.lambda.send(
        new CreateFunctionCommand(createFunctionInput(names, roleArn, zip, tags)),
      ),
    { ...ROLE_PROPAGATION, shouldRetry: isLambdaRoleNotAssumable },
  );
  await waitUntilFunctionActiveV2(
    { client: clients.lambda, maxWaitTime: LAMBDA_ACTIVE_WAIT_SECONDS },
    { FunctionName: names.functionName },
  );
  console.log(`Function ready: ${names.functionName}`);
  return requireValue(created.FunctionArn, "the function ARN");
}

async function createRule(state: DeployState, functionArn: string): Promise<void> {
  const { clients, manifest, names, tags } = state;
  manifest.record({ type: "events-rule", id: names.ruleName });
  const rule = await clients.events.send(
    new PutRuleCommand(putRuleInput(names, tags)),
  );
  await clients.lambda.send(
    new AddPermissionCommand({
      FunctionName: names.functionName,
      StatementId: "allow-eventbridge-rule",
      Action: "lambda:InvokeFunction",
      Principal: "events.amazonaws.com",
      SourceArn: rule.RuleArn,
    }),
  );
  await clients.events.send(
    new PutTargetsCommand({ Rule: names.ruleName, Targets: [{ Id: EVENT_RULE.targetId, Arn: functionArn }] }),
  );
  console.log(`Rule ready: ${names.ruleName}`);
}

async function main(): Promise<void> {
  const clients = createLabClients();
  const runId = randomBytes(RUN_ID_BYTES).toString("hex");
  const accountId = await callerAccountId(clients.sts);
  const manifest = Manifest.create(MANIFEST_PATH, runId, REGION, accountId);
  const state: DeployState = {
    clients,
    manifest,
    names: labNames(runId),
    tags: labTags(runId),
    accountId,
  };
  console.log(`Deploying run ${runId} in ${REGION}`);
  await createBucket(state);
  const roleArn = await createExecutionRole(state);
  await createLogGroup(state);
  const functionArn = await createFunction(state, roleArn);
  await createRule(state, functionArn);
  console.log(`Done. ${manifest.entries.length} resources recorded in ${MANIFEST_PATH}`);
}

await main();
