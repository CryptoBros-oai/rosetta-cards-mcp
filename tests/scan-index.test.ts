import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanPhases } from "../src/kb/vm_phase_scan.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import {
  appendToScanIndex,
  loadScanIndex,
  searchScanIndex,
} from "../src/kb/vm_scan_index.js";

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
// appendToScanIndex
// ---------------------------------------------------------------------------

describe("Scan Index — append", () => {
  it("creates valid record with all required fields", () => {
    const result = scanPhases({
      program: rngPhaseTransitionV2,
      state0: emptyState(),
      base_env: { ...BASE_ENV, params: { halt_threshold: 100 } },
      knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      options: { softHalt: true },
    });
    const record = appendToScanIndex(result, "/tmp/test-scan-dir");

    assert.equal(record.schema_version, "scan_index.v1");
    assert.ok(record.scan_id);
    assert.equal(record.scan_hash12.length, 12);
    assert.equal(record.program_id, "rng_phase_transition_v2");
    assert.ok(record.program_fingerprint);
    assert.ok(record.knobs.length > 0);
    assert.equal(record.counts.grid_points, 3);
    assert.ok(record.counts.phase_hints >= 0);
    assert.equal(record.regime.total, 3);
    assert.ok(record.created_at);
  });

  it("records adaptive_refinements as null for grid scan", () => {
    const result = scanPhases({
      program: controlProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "run_seed", values: [1, 2] }],
    });
    const record = appendToScanIndex(result, "/tmp/test-control");
    assert.equal(record.counts.adaptive_refinements, null);
  });

  it("records adaptive_refinements for adaptive scan", () => {
    const result = scanPhases({
      program: rngPhaseTransitionV2,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: [10.5, 100.5, 500.5, 900.5] }],
      options: { softHalt: true },
      scan_mode: "adaptive",
      adaptive: { max_refinements: 2, max_total_runs: 15 },
    });
    const record = appendToScanIndex(result, "/tmp/test-adaptive");
    assert.ok(
      record.counts.adaptive_refinements !== null,
      "Adaptive scan should have non-null refinement count",
    );
    assert.ok(
      record.counts.adaptive_refinements! >= 0,
      "Adaptive refinements should be non-negative",
    );
  });

  it("knob metadata includes type and refinability", () => {
    const result = scanPhases({
      program: rngPhaseTransitionV2,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "halt_threshold", values: [10.5, 100.5] }],
      options: { softHalt: true },
    });
    const record = appendToScanIndex(result, "/tmp/test-knobs");
    const knob = record.knobs.find((k) => k.name === "halt_threshold");
    assert.ok(knob);
    assert.equal(knob!.type, "float");
    assert.equal(knob!.refinable, true);
  });
});

// ---------------------------------------------------------------------------
// loadScanIndex + searchScanIndex
// ---------------------------------------------------------------------------

describe("Scan Index — search", () => {
  // Pre-populate index with a few records
  let rngRecord: any;
  let controlRecord: any;

  it("append two scans and load them", () => {
    const rngResult = scanPhases({
      program: rngPhaseTransitionV2,
      state0: emptyState(),
      base_env: { ...BASE_ENV, params: { halt_threshold: 100 } },
      knobs: [{ key: "run_seed", values: [1, 2, 3, 4, 5] }],
      options: { softHalt: true },
    });
    rngRecord = appendToScanIndex(rngResult, "/tmp/rng-scan");

    const ctrlResult = scanPhases({
      program: controlProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "run_seed", values: [1, 2, 3] }],
    });
    controlRecord = appendToScanIndex(ctrlResult, "/tmp/ctrl-scan");

    const loaded = loadScanIndex();
    // Should contain at least our two records (may contain more from other tests)
    const ids = loaded.map((r) => r.scan_id);
    assert.ok(ids.includes(rngRecord.scan_id));
    assert.ok(ids.includes(controlRecord.scan_id));
  });

  it("filter by program_id", () => {
    const result = searchScanIndex({ program_id: "always_completes" });
    assert.ok(result.records.length > 0);
    for (const r of result.records) {
      assert.equal(r.program_id, "always_completes");
    }
  });

  it("filter by min_hints", () => {
    const result = searchScanIndex({ min_hints: 1 });
    for (const r of result.records) {
      assert.ok(r.counts.phase_hints >= 1);
    }
  });

  it("filter by has_adaptive false", () => {
    const result = searchScanIndex({ has_adaptive: false });
    for (const r of result.records) {
      assert.equal(r.counts.adaptive_refinements, null);
    }
  });

  it("pagination works", () => {
    const all = searchScanIndex({ limit: 100 });
    if (all.total >= 2) {
      const page1 = searchScanIndex({ limit: 1, offset: 0 });
      const page2 = searchScanIndex({ limit: 1, offset: 1 });
      assert.equal(page1.records.length, 1);
      assert.equal(page2.records.length, 1);
      assert.notEqual(page1.records[0].scan_id, page2.records[0].scan_id);
    }
  });

  it("total reflects full count before pagination", () => {
    const result = searchScanIndex({ limit: 1 });
    assert.ok(result.total >= result.records.length);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("Scan Index — determinism", () => {
  it("identical scans produce same record fields (except created_at)", () => {
    const def = {
      program: controlProgram,
      state0: emptyState(),
      base_env: BASE_ENV,
      knobs: [{ key: "run_seed", values: [1, 2] }],
    };
    const r1 = scanPhases(def);
    const r2 = scanPhases(def);

    const rec1 = appendToScanIndex(r1, "/tmp/det1");
    const rec2 = appendToScanIndex(r2, "/tmp/det2");

    assert.equal(rec1.scan_id, rec2.scan_id);
    assert.equal(rec1.program_id, rec2.program_id);
    assert.deepEqual(rec1.counts, rec2.counts);
    assert.deepEqual(rec1.regime, rec2.regime);
  });
});
