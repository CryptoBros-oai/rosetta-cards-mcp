/**
 * Storage Policy Engine — policy schema, defaults, and load/save.
 *
 * The policy file lives at <vault_root>/data/storage_policy.json.
 * It is NOT a hashed identity artifact; it is plain configuration.
 * If absent, DEFAULT_POLICY is used everywhere.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Backend schemas
// ---------------------------------------------------------------------------

export const LocalBackendSchema = z.object({
  kind: z.literal("local"),
  cold_dir: z.string(),
}).strict();

export const S3BackendSchema = z.object({
  kind: z.literal("s3"),
  bucket: z.string(),
  prefix: z.string(),
  region: z.string(),
  /** Optional: path to local manifest file tracking archived entries. Defaults to cold_manifest.json in process.cwd(). */
  manifest_path: z.string().optional(),
}).strict();

export const StorageBackendSchema = z.discriminatedUnion("kind", [
  LocalBackendSchema,
  S3BackendSchema,
]);

export type StorageBackend = z.infer<typeof StorageBackendSchema>;
export type LocalBackend = z.infer<typeof LocalBackendSchema>;
export type S3Backend = z.infer<typeof S3BackendSchema>;

// ---------------------------------------------------------------------------
// Tier schemas
// ---------------------------------------------------------------------------

const IdentityTierSchema = z.object({
  mode: z.literal("always_local"),
}).strict();

const MetaTierSchema = z.object({
  mode: z.literal("always_local"),
}).strict();

const DerivedTierSchema = z.object({
  mode: z.literal("local_cache"),
  max_gb: z.number().positive(),
  prune: z.enum(["lru", "none"]),
  /** Target % of max_gb to reach after pruning (0–100). Default 80. */
  prune_target_pct: z.number().min(0).max(100).optional(),
}).strict();

const WarmTierSchema = z.object({
  mode: z.literal("local_warm"),
  cold_after_days: z.number().int().positive(),
  backend: StorageBackendSchema,
}).strict();

const BundlesTierSchema = z.object({
  mode: z.literal("local_cache"),
  max_gb: z.number().positive(),
  prune: z.enum(["lru", "none"]),
  prune_target_pct: z.number().min(0).max(100).optional(),
}).strict();

