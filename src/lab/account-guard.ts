import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { REGION } from "../config/lab-config";
import type { Manifest } from "./manifest";

export function requireValue(value: string | undefined, description: string): string {
  if (!value) throw new Error(`AWS did not return ${description}; refusing to continue with an empty value.`);
  return value;
}

export async function callerAccountId(sts: STSClient): Promise<string> {
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return requireValue(identity.Account, "the caller account id");
}

/**
 * Teardown and verify-clean must act on the account and region that created the manifest. With
 * other credentials every lookup would return NotFound and read as "already gone".
 */
export async function assertManifestMatchesCaller(manifest: Manifest, sts: STSClient): Promise<void> {
  const accountId = await callerAccountId(sts);
  if (accountId !== manifest.accountId) {
    throw new Error("The current AWS credentials belong to a different account than the one that created the manifest. Aborting.");
  }
  if (manifest.region !== REGION) {
    throw new Error(`The manifest was created in ${manifest.region} but the lab operates in ${REGION}. Aborting.`);
  }
}
