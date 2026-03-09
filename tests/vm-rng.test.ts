import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/kb/vm_rng.js";

describe("vm_rng", () => {
  it("same seeds produce identical sequence", () => {
    const rng1 = createRng(42, 7);
    const rng2 = createRng(42, 7);
    for (let i = 0; i < 1000; i++) {
      assert.equal(rng1.next(), rng2.next(), `mismatch at iteration ${i}`);
    }
  });

  it("different seeds produce different sequences", () => {
    const rng1 = createRng(42, 7);
    const rng2 = createRng(43, 7);
    const seq1 = Array.from({ length: 10 }, () => rng1.next());
    const seq2 = Array.from({ length: 10 }, () => rng2.next());
    assert.notDeepEqual(seq1, seq2);
  });

  it("values are in [0, 1) range", () => {
    const rng = createRng(123, 456);
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      assert.ok(v >= 0, `value ${v} < 0`);
      assert.ok(v < 1, `value ${v} >= 1`);
      assert.ok(Number.isFinite(v), `value ${v} is not finite`);
      assert.ok(!Number.isNaN(v), `value ${v} is NaN`);
    }
  });

  it("nextInt returns integers in [0, max)", () => {
    const rng = createRng(99, 88);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(10);
      assert.ok(v >= 0 && v < 10 && Number.isInteger(v), `invalid nextInt: ${v}`);
    }
  });

  it("fork produces independent sub-stream", () => {
    const rng = createRng(42, 7);
    rng.next(); rng.next();
    const forked = rng.fork(100);

    const parentSeq = Array.from({ length: 10 }, () => rng.next());
    const forkedSeq = Array.from({ length: 10 }, () => forked.next());
    assert.notDeepEqual(parentSeq, forkedSeq);
  });

  it("fork with same salt is deterministic", () => {
    const rng1 = createRng(42, 7);
    rng1.next(); rng1.next();
    const fork1 = rng1.fork(100);

    const rng2 = createRng(42, 7);
    rng2.next(); rng2.next();
    const fork2 = rng2.fork(100);

    for (let i = 0; i < 100; i++) {
      assert.equal(fork1.next(), fork2.next(), `fork mismatch at ${i}`);
    }
  });

  it("determinism: 10 runs all identical", () => {
    const runs: number[][] = [];
    for (let r = 0; r < 10; r++) {
      const rng = createRng(777, 888);
      runs.push(Array.from({ length: 50 }, () => rng.next()));
    }
    for (let r = 1; r < 10; r++) {
      assert.deepEqual(runs[r], runs[0], `run ${r} differs from run 0`);
    }
  });

  it("handles zero seeds by substituting non-zero defaults", () => {
    const rng = createRng(0, 0);
    const v = rng.next();
    assert.ok(Number.isFinite(v) && v >= 0 && v < 1);
  });
});
