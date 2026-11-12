import { BEDROCK_MODEL, DOCS_PREFIX, METADATA_TABLES, REGION } from "../config/lab-config";

export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: Array<Record<string, unknown>>;
}

const POLICY_VERSION = "2012-10-17" as const;

export function lambdaTrustPolicy(): PolicyDocument {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

export interface ExecutionPolicyInput {
  bucket: string;
  accountId: string;
  logGroup: string;
}

/**
 * Least privilege for the enrichment Lambda: object read and annotation write limited to the
 * docs/ prefix of the lab bucket, Converse on the Nova Lite inference profile and the foundation
 * model behind it, and log writes to its own pre-created log group.
 */
export function executionPolicy(input: ExecutionPolicyInput): PolicyDocument {
  const objectsArn = `arn:aws:s3:::${input.bucket}/${DOCS_PREFIX}*`;
  const profileArn = `arn:aws:bedrock:${REGION}:${input.accountId}:inference-profile/${BEDROCK_MODEL.inferenceProfileId}`;
  const foundationModelArn = `arn:aws:bedrock:*::foundation-model/${BEDROCK_MODEL.foundationModelId}`;
  const logGroupArn = `arn:aws:logs:${REGION}:${input.accountId}:log-group:${input.logGroup}:*`;
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: "ReadObjectsAndAnnotate",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObjectAnnotation",
          "s3:PutObjectVersionAnnotation",
        ],
        Resource: objectsArn,
      },
      {
        Sid: "InvokeNovaLite",
        Effect: "Allow",
        Action: "bedrock:InvokeModel",
        Resource: [profileArn, foundationModelArn],
      },
      {
        Sid: "WriteOwnLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: logGroupArn,
      },
    ],
  };
}

export interface MetadataTrustInput {
  bucket: string;
  accountId: string;
}

export function metadataTrustPolicy(input: MetadataTrustInput): PolicyDocument {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: METADATA_TABLES.servicePrincipal },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": input.accountId },
          ArnLike: { "aws:SourceArn": `arn:aws:s3:::${input.bucket}` },
        },
      },
    ],
  };
}

export function metadataReadPolicy(bucket: string): PolicyDocument {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObjectAnnotation", "s3:GetObjectVersionAnnotation"],
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:ListBucketVersions"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
    ],
  };
}
