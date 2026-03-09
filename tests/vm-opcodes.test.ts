import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOpcode, listOpcodes, listOpcodesByVerb } from "../src/kb/vm_registry.js";
import { emptyState } from "../src/kb/vm_types.js";
import type { VmState, VmEnv } from "../src/kb/vm_types.js";
import { createRng } from "../src/kb/vm_rng.js";

const ENV: VmEnv = { run_seed: 42, world_seed: 7, max_steps: 10000 };

function state(bags: Record<string, number> = {}, extra?: Partial<VmState>): VmState {
  return { bags, stack: [], flags: {}, notes: [], ...extra };
}

function run(opcode_id: string, s: VmState, args: Record<string, number | string | boolean>, rngSeed1 = 42, rngSeed2 = 7) {
  const spec = getOpcode(opcode_id)!;
  assert.ok(spec, `opcode ${opcode_id} not found`);
  const rng = createRng(rngSeed1, rngSeed2);
  if (spec.precondition) {
    const err = spec.precondition(s, args);
    if (err) return { error: err };
  }
  return { state: spec.reduce(s, args, ENV, rng.next) };
}

describe("registry", () => {
  it("lists all 20 opcodes", () => {
    assert.equal(listOpcodes().length, 20);
  });

  it("lists opcodes by verb", () => {
    assert.equal(listOpcodesByVerb("Attract").length, 4);
    assert.equal(listOpcodesByVerb("Contain").length, 6);
    assert.equal(listOpcodesByVerb("Release").length, 4);
    assert.equal(listOpcodesByVerb("Repel").length, 3);
    assert.equal(listOpcodesByVerb("Transform").length, 3);
  });

  it("returns undefined for unknown opcode", () => {
    assert.equal(getOpcode("nonexistent"), undefined);
  });
});

// ===========================================================================
// ATTRACT
// ===========================================================================

describe("attract.add", () => {
  it("adds amount to new bag", () => {
    const r = run("attract.add", state(), { bag: "energy", amount: 50 });
    assert.equal(r.state!.bags.energy, 50);
  });

  it("adds amount to existing bag", () => {
    const r = run("attract.add", state({ energy: 30 }), { bag: "energy", amount: 20 });
    assert.equal(r.state!.bags.energy, 50);
  });

  it("rejects negative amount", () => {
    const r = run("attract.add", state(), { bag: "x", amount: -1 });
    assert.ok(r.error);
  });

  it("allows zero amount", () => {
    const r = run("attract.add", state({ x: 5 }), { bag: "x", amount: 0 });
    assert.equal(r.state!.bags.x, 5);
  });
});

describe("attract.collect", () => {
  it("sums sources into target and deletes sources", () => {
    const r = run("attract.collect", state({ a: 10, b: 20, c: 30 }), { sources: "a,b", target: "total" });
    assert.equal(r.state!.bags.total, 30);
    assert.equal(r.state!.bags.a, undefined);
    assert.equal(r.state!.bags.b, undefined);
    assert.equal(r.state!.bags.c, 30);
  });

  it("fails if source bag missing", () => {
    const r = run("attract.collect", state({ a: 10 }), { sources: "a,missing", target: "t" });
    assert.ok(r.error);
  });

  it("adds to existing target", () => {
    const r = run("attract.collect", state({ a: 10, b: 20, total: 5 }), { sources: "a,b", target: "total" });
    assert.equal(r.state!.bags.total, 35);
  });
});

describe("attract.select", () => {
  it("selects one candidate by RNG", () => {
    const r = run("attract.select", state({ a: 10, b: 20, c: 30 }), { candidates: "a,b,c", into: "chosen" });
    assert.ok(r.state!.bags.chosen !== undefined);
    assert.ok(r.state!.notes.length === 1);
    assert.ok(r.state!.notes[0].includes("selected"));
  });

  it("fails if candidates empty", () => {
    const r = run("attract.select", state(), { candidates: "", into: "x" });
    assert.ok(r.error);
  });

  it("is deterministic with same seeds", () => {
    const r1 = run("attract.select", state({ a: 10, b: 20 }), { candidates: "a,b", into: "out" }, 42, 7);
    const r2 = run("attract.select", state({ a: 10, b: 20 }), { candidates: "a,b", into: "out" }, 42, 7);
    assert.deepEqual(r1.state, r2.state);
  });
});

describe("attract.increment", () => {
  it("increments existing bag by 1", () => {
    const r = run("attract.increment", state({ counter: 5 }), { bag: "counter" });
    assert.equal(r.state!.bags.counter, 6);
  });

  it("fails if bag does not exist", () => {
    const r = run("attract.increment", state(), { bag: "missing" });
    assert.ok(r.error);
  });
});

// ===========================================================================
// CONTAIN
// ===========================================================================

