import { PutObjectCommand } from "@aws-sdk/client-s3";
import { EXPERIMENT_PREFIX, MEBIBYTE } from "../src/config/lab-config";
import { attempt } from "../src/lab/attempt";
import { COPY_PROPS_VALUES, copyCommandArgs, runAwsCli } from "../src/lab/cli-copy";
import { runExperiment, type ExperimentContext, type ExperimentDefinition, type ExperimentReport } from "../src/lab/experiment-runner";
import { copyObject, headObject, putTextObject } from "../src/lab/object-helpers";

type Directive = "COPY" | "EXCLUDE" | undefined;

const DIRECTIVE_CASES: ReadonlyArray<{ label: string; directive: Directive }> = [
  { label: "default (no directive)", directive: undefined },
  { label: "COPY", directive: "COPY" },
  { label: "EXCLUDE", directive: "EXCLUDE" },
];

const BIG_OBJECT_MEBIBYTES = 17;
const CAPTURE_MIDDLEWARE = "captureAnnotationHeaders";
const ANNOTATION_HEADER = /annotation/i;

async function capturedCopyHeaders(context: ExperimentContext, sourceKey: string, targetKey: string) {
  const captured: Record<string, string> = {};
  const { s3 } = context.clients;
  s3.middlewareStack.add(
    (next) => async (args) => {
      const headers = (args.request as { headers?: Record<string, string> }).headers ?? {};
      for (const [name, value] of Object.entries(headers)) {
        if (ANNOTATION_HEADER.test(name)) captured[name] = value;
      }
      return next(args);
    },
    { step: "finalizeRequest", name: CAPTURE_MIDDLEWARE },
  );
  await attempt(() => copyObject(s3, context.names.bucket, sourceKey, targetKey, "EXCLUDE"));
  s3.middlewareStack.remove(CAPTURE_MIDDLEWARE);
  return captured;
}

async function smallObjectCopies(context: ExperimentContext, stamp: number) {
  const { store, clients, names } = context;
  const sourceKey = `${EXPERIMENT_PREFIX}exp03/${stamp}-source.txt`;
  await putTextObject(clients.s3, names.bucket, sourceKey, "copy source");
  await store.putJson(sourceKey, "ai.classification-probe", { doc_type: "other" });
  await store.putJson(sourceKey, "ai.second", { n: 2 });

  const observations = [];
  for (const { label, directive } of DIRECTIVE_CASES) {
    const targetKey = `${EXPERIMENT_PREFIX}exp03/${stamp}-${label.replace(/\W+/g, "-")}.txt`;
    const copy = await attempt(() => copyObject(clients.s3, names.bucket, sourceKey, targetKey, directive));
    const listing = copy.ok ? await attempt(() => store.list({ key: targetKey })) : undefined;
    observations.push({ label, directive: directive ?? null, copy, annotationsOnTarget: listing });
  }
  const wireHeaders = await capturedCopyHeaders(context, sourceKey, `${EXPERIMENT_PREFIX}exp03/${stamp}-header-probe.txt`);
  return { sourceKey, observations, wireHeaders };
}

async function uploadBigObject(context: ExperimentContext, key: string): Promise<void> {
  const body = Buffer.alloc(BIG_OBJECT_MEBIBYTES * MEBIBYTE, 97);
  await context.clients.s3.send(new PutObjectCommand({ Bucket: context.names.bucket, Key: key, Body: body }));
  await context.store.putJson(key, "ai.classification-probe", { doc_type: "other", note: "multipart copy probe" });
  await context.store.putJson(key, "ai.second", { n: 2 });
}

async function multipartCliCopies(context: ExperimentContext, stamp: number) {
  const { store, clients, names } = context;
  const sourceKey = `${EXPERIMENT_PREFIX}exp03/${stamp}-big.bin`;
  await uploadBigObject(context, sourceKey);
  const results = [];
  for (const copyProps of COPY_PROPS_VALUES) {
    const targetKey = `${EXPERIMENT_PREFIX}exp03/${stamp}-big-copy-${copyProps}.bin`;
    const startedAt = new Date();
    const cli = await runAwsCli(copyCommandArgs({ bucket: names.bucket, sourceKey, targetKey, copyProps }), clients.profile);
    const finishedAt = new Date();
    const exists = await attempt(() => headObject(clients.s3, names.bucket, targetKey));
    const annotations = exists.ok ? await attempt(() => store.list({ key: targetKey })) : undefined;
    results.push({ copyProps, command: `aws ${copyCommandArgs({ bucket: "<bucket>", sourceKey, targetKey, copyProps }).join(" ")}`, startedAt, finishedAt, cli, targetExists: exists.ok, annotations });
  }
  return { sourceKey, sizeMebibytes: BIG_OBJECT_MEBIBYTES, results };
}

async function run(context: ExperimentContext): Promise<ExperimentReport> {
  const stamp = Date.now();
  const small = await smallObjectCopies(context, stamp);
  const sdkBig = await sdkCopyOfBigObject(context, stamp);
  const multipart = await multipartCliCopies(context, stamp);

  const count = (listing: Awaited<ReturnType<typeof attempt<{ name: string }[]>>> | undefined) =>
    listing?.ok ? listing.value.length : "n/a";
  return {
    inputs: { sourceAnnotations: 2, bigObjectMebibytes: BIG_OBJECT_MEBIBYTES },
    observations: [{ part: "CopyObject directives (tiny object)", ...small }, { part: "CopyObject SDK, 17 MiB, default", sdkBig }, { part: "aws s3 cp, 17 MiB (multipart copy)", ...multipart }],
    conclusions: [
      ...small.observations.map((item) => `${item.label}: ${count(item.annotationsOnTarget)} annotations on the copy`),
      `Wire headers carrying "annotation" on CopyObject EXCLUDE: ${JSON.stringify(small.wireHeaders)}`,
      `SDK CopyObject of 17 MiB (no directive): ${count(sdkBig.annotations)} annotations`,
      ...multipart.results.map((item) => `aws s3 cp --copy-props ${item.copyProps}: exit ${item.cli.exitCode}, ${count(item.annotations)} annotations on the copy`),
    ],
  };
}

async function sdkCopyOfBigObject(context: ExperimentContext, stamp: number) {
  const sourceKey = `${EXPERIMENT_PREFIX}exp03/${stamp}-big-sdk-source.bin`;
  await uploadBigObject(context, sourceKey);
  const targetKey = `${EXPERIMENT_PREFIX}exp03/${stamp}-big-sdk-copy.bin`;
  const copy = await attempt(() => copyObject(context.clients.s3, context.names.bucket, sourceKey, targetKey));
  const annotations = copy.ok ? await attempt(() => context.store.list({ key: targetKey })) : undefined;
  return { copy, annotations };
}

const definition: ExperimentDefinition = {
  id: "03-copy-directive",
  title: "CopyObject directives, wire header, and multipart copy through the AWS CLI",
  run,
};

await runExperiment(definition, process.argv.slice(2));
