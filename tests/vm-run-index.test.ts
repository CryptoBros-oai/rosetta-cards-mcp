import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execute } from "../src/kb/vm_engine.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import { persistRun } from "../src/kb/vm_run_store.js";
import {
  appendToIndex,
  loadIndex,
  searchIndex,
  rebuildRunIndex,
  IndexRecordSchema,
} from "../src/kb/vm_run_index.js";

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

const INDEX_PATH = join("data", "runs", "index.jsonl");
const createdDirs: string[] = [];

describe("VM Run Index", () => {
  beforeEach(() => {
    // Ensure clean state before each test (guards against batch-run pollution)
    if (existsSync(INDEX_PATH)) rmSync(INDEX_PATH);
  });

  afterEach(() => {
    // Clean up created run dirs
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
    // Clean up index file
    if (existsSync(INDEX_PATH)) rmSync(INDEX_PATH);
  });

  describe("appendToIndex", () => {
    it("creates index.jsonl on first call", () => {
      const r = execute(budgetAllocator, emptyState(), ENV);
      const { run_dir } = persistRun(budgetAllocator, emptyState(), ENV, r);
      createdDirs.push(run_dir);

      assert.ok(existsSync(INDEX_PATH));
      const content = readFileSync(INDEX_PATH, "utf-8").trim();
      const lines = content.split("\n");
      assert.equal(lines.length, 1);
    });

    it("appends second record", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2);
      createdDirs.push(p1.run_dir, p2.run_dir);

      const content = readFileSync(INDEX_PATH, "utf-8").trim();
      const lines = content.split("\n");
      assert.equal(lines.length, 2);
    });

    it("index records validate against IndexRecordSchema", () => {
      const r = execute(budgetAllocator, emptyState(), ENV);
      const { run_dir } = persistRun(budgetAllocator, emptyState(), ENV, r);
      createdDirs.push(run_dir);

      const content = readFileSync(INDEX_PATH, "utf-8").trim();
      const parsed = JSON.parse(content);
      const result = IndexRecordSchema.safeParse(parsed);
      assert.ok(result.success, `Schema validation failed: ${JSON.stringify(result.error?.issues)}`);
    });
  });

  describe("loadIndex", () => {
    it("returns non-superseded records sorted by created_at desc", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2);
      createdDirs.push(p1.run_dir, p2.run_dir);

      const records = loadIndex();
      assert.equal(records.length, 2);
      // Second persist happened later, should be first
      assert.ok(records[0].created_at >= records[1].created_at);
    });

    it("returns empty array when no index exists", () => {
      const records = loadIndex();
      assert.deepEqual(records, []);
    });
  });

  describe("re-persist supersedes old record", () => {
    it("loadIndex returns only latest record for same run_id", () => {
      const r = execute(budgetAllocator, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r);
      createdDirs.push(p1.run_dir);

      // Re-persist same run
      const p2 = persistRun(budgetAllocator, emptyState(), ENV, r);
      assert.equal(p1.run_hash, p2.run_hash);

      const records = loadIndex();
      assert.equal(records.length, 1);
      assert.equal(records[0].run_id, p1.run_hash);
    });
  });

  describe("searchIndex", () => {
    it("filters by program_fingerprint", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2);
      createdDirs.push(p1.run_dir, p2.run_dir);

      const records = loadIndex();
      const budgetFp = records.find((r) => r.program_id === "smoke_budget_allocator")!.program_fingerprint;

      const result = searchIndex({ program_fingerprint: budgetFp });
      assert.equal(result.total, 1);
      assert.equal(result.records[0].program_id, "smoke_budget_allocator");
    });

    it("filters by program_id", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2);
      createdDirs.push(p1.run_dir, p2.run_dir);

      const result = searchIndex({ program_id: "smoke_filter_pipeline" });
      assert.equal(result.total, 1);
      assert.equal(result.records[0].program_id, "smoke_filter_pipeline");
    });

    it("filters by env ranges", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(budgetAllocator, emptyState(), { ...ENV, run_seed: 999 });
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(budgetAllocator, emptyState(), { ...ENV, run_seed: 999 }, r2);
      createdDirs.push(p1.run_dir, p2.run_dir);

      const result = searchIndex({ run_seed_min: 100 });
      assert.equal(result.total, 1);
      assert.equal(result.records[0].env.run_seed, 999);
    });

    it("filters by metric thresholds", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2);
      createdDirs.push(p1.run_dir, p2.run_dir);

      // Budget allocator has final_bag_sum=0, filter has 100
      const result = searchIndex({ final_bag_sum_min: 50 });
      assert.equal(result.total, 1);
      assert.equal(result.records[0].program_id, "smoke_filter_pipeline");
    });

    it("filters by tags (AND logic)", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1, { tags: ["budget", "smoke"] });
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2, { tags: ["filter", "smoke"] });
      createdDirs.push(p1.run_dir, p2.run_dir);

      const result = searchIndex({ tags: ["smoke"] });
      assert.equal(result.total, 2);

      const result2 = searchIndex({ tags: ["budget", "smoke"] });
      assert.equal(result2.total, 1);
      assert.equal(result2.records[0].program_id, "smoke_budget_allocator");
    });

    it("filters by halted_early", () => {
      const r = execute(budgetAllocator, emptyState(), ENV);
      const p = persistRun(budgetAllocator, emptyState(), ENV, r);
      createdDirs.push(p.run_dir);

      const result = searchIndex({ halted_early: false });
      assert.equal(result.total, 1);

      const result2 = searchIndex({ halted_early: true });
      assert.equal(result2.total, 0);
    });

    it("pagination works (offset + limit)", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const r3 = execute(budgetAllocator, emptyState(), { ...ENV, run_seed: 99 });
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2);
      const p3 = persistRun(budgetAllocator, emptyState(), { ...ENV, run_seed: 99 }, r3);
      createdDirs.push(p1.run_dir, p2.run_dir, p3.run_dir);

      const page1 = searchIndex({ limit: 2, offset: 0 });
      assert.equal(page1.total, 3);
      assert.equal(page1.records.length, 2);

      const page2 = searchIndex({ limit: 2, offset: 2 });
      assert.equal(page2.total, 3);
      assert.equal(page2.records.length, 1);
    });
  });

  describe("rebuildRunIndex", () => {
    it("recovers from missing index", () => {
      const r1 = execute(budgetAllocator, emptyState(), ENV);
      const r2 = execute(filterPipeline, emptyState(), ENV);
      const p1 = persistRun(budgetAllocator, emptyState(), ENV, r1);
      const p2 = persistRun(filterPipeline, emptyState(), ENV, r2);
      createdDirs.push(p1.run_dir, p2.run_dir);

      // Delete the index
      rmSync(INDEX_PATH);
      assert.ok(!existsSync(INDEX_PATH));

      // Rebuild
      const records = rebuildRunIndex();
      assert.equal(records.length, 2);
      assert.ok(existsSync(INDEX_PATH));

      // Verify loadIndex works after rebuild
      const loaded = loadIndex();
      assert.equal(loaded.length, 2);
    });
  });

  describe("determinism", () => {
    it("same persist produces consistent index record fields", () => {
      const r = execute(budgetAllocator, emptyState(), ENV);
      const p = persistRun(budgetAllocator, emptyState(), ENV, r);
      createdDirs.push(p.run_dir);

      const records = loadIndex();
      assert.equal(records.length, 1);
      assert.equal(records[0].run_id, p.run_hash);
      assert.equal(records[0].run_hash12, p.run_hash.slice(0, 12));
      assert.equal(records[0].program_id, "smoke_budget_allocator");
      assert.equal(records[0].total_steps, 12);
      assert.equal(records[0].final_bag_sum, 0);
      assert.equal(records[0].halted_early, false);
    });
  });
});
