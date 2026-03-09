import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkNonNegativeBags,
  checkBagBalance,
  checkStackBound,
  checkBagIntegrity,
  checkAllInvariants,
} from "../src/kb/vm_invariants.js";
import type { VmState } from "../src/kb/vm_types.js";

function makeState(overrides: Partial<VmState> = {}): VmState {
  return {
    bags: {},
    stack: [],
    flags: {},
    notes: [],
    ...overrides,
  };
}

describe("vm_invariants", () => {
  describe("checkNonNegativeBags", () => {
    it("passes for empty bags", () => {
      const r = checkNonNegativeBags(makeState());
      assert.equal(r.ok, true);
      assert.equal(r.violations.length, 0);
    });

    it("passes for all non-negative bags", () => {
      const r = checkNonNegativeBags(makeState({ bags: { a: 0, b: 5, c: 100 } }));
      assert.equal(r.ok, true);
    });

    it("fails for negative bag", () => {
      const r = checkNonNegativeBags(makeState({ bags: { a: -1, b: 5 } }));
      assert.equal(r.ok, false);
      assert.equal(r.violations.length, 1);
      assert.ok(r.violations[0].includes('"a"'));
    });

    it("reports multiple negative bags", () => {
      const r = checkNonNegativeBags(makeState({ bags: { x: -3, y: -1 } }));
      assert.equal(r.ok, false);
      assert.equal(r.violations.length, 2);
    });
  });

  describe("checkBagBalance", () => {
    it("passes when sum matches expected", () => {
      const r = checkBagBalance(makeState({ bags: { a: 30, b: 70 } }), 100);
      assert.equal(r.ok, true);
    });

    it("fails when sum differs from expected", () => {
      const r = checkBagBalance(makeState({ bags: { a: 30, b: 60 } }), 100);
      assert.equal(r.ok, false);
      assert.ok(r.violations[0].includes("90"));
    });

    it("passes for empty bags with expected 0", () => {
      const r = checkBagBalance(makeState(), 0);
      assert.equal(r.ok, true);
    });
  });

  describe("checkStackBound", () => {
    it("passes when stack within limit", () => {
      const r = checkStackBound(makeState({ stack: [1, 2, 3] }), 10);
      assert.equal(r.ok, true);
    });

    it("passes at exact limit", () => {
      const r = checkStackBound(makeState({ stack: [1, 2, 3] }), 3);
      assert.equal(r.ok, true);
    });

    it("fails when stack exceeds limit", () => {
      const r = checkStackBound(makeState({ stack: [1, 2, 3, 4] }), 3);
      assert.equal(r.ok, false);
      assert.ok(r.violations[0].includes("4"));
    });
  });

  describe("checkBagIntegrity", () => {
    it("passes for integer bags", () => {
      const r = checkBagIntegrity(makeState({ bags: { a: 0, b: 42 } }));
      assert.equal(r.ok, true);
    });

    it("fails for non-integer bag", () => {
      const r = checkBagIntegrity(makeState({ bags: { a: 3.14 } }));
      assert.equal(r.ok, false);
      assert.ok(r.violations.some((v) => v.includes("not an integer")));
    });

    it("fails for NaN bag", () => {
      const r = checkBagIntegrity(makeState({ bags: { a: NaN } }));
      assert.equal(r.ok, false);
    });

    it("fails for Infinity bag", () => {
      const r = checkBagIntegrity(makeState({ bags: { a: Infinity } }));
      assert.equal(r.ok, false);
    });
  });

  describe("checkAllInvariants", () => {
    it("passes for valid state", () => {
      const r = checkAllInvariants(makeState({ bags: { a: 10, b: 20 } }));
      assert.equal(r.ok, true);
    });

    it("combines violations from multiple checks", () => {
      const r = checkAllInvariants(
        makeState({ bags: { a: -1 }, stack: new Array(1001).fill(0) }),
        { maxStackDepth: 1000 },
      );
      assert.equal(r.ok, false);
      assert.ok(r.violations.length >= 2);
    });

    it("checks balance when expectedTotal provided", () => {
      const r = checkAllInvariants(
        makeState({ bags: { a: 30, b: 60 } }),
        { expectedTotal: 100 },
      );
      assert.equal(r.ok, false);
      assert.ok(r.violations.some((v) => v.includes("expected total")));
    });

    it("skips balance check when expectedTotal not provided", () => {
      const r = checkAllInvariants(makeState({ bags: { a: 30, b: 60 } }));
      assert.equal(r.ok, true);
    });
  });
});
