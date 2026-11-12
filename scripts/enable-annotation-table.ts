import { CreateRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateBucketMetadataConfigurationCommand, GetBucketMetadataConfigurationCommand } from "@aws-sdk/client-s3";
import { ListTableBucketsCommand } from "@aws-sdk/client-s3tables";
import { labNames, labTags, MANIFEST_PATH, METADATA_TABLES, ROLE_PROPAGATION } from "../src/config/lab-config";
import { createLabClients, type LabClients } from "../src/lab/aws-clients";
import { createRoleInput } from "../src/lab/create-inputs";
import { metadataReadPolicy, metadataTrustPolicy } from "../src/lab/iam-documents";
import { Manifest } from "../src/lab/manifest";
import { assertManifestMatchesCaller, requireValue } from "../src/lab/account-guard";
import { isMetadataRoleNotReady, retry } from "../src/lab/retry";

async function awsManagedTableBucketExists(clients: LabClients): Promise<boolean> {
  const page = await clients.s3tables.send(
    new ListTableBucketsCommand({ type: "aws", prefix: METADATA_TABLES.tableBucketName }),
  );
  return (page.tableBuckets ?? []).some((bucket) => bucket.name === METADATA_TABLES.tableBucketName);
}

async function createMetadataRole(clients: LabClients, manifest: Manifest, accountId: string): Promise<string> {
  const names = labNames(manifest.runId);
  manifest.record({ type: "iam-role", id: names.metadataRole });
  const role = await clients.iam.send(
    new CreateRoleCommand(createRoleInput(names.metadataRole, metadataTrustPolicy({ bucket: names.bucket, accountId }), labTags(manifest.runId))),
  );
  manifest.record({
    type: "iam-role-policy",
    id: `${names.metadataRole}/${names.metadataPolicy}`,
    details: { roleName: names.metadataRole, policyName: names.metadataPolicy },
  });
  await clients.iam.send(
    new PutRolePolicyCommand({
      RoleName: names.metadataRole,
      PolicyName: names.metadataPolicy,
      PolicyDocument: JSON.stringify(metadataReadPolicy(names.bucket)),
    }),
  );
  return requireValue(role.Role?.Arn, "the metadata role ARN");
}

async function createConfiguration(clients: LabClients, bucket: string, roleArn: string): Promise<void> {
  await retry(
    () =>
      clients.s3.send(
        new CreateBucketMetadataConfigurationCommand({
          Bucket: bucket,
          MetadataConfiguration: {
            JournalTableConfiguration: { RecordExpiration: { Expiration: "DISABLED" } },
            InventoryTableConfiguration: { ConfigurationState: "DISABLED" },
            AnnotationTableConfiguration: { ConfigurationState: "ENABLED", Role: roleArn },
          },
        }),
      ),
    { ...ROLE_PROPAGATION, shouldRetry: isMetadataRoleNotReady },
  );
}

/**
 * Enables the journal and annotation tables for the lab bucket only. It never touches Lake
 * Formation or the Glue s3tablescatalog integration: those are account-level and stay as they are.
 */
async function main(): Promise<void> {
  const clients = createLabClients();
  const manifest = Manifest.load(MANIFEST_PATH);
  const names = labNames(manifest.runId);
  await assertManifestMatchesCaller(manifest, clients.sts);

  const alreadyExisted = await awsManagedTableBucketExists(clients);
  console.log(`AWS-managed table bucket "${METADATA_TABLES.tableBucketName}" existed before: ${alreadyExisted}`);
  manifest.record({
    type: "s3tables-table-bucket",
    id: METADATA_TABLES.tableBucketName,
    details: { createdByLab: String(!alreadyExisted) },
  });

  const roleArn = await createMetadataRole(clients, manifest, manifest.accountId);
  manifest.record({ type: "s3tables-namespace", id: names.metadataNamespace });
  manifest.record({ type: "bucket-metadata-config", id: names.bucket });
  await createConfiguration(clients, names.bucket, roleArn);

  const configuration = await clients.s3.send(new GetBucketMetadataConfigurationCommand({ Bucket: names.bucket }));
  const result = configuration.GetBucketMetadataConfigurationResult?.MetadataConfigurationResult;
  const actualNamespace = result?.DestinationResult?.TableNamespace;
  if (actualNamespace && actualNamespace !== names.metadataNamespace) {
    manifest.record({ type: "s3tables-namespace", id: actualNamespace });
  }
  console.log(`Annotation table status: ${result?.AnnotationTableConfigurationResult?.TableStatus ?? "unknown"}`);
  console.log(`Namespace: ${actualNamespace ?? names.metadataNamespace}`);
}

await main();