describe("contain.threshold", () => {
  it("sets flag true when bag >= threshold", () => {
    const r = run("contain.threshold", state({ energy: 100 }), { bag: "energy", threshold: 50, flag: "high" });
    assert.equal(r.state!.flags.high, true);
  });

  it("sets flag false when bag < threshold", () => {
    const r = run("contain.threshold", state({ energy: 30 }), { bag: "energy", threshold: 50, flag: "high" });
    assert.equal(r.state!.flags.high, false);
  });

  it("fails if bag missing", () => {
    const r = run("contain.threshold", state(), { bag: "x", threshold: 10, flag: "f" });
    assert.ok(r.error);
  });
});

describe("contain.clamp", () => {
  it("clamps value above max", () => {
    const r = run("contain.clamp", state({ x: 200 }), { bag: "x", min: 0, max: 100 });
    assert.equal(r.state!.bags.x, 100);
  });

  it("clamps value below min", () => {
    const r = run("contain.clamp", state({ x: 5 }), { bag: "x", min: 10, max: 100 });
    assert.equal(r.state!.bags.x, 10);
  });

  it("leaves value within range unchanged", () => {
    const r = run("contain.clamp", state({ x: 50 }), { bag: "x", min: 0, max: 100 });
    assert.equal(r.state!.bags.x, 50);
  });

  it("fails if min > max", () => {
    const r = run("contain.clamp", state({ x: 50 }), { bag: "x", min: 100, max: 10 });
    assert.ok(r.error);
  });
});

describe("contain.normalize", () => {
  it("redistributes proportionally to target sum", () => {
    const r = run("contain.normalize", state({ a: 80, b: 20 }), { bags_list: "a,b", target: 100 });
    assert.equal(r.state!.bags.a + r.state!.bags.b, 100);
    assert.equal(r.state!.bags.a, 80);
    assert.equal(r.state!.bags.b, 20);
  });

  it("handles non-trivial proportions with integer rounding", () => {
    const r = run("contain.normalize", state({ a: 1, b: 1, c: 1 }), { bags_list: "a,b,c", target: 100 });
    const sum = r.state!.bags.a + r.state!.bags.b + r.state!.bags.c;
    assert.equal(sum, 100);
  });

  it("fails if sum is zero", () => {
    const r = run("contain.normalize", state({ a: 0, b: 0 }), { bags_list: "a,b", target: 100 });
    assert.ok(r.error);
  });

  it("zeros bags with zero value remain zero-ish after normalize", () => {
    // Only non-zero bags get proportion
    const r = run("contain.normalize", state({ a: 100, b: 0 }), { bags_list: "a,b", target: 50 });
    assert.equal(r.state!.bags.a, 50);
    assert.equal(r.state!.bags.b, 0);
  });
});

describe("contain.bind", () => {
  it("sets flag to true", () => {
    const r = run("contain.bind", state(), { flag: "ready", value: true });
    assert.equal(r.state!.flags.ready, true);
  });

  it("sets flag to false", () => {
    const r = run("contain.bind", state(undefined, { flags: { ready: true } }), { flag: "ready", value: false });
    assert.equal(r.state!.flags.ready, false);
  });
});

describe("contain.commit_to_stack", () => {
  it("pushes bag value to stack and zeros bag", () => {
    const r = run("contain.commit_to_stack", state({ x: 42 }), { bag: "x" });
    assert.equal(r.state!.bags.x, 0);
    assert.deepEqual(r.state!.stack, [42]);
  });

  it("fails if bag missing", () => {
    const r = run("contain.commit_to_stack", state(), { bag: "missing" });
    assert.ok(r.error);
  });
});

// ===========================================================================
// RELEASE
// ===========================================================================

describe("release.decrement", () => {
  it("decrements bag by amount", () => {
    const r = run("release.decrement", state({ x: 100 }), { bag: "x", amount: 30 });
    assert.equal(r.state!.bags.x, 70);
  });

  it("fails if insufficient funds", () => {
    const r = run("release.decrement", state({ x: 10 }), { bag: "x", amount: 20 });
    assert.ok(r.error);
  });

  it("allows decrement to zero", () => {
    const r = run("release.decrement", state({ x: 10 }), { bag: "x", amount: 10 });
    assert.equal(r.state!.bags.x, 0);
  });
});

describe("release.emit", () => {
  it("appends message to notes", () => {
    const r = run("release.emit", state(), { message: "hello" });
    assert.deepEqual(r.state!.notes, ["hello"]);
  });

  it("preserves existing notes", () => {
    const r = run("release.emit", state(undefined, { notes: ["prev"] }), { message: "next" });
    assert.deepEqual(r.state!.notes, ["prev", "next"]);
  });
});

describe("release.finalize", () => {
  it("pops stack into bag", () => {
    const r = run("release.finalize", state(undefined, { stack: [42] }), { bag: "result" });
    assert.equal(r.state!.bags.result, 42);
    assert.deepEqual(r.state!.stack, []);
  });

  it("pops last element from multi-element stack", () => {
    const r = run("release.finalize", state(undefined, { stack: [10, 20, 30] }), { bag: "x" });
    assert.equal(r.state!.bags.x, 30);
    assert.deepEqual(r.state!.stack, [10, 20]);
  });

  it("fails if stack empty", () => {
    const r = run("release.finalize", state(), { bag: "x" });
    assert.ok(r.error);
  });
});

