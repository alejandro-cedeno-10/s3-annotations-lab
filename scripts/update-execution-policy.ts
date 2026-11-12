import { PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { labNames, MANIFEST_PATH } from "../src/config/lab-config";
import { createLabClients } from "../src/lab/aws-clients";
import { executionPolicy } from "../src/lab/iam-documents";
import { assertManifestMatchesCaller } from "../src/lab/account-guard";
import { Manifest } from "../src/lab/manifest";

/**
 * Re-applies the execution policy of the deployed lab role in place. The inline policy is already
 * in the manifest, so no new resource is created.
 */
async function main(): Promise<void> {
  const clients = createLabClients();
  const manifest = Manifest.load(MANIFEST_PATH);
  await assertManifestMatchesCaller(manifest, clients.sts);
  const names = labNames(manifest.runId);
  const document = executionPolicy({ bucket: names.bucket, accountId: manifest.accountId, logGroup: names.logGroup });
  await clients.iam.send(
    new PutRolePolicyCommand({ RoleName: names.executionRole, PolicyName: names.executionPolicy, PolicyDocument: JSON.stringify(document) }),
  );
  console.log("Execution policy updated in place");
}

await main();
