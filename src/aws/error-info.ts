export interface ErrorInfo {
  name: string;
  httpStatusCode?: number;
  message: string;
}

const NOT_FOUND_NAMES: ReadonlySet<string> = new Set([
  "NoSuchBucket",
  "NoSuchKey",
  "NoSuchAnnotation",
  "NoSuchEntity",
  "NoSuchEntityException",
  "NotFound",
  "NotFoundException",
  "EntityNotFoundException",
  "ResourceNotFoundException",
  "NoSuchConfiguration",
  "MetadataConfigurationNotFound",
  "NoSuchBucketMetadataConfiguration",
]);

const PRECONDITION_FAILED_NAMES: ReadonlySet<string> = new Set(["PreconditionFailed"]);

const PRECONDITION_FAILED_STATUS = 412;
const NOT_FOUND_STATUS = 404;

export function describeError(error: unknown): ErrorInfo {
  if (typeof error !== "object" || error === null) {
    return { name: "UnknownError", message: String(error) };
  }
  const candidate = error as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: number } };
  return {
    name: typeof candidate.name === "string" ? candidate.name : "UnknownError",
    httpStatusCode: candidate.$metadata?.httpStatusCode,
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

export function isNotFoundError(error: unknown): boolean {
  const info = describeError(error);
  return NOT_FOUND_NAMES.has(info.name) || info.httpStatusCode === NOT_FOUND_STATUS;
}

/**
 * True when a conditional request (If-Match / ObjectIfMatch) was rejected because
 * the ETag no longer matches. Experiment 04 records the exact name the service returns.
 */
export function isPreconditionFailed(error: unknown): boolean {
  const info = describeError(error);
  return PRECONDITION_FAILED_NAMES.has(info.name) || info.httpStatusCode === PRECONDITION_FAILED_STATUS;
}
