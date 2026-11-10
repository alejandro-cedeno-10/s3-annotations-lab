import { ListObjectAnnotationsCommand } from "@aws-sdk/client-s3";
import { checkAnnotationName } from "../src/annotations/annotation-name";
import { checkAnnotationPayload, type PayloadInput } from "../src/annotations/annotation-payload";
import { ANNOTATION_LIMITS, EXPERIMENT_PREFIX } from "../src/config/lab-config";
import { attempt } from "../src/lab/attempt";
import { numberArg, runExperiment, type ExperimentContext, type ExperimentDefinition, type ExperimentReport } from "../src/lab/experiment-runner";
import { putTextObject } from "../src/lab/object-helpers";

interface LimitCase {
  label: string;
  name: string;
  payload: PayloadInput;
}

const VALID_PAYLOAD = JSON.stringify({ probe: true });
const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0xfd]);

const limitCases = (): LimitCase[] => [
  { label: "valid ascii name", name: "ai.probe", payload: VALID_PAYLOAD },
  { label: "valid multilingual name", name: "descripción.日本語", payload: VALID_PAYLOAD },
  { label: "prefix aws lowercase", name: "aws.probe", payload: VALID_PAYLOAD },
  { label: "prefix AWS uppercase", name: "AWS.probe", payload: VALID_PAYLOAD },
  { label: "prefix s3 lowercase", name: "s3.probe", payload: VALID_PAYLOAD },
  { label: "prefix S3 uppercase", name: "S3-probe", payload: VALID_PAYLOAD },
  { label: "name with space", name: "has space", payload: VALID_PAYLOAD },
  { label: "name with slash", name: "has/slash", payload: VALID_PAYLOAD },
  { label: "name only whitespace", name: "   ", payload: VALID_PAYLOAD },
  { label: "name 512 bytes ascii", name: "a".repeat(ANNOTATION_LIMITS.maxNameBytes), payload: VALID_PAYLOAD },
  { label: "name 513 bytes ascii", name: "a".repeat(ANNOTATION_LIMITS.maxNameBytes + 1), payload: VALID_PAYLOAD },
  { label: "name 512 bytes multibyte", name: "é".repeat(ANNOTATION_LIMITS.maxNameBytes / 2), payload: VALID_PAYLOAD },
  { label: "name 514 bytes multibyte", name: "é".repeat(ANNOTATION_LIMITS.maxNameBytes / 2 + 1), payload: VALID_PAYLOAD },
  { label: "payload not utf-8", name: "ai.binary", payload: NOT_UTF8 },
  { label: "payload 1 byte", name: "ai.one-byte", payload: "x" },
  { label: "payload empty", name: "ai.empty", payload: "" },
  { label: "payload exactly 1 MiB", name: "ai.max", payload: "x".repeat(ANNOTATION_LIMITS.maxPayloadBytes) },
  { label: "payload 1 MiB + 1 byte", name: "ai.over", payload: "x".repeat(ANNOTATION_LIMITS.maxPayloadBytes + 1) },
];

const localVerdict = (limitCase: LimitCase): { valid: boolean; reason?: string } => {
  const name = checkAnnotationName(limitCase.name);
  if (!name.valid) return { valid: false, reason: name.reason };
  const payload = checkAnnotationPayload(limitCase.payload);
  return payload.valid ? { valid: true } : { valid: false, reason: payload.reason };
};

const sizeOf = (payload: PayloadInput): number => (typeof payload === "string" ? new TextEncoder().encode(payload).length : payload.length);

async function runCase({ store }: ExperimentContext, key: string, limitCase: LimitCase) {
  const started = Date.now();
  const server = await attempt(() => store.put(key, limitCase.name, limitCase.payload, { validateLocally: false }));
  const local = localVerdict(limitCase);
  const serverAccepted = server.ok;
  return {
    label: limitCase.label,
    nameBytes: new TextEncoder().encode(limitCase.name).length,
    payloadBytes: sizeOf(limitCase.payload),
    localVerdict: local,
    serverAccepted,
    serverError: server.ok ? undefined : server.error,
    verdictsAgree: local.valid === serverAccepted,
    elapsedMs: Date.now() - started,
  };
}

const DEFAULT_COUNT_CONCURRENCY = 3;

const countName = (index: number): string => `n${String(index).padStart(4, "0")}`;

type Histogram = Record<string, number>;

const tally = (histogram: Histogram, result: { ok: boolean; error?: { name: string; httpStatusCode?: number } }): void => {
  if (result.ok || !result.error) return;
  const label = `${result.error.name} HTTP ${result.error.httpStatusCode}`;
  histogram[label] = (histogram[label] ?? 0) + 1;
};

