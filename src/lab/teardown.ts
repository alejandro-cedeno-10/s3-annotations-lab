import { describeError, isNotFoundError, type ErrorInfo } from "../aws/error-info";
import type { Manifest, ManifestEntry, ResourceType } from "./manifest";

export type RemovalOutcome = "deleted" | "already-gone" | "skipped";

export interface ResourceOps {
  remove(entry: ManifestEntry): Promise<RemovalOutcome>;
  exists(entry: ManifestEntry): Promise<boolean>;
}

export type ResourceOpsTable = Record<ResourceType, ResourceOps>;

export type TeardownResult =
  | { entry: ManifestEntry; outcome: RemovalOutcome }
  | { entry: ManifestEntry; outcome: "failed"; error: ErrorInfo };

async function removeEntry(entry: ManifestEntry, ops: ResourceOpsTable): Promise<TeardownResult> {
  try {
    return { entry, outcome: await ops[entry.type].remove(entry) };
  } catch (error) {
    if (isNotFoundError(error)) return { entry, outcome: "already-gone" };
    return { entry, outcome: "failed", error: describeError(error) };
  }
}

/**
 * Deletes only what the manifest lists, newest first, so dependents go before their parents.
 * Never lists or deletes anything by prefix. A failure on one entry does not stop the rest, and a
 * second run is safe: resources that are already gone count as success.
 */
export async function runTeardown(
  manifest: Manifest,
  ops: ResourceOpsTable,
  report: (result: TeardownResult) => void = () => undefined,
): Promise<TeardownResult[]> {
  const results: TeardownResult[] = [];
  for (const entry of [...manifest.entries].reverse()) {
    const result = await removeEntry(entry, ops);
    report(result);
    results.push(result);
  }
  return results;
}

export const hasFailures = (results: readonly TeardownResult[]): boolean =>
  results.some((result) => result.outcome === "failed");

export interface LeftoverResult {
  entry: ManifestEntry;
  exists: boolean;
  error?: ErrorInfo;
}

/**
 * Reports, for every manifest entry, whether the resource still exists. An entry whose check
 * errors is treated as still existing: "could not prove it is gone" must not pass as clean.
 */
export async function findLeftovers(manifest: Manifest, ops: ResourceOpsTable): Promise<LeftoverResult[]> {
  const results: LeftoverResult[] = [];
  for (const entry of manifest.entries) {
    try {
      results.push({ entry, exists: await ops[entry.type].exists(entry) });
    } catch (error) {
      results.push(
        isNotFoundError(error)
          ? { entry, exists: false }
          : { entry, exists: true, error: describeError(error) },
      );
    }
  }
  return results;
}
