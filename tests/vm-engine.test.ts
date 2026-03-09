import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execute, VmInvariantError } from "../src/kb/vm_engine.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmProgram, VmState, VmEnv } from "../src/kb/vm_types.js";

const ENV: VmEnv = { run_seed: 42, world_seed: 7, max_steps: 10000 };

function prog(opcodes: VmProgram["opcodes"], id = "test"): VmProgram {
  return { program_id: id, version: "program.v1", opcodes };
}

describe("vm_engine", () => {
  it("executes single opcode program", () => {
    const p = prog([
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 10 } },
    ]);
    const r = execute(p, emptyState(), ENV);
    assert.equal(r.state.bags.x, 10);
    assert.equal(r.trace.length, 1);
    assert.equal(r.trace[0].step, 0);
    assert.equal(r.trace[0].opcode_id, "attract.add");
    assert.equal(r.metrics.total_steps, 1);
    assert.equal(r.metrics.halted_early, false);
  });

  it("executes multi-opcode program sequentially", () => {
    const p = prog([
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 100 } },
      { opcode_id: "transform.convert", verb: "Transform", args: { source: "x", dest: "y", amount: 40 } },
      { opcode_id: "release.emit", verb: "Release", args: { message: "done" } },
    ]);
    const r = execute(p, emptyState(), ENV);
    assert.equal(r.state.bags.x, 60);
    assert.equal(r.state.bags.y, 40);
    assert.deepEqual(r.state.notes, ["done"]);
    assert.equal(r.trace.length, 3);
  });

  it("halts at max_steps", () => {
    const opcodes = Array.from({ length: 5 }, (_, i) => ({
      opcode_id: "attract.add" as const,
      verb: "Attract" as const,
      args: { bag: "x", amount: 1 },
    }));
    const r = execute(prog(opcodes), emptyState(), { ...ENV, max_steps: 3 });
    assert.equal(r.metrics.halted_early, true);
    assert.ok(r.metrics.halt_reason!.includes("max_steps"));
    assert.equal(r.trace.length, 3);
    assert.equal(r.state.bags.x, 3);
  });

  it("throws on unknown opcode", () => {
    const p = prog([
      { opcode_id: "nonexistent.op", verb: "Attract", args: {} },
    ]);
    assert.throws(() => execute(p, emptyState(), ENV), /Unknown opcode/);
  });

  it("throws on verb mismatch", () => {
    const p = prog([
      { opcode_id: "attract.add", verb: "Release", args: { bag: "x", amount: 1 } },
    ]);
    assert.throws(() => execute(p, emptyState(), ENV), /Verb mismatch/);
  });

  it("halts on precondition failure", () => {
    const p = prog([
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 10 } },
      { opcode_id: "attract.increment", verb: "Attract", args: { bag: "missing" } },
      { opcode_id: "release.emit", verb: "Release", args: { message: "never" } },
    ]);
    const r = execute(p, emptyState(), ENV);
    assert.equal(r.metrics.halted_early, true);
    assert.ok(r.metrics.halt_reason!.includes("precondition"));
    assert.equal(r.trace.length, 2);
    assert.ok(r.trace[1].error!.includes("precondition failed"));
    // State should still reflect step 0 result
    assert.equal(r.state.bags.x, 10);
  });

  it("throws VmInvariantError on violation (softHalt=false)", () => {
    // Use release.decrement to go negative — but we need to bypass the precondition.
    // Instead, use transform.derive with multiply to create a large value, then
    // test invariant with expectedBagTotal.
    const p = prog([
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 50 } },
    ]);
    assert.throws(
      () => execute(p, emptyState(), ENV, { expectedBagTotal: 100 }),
      (err: any) => err instanceof VmInvariantError,
    );
  });

  it("halts on invariant violation (softHalt=true)", () => {
    const p = prog([
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 50 } },
    ]);
    const r = execute(p, emptyState(), ENV, { expectedBagTotal: 100, softHalt: true });
    assert.equal(r.metrics.halted_early, true);
    assert.ok(r.metrics.halt_reason!.includes("invariant violation"));
    assert.ok(r.trace[0].error!.includes("invariant"));
  });

  it("handles empty program", () => {
    const r = execute(prog([]), emptyState(), ENV);
    assert.deepEqual(r.state, emptyState());
    assert.deepEqual(r.trace, []);
    assert.equal(r.metrics.total_steps, 0);
    assert.equal(r.metrics.halted_early, false);
    assert.equal(r.metrics.final_bag_sum, 0);
  });

  it("computes correct metrics", () => {
    const p = prog([
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "a", amount: 50 } },
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "b", amount: 30 } },
      { opcode_id: "transform.convert", verb: "Transform", args: { source: "a", dest: "b", amount: 20 } },
      { opcode_id: "release.emit", verb: "Release", args: { message: "ok" } },
    ]);
    const r = execute(p, emptyState(), ENV);
    assert.equal(r.metrics.total_steps, 4);
    assert.equal(r.metrics.opcode_frequency["attract.add"], 2);
    assert.equal(r.metrics.opcode_frequency["transform.convert"], 1);
    assert.equal(r.metrics.opcode_frequency["release.emit"], 1);
    assert.equal(r.metrics.verb_distribution.Attract, 2);
    assert.equal(r.metrics.verb_distribution.Transform, 1);
    assert.equal(r.metrics.verb_distribution.Release, 1);
    assert.equal(r.metrics.verb_distribution.Contain, 0);
    assert.equal(r.metrics.verb_distribution.Repel, 0);
    assert.equal(r.metrics.final_bag_sum, 80);
  });

  it("trace contains state_before and state_after", () => {
    const p = prog([
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 10 } },
      { opcode_id: "attract.add", verb: "Attract", args: { bag: "x", amount: 5 } },
    ]);
    const r = execute(p, emptyState(), ENV);
    // Step 0: before={bags:{}}, after={bags:{x:10}}
    assert.deepEqual(r.trace[0].state_before.bags, {});
    assert.equal(r.trace[0].state_after.bags.x, 10);
    // Step 1: before={bags:{x:10}}, after={bags:{x:15}}
    assert.equal(r.trace[1].state_before.bags.x, 10);
    assert.equal(r.trace[1].state_after.bags.x, 15);
  });

  it("validates program schema", () => {
    assert.throws(
      () => execute({ program_id: 123 } as any, emptyState(), ENV),
    );
  });

  it("validates state schema", () => {
    assert.throws(
      () => execute(prog([]), { bags: { x: 1.5 } } as any, ENV),
    );
  });

  it("validates env schema", () => {
    assert.throws(
      () => execute(prog([]), emptyState(), { run_seed: "bad" } as any),
    );
  });
});
