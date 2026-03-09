import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRunHash, computeProgramFingerprint } from "../src/kb/vm_run_store.js";
import { canonicalHash } from "../src/kb/canonical.js";
import { scanPhases } from "../src/kb/vm_phase_scan.js";
import { emptyState } from "../src/kb/vm_types.js";
import { execute } from "../src/kb/vm_engine.js";
import { appendToIndex, loadIndex } from "../src/kb/vm_run_index.js";
import type { VmProgram, VmState, VmEnv, RunMetadata } from "../src/kb/vm_types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const simpleProgram: VmProgram = {
  program_id: "guardrail_test",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 10 } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "done" } },
  ],
};

const state0: VmState = { bags: {}, stack: [], flags: {}, notes: [] };

const baseEnv: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000 };

// ---------------------------------------------------------------------------
// Run hash includes env.params
// ---------------------------------------------------------------------------

describe("Identity Guardrail — run hash", () => {
  it("same inputs produce same run_hash", () => {
    const env: VmEnv = { ...baseEnv, params: { threshold: 100 } };
    const h1 = computeRunHash(simpleProgram, state0, env);
    const h2 = computeRunHash(simpleProgram, state0, env);
    assert.equal(h1, h2);
  });

  it("different env.params value produces different run_hash", () => {
    const env1: VmEnv = { ...baseEnv, params: { threshold: 100 } };
    const env2: VmEnv = { ...baseEnv, params: { threshold: 200 } };
    const h1 = computeRunHash(simpleProgram, state0, env1);
    const h2 = computeRunHash(simpleProgram, state0, env2);
    assert.notEqual(h1, h2);
  });

  it("different env.params key produces different run_hash", () => {
    const env1: VmEnv = { ...baseEnv, params: { alpha: 100 } };
    const env2: VmEnv = { ...baseEnv, params: { beta: 100 } };
    const h1 = computeRunHash(simpleProgram, state0, env1);
    const h2 = computeRunHash(simpleProgram, state0, env2);
    assert.notEqual(h1, h2);
  });

  it("env.params key ordering does not affect hash (canonical sort)", () => {
    const env1: VmEnv = { ...baseEnv, params: { alpha: 1, beta: 2 } };
    const env2: VmEnv = { ...baseEnv, params: { beta: 2, alpha: 1 } };
    const h1 = computeRunHash(simpleProgram, state0, env1);
    const h2 = computeRunHash(simpleProgram, state0, env2);
    assert.equal(h1, h2);
  });

  it("missing params vs undefined params produce same hash", () => {
    const env1: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000 };
    const env2: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000, params: undefined };
    const h1 = computeRunHash(simpleProgram, state0, env1);
    const h2 = computeRunHash(simpleProgram, state0, env2);
    // canonicalHash strips undefined, so these should be identical
    assert.equal(h1, h2);
  });

  it("empty params object differs from missing params", () => {
    const env1: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000 };
    const env2: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000, params: {} };
    const h1 = computeRunHash(simpleProgram, state0, env1);
    const h2 = computeRunHash(simpleProgram, state0, env2);
    // Empty object {} is not undefined, so canonicalHash keeps it → different hash
    assert.notEqual(h1, h2);
  });
});

// ---------------------------------------------------------------------------
// Scan hash includes base_env.params
// ---------------------------------------------------------------------------

describe("Identity Guardrail — scan hash", () => {
  it("same scan inputs produce same scan_hash", () => {
    const r1 = scanPhases({
      program: simpleProgram,
      state0,
      base_env: { ...baseEnv, params: { threshold: 50 } },
      knobs: [{ key: "run_seed", values: [1, 2] }],
    });
    const r2 = scanPhases({
      program: simpleProgram,
      state0,
      base_env: { ...baseEnv, params: { threshold: 50 } },
      knobs: [{ key: "run_seed", values: [1, 2] }],
    });
    assert.equal(r1.scan_index.scan_hash, r2.scan_index.scan_hash);
  });

  it("different base_env.params produce different scan_hash", () => {
    const r1 = scanPhases({
      program: simpleProgram,
      state0,
      base_env: { ...baseEnv, params: { threshold: 50 } },
      knobs: [{ key: "run_seed", values: [1, 2] }],
    });
    const r2 = scanPhases({
      program: simpleProgram,
      state0,
      base_env: { ...baseEnv, params: { threshold: 999 } },
      knobs: [{ key: "run_seed", values: [1, 2] }],
    });
    assert.notEqual(r1.scan_index.scan_hash, r2.scan_index.scan_hash);
  });
});

// ---------------------------------------------------------------------------
// Index preserves env.params
// ---------------------------------------------------------------------------

describe("Identity Guardrail — index round-trip", () => {
  it("appendToIndex preserves env.params", () => {
    const env: VmEnv = { ...baseEnv, params: { halt_threshold: 42.5 } };
    const result = execute(simpleProgram, state0, env);
    const run_hash = computeRunHash(simpleProgram, state0, env);
    const metadata: RunMetadata = {
      schema_version: "run.v1",
      run_hash,
      program_fingerprint: computeProgramFingerprint(simpleProgram),
      program_id: simpleProgram.program_id,
      program_version: simpleProgram.version,
      initial_state_hash: canonicalHash(state0 as unknown as Record<string, unknown>),
      env,
      total_steps: result.metrics.total_steps,
      halted_early: result.metrics.halted_early,
      final_bag_sum: result.metrics.final_bag_sum,
      created_at: "2026-01-01T00:00:00.000Z",
    };

    const record = appendToIndex(metadata);
    assert.ok(record.env.params, "Index record should have env.params");
    assert.equal(record.env.params!.halt_threshold, 42.5);
  });
});
