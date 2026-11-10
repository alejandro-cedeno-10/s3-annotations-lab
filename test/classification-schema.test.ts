import { describe, expect, it } from "vitest";
import { classificationSchema, modelClassificationSchema, toClassification, type ModelClassification } from "../src/enrichment/classification-schema";
import { FIXED_NOW } from "./support/fakes";

const VALID_MODEL: ModelClassification = { doc_type: "contract", language: "en", pii_present: false, summary: "A sample contract." };

describe("modelClassificationSchema", () => {
  it("accepts a valid model answer and strips unknown keys", () => {
    const parsed = modelClassificationSchema.parse({ ...VALID_MODEL, injected: "ignored" });
    expect(parsed).toEqual(VALID_MODEL);
  });

  it.each<[string, Record<string, unknown>]>([
    ["unknown doc_type", { ...VALID_MODEL, doc_type: "poem" }],
    ["pii_present as string", { ...VALID_MODEL, pii_present: "false" }],
    ["empty summary", { ...VALID_MODEL, summary: "" }],
    ["summary over 500 chars", { ...VALID_MODEL, summary: "x".repeat(501) }],
    ["missing language", { doc_type: "contract", pii_present: false, summary: "s" }],
  ])("rejects %s", (_label, input) => {
    expect(modelClassificationSchema.safeParse(input).success).toBe(false);
  });
});

describe("toClassification", () => {
  it("adds provenance and always marks the label as a proposal", () => {
    const result = toClassification(VALID_MODEL, { generatedBy: "model-x", generatedAt: FIXED_NOW });
    expect(result).toEqual({
      ...VALID_MODEL,
      schema_version: 1,
      generated_by: "model-x",
      generated_at: "2026-11-10T12:00:00.000Z",
      review_required: true,
    });
    expect(classificationSchema.safeParse(result).success).toBe(true);
  });

  it("rejects a persisted document with the wrong schema_version or timestamp", () => {
    const valid = toClassification(VALID_MODEL, { generatedBy: "m", generatedAt: FIXED_NOW });
    expect(classificationSchema.safeParse({ ...valid, schema_version: 2 }).success).toBe(false);
    expect(classificationSchema.safeParse({ ...valid, generated_at: "yesterday" }).success).toBe(false);
  });
});