async function fillAnnotations(context: ExperimentContext, key: string, concurrency: number) {
  const firstPassErrors: Histogram = {};
  const failedIndices: number[] = [];
  const indices = Array.from({ length: ANNOTATION_LIMITS.maxPerVersion }, (_unused, offset) => offset + 1);
  for (let start = 0; start < indices.length; start += concurrency) {
    const batch = indices.slice(start, start + concurrency);
    const results = await Promise.all(batch.map((index) => attempt(() => context.store.put(key, countName(index), "x"))));
    results.forEach((result, position) => {
      tally(firstPassErrors, result.ok ? { ok: true } : { ok: false, error: result.error });
      if (!result.ok) failedIndices.push(batch[position] as number);
    });
  }
  const retryErrors: Histogram = {};
  for (const index of failedIndices) {
    const result = await attempt(() => context.store.put(key, countName(index), "x"));
    tally(retryErrors, result.ok ? { ok: true } : { ok: false, error: result.error });
  }
  return { concurrency, firstPassFailures: failedIndices.length, firstPassErrors, sequentialRetryErrors: retryErrors };
}

async function annotationCountLimit(context: ExperimentContext) {
  const key = `${EXPERIMENT_PREFIX}exp01/count-${Date.now()}.txt`;
  await putTextObject(context.clients.s3, context.names.bucket, key, "experiment 01 count target");
  const fill = await fillAnnotations(context, key, numberArg(context.args, "count-concurrency", DEFAULT_COUNT_CONCURRENCY));
  const listedBeforeLimit = await attempt(() => context.store.list({ key }));
  const overLimit = await attempt(() => context.store.put(key, countName(ANNOTATION_LIMITS.maxPerVersion + 1), "x"));
  const overwriteAtLimit = await attempt(() => context.store.put(key, countName(1), "y"));
  const firstPage = await attempt(() =>
    context.clients.s3.send(new ListObjectAnnotationsCommand({ Bucket: context.names.bucket, Key: key, AnnotationPrefix: "n00", MaxAnnotationResults: 5 })),
  );
  const total = await attempt(() => context.store.list({ key }));
  return {
    label: "annotation count limit",
    fill,
    listedBeforeLimit: listedBeforeLimit.ok ? listedBeforeLimit.value.length : listedBeforeLimit,
    overLimit,
    overwriteAtLimit,
    listMaxResults5: firstPage.ok
      ? { returned: firstPage.value.Annotations?.length, annotationCount: firstPage.value.AnnotationCount, hasNextToken: Boolean(firstPage.value.NextContinuationToken) }
      : firstPage,
    totalListed: total.ok ? total.value.length : total,
  };
}

async function run(context: ExperimentContext): Promise<ExperimentReport> {
  const key = `${EXPERIMENT_PREFIX}exp01/${Date.now()}.txt`;
  await putTextObject(context.clients.s3, context.names.bucket, key, "experiment 01 target");
  const observations = [];
  for (const limitCase of limitCases()) {
    observations.push(await runCase(context, key, limitCase));
  }
  const disagreements = observations.filter((observation) => !observation.verdictsAgree);
  const listing = await attempt(() => context.store.list({ key }));
  const countLimit = context.args["skip-count"] ? undefined : await annotationCountLimit(context);
  return {
    inputs: { key, cases: observations.length, countLimitTested: Boolean(countLimit) },
    observations: [...observations, { label: "annotations left on the object", listing }, ...(countLimit ? [countLimit] : [])],
    conclusions: [
      `${observations.length - disagreements.length}/${observations.length} client-side verdicts match the server`,
      ...(countLimit
        ? [`1,001st annotation: ${countLimit.overLimit.ok ? "ACCEPTED" : `${countLimit.overLimit.error.name} HTTP ${countLimit.overLimit.error.httpStatusCode}`}; overwrite at limit: ${countLimit.overwriteAtLimit.ok ? "accepted" : countLimit.overwriteAtLimit.error.name}`]
        : []),
      ...disagreements.map((item) => `Disagreement on "${item.label}": client ${JSON.stringify(item.localVerdict)}, server ${item.serverAccepted ? "accepted" : item.serverError?.name}`),
    ],
  };
}

const definition: ExperimentDefinition = {
  id: "01-crud-and-limits",
  title: "Annotation name and payload limits against the real service",
  run,
};

await runExperiment(definition, process.argv.slice(2));
