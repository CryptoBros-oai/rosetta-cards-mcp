import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { scanPhases } from "../src/kb/vm_phase_scan.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";

// ---------------------------------------------------------------------------
// Test program (rngPhaseTransitionV2)
// ---------------------------------------------------------------------------

const rngProgram: VmProgram = {
  program_id: "rng_phase_transition_v2",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_low", amount: 30 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_mid", amount: 200 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_high", amount: 800 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_a", amount: 1 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_b", amount: 2 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_a,warmup_b", into: "discard1" } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_c", amount: 3 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_d", amount: 4 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_c,warmup_d", into: "discard2" } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_e", amount: 5 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_f", amount: 6 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_e,warmup_f", into: "discard3" } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "pool_low,pool_mid,pool_high", into: "chosen" } },
    { opcode_id: "contain.env_threshold", verb: "Contain", args: { bag: "chosen", threshold_key: "halt_threshold", flag: "is_high" } },
    { opcode_id: "repel.reject", verb: "Repel", args: { flag: "is_high", reason: "threshold exceeded — halting" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "chosen" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "low value path complete" } },
  ],
};

const BASE_ENV: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000 };

// Bracket thresholds that span known pool boundaries (30, 200, 800)
const THRESHOLDS = [10.5, 25.5, 35.5, 100.5, 195.5, 205.5, 500.5, 795.5, 805.5, 900.5];

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe("Boundary Hunt — basic", () => {
  it("returns PhaseScanResult with boundary_hunt field", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: THRESHOLDS }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: { max_refinements: 2, max_total_runs: 50 },
    });
    assert.ok(result.boundary_hunt, "Expected boundary_hunt field");
    assert.ok(Array.isArray(result.boundary_hunt.boundary_regions));
    assert.ok(Array.isArray(result.boundary_hunt.all_points));
    assert.ok(Array.isArray(result.boundary_hunt.all_hints));
    assert.ok(Array.isArray(result.boundary_hunt.expansion_rounds));
    assert.ok(Array.isArray(result.boundary_hunt.refinement_rounds));
  });

  it("produces more points than coarse grid", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: THRESHOLDS }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: { max_refinements: 2, max_total_runs: 50 },
    });
    assert.ok(result.boundary_hunt);
    assert.ok(
      result.boundary_hunt.all_points.length > THRESHOLDS.length,
      `Expected more than ${THRESHOLDS.length} points, got ${result.boundary_hunt.all_points.length}`,
    );
  });

  it("at least one boundary region detected", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: THRESHOLDS }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: { max_refinements: 2, max_total_runs: 50 },
    });
    assert.ok(result.boundary_hunt);
    assert.ok(
      result.boundary_hunt.boundary_regions.length > 0,
      "Expected at least one boundary region",
    );
  });

  it("boundary regions have distinct regimes", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: THRESHOLDS }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: { max_refinements: 2, max_total_runs: 50 },
    });
    assert.ok(result.boundary_hunt);
    for (const region of result.boundary_hunt.boundary_regions) {
      assert.notEqual(
        region.regime_low, region.regime_high,
        `Boundary region should have distinct regimes, got ${region.regime_low} on both sides`,
      );
    }
  });

  it("no duplicate knob values", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: THRESHOLDS }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: { max_refinements: 2, max_total_runs: 50 },
    });
    assert.ok(result.boundary_hunt);
    const keys = result.boundary_hunt.all_points.map(
      (p) => JSON.stringify(Object.entries(p.knob_values).sort()),
    );
    assert.equal(new Set(keys).size, keys.length, "Duplicate knob values found");
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe("Boundary Hunt — bounds", () => {
  it("respects max_total_runs", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: THRESHOLDS }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: { max_refinements: 10, max_total_runs: 15 },
    });
    assert.ok(result.boundary_hunt);
    assert.ok(
      result.boundary_hunt.all_points.length <= 15,
      `Expected <= 15 points, got ${result.boundary_hunt.all_points.length}`,
    );
  });

  it("no refinable knobs returns coarse result", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: { ...BASE_ENV, params: { halt_threshold: 100 } },
      knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
    });
    assert.ok(result.boundary_hunt);
    assert.equal(result.boundary_hunt.boundary_regions.length, 0);
    assert.equal(result.boundary_hunt.all_points.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Backward compat
// ---------------------------------------------------------------------------

describe("Boundary Hunt — backward compat", () => {
  it("grid mode still works", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: { ...BASE_ENV, params: { halt_threshold: 100 } },
      knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      options: { softHalt: true },
      scan_mode: "grid",
    });
    assert.ok(!result.boundary_hunt);
    assert.ok(!result.adaptive);
    assert.equal(result.scan_index.grid_size, 3);
  });

  it("adaptive mode still works", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: [10.5, 100.5, 500.5, 900.5] }],
      options: { softHalt: true },
      scan_mode: "adaptive",
      adaptive: { max_refinements: 1, max_total_runs: 20 },
    });
    assert.ok(!result.boundary_hunt);
    assert.ok(result.adaptive);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("Boundary Hunt — determinism", () => {
  it("two runs produce identical results", () => {
    const def = {
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: [25.5, 35.5, 195.5, 205.5, 795.5, 805.5] }],
      options: { softHalt: true } as const,
      scan_mode: "hunt_boundaries" as const,
      boundary_hunt: { max_refinements: 2, max_total_runs: 30 },
    };
    const r1 = scanPhases(def);
    const r2 = scanPhases(def);

    assert.ok(r1.boundary_hunt && r2.boundary_hunt);
    assert.equal(r1.boundary_hunt.all_points.length, r2.boundary_hunt.all_points.length);
    assert.equal(r1.boundary_hunt.boundary_regions.length, r2.boundary_hunt.boundary_regions.length);
    assert.equal(r1.boundary_hunt.all_hints.length, r2.boundary_hunt.all_hints.length);
    assert.deepEqual(r1.boundary_hunt.boundary_regions, r2.boundary_hunt.boundary_regions);
  });
});

