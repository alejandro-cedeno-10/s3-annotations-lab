# Amazon S3 annotations for generative-AI builders: a measurement lab

Companion code for the article *"S3 annotations: dónde guardar lo que tu modelo dice sobre cada documento"* (Spanish, on Medium).

[Amazon S3 annotations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/annotations-overview.html) (launched 2026-06-16) attach named, versioned payloads to S3 objects. They are a natural place for the context a model produces about a document, but they are not a database: no history, no conditional write on the annotation itself, and a queryable table that arrives with a delay.

This repository does two things:

- **A reference pipeline.** An S3 upload triggers EventBridge, which invokes a Lambda that asks Amazon Bedrock (Nova Lite, temperature 0) to classify the document, validates the JSON with a zod schema, and writes it as the `ai.classification` annotation. Labels are proposals (`review_required: true`). A helper derives the `.metadata.json` sidecar that Bedrock Knowledge Bases reads.
- **Seven experiments** that measure what the documentation only describes, above all the lost update when two writers read-modify-write the same annotation name.

Nothing here is taken on trust from the announcement posts: each claim worth designing around has an experiment that records the real service behavior in `results/`.

## Repository layout

| Path | Contents |
|---|---|
| `src/config/lab-config.ts` | Single source of truth: annotation names, limits, model id, tag keys, resource naming. |
| `src/annotations/` | Name rules (1-512 bytes, letters/digits/`_`.`-`, no `aws`/`s3` prefix), payload rules (1 byte to 1 MiB, UTF-8), and a typed `AnnotationStore` over Put/Get/List/Delete with `ObjectIfMatch` and `VersionId`. |
| `src/enrichment/` | zod schema, tolerant JSON extraction from model output, Bedrock Converse classifier, the EventBridge handler and the Lambda entry point. |
| `src/rag/knowledge-base-sidecar.ts` | Builds the Bedrock Knowledge Base sidecar from the annotation and enforces its 10 KB limit. |
| `src/lab/` | Manifest, resource deletion table, teardown and leftover detection, IAM documents, annotation-table readers, experiment runner. |
| `scripts/` | `build-lambda`, `deploy`, `enable-annotation-table`, `teardown`, `verify-clean`, `smoke-handler`. |
| `experiments/` | `01` to `07`, each writes a JSON result to `results/`. |
| `fixtures/docs/` | Synthetic documents with fictitious personal data, plus one with a prompt-injection attempt. |
| `test/` | Vitest with `aws-sdk-client-mock`; no network. |

`results/`, `.lab/` and `dist/` are not versioned.

## Prerequisites

