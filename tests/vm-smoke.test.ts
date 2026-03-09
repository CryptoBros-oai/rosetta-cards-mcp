import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/kb/vm_engine.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";

const ENV: VmEnv = { run_seed: 42, world_seed: 7, max_steps: 10000 };

// ===========================================================================
// Smoke Program 1: Budget Allocator
// ===========================================================================

const budgetAllocator: VmProgram = {
  program_id: "smoke_budget_allocator",
  version: "program.v1",
  opcodes: [
    // Phase 1: Initialize total budget
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "total", amount: 1000 } },

    // Phase 2: Transform — split budget
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "engineering", amount: 500 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "marketing", amount: 300 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "operations", amount: 200 } },

    // Phase 3: Contain — clamp each dept
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "engineering", min: 100, max: 600 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "marketing", min: 50, max: 400 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "operations", min: 50, max: 300 } },

    // Phase 4: Contain — threshold check
    { opcode_id: "contain.threshold", verb: "Contain", args: { bag: "engineering", threshold: 400, flag: "eng_above_400" } },

    // Phase 5: Release — export results
    { opcode_id: "release.export", verb: "Release", args: { bag: "engineering" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "marketing" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "operations" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "budget allocation complete" } },
  ],
};

describe("Smoke: Budget Allocator", () => {
  it("produces correct final state", () => {
    const r = execute(budgetAllocator, emptyState(), ENV);

    // All exported — bags should be 0
    assert.equal(r.state.bags.engineering, 0);
    assert.equal(r.state.bags.marketing, 0);
    assert.equal(r.state.bags.operations, 0);
    assert.equal(r.state.bags.total, 0);
    assert.equal(r.metrics.final_bag_sum, 0);
  });

  it("exports correct values in notes", () => {
    const r = execute(budgetAllocator, emptyState(), ENV);
    assert.ok(r.state.notes.includes("export:engineering=500"));
    assert.ok(r.state.notes.includes("export:marketing=300"));
    assert.ok(r.state.notes.includes("export:operations=200"));
    assert.ok(r.state.notes.includes("budget allocation complete"));
  });

  it("sets eng_above_400 flag", () => {
    const r = execute(budgetAllocator, emptyState(), ENV);
    assert.equal(r.state.flags.eng_above_400, true);
  });

  it("has correct trace length and verb distribution", () => {
    const r = execute(budgetAllocator, emptyState(), ENV);
    assert.equal(r.trace.length, 12);
    assert.equal(r.metrics.total_steps, 12);
    assert.equal(r.metrics.verb_distribution.Attract, 1);
    assert.equal(r.metrics.verb_distribution.Transform, 3);
    assert.equal(r.metrics.verb_distribution.Contain, 4);
    assert.equal(r.metrics.verb_distribution.Release, 4);
    assert.equal(r.metrics.halted_early, false);
  });

  it("is deterministic", () => {
    const r1 = execute(budgetAllocator, emptyState(), ENV);
    const r2 = execute(budgetAllocator, emptyState(), ENV);
    assert.deepEqual(r1, r2);
  });
});

// ===========================================================================
// Smoke Program 2: Filter Pipeline
// ===========================================================================

const filterPipeline: VmProgram = {
  program_id: "smoke_filter_pipeline",
  version: "program.v1",
  opcodes: [
    // Attract: bring items in
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_a", amount: 80 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_b", amount: 30 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_c", amount: 95 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_d", amount: 10 } },

    // Repel: filter out below threshold 50
    { opcode_id: "repel.filter", verb: "Repel", args: { threshold: 50, bags_list: "item_a,item_b,item_c,item_d" } },

    // Contain: normalize survivors to sum to 100
    { opcode_id: "contain.normalize", verb: "Contain", args: { bags_list: "item_a,item_b,item_c,item_d", target: 100 } },

    // Release: emit summary
    { opcode_id: "release.emit", verb: "Release", args: { message: "filter pipeline complete" } },
  ],
};

describe("Smoke: Filter Pipeline", () => {
  it("zeroes items below threshold", () => {
    const r = execute(filterPipeline, emptyState(), ENV);
    // After normalize, b and d should be 0 (they were filtered)
    assert.equal(r.state.bags.item_b, 0);
    assert.equal(r.state.bags.item_d, 0);
  });

  it("normalizes survivors to target sum", () => {
    const r = execute(filterPipeline, emptyState(), ENV);
    const sum = r.state.bags.item_a + r.state.bags.item_b +
                r.state.bags.item_c + r.state.bags.item_d;
    assert.equal(sum, 100);
  });

  it("has correct verb distribution", () => {
    const r = execute(filterPipeline, emptyState(), ENV);
    assert.equal(r.trace.length, 7);
    assert.equal(r.metrics.verb_distribution.Attract, 4);
    assert.equal(r.metrics.verb_distribution.Repel, 1);
    assert.equal(r.metrics.verb_distribution.Contain, 1);
    assert.equal(r.metrics.verb_distribution.Release, 1);
  });

  it("is deterministic", () => {
    const r1 = execute(filterPipeline, emptyState(), ENV);
    const r2 = execute(filterPipeline, emptyState(), ENV);
    assert.deepEqual(r1, r2);
  });
});

// ===========================================================================
// Smoke Program 3: Provenance Compiler
// ===========================================================================

const provenanceCompiler: VmProgram = {
  program_id: "smoke_provenance_compiler",
  version: "program.v1",
  opcodes: [
    // Set up raw data
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "raw_signal", amount: 200 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "noise_floor", amount: 50 } },

    // Transform: derive
    { opcode_id: "transform.derive", verb: "Transform", args: { source: "raw_signal", dest: "amplified", fn: "multiply", param: 3 } },
    { opcode_id: "transform.derive", verb: "Transform", args: { source: "noise_floor", dest: "noise_scaled", fn: "multiply", param: 2 } },

    // Transform: compose into single metric
    { opcode_id: "transform.compose", verb: "Transform", args: { a: "amplified", b: "noise_scaled", into: "composite" } },

    // Contain: commit to stack
    { opcode_id: "contain.commit_to_stack", verb: "Contain", args: { bag: "composite" } },

    // Release: finalize and export
    { opcode_id: "release.finalize", verb: "Release", args: { bag: "final_metric" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "final_metric" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "provenance compilation complete" } },
  ],
};

describe("Smoke: Provenance Compiler", () => {
  it("computes correct derived values", () => {
    const r = execute(provenanceCompiler, emptyState(), ENV);
    // amplified = 200 * 3 = 600, noise_scaled = 50 * 2 = 100
    // composite = 600 + 100 = 700, pushed to stack, popped to final_metric, exported
    assert.ok(r.state.notes.includes("export:final_metric=700"));
  });

  it("preserves source bags (derive does not consume)", () => {
    const r = execute(provenanceCompiler, emptyState(), ENV);
    assert.equal(r.state.bags.raw_signal, 200);
    assert.equal(r.state.bags.noise_floor, 50);
  });

  it("has correct trace length", () => {
    const r = execute(provenanceCompiler, emptyState(), ENV);
    assert.equal(r.trace.length, 9);
    assert.equal(r.metrics.verb_distribution.Attract, 2);
    assert.equal(r.metrics.verb_distribution.Transform, 3);
    assert.equal(r.metrics.verb_distribution.Contain, 1);
    assert.equal(r.metrics.verb_distribution.Release, 3);
  });

  it("is deterministic", () => {
    const r1 = execute(provenanceCompiler, emptyState(), ENV);
    const r2 = execute(provenanceCompiler, emptyState(), ENV);
    assert.deepEqual(r1, r2);
  });
});
