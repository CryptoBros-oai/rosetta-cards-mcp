import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { scanPhases } from "../src/kb/vm_phase_scan.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import {
  buildReportModel,
  generateMarkdown,
  generateJSON,
  generateCSV,
} from "../scripts/make_phase_transition_report.mjs";

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

// Simple program that never halts — no transitions expected
const noTransitionProgram: VmProgram = {
  program_id: "always_completes",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 10 } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "done" } },
  ],
};

const BASE_ENV: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000 };

// Fixed timestamp for deterministic tests
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Helper: run scan + build report model with fixed timestamp
// ---------------------------------------------------------------------------

function buildReport(program: VmProgram, knobs: { key: string; values: number[] }[]) {
  const result = scanPhases({
    program,
    state0: emptyState(),
    base_env: BASE_ENV,
    knobs,
  });

  // Assemble scan data in the shape loadScanData returns
  const scanData = {
    scanIndex: result.scan_index,
    phaseHints: result.phase_hints,
    formalizedDossier: result.formalized_dossier,
    transitionDossier: result.transition_dossier,
    refined: null,
  };

  const saved = process.env.REPORT_TIMESTAMP;
  process.env.REPORT_TIMESTAMP = FIXED_TIMESTAMP;
  try {
    return buildReportModel(scanData);
  } finally {
    if (saved !== undefined) {
      process.env.REPORT_TIMESTAMP = saved;
    } else {
      delete process.env.REPORT_TIMESTAMP;
    }
  }
}

// ---------------------------------------------------------------------------
// Report model structure
// ---------------------------------------------------------------------------

