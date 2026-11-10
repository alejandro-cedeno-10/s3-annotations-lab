import { execFile } from "node:child_process";
import { REGION } from "../config/lab-config";

export const COPY_PROPS_VALUES = ["default", "all", "none"] as const;

export type CopyProps = (typeof COPY_PROPS_VALUES)[number];

export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CopyCommand {
  bucket: string;
  sourceKey: string;
  targetKey: string;
  copyProps: CopyProps;
}

export function copyCommandArgs(command: CopyCommand): string[] {
  return [
    "s3",
    "cp",
    `s3://${command.bucket}/${command.sourceKey}`,
    `s3://${command.bucket}/${command.targetKey}`,
    "--copy-props",
    command.copyProps,
    "--region",
    REGION,
  ];
}

/**
 * Runs the AWS CLI with the lab profile and reports exit code and output instead of throwing:
 * a rejected flag value is itself an experiment result.
 */
export function runAwsCli(args: readonly string[], profile: string): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile("aws", [...args], { env: { ...process.env, AWS_PROFILE: profile }, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ exitCode: error ? (typeof code === "number" ? code : 1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
