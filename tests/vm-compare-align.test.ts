import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execute } from "../src/kb/vm_engine.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv, TraceStep } from "../src/kb/vm_types.js";
import {
  compareRuns,
  lcsMatches,
  lcsOpcodeAlignment,
  milestoneAlignment,
  DEFAULT_MILESTONES,
} from "../src/kb/vm_compare.js";
import type { AlignMode } from "../src/kb/vm_compare.js";

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

// A variant that shares some opcodes with budgetAllocator for LCS alignment testing
const budgetVariant: VmProgram = {
  program_id: "smoke_budget_variant",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "total", amount: 2000 } },
    // Skip one transform (marketing removed)
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "engineering", amount: 800 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "operations", amount: 400 } },
    // Extra attract not in original
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "reserve", amount: 100 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "engineering", min: 100, max: 600 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "operations", min: 50, max: 300 } },
    { opcode_id: "contain.threshold", verb: "Contain", args: { bag: "engineering", threshold: 400, flag: "eng_above_400" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "engineering" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "operations" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "budget variant complete" } },
  ],
};

describe("VM Compare — Alignment Modes", () => {
  // -------------------------------------------------------------------------
  // lcsMatches (core primitive)
  // -------------------------------------------------------------------------

  describe("lcsMatches", () => {
    it("identical sequences produce full match", () => {
      const matches = lcsMatches(["a", "b", "c"], ["a", "b", "c"]);
      assert.deepEqual(matches, [[0, 0], [1, 1], [2, 2]]);
    });

    it("empty sequences produce no matches", () => {
      assert.deepEqual(lcsMatches([], []), []);
      assert.deepEqual(lcsMatches(["a"], []), []);
      assert.deepEqual(lcsMatches([], ["a"]), []);
    });

    it("disjoint sequences produce no matches", () => {
      assert.deepEqual(lcsMatches(["a", "b"], ["c", "d"]), []);
    });

    it("subsequence correctly identified", () => {
      const matches = lcsMatches(["a", "b", "c", "d"], ["a", "c", "d"]);
      assert.deepEqual(matches, [[0, 0], [2, 1], [3, 2]]);
    });

    it("tie-breaking prefers advancing a", () => {
      // "a" appears in both but at different positions
      // a=[x, a], b=[a, x] — both have LCS length 1
      // Tie-break: prefer advancing a, so match "x" rather than "a"
      const matches = lcsMatches(["x", "a"], ["a", "x"]);
      // LCS: both "x" or "a" are valid length-1 LCS.
      // dp[2][2] = 1 (via dp[1][2] from x matching x)
      // Backtrack from (2,2): a_ids[1]="a" vs b_ids[1]="x" — not equal
      // dp[1][2]=1 >= dp[2][1]=1 — tie, prefer advancing a (go up)
      // At (1,2): a_ids[0]="x" vs b_ids[1]="x" — match! → [0,1]
      assert.deepEqual(matches, [[0, 1]]);
    });

    it("handles duplicates correctly", () => {
      const matches = lcsMatches(["a", "a", "b"], ["a", "b", "a"]);
      // LCS length is 2: "a","b"
      assert.equal(matches.length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // lcsOpcodeAlignment
  // -------------------------------------------------------------------------

  describe("lcsOpcodeAlignment", () => {
    it("self-alignment produces all matched pairs", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const alignment = lcsOpcodeAlignment(result.trace, result.trace);

      assert.equal(alignment.length, result.trace.length);
      for (let i = 0; i < alignment.length; i++) {
        assert.deepEqual(alignment[i], [i, i]);
      }
    });

    it("variant alignment has missing steps", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const alignment = lcsOpcodeAlignment(a.trace, b.trace);

      // Should have some null entries (missing on one side)
      const missing = alignment.filter(([ai, bi]) => ai === null || bi === null);
      assert.ok(missing.length > 0, "Expected some missing steps in LCS alignment");
    });

    it("every trace index appears exactly once", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const alignment = lcsOpcodeAlignment(a.trace, b.trace);

      const seenA = new Set<number>();
      const seenB = new Set<number>();
      for (const [ai, bi] of alignment) {
        if (ai !== null) {
          assert.ok(!seenA.has(ai), `a_index ${ai} appears more than once`);
          seenA.add(ai);
        }
        if (bi !== null) {
          assert.ok(!seenB.has(bi), `b_index ${bi} appears more than once`);
          seenB.add(bi);
        }
      }
      assert.equal(seenA.size, a.trace.length);
      assert.equal(seenB.size, b.trace.length);
    });
  });

  // -------------------------------------------------------------------------
  // milestoneAlignment
  // -------------------------------------------------------------------------

  describe("milestoneAlignment", () => {
    it("anchors on default milestone opcodes", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const alignment = milestoneAlignment(a.trace, b.trace);

      // Both have contain.threshold — should be anchored
      const aThreshIdx = a.trace.findIndex((s) => s.opcode_id === "contain.threshold");
      const bThreshIdx = b.trace.findIndex((s) => s.opcode_id === "contain.threshold");
      assert.ok(aThreshIdx >= 0);
      assert.ok(bThreshIdx >= 0);

      const anchorPair = alignment.find(([ai, bi]) => ai === aThreshIdx && bi === bThreshIdx);
      assert.ok(anchorPair, "contain.threshold should be anchored together");
    });

    it("every trace index appears exactly once", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const alignment = milestoneAlignment(a.trace, b.trace);

      const seenA = new Set<number>();
      const seenB = new Set<number>();
      for (const [ai, bi] of alignment) {
        if (ai !== null) {
          assert.ok(!seenA.has(ai), `a_index ${ai} appears more than once`);
          seenA.add(ai);
        }
        if (bi !== null) {
          assert.ok(!seenB.has(bi), `b_index ${bi} appears more than once`);
          seenB.add(bi);
        }
      }
      assert.equal(seenA.size, a.trace.length);
      assert.equal(seenB.size, b.trace.length);
    });

    it("custom milestone opcodes override defaults", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);

      // Use release.emit as the only milestone
      const alignment = milestoneAlignment(a.trace, b.trace, ["release.emit"]);
      const aEmitIdx = a.trace.findIndex((s) => s.opcode_id === "release.emit");
      const bEmitIdx = b.trace.findIndex((s) => s.opcode_id === "release.emit");

      const anchorPair = alignment.find(([ai, bi]) => ai === aEmitIdx && bi === bEmitIdx);
      assert.ok(anchorPair, "release.emit should be anchored with custom milestones");
    });

    it("no milestones present falls back to zip", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);

      // Use a nonexistent milestone — no anchors, pure zip
      const alignment = milestoneAlignment(a.trace, b.trace, ["nonexistent.opcode"]);
      const minLen = Math.min(a.trace.length, b.trace.length);

      // First minLen pairs should be zipped (both sides present)
      for (let i = 0; i < minLen; i++) {
        assert.deepEqual(alignment[i], [i, i]);
      }
      // Excess should have null on the shorter side
      for (let i = minLen; i < alignment.length; i++) {
        const [ai, bi] = alignment[i];
        assert.ok(ai !== null || bi !== null);
        if (a.trace.length > b.trace.length) {
          assert.ok(ai !== null);
          assert.equal(bi, null);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // compareRuns with opcode_signature alignment
  // -------------------------------------------------------------------------

  describe("compareRuns with opcode_signature", () => {
    it("self-compare produces zero deltas", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result, { align: "opcode_signature" });

      assert.equal(cmp.align_mode, "opcode_signature");
      assert.equal(cmp.scalars.total_steps.delta, 0);
      assert.equal(cmp.scalars.final_bag_sum.delta, 0);

      for (const sd of cmp.step_deltas) {
        assert.ok(!sd.missing, `step ${sd.step} should not be missing`);
        for (const bd of sd.bag_deltas) {
          assert.equal(bd.delta, 0, `step ${sd.step} bag ${bd.bag} delta should be zero`);
          assert.ok(!bd.missing);
        }
      }
    });

    it("cross-program compare has missing steps with null values", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const cmp = compareRuns(a, b, { align: "opcode_signature" });

      assert.equal(cmp.align_mode, "opcode_signature");

      const missingSteps = cmp.step_deltas.filter((sd) => sd.missing);
      assert.ok(missingSteps.length > 0, "Expected some missing steps");

      for (const sd of missingSteps) {
        // Missing steps have a_index or b_index as null
        assert.ok(sd.a_index === null || sd.b_index === null);
        // Bag deltas on missing steps have null delta
        for (const bd of sd.bag_deltas) {
          assert.equal(bd.delta, null, "Missing step bag delta should be null");
          assert.ok(bd.missing);
        }
      }
    });

    it("step_deltas include a_index and b_index", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(filterPipeline, emptyState(), ENV);
      const cmp = compareRuns(a, b, { align: "opcode_signature" });

      for (const sd of cmp.step_deltas) {
        assert.ok("a_index" in sd, "a_index should be present");
        assert.ok("b_index" in sd, "b_index should be present");
      }
    });

    it("is deterministic", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const c1 = compareRuns(a, b, { align: "opcode_signature" });
      const c2 = compareRuns(a, b, { align: "opcode_signature" });
      assert.deepEqual(c1, c2);
      assert.equal(c1.compare_hash, c2.compare_hash);
      assert.equal(c1.compare_hash.length, 64);
    });
  });

  // -------------------------------------------------------------------------
  // compareRuns with milestone alignment
  // -------------------------------------------------------------------------

  describe("compareRuns with milestone", () => {
    it("self-compare produces zero deltas", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result, { align: "milestone" });

      assert.equal(cmp.align_mode, "milestone");
      assert.equal(cmp.scalars.total_steps.delta, 0);

      for (const sd of cmp.step_deltas) {
        assert.ok(!sd.missing);
        for (const bd of sd.bag_deltas) {
          assert.equal(bd.delta, 0);
        }
      }
    });

    it("custom milestones affect alignment", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);

      const cmpDefault = compareRuns(a, b, { align: "milestone" });
      const cmpCustom = compareRuns(a, b, {
        align: "milestone",
        milestones: { opcode_ids: ["release.emit"] },
      });

      // Different milestone sets should produce different alignments
      assert.notEqual(cmpDefault.compare_hash, cmpCustom.compare_hash);
    });

    it("is deterministic", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const c1 = compareRuns(a, b, { align: "milestone" });
      const c2 = compareRuns(a, b, { align: "milestone" });
      assert.deepEqual(c1, c2);
    });
  });

  // -------------------------------------------------------------------------
  // align_mode field behavior
  // -------------------------------------------------------------------------

  describe("align_mode field", () => {
    it("absent for step mode (backward compat)", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result);
      assert.ok(!("align_mode" in cmp), "align_mode should not be present for step mode");
    });

    it("present for opcode_signature", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result, { align: "opcode_signature" });
      assert.equal(cmp.align_mode, "opcode_signature");
    });

    it("present for milestone", () => {
      const result = execute(budgetAllocator, emptyState(), ENV);
      const cmp = compareRuns(result, result, { align: "milestone" });
      assert.equal(cmp.align_mode, "milestone");
    });
  });

  // -------------------------------------------------------------------------
  // different alignment modes produce different hashes (same inputs)
  // -------------------------------------------------------------------------

  describe("alignment modes produce different compare_hash", () => {
    it("step vs opcode_signature differ for cross-program", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const step = compareRuns(a, b, { align: "step" });
      const lcs = compareRuns(a, b, { align: "opcode_signature" });
      assert.notEqual(step.compare_hash, lcs.compare_hash);
    });
  });

  // -------------------------------------------------------------------------
  // Golden fixtures
  // -------------------------------------------------------------------------

  describe("golden fixtures", () => {
    it("opcode_signature golden", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const cmp = compareRuns(a, b, { align: "opcode_signature" });

      const goldenPath = "tests/fixtures/golden-vm-compare-opcode-align.json";
      if (!existsSync(goldenPath)) {
        writeFileSync(goldenPath, JSON.stringify(cmp, null, 2) + "\n");
        console.log("  [golden fixture written — re-run to verify]");
        return;
      }

      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
      assert.deepEqual(cmp, golden);
    });

    it("milestone golden", () => {
      const a = execute(budgetAllocator, emptyState(), ENV);
      const b = execute(budgetVariant, emptyState(), ENV);
      const cmp = compareRuns(a, b, { align: "milestone" });

      const goldenPath = "tests/fixtures/golden-vm-compare-milestone-align.json";
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
