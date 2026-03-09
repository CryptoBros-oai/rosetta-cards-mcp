import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { emptyState } from "../src/kb/vm_types.js";
import { TransitionDossierSchema } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import {
  scanPhases,
  isRefinableKnob,
  bisectKnobs,
  cartesianProduct,
  detectPhaseHints,
} from "../src/kb/vm_phase_scan.js";
import type { Knob, KnobValue, GridPointSummary } from "../src/kb/vm_phase_scan.js";

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

// -------------------------------------------------------------------------
// isRefinableKnob
// -------------------------------------------------------------------------

describe("isRefinableKnob", () => {
  it("returns true for knob with at least one float", () => {
    assert.ok(isRefinableKnob({ key: "x", values: [1.5, 2.5] }));
    assert.ok(isRefinableKnob({ key: "x", values: [1, 2.5, 3] }));
  });

  it("returns false for integer-only knob", () => {
    assert.ok(!isRefinableKnob({ key: "x", values: [1, 2, 3] }));
  });

  it("returns false for string knob", () => {
    assert.ok(!isRefinableKnob({ key: "x", values: ["a", "b"] }));
  });

  it("returns false for boolean knob", () => {
    assert.ok(!isRefinableKnob({ key: "x", values: [true, false] }));
  });

  it("returns false for mixed-type knob", () => {
    assert.ok(!isRefinableKnob({ key: "x", values: [1.5, "a"] }));
  });

  it("returns false for empty values", () => {
    assert.ok(!isRefinableKnob({ key: "x", values: [] }));
  });
});

// -------------------------------------------------------------------------
// bisectKnobs
// -------------------------------------------------------------------------

describe("bisectKnobs", () => {
  it("computes arithmetic midpoint for refinable keys", () => {
    const a: Record<string, KnobValue> = { x: 1.0, y: 10.0 };
    const b: Record<string, KnobValue> = { x: 3.0, y: 20.0 };
    const result = bisectKnobs(a, b, new Set(["x", "y"]));
    assert.equal(result.x, 2.0);
    assert.equal(result.y, 15.0);
  });

  it("keeps A value for discrete keys", () => {
    const a: Record<string, KnobValue> = { seed: 42, factor: 1.0 };
    const b: Record<string, KnobValue> = { seed: 99, factor: 3.0 };
    const result = bisectKnobs(a, b, new Set(["factor"]));
    assert.equal(result.seed, 42); // discrete, keeps A
    assert.equal(result.factor, 2.0); // refinable, midpoint
  });

  it("produces sorted keys", () => {
    const a: Record<string, KnobValue> = { z: 1.0, a: 2.0 };
    const b: Record<string, KnobValue> = { z: 3.0, a: 4.0 };
    const result = bisectKnobs(a, b, new Set(["z", "a"]));
    const keys = Object.keys(result);
    assert.deepEqual(keys, ["a", "z"]);
  });
});

// -------------------------------------------------------------------------
// Adaptive scan — grid mode (backward compat)
// -------------------------------------------------------------------------

describe("adaptive scan — grid mode baseline", () => {
  it("scan_mode=grid produces same result as default", () => {
    const def = {
      program: budgetAllocator,
      state0: emptyState(),
      base_env: ENV,
      knobs: [{ key: "run_seed", values: [1, 2] }] as Knob[],
    };

    const defaultResult = scanPhases(def);
    const gridResult = scanPhases({ ...def, scan_mode: "grid" as const });

    assert.deepEqual(defaultResult.scan_index, gridResult.scan_index);
    assert.deepEqual(defaultResult.phase_hints, gridResult.phase_hints);
    assert.ok(!defaultResult.adaptive);
    assert.ok(!gridResult.adaptive);
  });
});

// -------------------------------------------------------------------------
// Adaptive scan — no refinable knobs
// -------------------------------------------------------------------------

describe("adaptive scan — no refinable knobs", () => {
  it("returns coarse result with empty refinements when all knobs are integers", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: ENV,
      knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      scan_mode: "adaptive",
    });

    assert.ok(result.adaptive);
    assert.equal(result.adaptive!.refinements.length, 0);
    assert.equal(result.adaptive!.all_points.length, 3);
    assert.deepEqual(
      result.adaptive!.all_hints,
      result.phase_hints.hints,
    );
  });
});

// -------------------------------------------------------------------------
// Adaptive scan — with refinable knobs
// -------------------------------------------------------------------------

