import { GetBucketMetadataConfigurationCommand } from "@aws-sdk/client-s3";
import { ListNamespacesCommand, ListTableBucketsCommand } from "@aws-sdk/client-s3tables";
import { attempt } from "../src/lab/attempt";
import { AI_ANNOTATIONS, METADATA_TABLES, EXPERIMENT_PREFIX } from "../src/config/lab-config";
import { chooseReader, defaultReaders, type TableSample } from "../src/lab/annotation-table-readers";
import { numberArg, runExperiment, type ExperimentContext, type ExperimentDefinition, type ExperimentReport } from "../src/lab/experiment-runner";
import { putTextObject } from "../src/lab/object-helpers";
import { sleep } from "../src/lab/retry";

const DEFAULT_MAX_MINUTES = 90;
const DEFAULT_INTERVAL_SECONDS = 30;
const SEED_OBJECTS = 3;
const SECONDS_PER_MINUTE = 60;

interface Sample extends TableSample {
  elapsedSeconds: number;
  annotationTableStatus?: string;
  journalTableStatus?: string;
}

async function readConfiguration(context: ExperimentContext) {
  const response = await attempt(() => context.clients.s3.send(new GetBucketMetadataConfigurationCommand({ Bucket: context.names.bucket })));
  if (!response.ok) return { error: response.error };
  const result = response.value.GetBucketMetadataConfigurationResult?.MetadataConfigurationResult;
  return {
    namespace: result?.DestinationResult?.TableNamespace,
    tableBucketType: result?.DestinationResult?.TableBucketType,
    annotationTableStatus: result?.AnnotationTableConfigurationResult?.TableStatus,
    annotationTableName: result?.AnnotationTableConfigurationResult?.TableName,
    annotationTableError: result?.AnnotationTableConfigurationResult?.Error,
    journalTableStatus: result?.JournalTableConfigurationResult?.TableStatus,
    journalTableName: result?.JournalTableConfigurationResult?.TableName,
  };
}

async function listManagedNamespaces(context: ExperimentContext) {
  const buckets = await attempt(() => context.clients.s3tables.send(new ListTableBucketsCommand({ type: "aws", prefix: METADATA_TABLES.tableBucketName })));
  const arn = buckets.ok ? buckets.value.tableBuckets?.find((bucket) => bucket.name === METADATA_TABLES.tableBucketName)?.arn : undefined;
  if (!arn) return { tableBucketFound: false };
  const namespaces = await attempt(() => context.clients.s3tables.send(new ListNamespacesCommand({ tableBucketARN: arn })));
  return { tableBucketFound: true, namespaces: namespaces.ok ? namespaces.value.namespaces?.map((item) => item.namespace) : namespaces.error };
}

const seesData = (sample: TableSample): boolean =>
  (sample.rowCount ?? 0) > 0 || sample.tableExists === true;

async function seedAnnotations(context: ExperimentContext): Promise<number> {
  const stamp = Date.now();
  for (let index = 0; index < SEED_OBJECTS; index += 1) {
    const key = `${EXPERIMENT_PREFIX}exp07/${stamp}-${index}.txt`;
    await putTextObject(context.clients.s3, context.names.bucket, key, `table lag probe ${index}`);
    await context.store.putJson(key, AI_ANNOTATIONS.classification, { probe: index });
  }
  return Date.now();
}

async function pollTable(context: ExperimentContext, startedAtMs: number, intervalMs: number, deadlineMs: number, namespace: string) {
  const reader = await chooseReader(defaultReaders(context.clients, { bucket: context.names.bucket, namespace }));
  const samples: Sample[] = [];
  let timeToFirstRowSeconds: number | undefined;
  let timeToActiveSeconds: number | undefined;
  while (Date.now() < deadlineMs) {
    const sample = await reader.sample();
    const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1000);
    const configuration = await readConfiguration(context);
    const annotationTableStatus = "annotationTableStatus" in configuration ? configuration.annotationTableStatus : undefined;
    samples.push({
      ...sample,
      elapsedSeconds,
      annotationTableStatus,
      journalTableStatus: "journalTableStatus" in configuration ? configuration.journalTableStatus : undefined,
    });
    console.log(`t+${elapsedSeconds}s ${reader.kind}: ${JSON.stringify(sample)} annotationTable=${annotationTableStatus}`);
    if (seesData(sample)) timeToFirstRowSeconds ??= elapsedSeconds;
    if (annotationTableStatus === "ACTIVE") timeToActiveSeconds ??= elapsedSeconds;
    if (timeToFirstRowSeconds !== undefined && (reader.kind !== "table-status" || timeToActiveSeconds !== undefined)) break;
    await sleep(intervalMs);
  }
  return { reader: reader.kind, samples, timeToFirstRowSeconds, timeToActiveSeconds };
}

async function run(context: ExperimentContext): Promise<ExperimentReport> {
  const maxMinutes = numberArg(context.args, "max-minutes", DEFAULT_MAX_MINUTES);
  const intervalSeconds = numberArg(context.args, "interval-seconds", DEFAULT_INTERVAL_SECONDS);
  const configurationBefore = await readConfiguration(context);
  const namespacesBefore = await listManagedNamespaces(context);
  const namespace = ("namespace" in configurationBefore && configurationBefore.namespace) || context.names.metadataNamespace;
  const startedAtMs = await seedAnnotations(context);
  const outcome = await pollTable(context, startedAtMs, intervalSeconds * 1000, startedAtMs + maxMinutes * SECONDS_PER_MINUTE * 1000, namespace);
  const namespacesAfter = await listManagedNamespaces(context);
  const measured = outcome.reader === "table-status" ? "time until the table exists (rows not counted)" : "time to first row";

  return {
    inputs: { maxMinutes, intervalSeconds, seededObjects: SEED_OBJECTS, reader: outcome.reader, predictedNamespace: context.names.metadataNamespace, namespaceUsed: namespace },
    observations: [{ configurationBefore, namespacesBefore, namespacesAfter }, ...outcome.samples],
    conclusions: [
      `Namespace reported by GetBucketMetadataConfiguration: ${namespace} (predicted ${context.names.metadataNamespace})`,
      outcome.timeToFirstRowSeconds === undefined
        ? `Nothing observed within ${maxMinutes} minutes using the ${outcome.reader} reader`
        : `${measured}: ${outcome.timeToFirstRowSeconds} s after the first annotation write (reader: ${outcome.reader})`,
      `Annotation table status reached ACTIVE after: ${outcome.timeToActiveSeconds ?? "not observed"} s`,
      "Polling granularity is the interval; the lab bucket must have the annotation table enabled (scripts/enable-annotation-table.ts) before this run",
    ],
  };
}

const definition: ExperimentDefinition = {
  id: "07-annotation-table-lag",
  title: "Delay between writing annotations and seeing them in the annotation table",
  run,
};

await runExperiment(definition, process.argv.slice(2));
