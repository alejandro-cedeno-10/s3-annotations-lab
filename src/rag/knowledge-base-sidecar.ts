import { KNOWLEDGE_BASE_LIMITS } from "../config/lab-config";
import type { Classification } from "../enrichment/classification-schema";

export type SidecarAttributeValue = string | number | boolean;

export interface KnowledgeBaseSidecar {
  metadataAttributes: Record<string, SidecarAttributeValue>;
}

export class SidecarTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Sidecar is ${bytes} bytes; the Knowledge Base limit is ${KNOWLEDGE_BASE_LIMITS.maxSidecarBytes}`);
    this.name = "SidecarTooLargeError";
  }
}

const SIDECAR_FIELDS: ReadonlyArray<keyof Classification> = [
  "doc_type",
  "language",
  "pii_present",
  "review_required",
  "schema_version",
  "generated_at",
];

export function sidecarKeyFor(objectKey: string): string {
  return `${objectKey}${KNOWLEDGE_BASE_LIMITS.sidecarSuffix}`;
}

export function buildSidecar(
  classification: Classification,
  extraAttributes: Record<string, SidecarAttributeValue> = {},
): KnowledgeBaseSidecar {
  const metadataAttributes: Record<string, SidecarAttributeValue> = {};
  for (const field of SIDECAR_FIELDS) {
    metadataAttributes[field] = classification[field];
  }
  return { metadataAttributes: { ...metadataAttributes, ...extraAttributes } };
}

/**
 * Serializes the sidecar that Bedrock Knowledge Bases reads next to the object
 * (`<key>.metadata.json`). Only filter-friendly scalar fields are copied (plus caller-supplied extras): the summary stays in the
 * annotation. Throws instead of truncating, because a silently cut sidecar would change filters.
 */
export function serializeSidecar(
  classification: Classification,
  extraAttributes: Record<string, SidecarAttributeValue> = {},
): string {
  const json = JSON.stringify(buildSidecar(classification, extraAttributes));
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > KNOWLEDGE_BASE_LIMITS.maxSidecarBytes) {
    throw new SidecarTooLargeError(bytes);
  }
  return json;
}
