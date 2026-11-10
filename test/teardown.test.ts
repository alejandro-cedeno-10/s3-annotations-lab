import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeS3Error } from "./support/fakes";
import { Manifest, RESOURCE_TYPES, type ManifestEntry, type ResourceType } from "../src/lab/manifest";
import { findLeftovers, hasFailures, runTeardown, type ResourceOps, type ResourceOpsTable } from "../src/lab/teardown";

const DEPLOY_ORDER: ReadonlyArray<[ResourceType, string]> = [
  ["s3-bucket", "bucket-1"],
  ["iam-role", "role-1"],
  ["iam-role-policy", "role-1/policy"],
  ["log-group", "/aws/lambda/fn"],
  ["lambda-function", "fn"],
  ["events-rule", "rule-1"],
  ["s3tables-table-bucket", "aws-s3"],
  ["s3tables-namespace", "b_bucket-1"],
  ["bucket-metadata-config", "bucket-1"],
];

let manifest: Manifest;

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), "lab-manifest-"));
  manifest = Manifest.create(join(directory, "manifest.json"), "run1", "us-east-1");
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
      "bucket-metadata-config:bucket-1",
      "s3tables-namespace:b_bucket-1",
      "s3tables-table-bucket:aws-s3",
      "events-rule:rule-1",
      "lambda-function:fn",
      "log-group:/aws/lambda/fn",
      "iam-role-policy:role-1/policy",
      "iam-role:role-1",
      "s3-bucket:bucket-1",
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
    const created = Manifest.create(path, "run2", "us-east-1");
    created.record({ type: "s3-bucket", id: "b" });
    const reloaded = Manifest.load(path);
    expect(reloaded.runId).toBe("run2");
    expect(reloaded.entries.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("refuses to overwrite an existing manifest", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lab-manifest-")), "m.json");
    Manifest.create(path, "r", "us-east-1");
    expect(() => Manifest.create(path, "r2", "us-east-1")).toThrow(/already exists/);
  });

  it("fails clearly when there is no manifest", () => {
    expect(() => Manifest.load(join(tmpdir(), "does-not-exist-lab.json"))).toThrow(/No manifest/);
  });

  it("archives the file out of the way", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lab-manifest-")), "m.json");
    const created = Manifest.create(path, "r", "us-east-1");
    const archived = created.archive();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(archived)).toBe(true);
  });
});