describe("release.export", () => {
  it("copies bag to notes and zeros it", () => {
    const r = run("release.export", state({ budget: 500 }), { bag: "budget" });
    assert.equal(r.state!.bags.budget, 0);
    assert.deepEqual(r.state!.notes, ["export:budget=500"]);
  });

  it("fails if bag missing", () => {
    const r = run("release.export", state(), { bag: "nope" });
    assert.ok(r.error);
  });
});

// ===========================================================================
// REPEL
// ===========================================================================

describe("repel.filter", () => {
  it("zeros bags below threshold", () => {
    const r = run("repel.filter", state({ a: 80, b: 30, c: 95, d: 10 }), { threshold: 50, bags_list: "a,b,c,d" });
    assert.equal(r.state!.bags.a, 80);
    assert.equal(r.state!.bags.b, 0);
    assert.equal(r.state!.bags.c, 95);
    assert.equal(r.state!.bags.d, 0);
  });

  it("keeps bags at exactly threshold", () => {
    const r = run("repel.filter", state({ x: 50 }), { threshold: 50, bags_list: "x" });
    assert.equal(r.state!.bags.x, 50);
  });

  it("fails if bag missing", () => {
    const r = run("repel.filter", state({ a: 10 }), { threshold: 5, bags_list: "a,missing" });
    assert.ok(r.error);
  });
});

describe("repel.reject", () => {
  it("halts (precondition fails) if flag is true", () => {
    const r = run("repel.reject", state(undefined, { flags: { abort: true } }), { flag: "abort", reason: "aborted!" });
    assert.ok(r.error);
    assert.equal(r.error, "aborted!");
  });

  it("passes through if flag is false", () => {
    const r = run("repel.reject", state(undefined, { flags: { abort: false } }), { flag: "abort", reason: "aborted!" });
    assert.ok(r.state);
  });

  it("passes through if flag not set", () => {
    const r = run("repel.reject", state(), { flag: "abort", reason: "aborted!" });
    assert.ok(r.state);
  });
});

describe("repel.guard", () => {
  it("halts if bag < min", () => {
    const r = run("repel.guard", state({ fuel: 5 }), { bag: "fuel", min: 10, reason: "out of fuel" });
    assert.ok(r.error);
    assert.equal(r.error, "out of fuel");
  });

  it("passes if bag >= min", () => {
    const r = run("repel.guard", state({ fuel: 10 }), { bag: "fuel", min: 10, reason: "out of fuel" });
    assert.ok(r.state);
  });

  it("fails if bag missing", () => {
    const r = run("repel.guard", state(), { bag: "missing", min: 1, reason: "gone" });
    assert.ok(r.error);
  });
});

// ===========================================================================
// TRANSFORM
// ===========================================================================

describe("transform.convert", () => {
  it("moves amount from source to dest", () => {
    const r = run("transform.convert", state({ src: 100 }), { source: "src", dest: "dst", amount: 40 });
    assert.equal(r.state!.bags.src, 60);
    assert.equal(r.state!.bags.dst, 40);
  });

  it("creates dest bag if missing", () => {
    const r = run("transform.convert", state({ a: 50 }), { source: "a", dest: "b", amount: 20 });
    assert.equal(r.state!.bags.b, 20);
  });

  it("fails if source insufficient", () => {
    const r = run("transform.convert", state({ a: 10 }), { source: "a", dest: "b", amount: 20 });
    assert.ok(r.error);
  });
});

describe("transform.derive", () => {
  it("multiplies source into dest", () => {
    const r = run("transform.derive", state({ x: 50 }), { source: "x", dest: "y", fn: "multiply", param: 3 });
    assert.equal(r.state!.bags.y, 150);
    assert.equal(r.state!.bags.x, 50); // source unchanged
  });

  it("divides source into dest (floor)", () => {
    const r = run("transform.derive", state({ x: 100 }), { source: "x", dest: "y", fn: "divide", param: 3 });
    assert.equal(r.state!.bags.y, 33);
  });

  it("fails for unknown fn", () => {
    const r = run("transform.derive", state({ x: 10 }), { source: "x", dest: "y", fn: "unknown", param: 1 });
    assert.ok(r.error);
  });

  it("fails for divide by zero", () => {
    const r = run("transform.derive", state({ x: 10 }), { source: "x", dest: "y", fn: "divide", param: 0 });
    assert.ok(r.error);
  });
});

describe("transform.compose", () => {
  it("merges two bags into one", () => {
    const r = run("transform.compose", state({ a: 30, b: 70 }), { a: "a", b: "b", into: "total" });
    assert.equal(r.state!.bags.total, 100);
    assert.equal(r.state!.bags.a, undefined);
    assert.equal(r.state!.bags.b, undefined);
  });

  it("fails if first bag missing", () => {
    const r = run("transform.compose", state({ b: 10 }), { a: "a", b: "b", into: "t" });
    assert.ok(r.error);
  });

  it("fails if second bag missing", () => {
    const r = run("transform.compose", state({ a: 10 }), { a: "a", b: "b", into: "t" });
    assert.ok(r.error);
  });
});
