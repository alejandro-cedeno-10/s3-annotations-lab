import { Readable } from "node:stream";
import { sdkStreamMixin } from "@smithy/util-stream";

export const sdkBody = (text: string) => sdkStreamMixin(Readable.from([Buffer.from(text, "utf-8")]));

export const FIXED_NOW = new Date("2026-11-10T12:00:00.000Z");

export const objectCreatedEvent = (overrides: { bucket?: string; key?: string; versionId?: string } = {}) => ({
  version: "0",
  "detail-type": "Object Created",
  source: "aws.s3",
  detail: {
    bucket: { name: overrides.bucket ?? "lab-bucket" },
    object: { key: overrides.key ?? "docs/sample.txt", "version-id": overrides.versionId ?? "v1" },
  },
});

export const MODEL_REPLY_JSON = JSON.stringify({
  doc_type: "invoice",
  language: "es",
  pii_present: true,
  summary: "Factura de ejemplo.",
});

export const fencedReply = (json: string = MODEL_REPLY_JSON): string => `Here you go:\n\`\`\`json\n${json}\n\`\`\``;

export class FakeS3Error extends Error {
  readonly $metadata: { httpStatusCode: number };
  constructor(name: string, httpStatusCode: number) {
    super(name);
    this.name = name;
    this.$metadata = { httpStatusCode };
  }
}
