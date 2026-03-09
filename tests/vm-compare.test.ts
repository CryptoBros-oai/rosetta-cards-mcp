import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execute } from "../src/kb/vm_engine.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import { compareRuns } from "../src/kb/vm_compare.js";

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

describe("VM Compare", () => {
  describe("self-compare (zero deltas)", () => {
    it("all scalar deltas are zero", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result);

      assert.equal(cmp.schema_version, "compare.v1");
      assert.equal(cmp.scalars.total_steps.delta, 0);
      assert.equal(cmp.scalars.final_bag_sum.delta, 0);
    });

    it("all verb deltas are zero", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result);

      for (const vd of cmp.verb_distribution) {
        assert.equal(vd.delta, 0, `verb ${vd.verb} delta not zero`);
      }
    });

    it("all bag variance deltas are zero", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result);

      for (const bv of cmp.bag_variance) {
        assert.equal(bv.delta, 0, `bag ${bv.bag} delta not zero`);
      }
    });

    it("all opcode frequency deltas are zero", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result);

      for (const od of cmp.opcode_frequency) {
        assert.equal(od.delta, 0, `opcode ${od.opcode_id} delta not zero`);
      }
    });

    it("all step bag deltas are zero", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result);

      assert.equal(cmp.step_deltas.length, result.trace.length);
      for (const sd of cmp.step_deltas) {
        for (const bd of sd.bag_deltas) {
          assert.equal(bd.delta, 0, `step ${sd.step} bag ${bd.bag} delta not zero`);
        }
      }
    });

    it("summary shows no changes", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result);

      assert.deepEqual(cmp.summary.most_changed_bags, []);
      assert.deepEqual(cmp.summary.most_shifted_verbs, []);
    });
  });

  describe("cross-program compare", () => {
    it("detects differences between budget and filter", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const cmp = compareRuns(a, b);

      assert.notEqual(cmp.scalars.total_steps.delta, 0);
      assert.ok(cmp.summary.most_changed_bags.length > 0);
    });

    it("step alignment handles different-length traces", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const cmp = compareRuns(a, b);

      // Budget has 12 steps, filter has 7
      assert.equal(cmp.step_deltas.length, Math.max(a.trace.length, b.trace.length));

      // Steps beyond shorter trace should have null bags
      const lastStep = cmp.step_deltas[cmp.step_deltas.length - 1];
      assert.ok(lastStep.a_bags !== null); // budget is longer
      assert.ok(lastStep.b_bags === null); // filter is shorter
    });

    it("includes all 5 verbs in distribution", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const cmp = compareRuns(a, b);

      assert.equal(cmp.verb_distribution.length, 5);
      const verbs = cmp.verb_distribution.map((vd) => vd.verb);
      assert.ok(verbs.includes("Attract"));
      assert.ok(verbs.includes("Contain"));
      assert.ok(verbs.includes("Release"));
      assert.ok(verbs.includes("Repel"));
      assert.ok(verbs.includes("Transform"));
    });
  });

  describe("determinism", () => {
    it("compareRuns is deterministic", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const c1 = compareRuns(a, b);
      const c2 = compareRuns(a, b);
      assert.deepEqual(c1, c2);
    });

    it("compare_hash is deterministic", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const c1 = compareRuns(a, b);
      const c2 = compareRuns(a, b);
      assert.equal(c1.compare_hash, c2.compare_hash);
      assert.equal(c1.compare_hash.length, 64);
    });
  });

  describe("run hash propagation", () => {
    it("includes run hashes when provided", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const cmp = compareRuns(a, b, {
        a_run_hash: "aaa111",
        b_run_hash: "bbb222",
      });
      assert.equal(cmp.a_run_hash, "aaa111");
      assert.equal(cmp.b_run_hash, "bbb222");
    });
  });

  describe("golden fixture", () => {
    it("matches frozen output", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const cmp = compareRuns(a, b);

      const goldenPath = "tests/fixtures/golden-vm-compare.json";
      if (!existsSync(goldenPath)) {
        writeFileSync(goldenPath, JSON.stringify(cmp, null, 2) + "\n");
        console.log("  [golden fixture written — re-run to verify]");
        return;
      }

      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
      assert.deepEqual(cmp, golden);
    });
  });
});
