import { ANNOTATION_LIMITS } from "../config/lab-config";

export type PayloadViolation = "empty" | "too-large" | "not-utf8";

export type PayloadCheck =
  | { valid: true; bytes: number }
  | { valid: false; reason: PayloadViolation; bytes: number };

export type PayloadInput = string | Uint8Array;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function toBytes(payload: PayloadInput): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}

const isUtf8 = (bytes: Uint8Array): boolean => {
  try {
    STRICT_UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

const PAYLOAD_RULES: ReadonlyArray<{ violation: PayloadViolation; broken: (bytes: Uint8Array) => boolean }> = [
  { violation: "empty", broken: (bytes) => bytes.length < ANNOTATION_LIMITS.minPayloadBytes },
  { violation: "too-large", broken: (bytes) => bytes.length > ANNOTATION_LIMITS.maxPayloadBytes },
  { violation: "not-utf8", broken: (bytes) => !isUtf8(bytes) },
];

/**
 * Client-side mirror of the documented payload limits (1 byte to 1 MiB, UTF-8 text).
 * Binary data must be Base64-encoded by the caller.
 */
export function checkAnnotationPayload(payload: PayloadInput): PayloadCheck {
  const bytes = toBytes(payload);
  const broken = PAYLOAD_RULES.find((rule) => rule.broken(bytes));
  return broken
    ? { valid: false, reason: broken.violation, bytes: bytes.length }
    : { valid: true, bytes: bytes.length };
}

export class InvalidAnnotationPayloadError extends Error {
  constructor(readonly reason: PayloadViolation) {
    super(`Invalid annotation payload (${reason})`);
    this.name = "InvalidAnnotationPayloadError";
  }
}

export function assertAnnotationPayload(payload: PayloadInput): void {
  const check = checkAnnotationPayload(payload);
  if (!check.valid) {
    throw new InvalidAnnotationPayloadError(check.reason);
  }
}
