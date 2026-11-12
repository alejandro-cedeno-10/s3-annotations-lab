import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeS3Error } from "./support/fakes";
import { Manifest, RESOURCE_TYPES, type ManifestEntry, type ResourceType } from "../src/lab/manifest";
import { findLeftovers, hasFailures, runTeardown, type ResourceOps, type ResourceOpsTable } from "../src/lab/teardown";

const ACCOUNT = "111122223333";

const DEPLOY_ORDER: ReadonlyArray<[ResourceType, string]> = [
  ["s3-bucket", "s3-annotations-lab-run1"],
  ["iam-role", "s3-annotations-lab-run1-lambda-role"],
  ["iam-role-policy", "s3-annotations-lab-run1-lambda-role/policy"],
  ["log-group", "/aws/lambda/s3-annotations-lab-run1-enrichment"],
  ["lambda-function", "s3-annotations-lab-run1-enrichment"],
  ["events-rule", "s3-annotations-lab-run1-object-created"],
  ["s3tables-table-bucket", "aws-s3"],
  ["s3tables-namespace", "b_s3-annotations-lab-run1"],
  ["bucket-metadata-config", "s3-annotations-lab-run1"],
];

let manifest: Manifest;

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), "lab-manifest-"));
  manifest = Manifest.create(join(directory, "manifest.json"), "run1", "us-east-1", ACCOUNT);
  for (const [type, id] of DEPLOY_ORDER) manifest.record({ type, id });
});

const opsRecording = (
  calls: string[],
  behavior: (entry: ManifestEntry) => Promise<"deleted" | "already-gone" | "skipped"> = async () => "deleted",
): ResourceOpsTable =>
  Object.fromEntries(
    RESOURCE_TYPES.map((type): [ResourceType, ResourceOps] => [
      type,
      {
        remove: async (entry) => {
          calls.push(`${entry.type}:${entry.id}`);
          return behavior(entry);
        },
        exists: async () => false,
      },
    ]),
  ) as ResourceOpsTable;

describe("runTeardown", () => {
  it("deletes manifest entries newest first so dependents go before parents", async () => {
    const calls: string[] = [];
    await runTeardown(manifest, opsRecording(calls));
    expect(calls).toEqual([
      "bucket-metadata-config:s3-annotations-lab-run1",
      "s3tables-namespace:b_s3-annotations-lab-run1",
      "s3tables-table-bucket:aws-s3",
      "events-rule:s3-annotations-lab-run1-object-created",
      "lambda-function:s3-annotations-lab-run1-enrichment",
      "log-group:/aws/lambda/s3-annotations-lab-run1-enrichment",
      "iam-role-policy:s3-annotations-lab-run1-lambda-role/policy",
      "iam-role:s3-annotations-lab-run1-lambda-role",
      "s3-bucket:s3-annotations-lab-run1",
    ]);
  });

  it("touches nothing that is not in the manifest", async () => {
    const calls: string[] = [];
    await runTeardown(manifest, opsRecording(calls));
    expect(calls).toHaveLength(manifest.entries.length);
  });

  it("treats NotFound as success so a second run is idempotent", async () => {
    const calls: string[] = [];
    const results = await runTeardown(
      manifest,
      opsRecording(calls, async () => {
        throw new FakeS3Error("NoSuchEntity", 404);
      }),
    );
    expect(results.every((result) => result.outcome === "already-gone")).toBe(true);
    expect(hasFailures(results)).toBe(false);
  });

  it("keeps going after a failure and reports it", async () => {
    const calls: string[] = [];
    const results = await runTeardown(
      manifest,
      opsRecording(calls, async (entry) => {
        if (entry.type === "lambda-function") throw new FakeS3Error("ResourceConflictException", 409);
        return "deleted";
      }),
    );
    expect(calls).toHaveLength(manifest.entries.length);
    expect(hasFailures(results)).toBe(true);
    expect(results.filter((result) => result.outcome === "failed")).toHaveLength(1);
  });

  it("reports each result through the callback", async () => {
    const seen: string[] = [];
    await runTeardown(manifest, opsRecording([]), (result) => seen.push(result.outcome));
    expect(seen).toHaveLength(manifest.entries.length);
  });
});

