import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from "@aws-sdk/client-athena";
import { GetCatalogCommand } from "@aws-sdk/client-glue";
import { GetTableCommand, ListTableBucketsCommand } from "@aws-sdk/client-s3tables";
import { isNotFoundError } from "../aws/error-info";
import { METADATA_TABLES } from "../config/lab-config";
import type { LabClients } from "./aws-clients";
import { sleep } from "./retry";

const run = promisify(execFile);

export const S3_TABLES_CATALOG = "s3tablescatalog";
const ATHENA_POLL_MS = 1500;
const ATHENA_MAX_POLLS = 60;
const DUCKDB_BINARY = "duckdb";
const DUCKDB_TIMEOUT_MS = 120_000;
const ATHENA_RESULTS_PREFIX = "athena-results/";

export type ReaderKind = "athena" | "duckdb" | "table-status";

export interface TableSample {
  reader: ReaderKind;
  rowCount?: number;
  tableExists?: boolean;
  detail?: string;
}

export interface TableReader {
  kind: ReaderKind;
  isAvailable(): Promise<boolean>;
  sample(): Promise<TableSample>;
}

export interface TableTarget {
  bucket: string;
  namespace: string;
}

const rowCountSql = (target: TableTarget, catalogPath: string): string =>
  `SELECT count(*) FROM ${catalogPath}"${target.namespace}"."${METADATA_TABLES.annotationTableName}"`;

async function findTableBucketArn(clients: LabClients): Promise<string | undefined> {
  const page = await clients.s3tables.send(new ListTableBucketsCommand({ type: "aws", prefix: METADATA_TABLES.tableBucketName }));
  return (page.tableBuckets ?? []).find((bucket) => bucket.name === METADATA_TABLES.tableBucketName)?.arn;
}

/**
 * Reads through Athena only when the account already has the s3tablescatalog Glue catalog. The
 * lab never creates that account-level integration.
 */
export function athenaReader(clients: LabClients, target: TableTarget): TableReader {
  const catalogPath = `"${S3_TABLES_CATALOG}/${METADATA_TABLES.tableBucketName}".`;
  return {
    kind: "athena",
    async isAvailable() {
      try {
        await clients.glue.send(new GetCatalogCommand({ CatalogId: S3_TABLES_CATALOG }));
        return true;
      } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
    },
    async sample() {
      const started = await clients.athena.send(
        new StartQueryExecutionCommand({
          QueryString: rowCountSql(target, catalogPath),
          ResultConfiguration: { OutputLocation: `s3://${target.bucket}/${ATHENA_RESULTS_PREFIX}` },
        }),
      );
      const id = started.QueryExecutionId;
      for (let poll = 0; poll < ATHENA_MAX_POLLS; poll += 1) {
        const execution = await clients.athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
        const state = execution.QueryExecution?.Status?.State;
        if (state === "SUCCEEDED") {
          const results = await clients.athena.send(new GetQueryResultsCommand({ QueryExecutionId: id }));
          const value = results.ResultSet?.Rows?.[1]?.Data?.[0]?.VarCharValue;
          return { reader: "athena", rowCount: Number(value ?? 0) };
        }
        if (state === "FAILED" || state === "CANCELLED") {
          return { reader: "athena", detail: execution.QueryExecution?.Status?.StateChangeReason ?? state };
        }
        await sleep(ATHENA_POLL_MS);
      }
      return { reader: "athena", detail: "query did not finish in time" };
    },
  };
}

const duckdbScript = (tableBucketArn: string, target: TableTarget): string =>
  [
    "INSTALL aws; INSTALL httpfs; INSTALL iceberg; LOAD aws; LOAD httpfs; LOAD iceberg;",
    "CREATE OR REPLACE SECRET lab_s3 (TYPE s3, PROVIDER credential_chain);",
    `ATTACH '${tableBucketArn}' AS lab_tables (TYPE iceberg, ENDPOINT_TYPE s3_tables);`,
    `${rowCountSql(target, "lab_tables.")};`,
  ].join(" ");

/**
 * Best-effort local read of the Iceberg table with the DuckDB CLI (iceberg extension, s3_tables
 * endpoint). Available only when a duckdb binary is on PATH.
 */
export function duckdbReader(clients: LabClients, target: TableTarget): TableReader {
  return {
    kind: "duckdb",
    async isAvailable() {
      try {
        await run(DUCKDB_BINARY, ["--version"]);
        return (await findTableBucketArn(clients)) !== undefined;
      } catch {
        return false;
      }
    },
    async sample() {
      const arn = await findTableBucketArn(clients);
      if (!arn) return { reader: "duckdb", detail: "AWS-managed table bucket not found" };
      try {
        const { stdout } = await run(DUCKDB_BINARY, ["-csv", "-noheader", "-c", duckdbScript(arn, target)], {
          timeout: DUCKDB_TIMEOUT_MS,
        });
        return { reader: "duckdb", rowCount: Number(stdout.trim().split(/\r?\n/).pop() ?? 0) };
      } catch (error) {
        return { reader: "duckdb", detail: (error as Error).message.slice(0, 400) };
      }
    },
  };
}

/**
 * Fallback that proves the table exists but cannot count rows: time to table, not time to first row.
 */
export function tableStatusReader(clients: LabClients, target: TableTarget): TableReader {
  return {
    kind: "table-status",
    async isAvailable() {
      return true;
    },
    async sample() {
      const tableBucketARN = await findTableBucketArn(clients);
      if (!tableBucketARN) return { reader: "table-status", tableExists: false, detail: "table bucket not found yet" };
      try {
        const table = await clients.s3tables.send(
          new GetTableCommand({ tableBucketARN, namespace: target.namespace, name: METADATA_TABLES.annotationTableName }),
        );
        return { reader: "table-status", tableExists: true, detail: `metadataLocation present: ${Boolean(table.metadataLocation)}` };
      } catch (error) {
        if (isNotFoundError(error)) return { reader: "table-status", tableExists: false };
        throw error;
      }
    },
  };
}

export async function chooseReader(readers: readonly TableReader[]): Promise<TableReader> {
  for (const reader of readers) {
    if (await reader.isAvailable()) return reader;
  }
  throw new Error("No table reader available");
}

export const defaultReaders = (clients: LabClients, target: TableTarget): TableReader[] => [
  athenaReader(clients, target),
  duckdbReader(clients, target),
  tableStatusReader(clients, target),
];