// ---------------------------------------------------------------------------
// No NaN
// ---------------------------------------------------------------------------

describe("Boundary Hunt — no NaN", () => {
  it("JSON output contains no NaN or Infinity", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: [25.5, 205.5, 805.5] }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: { max_refinements: 1, max_total_runs: 20 },
    });
    assert.ok(result.boundary_hunt);
    const json = JSON.stringify(result.boundary_hunt);
    assert.ok(!json.includes("NaN"), "Output must not contain NaN");
    assert.ok(!json.includes("Infinity"), "Output must not contain Infinity");
  });
});

// ---------------------------------------------------------------------------
// Golden fixture
// ---------------------------------------------------------------------------

describe("Boundary Hunt — golden fixture", () => {
  it("matches frozen output", () => {
    const result = scanPhases({
      program: rngProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: [25.5, 35.5, 195.5, 205.5, 795.5, 805.5] }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: { max_refinements: 2, max_total_runs: 30 },
    });
    assert.ok(result.boundary_hunt);

    const frozen = {
      boundary_region_count: result.boundary_hunt.boundary_regions.length,
      all_points_count: result.boundary_hunt.all_points.length,
      all_hints_count: result.boundary_hunt.all_hints.length,
      expansion_rounds_count: result.boundary_hunt.expansion_rounds.length,
      refinement_rounds_count: result.boundary_hunt.refinement_rounds.length,
      scan_hash: result.scan_index.scan_hash.slice(0, 12),
    };

    const goldenPath = "tests/fixtures/golden-vm-boundary-hunt.json";
    if (!existsSync(goldenPath)) {
      writeFileSync(goldenPath, JSON.stringify(frozen, null, 2) + "\n");
      console.log("  [golden fixture written — re-run to verify]");
      return;
    }

    const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
    assert.deepEqual(frozen, golden);
  });
});
