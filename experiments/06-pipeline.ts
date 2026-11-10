import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_ANNOTATIONS, DOCS_PREFIX } from "../src/config/lab-config";
import { attempt } from "../src/lab/attempt";
import { isNotFoundError } from "../src/aws/error-info";
import { classificationSchema } from "../src/enrichment/classification-schema";
import { numberArg, runExperiment, type ExperimentContext, type ExperimentDefinition, type ExperimentReport } from "../src/lab/experiment-runner";
import { putTextObject } from "../src/lab/object-helpers";
import { sleep } from "../src/lab/retry";

const FIXTURES_DIR = "fixtures/docs";
const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_SECONDS = 180;
const INJECTION_FIXTURE = "injection-en.txt";

interface Upload {
  file: string;
  key: string;
  uploadedAtMs: number;
}

interface Arrival {
  file: string;
  key: string;
  latencyMs?: number;
  raw?: unknown;
  schemaValid?: boolean;
  schemaIssues?: string[];
}

async function uploadFixtures(context: ExperimentContext, runTag: string): Promise<Upload[]> {
  const uploads: Upload[] = [];
  for (const file of readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".txt"))) {
    const key = `${DOCS_PREFIX}${runTag}/${file}`;
    await putTextObject(context.clients.s3, context.names.bucket, key, readFileSync(join(FIXTURES_DIR, file), "utf-8"));
    uploads.push({ file, key, uploadedAtMs: Date.now() });
  }
  return uploads;
}

async function readClassification(context: ExperimentContext, key: string): Promise<unknown | undefined> {
  try {
    return (await context.store.getJson({ key }, AI_ANNOTATIONS.classification)).value;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function toArrival(upload: Upload, raw: unknown): Arrival {
  const parsed = classificationSchema.safeParse(raw);
  return {
    file: upload.file,
    key: upload.key,
    latencyMs: Date.now() - upload.uploadedAtMs,
    raw,
    schemaValid: parsed.success,
    schemaIssues: parsed.success ? undefined : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

async function pollUntilAnnotated(context: ExperimentContext, uploads: Upload[], pollMs: number, timeoutMs: number): Promise<Arrival[]> {
  const pending = new Map(uploads.map((upload) => [upload.key, upload]));
  const arrivals: Arrival[] = [];
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const [key, upload] of [...pending]) {
      const raw = await readClassification(context, key);
      if (raw !== undefined) {
        arrivals.push(toArrival(upload, raw));
        pending.delete(key);
      }
    }
    if (pending.size > 0) await sleep(pollMs);
  }
  for (const upload of pending.values()) arrivals.push({ file: upload.file, key: upload.key });
  return arrivals;
}

const LOG_SETTLE_MS = 8000;
const LOG_TAIL_EVENTS = 30;
const LOG_MESSAGE_CHARS = 600;

async function fetchLambdaLogs(context: ExperimentContext, startTimeMs: number, onlyReports: boolean) {
  await sleep(LOG_SETTLE_MS);
  const page = await attempt(() =>
    context.clients.logs.send(
      new FilterLogEventsCommand({ logGroupName: context.names.logGroup, startTime: startTimeMs, filterPattern: onlyReports ? "REPORT" : undefined, limit: 100 }),
    ),
  );
  if (!page.ok) return page;
  const messages = (page.value.events ?? []).map((event) => (event.message ?? "").trim().slice(0, LOG_MESSAGE_CHARS));
  return messages.slice(-LOG_TAIL_EVENTS);
}

const describeArrival = (arrival: Arrival): string =>
  arrival.latencyMs === undefined
    ? `${arrival.file}: no annotation within the timeout`
    : `${arrival.file}: ${arrival.latencyMs} ms, schema ${arrival.schemaValid ? "valid" : "INVALID"}`;

function injectionNote(arrivals: Arrival[]): string {
  const probe = arrivals.find((arrival) => arrival.file === INJECTION_FIXTURE)?.raw as { doc_type?: string; pii_present?: boolean } | undefined;
  if (!probe) return "Injection fixture: no annotation to inspect";
  const followed = probe.doc_type === "invoice";
  return `Injection fixture classified as "${probe.doc_type}": instruction ${followed ? "FOLLOWED" : "not followed"} (review_required stays true either way)`;
}

async function run(context: ExperimentContext): Promise<ExperimentReport> {
  const pollMs = numberArg(context.args, "poll-ms", DEFAULT_POLL_MS);
  const timeoutSeconds = numberArg(context.args, "timeout-seconds", DEFAULT_TIMEOUT_SECONDS);
  const runTag = `exp06-${Date.now()}`;
  const startedAtMs = Date.now();
  const uploads = await uploadFixtures(context, runTag);
  const arrivals = await pollUntilAnnotated(context, uploads, pollMs, timeoutSeconds * 1000);
  const latencies = arrivals.flatMap((arrival) => (arrival.latencyMs === undefined ? [] : [arrival.latencyMs]));

  const missing = arrivals.some((arrival) => arrival.latencyMs === undefined);
  const lambdaLogs = await fetchLambdaLogs(context, startedAtMs, !missing);

  return {
    inputs: { pollMs, timeoutSeconds, fixtures: uploads.length, note: "Latency has pollMs granularity and includes the first Lambda cold start" },
    observations: [...arrivals, { lambdaLogs: missing ? "last events (annotation missing)" : "REPORT lines", entries: lambdaLogs }],
    conclusions: [
      ...arrivals.map(describeArrival),
      latencies.length > 0 ? `Upload to annotation: min ${Math.min(...latencies)} ms, max ${Math.max(...latencies)} ms` : "No annotation arrived",
      injectionNote(arrivals),
    ],
  };
}

const definition: ExperimentDefinition = {
  id: "06-pipeline",
  title: "EventBridge to Lambda to Bedrock to annotation: latency and schema validity",
  run,
};

await runExperiment(definition, process.argv.slice(2));