describe("findLeftovers", () => {
  const existsTable = (exists: (entry: ManifestEntry) => Promise<boolean>): ResourceOpsTable =>
    Object.fromEntries(
      RESOURCE_TYPES.map((type): [ResourceType, ResourceOps] => [type, { remove: async () => "deleted", exists }]),
    ) as ResourceOpsTable;

  it("reports nothing when every resource is gone", async () => {
    const leftovers = await findLeftovers(manifest, existsTable(async () => false));
    expect(leftovers.filter((item) => item.exists)).toHaveLength(0);
  });

  it("flags resources that still exist", async () => {
    const leftovers = await findLeftovers(manifest, existsTable(async (entry) => entry.type === "s3-bucket"));
    expect(leftovers.filter((item) => item.exists).map((item) => item.entry.type)).toEqual(["s3-bucket"]);
  });

  it("does not count an inconclusive check as clean", async () => {
    const leftovers = await findLeftovers(
      manifest,
      existsTable(async () => {
        throw new FakeS3Error("AccessDenied", 403);
      }),
    );
    expect(leftovers.every((item) => item.exists && item.error?.name === "AccessDenied")).toBe(true);
  });

  it("counts NotFound errors from the check as gone", async () => {
    const leftovers = await findLeftovers(
      manifest,
      existsTable(async () => {
        throw new FakeS3Error("NotFound", 404);
      }),
    );
    expect(leftovers.some((item) => item.exists)).toBe(false);
  });
});

describe("Manifest", () => {
  it("persists every entry before the next one and reloads identically", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lab-manifest-")), "m.json");
    const created = Manifest.create(path, "run2", "us-east-1", ACCOUNT);
    created.record({ type: "s3-bucket", id: "s3-annotations-lab-run2" });
    const reloaded = Manifest.load(path);
    expect(reloaded.runId).toBe("run2");
    expect(reloaded.entries.map((entry) => entry.id)).toEqual(["s3-annotations-lab-run2"]);
  });

  it("refuses to overwrite an existing manifest", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lab-manifest-")), "m.json");
    Manifest.create(path, "r", "us-east-1", ACCOUNT);
    expect(() => Manifest.create(path, "r2", "us-east-1", ACCOUNT)).toThrow(/already exists/);
  });

  it("fails clearly when there is no manifest", () => {
    expect(() => Manifest.load(join(tmpdir(), "does-not-exist-lab.json"))).toThrow(/No manifest/);
  });

  it("archives the file out of the way", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lab-manifest-")), "m.json");
    const created = Manifest.create(path, "r", "us-east-1", ACCOUNT);
    const archived = created.archive();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(archived)).toBe(true);
  });
});

describe("Manifest ownership", () => {
  const newManifest = () => Manifest.create(join(mkdtempSync(join(tmpdir(), "lab-manifest-")), "m.json"), "run3", "us-east-1", ACCOUNT);

  it("refuses to record a resource that does not belong to the run", () => {
    expect(() => newManifest().record({ type: "s3-bucket", id: "someone-elses-bucket" })).toThrow(/does not belong/);
  });

  it("accepts the AWS-managed table bucket, which carries no run id", () => {
    expect(() => newManifest().record({ type: "s3tables-table-bucket", id: "aws-s3" })).not.toThrow();
  });

  it("rejects a manifest file whose entry ids do not belong to its run", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lab-manifest-")), "m.json");
    writeFileSync(
      path,
      JSON.stringify({
        runId: "run3",
        region: "us-east-1",
        accountId: ACCOUNT,
        createdAt: "2026-11-12T00:00:00.000Z",
        entries: [{ type: "s3-bucket", id: "someone-elses-bucket", details: {}, recordedAt: "2026-11-12T00:00:00.000Z" }],
      }),
    );
    expect(() => Manifest.load(path)).toThrow(/does not belong/);
  });

  it("rejects a manifest without a 12-digit account id", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lab-manifest-")), "m.json");
    writeFileSync(path, JSON.stringify({ runId: "run3", region: "us-east-1", createdAt: "2026-11-12T00:00:00.000Z", entries: [] }));
    expect(() => Manifest.load(path)).toThrow();
  });
});
