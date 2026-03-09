import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRegime,
  REGIME_CLASS_INDEX,
  ALL_REGIME_CLASSES,
} from "../src/kb/vm_regime.js";
import type { RegimeClass } from "../src/kb/vm_regime.js";
import { execute } from "../src/kb/vm_engine.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";

// ---------------------------------------------------------------------------
// Unit tests — string parsing
// ---------------------------------------------------------------------------

describe("classifyRegime — unit", () => {
  it("returns 'completed' for non-halted run", () => {
    assert.equal(
      classifyRegime({ halted_early: false }),
      "completed",
    );
  });

  it("returns 'completed' when halted_early=false even with halt_reason", () => {
    assert.equal(
      classifyRegime({ halted_early: false, halt_reason: "max_steps exceeded (10)" }),
      "completed",
    );
  });

  it("returns 'halt:max_steps' for max_steps exceeded", () => {
    assert.equal(
      classifyRegime({ halted_early: true, halt_reason: "max_steps exceeded (100)" }),
      "halt:max_steps",
    );
  });

  it("returns 'halt:precondition' for precondition failed", () => {
    assert.equal(
      classifyRegime({
        halted_early: true,
        halt_reason: "precondition failed at step 14 (repel.reject): threshold exceeded — halting",
      }),
      "halt:precondition",
    );
  });

  it("returns 'halt:invariant:negative_bag' for negative bag", () => {
    assert.equal(
      classifyRegime({
        halted_early: true,
        halt_reason: 'invariant violation at step 3: bag "pool" is negative: -5',
      }),
      "halt:invariant:negative_bag",
    );
  });

  it("returns 'halt:invariant:non_integer' for not an integer", () => {
    assert.equal(
      classifyRegime({
        halted_early: true,
        halt_reason: 'invariant violation at step 3: bag "x" is not an integer: 3.5',
      }),
      "halt:invariant:non_integer",
    );
  });

  it("returns 'halt:invariant:non_integer' for not finite", () => {
    assert.equal(
      classifyRegime({
        halted_early: true,
        halt_reason: 'invariant violation at step 3: bag "x" is not finite: NaN',
      }),
      "halt:invariant:non_integer",
    );
  });

  it("returns 'halt:invariant:stack_overflow' for stack depth exceeded", () => {
    assert.equal(
      classifyRegime({
        halted_early: true,
        halt_reason: "invariant violation at step 3: stack depth 1001 exceeds max 1000",
      }),
      "halt:invariant:stack_overflow",
    );
  });

  it("returns 'halt:invariant:balance' for bag sum mismatch", () => {
    assert.equal(
      classifyRegime({
        halted_early: true,
        halt_reason: "invariant violation at step 3: bag sum 100 != expected total 200",
      }),
      "halt:invariant:balance",
    );
  });

  it("returns 'halt:invariant:unknown' for unrecognized invariant", () => {
    assert.equal(
      classifyRegime({
        halted_early: true,
        halt_reason: "invariant violation at step 3: some new condition",
      }),
      "halt:invariant:unknown",
    );
  });

  it("returns 'halt:unknown' for undefined halt_reason on halted run", () => {
    assert.equal(
      classifyRegime({ halted_early: true }),
      "halt:unknown",
    );
  });

  it("returns 'halt:unknown' for unrecognized halt_reason", () => {
    assert.equal(
      classifyRegime({ halted_early: true, halt_reason: "something unexpected" }),
      "halt:unknown",
    );
  });

  it("deterministic: same input produces same output", () => {
    const input = { halted_early: true, halt_reason: "max_steps exceeded (10)" };
    assert.equal(classifyRegime(input), classifyRegime(input));
  });
});

// ---------------------------------------------------------------------------
// REGIME_CLASS_INDEX
// ---------------------------------------------------------------------------

describe("REGIME_CLASS_INDEX", () => {
  it("covers all RegimeClass values", () => {
    for (const rc of ALL_REGIME_CLASSES) {
      assert.ok(
        rc in REGIME_CLASS_INDEX,
        `Missing index for ${rc}`,
      );
    }
  });

  it("all indices are unique", () => {
    const values = Object.values(REGIME_CLASS_INDEX);
    assert.equal(new Set(values).size, values.length);
  });

  it("indices are sequential from 0", () => {
    const values = Object.values(REGIME_CLASS_INDEX).sort((a, b) => a - b);
    for (let i = 0; i < values.length; i++) {
      assert.equal(values[i], i, `Expected index ${i}, got ${values[i]}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Real programs
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

const budgetProgram: VmProgram = {
  program_id: "smoke_budget_allocator",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "total", amount: 1000 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "engineering", amount: 500 } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "done" } },
  ],
};

const BASE_ENV: VmEnv = { run_seed: 1, world_seed: 7, max_steps: 10000 };

describe("classifyRegime — real programs", () => {
  it("rng with low threshold halts as 'halt:precondition'", () => {
    const env = { ...BASE_ENV, params: { halt_threshold: 10 } };
    const result = execute(rngProgram, emptyState(), env, { softHalt: true });
    assert.equal(classifyRegime(result.metrics), "halt:precondition");
  });

  it("budget allocator completes as 'completed'", () => {
    const result = execute(budgetProgram, emptyState(), BASE_ENV);
    assert.equal(classifyRegime(result.metrics), "completed");
  });

  it("budget allocator with max_steps=1 halts as 'halt:max_steps'", () => {
    const env = { ...BASE_ENV, max_steps: 1 };
    const result = execute(budgetProgram, emptyState(), env);
    assert.equal(classifyRegime(result.metrics), "halt:max_steps");
  });
});
