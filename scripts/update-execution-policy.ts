import { PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { labNames, MANIFEST_PATH } from "../src/config/lab-config";
import { createLabClients } from "../src/lab/aws-clients";
import { executionPolicy } from "../src/lab/iam-documents";
import { Manifest } from "../src/lab/manifest";

/**
 * Re-applies the execution policy of the deployed lab role in place. The inline policy is already
 * in the manifest, so no new resource is created.
 */
async function main(): Promise<void> {
  const clients = createLabClients();
  const names = labNames(Manifest.load(MANIFEST_PATH).runId);
  const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
  const document = executionPolicy({ bucket: names.bucket, accountId: identity.Account ?? "", logGroup: names.logGroup });
  await clients.iam.send(
    new PutRolePolicyCommand({ RoleName: names.executionRole, PolicyName: names.executionPolicy, PolicyDocument: JSON.stringify(document) }),
  );
  console.log("Execution policy updated in place");
}

await main();
