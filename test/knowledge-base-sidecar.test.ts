import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE_LIMITS } from "../src/config/lab-config";
import { toClassification } from "../src/enrichment/classification-schema";
import { buildSidecar, serializeSidecar, sidecarKeyFor, SidecarTooLargeError } from "../src/rag/knowledge-base-sidecar";
import { FIXED_NOW } from "./support/fakes";

const classification = toClassification(
  { doc_type: "report", language: "en", pii_present: false, summary: "Long summary that stays in the annotation." },
  { generatedBy: "model-x", generatedAt: FIXED_NOW },
);

describe("knowledge base sidecar", () => {
  it("wraps filterable fields in metadataAttributes and leaves the summary out", () => {
    expect(buildSidecar(classification)).toEqual({
      metadataAttributes: {
        doc_type: "report",
        language: "en",
        pii_present: false,
        review_required: true,
        schema_version: 1,
        generated_at: "2026-11-10T12:00:00.000Z",
      },
    });
  });

  it("names the sidecar next to the object", () => {
    expect(sidecarKeyFor("docs/a/b.pdf")).toBe("docs/a/b.pdf.metadata.json");
  });

  it("serializes within the limit", () => {
    expect(JSON.parse(serializeSidecar(classification))).toHaveProperty("metadataAttributes.doc_type", "report");
  });

  it("accepts a sidecar of exactly 10 KB and rejects one byte more", () => {
    const base = new TextEncoder().encode(serializeSidecar(classification, { pad: "" })).length;
    const exact = KNOWLEDGE_BASE_LIMITS.maxSidecarBytes - base;
    expect(new TextEncoder().encode(serializeSidecar(classification, { pad: "x".repeat(exact) })).length).toBe(KNOWLEDGE_BASE_LIMITS.maxSidecarBytes);
    expect(() => serializeSidecar(classification, { pad: "x".repeat(exact + 1) })).toThrow(SidecarTooLargeError);
  });

  it("measures bytes, not characters", () => {
    const multibyte = "é".repeat(KNOWLEDGE_BASE_LIMITS.maxSidecarBytes / 2);
    expect(() => serializeSidecar(classification, { notes: multibyte })).toThrow(SidecarTooLargeError);
  });
});
