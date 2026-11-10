import { describe, expect, it } from "vitest";
import { assertAnnotationPayload, checkAnnotationPayload, InvalidAnnotationPayloadError } from "../src/annotations/annotation-payload";
import { ANNOTATION_LIMITS } from "../src/config/lab-config";

describe("checkAnnotationPayload", () => {
  it("accepts 1 byte and exactly 1 MiB", () => {
    expect(checkAnnotationPayload("x")).toEqual({ valid: true, bytes: 1 });
    expect(checkAnnotationPayload("x".repeat(ANNOTATION_LIMITS.maxPayloadBytes))).toEqual({
      valid: true,
      bytes: ANNOTATION_LIMITS.maxPayloadBytes,
    });
  });

  it("rejects empty and over-limit payloads", () => {
    expect(checkAnnotationPayload("")).toMatchObject({ valid: false, reason: "empty" });
    expect(checkAnnotationPayload("x".repeat(ANNOTATION_LIMITS.maxPayloadBytes + 1))).toMatchObject({ valid: false, reason: "too-large" });
  });

  it("measures the limit in UTF-8 bytes", () => {
    const halfMebibyteOfTwoByteChars = "é".repeat(ANNOTATION_LIMITS.maxPayloadBytes / 2 + 1);
    expect(halfMebibyteOfTwoByteChars.length).toBeLessThan(ANNOTATION_LIMITS.maxPayloadBytes);
    expect(checkAnnotationPayload(halfMebibyteOfTwoByteChars)).toMatchObject({ valid: false, reason: "too-large" });
  });

  it("accepts valid multibyte UTF-8 bytes", () => {
    expect(checkAnnotationPayload(new TextEncoder().encode("日本語 ñ"))).toMatchObject({ valid: true });
  });

  it.each([
    [new Uint8Array([0xff, 0xfe, 0xfd])],
    [new Uint8Array([0xc3, 0x28])],
    [new Uint8Array([0xe2, 0x82])],
  ])("rejects invalid UTF-8 %j", (bytes) => {
    expect(checkAnnotationPayload(bytes)).toMatchObject({ valid: false, reason: "not-utf8" });
  });

  it("throws a typed error from the assertion", () => {
    expect(() => assertAnnotationPayload("")).toThrow(InvalidAnnotationPayloadError);
    expect(() => assertAnnotationPayload("{}")).not.toThrow();
  });
});
