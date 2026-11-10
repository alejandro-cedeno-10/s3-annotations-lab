import { DeleteObjectsCommand, DeleteBucketCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteRoleCommand, DeleteRolePolicyCommand, IAMClient, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand } from "@aws-sdk/client-iam";
import {
  DeleteNamespaceCommand,
  DeleteTableBucketCommand,
  DeleteTableCommand,
  ListNamespacesCommand,
  ListTableBucketsCommand,
  ListTablesCommand,
  S3TablesClient,
} from "@aws-sdk/client-s3tables";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createResourceOps, type OpsClients } from "../src/lab/aws-resource-ops";
import type { ManifestEntry } from "../src/lab/manifest";

const s3Mock = mockClient(S3Client);
const iamMock = mockClient(IAMClient);
const tablesMock = mockClient(S3TablesClient);

const clients = {
  s3: new S3Client({ region: "us-east-1" }),
  iam: new IAMClient({ region: "us-east-1" }),
  s3tables: new S3TablesClient({ region: "us-east-1" }),
} as unknown as OpsClients;

const ops = createResourceOps(clients);
const entry = (type: ManifestEntry["type"], id: string, details: Record<string, string> = {}): ManifestEntry => ({
  type,
  id,
  details,
  recordedAt: "2026-11-10T00:00:00.000Z",
});

beforeEach(() => {
  s3Mock.reset();
  iamMock.reset();
  tablesMock.reset();
});

describe("bucket removal", () => {
  it("deletes every version and delete marker before the bucket", async () => {
    s3Mock
      .on(ListObjectVersionsCommand)
      .resolvesOnce({
        Versions: [
          { Key: "a", VersionId: "1" },
          { Key: "a", VersionId: "2" },
        ],
        DeleteMarkers: [{ Key: "b", VersionId: "3" }],
      })
      .resolvesOnce({});
    s3Mock.on(DeleteObjectsCommand).resolves({});
    s3Mock.on(DeleteBucketCommand).resolves({});

    await expect(ops["s3-bucket"].remove(entry("s3-bucket", "bkt"))).resolves.toBe("deleted");

    const deleted = s3Mock.commandCalls(DeleteObjectsCommand)[0]?.args[0].input.Delete?.Objects;
    expect(deleted).toEqual([
      { Key: "a", VersionId: "1" },
      { Key: "a", VersionId: "2" },
      { Key: "b", VersionId: "3" },
    ]);
    const order = s3Mock.calls().map((call) => call.args[0].constructor.name);
    expect(order.at(-1)).toBe("DeleteBucketCommand");
  });

  it("fails loudly when DeleteObjects reports per-key errors", async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({ Versions: [{ Key: "a", VersionId: "1" }] });
    s3Mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Code: "AccessDenied", Key: "a" }] });
    await expect(ops["s3-bucket"].remove(entry("s3-bucket", "bkt"))).rejects.toThrow(/AccessDenied/);
    expect(s3Mock.commandCalls(DeleteBucketCommand)).toHaveLength(0);
  });
});

describe("role removal", () => {
  it("removes inline policies before deleting the role", async () => {
    iamMock.on(ListRolePoliciesCommand).resolves({ PolicyNames: ["p1", "p2"] });
    iamMock.on(ListAttachedRolePoliciesCommand).resolves({ AttachedPolicies: [] });
    iamMock.on(DeleteRolePolicyCommand).resolves({});
    iamMock.on(DeleteRoleCommand).resolves({});
    await ops["iam-role"].remove(entry("iam-role", "role-1"));
    const order = iamMock.calls().map((call) => call.args[0].constructor.name);
    expect(order).toEqual(["ListRolePoliciesCommand", "DeleteRolePolicyCommand", "DeleteRolePolicyCommand", "ListAttachedRolePoliciesCommand", "DeleteRoleCommand"]);
  });
});

describe("table bucket removal", () => {
  it("skips the AWS-managed table bucket when it existed before the lab", async () => {
    await expect(ops["s3tables-table-bucket"].remove(entry("s3tables-table-bucket", "aws-s3", { createdByLab: "false" }))).resolves.toBe("skipped");
    expect(tablesMock.calls()).toHaveLength(0);
  });

  it("skips when the lab created it but other namespaces remain", async () => {
    tablesMock.on(ListTableBucketsCommand).resolves({ tableBuckets: [{ name: "aws-s3", arn: "arn:test", ownerAccountId: "0", createdAt: new Date() }] });
    tablesMock.on(ListNamespacesCommand).resolves({ namespaces: [{ namespace: ["other"], createdAt: new Date(), createdBy: "x", ownerAccountId: "0" }] });
    await expect(ops["s3tables-table-bucket"].remove(entry("s3tables-table-bucket", "aws-s3", { createdByLab: "true" }))).resolves.toBe("skipped");
    expect(tablesMock.commandCalls(DeleteTableBucketCommand)).toHaveLength(0);
  });

  it("deletes it when the lab created it and it is empty", async () => {
    tablesMock.on(ListTableBucketsCommand).resolves({ tableBuckets: [{ name: "aws-s3", arn: "arn:test", ownerAccountId: "0", createdAt: new Date() }] });
    tablesMock.on(ListNamespacesCommand).resolves({ namespaces: [] });
    tablesMock.on(DeleteTableBucketCommand).resolves({});
    await expect(ops["s3tables-table-bucket"].remove(entry("s3tables-table-bucket", "aws-s3", { createdByLab: "true" }))).resolves.toBe("deleted");
  });
});

describe("namespace removal", () => {
  it("deletes the tables of the namespace, then the namespace", async () => {
    tablesMock.on(ListTableBucketsCommand).resolves({ tableBuckets: [{ name: "aws-s3", arn: "arn:test", ownerAccountId: "0", createdAt: new Date() }] });
    tablesMock.on(ListTablesCommand).resolves({
      tables: [{ name: "annotation", namespace: ["b_x"], type: "aws", tableARN: "t", createdAt: new Date(), modifiedAt: new Date() }],
    });
    tablesMock.on(DeleteTableCommand).resolves({});
    tablesMock.on(DeleteNamespaceCommand).resolves({});
    await expect(ops["s3tables-namespace"].remove(entry("s3tables-namespace", "b_x"))).resolves.toBe("deleted");
    const order = tablesMock.calls().map((call) => call.args[0].constructor.name);
    expect(order).toEqual(["ListTableBucketsCommand", "ListTablesCommand", "DeleteTableCommand", "DeleteNamespaceCommand"]);
    expect(tablesMock.commandCalls(ListTablesCommand)[0]?.args[0].input.namespace).toBe("b_x");
  });

  it("reports already-gone when the table bucket does not exist", async () => {
    tablesMock.on(ListTableBucketsCommand).resolves({ tableBuckets: [] });
    await expect(ops["s3tables-namespace"].remove(entry("s3tables-namespace", "b_x"))).resolves.toBe("already-gone");
  });
});
