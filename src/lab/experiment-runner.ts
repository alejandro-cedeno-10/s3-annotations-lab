import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnnotationStore } from "../annotations/annotation-store";
import { describeError, type ErrorInfo } from "../aws/error-info";
import { labNames, MANIFEST_PATH, REGION, RESULTS_DIR, type LabNames } from "../config/lab-config";
import { createLabClients, type LabClients } from "./aws-clients";
import { Manifest } from "./manifest";

export interface ExperimentContext {
  runId: string;
  names: LabNames;
  clients: LabClients;
  store: AnnotationStore;
  args: Record<string, string>;
}

export interface ExperimentReport {
  inputs: Record<string, unknown>;
  observations: unknown[];
  conclusions: string[];
}

export interface ExperimentDefinition {
  id: string;
  title: string;
  run(context: ExperimentContext): Promise<ExperimentReport>;
}

export interface ExperimentResult extends Partial<ExperimentReport> {
  experiment: string;
  title: string;
  runId: string;
  region: string;
  startedAt: string;
  finishedAt: string;
  error?: ErrorInfo;
}

export function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const token of argv) {
    const match = /^--([\w-]+)=(.*)$/.exec(token);
    if (match?.[1] !== undefined) args[match[1]] = match[2] ?? "";
  }
  return args;
}

export const numberArg = (args: Record<string, string>, name: string, fallback: number): number => {
  const parsed = Number(args[name]);
  return args[name] !== undefined && Number.isFinite(parsed) ? parsed : fallback;
};

export function writeResult(result: ExperimentResult, directory: string = RESULTS_DIR): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${result.experiment}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  return path;
}

export function formatSummary(result: ExperimentResult): string {
  const lines = [`=== ${result.experiment}: ${result.title} ===`];
  for (const conclusion of result.conclusions ?? []) lines.push(`- ${conclusion}`);
  if (result.error) lines.push(`ERROR ${result.error.name}: ${result.error.message}`);
  return lines.join("\n");
}

function openContext(args: Record<string, string>): ExperimentContext {
  const manifest = Manifest.load(MANIFEST_PATH);
  const clients = createLabClients();
  const names = labNames(manifest.runId);
  return {
    runId: manifest.runId,
    names,
    clients,
    store: new AnnotationStore(clients.s3, names.bucket),
    args,
  };
}

/**
 * Entry point shared by every experiment script: opens the deployed lab from the manifest, runs
 * the experiment, stores the JSON result and prints a summary. Failures are stored too, so a
 * half-finished run still leaves evidence.
 */
export async function runExperiment(definition: ExperimentDefinition, argv: readonly string[]): Promise<void> {
  const context = openContext(parseArgs(argv));
  const startedAt = new Date().toISOString();
  const base = { experiment: context.args["tag"] ? `${definition.id}-${context.args["tag"]}` : definition.id, title: definition.title, runId: context.runId, region: REGION, startedAt };
  try {
    const report = await definition.run(context);
    const result: ExperimentResult = { ...base, ...report, finishedAt: new Date().toISOString() };
    const path = writeResult(result);
    console.log(formatSummary(result));
    console.log(`Result written to ${path}`);
  } catch (error) {
    const result: ExperimentResult = { ...base, finishedAt: new Date().toISOString(), error: describeError(error) };
    writeResult(result);
    console.error(formatSummary(result));
    process.exitCode = 1;
  }
}
