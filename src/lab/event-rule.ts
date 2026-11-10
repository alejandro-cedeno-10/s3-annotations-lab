import { DOCS_PREFIX, EVENT_RULE } from "../config/lab-config";

export function objectCreatedPattern(bucket: string): string {
  return JSON.stringify({
    source: [EVENT_RULE.source],
    "detail-type": [EVENT_RULE.detailType],
    detail: {
      bucket: { name: [bucket] },
      object: { key: [{ prefix: DOCS_PREFIX }] },
    },
  });
}
