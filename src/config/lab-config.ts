export const REGION = "us-east-1";

export const LAB_TAG = { key: "lab", value: "s3-annotations-lab" } as const;
export const RUN_ID_TAG_KEY = "run-id";

/**
 * Parses extra tags a target account may require at creation time. Expects a JSON object of
 * string values in `LAB_EXTRA_TAGS`; anything else is rejected so a typo cannot silently drop tags.
 */
export function parseExtraTags(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LAB_EXTRA_TAGS must be valid JSON");
  }
  const isStringMap =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.values(parsed).every((value) => typeof value === "string");
  if (!isStringMap) throw new Error("LAB_EXTRA_TAGS must be a JSON object whose values are strings");
  return parsed as Record<string, string>;
}

export const NAME_PREFIX = "s3-annotations-lab";

export const DOCS_PREFIX = "docs/";
export const EXPERIMENT_PREFIX = "lab/";

export const ROLE_PROPAGATION = { attempts: 12, delayMs: 5000 } as const;

export const MANIFEST_PATH = ".lab/manifest.json";
export const RESULTS_DIR = "results";
export const LAMBDA_ZIP_PATH = "dist/enrichment-lambda.zip";

export const MEBIBYTE = 1024 * 1024;

export const ANNOTATION_LIMITS = {
  maxNameBytes: 512,
  minNameBytes: 1,
  minPayloadBytes: 1,
  maxPayloadBytes: MEBIBYTE,
  maxPerVersion: 1000,
  reservedNamePrefixes: ["aws", "s3"],
} as const;

export const AI_ANNOTATIONS = {
  classification: "ai.classification",
} as const;

export const KNOWLEDGE_BASE_LIMITS = {
  maxSidecarBytes: 10 * 1024,
  sidecarSuffix: ".metadata.json",
} as const;

export const BEDROCK_MODEL = {
  inferenceProfileId: "us.amazon.nova-lite-v1:0",
  foundationModelId: "amazon.nova-lite-v1:0",
  temperature: 0,
  maxTokens: 512,
} as const;

export const CLASSIFIER_LIMITS = {
  maxDocumentChars: 20000,
  maxObjectBytes: 5 * MEBIBYTE,
} as const;

export const LAMBDA_SETTINGS = {
  runtime: "nodejs22.x",
  architecture: "arm64",
  handler: "index.handler",
  timeoutSeconds: 60,
  memoryMb: 512,
  logRetentionDays: 1,
  bundleFileName: "index.mjs",
} as const;

export const EVENT_RULE = {
  source: "aws.s3",
  detailType: "Object Created",
  targetId: "enrichment",
} as const;

export const METADATA_TABLES = {
  tableBucketName: "aws-s3",
  annotationTableName: "annotation",
  namespacePrefix: "b_",
  servicePrincipal: "metadata.s3.amazonaws.com",
} as const;

export const CLASSIFICATION_SCHEMA_VERSION = 1;

export interface LabNames {
  bucket: string;
  functionName: string;
  executionRole: string;
  executionPolicy: string;
  metadataRole: string;
  metadataPolicy: string;
  logGroup: string;
  ruleName: string;
  metadataNamespace: string;
}

export function labNames(runId: string): LabNames {
  const base = `${NAME_PREFIX}-${runId}`;
  return {
    bucket: base,
    functionName: `${base}-enrichment`,
    executionRole: `${base}-lambda-role`,
    executionPolicy: "least-privilege-enrichment",
    metadataRole: `${base}-metadata-role`,
    metadataPolicy: "annotation-table-read",
    logGroup: `/aws/lambda/${base}-enrichment`,
    ruleName: `${base}-object-created`,
    metadataNamespace: `${METADATA_TABLES.namespacePrefix}${base}`,
  };
}

export function labTags(runId: string): Record<string, string> {
  return { ...parseExtraTags(process.env.LAB_EXTRA_TAGS), [LAB_TAG.key]: LAB_TAG.value, [RUN_ID_TAG_KEY]: runId };
}
