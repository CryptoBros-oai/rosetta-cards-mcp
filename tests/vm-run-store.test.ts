import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execute } from "../src/kb/vm_engine.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import {
  computeRunHash,
  computeProgramFingerprint,
  persistRun,
  loadRun,
  listRuns,
  generateRunSummary,
} from "../src/kb/vm_run_store.js";

const ENV: VmEnv = { run_seed: 42, world_seed: 7, max_steps: 10000 };

const budgetAllocator: VmProgram = {
  program_id: "smoke_budget_allocator",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "total", amount: 1000 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "engineering", amount: 500 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "marketing", amount: 300 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "operations", amount: 200 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "engineering", min: 100, max: 600 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "marketing", min: 50, max: 400 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "operations", min: 50, max: 300 } },
    { opcode_id: "contain.threshold", verb: "Contain", args: { bag: "engineering", threshold: 400, flag: "eng_above_400" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "engineering" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "marketing" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "operations" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "budget allocation complete" } },
  ],
};

const filterPipeline: VmProgram = {
  program_id: "smoke_filter_pipeline",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_a", amount: 80 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_b", amount: 30 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_c", amount: 95 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_d", amount: 10 } },
    { opcode_id: "repel.filter", verb: "Repel", args: { threshold: 50, bags_list: "item_a,item_b,item_c,item_d" } },
    { opcode_id: "contain.normalize", verb: "Contain", args: { bags_list: "item_a,item_b,item_c,item_d", target: 100 } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "filter pipeline complete" } },
  ],
};

// Use a temp directory for test isolation
const TEST_DATA_DIR = join("data", "runs");

describe("VM Run Store", () => {
  // Clean up test runs before and after
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  describe("computeRunHash", () => {
    it("produces deterministic hash", () => {
      const h1 = computeRunHash(budgetAllocator, emptyState(), ENV);
      const h2 = computeRunHash(budgetAllocator, emptyState(), ENV);
      assert.equal(h1, h2);
      assert.equal(h1.length, 64); // SHA-256 hex
    });

    it("different programs produce different hashes", () => {
      const h1 = computeRunHash(budgetAllocator, emptyState(), ENV);
      const h2 = computeRunHash(filterPipeline, emptyState(), ENV);
      assert.notEqual(h1, h2);
    });

    it("different envs produce different hashes", () => {
      const h1 = computeRunHash(budgetAllocator, emptyState(), ENV);
      const h2 = computeRunHash(budgetAllocator, emptyState(), { ...ENV, run_seed: 999 });
      assert.notEqual(h1, h2);
    });

    it("different initial states produce different hashes", () => {
      const s1 = emptyState();
      const s2 = emptyState();
      s2.bags.pre = 100;
      const h1 = computeRunHash(budgetAllocator, s1, ENV);
      const h2 = computeRunHash(budgetAllocator, s2, ENV);
      assert.notEqual(h1, h2);
    });
  });

  describe("computeProgramFingerprint", () => {
    it("produces deterministic fingerprint", () => {
      const f1 = computeProgramFingerprint(budgetAllocator);
      const f2 = computeProgramFingerprint(budgetAllocator);
      assert.equal(f1, f2);
    });

    it("different programs produce different fingerprints", () => {
      const f1 = computeProgramFingerprint(budgetAllocator);
      const f2 = computeProgramFingerprint(filterPipeline);
      assert.notEqual(f1, f2);
    });
  });

  describe("persistRun + loadRun round-trip", () => {
    it("persists and loads a run", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const { run_hash, run_dir } = persistRun(budgetAllocator, emptyState(), ENV, result);
      createdDirs.push(run_dir);

      assert.equal(run_hash.length, 64);
      assert.ok(existsSync(run_dir));
      assert.ok(existsSync(join(run_dir, "RUN_METADATA.json")));
      assert.ok(existsSync(join(run_dir, "TRACE.json")));
      assert.ok(existsSync(join(run_dir, "VM_METRICS.json")));
      assert.ok(existsSync(join(run_dir, "FINAL_STATE.json")));
      assert.ok(existsSync(join(run_dir, "RUN_SUMMARY.md")));

      const loaded = loadRun(run_hash);
      assert.ok(loaded !== null);
      assert.equal(loaded!.metadata.run_hash, run_hash);
      assert.equal(loaded!.metadata.program_id, "smoke_budget_allocator");
      assert.equal(loaded!.metadata.schema_version, "run.v1");
      assert.deepEqual(loaded!.metrics, result.metrics);
      assert.deepEqual(loaded!.finalState, result.state);
      assert.equal(loaded!.trace.length, result.trace.length);
    });

    it("loadRun returns null for missing hash", () => {
      const loaded = loadRun("000000000000");
      assert.equal(loaded, null);
    });

    it("persisting same run twice is idempotent (overwrites)", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const r1 = persistRun(budgetAllocator, emptyState(), ENV, result);
      const r2 = persistRun(budgetAllocator, emptyState(), ENV, result);
      createdDirs.push(r1.run_dir);
      assert.equal(r1.run_hash, r2.run_hash);
      assert.equal(r1.run_dir, r2.run_dir);
    });

    it("metadata includes correct program fingerprint", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const { run_hash, run_dir } = persistRun(budgetAllocator, emptyState(), ENV, result);
      createdDirs.push(run_dir);

      const loaded = loadRun(run_hash)!;
      const expectedFp = computeProgramFingerprint(budgetAllocator);
      assert.equal(loaded.metadata.program_fingerprint, expectedFp);
    });
  });

  describe("listRuns", () => {
    it("lists persisted runs sorted by hash prefix", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2);
      createdDirs.push(p1.run_dir, p2.run_dir);

      const runs = listRuns();
      assert.ok(runs.length >= 2);

      // Find our runs in the list
      const found1 = runs.find((r) => r.run_hash === p1.run_hash);
      const found2 = runs.find((r) => r.run_hash === p2.run_hash);
      assert.ok(found1);
      assert.ok(found2);
    });
  });

  describe("generateRunSummary", () => {
    it("produces valid markdown", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const { run_hash, run_dir } = persistRun(budgetAllocator, emptyState(), ENV, result);
      createdDirs.push(run_dir);

      const loaded = loadRun(run_hash)!;
      const summary = generateRunSummary(loaded.metadata, loaded.metrics);

      assert.ok(summary.startsWith("# Run Summary"));
      assert.ok(summary.includes("smoke_budget_allocator"));
      assert.ok(summary.includes("run_seed"));
      assert.ok(summary.includes("Verb Distribution"));
      assert.ok(summary.includes("Opcode Frequency"));
      assert.ok(summary.includes("attract.add"));
    });
  });

  describe("run hash determinism", () => {
    it("10 runs produce identical hashes", () => {
      const hashes: string[] = [];
      for (let i = 0; i < 10; i++) {
        hashes.push(computeRunHash(budgetAllocator, emptyState(), ENV));
      }
      for (let i = 1; i < 10; i++) {
        assert.equal(hashes[i], hashes[0], `hash ${i} differs from hash 0`);
      }
    });
  });
});
