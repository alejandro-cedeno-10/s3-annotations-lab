import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { NAME_PREFIX } from "../config/lab-config";

export const RESOURCE_TYPES = [
  "s3-bucket",
  "iam-role",
  "iam-role-policy",
  "lambda-function",
  "log-group",
  "events-rule",
  "bucket-metadata-config",
  "s3tables-table-bucket",
  "s3tables-namespace",
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const manifestEntrySchema = z.object({
  type: z.enum(RESOURCE_TYPES),
  id: z.string().min(1),
  details: z.record(z.string(), z.string()).default({}),
  recordedAt: z.iso.datetime(),
});

const AWS_MANAGED_TYPES: readonly ResourceType[] = ["s3tables-table-bucket"];

export const ownsEntry = (runId: string, entry: { type: ResourceType; id: string }): boolean =>
  AWS_MANAGED_TYPES.includes(entry.type) || entry.id.includes(`${NAME_PREFIX}-${runId}`);

export const manifestSchema = z
  .object({
    runId: z.string().min(1),
    region: z.string().min(1),
    accountId: z.string().regex(/^\d{12}$/),
    createdAt: z.iso.datetime(),
    entries: z.array(manifestEntrySchema),
  })
  .superRefine((data, context) => {
    data.entries.forEach((entry, index) => {
      if (!ownsEntry(data.runId, entry)) {
        context.addIssue({ code: "custom", path: ["entries", index, "id"], message: `Entry id does not belong to run ${data.runId}` });
      }
    });
  });

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type ManifestData = z.infer<typeof manifestSchema>;

export interface NewEntry {
  type: ResourceType;
  id: string;
  details?: Record<string, string>;
}

/**
 * Append-only record of everything the lab creates. Each entry is flushed to disk before the
 * matching AWS call, so a crash mid-deploy still leaves a manifest that teardown can follow.
 */
export class Manifest {
  private constructor(
    private readonly path: string,
    private readonly data: ManifestData,
  ) {}

  static create(path: string, runId: string, region: string, accountId: string, now: Date = new Date()): Manifest {
    if (existsSync(path)) {
      throw new Error(`Manifest already exists at ${path}. Run teardown and verify-clean --archive first.`);
    }
    const manifest = new Manifest(path, { runId, region, accountId, createdAt: now.toISOString(), entries: [] });
    manifest.flush();
    return manifest;
  }

  static load(path: string): Manifest {
    if (!existsSync(path)) {
      throw new Error(`No manifest at ${path}. Nothing to operate on.`);
    }
    return new Manifest(path, manifestSchema.parse(JSON.parse(readFileSync(path, "utf-8"))));
  }

  get runId(): string {
    return this.data.runId;
  }

  get region(): string {
    return this.data.region;
  }

  get accountId(): string {
    return this.data.accountId;
  }

  get entries(): readonly ManifestEntry[] {
    return this.data.entries;
  }

  find(type: ResourceType): ManifestEntry | undefined {
    return this.data.entries.find((entry) => entry.type === type);
  }

  record(entry: NewEntry, now: Date = new Date()): void {
    if (!ownsEntry(this.data.runId, entry)) {
      throw new Error(`Refusing to record ${entry.type} "${entry.id}": it does not belong to run ${this.data.runId}`);
    }
    this.data.entries.push({ ...entry, details: entry.details ?? {}, recordedAt: now.toISOString() });
    this.flush();
  }

  archive(now: Date = new Date()): string {
    const archived = this.path.replace(/\.json$/, `.${now.toISOString().replace(/[:.]/g, "-")}.archived.json`);
    renameSync(this.path, archived);
    return archived;
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf-8");
    renameSync(temporary, this.path);
  }
}
