import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCases,
  runBattery,
  TIERS,
  budgetAllocator,
  filterPipeline,
  provenanceCompiler,
  rngPhaseTransitionV2,
} from "../scripts/corpus_battery.mjs";

// ---------------------------------------------------------------------------
// Case builder
// ---------------------------------------------------------------------------

describe("Corpus Battery — buildCases", () => {
  it("tiny tier produces 10 cases", () => {
    const cases = buildCases("tiny");
    assert.equal(cases.length, 10);
  });

  it("case names are unique", () => {
    const cases = buildCases("tiny");
    const names = cases.map((c: any) => c.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("expected case names present", () => {
    const cases = buildCases("tiny");
    const names = cases.map((c: any) => c.name);
    assert.ok(names.includes("rng_v2_seed"));
    assert.ok(names.includes("rng_v2_threshold"));
    assert.ok(names.includes("rng_v2_mixed"));
    assert.ok(names.includes("budget_steps"));
    assert.ok(names.includes("filter_control"));
    assert.ok(names.includes("provenance_control"));
    assert.ok(names.includes("rng_v2_threshold_wide"));
    assert.ok(names.includes("budget_multiseed"));
    assert.ok(names.includes("rng_v2_low_threshold"));
    assert.ok(names.includes("rng_v2_boundary_hunt"));
  });

  it("rng_v2_threshold uses adaptive mode", () => {
    const cases = buildCases("tiny");
    const threshold = cases.find((c: any) => c.name === "rng_v2_threshold");
    assert.equal(threshold.scan_mode, "adaptive");
    assert.ok(threshold.adaptive);
  });

  it("float knob values are non-integer for refinability", () => {
    const cases = buildCases("tiny");
    const threshold = cases.find((c: any) => c.name === "rng_v2_threshold");
    const thresholdKnob = threshold.knobs.find((k: any) => k.key === "halt_threshold");
    assert.ok(thresholdKnob);
    for (const v of thresholdKnob.values) {
      assert.equal(Number.isInteger(v), false, `Expected non-integer, got ${v}`);
    }
  });

  it("throws on unknown tier", () => {
    assert.throws(() => buildCases("mega"), /Unknown tier/);
  });
});

// ---------------------------------------------------------------------------
// Program definitions
// ---------------------------------------------------------------------------

describe("Corpus Battery — programs", () => {
  it("all programs have program_id", () => {
    assert.ok(budgetAllocator.program_id);
    assert.ok(filterPipeline.program_id);
    assert.ok(provenanceCompiler.program_id);
    assert.ok(rngPhaseTransitionV2.program_id);
  });

  it("programs have correct opcode counts", () => {
    assert.equal(budgetAllocator.opcodes.length, 12);
    assert.equal(filterPipeline.opcodes.length, 7);
    assert.equal(provenanceCompiler.opcodes.length, 9);
    assert.equal(rngPhaseTransitionV2.opcodes.length, 17);
  });

  it("rng_v2 uses contain.env_threshold", () => {
    const hasEnvThreshold = rngPhaseTransitionV2.opcodes.some(
      (op: any) => op.opcode_id === "contain.env_threshold",
    );
    assert.ok(hasEnvThreshold, "rng_v2 should use contain.env_threshold");
  });
});

// ---------------------------------------------------------------------------
// Full battery run (tiny tier)
// ---------------------------------------------------------------------------

describe("Corpus Battery — tiny run", () => {
  let results: any[];

  it("completes all 10 cases", () => {
    results = runBattery("tiny", { quiet: true });
    assert.equal(results.length, 10);
  });

  it("all cases produce scan artifacts on disk", () => {
    assert.ok(results, "Battery must run first");
    for (const r of results) {
      const dir = r.scanDir;
      assert.ok(existsSync(join(dir, "SCAN_INDEX.json")), `Missing SCAN_INDEX.json in ${r.name}`);
      assert.ok(existsSync(join(dir, "PHASE_HINTS.json")), `Missing PHASE_HINTS.json in ${r.name}`);
      assert.ok(existsSync(join(dir, "FORMALIZED_DOSSIER.json")), `Missing FORMALIZED_DOSSIER.json in ${r.name}`);
      assert.ok(existsSync(join(dir, "TRANSITION_DOSSIER.json")), `Missing TRANSITION_DOSSIER.json in ${r.name}`);
      assert.ok(existsSync(join(dir, "PHASE_TRANSITION_REPORT.md")), `Missing REPORT.md in ${r.name}`);
      assert.ok(existsSync(join(dir, "PHASE_TRANSITION_REPORT.json")), `Missing REPORT.json in ${r.name}`);
      assert.ok(existsSync(join(dir, "PHASE_TRANSITION_REPORT.csv")), `Missing REPORT.csv in ${r.name}`);
    }
  });

  it("rng_v2 cases produce phase hints", () => {
    assert.ok(results);
    for (const name of ["rng_v2_seed", "rng_v2_threshold", "rng_v2_mixed"]) {
      const r = results.find((r: any) => r.name === name);
      assert.ok(r, `Missing case ${name}`);
      assert.ok(r.hints > 0, `${name}: expected hints > 0, got ${r.hints}`);
    }
  });

  it("control cases produce 0 phase hints", () => {
    assert.ok(results);
    for (const name of ["filter_control", "provenance_control"]) {
      const r = results.find((r: any) => r.name === name);
      assert.ok(r, `Missing case ${name}`);
      assert.equal(r.hints, 0, `${name}: expected 0 hints, got ${r.hints}`);
    }
  });

  it("budget_steps has both halted and completed runs", () => {
    assert.ok(results);
    const r = results.find((r: any) => r.name === "budget_steps");
    assert.ok(r);
    assert.ok(r.halted > 0, `Expected some halted runs, got ${r.halted}`);
    assert.ok(r.completed > 0, `Expected some completed runs, got ${r.completed}`);
  });

  it("rng_v2_threshold uses adaptive mode with refinements", () => {
    assert.ok(results);
    const r = results.find((r: any) => r.name === "rng_v2_threshold");
    assert.ok(r);
    assert.ok(r.adaptive, "Expected adaptive result");
    assert.ok(r.adaptive.refinements > 0, `Expected refinements > 0, got ${r.adaptive.refinements}`);
    assert.ok(
      r.adaptive.total_points > r.grid_size,
      `Expected total_points (${r.adaptive.total_points}) > grid_size (${r.grid_size})`,
    );
  });

  it("rng_v2_threshold produces PHASE_SCAN_REFINED.json", () => {
    assert.ok(results);
    const r = results.find((r: any) => r.name === "rng_v2_threshold");
    assert.ok(r);
    assert.ok(
      existsSync(join(r.scanDir, "PHASE_SCAN_REFINED.json")),
      "Adaptive case should produce PHASE_SCAN_REFINED.json",
    );
  });

  it("all cases produce SCAN_SIGNATURE.json", () => {
    assert.ok(results, "Battery must run first");
    for (const r of results) {
      assert.ok(
        existsSync(join(r.scanDir, "SCAN_SIGNATURE.json")),
        `Missing SCAN_SIGNATURE.json in ${r.name}`,
      );
    }
  });

  it("rng_v2_threshold_wide uses adaptive mode with refinements", () => {
    assert.ok(results);
    const r = results.find((r: any) => r.name === "rng_v2_threshold_wide");
    assert.ok(r, "Missing rng_v2_threshold_wide");
    assert.ok(r.adaptive, "Expected adaptive result");
    assert.ok(
      r.adaptive.refinements > 0,
      `Expected refinements > 0, got ${r.adaptive.refinements}`,
    );
  });

  it("budget_multiseed has both halted and completed runs", () => {
    assert.ok(results);
    const r = results.find((r: any) => r.name === "budget_multiseed");
    assert.ok(r, "Missing budget_multiseed");
    assert.ok(r.halted > 0, `Expected some halted runs, got ${r.halted}`);
    assert.ok(r.completed > 0, `Expected some completed runs, got ${r.completed}`);
  });

  it("rng_v2_low_threshold has mostly halted runs", () => {
    assert.ok(results);
    const r = results.find((r: any) => r.name === "rng_v2_low_threshold");
    assert.ok(r, "Missing rng_v2_low_threshold");
    assert.ok(r.halted > 0, `Expected halted runs, got ${r.halted}`);
  });

  it("rng_v2_boundary_hunt produces BOUNDARY_HUNT.json", () => {
    assert.ok(results);
    const r = results.find((r: any) => r.name === "rng_v2_boundary_hunt");
    assert.ok(r, "Missing rng_v2_boundary_hunt");
    assert.ok(
      existsSync(join(r.scanDir, "BOUNDARY_HUNT.json")),
      "Boundary hunt case should produce BOUNDARY_HUNT.json",
    );
  });

  it("report JSON has correct program_id for each case", () => {
    assert.ok(results);
    for (const r of results) {
      const reportJson = JSON.parse(
        readFileSync(join(r.scanDir, "PHASE_TRANSITION_REPORT.json"), "utf-8"),
      );
      assert.equal(reportJson.meta.program_id, r.program_id);
    }
  });

  it("report CSV row count matches grid_size", () => {
    assert.ok(results);
    for (const r of results) {
      const csv = readFileSync(join(r.scanDir, "PHASE_TRANSITION_REPORT.csv"), "utf-8");
      const lines = csv.trim().split("\n");
      assert.equal(
        lines.length,
        r.grid_size + 1,
        `${r.name}: CSV rows (${lines.length}) should be grid_size+1 (${r.grid_size + 1})`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("Corpus Battery — determinism", () => {
  it("two tiny runs produce identical scan hashes", () => {
    const r1 = runBattery("tiny", { quiet: true });
    const r2 = runBattery("tiny", { quiet: true });

    assert.equal(r1.length, r2.length);
    for (let i = 0; i < r1.length; i++) {
      assert.equal(
        r1[i].scan_hash,
        r2[i].scan_hash,
        `Case ${r1[i].name}: scan hashes differ`,
      );
      assert.equal(r1[i].hints, r2[i].hints, `Case ${r1[i].name}: hint counts differ`);
      assert.equal(r1[i].halted, r2[i].halted, `Case ${r1[i].name}: halted counts differ`);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden fixture
// ---------------------------------------------------------------------------

describe("Corpus Battery — golden fixture", () => {
  it("rng_v2_seed report matches frozen summary", () => {
    const results = runBattery("tiny", { quiet: true });
    const r = results.find((r: any) => r.name === "rng_v2_seed");
    assert.ok(r);

    const frozen = {
      name: r.name,
      scan_hash: r.scan_hash,
      program_id: r.program_id,
      grid_size: r.grid_size,
      hints: r.hints,
      halted: r.halted,
      completed: r.completed,
    };

    const goldenPath = "tests/fixtures/golden-battery-rng-v2-seed.json";
    if (!existsSync(goldenPath)) {
      writeFileSync(goldenPath, JSON.stringify(frozen, null, 2) + "\n");
      console.log("  [golden fixture written — re-run to verify]");
      return;
    }

    const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
    assert.deepEqual(frozen, golden);
  });
});