describe("Phase Transition Report — model", () => {
  it("schema_version is correct", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3] },
    ]);
    assert.equal(model.schema_version, "phase_transition_report.v1");
  });

  it("meta contains scan_hash, program_id, fingerprint, engine", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3] },
    ]);
    assert.ok(model.meta.scan_hash);
    assert.ok(model.meta.scan_hash12);
    assert.equal(model.meta.scan_hash12.length, 12);
    assert.equal(model.meta.program_id, "rng_phase_transition");
    assert.ok(model.meta.program_fingerprint);
    assert.equal(model.meta.engine_version, "rks.v1");
    assert.equal(model.meta.generated_at, FIXED_TIMESTAMP);
  });

  it("summary has correct grid_size and knob metadata", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5] },
    ]);
    assert.equal(model.summary.grid_size, 5);
    assert.equal(model.summary.knobs.length, 1);
    assert.equal(model.summary.knobs[0].name, "run_seed");
    assert.equal(model.summary.knobs[0].type, "integer");
    assert.equal(model.summary.knobs[0].refinable, false);
  });

  it("regime_proportions adds up correctly", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);
    assert.equal(
      model.regime_proportions.halted + model.regime_proportions.completed,
      model.regime_proportions.total,
    );
    assert.equal(model.regime_proportions.total, 10);
    assert.ok(model.regime_proportions.halted > 0, "Expected some halts");
    assert.ok(model.regime_proportions.completed > 0, "Expected some completions");
  });

  it("grid_points has correct length and structure", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3] },
    ]);
    assert.equal(model.grid_points.length, 3);
    for (const p of model.grid_points) {
      assert.ok("index" in p);
      assert.ok("knob_values" in p);
      assert.ok("total_steps" in p);
      assert.ok("final_bag_sum" in p);
      assert.ok("halted_early" in p);
    }
  });

  it("transitions have required fields", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);
    // rng_phase_transition with 10 seeds should have some transitions
    assert.ok(model.transitions.length > 0, "Expected transitions");
    for (const t of model.transitions) {
      assert.ok(t.id, "transition must have id");
      assert.ok(t.hint_type, "transition must have hint_type");
      assert.ok(t.metric, "transition must have metric");
      assert.ok(t.mechanism, "transition must have mechanism");
      assert.ok(t.compare_hash, "transition must have compare_hash");
    }
  });

  it("mechanism text is auto-generated for sign_change on halted_early", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);
    const signChangeTransitions = model.transitions.filter(
      (t: any) => t.hint_type === "sign_change" && t.metric === "halted_early",
    );
    assert.ok(signChangeTransitions.length > 0);
    for (const t of signChangeTransitions) {
      assert.ok(
        t.mechanism.includes("halted_early to flip"),
        `Expected mechanism to mention halted_early flip, got: ${t.mechanism}`,
      );
      assert.ok(
        t.mechanism.includes("gating") || t.mechanism.includes("no opcode"),
        `Expected mechanism to mention gating, got: ${t.mechanism}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

describe("Phase Transition Report — markdown", () => {
  it("contains all required headings", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8] },
    ]);
    const md = generateMarkdown(model);

    const requiredHeadings = [
      "# Phase Transition Report",
      "## Summary",
      "## Regime Proportions",
      "## Transitions",
      "## Grid Points",
      "## Artifact Links",
    ];
    for (const heading of requiredHeadings) {
      assert.ok(
        md.includes(heading),
        `Missing heading: ${heading}`,
      );
    }
  });

  it("contains program_id in header table", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2] },
    ]);
    const md = generateMarkdown(model);
    assert.ok(md.includes("rng_phase_transition"), "MD should contain program_id");
  });

  it("grid points table has correct row count", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5] },
    ]);
    const md = generateMarkdown(model);
    // Count lines in grid points section (header + separator + 5 data rows)
    const gridSection = md.split("## Grid Points")[1].split("## Artifact Links")[0];
    const tableLines = gridSection.trim().split("\n").filter((l) => l.startsWith("|"));
    // header + separator + 5 data rows = 7
    assert.equal(tableLines.length, 7, `Expected 7 table lines, got ${tableLines.length}`);
  });

  it("no transitions section says so", () => {
    const model = buildReport(noTransitionProgram, [
      { key: "run_seed", values: [1, 2, 3] },
    ]);
    const md = generateMarkdown(model);
    assert.ok(
      md.includes("No phase transitions detected"),
      "Should say no transitions",
    );
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe("Phase Transition Report — JSON", () => {
  it("parses as valid JSON with expected top-level keys", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3] },
    ]);
    const json = JSON.parse(generateJSON(model));
    assert.ok(json.schema_version);
    assert.ok(json.meta);
    assert.ok(json.summary);
    assert.ok(json.regime_proportions);
    assert.ok(json.transitions);
    assert.ok(json.grid_points);
  });

  it("strips knob values array from JSON for compactness", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5] },
    ]);
    const json = JSON.parse(generateJSON(model));
    for (const k of json.summary.knobs) {
      assert.equal(k.values, undefined, "knob values should be stripped in JSON");
    }
  });

  it("strips null halt_reason from grid points", () => {
    const model = buildReport(noTransitionProgram, [
      { key: "run_seed", values: [1, 2] },
    ]);
    const json = JSON.parse(generateJSON(model));
    for (const p of json.grid_points) {
      assert.equal(p.halt_reason, undefined, "null halt_reason should be stripped");
    }
  });
});

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

describe("Phase Transition Report — CSV", () => {
  it("header row has correct columns", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3] },
    ]);
    const csv = generateCSV(model);
    const header = csv.split("\n")[0];
    assert.equal(header, "index,run_seed,total_steps,final_bag_sum,halted_early,halt_reason");
  });

  it("row count equals grid_size + 1 (header)", () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7];
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: seeds },
    ]);
    const csv = generateCSV(model);
    const lines = csv.trim().split("\n");
    assert.equal(lines.length, seeds.length + 1);
  });

  it("data rows have correct number of fields", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3] },
    ]);
    const csv = generateCSV(model);
    const lines = csv.trim().split("\n");
    const headerFields = lines[0].split(",").length;
    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].split(",").length;
      assert.equal(fields, headerFields, `Row ${i} has ${fields} fields, expected ${headerFields}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Phase Transition Report — edge cases", () => {
  it("0 transitions does not crash", () => {
    const model = buildReport(noTransitionProgram, [
      { key: "run_seed", values: [1, 2, 3] },
    ]);
    assert.equal(model.transitions.length, 0);
    assert.equal(model.regime_proportions.halted, 0);
    assert.equal(model.regime_proportions.completed, 3);

    // All output formats should work
    const md = generateMarkdown(model);
    assert.ok(md.length > 0);
    const json = generateJSON(model);
    assert.ok(JSON.parse(json));
    const csv = generateCSV(model);
    assert.ok(csv.length > 0);
  });

  it("single grid point does not crash", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1] },
    ]);
    assert.equal(model.grid_points.length, 1);
    assert.equal(model.transitions.length, 0);
    const md = generateMarkdown(model);
    assert.ok(md.includes("# Phase Transition Report"));
  });

  it("adaptive_refinements is null for grid scan", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2] },
    ]);
    assert.equal(model.summary.adaptive_refinements, null);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("Phase Transition Report — determinism", () => {
  it("two runs produce identical output", () => {
    const knobs = [{ key: "run_seed", values: [1, 2, 3, 4, 5] }];
    const m1 = buildReport(rngPhaseTransition, knobs);
    const m2 = buildReport(rngPhaseTransition, knobs);

    assert.deepEqual(m1, m2);
    assert.equal(generateMarkdown(m1), generateMarkdown(m2));
    assert.equal(generateJSON(m1), generateJSON(m2));
    assert.equal(generateCSV(m1), generateCSV(m2));
  });
});

// ---------------------------------------------------------------------------
// Golden fixture
// ---------------------------------------------------------------------------

describe("Phase Transition Report — golden fixture", () => {
  it("JSON report matches frozen output", () => {
    const model = buildReport(rngPhaseTransition, [
      { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ]);

    const frozen = {
      schema_version: model.schema_version,
      program_id: model.meta.program_id,
      grid_size: model.summary.grid_size,
      hint_count: model.summary.total_hints,
      transition_count: model.transitions.length,
      halted: model.regime_proportions.halted,
      completed: model.regime_proportions.completed,
      knob_names: model.summary.knobs.map((k: any) => k.name),
      transition_ids: model.transitions.map((t: any) => t.id),
      grid_statuses: model.grid_points.map((p: any) => p.halted_early),
    };

    const goldenPath = "tests/fixtures/golden-phase-report.json";
    if (!existsSync(goldenPath)) {
      writeFileSync(goldenPath, JSON.stringify(frozen, null, 2) + "\n");
      console.log("  [golden fixture written — re-run to verify]");
      return;
    }

    const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
    assert.deepEqual(frozen, golden);
  });
});
