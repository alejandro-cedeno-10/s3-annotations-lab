import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { build } from "esbuild";
import { zipSync } from "fflate";
import { LAMBDA_SETTINGS, LAMBDA_ZIP_PATH } from "../src/config/lab-config";

const ENTRY_POINT = "src/enrichment/lambda-entry.ts";
const ANNOTATION_API_MARKER = "PutObjectAnnotation";
const S3_SDK_PACKAGE_JSON = "node_modules/@aws-sdk/client-s3/package.json";

async function bundleHandler(): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY_POINT],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    minify: true,
    write: false,
    outfile: LAMBDA_SETTINGS.bundleFileName,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("esbuild produced no output");
  return output.text;
}

function assertBundlesAnnotationApi(code: string): void {
  if (!code.includes(ANNOTATION_API_MARKER)) {
    throw new Error("Bundle lacks the annotation API: the bundled @aws-sdk/client-s3 is too old");
  }
}

function sdkVersion(): string {
  return (JSON.parse(readFileSync(S3_SDK_PACKAGE_JSON, "utf-8")) as { version: string }).version;
}

function writeZip(code: string): number {
  const zip = zipSync({ [LAMBDA_SETTINGS.bundleFileName]: new TextEncoder().encode(code) }, { level: 9 });
  mkdirSync(dirname(LAMBDA_ZIP_PATH), { recursive: true });
  writeFileSync(LAMBDA_ZIP_PATH, zip);
  return zip.length;
}

async function main(): Promise<void> {
  const code = await bundleHandler();
  assertBundlesAnnotationApi(code);
  const bytes = writeZip(code);
  console.log(`Built ${LAMBDA_ZIP_PATH} (${bytes} bytes) bundling @aws-sdk/client-s3 ${sdkVersion()}`);
}

await main();
