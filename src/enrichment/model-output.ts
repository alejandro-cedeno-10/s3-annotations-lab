export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

const FENCED_BLOCK = /```(?:json)?\s*([\s\S]*?)```/i;

const fencedCandidate = (text: string): string | undefined => FENCED_BLOCK.exec(text)?.[1]?.trim();

const advanceInString = (char: string, escaped: boolean): { inString: boolean; escaped: boolean } => {
  if (escaped) return { inString: true, escaped: false };
  if (char === "\\") return { inString: true, escaped: true };
  return { inString: char !== '"', escaped: false };
};

const balancedObjectCandidate = (text: string): string | undefined => {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (inString) {
      ({ inString, escaped } = advanceInString(char, escaped));
      continue;
    }
    if (char === '"') inString = true;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
};

const CANDIDATE_EXTRACTORS: ReadonlyArray<(text: string) => string | undefined> = [
  fencedCandidate,
  (text) => text.trim(),
  balancedObjectCandidate,
];

const tryParse = (candidate: string): { parsed: unknown } | undefined => {
  try {
    return { parsed: JSON.parse(candidate) };
  } catch {
    return undefined;
  }
};

/**
 * Models often wrap JSON in a Markdown fence or add prose around it. Tries, in order:
 * the fenced block, the whole text, the first balanced object. Throws ModelOutputError
 * when none parses; schema validation is a separate step.
 */
export function extractJson(text: string): unknown {
  for (const extract of CANDIDATE_EXTRACTORS) {
    const candidate = extract(text);
    const result = candidate ? tryParse(candidate) : undefined;
    if (result) return result.parsed;
  }
  throw new ModelOutputError("Model output does not contain parseable JSON");
}
