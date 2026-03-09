import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getOpcode, listOpcodesByVerb } from "../src/kb/vm_registry.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmState, VmEnv, VmProgram } from "../src/kb/vm_types.js";
import { createRng } from "../src/kb/vm_rng.js";
import { execute } from "../src/kb/vm_engine.js";
import { scanPhases } from "../src/kb/vm_phase_scan.js";
import type { Knob } from "../src/kb/vm_phase_scan.js";

function state(
  bags: Record<string, number> = {},
  extra?: Partial<VmState>,
): VmState {
  return { bags, stack: [], flags: {}, notes: [], ...extra };
}

const ENV: VmEnv = { run_seed: 42, world_seed: 7, max_steps: 10000 };

// ---------------------------------------------------------------------------
// contain.env_threshold — unit tests
// ---------------------------------------------------------------------------

describe("contain.env_threshold", () => {
  const spec = getOpcode("contain.env_threshold")!;

  it("exists in registry as Contain verb", () => {
    assert.ok(spec);
    assert.equal(spec.verb, "Contain");
    assert.deepEqual(spec.required_args, ["bag", "threshold_key", "flag"]);
  });

  it("sets flag true when bag >= env.params threshold", () => {
    const s = state({ score: 100 });
    const env: VmEnv = { ...ENV, params: { my_thresh: 50 } };
    const rng = createRng(42, 7);
    const result = spec.reduce(
      s,
      { bag: "score", threshold_key: "my_thresh", flag: "above" },
      env,
      rng.next,
    );
    assert.equal(result.flags.above, true);
  });

  it("sets flag true when bag equals threshold exactly", () => {
    const s = state({ score: 50 });
    const env: VmEnv = { ...ENV, params: { my_thresh: 50 } };
    const rng = createRng(42, 7);
    const result = spec.reduce(
      s,
      { bag: "score", threshold_key: "my_thresh", flag: "above" },
      env,
      rng.next,
    );
    assert.equal(result.flags.above, true);
  });

  it("sets flag false when bag < env.params threshold", () => {
    const s = state({ score: 30 });
    const env: VmEnv = { ...ENV, params: { my_thresh: 50 } };
    const rng = createRng(42, 7);
    const result = spec.reduce(
      s,
      { bag: "score", threshold_key: "my_thresh", flag: "above" },
      env,
      rng.next,
    );
    assert.equal(result.flags.above, false);
  });

  it("defaults threshold to 0 when param key missing", () => {
    const s = state({ score: 1 });
    const env: VmEnv = { ...ENV, params: { other_key: 999 } };
    const rng = createRng(42, 7);
    const result = spec.reduce(
      s,
      { bag: "score", threshold_key: "missing_key", flag: "above" },
      env,
      rng.next,
    );
    // score=1 >= 0 → true
    assert.equal(result.flags.above, true);
  });

  it("defaults threshold to 0 when params is undefined", () => {
    const s = state({ score: 5 });
    const env: VmEnv = { run_seed: 42, world_seed: 7, max_steps: 10000 };
    const rng = createRng(42, 7);
    const result = spec.reduce(
      s,
      { bag: "score", threshold_key: "anything", flag: "above" },
      env,
      rng.next,
    );
    // score=5 >= 0 → true
    assert.equal(result.flags.above, true);
  });

  it("precondition fails if bag does not exist", () => {
    const s = state({});
    const err = spec.precondition!(s, {
      bag: "nonexistent",
      threshold_key: "t",
      flag: "f",
    });
    assert.ok(err);
    assert.ok(err!.includes("nonexistent"));
  });

  it("works with float threshold from env.params", () => {
    const s = state({ score: 100 });
    const env: VmEnv = { ...ENV, params: { cutoff: 99.5 } };
    const rng = createRng(42, 7);
    const result = spec.reduce(
      s,
      { bag: "score", threshold_key: "cutoff", flag: "passed" },
      env,
      rng.next,
    );
    assert.equal(result.flags.passed, true);
  });
});

// ---------------------------------------------------------------------------
// rng_phase_transition_v2 — integration
// ---------------------------------------------------------------------------

const rngPhaseTransitionV2: VmProgram = {
  program_id: "rng_phase_transition_v2",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_low", amount: 30 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_mid", amount: 200 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_high", amount: 800 } },
    // RNG warm-up
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_a", amount: 1 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_b", amount: 2 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_a,warmup_b", into: "discard1" } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_c", amount: 3 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_d", amount: 4 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_c,warmup_d", into: "discard2" } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_e", amount: 5 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_f", amount: 6 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_e,warmup_f", into: "discard3" } },
    // Critical selection
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "pool_low,pool_mid,pool_high", into: "chosen" } },
    // Env-driven threshold check
    { opcode_id: "contain.env_threshold", verb: "Contain", args: { bag: "chosen", threshold_key: "halt_threshold", flag: "is_high" } },
    { opcode_id: "repel.reject", verb: "Repel", args: { flag: "is_high", reason: "threshold exceeded — halting" } },
    // Completion path
    { opcode_id: "release.export", verb: "Release", args: { bag: "chosen" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "low value path complete" } },
  ],
};

