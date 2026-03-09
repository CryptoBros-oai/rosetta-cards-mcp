import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventCreateInputSchema } from "../src/kb/schema.js";

function validInput() {
  return {
    title: "Test Event",
    summary: "Summary",
    event: {
      kind: "deployment",
      status: "confirmed",
      severity: "info",
      confidence: 0.9,
      participants: [{ role: "builder", name: "Alice" }],
      refs: [{ ref_type: "artifact_id", value: "card_123" }],
    },
    tags: ["test"],
    rosetta: { verb: "Transform", polarity: "+", weights: { A: 0, C: 0, L: 0, P: 0, T: 1 } },
  };
}

describe("event input schema — strict boundary", () => {
  it("rejects occurred_at at root level", () => {
    const inp = { ...validInput(), occurred_at: "2026-03-02T00:00:00Z" };
    assert.throws(() => EventCreateInputSchema.parse(inp), /unrecognized_keys/i);
  });

  it("rejects temporal field nested inside event block", () => {
    const inp = { ...validInput(), event: { ...validInput().event, timestamp: "2026-03-02T00:00:00Z" } };
    assert.throws(() => EventCreateInputSchema.parse(inp), /unrecognized_keys/i);
  });

  it("rejects temporal field inside participants array element", () => {
    const e = { ...validInput().event };
    e.participants = [{ role: "builder", name: "Bob", created_at: "bad" } as any];
    const inp = { ...validInput(), event: e };
    assert.throws(() => EventCreateInputSchema.parse(inp), /unrecognized_keys/i);
  });

  it("rejects prototype pollution keys at root", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const inp: any = { ...validInput() };
      // Ensure the property is an own, enumerable property rather than setting
      // the prototype via the `__proto__` accessor.
      Object.defineProperty(inp, key, { value: {}, enumerable: true, configurable: true, writable: true });
      assert.throws(() => EventCreateInputSchema.parse(inp), /unrecognized_keys/i);
    }
  });
});
