import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { scanPhases } from "../src/kb/vm_phase_scan.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import { buildScanSignature } from "../src/kb/vm_scan_signature.js";
import type { ScanSignature } from "../src/kb/vm_scan_signature.js";
import { classifyRegime } from "../src/kb/vm_regime.js";

// ---------------------------------------------------------------------------
// Test programs
// ---------------------------------------------------------------------------

const rngPhaseTransition: VmProgram = {
  program_id: "rng_phase_transition",
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
    { opcode_id: "contain.threshold", verb: "Contain", args: { bag: "chosen", threshold: 100, flag: "is_high" } },
    { opcode_id: "repel.reject", verb: "Repel", args: { flag: "is_high", reason: "high value selected — halting" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "chosen" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "low value path complete" } },
  ],
};

const controlProgram: VmProgram = {
  program_id: "always_completes",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 10 } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "done" } },
  ],
};

const BASE_ENV: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000 };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function buildSignature(program: VmProgram, knobs: { key: string; values: number[] }[]): ScanSignature {
  const result = scanPhases({ program, state0: emptyState(), base_env: BASE_ENV, knobs });
  const si = result.scan_index;
  const points = si.points;
  const halted = points.filter((p) => p.metrics.halted_early).length;
  const total = points.length;
  const haltFraction = total > 0
    ? Math.round((halted / total) * 10000) / 10000
    : 0;

  const knobTypes = si.knobs.map((k) => {
    const vals = k.values;
    if (vals.length === 0) return "unknown";
    if (vals.every((v: any) => typeof v === "number")) {
      return (vals as number[]).some((v) => !Number.isInteger(v)) ? "float" : "integer";
    }
    return typeof vals[0];
  });

  const reportModel = {
    meta: { scan_hash: si.scan_hash, program_id: si.program_id },
    summary: {
      grid_size: si.grid_size,
      total_hints: result.phase_hints.hints.length,
      knobs: si.knobs.map((k, i) => ({ name: k.key, type: knobTypes[i] })),
      adaptive_refinements: result.adaptive
        ? result.adaptive.refinements.length
        : null,
    },
    regime_proportions: {
      halted,
      completed: total - halted,
      halt_fraction: haltFraction,
    },
    grid_points: points.map((p) => ({
      final_bag_sum: p.metrics.final_bag_sum,
      regime_class: classifyRegime(p.metrics),
    })),
  };

  return buildScanSignature(reportModel, result.formalized_dossier);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Scan Signature — structure", () => {
  it("has correct schema_version", () => {
    const sig = buildSignature(rngPhaseTransition, [{ key: "run_seed", values: [1, 2, 3] }]);
    assert.equal(sig.schema_version, "scan_signature.v1");
  });

  it("has correct program_id and scan_id", () => {
    const sig = buildSignature(rngPhaseTransition, [{ key: "run_seed", values: [1, 2, 3] }]);
    assert.equal(sig.program_id, "rng_phase_transition");
    assert.ok(sig.scan_id.length === 64, "scan_id should be full hash");
  });

  it("knob_summary reflects input knobs", () => {
    const sig = buildSignature(rngPhaseTransition, [{ key: "run_seed", values: [1, 2, 3] }]);
    assert.deepEqual(sig.knob_summary.names, ["run_seed"]);
    assert.deepEqual(sig.knob_summary.types, ["integer"]);
  });
});

describe("Scan Signature — rng scan (with transitions)", () => {
  it("transition_density > 0", () => {
    const sig = buildSignature(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);
    assert.ok(sig.transition_stats.transition_density > 0);
  });

  it("opcode_signature is non-empty", () => {
    const sig = buildSignature(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);
    assert.ok(sig.opcode_signature.length > 0);
  });

  it("metrics_signature is non-empty", () => {
    const sig = buildSignature(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);
    assert.ok(sig.metrics_signature.length > 0);
  });

  it("opcode_signature weights sum to ~1", () => {
    const sig = buildSignature(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);
    if (sig.opcode_signature.length > 0) {
      const sum = sig.opcode_signature.reduce((s, e) => s + e.weight, 0);
      assert.ok(Math.abs(sum - 1) < 0.01, `Opcode weights sum to ${sum}, expected ~1`);
    }
  });

  it("max_delta_magnitude >= avg_delta_magnitude", () => {
    const sig = buildSignature(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);
    assert.ok(sig.transition_stats.max_delta_magnitude >= sig.transition_stats.avg_delta_magnitude);
  });
});

