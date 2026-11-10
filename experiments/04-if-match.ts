import { EXPERIMENT_PREFIX } from "../src/config/lab-config";
import { attempt, type Attempt } from "../src/lab/attempt";
import { runExperiment, type ExperimentContext, type ExperimentDefinition, type ExperimentReport } from "../src/lab/experiment-runner";
import { putTextObject } from "../src/lab/object-helpers";

const NAME = "ai.guarded";

const unquoted = (etag: string): string => etag.replace(/"/g, "");

const verdict = (label: string, result: Attempt<unknown>): string =>
  `${label}: ${result.ok ? "ACCEPTED (condition not enforced)" : `${result.error.name} HTTP ${result.error.httpStatusCode}`}`;

async function run({ store, clients, names }: ExperimentContext): Promise<ExperimentReport> {
  const { s3 } = clients;
  const key = `${EXPERIMENT_PREFIX}exp04/${Date.now()}.txt`;
  const first = await putTextObject(s3, names.bucket, key, "first body");
  const second = await putTextObject(s3, names.bucket, key, "second body, different ETag");

  const withCurrent = await attempt(() => store.putJson(key, NAME, { by: "current etag" }, { objectIfMatch: second.etag }));
  const withCurrentUnquoted = await attempt(() => store.putJson(key, NAME, { by: "current etag unquoted" }, { objectIfMatch: unquoted(second.etag) }));
  const staleQuoted = await attempt(() => store.putJson(key, NAME, { by: "stale etag" }, { objectIfMatch: first.etag }));
  const staleUnquoted = await attempt(() => store.putJson(key, NAME, { by: "stale etag unquoted" }, { objectIfMatch: unquoted(first.etag) }));
  const staleWithOldVersion = await attempt(() =>
    store.putJson(key, NAME, { by: "stale etag, explicit old versionId" }, { objectIfMatch: first.etag, versionId: first.versionId }),
  );
  const deleteStaleQuoted = await attempt(() => store.delete({ key }, NAME, first.etag));
  const deleteStaleUnquoted = await attempt(() => store.delete({ key }, NAME, unquoted(first.etag)));
  const afterStale = await attempt(() => store.getJson({ key }, NAME));
  const deleteCurrent = await attempt(() => store.delete({ key }, NAME, second.etag));
  const afterDelete = await attempt(() => store.getJson({ key }, NAME));

  return {
    inputs: { key, staleEtag: first.etag, currentEtag: second.etag },
    observations: [
      { step: "put with current ETag (quoted)", result: withCurrent },
      { step: "put with current ETag (unquoted)", result: withCurrentUnquoted },
      { step: "put with stale ETag (quoted)", result: staleQuoted },
      { step: "put with stale ETag (unquoted)", result: staleUnquoted },
      { step: "put with stale ETag and explicit old versionId", result: staleWithOldVersion },
      { step: "delete with stale ETag (quoted)", result: deleteStaleQuoted },
      { step: "delete with stale ETag (unquoted)", result: deleteStaleUnquoted },
      { step: "annotation after the stale attempts", result: afterStale },
      { step: "delete with current ETag", result: deleteCurrent },
      { step: "annotation after the conditional delete", result: afterDelete },
    ],
    conclusions: [
      verdict("Put, stale ETag quoted", staleQuoted),
      verdict("Put, stale ETag unquoted", staleUnquoted),
      verdict("Put, current ETag unquoted", withCurrentUnquoted),
      verdict("Delete, stale ETag quoted", deleteStaleQuoted),
      verdict("Delete, stale ETag unquoted", deleteStaleUnquoted),
      "ObjectIfMatch compares the parent object's ETag, never the annotation's: see experiment 05 for why that does not serialize annotation writers",
    ],
  };
}

const definition: ExperimentDefinition = {
  id: "04-if-match",
  title: "ObjectIfMatch with a stale ETag: exact error name and HTTP status on Put and Delete",
  run,
};

await runExperiment(definition, process.argv.slice(2));
