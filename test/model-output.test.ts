import { describe, expect, it } from "vitest";
import { parseModelClassification } from "../src/enrichment/classifier";
import { extractJson, ModelOutputError } from "../src/enrichment/model-output";
import { MODEL_REPLY_JSON, fencedReply } from "./support/fakes";

const EXPECTED = JSON.parse(MODEL_REPLY_JSON) as unknown;

describe("extractJson", () => {
  it.each<[string, string]>([
    ["fenced json block", fencedReply()],
    ["fenced block without language", `\`\`\`\n${MODEL_REPLY_JSON}\n\`\`\``],
    ["unfenced bare json", MODEL_REPLY_JSON],
    ["json surrounded by prose", `Sure! ${MODEL_REPLY_JSON} Hope this helps.`],
    ["json with braces inside strings", `Result: {"a": "}{", "b": 1}`],
  ])("extracts from %s", (_label, text) => {
    expect(extractJson(text)).toBeTypeOf("object");
  });

  it("returns the expected object for fenced and unfenced forms alike", () => {
    expect(extractJson(fencedReply())).toEqual(EXPECTED);
    expect(extractJson(MODEL_REPLY_JSON)).toEqual(EXPECTED);
  });

  it("handles escaped quotes inside strings when scanning for the balanced object", () => {
    expect(extractJson('text {"summary": "he said \\"}\\" ok"} tail')).toEqual({ summary: 'he said "}" ok' });
  });

  it.each([["no json here"], ["{ not: valid json }"], ["```json\n{broken\n```"], [""]])("throws on %j", (text) => {
    expect(() => extractJson(text)).toThrow(ModelOutputError);
  });
});

describe("parseModelClassification", () => {
  it("returns the validated classification", () => {
    expect(parseModelClassification(fencedReply())).toEqual(EXPECTED);
  });

  it("rejects JSON that parses but breaks the schema", () => {
    const wrongType = JSON.stringify({ doc_type: "poem", language: "es", pii_present: true, summary: "x" });
    expect(() => parseModelClassification(wrongType)).toThrow(ModelOutputError);
  });

  it("rejects non-JSON text", () => {
    expect(() => parseModelClassification("I cannot help with that.")).toThrow(ModelOutputError);
  });
});
