import { describe, expect, it } from "vitest";
import { assertAnnotationName, checkAnnotationName, InvalidAnnotationNameError, type NameViolation } from "../src/annotations/annotation-name";
import { ANNOTATION_LIMITS } from "../src/config/lab-config";

describe("checkAnnotationName", () => {
  it.each([
    ["ai.classification"],
    ["ai_summary-v2"],
    ["descripción"],
    ["日本語.メモ"],
    ["Ünïcode.Näme"],
    ["a"],
    ["x".repeat(ANNOTATION_LIMITS.maxNameBytes)],
    ["é".repeat(ANNOTATION_LIMITS.maxNameBytes / 2)],
    ["awesome"],
    ["s4.name"],
  ])("accepts %s", (name) => {
    expect(checkAnnotationName(name)).toEqual({ valid: true });
  });

  it.each<[string, NameViolation]>([
    ["", "empty"],
    ["   ", "invalid-characters"],
    ["has space", "invalid-characters"],
    ["slash/name", "invalid-characters"],
    ["colon:name", "invalid-characters"],
    ["emoji-\u{1F600}", "invalid-characters"],
    ["aws.thing", "reserved-prefix"],
    ["AWS.thing", "reserved-prefix"],
    ["Aws-thing", "reserved-prefix"],
    ["s3.thing", "reserved-prefix"],
    ["S3_thing", "reserved-prefix"],
    ["x".repeat(ANNOTATION_LIMITS.maxNameBytes + 1), "too-long"],
    ["é".repeat(ANNOTATION_LIMITS.maxNameBytes / 2 + 1), "too-long"],
  ])("rejects %j as %s", (name, reason) => {
    expect(checkAnnotationName(name)).toEqual({ valid: false, reason });
  });

  it("counts bytes, not characters", () => {
    const charactersWithinLimit = "é".repeat(ANNOTATION_LIMITS.maxNameBytes - 10);
    expect(charactersWithinLimit.length).toBeLessThan(ANNOTATION_LIMITS.maxNameBytes);
    expect(checkAnnotationName(charactersWithinLimit)).toEqual({ valid: false, reason: "too-long" });
  });

  it("throws a typed error from the assertion", () => {
    expect(() => assertAnnotationName("aws.x")).toThrow(InvalidAnnotationNameError);
    expect(() => assertAnnotationName("ai.x")).not.toThrow();
  });
});
