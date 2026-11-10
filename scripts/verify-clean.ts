import { MANIFEST_PATH } from "../src/config/lab-config";
import { createLabClients } from "../src/lab/aws-clients";
import { createResourceOps } from "../src/lab/aws-resource-ops";
import { Manifest } from "../src/lab/manifest";
import { findLeftovers } from "../src/lab/teardown";

const ARCHIVE_FLAG = "--archive";

async function main(): Promise<void> {
  const manifest = Manifest.load(MANIFEST_PATH);
  const results = await findLeftovers(manifest, createResourceOps(createLabClients()));
  const leftovers = results.filter((result) => result.exists);

  for (const result of results) {
    const state = result.exists ? "STILL EXISTS" : "gone";
    const reason = result.error ? ` (${result.error.name}: ${result.error.message})` : "";
    console.log(`${state.padEnd(12)} ${result.entry.type} ${result.entry.id}${reason}`);
  }

  if (leftovers.length > 0) {
    console.error(`${leftovers.length} manifest resources are not confirmed gone.`);
    process.exitCode = 1;
    return;
  }
  console.log("Clean: every manifest resource returns NotFound.");
  if (process.argv.includes(ARCHIVE_FLAG)) {
    console.log(`Manifest archived to ${manifest.archive()}`);
  }
}

await main();
