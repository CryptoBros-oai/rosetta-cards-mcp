/**
 * Storage Policy Engine tests.
 *
 * Uses temp vaults (VAULT_ROOT=/tmp/...) for full isolation.
 * S3 backend is not integration-tested here; local backend is used throughout.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  StoragePolicySchema,
  DEFAULT_POLICY,
  loadStoragePolicy,
  saveStoragePolicy,
  loadColdManifest,
  appendColdManifestEntry,
} from "../src/kb/storage_policy.js";
import { storagePlan, storageApply, storageRestore } from "../src/kb/storage_engine.js";
import { StorageRestoreInputSchema, StoragePlanInputSchema, StorageApplyInputSchema } from "../src/kb/schema.js";
import type { StoragePolicy } from "../src/kb/storage_policy.js";

// ---------------------------------------------------------------------------
// Temp vault helpers
// ---------------------------------------------------------------------------

async function makeTempVault(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rosetta-storage-test-"));
  for (const sub of [
    "data/cards", "data/docs", "data/blobs", "data/text",
    "data/events", "data/index", "data/bundles", "data/packs",
    "data/pinsets", "data/summaries",
    "derived/cards", "derived/summaries",
  ]) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

async function withVault<T>(fn: (vaultRoot: string) => Promise<T>): Promise<T> {
  const dir = await makeTempVault();
  const prevRoot = process.env.VAULT_ROOT;
  process.env.VAULT_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    process.env.VAULT_ROOT = prevRoot ?? "";
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeFile(p: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (typeof content === "string") {
    await fs.writeFile(p, content, "utf-8");
  } else {
    await fs.writeFile(p, content);
  }
}

// ---------------------------------------------------------------------------
// StoragePolicySchema validation
// ---------------------------------------------------------------------------

describe("StoragePolicySchema — strict validation", () => {
  it("accepts a valid full policy", () => {
    const valid = StoragePolicySchema.parse({
      schema_version: "storage_policy.v1",
      budgets: { total_max_gb: 50, warn_at_pct: 80 },
      tiers: {
        identity: { mode: "always_local" },
        meta: { mode: "always_local" },
        derived: { mode: "local_cache", max_gb: 10, prune: "lru", prune_target_pct: 80 },
        docs:  { mode: "local_warm", cold_after_days: 90, backend: { kind: "local", cold_dir: "/tmp/cold" } },
        blobs: { mode: "local_warm", cold_after_days: 30, backend: { kind: "local", cold_dir: "/tmp/cold" } },
        text:  { mode: "local_warm", cold_after_days: 90, backend: { kind: "local", cold_dir: "/tmp/cold" } },
        bundles: { mode: "local_cache", max_gb: 2, prune: "lru" },
        embeddings: { mode: "local_warm", vacuum_on_apply: true },
      },
    });
    assert.equal(valid.schema_version, "storage_policy.v1");
  });

  it("rejects unknown keys at root", () => {
    assert.throws(
      () => StoragePolicySchema.parse({ ...DEFAULT_POLICY, extra: "bad" }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown keys in tiers", () => {
    const bad = {
      ...DEFAULT_POLICY,
      tiers: { ...DEFAULT_POLICY.tiers, identity: { mode: "always_local", extra: "bad" } },
    };
    assert.throws(() => StoragePolicySchema.parse(bad), /unrecognized_keys/);
  });

  it("rejects s3 backend with missing bucket", () => {
    assert.throws(
      () => StoragePolicySchema.parse({
        ...DEFAULT_POLICY,
        tiers: {
          ...DEFAULT_POLICY.tiers,
          docs: {
            mode: "local_warm",
            cold_after_days: 90,
            backend: { kind: "s3", prefix: "p", region: "us-east-1" }, // missing bucket
          },
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// loadStoragePolicy
// ---------------------------------------------------------------------------

describe("loadStoragePolicy", () => {
  it("returns DEFAULT_POLICY when no file exists", async () => {
    await withVault(async () => {
      const { policy, source } = await loadStoragePolicy();
      assert.equal(source, "default");
      assert.equal(policy.schema_version, "storage_policy.v1");
    });
  });

  it("parses policy from file when present", async () => {
    await withVault(async (root) => {
      await saveStoragePolicy(DEFAULT_POLICY);
      const { policy, source } = await loadStoragePolicy();
      assert.equal(source, "file");
      assert.equal(policy.tiers.identity.mode, "always_local");
    });
  });

  it("throws ZodError if policy file is invalid", async () => {
    await withVault(async (root) => {
      await writeFile(
        path.join(root, "data", "storage_policy.json"),
        JSON.stringify({ schema_version: "storage_policy.v1", bad_field: true }),
      );
      await assert.rejects(() => loadStoragePolicy(), /ZodError|unrecognized/i);
    });
  });
});

// ---------------------------------------------------------------------------
// storagePlan — empty vault
// ---------------------------------------------------------------------------

describe("storagePlan — empty vault", () => {
  it("produces no prune/archive actions for empty vault", async () => {
    await withVault(async () => {
      const policy: StoragePolicy = {
        ...DEFAULT_POLICY,
        tiers: {
          ...DEFAULT_POLICY.tiers,
          derived: { mode: "local_cache", max_gb: 10, prune: "lru", prune_target_pct: 80 },
        },
      };
      const plan = await storagePlan(policy);
      assert.equal(plan.schema_version, "storage_plan.v1");
      assert.equal(plan.summary.prune_count, 0);
      assert.equal(plan.summary.archive_count, 0);
      assert.equal(plan.summary.estimated_freed_bytes, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// storagePlan — derived over budget → LRU prune actions
// ---------------------------------------------------------------------------

describe("storagePlan — derived over budget", () => {
  it("creates prune actions ordered LRU (oldest first) when over budget", async () => {
    await withVault(async (root) => {
      const derivedDir = path.join(root, "derived", "cards");

      // Write 3 PNG files with different mtimes
      const files = ["card_aaa.png", "card_bbb.png", "card_ccc.png"];
      for (let i = 0; i < files.length; i++) {
        const p = path.join(derivedDir, files[i]);
        // ~200 bytes each
        await writeFile(p, "x".repeat(200));
        // Touch with distinct timestamps 1s apart
        const mtime = new Date(Date.now() - (files.length - i) * 1000);
        await fs.utimes(p, mtime, mtime);
      }

      const policy: StoragePolicy = {
        ...DEFAULT_POLICY,
        tiers: {
          ...DEFAULT_POLICY.tiers,
          // max_gb smaller than actual usage → trigger prune
          derived: { mode: "local_cache", max_gb: 0.0000001, prune: "lru", prune_target_pct: 0 },
        },
      };

      const plan = await storagePlan(policy);
      const pruneActions = plan.actions.filter(a => a.action === "prune" && a.tier === "derived");
      assert.ok(pruneActions.length > 0, "expected prune actions");

      // LRU: oldest mtime should be first
      for (let i = 1; i < pruneActions.length; i++) {
        const prev = new Date(pruneActions[i - 1].last_modified_at!).getTime();
        const curr = new Date(pruneActions[i].last_modified_at!).getTime();
        assert.ok(prev <= curr, "prune actions should be sorted oldest-first");
      }

      // All prune actions are reversible (re-renderable)
      assert.ok(pruneActions.every(a => a.reversible === true));
    });
  });
});

// ---------------------------------------------------------------------------
// storagePlan — old docs → cold archive actions
// ---------------------------------------------------------------------------

describe("storagePlan — old docs for cold archive", () => {
  it("marks docs older than cold_after_days as archive actions", async () => {
    await withVault(async (root) => {
      const docsDir = path.join(root, "data", "docs");
      const coldDir = path.join(root, "cold");

      // Write an old doc file (mtime 91 days ago)
      const docPath = path.join(docsDir, "doc_old.json");
      await writeFile(docPath, JSON.stringify({ id: "old" }));
      const oldTime = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
      await fs.utimes(docPath, oldTime, oldTime);

      // Write a fresh doc (mtime now)
      const freshPath = path.join(docsDir, "doc_fresh.json");
      await writeFile(freshPath, JSON.stringify({ id: "fresh" }));

      const policy: StoragePolicy = {
        ...DEFAULT_POLICY,
        tiers: {
          ...DEFAULT_POLICY.tiers,
          docs: { mode: "local_warm", cold_after_days: 90, backend: { kind: "local", cold_dir: coldDir } },
        },
      };

      const plan = await storagePlan(policy);
      const archiveActions = plan.actions.filter(a => a.action === "archive" && a.tier === "docs");
      assert.equal(archiveActions.length, 1, "only the old doc should be marked for archival");
      assert.ok(archiveActions[0].path.endsWith("doc_old.json"));
      assert.ok(archiveActions[0].reversible);
    });
  });
});

// ---------------------------------------------------------------------------
// storagePlan — protected tiers always skip
// ---------------------------------------------------------------------------

describe("storagePlan — protected tiers", () => {
  it("includes skip actions for identity and meta tiers", async () => {
    await withVault(async () => {
      const plan = await storagePlan(DEFAULT_POLICY);
      const skipActions = plan.actions.filter(a => a.action === "skip");
      const tiers = skipActions.map(a => a.tier);
      assert.ok(tiers.includes("identity"), "identity must be skipped");
      assert.ok(tiers.includes("meta"), "meta must be skipped");
    });
  });
});

// ---------------------------------------------------------------------------
// storageApply — prune derived PNGs
// ---------------------------------------------------------------------------

describe("storageApply — prune derived", () => {
  it("deletes derived PNGs and leaves identity JSONs untouched", async () => {
    await withVault(async (root) => {
      const pngPath = path.join(root, "derived", "cards", "card_abc.png");
      const identityPath = path.join(root, "data", "cards", "card_abc.json");
      // Write a file large enough to exceed budget (> 0.0000001 GB ≈ 107 bytes)
      await writeFile(pngPath, "x".repeat(200));
      await writeFile(identityPath, JSON.stringify({ card_id: "card_abc" }));

      // Stamp PNG as very old so it's LRU candidate
      const old = new Date(Date.now() - 1000);
      await fs.utimes(pngPath, old, old);

      const policy: StoragePolicy = {
        ...DEFAULT_POLICY,
        tiers: {
          ...DEFAULT_POLICY.tiers,
          derived: { mode: "local_cache", max_gb: 0.0000001, prune: "lru", prune_target_pct: 0 },
        },
      };

      const plan = await storagePlan(policy);
      const result = await storageApply(plan);

      // PNG should be gone
      await assert.rejects(() => fs.access(pngPath), "PNG should be deleted");

      // Identity JSON must still exist
      await assert.doesNotReject(() => fs.access(identityPath), "identity JSON must survive");

      // Record in executed
      const pruned = result.actions_executed.filter(a => a.action === "pruned");
      assert.ok(pruned.length > 0);
      assert.ok(result.freed_bytes > 0);
    });
  });
});

// ---------------------------------------------------------------------------
// storageApply — archive docs to local cold
// ---------------------------------------------------------------------------

describe("storageApply — archive to local cold", () => {
  it("moves doc to cold_dir and writes manifest entry", async () => {
    await withVault(async (root) => {
      const coldDir = path.join(root, "cold");
      const docPath = path.join(root, "data", "docs", "doc_old.json");
      const content = JSON.stringify({ id: "old_doc" });
      await writeFile(docPath, content);

      // Mark as old
      const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      await fs.utimes(docPath, oldTime, oldTime);

      const policy: StoragePolicy = {
        ...DEFAULT_POLICY,
        tiers: {
          ...DEFAULT_POLICY.tiers,
          docs: { mode: "local_warm", cold_after_days: 90, backend: { kind: "local", cold_dir: coldDir } },
        },
      };

      // Write policy to disk so storageApply picks up the cold_dir backend
      await saveStoragePolicy(policy);

      const plan = await storagePlan(policy);
      assert.ok(plan.actions.some(a => a.action === "archive" && a.tier === "docs"));

      const result = await storageApply(plan);
      assert.ok(result.cold_bytes > 0);

      // Original doc should be gone (moved)
      await assert.rejects(() => fs.access(docPath), "doc should be moved to cold");

      // Cold manifest should have an entry
      const manifest = await loadColdManifest({ kind: "local", cold_dir: coldDir });
      assert.ok(manifest.entries.some(e => e.tier === "docs"));
    });
  });
});

// ---------------------------------------------------------------------------
// storageApply — identity files never touched
// ---------------------------------------------------------------------------

describe("storageApply — identity always protected", () => {
  it("never deletes or moves identity card JSON files", async () => {
    await withVault(async (root) => {
      const identityPath = path.join(root, "data", "cards", "card_identity.json");
      await writeFile(identityPath, JSON.stringify({ card_id: "card_identity", hash: "abc" }));

      // Very aggressive policy but identity should still be safe
      const policy: StoragePolicy = {
        ...DEFAULT_POLICY,
        tiers: {
          ...DEFAULT_POLICY.tiers,
          derived: { mode: "local_cache", max_gb: 0.0000001, prune: "lru", prune_target_pct: 0 },
        },
      };

      const plan = await storagePlan(policy);
      await storageApply(plan);

      // Identity must survive
      await assert.doesNotReject(() => fs.access(identityPath));
    });
  });
});

// ---------------------------------------------------------------------------
// storageRestore — local cold manifest restore
// ---------------------------------------------------------------------------

describe("storageRestore — local cold", () => {
  it("copies file back from cold_dir to original path", async () => {
    await withVault(async (root) => {
      const coldDir = path.join(root, "cold");
      const backend = { kind: "local" as const, cold_dir: coldDir };
      const originalRel = "data/docs/doc_restore.json";
      const coldRelPath = "docs/doc_restore.json";
      const content = JSON.stringify({ id: "to_restore" });

      // Put file in cold storage
      const coldFullPath = path.join(coldDir, coldRelPath);
      await writeFile(coldFullPath, content);

      // Write manifest entry
      await appendColdManifestEntry(backend, {
        hash: "testhash",
        tier: "docs",
        original_path: originalRel,
        cold_path: coldRelPath,
        archived_at: new Date().toISOString(),
        bytes: content.length,
        backend: "local",
      });

      // Set up policy with cold backend
      const policy: StoragePolicy = {
        ...DEFAULT_POLICY,
        tiers: {
          ...DEFAULT_POLICY.tiers,
          docs: { mode: "local_warm", cold_after_days: 90, backend },
        },
      };
      await saveStoragePolicy(policy);

      const result = await storageRestore({ tier: "docs", hashes: ["testhash"] });
      assert.equal(result.errors.length, 0, `unexpected errors: ${result.errors.join(", ")}`);
      assert.equal(result.restored.length, 1);

      // File should be back
      const restoredContent = await fs.readFile(path.join(root, originalRel), "utf-8");
      assert.equal(restoredContent, content);

      // Cold copy should still be there (restore = copy, not move)
      await assert.doesNotReject(() => fs.access(coldFullPath), "cold copy must remain");
    });
  });
});

// ---------------------------------------------------------------------------
// Cold manifest — deduplication
// ---------------------------------------------------------------------------

describe("ColdManifest — deduplication", () => {
  it("does not duplicate entries on repeated append for same original_path", async () => {
    await withVault(async (root) => {
      const coldDir = path.join(root, "cold");
      const backend = { kind: "local" as const, cold_dir: coldDir };
      await fs.mkdir(coldDir, { recursive: true });

      const entry = {
        hash: "h1",
        tier: "docs",
        original_path: "data/docs/doc.json",
        cold_path: "docs/doc.json",
        archived_at: new Date().toISOString(),
        bytes: 100,
        backend: "local" as const,
      };

      await appendColdManifestEntry(backend, entry);
      await appendColdManifestEntry(backend, { ...entry, archived_at: new Date().toISOString() });

      const manifest = await loadColdManifest(backend);
      const matching = manifest.entries.filter(e => e.original_path === "data/docs/doc.json");
      assert.equal(matching.length, 1, "manifest must not duplicate entries for same path");
    });
  });
});

// ---------------------------------------------------------------------------
// Input schema validation
// ---------------------------------------------------------------------------

describe("Storage hook input schemas — strict rejection", () => {
  it("StoragePlanInputSchema rejects unknown keys", () => {
    assert.throws(
      () => StoragePlanInputSchema.parse({ extra: "bad" }),
      /unrecognized_keys/,
    );
  });

  it("StorageApplyInputSchema rejects unknown keys", () => {
    assert.throws(
      () => StorageApplyInputSchema.parse({ unknown: true }),
      /unrecognized_keys/,
    );
  });

  it("StorageRestoreInputSchema rejects missing tier", () => {
    assert.throws(() => StorageRestoreInputSchema.parse({ hashes: ["abc"] }));
  });

  it("StorageRestoreInputSchema rejects invalid tier", () => {
    assert.throws(
      () => StorageRestoreInputSchema.parse({ tier: "identity" }), // identity is not restorable
      /invalid_enum_value/,
    );
  });
});
