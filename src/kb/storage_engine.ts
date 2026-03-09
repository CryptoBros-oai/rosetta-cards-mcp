/**
 * Storage Policy Engine — plan, apply, restore.
 *
 * Safety invariants:
 *  - identity and meta tiers are NEVER pruned or archived.
 *  - Derived PNGs are pruned (deleted) not archived; they are always re-renderable.
 *  - Cold archival moves files out of the vault; a manifest tracks each entry.
 *  - storageRestore copies back (does not move), keeping cold copy intact.
 *  - storageApply executes: derived prune → doc/blob/text archive → vacuum → bundle prune.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import { storageReport } from "./derived.js";
import { renderCardPngToDerived } from "./derived.js";
import { rebuildIndex } from "./index.js";
import {
  loadStoragePolicy,
  appendColdManifestEntry,
  loadColdManifest,
  DEFAULT_POLICY,
  type StoragePolicy,
  type StorageBackend,
  type S3Backend,
} from "./storage_policy.js";
import type {
  PlanAction,
  StoragePlan,
  ApplyRecord,
  StorageApplyResult,
  StorageRestoreResult,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function vaultRoot(): string {
  return process.env.VAULT_ROOT ?? process.cwd();
}

function relToVault(absPath: string): string {
  return path.relative(vaultRoot(), absPath);
}

// ---------------------------------------------------------------------------
// File walker (recursive, returns [absPath, stat] pairs)
// ---------------------------------------------------------------------------

type FileStat = { absPath: string; bytes: number; mtime: Date; relPath: string };

async function walkFiles(dir: string, filterFn?: (name: string) => boolean): Promise<FileStat[]> {
  const results: FileStat[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...await walkFiles(full, filterFn));
    } else if (!filterFn || filterFn(e.name)) {
      try {
        const stat = await fs.stat(full);
        results.push({ absPath: full, bytes: stat.size, mtime: stat.mtime, relPath: relToVault(full) });
      } catch {
        // skip unreadable
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tier directory helpers
// ---------------------------------------------------------------------------

function tierDirs(tier: string): string[] {
  const root = vaultRoot();
  switch (tier) {
    case "derived":
      return [
        path.join(root, "derived", "cards"),
        path.join(root, "derived", "summaries"),
      ];
    case "docs":   return [path.join(root, "data", "docs")];
    case "blobs":  return [path.join(root, "data", "blobs")];
    case "text":   return [path.join(root, "data", "text")];
    case "bundles":return [path.join(root, "data", "bundles")];
    case "embeddings": return [path.join(root, "data", "index")];
    // Protected — never returned as actionable dirs
    case "identity":
    case "meta":
    default:       return [];
  }
}

// Identity files: card/event/summary/pack/pinset JSON (NOT *.meta.json)
function isIdentityFile(name: string): boolean {
  return name.endsWith(".json") && !name.endsWith(".meta.json");
}

// ---------------------------------------------------------------------------
// LRU prune computation for local-cache tiers (derived, bundles)
// ---------------------------------------------------------------------------

function computeLruPrune(
  files: FileStat[],
  maxGb: number,
  targetPct: number,
  tier: string,
): PlanAction[] {
  const maxBytes = maxGb * 1024 * 1024 * 1024;
  const targetBytes = maxBytes * (targetPct / 100);
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);

  if (totalBytes <= maxBytes) return [];

  // Sort oldest mtime first (least recently modified = LRU proxy)
  const sorted = [...files].sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  const actions: PlanAction[] = [];
  let remaining = totalBytes;

  for (const f of sorted) {
    if (remaining <= targetBytes) break;
    actions.push({
      action: "prune",
      tier,
      path: f.absPath,
      reason: `${tier} over budget (${(totalBytes / 1e9).toFixed(3)} GB > ${maxGb} GB limit); LRU prune`,
      bytes: f.bytes,
      reversible: true,
      last_modified_at: f.mtime.toISOString(),
    });
    remaining -= f.bytes;
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Cold-after-days computation for warm tiers
// ---------------------------------------------------------------------------

function computeColdArchive(
  files: FileStat[],
  coldAfterDays: number,
  tier: string,
  backend: StorageBackend,
): PlanAction[] {
  const now = Date.now();
  const cutoffMs = coldAfterDays * 24 * 60 * 60 * 1000;
  return files
    .filter(f => (now - f.mtime.getTime()) >= cutoffMs)
    .map(f => ({
      action: "archive" as const,
      tier,
      path: f.absPath,
      reason: `${tier} file older than ${coldAfterDays} days (mtime ${f.mtime.toISOString()}); archive to ${backend.kind}`,
      bytes: f.bytes,
      reversible: true,
      last_modified_at: f.mtime.toISOString(),
    }));
}

// ---------------------------------------------------------------------------
// storagePlan — dry run, no writes
// ---------------------------------------------------------------------------

export async function storagePlan(overridePolicy?: StoragePolicy): Promise<StoragePlan> {
  const { policy, source } = overridePolicy
    ? { policy: overridePolicy, source: "file" as const }
    : await loadStoragePolicy();

  const actions: PlanAction[] = [];

  // --- derived: LRU prune ---
  const derivedPolicy = policy.tiers.derived;
  if (derivedPolicy.prune === "lru") {
    const derivedFiles = (await Promise.all(
      tierDirs("derived").map(d => walkFiles(d, n => n.endsWith(".png") || n.endsWith(".render.json")))
    )).flat();
    actions.push(...computeLruPrune(
      derivedFiles,
      derivedPolicy.max_gb,
      derivedPolicy.prune_target_pct ?? 80,
      "derived",
    ));
  }

  // --- docs, blobs, text: cold archive ---
  for (const tier of ["docs", "blobs", "text"] as const) {
    const tierPolicy = policy.tiers[tier];
    // Skip if cold_dir is empty (archival disabled in defaults)
    if (tierPolicy.backend.kind === "local" && !(tierPolicy.backend as import("./storage_policy.js").LocalBackend).cold_dir) {
      continue;
    }
    const filterFn = tier === "text" ? (n: string) => n.endsWith(".txt") : undefined;
    const files = (await Promise.all(
      tierDirs(tier).map(d => walkFiles(d, filterFn))
    )).flat();
    actions.push(...computeColdArchive(
      files,
      tierPolicy.cold_after_days,
      tier,
      tierPolicy.backend,
    ));
  }

  // --- bundles: LRU prune ---
  const bundlesPolicy = policy.tiers.bundles;
  if (bundlesPolicy.prune === "lru") {
    const bundleFiles = (await Promise.all(
      tierDirs("bundles").map(d => walkFiles(d))
    )).flat();
    actions.push(...computeLruPrune(
      bundleFiles,
      bundlesPolicy.max_gb,
      bundlesPolicy.prune_target_pct ?? 80,
      "bundles",
    ));
  }

  // --- embeddings: vacuum ---
  if (policy.tiers.embeddings.vacuum_on_apply) {
    actions.push({
      action: "vacuum",
      tier: "embeddings",
      path: path.join(vaultRoot(), "data", "index"),
      reason: "vacuum_on_apply: true in policy",
      bytes: 0,
      reversible: false,
    });
  }

  // --- protected tiers (skip entries, informational) ---
  for (const tier of ["identity", "meta"] as const) {
    actions.push({
      action: "skip",
      tier,
      path: "",
      reason: "protected tier — never pruned or archived",
      bytes: 0,
      reversible: false,
    });
  }

  const pruneActions = actions.filter(a => a.action === "prune");
  const archiveActions = actions.filter(a => a.action === "archive");

  return {
    schema_version: "storage_plan.v1",
    generated_at: new Date().toISOString(),
    policy_source: source,
    actions,
    summary: {
      prune_count: pruneActions.length,
      archive_count: archiveActions.length,
      estimated_freed_bytes: pruneActions.reduce((s, a) => s + a.bytes, 0),
      estimated_cold_bytes: archiveActions.reduce((s, a) => s + a.bytes, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

function s3Client(backend: S3Backend): S3Client {
  return new S3Client({ region: backend.region });
}

function s3Key(backend: S3Backend, tier: string, relPath: string): string {
  return [backend.prefix, tier, relPath].filter(Boolean).join("/");
}

async function uploadToS3(backend: S3Backend, tier: string, srcPath: string, relPath: string): Promise<void> {
  const client = s3Client(backend);
  const key = s3Key(backend, tier, relPath);
  const data = await fs.readFile(srcPath);
  const upload = new Upload({
    client,
    params: { Bucket: backend.bucket, Key: key, Body: data },
  });
  await upload.done();
}

async function downloadFromS3(backend: S3Backend, tier: string, relPath: string, destPath: string): Promise<void> {
  const client = s3Client(backend);
  const key = s3Key(backend, tier, relPath);
  const { Body } = await client.send(new GetObjectCommand({ Bucket: backend.bucket, Key: key }));
  if (!Body) throw new Error(`S3 object not found: s3://${backend.bucket}/${key}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Body as Readable, createWriteStream(destPath));
}

// ---------------------------------------------------------------------------
// storageApply — execute plan actions
// ---------------------------------------------------------------------------

export async function storageApply(plan: StoragePlan): Promise<StorageApplyResult> {
  const { policy } = await loadStoragePolicy();
  const executed: ApplyRecord[] = [];
  const errors: string[] = [];
  let freedBytes = 0;
  let coldBytes = 0;

  // Helper to record and execute
  async function execute(action: PlanAction): Promise<void> {
    try {
      if (action.action === "prune") {
        await fs.unlink(action.path);
        executed.push({ action: "pruned", tier: action.tier, path: action.path, bytes: action.bytes, reason: action.reason });
        freedBytes += action.bytes;

      } else if (action.action === "archive") {
        const tierPolicy = policy.tiers[action.tier as "docs" | "blobs" | "text"];
        const backend = tierPolicy.backend;
        const relPath = relToVault(action.path);
        const coldRelPath = path.join(action.tier, path.basename(relPath));

        if (backend.kind === "local") {
          const dest = path.join(backend.cold_dir, coldRelPath);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(action.path, dest);
          await appendColdManifestEntry(backend, {
            hash: path.basename(action.path, path.extname(action.path)),
            tier: action.tier,
            original_path: relPath,
            cold_path: coldRelPath,
            archived_at: new Date().toISOString(),
            bytes: action.bytes,
            backend: "local",
          });
        } else if (backend.kind === "s3") {
          await uploadToS3(backend, action.tier, action.path, relPath);
          await fs.unlink(action.path); // remove from warm after successful upload
          await appendColdManifestEntry(backend, {
            hash: path.basename(action.path, path.extname(action.path)),
            tier: action.tier,
            original_path: relPath,
            cold_path: s3Key(backend, action.tier, relPath),
            archived_at: new Date().toISOString(),
            bytes: action.bytes,
            backend: "s3",
          });
        }

        executed.push({ action: "archived", tier: action.tier, path: action.path, bytes: action.bytes, reason: action.reason });
        coldBytes += action.bytes;

      } else if (action.action === "vacuum") {
        await rebuildIndex();
        executed.push({ action: "vacuumed", tier: action.tier, path: action.path, bytes: 0, reason: action.reason });

      } else if (action.action === "skip") {
        executed.push({ action: "skipped", tier: action.tier, path: action.path, bytes: 0, reason: action.reason });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${action.action} ${action.path}: ${msg}`);
      executed.push({ action: "failed", tier: action.tier, path: action.path, bytes: 0, reason: msg });
    }
  }

  // Execution order: prune derived → archive warm tiers → vacuum → prune bundles → skip protected
  const ordered: PlanAction[] = [
    ...plan.actions.filter(a => a.action === "prune" && a.tier === "derived"),
    ...plan.actions.filter(a => a.action === "archive"),
    ...plan.actions.filter(a => a.action === "vacuum"),
    ...plan.actions.filter(a => a.action === "prune" && a.tier === "bundles"),
    ...plan.actions.filter(a => a.action === "skip"),
  ];

  for (const action of ordered) {
    await execute(action);
  }

  return {
    schema_version: "storage_apply.v1",
    applied_at: new Date().toISOString(),
    actions_executed: executed,
    freed_bytes: freedBytes,
    cold_bytes: coldBytes,
    errors,
  };
}

// ---------------------------------------------------------------------------
// storageRestore — bring cold artifacts back
// ---------------------------------------------------------------------------

export async function storageRestore(args: {
  tier: string;
  hashes?: string[];
  all?: boolean;
}): Promise<StorageRestoreResult> {
  const { policy } = await loadStoragePolicy();
  const restored: StorageRestoreResult["restored"] = [];
  const reRendered: StorageRestoreResult["re_rendered"] = [];
  const errors: string[] = [];

  // For derived tier: re-render from identity (no cold archive for pruned PNGs)
  if (args.tier === "derived") {
    const hashes = args.hashes ?? [];
    const shouldRestoreAll = args.all === true;

    if (!shouldRestoreAll && hashes.length === 0) {
      errors.push("derived restore requires hashes[] or all:true");
      return { restored, re_rendered: reRendered, errors };
    }

    let targetHashes = hashes;
    if (shouldRestoreAll) {
      // Find all card identity JSONs and collect their hashes
      const cardsDir = path.join(vaultRoot(), "data", "cards");
      const files = await walkFiles(cardsDir, n => isIdentityFile(n));
      targetHashes = files.map(f => path.basename(f.absPath, ".json").replace(/^card_[a-z_]*/, "")).filter(Boolean);
    }

    for (const hash of targetHashes) {
      try {
        const result = await renderCardPngToDerived(hash);
        reRendered.push({ hash, png_path: result.png_path });
      } catch (err: unknown) {
        errors.push(`re-render ${hash}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { restored, re_rendered: reRendered, errors };
  }

  // For warm tiers: restore from cold manifest
  const tierKey = args.tier as "docs" | "blobs" | "text";
  const tierPolicy = policy.tiers[tierKey];
  if (!tierPolicy) {
    errors.push(`unknown tier: ${args.tier}`);
    return { restored, re_rendered: reRendered, errors };
  }

  const backend = (tierPolicy as { backend: StorageBackend }).backend;
  const manifest = await loadColdManifest(backend);

  let entries = manifest.entries.filter(e => e.tier === args.tier);
  if (args.hashes && args.hashes.length > 0) {
    entries = entries.filter(e => args.hashes!.includes(e.hash));
  }
  if (!args.all && (!args.hashes || args.hashes.length === 0)) {
    errors.push(`restore for tier "${args.tier}" requires hashes[] or all:true`);
    return { restored, re_rendered: reRendered, errors };
  }

  for (const entry of entries) {
    const destPath = path.join(vaultRoot(), entry.original_path);
    try {
      await fs.mkdir(path.dirname(destPath), { recursive: true });

      if (entry.backend === "local" && backend.kind === "local") {
        const srcPath = path.join(backend.cold_dir, entry.cold_path);
        await fs.copyFile(srcPath, destPath); // copy (keep cold copy intact)
      } else if (entry.backend === "s3" && backend.kind === "s3") {
        await downloadFromS3(backend, entry.tier, entry.original_path, destPath);
      } else {
        errors.push(`backend mismatch for ${entry.original_path}: manifest says ${entry.backend}, policy says ${backend.kind}`);
        continue;
      }

      const stat = await fs.stat(destPath);
      restored.push({ path: destPath, tier: entry.tier, bytes: stat.size });
    } catch (err: unknown) {
      errors.push(`restore ${entry.original_path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { restored, re_rendered: reRendered, errors };
}
