import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import {
  cartesianProduct,
  applyKnobs,
  scanPhases,
  detectPhaseHints,
} from "../src/kb/vm_phase_scan.js";
import type { Knob, GridPointSummary } from "../src/kb/vm_phase_scan.js";

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

describe("VM Phase Scan", () => {
  describe("cartesianProduct", () => {
    it("produces correct product for single knob", () => {
      const knobs: Knob[] = [{ key: "run_seed", values: [1, 2, 3] }];
      const grid = cartesianProduct(knobs);
      assert.equal(grid.length, 3);
      assert.deepEqual(grid[0], { run_seed: 1 });
      assert.deepEqual(grid[1], { run_seed: 2 });
      assert.deepEqual(grid[2], { run_seed: 3 });
    });

    it("produces correct product for two knobs", () => {
      const knobs: Knob[] = [
        { key: "run_seed", values: [1, 2] },
        { key: "world_seed", values: [10, 20] },
      ];
      const grid = cartesianProduct(knobs);
      assert.equal(grid.length, 4);
      // Sorted by key: run_seed, world_seed. Last varies fastest.
      assert.deepEqual(grid[0], { run_seed: 1, world_seed: 10 });
      assert.deepEqual(grid[1], { run_seed: 1, world_seed: 20 });
      assert.deepEqual(grid[2], { run_seed: 2, world_seed: 10 });
      assert.deepEqual(grid[3], { run_seed: 2, world_seed: 20 });
    });

    it("sorts knobs by key for determinism", () => {
      const knobs: Knob[] = [
        { key: "zeta", values: [1] },
        { key: "alpha", values: [2] },
      ];
      const grid = cartesianProduct(knobs);
      assert.equal(grid.length, 1);
      assert.deepEqual(grid[0], { alpha: 2, zeta: 1 });
    });

    it("empty knobs returns single empty point", () => {
      const grid = cartesianProduct([]);
      assert.equal(grid.length, 1);
      assert.deepEqual(grid[0], {});
    });

    it("handles empty values array", () => {
      const knobs: Knob[] = [{ key: "x", values: [] }];
      const grid = cartesianProduct(knobs);
      assert.equal(grid.length, 0);
    });
  });

  describe("applyKnobs", () => {
    it("applies direct env keys", () => {
      const env = applyKnobs(ENV, { run_seed: 999, world_seed: 888 });
      assert.equal(env.run_seed, 999);
      assert.equal(env.world_seed, 888);
      assert.equal(env.max_steps, 10000); // unchanged
    });

    it("puts non-direct keys into params", () => {
      const env = applyKnobs(ENV, { my_param: 42, another: "yes" });
      assert.equal(env.params?.my_param, 42);
      assert.equal(env.params?.another, "yes");
    });

    it("does not mutate the original env", () => {
      const original = { ...ENV };
      applyKnobs(ENV, { run_seed: 999 });
      assert.deepEqual(ENV, original);
    });
  });

  describe("scanPhases", () => {
    it("single knob value produces single grid point", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [42] }],
      });

      assert.equal(result.scan_index.schema_version, "phase_scan.v1");
      assert.equal(result.scan_index.grid_size, 1);
      assert.equal(result.scan_index.points.length, 1);
      assert.equal(result.phase_hints.hints.length, 0); // no adjacent points
      assert.equal(result.transition_dossier.length, 0);
    });

    it("multiple seed values produce correct grid", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      assert.equal(result.scan_index.grid_size, 3);
      assert.equal(result.scan_index.points.length, 3);
      assert.equal(result.transition_dossier.length, 2); // 3 points = 2 transitions
    });

    it("scan_hash is deterministic", () => {
      const def = {
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2] }] as Knob[],
      };
      const r1 = scanPhases(def);
      const r2 = scanPhases(def);
      assert.equal(r1.scan_index.scan_hash, r2.scan_index.scan_hash);
      assert.equal(r1.scan_index.scan_hash.length, 64);
    });

    it("includes trace when requested", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [42] }],
        include_trace: true,
      });

      assert.ok(result.scan_index.points[0].trace !== undefined);
      assert.equal(result.scan_index.points[0].trace!.length, 12);
    });

    it("omits trace by default", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [42] }],
      });

      assert.equal(result.scan_index.points[0].trace, undefined);
    });

    it("each point has a final_state_hash", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2] }],
      });

      for (const point of result.scan_index.points) {
        assert.equal(point.final_state_hash.length, 64);
      }
    });

    it("program_fingerprint is correct", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [42] }],
      });

      // Same program should produce same fingerprint
      const r2 = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1] }],
      });

      assert.equal(
        result.scan_index.program_fingerprint,
        r2.scan_index.program_fingerprint,
      );
    });
  });

  describe("detectPhaseHints", () => {
    it("detects sign_change when halted_early flips", () => {
      const points: GridPointSummary[] = [
        makePoint(0, { halted_early: false, total_steps: 12, final_bag_sum: 100 }),
        makePoint(1, { halted_early: true, total_steps: 5, final_bag_sum: 50 }),
      ];
      const hints = detectPhaseHints(points);
      const signChange = hints.find((h) => h.kind === "sign_change");
      assert.ok(signChange);
      assert.equal(signChange!.metric, "halted_early");
    });

    it("detects threshold_crossing for >50% shift", () => {
      const points: GridPointSummary[] = [
        makePoint(0, { halted_early: false, total_steps: 100, final_bag_sum: 100 }),
        makePoint(1, { halted_early: false, total_steps: 100, final_bag_sum: 10 }),
      ];
      const hints = detectPhaseHints(points);
      const threshold = hints.find(
        (h) => h.kind === "threshold_crossing" && h.metric === "final_bag_sum",
      );
      assert.ok(threshold);
    });

    it("no hints for identical points", () => {
      const points: GridPointSummary[] = [
        makePoint(0, { halted_early: false, total_steps: 12, final_bag_sum: 100 }),
        makePoint(1, { halted_early: false, total_steps: 12, final_bag_sum: 100 }),
      ];
      const hints = detectPhaseHints(points);
      assert.equal(hints.length, 0);
    });

    it("no hints for single point", () => {
      const points: GridPointSummary[] = [
        makePoint(0, { halted_early: false, total_steps: 12, final_bag_sum: 100 }),
      ];
      const hints = detectPhaseHints(points);
      assert.equal(hints.length, 0);
    });
  });

  describe("determinism", () => {
    it("full scan is deterministic", () => {
      const def = {
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }] as Knob[],
      };
      const r1 = scanPhases(def);
      const r2 = scanPhases(def);
      assert.deepEqual(r1.scan_index, r2.scan_index);
      assert.deepEqual(r1.phase_hints, r2.phase_hints);
      assert.deepEqual(r1.transition_dossier, r2.transition_dossier);
    });
  });

  describe("golden fixture", () => {
    it("matches frozen output", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 42] }],
      });

      // Only freeze scan_index + phase_hints (dossier is large)
      const frozen = {
        scan_index: result.scan_index,
        phase_hints: result.phase_hints,
      };

      const goldenPath = "tests/fixtures/golden-vm-phase-scan.json";
      if (!existsSync(goldenPath)) {
        writeFileSync(goldenPath, JSON.stringify(frozen, null, 2) + "\n");
        console.log("  [golden fixture written — re-run to verify]");
        return;
      }

      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
      assert.deepEqual(frozen, golden);
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePoint(
  index: number,
  overrides: {
    halted_early: boolean;
    total_steps: number;
    final_bag_sum: number;
  },
): GridPointSummary {
  return {
    index,
    knob_values: {},
    metrics: {
      total_steps: overrides.total_steps,
      opcode_frequency: {},
      verb_distribution: {
        Attract: 0,
        Contain: 0,
        Release: 0,
        Repel: 0,
        Transform: 0,
      },
      bag_variance: {},
      final_bag_sum: overrides.final_bag_sum,
      halted_early: overrides.halted_early,
    },
    final_state_hash: "0".repeat(64),
  };
}
