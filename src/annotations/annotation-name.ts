import { ANNOTATION_LIMITS } from "../config/lab-config";

export type NameViolation = "empty" | "too-long" | "invalid-characters" | "reserved-prefix";

export type NameCheck = { valid: true } | { valid: false; reason: NameViolation };

const ALLOWED_CHARACTERS = /^[\p{L}\p{N}_.-]+$/u;

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

const hasReservedPrefix = (name: string): boolean => {
  const lower = name.toLowerCase();
  return ANNOTATION_LIMITS.reservedNamePrefixes.some((prefix) => lower.startsWith(prefix));
};

const NAME_RULES: ReadonlyArray<{ violation: NameViolation; broken: (name: string) => boolean }> = [
  { violation: "empty", broken: (name) => byteLength(name) < ANNOTATION_LIMITS.minNameBytes },
  { violation: "too-long", broken: (name) => byteLength(name) > ANNOTATION_LIMITS.maxNameBytes },
  { violation: "invalid-characters", broken: (name) => !ALLOWED_CHARACTERS.test(name) },
  { violation: "reserved-prefix", broken: hasReservedPrefix },
];

/**
 * Client-side mirror of the documented annotation name rules. The server stays
 * the authority: experiment 01 compares both verdicts.
 */
export function checkAnnotationName(name: string): NameCheck {
  const broken = NAME_RULES.find((rule) => rule.broken(name));
  return broken ? { valid: false, reason: broken.violation } : { valid: true };
}

export class InvalidAnnotationNameError extends Error {
  constructor(
    readonly annotationName: string,
    readonly reason: NameViolation,
  ) {
    super(`Invalid annotation name (${reason})`);
    this.name = "InvalidAnnotationNameError";
  }
}

export function assertAnnotationName(name: string): void {
  const check = checkAnnotationName(name);
  if (!check.valid) {
    throw new InvalidAnnotationNameError(name, check.reason);
  }
}
