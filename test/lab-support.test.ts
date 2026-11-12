import { describe, expect, it } from "vitest";
import { describeError, isNotFoundError, isPreconditionFailed } from "../src/aws/error-info";
import { AI_ANNOTATIONS, DOCS_PREFIX, labNames, labTags } from "../src/config/lab-config";
import { objectCreatedPattern } from "../src/lab/event-rule";
import { executionPolicy, metadataTrustPolicy } from "../src/lab/iam-documents";
import { findLostFields, jitterMs, readsInterleaved, summarizeRounds } from "../src/lab/lost-update";
import { requireProfile } from "../src/lab/aws-clients";
import { retry } from "../src/lab/retry";
import { parseArgs, numberArg } from "../src/lab/experiment-runner";
import { FakeS3Error } from "./support/fakes";

describe("error classification", () => {
  it("recognizes not found by name or status", () => {
    expect(isNotFoundError(new FakeS3Error("NoSuchBucket", 404))).toBe(true);
    expect(isNotFoundError(new FakeS3Error("Whatever", 404))).toBe(true);
    expect(isNotFoundError(new FakeS3Error("EntityNotFoundException", 400))).toBe(true);
    expect(isNotFoundError(new FakeS3Error("AccessDenied", 403))).toBe(false);
  });

  it("recognizes a failed precondition by name or status", () => {
    expect(isPreconditionFailed(new FakeS3Error("PreconditionFailed", 412))).toBe(true);
    expect(isPreconditionFailed(new FakeS3Error("Other", 412))).toBe(true);
    expect(isPreconditionFailed(new FakeS3Error("Other", 400))).toBe(false);
  });

  it("describes non-error throwables", () => {
    expect(describeError("boom")).toEqual({ name: "UnknownError", message: "boom" });
  });
});

describe("lab naming and tagging", () => {
  it("derives every resource name from the run id", () => {
    const names = labNames("abcd1234");
    expect(names.bucket).toBe("s3-annotations-lab-abcd1234");
    expect(names.metadataNamespace).toBe("b_s3-annotations-lab-abcd1234");
    expect(names.logGroup).toBe(`/aws/lambda/${names.functionName}`);
  });

  it("tags with the lab marker and the run id on top of the required set", () => {
    expect(labTags("r1")).toMatchObject({ lab: "s3-annotations-lab", "run-id": "r1" });
  });

  it("keeps the annotation name in one place", () => {
    expect(AI_ANNOTATIONS.classification).toBe("ai.classification");
  });
});

describe("infrastructure documents", () => {
  const policy = executionPolicy({ bucket: "bkt", accountId: "ACCOUNT_ID", logGroup: "/aws/lambda/fn" });
  const statements = policy.Statement as Array<{ Action: string | string[]; Resource: string | string[] }>;

  it("limits annotation permissions to the docs prefix of the lab bucket", () => {
    const s3 = statements.find((statement) => JSON.stringify(statement.Action).includes("PutObjectAnnotation"));
    expect(s3?.Resource).toBe(`arn:aws:s3:::bkt/${DOCS_PREFIX}*`);
  });

  it("grants the version-scoped write that a VersionId on PutObjectAnnotation requires", () => {
    const s3 = statements.find((statement) => JSON.stringify(statement.Action).includes("PutObjectAnnotation"));
    expect(s3?.Action).toContain("s3:PutObjectVersionAnnotation");
  });

  it("grants no annotation read action, which the handler never uses", () => {
    const actions = JSON.stringify(statements.map((statement) => statement.Action));
    expect(actions).not.toContain("GetObjectAnnotation");
    expect(actions).not.toContain("GetObjectVersionAnnotation");
  });

  it("allows invoking only the Nova Lite profile and foundation model", () => {
    const bedrock = statements.find((statement) => statement.Action === "bedrock:InvokeModel");
    expect(bedrock?.Resource).toEqual([
      "arn:aws:bedrock:us-east-1:ACCOUNT_ID:inference-profile/us.amazon.nova-lite-v1:0",
      "arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0",
    ]);
  });

  it("never grants wildcard actions or resources", () => {
    for (const statement of statements) {
      expect(JSON.stringify(statement.Action)).not.toContain("*");
      expect(statement.Resource).not.toBe("*");
    }
  });

  it("trusts the metadata service only for this account and bucket", () => {
    const trust = metadataTrustPolicy({ bucket: "bkt", accountId: "ACCOUNT_ID" });
    expect(trust.Statement[0]).toMatchObject({
      Principal: { Service: "metadata.s3.amazonaws.com" },
      Condition: { StringEquals: { "aws:SourceAccount": "ACCOUNT_ID" }, ArnLike: { "aws:SourceArn": "arn:aws:s3:::bkt" } },
    });
  });

  it("matches Object Created events for the bucket and the docs prefix only", () => {
    expect(JSON.parse(objectCreatedPattern("bkt"))).toEqual({
      source: ["aws.s3"],
      "detail-type": ["Object Created"],
      detail: { bucket: { name: ["bkt"] }, object: { key: [{ prefix: "docs/" }] } },
    });
  });
});