const EmbeddingsTierSchema = z.object({
  mode: z.literal("local_warm"),
  max_gb: z.number().positive().optional(),
  vacuum_on_apply: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// Full policy schema
// ---------------------------------------------------------------------------

export const StoragePolicySchema = z.object({
  schema_version: z.literal("storage_policy.v1"),
  budgets: z.object({
    total_max_gb: z.number().positive(),
    warn_at_pct: z.number().min(0).max(100),
  }).strict(),
  tiers: z.object({
    identity: IdentityTierSchema,
    meta: MetaTierSchema,
    derived: DerivedTierSchema,
    docs: WarmTierSchema,
    blobs: WarmTierSchema,
    text: WarmTierSchema,
    bundles: BundlesTierSchema,
    embeddings: EmbeddingsTierSchema,
  }).strict(),
}).strict();

export type StoragePolicy = z.infer<typeof StoragePolicySchema>;

// ---------------------------------------------------------------------------
// Cold manifest schema (tracks what has been archived)
// ---------------------------------------------------------------------------

export const ColdManifestEntrySchema = z.object({
  hash: z.string(),
  tier: z.string(),
  /** Path relative to vault root, e.g. "data/docs/doc_xxx.json" */
  original_path: z.string(),
  /** Path relative to cold_dir (local) or S3 key suffix (s3), e.g. "docs/doc_xxx.json" */
  cold_path: z.string(),
  archived_at: z.string(),
  bytes: z.number().int().nonnegative(),
  backend: z.enum(["local", "s3"]),
}).strict();

export const ColdManifestSchema = z.object({
  schema_version: z.literal("cold_manifest.v1"),
  updated_at: z.string(),
  entries: z.array(ColdManifestEntrySchema),
}).strict();

export type ColdManifestEntry = z.infer<typeof ColdManifestEntrySchema>;
export type ColdManifest = z.infer<typeof ColdManifestSchema>;

// ---------------------------------------------------------------------------
// Default policy (used when no policy file is present)
// ---------------------------------------------------------------------------

export const DEFAULT_POLICY: StoragePolicy = {
  schema_version: "storage_policy.v1",
  budgets: {
    total_max_gb: 50,
    warn_at_pct: 80,
  },
  tiers: {
    identity: { mode: "always_local" },
    meta: { mode: "always_local" },
    derived: {
      mode: "local_cache",
      max_gb: 10,
      prune: "lru",
      prune_target_pct: 80,
    },
    docs: {
      mode: "local_warm",
      cold_after_days: 90,
      backend: { kind: "local", cold_dir: "" }, // empty = cold archival disabled
    },
    blobs: {
      mode: "local_warm",
      cold_after_days: 30,
      backend: { kind: "local", cold_dir: "" },
    },
    text: {
      mode: "local_warm",
      cold_after_days: 90,
      backend: { kind: "local", cold_dir: "" },
    },
    bundles: {
      mode: "local_cache",
      max_gb: 2,
      prune: "lru",
      prune_target_pct: 80,
    },
    embeddings: {
      mode: "local_warm",
      vacuum_on_apply: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function vaultRoot(): string {
  return process.env.VAULT_ROOT ?? process.cwd();
}

function policyPath(): string {
  return path.join(vaultRoot(), "data", "storage_policy.json");
}

/**
 * Load storage policy from disk. Returns DEFAULT_POLICY if the file is absent.
 * Throws ZodError if the file exists but fails validation.
 */
export async function loadStoragePolicy(): Promise<{ policy: StoragePolicy; source: "file" | "default" }> {
  try {
    const raw = await fs.readFile(policyPath(), "utf-8");
    const policy = StoragePolicySchema.parse(JSON.parse(raw));
    return { policy, source: "file" };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { policy: DEFAULT_POLICY, source: "default" };
    }
    throw err;
  }
}

/**
 * Save a storage policy to disk.
 */
export async function saveStoragePolicy(policy: StoragePolicy): Promise<void> {
  await fs.mkdir(path.dirname(policyPath()), { recursive: true });
  await fs.writeFile(policyPath(), JSON.stringify(policy, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Cold manifest load / save (local only; S3 manifest is tracked locally too)
// ---------------------------------------------------------------------------

function coldManifestPath(backend: StorageBackend): string {
  if (backend.kind === "local") {
    return path.join(backend.cold_dir, "manifest.json");
  }
  // For S3, we keep a local manifest alongside the vault
  const manifestPath = (backend as S3Backend).manifest_path;
  return manifestPath ?? path.join(vaultRoot(), "data", `cold_manifest_s3_${backend.bucket}.json`);
}

export async function loadColdManifest(backend: StorageBackend): Promise<ColdManifest> {
  const p = coldManifestPath(backend);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return ColdManifestSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: "cold_manifest.v1", updated_at: new Date().toISOString(), entries: [] };
    }
    throw err;
  }
}

export async function saveColdManifest(backend: StorageBackend, manifest: ColdManifest): Promise<void> {
  const p = coldManifestPath(backend);
  await fs.mkdir(path.dirname(p), { recursive: true });
  manifest.updated_at = new Date().toISOString();
  await fs.writeFile(p, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * Append an entry to the cold manifest (deduplicates by original_path).
 */
export async function appendColdManifestEntry(
  backend: StorageBackend,
  entry: ColdManifestEntry,
): Promise<void> {
  const manifest = await loadColdManifest(backend);
  // Deduplicate: remove existing entry for same path before appending
  manifest.entries = manifest.entries.filter(e => e.original_path !== entry.original_path);
  manifest.entries.push(entry);
  await saveColdManifest(backend, manifest);
}
