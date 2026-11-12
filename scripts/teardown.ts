import { MANIFEST_PATH } from "../src/config/lab-config";
import { createLabClients } from "../src/lab/aws-clients";
import { createResourceOps } from "../src/lab/aws-resource-ops";
import { assertManifestMatchesCaller } from "../src/lab/account-guard";
import { Manifest } from "../src/lab/manifest";
import { hasFailures, runTeardown, type TeardownResult } from "../src/lab/teardown";

const describeResult = (result: TeardownResult): string => {
  const label = `${result.entry.type} ${result.entry.id}`;
  return result.outcome === "failed" ? `FAILED   ${label}: ${result.error.name} ${result.error.message}` : `${result.outcome.padEnd(8)} ${label}`;
};

async function main(): Promise<void> {
  const manifest = Manifest.load(MANIFEST_PATH);
  const clients = createLabClients();
  await assertManifestMatchesCaller(manifest, clients.sts);
  const ops = createResourceOps(clients);
  const results = await runTeardown(manifest, ops, (result) => console.log(describeResult(result)));
  if (hasFailures(results)) {
    console.error("Teardown finished with failures. Fix them and run teardown again (it is idempotent).");
    process.exitCode = 1;
    return;
  }
  console.log("Teardown finished. Run verify-clean to confirm.");
}

await main();