describe("lost update accounting", () => {
  it("reports fields that are missing or overwritten", () => {
    expect(findLostFields({ a: "1", b: "2" }, { a: "1" })).toEqual(["b"]);
    expect(findLostFields({ a: "1", b: "2" }, { a: "1", b: "2" })).toEqual([]);
    expect(findLostFields({ a: "1" }, { a: "other" })).toEqual(["a"]);
  });

  it("totals rounds", () => {
    const totals = summarizeRounds([
      { round: 1, lostFields: [], finalDocuments: {} },
      { round: 2, lostFields: ["b"], finalDocuments: {} },
      { round: 3, lostFields: ["a", "b"], finalDocuments: {} },
    ]);
    expect(totals).toEqual({ rounds: 3, roundsWithLoss: 2, lostFields: 3, lostPerRound: [0, 1, 2] });
  });

  it("bounds the jitter", () => {
    expect(jitterMs(30, () => 0)).toBe(0);
    expect(jitterMs(30, () => 0.999999)).toBe(30);
  });
});

describe("readsInterleaved", () => {
  const timing = (startMs: number, readEndMs: number, writeEndMs: number) => ({ writer: "x", startMs, readEndMs, writeEndMs });

  it("is true when both reads finish before the other write finishes", () => {
    expect(readsInterleaved(timing(0, 30, 120), timing(10, 40, 130))).toBe(true);
  });

  it("is false when one writer completes before the other reads", () => {
    expect(readsInterleaved(timing(0, 30, 80), timing(100, 130, 200))).toBe(false);
  });
});

describe("retry", () => {
  const instantly = async () => undefined;

  it("retries matching errors and then succeeds", async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("not yet");
        return "ok";
      },
      { attempts: 5, delayMs: 1, shouldRetry: () => true, wait: instantly },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("fails fast on errors it should not retry", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error("fatal");
        },
        { attempts: 5, delayMs: 1, shouldRetry: () => false, wait: instantly },
      ),
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });

  it("gives up after the last attempt", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error("always");
        },
        { attempts: 3, delayMs: 1, shouldRetry: () => true, wait: instantly },
      ),
    ).rejects.toThrow("always");
    expect(calls).toBe(3);
  });
});

describe("script inputs", () => {
  it("requires AWS_PROFILE explicitly", () => {
    expect(() => requireProfile({})).toThrow(/AWS_PROFILE/);
    expect(requireProfile({ AWS_PROFILE: "lab" })).toBe("lab");
  });

  it("parses --name=value arguments with numeric fallbacks", () => {
    const args = parseArgs(["--rounds=5", "--other=x", "positional"]);
    expect(args).toEqual({ rounds: "5", other: "x" });
    expect(numberArg(args, "rounds", 20)).toBe(5);
    expect(numberArg(args, "missing", 20)).toBe(20);
    expect(numberArg(args, "other", 20)).toBe(20);
  });
});