describe("Scan Signature — control scan (no transitions)", () => {
  it("all transition_stats are 0", () => {
    const sig = buildSignature(controlProgram, [{ key: "run_seed", values: [1, 2, 3] }]);
    assert.equal(sig.transition_stats.transition_density, 0);
    assert.equal(sig.transition_stats.avg_delta_magnitude, 0);
    assert.equal(sig.transition_stats.max_delta_magnitude, 0);
    assert.equal(sig.transition_stats.opcode_delta_concentration, 0);
    assert.equal(sig.transition_stats.metric_cliff_score, 0);
  });

  it("empty opcode_signature and metrics_signature", () => {
    const sig = buildSignature(controlProgram, [{ key: "run_seed", values: [1, 2, 3] }]);
    assert.equal(sig.opcode_signature.length, 0);
    assert.equal(sig.metrics_signature.length, 0);
  });

  it("regime shows 0 halted", () => {
    const sig = buildSignature(controlProgram, [{ key: "run_seed", values: [1, 2, 3] }]);
    assert.equal(sig.regime.halted, 0);
    assert.equal(sig.regime.completed, 3);
    assert.equal(sig.regime.halt_fraction, 0);
  });
});

describe("Scan Signature — no NaN", () => {
  it("JSON stringified signature contains no NaN or Infinity", () => {
    const sig = buildSignature(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5] },
    ]);
    const json = JSON.stringify(sig);
    assert.ok(!json.includes("NaN"), "Signature JSON must not contain NaN");
    assert.ok(!json.includes("Infinity"), "Signature JSON must not contain Infinity");
    // adaptive_refinements: null is valid (means "not adaptive")
    // All numeric stats must be finite numbers
    const stats = sig.transition_stats;
    for (const [k, v] of Object.entries(stats)) {
      assert.ok(Number.isFinite(v), `transition_stats.${k} must be finite, got ${v}`);
    }
  });

  it("control scan JSON has no NaN", () => {
    const sig = buildSignature(controlProgram, [{ key: "run_seed", values: [1] }]);
    const json = JSON.stringify(sig);
    assert.ok(!json.includes("NaN"), "Control signature must not contain NaN");
  });
});

describe("Scan Signature — determinism", () => {
  it("two runs produce identical signature", () => {
    const knobs = [{ key: "run_seed", values: [1, 2, 3, 4, 5] }];
    const s1 = buildSignature(rngPhaseTransition, knobs);
    const s2 = buildSignature(rngPhaseTransition, knobs);
    assert.deepEqual(s1, s2);
  });
});

describe("Scan Signature — golden fixture", () => {
  it("matches frozen output", () => {
    const sig = buildSignature(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);

    const frozen = {
      scan_id: sig.scan_id,
      program_id: sig.program_id,
      transition_density: sig.transition_stats.transition_density,
      avg_delta_magnitude: sig.transition_stats.avg_delta_magnitude,
      max_delta_magnitude: sig.transition_stats.max_delta_magnitude,
      opcode_concentration: sig.transition_stats.opcode_delta_concentration,
      cliff_score: sig.transition_stats.metric_cliff_score,
      opcode_count: sig.opcode_signature.length,
      metric_count: sig.metrics_signature.length,
      halted: sig.regime.halted,
      completed: sig.regime.completed,
    };

    const goldenPath = "tests/fixtures/golden-scan-signature.json";
    if (!existsSync(goldenPath)) {
      writeFileSync(goldenPath, JSON.stringify(frozen, null, 2) + "\n");
      console.log("  [golden fixture written — re-run to verify]");
      return;
    }

    const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
    assert.deepEqual(frozen, golden);
  });
});
