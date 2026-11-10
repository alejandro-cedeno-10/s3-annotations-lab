import { describe, expect, it } from "vitest";
import { EXTRA_TAGS, labNames, labTags, parseExtraTags } from "../src/config/lab-config";
import { createBucketInput, createFunctionInput, createLogGroupInput, createRoleInput, putRuleInput, toTagList } from "../src/lab/create-inputs";
import { lambdaTrustPolicy } from "../src/lab/iam-documents";

const names = labNames("abcd1234");
const tags = labTags("abcd1234");
const asMap = (list: Array<{ Key?: string; Value?: string }> | undefined): Record<string, string> =>
  Object.fromEntries((list ?? []).map(({ Key, Value }) => [Key as string, Value as string]));

describe("tag set", () => {
  it("contains the lab keys plus any extra tags", () => {
    expect(tags).toEqual({ ...EXTRA_TAGS, lab: "s3-annotations-lab", "run-id": "abcd1234" });
  });

  it("parses extra tags from a JSON object of strings", () => {
    expect(parseExtraTags('{"Team":"a","Env":"b"}')).toEqual({ Team: "a", Env: "b" });
  });

  it("defaults to no extra tags", () => {
    expect(parseExtraTags(undefined)).toEqual({});
    expect(parseExtraTags("")).toEqual({});
  });

  it.each(['["a"]', '{"a":1}', "null", '"text"'])("rejects %s", (raw) => {
    expect(() => parseExtraTags(raw)).toThrow(/LAB_EXTRA_TAGS/);
  });

  it("converts to the Key/Value list format", () => {
    expect(toTagList({ a: "1" })).toEqual([{ Key: "a", Value: "1" }]);
  });
});

describe("every create call carries the tag set at creation", () => {
  it("S3 CreateBucket sends the tags inside CreateBucketConfiguration", () => {
    expect(asMap(createBucketInput(names, tags).CreateBucketConfiguration?.Tags)).toEqual(tags);
  });

  it("IAM CreateRole", () => {
    expect(asMap(createRoleInput(names.executionRole, lambdaTrustPolicy(), tags).Tags)).toEqual(tags);
  });

  it("CloudWatch CreateLogGroup", () => {
    expect(createLogGroupInput(names, tags).tags).toEqual(tags);
  });

  it("Lambda CreateFunction", () => {
    expect(createFunctionInput(names, "role-arn", new Uint8Array([1]), tags).Tags).toEqual(tags);
  });

  it("EventBridge PutRule", () => {
    expect(asMap(putRuleInput(names, tags).Tags)).toEqual(tags);
  });
});
