import { EXPERIMENT_PREFIX } from "../src/config/lab-config";
import { attempt } from "../src/lab/attempt";
import { runExperiment, type ExperimentContext, type ExperimentDefinition, type ExperimentReport } from "../src/lab/experiment-runner";
import { deleteObject, headObject, putTextObject } from "../src/lab/object-helpers";

const NAME = "ai.note";

async function run({ store, clients, names }: ExperimentContext): Promise<ExperimentReport> {
  const { s3 } = clients;
  const key = `${EXPERIMENT_PREFIX}exp02/${Date.now()}.txt`;
  const observations: Record<string, unknown>[] = [];
  const record = (step: string, data: unknown) => observations.push({ step, data });

  const v1 = await putTextObject(s3, names.bucket, key, "version one");
  record("put object v1", v1);
  const etagBefore = (await headObject(s3, names.bucket, key, v1.versionId)).etag;
  await store.putJson(key, NAME, { owner: "v1", revision: 1 }, { versionId: v1.versionId });
  const etagAfter = (await headObject(s3, names.bucket, key, v1.versionId)).etag;
  record("object ETag before/after annotating v1", { etagBefore, etagAfter, unchanged: etagBefore === etagAfter });

  const v2 = await putTextObject(s3, names.bucket, key, "version two");
  record("put object v2 (same key)", v2);
  const listV2 = await attempt(() => store.list({ key, versionId: v2.versionId }));
  const listV1 = await attempt(() => store.list({ key, versionId: v1.versionId }));
  record("annotations on v2 (new version inherits?)", listV2);
  record("annotations on v1 (still there?)", listV1);

  const firstPut = await store.putJson(key, NAME, { owner: "v1", revision: 2 }, { versionId: v1.versionId });
  const read = await attempt(() => store.getJson({ key, versionId: v1.versionId }, NAME));
  record("overwrite same name on v1", { putEtag: firstPut.etag, readBack: read });
  record("history API", "none: the four operations expose no previous payload; only the latest is readable");

  const marker = await deleteObject(s3, names.bucket, key);
  record("delete without versionId (delete marker)", marker);
  const afterMarkerLatest = await attempt(() => store.list({ key }));
  const afterMarkerV1 = await attempt(() => store.list({ key, versionId: v1.versionId }));
  record("list latest after delete marker", afterMarkerLatest);
  record("list v1 after delete marker", afterMarkerV1);

  return {
    inputs: { key, annotationName: NAME },
    observations,
    conclusions: [
      `Annotating changed the object ETag: ${etagBefore !== etagAfter}`,
      `v2 annotations: ${listV2.ok ? listV2.value.length : listV2.error.name}; v1 annotations: ${listV1.ok ? listV1.value.length : listV1.error.name}`,
      `v1 annotations after delete marker: ${afterMarkerV1.ok ? afterMarkerV1.value.length : afterMarkerV1.error.name}`,
    ],
  };
}

const definition: ExperimentDefinition = {
  id: "02-versioning",
  title: "Annotations and object versions: inheritance, overwrite, ETag, delete markers",
  run,
};

await runExperiment(definition, process.argv.slice(2));
