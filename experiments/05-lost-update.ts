import { attempt } from "../src/lab/attempt";
import type { ErrorInfo } from "../src/aws/error-info";
import { EXPERIMENT_PREFIX } from "../src/config/lab-config";
import { jitterMs, findLostFields, readsInterleaved, summarizeRounds, type FieldMap, type RoundOutcome, type WriterTiming } from "../src/lab/lost-update";
import { numberArg, runExperiment, type ExperimentContext, type ExperimentDefinition, type ExperimentReport } from "../src/lab/experiment-runner";
import { putTextObject } from "../src/lab/object-helpers";
import { sleep } from "../src/lab/retry";

const serviceErrors: Array<{ round: number; writer: Writer; name: string; error: ErrorInfo }> = [];

const DEFAULT_ROUNDS = 20;
const DEFAULT_JITTER_MS = 30;
const SHARED_NAME = "ai.shared";
const WRITERS = ["a", "b"] as const;

type Writer = (typeof WRITERS)[number];

const fieldOf = (writer: Writer): string => `field_${writer}`;
const valueOf = (writer: Writer, round: number): string => `value-${writer}-${round}`;
const expectedFields = (round: number): FieldMap =>
  Object.fromEntries(WRITERS.map((writer) => [fieldOf(writer), valueOf(writer, round)]));

interface Settings {
  rounds: number;
  jitter: number;
}

async function readFields(context: ExperimentContext, key: string, name: string): Promise<FieldMap> {
  const { value } = await context.store.getJson<FieldMap>({ key }, name);
  return value;
}

/**
 * Read-modify-write of one field of the JSON stored under `name`. The jitter before the read
 * spreads the two writers over the window in which their read and write can interleave.
 */
async function updateField(context: ExperimentContext, key: string, name: string, writer: Writer, round: number, jitter: number) {
  await sleep(jitterMs(jitter));
  const startMs = performance.now();
  let readEndMs = startMs;
  const outcome = await attempt(async () => {
    const current = await readFields(context, key, name);
    readEndMs = performance.now();
    await context.store.putJson(key, name, { ...current, [fieldOf(writer)]: valueOf(writer, round) });
  });
  if (!outcome.ok) serviceErrors.push({ round, writer, name, error: outcome.error });
  return { writer, startMs, readEndMs, writeEndMs: performance.now() } satisfies WriterTiming;
}

const roundTimings: Array<{ round: number; interleaved: boolean; timings: WriterTiming[] }> = [];

const recordTimings = (round: number, timings: WriterTiming[]): void => {
  const [first, second] = timings;
  if (first && second) {
    const base = Math.min(first.startMs, second.startMs);
    roundTimings.push({
      round,
      interleaved: readsInterleaved(first, second),
      timings: timings.map((timing) => ({ writer: timing.writer, startMs: Math.round(timing.startMs - base), readEndMs: Math.round(timing.readEndMs - base), writeEndMs: Math.round(timing.writeEndMs - base) })),
    });
  }
};

async function sharedNameRound(context: ExperimentContext, round: number, settings: Settings): Promise<RoundOutcome> {
  const key = `${EXPERIMENT_PREFIX}exp05/shared-${Date.now()}-${round}.txt`;
  await putTextObject(context.clients.s3, context.names.bucket, key, `round ${round}`);
  await context.store.putJson(key, SHARED_NAME, { seed: "initial" });
  recordTimings(round, await Promise.all(WRITERS.map((writer) => updateField(context, key, SHARED_NAME, writer, round, settings.jitter))));
  const finalDocument = await readFields(context, key, SHARED_NAME);
  return { round, lostFields: findLostFields(expectedFields(round), finalDocument), finalDocuments: { [SHARED_NAME]: finalDocument } };
}

async function nameForWriterRound(context: ExperimentContext, round: number, settings: Settings): Promise<RoundOutcome> {
  const key = `${EXPERIMENT_PREFIX}exp05/per-writer-${Date.now()}-${round}.txt`;
  await putTextObject(context.clients.s3, context.names.bucket, key, `round ${round}`);
  const nameOf = (writer: Writer) => `ai.writer-${writer}`;
  await Promise.all(WRITERS.map((writer) => context.store.putJson(key, nameOf(writer), { seed: "initial" })));
  await Promise.all(WRITERS.map((writer) => updateField(context, key, nameOf(writer), writer, round, settings.jitter)));
  const documents = Object.fromEntries(await Promise.all(WRITERS.map(async (writer) => [nameOf(writer), await readFields(context, key, nameOf(writer))] as const)));
  const lostFields = WRITERS.flatMap((writer) =>
    findLostFields({ [fieldOf(writer)]: valueOf(writer, round) }, documents[nameOf(writer)] ?? {}),
  );
  return { round, lostFields, finalDocuments: documents };
}

async function runVariant(label: string, rounds: number, play: (round: number) => Promise<RoundOutcome>) {
  const outcomes: RoundOutcome[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    outcomes.push(await play(round));
  }
  return { label, totals: summarizeRounds(outcomes), outcomes };
}

async function run(context: ExperimentContext): Promise<ExperimentReport> {
  const settings: Settings = {
    rounds: numberArg(context.args, "rounds", DEFAULT_ROUNDS),
    jitter: numberArg(context.args, "jitter-ms", DEFAULT_JITTER_MS),
  };
  const shared = await runVariant("one shared name, two writers", settings.rounds, (round) => sharedNameRound(context, round, settings));
  const perWriter = await runVariant("one name per writer", settings.rounds, (round) => nameForWriterRound(context, round, settings));

  return {
    inputs: { ...settings, writers: WRITERS.length, sharedName: SHARED_NAME },
    observations: [shared, perWriter, { serviceErrors }, { sharedNameRoundTimingsMs: roundTimings }],
    conclusions: [
      ...[shared, perWriter].map(({ label, totals }) => `${label}: ${totals.lostFields} lost fields in ${totals.roundsWithLoss}/${totals.rounds} rounds`),
      `Shared-name rounds where both reads preceded the other write: ${roundTimings.filter((item) => item.interleaved).length}/${roundTimings.length}`,
      `Service errors during concurrent writes: ${serviceErrors.length}${serviceErrors.length ? ` (${[...new Set(serviceErrors.map((item) => `${item.error.name} ${item.error.httpStatusCode}`))].join(", ")})` : ""}`,
    ],
  };
}

const definition: ExperimentDefinition = {
  id: "05-lost-update",
  title: "Lost update: two read-modify-write writers on the same annotation name",
  run,
};

await runExperiment(definition, process.argv.slice(2));
