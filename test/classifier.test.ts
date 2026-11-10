import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createBedrockClassifier } from "../src/enrichment/classifier";
import { BEDROCK_MODEL, CLASSIFIER_LIMITS } from "../src/config/lab-config";
import { ModelOutputError } from "../src/enrichment/model-output";
import { fencedReply } from "./support/fakes";

const bedrockMock = mockClient(BedrockRuntimeClient);
const classifier = createBedrockClassifier(new BedrockRuntimeClient({ region: "us-east-1" }));

const reply = (text: string) => ({ output: { message: { role: "assistant" as const, content: [{ text }] } } });

beforeEach(() => {
  bedrockMock.reset();
});

describe("createBedrockClassifier", () => {
  it("calls Converse with the Nova Lite profile and temperature 0", async () => {
    bedrockMock.on(ConverseCommand).resolves(reply(fencedReply()));
    await classifier.classify("document text");
    const input = bedrockMock.commandCalls(ConverseCommand)[0]?.args[0].input;
    expect(input?.modelId).toBe("us.amazon.nova-lite-v1:0");
    expect(input?.modelId).toBe(BEDROCK_MODEL.inferenceProfileId);
    expect(input?.inferenceConfig?.temperature).toBe(0);
  });

  it("returns the parsed classification", async () => {
    bedrockMock.on(ConverseCommand).resolves(reply(fencedReply()));
    await expect(classifier.classify("x")).resolves.toMatchObject({ doc_type: "invoice", language: "es", pii_present: true });
  });

  it("truncates long documents before sending", async () => {
    bedrockMock.on(ConverseCommand).resolves(reply(fencedReply()));
    await classifier.classify("x".repeat(CLASSIFIER_LIMITS.maxDocumentChars + 500));
    const sent = bedrockMock.commandCalls(ConverseCommand)[0]?.args[0].input.messages?.[0]?.content?.[0]?.text;
    expect(sent).toHaveLength(CLASSIFIER_LIMITS.maxDocumentChars);
  });

  it("fails with ModelOutputError when the model does not answer with JSON", async () => {
    bedrockMock.on(ConverseCommand).resolves(reply("I cannot classify this."));
    await expect(classifier.classify("x")).rejects.toBeInstanceOf(ModelOutputError);
  });
});
