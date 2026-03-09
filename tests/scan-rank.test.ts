import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanPhases } from "../src/kb/vm_phase_scan.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv, TransitionDossierEntry } from "../src/kb/vm_types.js";
import { classifyRegime } from "../src/kb/vm_regime.js";
import { buildScanSignature } from "../src/kb/vm_scan_signature.js";
import type { ScanSignature } from "../src/kb/vm_scan_signature.js";
import {
  scoreScan,
  scoreTransition,
  buildTopScans,
  buildTopTransitions,
  W_TRANSITION_DENSITY,
  W_METRIC_CLIFF,
  W_MAX_DELTA,
  W_OPCODE_CONCENTRATION,
  W_ADAPTIVE_BONUS,
} from "../src/kb/vm_scan_rank.js";

// ---------------------------------------------------------------------------
// Test programs
// ---------------------------------------------------------------------------

const rngPhaseTransitionV2: VmProgram = {
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
// Helpers
// ---------------------------------------------------------------------------

function buildSigFromScan(
  program: VmProgram,
  env: VmEnv,
  knobs: Array<{ key: string; values: any[] }>,
  opts?: any,
) {
  const result = scanPhases({
    program,
    state0: emptyState(),
    base_env: env,
    knobs,
    options: opts?.options,
    scan_mode: opts?.scan_mode,
    adaptive: opts?.adaptive,
  });

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

  const miniReportModel = {
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

  return buildScanSignature(miniReportModel, result.formalized_dossier);
}

function makeZeroSignature(): ScanSignature {
  return {
    schema_version: "scan_signature.v1",
    scan_id: "zero_scan_id",
    program_id: "zero_program",
    knob_summary: { names: [], types: [] },
    counts: {
      grid_points: 0,
      phase_hints: 0,
      dossier_entries: 0,
      adaptive_refinements: null,
    },
    regime: { halted: 0, completed: 0, halt_fraction: 0 },
    transition_stats: {
      transition_density: 0,
      avg_delta_magnitude: 0,
      max_delta_magnitude: 0,
      opcode_delta_concentration: 0,
      metric_cliff_score: 0,
    },
    opcode_signature: [],
    metrics_signature: [],
    regime_classes: [],
    regime_distribution: [],
  };
}

// ---------------------------------------------------------------------------
// scoreScan
// ---------------------------------------------------------------------------

describe("Scan Rank — scoreScan", () => {
  it("returns 0 for zero-valued signature", () => {
    const sig = makeZeroSignature();
    const result = scoreScan(sig);
    assert.equal(result.score, 0);
    assert.equal(result.breakdown.density, 0);
    assert.equal(result.breakdown.cliff, 0);
    assert.equal(result.breakdown.max_delta, 0);
    assert.equal(result.breakdown.concentration, 0);
    assert.equal(result.breakdown.noise, 0);
    assert.equal(result.breakdown.adaptive, 0);
  });

  it("returns positive score for scan with transitions", () => {
    const sig = buildSigFromScan(
      rngPhaseTransitionV2,
      { ...BASE_ENV, params: { halt_threshold: 100 } },
      [{ key: "run_seed", values: [1, 2, 3, 4, 5] }],
      { options: { softHalt: true } },
    );
    const result = scoreScan(sig);
    assert.ok(result.score > 0, `Expected positive score, got ${result.score}`);
  });

  it("higher transition_density → higher score", () => {
    // Dense scan: lots of phase hints relative to grid
    const sigDense = buildSigFromScan(
      rngPhaseTransitionV2,
      { ...BASE_ENV, params: { halt_threshold: 100 } },
      [{ key: "run_seed", values: [1, 2, 3, 4, 5] }],
      { options: { softHalt: true } },
    );

    // Sparse scan: control program with no transitions
    const sigSparse = buildSigFromScan(
      controlProgram,
      BASE_ENV,
      [{ key: "run_seed", values: [1, 2, 3] }],
    );

    const scoreDense = scoreScan(sigDense);
    const scoreSparse = scoreScan(sigSparse);

    assert.ok(
      scoreDense.score > scoreSparse.score,
      `Dense (${scoreDense.score}) should beat sparse (${scoreSparse.score})`,
    );
  });

  it("higher cliff_score → higher score", () => {
    const sig = makeZeroSignature();
    sig.scan_id = "low_cliff";
    const lowCliff = { ...sig, transition_stats: { ...sig.transition_stats, metric_cliff_score: 0.1 } };
    const highCliff = { ...sig, scan_id: "high_cliff", transition_stats: { ...sig.transition_stats, metric_cliff_score: 2.0 } };

    assert.ok(scoreScan(highCliff).score > scoreScan(lowCliff).score);
  });

  it("adaptive bonus applied when adaptive_refinements > 0", () => {
    const base = makeZeroSignature();
    base.transition_stats = {
      transition_density: 0.5,
      avg_delta_magnitude: 10,
      max_delta_magnitude: 50,
      opcode_delta_concentration: 0.6,
      metric_cliff_score: 1.0,
    };

    const noAdaptive = { ...base, scan_id: "no_adaptive" };
    const withAdaptive = {
      ...base,
      scan_id: "with_adaptive",
      counts: { ...base.counts, adaptive_refinements: 3 },
    };

    const scoreNo = scoreScan(noAdaptive);
    const scoreYes = scoreScan(withAdaptive);

    assert.equal(
      scoreYes.score - scoreNo.score,
      W_ADAPTIVE_BONUS,
      "Adaptive bonus should be exactly W_ADAPTIVE_BONUS",
    );
  });

  it("control scans rank lower than transition scans", () => {
    // Use threshold knobs to trigger actual phase transitions
    const rngSig = buildSigFromScan(
      rngPhaseTransitionV2,
      BASE_ENV,
      [{ key: "halt_threshold", values: [10.5, 100.5, 500.5, 900.5] }],
      { options: { softHalt: true } },
    );

    const ctrlSig = buildSigFromScan(
      controlProgram,
      BASE_ENV,
      [{ key: "run_seed", values: [1, 2, 3] }],
    );

    assert.ok(
      rngSig.counts.phase_hints > 0,
      `RNG scan should have hints, got ${rngSig.counts.phase_hints}`,
    );
    assert.ok(
      scoreScan(rngSig).score > scoreScan(ctrlSig).score,
      "RNG scan should rank higher than control scan",
    );
  });

  it("deterministic: two runs produce identical scores", () => {
    const sig1 = buildSigFromScan(
      rngPhaseTransitionV2,
      { ...BASE_ENV, params: { halt_threshold: 100 } },
      [{ key: "run_seed", values: [1, 2, 3] }],
      { options: { softHalt: true } },
    );
    const sig2 = buildSigFromScan(
      rngPhaseTransitionV2,
      { ...BASE_ENV, params: { halt_threshold: 100 } },
      [{ key: "run_seed", values: [1, 2, 3] }],
      { options: { softHalt: true } },
    );

    assert.equal(scoreScan(sig1).score, scoreScan(sig2).score);
  });
});

// ---------------------------------------------------------------------------
// scoreTransition
// ---------------------------------------------------------------------------

describe("Scan Rank — scoreTransition", () => {
  it("returns 0 for empty transition", () => {
    const entry: TransitionDossierEntry = {
      candidate_id: "test",
      hint_type: "zero_crossing",
      hint_evidence: { metric: "test", a_value: 0, b_value: 0, detail: "" },
      run_a_id: "a",
      run_b_id: "b",
      compare_hash: "abc",
      summary: {
        top_scalar_deltas: [],
        top_opcode_deltas: [],
      },
      paths: {},
      meta: { engine_version: "test", schema_version: "transition_dossier.v1" },
    };
    const result = scoreTransition(entry, 100);
    assert.equal(result.score, 0);
  });

  it("higher scalar deltas → higher score", () => {
    const base: TransitionDossierEntry = {
      candidate_id: "test",
      hint_type: "zero_crossing",
      hint_evidence: { metric: "test", a_value: 0, b_value: 10, detail: "" },
      run_a_id: "a",
      run_b_id: "b",
      compare_hash: "abc",
      summary: {
        top_scalar_deltas: [{ metric: "final_bag_sum", delta: 10 }],
        top_opcode_deltas: [],
      },
      paths: {},
      meta: { engine_version: "test", schema_version: "transition_dossier.v1" },
    };

    const high = {
      ...base,
      summary: {
        ...base.summary,
        top_scalar_deltas: [{ metric: "final_bag_sum", delta: 1000 }],
      },
    };

    assert.ok(scoreTransition(high, 100).score > scoreTransition(base, 100).score);
  });
});

// ---------------------------------------------------------------------------
// buildTopScans
// ---------------------------------------------------------------------------

describe("Scan Rank — buildTopScans", () => {
  it("respects limit parameter", () => {
    const sigs: ScanSignature[] = [];
    for (let i = 0; i < 5; i++) {
      const sig = makeZeroSignature();
      sig.scan_id = `scan_${i}`;
      sig.transition_stats = {
        ...sig.transition_stats,
        transition_density: (i + 1) * 0.1,
      };
      sigs.push(sig);
    }

    const result = buildTopScans(sigs, 3);
    assert.equal(result.scans.length, 3);
    assert.equal(result.total, 5);
  });

  it("sorts by score descending", () => {
    const sigs: ScanSignature[] = [];
    for (let i = 0; i < 4; i++) {
      const sig = makeZeroSignature();
      sig.scan_id = `scan_${i}`;
      sig.transition_stats = {
        ...sig.transition_stats,
        transition_density: (i + 1) * 0.1,
      };
      sigs.push(sig);
    }

    const result = buildTopScans(sigs);
    for (let i = 1; i < result.scans.length; i++) {
      assert.ok(
        result.scans[i - 1].score >= result.scans[i].score,
        `Score ${result.scans[i - 1].score} should >= ${result.scans[i].score}`,
      );
    }
  });

  it("tiebreaks by scan_id lexicographic", () => {
    const sigA = makeZeroSignature();
    sigA.scan_id = "aaa";
    const sigB = makeZeroSignature();
    sigB.scan_id = "bbb";

    // Both have score 0
    const result = buildTopScans([sigB, sigA]);
    assert.equal(result.scans[0].scan_id, "aaa");
    assert.equal(result.scans[1].scan_id, "bbb");
  });

  it("ranks transition scans above control scans from real data", () => {
    // Use threshold knobs to trigger actual phase transitions
    const rngSig = buildSigFromScan(
      rngPhaseTransitionV2,
      BASE_ENV,
      [{ key: "halt_threshold", values: [10.5, 100.5, 500.5, 900.5] }],
      { options: { softHalt: true } },
    );

    const ctrlSig = buildSigFromScan(
      controlProgram,
      BASE_ENV,
      [{ key: "run_seed", values: [1, 2, 3] }],
    );

    const result = buildTopScans([ctrlSig, rngSig]);
    assert.equal(result.scans[0].scan_id, rngSig.scan_id, "RNG scan should be #1");
  });
});

// ---------------------------------------------------------------------------
// buildTopTransitions
// ---------------------------------------------------------------------------

describe("Scan Rank — buildTopTransitions", () => {
  it("respects limit parameter", () => {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push({
        entry: {
          candidate_id: `trans_${i}`,
          hint_type: "zero_crossing" as const,
          hint_evidence: { metric: "test", a_value: 0, b_value: i * 10, detail: "" },
          run_a_id: "a",
          run_b_id: "b",
          compare_hash: "abc",
          summary: {
            top_scalar_deltas: [{ metric: "final_bag_sum", delta: i * 10 }],
            top_opcode_deltas: [],
          },
          paths: {},
          meta: { engine_version: "test", schema_version: "transition_dossier.v1" as const },
        },
        scan_id: "test_scan",
        meanBagSum: 100,
      });
    }

    const result = buildTopTransitions(entries, 3);
    assert.equal(result.transitions.length, 3);
    assert.equal(result.total, 5);
  });
});
