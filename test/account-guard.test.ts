import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertManifestMatchesCaller, callerAccountId, requireValue } from "../src/lab/account-guard";
import { isLambdaRoleNotAssumable, isMetadataRoleNotReady } from "../src/lab/retry";
import { Manifest } from "../src/lab/manifest";

const stsMock = mockClient(STSClient);
const sts = new STSClient({ region: "us-east-1" });
const MANIFEST_ACCOUNT = "111122223333";

const newManifest = (region = "us-east-1") =>
  Manifest.create(join(mkdtempSync(join(tmpdir(), "lab-guard-")), "m.json"), "run1", region, MANIFEST_ACCOUNT);

beforeEach(() => stsMock.reset());

describe("account guard", () => {
  it("passes when the caller is the account that created the manifest", async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: MANIFEST_ACCOUNT });
    await expect(assertManifestMatchesCaller(newManifest(), sts)).resolves.toBeUndefined();
  });

  it("aborts when the caller belongs to another account", async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: "999999999999" });
    await expect(assertManifestMatchesCaller(newManifest(), sts)).rejects.toThrow(/different account/);
  });

  it("aborts when the manifest region is not the lab region", async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: MANIFEST_ACCOUNT });
    await expect(assertManifestMatchesCaller(newManifest("eu-west-1"), sts)).rejects.toThrow(/eu-west-1/);
  });

  it("refuses an empty account id instead of building empty ARNs", async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({});
    await expect(callerAccountId(sts)).rejects.toThrow(/account id/);
    expect(() => requireValue(undefined, "the role ARN")).toThrow(/role ARN/);
    expect(requireValue("arn:x", "the role ARN")).toBe("arn:x");
  });
});

describe("role propagation predicates", () => {
  it("retries only the Lambda not-assumable error", () => {
    expect(isLambdaRoleNotAssumable({ name: "InvalidParameterValueException", message: "The role defined cannot be assumed by Lambda" })).toBe(true);
    expect(isLambdaRoleNotAssumable({ name: "AccessDenied", message: "role cannot be assumed" })).toBe(false);
  });

  it("does not hide unrelated permission errors that merely mention a role", () => {
    expect(isMetadataRoleNotReady({ name: "InvalidRequest", message: "Invalid role" })).toBe(true);
    expect(isMetadataRoleNotReady({ name: "AccessDenied", message: "role is not authorized" })).toBe(false);
  });
});