describe("rng_phase_transition_v2 — execution", () => {
  it("halts when halt_threshold is low (all pools exceed it)", () => {
    const env: VmEnv = {
      run_seed: 4,
      world_seed: 7,
      max_steps: 10000,
      params: { halt_threshold: 10 },
    };
    const result = execute(rngPhaseTransitionV2, emptyState(), env);
    // pool_low=30 >= 10, so even pool_low triggers halt
    assert.equal(result.metrics.halted_early, true);
  });

  it("completes when halt_threshold is very high (no pool exceeds it)", () => {
    const env: VmEnv = {
      run_seed: 4,
      world_seed: 7,
      max_steps: 10000,
      params: { halt_threshold: 1000 },
    };
    const result = execute(rngPhaseTransitionV2, emptyState(), env);
    // All pools < 1000, so nothing triggers halt
    assert.equal(result.metrics.halted_early, false);
  });

  it("threshold between pool_low and pool_mid creates mixed regimes", () => {
    // halt_threshold=100: pool_low(30) < 100 passes, pool_mid(200) >= 100 halts
    const halted: boolean[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const env: VmEnv = {
        run_seed: seed,
        world_seed: 7,
        max_steps: 10000,
        params: { halt_threshold: 100 },
      };
      const result = execute(rngPhaseTransitionV2, emptyState(), env);
      halted.push(result.metrics.halted_early);
    }
    const haltCount = halted.filter(Boolean).length;
    const passCount = halted.filter((h) => !h).length;
    // Both regimes should be represented
    assert.ok(haltCount > 0, `Expected some halts, got ${haltCount}`);
    assert.ok(passCount > 0, `Expected some passes, got ${passCount}`);
  });
});

// ---------------------------------------------------------------------------
// rng_phase_transition_v2 — adaptive scan
// ---------------------------------------------------------------------------

describe("rng_phase_transition_v2 — adaptive scan", () => {
  it("adaptive scan with float halt_threshold produces refinements", () => {
    const result = scanPhases({
      program: rngPhaseTransitionV2,
      state0: emptyState(),
      base_env: { run_seed: 4, world_seed: 7, max_steps: 10000 },
      knobs: [
        { key: "halt_threshold", values: [10.5, 100.5, 500.5, 900.5] },
      ],
      options: { softHalt: true },
      scan_mode: "adaptive",
      adaptive: { max_refinements: 3, max_total_runs: 20 },
    });

    assert.ok(result.adaptive);
    // Float knob is refinable → should produce refinements around boundaries
    assert.ok(
      result.adaptive!.refinements.length > 0,
      `Expected refinements > 0, got ${result.adaptive!.refinements.length}`,
    );
    assert.ok(
      result.adaptive!.all_points.length > 4,
      `Expected more than 4 coarse points, got ${result.adaptive!.all_points.length}`,
    );
  });

  it("produces phase hints in adaptive result", () => {
    const result = scanPhases({
      program: rngPhaseTransitionV2,
      state0: emptyState(),
      base_env: { run_seed: 4, world_seed: 7, max_steps: 10000 },
      knobs: [
        { key: "halt_threshold", values: [10.5, 100.5, 500.5, 900.5] },
      ],
      options: { softHalt: true },
      scan_mode: "adaptive",
      adaptive: { max_refinements: 2, max_total_runs: 15 },
    });

    assert.ok(result.adaptive);
    assert.ok(
      result.adaptive!.all_hints.length > 0,
      `Expected hints > 0, got ${result.adaptive!.all_hints.length}`,
    );
  });

  it("adaptive scan is deterministic", () => {
    const def = {
      program: rngPhaseTransitionV2,
      state0: emptyState(),
      base_env: { run_seed: 4, world_seed: 7, max_steps: 10000 } as VmEnv,
      knobs: [
        { key: "halt_threshold", values: [10.5, 100.5, 500.5, 900.5] },
      ] as Knob[],
      options: { softHalt: true } as const,
      scan_mode: "adaptive" as const,
      adaptive: { max_refinements: 2, max_total_runs: 15 },
    };

    const r1 = scanPhases(def);
    const r2 = scanPhases(def);

    assert.ok(r1.adaptive);
    assert.ok(r2.adaptive);
    assert.deepEqual(r1.adaptive!.all_points, r2.adaptive!.all_points);
    assert.deepEqual(r1.adaptive!.all_hints, r2.adaptive!.all_hints);
    assert.deepEqual(r1.adaptive!.refinements, r2.adaptive!.refinements);
  });
});

// ---------------------------------------------------------------------------
// Golden fixture
// ---------------------------------------------------------------------------

describe("rng_phase_transition_v2 — golden fixture", () => {
  it("adaptive scan matches frozen output", () => {
    const result = scanPhases({
      program: rngPhaseTransitionV2,
      state0: emptyState(),
      base_env: { run_seed: 4, world_seed: 7, max_steps: 10000 },
      knobs: [
        { key: "halt_threshold", values: [10.5, 100.5, 500.5, 900.5] },
      ],
      options: { softHalt: true },
      scan_mode: "adaptive",
      adaptive: { max_refinements: 2, max_total_runs: 15 },
    });

    assert.ok(result.adaptive);

    const frozen = {
      coarse_grid_size: result.scan_index.grid_size,
      coarse_hints: result.phase_hints.hints.length,
      all_points_count: result.adaptive!.all_points.length,
      all_hints_count: result.adaptive!.all_hints.length,
      refinement_rounds: result.adaptive!.refinements.length,
      point_knob_values: result.adaptive!.all_points.map((p) => p.knob_values),
      refined_dossier_entry_count: result.adaptive!.refined_dossier.entries.length,
    };

    const goldenPath = "tests/fixtures/golden-env-threshold-adaptive.json";
    if (!existsSync(goldenPath)) {
      writeFileSync(goldenPath, JSON.stringify(frozen, null, 2) + "\n");
      console.log("  [golden fixture written — re-run to verify]");
      return;
    }

    const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
    assert.deepEqual(frozen, golden);
  });
});