- Node.js 22 and [pnpm](https://pnpm.io) (this repo is pnpm only).
- For the AWS part: an AWS account, a profile exported as `AWS_PROFILE` (the scripts refuse to use default credentials implicitly), Amazon Bedrock access to Nova Lite through the `us.amazon.nova-lite-v1:0` inference profile in `us-east-1`, and permissions to create the resources listed below.
- Experiment 7 only: permission to configure S3 Metadata and S3 Tables. Optionally the DuckDB CLI on your PATH (see below).

## Quick start (no AWS needed)

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build:lambda   # bundles @aws-sdk/client-s3 into dist/enrichment-lambda.zip
pnpm smoke          # runs the handler against mocked S3 and Bedrock
```

The Lambda zip bundles its own `@aws-sdk/client-s3` (3.1165.0 or later) instead of relying on the SDK that ships with the Lambda runtime, which may predate the annotation APIs. The build fails if the bundle does not contain them.

## Running against AWS

Everything is created in `us-east-1` and recorded in `.lab/manifest.json` before it is created.

```bash
export AWS_PROFILE=<your-profile>

pnpm build:lambda
pnpm run deploy                       # bucket, role, Lambda, log group, EventBridge rule

pnpm exec tsx experiments/01-crud-and-limits.ts
pnpm exec tsx experiments/02-versioning.ts
pnpm exec tsx experiments/03-copy-directive.ts
pnpm exec tsx experiments/04-if-match.ts
pnpm exec tsx experiments/05-lost-update.ts --rounds=20 --jitter-ms=30
pnpm exec tsx experiments/06-pipeline.ts

pnpm enable-annotation-table      # opt-in, only for experiment 7
pnpm exec tsx experiments/07-annotation-table-lag.ts --max-minutes=90 --interval-seconds=30

pnpm teardown
pnpm verify-clean --archive
```

What `pnpm run deploy` creates, all tagged `lab=s3-annotations-lab`, `run-id=<id>` and the required tag set from `src/config/lab-config.ts`:

| Resource | Notes |
|---|---|
| S3 bucket `s3-annotations-lab-<run-id>` | Versioned, SSE-S3, public access blocked, EventBridge notifications on. |
| IAM role for the Lambda | Least privilege: object read and annotation read/write on `docs/*` of that bucket, `bedrock:InvokeModel` on the Nova Lite inference profile and foundation model, writes to its own log group. |
| Lambda (`nodejs22.x`, arm64) | The bundled zip. |
| CloudWatch log group | Created explicitly, retention 1 day. |
| EventBridge rule and Lambda permission | `Object Created`, bucket and prefix `docs/`. |

Tags are sent inside each create call (for the bucket, in `CreateBucketConfiguration.Tags`), not applied afterwards, because an account may reject untagged creation. If your account requires extra tags, pass them as a JSON object in the `LAB_EXTRA_TAGS` environment variable, for example `LAB_EXTRA_TAGS='{"Team":"my-team"}'`; they are added to every taggable resource the lab creates.

## The experiments

Each writes `results/<experiment>.json` (timestamps, inputs, observed outputs and error names, HTTP status) and prints a summary.

| # | Question it answers |
|---|---|
| 01 | Which names and payloads does the real service reject, with which error, and does the client-side validator agree? Covers `aws`/`s3` prefixes in any case, 512-byte names (ASCII and multibyte), non-UTF-8 payloads and the 1 MiB boundary. |
| 02 | Does a new object version inherit annotations? Does overwriting a name keep history? Does annotating change the object ETag? What survives a delete marker? |
| 03 | What does `CopyObject` do with `AnnotationDirective` unset, `COPY` and `EXCLUDE`? |
| 04 | What exact error name and HTTP status does a stale `ObjectIfMatch` produce, on put and on delete? |
| 05 | The centerpiece. Two writers read-modify-write one field each of the same annotation, concurrently, with random jitter, for N rounds (default 20), compared with one annotation name per writer. Reports lost fields per round and in total. |
| 06 | Real pipeline: uploads the fixtures, polls until `ai.classification` appears, records upload-to-annotation latency, validates the payload with the zod schema, and checks whether the injection fixture changed the label. |
| 07 | How long until annotations show up in the managed `annotation` table of S3 Metadata. |

`ObjectIfMatch` validates the ETag of the parent object, not of the annotation. When a `VersionId` is also sent, the ETag is compared with that version, so it does not detect that a newer version replaced it: the annotation lands on the version that was read, which is what the Lambda relies on. It does not serialize two writers of the same annotation name; experiment 05 shows what that costs.

### Experiment 7 and what it does not touch

`pnpm enable-annotation-table` creates an IAM role trusted by `metadata.s3.amazonaws.com` (conditioned on `aws:SourceAccount` and `aws:SourceArn`) and a bucket metadata configuration with the journal and annotation tables (inventory disabled). Before creating anything it records in the manifest whether the AWS-managed table bucket `aws-s3` already existed, so teardown removes it only if this lab created it and it is empty.

It never enables an account-level analytics integration (no Lake Formation or Glue `s3tablescatalog` setup). The experiment reads rows with the first available option:

1. Athena, only if the account already has the `s3tablescatalog` Glue catalog.
2. A local read of the Iceberg table with the DuckDB CLI (iceberg extension, `s3_tables` endpoint), if `duckdb` is on your PATH.
3. Otherwise `s3tables:GetTable` status, which measures time until the table exists, not time to first row. The result file says which reader was used.

## Cost

Expected total under USD 1 for one full run in `us-east-1`: a few hundred small S3 requests and annotation writes, a handful of Nova Lite calls on a few short documents, Lambda and log storage for minutes, and, for experiment 7, a journal and annotation table that exist for the duration of the test. Prices change and depend on your account; check the current S3, S3 Tables and Bedrock pricing pages before running. Run teardown as soon as you finish.

## Cleanup

```bash
pnpm teardown              # deletes only what .lab/manifest.json lists, newest first
pnpm verify-clean --archive
```

`teardown` is idempotent (a missing resource counts as deleted). It removes the metadata configuration, the tables in the `b_<bucket>` namespace and the namespace, the EventBridge rule targets and rule, the Lambda, the log group, the IAM roles (inline policies first) and the bucket with every object version and delete marker. It never lists or deletes anything by prefix outside the manifest. `verify-clean` exits non-zero if any manifest resource still exists or if its absence cannot be confirmed; `--archive` then moves the manifest aside so a new deploy can start.

## Security notes

The AWS account id is read from STS at runtime and is never written to a committed file. `.lab/` (the manifest) and `results/` (run outputs) are git-ignored; they contain your account id and resource names, so mask them before sharing. The Lambda role is limited to the lab bucket, the `docs/` prefix and the Nova Lite inference profile. Fixture documents are synthetic and contain fictitious data only; one of them (`injection-en.txt`) is a deliberate prompt-injection probe.

## Disclaimer

Results depend on your account, region and the service version on the day you run them. The numbers in the article come from one run in `us-east-1` on 2026-11-10 and are evidence, not guarantees; S3 annotations are new and behavior can change. Review the IAM documents in `src/lab/iam-documents.ts` before deploying into an account you care about. The trust policy conditions for the metadata role and the exact error names the service returns are assumptions that the lab verifies rather than documents.

## License

MIT. See [`LICENSE`](LICENSE).
