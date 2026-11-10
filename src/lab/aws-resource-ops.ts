import { DeleteRuleCommand, DescribeRuleCommand, ListTargetsByRuleCommand, RemoveTargetsCommand } from "@aws-sdk/client-eventbridge";
import {
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
} from "@aws-sdk/client-iam";
import { DeleteFunctionCommand, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { DeleteLogGroupCommand, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  DeleteBucketCommand,
  DeleteBucketMetadataConfigurationCommand,
  DeleteObjectsCommand,
  GetBucketMetadataConfigurationCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import {
  DeleteNamespaceCommand,
  DeleteTableBucketCommand,
  DeleteTableCommand,
  GetNamespaceCommand,
  ListNamespacesCommand,
  ListTableBucketsCommand,
  ListTablesCommand,
} from "@aws-sdk/client-s3tables";
import { isNotFoundError } from "../aws/error-info";
import { METADATA_TABLES } from "../config/lab-config";
import type { LabClients } from "./aws-clients";
import type { ManifestEntry } from "./manifest";
import type { RemovalOutcome, ResourceOps, ResourceOpsTable } from "./teardown";

export type OpsClients = Pick<LabClients, "s3" | "iam" | "lambda" | "events" | "logs" | "s3tables">;

const DELETE_BATCH_SIZE = 1000;
const CREATED_BY_LAB = "true";

const present = async (probe: () => Promise<unknown>): Promise<boolean> => {
  try {
    await probe();
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
};

const detail = (entry: ManifestEntry, key: string): string => {
  const value = entry.details[key];
  if (!value) throw new Error(`Manifest entry ${entry.type}:${entry.id} lacks detail "${key}"`);
  return value;
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

async function emptyBucket(clients: OpsClients, bucket: string): Promise<void> {
  for (;;) {
    const page = await clients.s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((item) => ({
      Key: item.Key as string,
      VersionId: item.VersionId,
    }));
    if (objects.length === 0) return;
    for (const batch of chunk(objects, DELETE_BATCH_SIZE)) {
      const result = await clients.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
      if (result.Errors?.length) {
        throw new Error(`DeleteObjects reported ${result.Errors.length} errors, first: ${result.Errors[0]?.Code}`);
      }
    }
  }
}

const bucketOps = (clients: OpsClients): ResourceOps => ({
  async remove(entry) {
    await emptyBucket(clients, entry.id);
    await clients.s3.send(new DeleteBucketCommand({ Bucket: entry.id }));
    return "deleted";
  },
  exists: (entry) => present(() => clients.s3.send(new HeadBucketCommand({ Bucket: entry.id }))),
});

const roleOps = (clients: OpsClients): ResourceOps => ({
  async remove(entry) {
    const inline = await clients.iam.send(new ListRolePoliciesCommand({ RoleName: entry.id }));
    for (const policyName of inline.PolicyNames ?? []) {
      await clients.iam.send(new DeleteRolePolicyCommand({ RoleName: entry.id, PolicyName: policyName }));
    }
    const attached = await clients.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: entry.id }));
    for (const policy of attached.AttachedPolicies ?? []) {
      await clients.iam.send(new DetachRolePolicyCommand({ RoleName: entry.id, PolicyArn: policy.PolicyArn }));
    }
    await clients.iam.send(new DeleteRoleCommand({ RoleName: entry.id }));
    return "deleted";
  },
  exists: (entry) => present(() => clients.iam.send(new GetRoleCommand({ RoleName: entry.id }))),
});

const rolePolicyOps = (clients: OpsClients): ResourceOps => ({
  async remove(entry) {
    await clients.iam.send(
      new DeleteRolePolicyCommand({ RoleName: detail(entry, "roleName"), PolicyName: detail(entry, "policyName") }),
    );
    return "deleted";
  },
  exists: (entry) =>
    present(() =>
      clients.iam.send(new GetRolePolicyCommand({ RoleName: detail(entry, "roleName"), PolicyName: detail(entry, "policyName") })),
    ),
});

const functionOps = (clients: OpsClients): ResourceOps => ({
  async remove(entry) {
    await clients.lambda.send(new DeleteFunctionCommand({ FunctionName: entry.id }));
    return "deleted";
  },
  exists: (entry) => present(() => clients.lambda.send(new GetFunctionCommand({ FunctionName: entry.id }))),
});

const logGroupExists = async (clients: OpsClients, name: string): Promise<boolean> => {
  const page = await clients.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
  return (page.logGroups ?? []).some((group) => group.logGroupName === name);
};

const logGroupOps = (clients: OpsClients): ResourceOps => ({
  async remove(entry) {
    await clients.logs.send(new DeleteLogGroupCommand({ logGroupName: entry.id }));
    return "deleted";
  },
  exists: (entry) => logGroupExists(clients, entry.id),
});

const ruleOps = (clients: OpsClients): ResourceOps => ({
  async remove(entry) {
    const targets = await clients.events.send(new ListTargetsByRuleCommand({ Rule: entry.id }));
    const ids = (targets.Targets ?? []).map((target) => target.Id as string);
    if (ids.length > 0) {
      await clients.events.send(new RemoveTargetsCommand({ Rule: entry.id, Ids: ids }));
    }
    await clients.events.send(new DeleteRuleCommand({ Name: entry.id }));
    return "deleted";
  },
  exists: (entry) => present(() => clients.events.send(new DescribeRuleCommand({ Name: entry.id }))),
});

const metadataConfigOps = (clients: OpsClients): ResourceOps => ({
  async remove(entry) {
    await clients.s3.send(new DeleteBucketMetadataConfigurationCommand({ Bucket: entry.id }));
    return "deleted";
  },
  exists: (entry) => present(() => clients.s3.send(new GetBucketMetadataConfigurationCommand({ Bucket: entry.id }))),
});

async function findAwsTableBucketArn(clients: OpsClients): Promise<string | undefined> {
  const page = await clients.s3tables.send(
    new ListTableBucketsCommand({ type: "aws", prefix: METADATA_TABLES.tableBucketName }),
  );
  return (page.tableBuckets ?? []).find((bucket) => bucket.name === METADATA_TABLES.tableBucketName)?.arn;
}

async function removeNamespace(clients: OpsClients, namespace: string): Promise<RemovalOutcome> {
  const tableBucketARN = await findAwsTableBucketArn(clients);
  if (!tableBucketARN) return "already-gone";
  const tables = await clients.s3tables.send(new ListTablesCommand({ tableBucketARN, namespace }));
  for (const table of tables.tables ?? []) {
    await clients.s3tables.send(new DeleteTableCommand({ tableBucketARN, namespace, name: table.name }));
  }
  await clients.s3tables.send(new DeleteNamespaceCommand({ tableBucketARN, namespace }));
  return "deleted";
}

const namespaceOps = (clients: OpsClients): ResourceOps => ({
  remove: (entry) => removeNamespace(clients, entry.id),
  async exists(entry) {
    const tableBucketARN = await findAwsTableBucketArn(clients);
    if (!tableBucketARN) return false;
    return present(() => clients.s3tables.send(new GetNamespaceCommand({ tableBucketARN, namespace: entry.id })));
  },
});

const createdByLab = (entry: ManifestEntry): boolean => entry.details["createdByLab"] === CREATED_BY_LAB;

/**
 * The AWS-managed table bucket is shared by every metadata configuration in the account. It is
 * removed only when this lab created it and it holds no other namespace.
 */
const tableBucketOps = (clients: OpsClients): ResourceOps => ({
  async remove(entry) {
    if (!createdByLab(entry)) return "skipped";
    const tableBucketARN = await findAwsTableBucketArn(clients);
    if (!tableBucketARN) return "already-gone";
    const namespaces = await clients.s3tables.send(new ListNamespacesCommand({ tableBucketARN }));
    if ((namespaces.namespaces ?? []).length > 0) return "skipped";
    await clients.s3tables.send(new DeleteTableBucketCommand({ tableBucketARN }));
    return "deleted";
  },
  async exists(entry) {
    if (!createdByLab(entry)) return false;
    return (await findAwsTableBucketArn(clients)) !== undefined;
  },
});

export function createResourceOps(clients: OpsClients): ResourceOpsTable {
  return {
    "s3-bucket": bucketOps(clients),
    "iam-role": roleOps(clients),
    "iam-role-policy": rolePolicyOps(clients),
    "lambda-function": functionOps(clients),
    "log-group": logGroupOps(clients),
    "events-rule": ruleOps(clients),
    "bucket-metadata-config": metadataConfigOps(clients),
    "s3tables-table-bucket": tableBucketOps(clients),
    "s3tables-namespace": namespaceOps(clients),
  };
}