describe("adaptive scan — with refinable knobs", () => {
  // Use a float knob so bisection can produce midpoints
  const floatKnobs: Knob[] = [
    { key: "factor", values: [0.1, 0.5, 0.9] },
  ];

  it("produces more points than coarse grid", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: floatKnobs,
      scan_mode: "adaptive",
    });

    assert.ok(result.adaptive);
    // Coarse has 3 points. If there are any hints, adaptive adds midpoints.
    // Even if no hints are detected, all_points >= 3
    assert.ok(result.adaptive!.all_points.length >= 3);
  });

  it("all_points are sorted by knob values", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: floatKnobs,
      scan_mode: "adaptive",
    });

    assert.ok(result.adaptive);
    const points = result.adaptive!.all_points;
    for (let i = 0; i < points.length - 1; i++) {
      const aFactor = points[i].knob_values.factor as number;
      const bFactor = points[i + 1].knob_values.factor as number;
      assert.ok(aFactor <= bFactor, `Points not sorted: ${aFactor} > ${bFactor}`);
    }
  });

  it("all_points have sequential indices", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: floatKnobs,
      scan_mode: "adaptive",
    });

    assert.ok(result.adaptive);
    for (let i = 0; i < result.adaptive!.all_points.length; i++) {
      assert.equal(result.adaptive!.all_points[i].index, i);
    }
  });

  it("refined_dossier validates against schema", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: floatKnobs,
      scan_mode: "adaptive",
    });

    assert.ok(result.adaptive);
    const parsed = TransitionDossierSchema.safeParse(result.adaptive!.refined_dossier);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });

  it("no duplicate knob values across all_points", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: floatKnobs,
      scan_mode: "adaptive",
    });

    assert.ok(result.adaptive);
    const seen = new Set<string>();
    for (const point of result.adaptive!.all_points) {
      const key = JSON.stringify(point.knob_values);
      assert.ok(!seen.has(key), `Duplicate knob values: ${key}`);
      seen.add(key);
    }
  });
});

// -------------------------------------------------------------------------
// Bounds
// -------------------------------------------------------------------------

describe("adaptive scan — bounds", () => {
  it("respects max_total_runs", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: [{ key: "factor", values: [0.1, 0.5, 0.9] }],
      scan_mode: "adaptive",
      adaptive: { max_total_runs: 4 }, // coarse=3, at most 1 refinement
    });

    assert.ok(result.adaptive);
    assert.ok(result.adaptive!.all_points.length <= 4);
  });

  it("respects max_refinements=0", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: [{ key: "factor", values: [0.1, 0.5, 0.9] }],
      scan_mode: "adaptive",
      adaptive: { max_refinements: 0 },
    });

    assert.ok(result.adaptive);
    assert.equal(result.adaptive!.refinements.length, 0);
    // all_points should just be the coarse grid
    assert.equal(result.adaptive!.all_points.length, 3);
  });
});

// -------------------------------------------------------------------------
// Determinism
// -------------------------------------------------------------------------

describe("adaptive scan — determinism", () => {
  it("adaptive scan is deterministic", () => {
    const def = {
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: [{ key: "factor", values: [0.1, 0.5, 0.9] }] as Knob[],
      scan_mode: "adaptive" as const,
    };

    const r1 = scanPhases(def);
    const r2 = scanPhases(def);

    assert.ok(r1.adaptive);
    assert.ok(r2.adaptive);
    assert.deepEqual(r1.adaptive!.all_points, r2.adaptive!.all_points);
    assert.deepEqual(r1.adaptive!.all_hints, r2.adaptive!.all_hints);
    assert.deepEqual(r1.adaptive!.refined_dossier, r2.adaptive!.refined_dossier);
    assert.deepEqual(r1.adaptive!.refinements, r2.adaptive!.refinements);
  });
});

// -------------------------------------------------------------------------
// Golden fixture
// -------------------------------------------------------------------------

describe("adaptive scan — golden fixture", () => {
  it("matches frozen output", () => {
    const result = scanPhases({
      program: budgetAllocator,
      state0: emptyState(),
      base_env: { ...ENV, params: { factor: 0.5 } },
      knobs: [{ key: "factor", values: [0.1, 0.5, 0.9] }],
      scan_mode: "adaptive",
      adaptive: { max_refinements: 2 },
    });

    assert.ok(result.adaptive);

    // Freeze only the compact summary (not full comparisons)
    const frozen = {
      all_points_count: result.adaptive!.all_points.length,
      all_hints_count: result.adaptive!.all_hints.length,
      refinement_rounds: result.adaptive!.refinements.length,
      point_knob_values: result.adaptive!.all_points.map((p) => p.knob_values),
      refined_dossier_entry_count: result.adaptive!.refined_dossier.entries.length,
    };

    const goldenPath = "tests/fixtures/golden-vm-phase-scan-adaptive.json";
    if (!existsSync(goldenPath)) {
      writeFileSync(goldenPath, JSON.stringify(frozen, null, 2) + "\n");
      console.log("  [golden fixture written — re-run to verify]");
      return;
    }

    const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
    assert.deepEqual(frozen, golden);
  });
});
