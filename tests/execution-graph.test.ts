/**
 * Execution graph query helper tests — deterministic pipeline traversal,
 * parent/child chain walking, integrity checks (missing parent, cycles,
 * duplicate step_index, pipeline contamination, orphan step_index).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalHash } from "../src/kb/canonical.js";
import { buildExecutionHashPayload } from "../src/kb/schema.js";
import type { ExecutionCard, ExecutionChain } from "../src/kb/schema.js";
import {
  getPipeline,
  walkParentChain,
  getChildren,
  getSiblings,
  checkChainIntegrity,
  getPipelineView,
  listPipelineIds,
} from "../src/kb/execution_graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;

function makeCard(opts: {
  title?: string;
  chain?: ExecutionChain;
  hashOverride?: string;
}): ExecutionCard {
  counter++;
  const payload = buildExecutionHashPayload({
    title: opts.title ?? `step-${counter}`,
    summary: `Test step ${counter}`,
    execution: {
      kind: "job" as const,
      status: "succeeded" as const,
      actor: { type: "agent" as const, name: "test" },
      target: { type: "tool" as const, name: "test.tool" },
      inputs: [],
      outputs: [],
      validation: { state: "self_reported" as const, method: "none" as const },
      chain: opts.chain,
    },
    tags: ["test"],
    rosetta: {
      verb: "Contain" as const,
      polarity: "+" as const,
      weights: { A: 0, C: 1, L: 0, P: 0, T: 0 },
    },
  });
  const hash =
    opts.hashOverride ??
    canonicalHash(payload as unknown as Record<string, unknown>);
  return { ...payload, hash };
}

/** Build a linear pipeline of N steps, returning cards with correct parent links. */
function makePipeline(
  pipelineId: string,
  count: number,
): ExecutionCard[] {
  const cards: ExecutionCard[] = [];
  for (let i = 0; i < count; i++) {
    const chain: ExecutionChain = {
      pipeline_id: pipelineId,
      step_index: i,
      ...(i > 0
        ? { parent_execution_id: cards[i - 1].hash }
        : {}),
    };
    cards.push(
      makeCard({ title: `${pipelineId}-step-${i}`, chain }),
    );
  }
  return cards;
}

// ---------------------------------------------------------------------------
// getPipeline
// ---------------------------------------------------------------------------

describe("execution graph -- getPipeline", () => {
  it("returns cards ordered by step_index", () => {
    const cards = makePipeline("pipe-a", 4);
    // shuffle
    const shuffled = [cards[3], cards[1], cards[0], cards[2]];
    const result = getPipeline(shuffled, "pipe-a");
    assert.equal(result.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(result[i].execution.chain?.step_index, i);
    }
  });

  it("returns empty array for unknown pipeline", () => {
    const cards = makePipeline("pipe-a", 2);
    assert.deepStrictEqual(getPipeline(cards, "pipe-unknown"), []);
  });

  it("cards without step_index sort after those with", () => {
    const withIdx = makeCard({
      title: "with-idx",
      chain: { pipeline_id: "p", step_index: 0 },
    });
    const without = makeCard({
      title: "no-idx",
      chain: { pipeline_id: "p" },
    });
    const result = getPipeline([without, withIdx], "p");
    assert.equal(result[0].execution.chain?.step_index, 0);
    assert.equal(result[1].execution.chain?.step_index, undefined);
  });
});

// ---------------------------------------------------------------------------
// walkParentChain
// ---------------------------------------------------------------------------

describe("execution graph -- walkParentChain", () => {
  it("walks 3-step chain back to root in root-first order", () => {
    const cards = makePipeline("pipe-walk", 3);
    const chain = walkParentChain(cards, cards[2].hash);
    assert.equal(chain.length, 3);
    assert.equal(chain[0].hash, cards[0].hash); // root first
    assert.equal(chain[2].hash, cards[2].hash); // self last
  });

  it("returns single card for root node", () => {
    const root = makeCard({ title: "root", chain: {} });
    assert.equal(walkParentChain([root], root.hash).length, 1);
  });

  it("stops at missing parent", () => {
    const parent = makeCard({ title: "parent" });
    const child = makeCard({
      title: "child",
      chain: { parent_execution_id: parent.hash },
    });
    // only provide child — parent is missing
    const chain = walkParentChain([child], child.hash);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].hash, child.hash);
  });

  it("returns empty for unknown hash", () => {
    const cards = makePipeline("pipe-x", 2);
    assert.deepStrictEqual(walkParentChain(cards, "nonexistent"), []);
  });
});

// ---------------------------------------------------------------------------
// getChildren
// ---------------------------------------------------------------------------

describe("execution graph -- getChildren", () => {
  it("finds children of root in pipeline", () => {
    const cards = makePipeline("pipe-kids", 3);
    const children = getChildren(cards, cards[0].hash);
    assert.equal(children.length, 1);
    assert.equal(children[0].hash, cards[1].hash);
  });

  it("returns empty when no children exist", () => {
    const cards = makePipeline("pipe-leaf", 3);
    const children = getChildren(cards, cards[2].hash);
    assert.equal(children.length, 0);
  });

  it("returns multiple children sorted by step_index", () => {
    const root = makeCard({ title: "root" });
    const childA = makeCard({
      title: "child-a",
      chain: {
        parent_execution_id: root.hash,
        pipeline_id: "fan",
        step_index: 1,
      },
    });
    const childB = makeCard({
      title: "child-b",
      chain: {
        parent_execution_id: root.hash,
        pipeline_id: "fan",
        step_index: 0,
      },
    });
    const result = getChildren([root, childA, childB], root.hash);
    assert.equal(result.length, 2);
    assert.equal(result[0].execution.chain?.step_index, 0);
    assert.equal(result[1].execution.chain?.step_index, 1);
  });
});

// ---------------------------------------------------------------------------
// getSiblings
// ---------------------------------------------------------------------------

describe("execution graph -- getSiblings", () => {
  it("returns all pipeline members when given any member hash", () => {
    const cards = makePipeline("pipe-sib", 3);
    const siblings = getSiblings(cards, cards[1].hash);
    assert.equal(siblings.length, 3);
  });

  it("returns empty for card without pipeline_id", () => {
    const lone = makeCard({ title: "lone" });
    assert.deepStrictEqual(getSiblings([lone], lone.hash), []);
  });

  it("returns empty for unknown hash", () => {
    const cards = makePipeline("pipe-q", 2);
    assert.deepStrictEqual(getSiblings(cards, "nope"), []);
  });
});

// ---------------------------------------------------------------------------
// checkChainIntegrity -- missing parent
// ---------------------------------------------------------------------------

describe("execution graph -- integrity: missing parent", () => {
  it("detects missing parent", () => {
    const child = makeCard({
      title: "orphan-child",
      chain: { parent_execution_id: "deadbeef0000" },
    });
    const issues = checkChainIntegrity([child]);
    const missing = issues.filter((i) => i.kind === "missing_parent");
    assert.equal(missing.length, 1);
    assert.equal(missing[0].hash, child.hash);
    assert.ok(missing[0].detail.includes("deadbeef0000"));
  });

  it("no issue when parent is present", () => {
    const cards = makePipeline("pipe-ok", 2);
    const missing = checkChainIntegrity(cards).filter(
      (i) => i.kind === "missing_parent",
    );
    assert.equal(missing.length, 0);
  });
});

// ---------------------------------------------------------------------------
// checkChainIntegrity -- cycle detection
// ---------------------------------------------------------------------------

describe("execution graph -- integrity: cycle detection", () => {
  it("detects a self-referencing cycle", () => {
    const selfRef = makeCard({
      title: "self-ref",
      chain: { parent_execution_id: "PLACEHOLDER" },
    });
    // Point parent to self
    (selfRef as any).execution.chain.parent_execution_id = selfRef.hash;
    const issues = checkChainIntegrity([selfRef]);
    const cycles = issues.filter((i) => i.kind === "cycle");
    assert.ok(cycles.length >= 1);
  });

  it("detects a 2-node cycle", () => {
    // Create two cards that point to each other
    const a = makeCard({
      title: "cycle-a",
      chain: { parent_execution_id: "PLACEHOLDER_B" },
    });
    const b = makeCard({
      title: "cycle-b",
      chain: { parent_execution_id: a.hash },
    });
    // Now point a's parent to b
    (a as any).execution.chain.parent_execution_id = b.hash;

    const issues = checkChainIntegrity([a, b]);
    const cycles = issues.filter((i) => i.kind === "cycle");
    assert.ok(cycles.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// checkChainIntegrity -- duplicate step_index
// ---------------------------------------------------------------------------

describe("execution graph -- integrity: duplicate step_index", () => {
  it("detects two cards with same step_index in same pipeline", () => {
    const a = makeCard({
      title: "dup-a",
      chain: { pipeline_id: "dup-pipe", step_index: 0 },
    });
    const b = makeCard({
      title: "dup-b",
      chain: { pipeline_id: "dup-pipe", step_index: 0 },
    });
    const issues = checkChainIntegrity([a, b]);
    const dups = issues.filter((i) => i.kind === "duplicate_step_index");
    assert.equal(dups.length, 2); // one per card
    assert.ok(dups[0].detail.includes("step_index=0"));
  });

  it("no issue when step indices are unique", () => {
    const cards = makePipeline("unique-pipe", 3);
    const dups = checkChainIntegrity(cards).filter(
      (i) => i.kind === "duplicate_step_index",
    );
    assert.equal(dups.length, 0);
  });
});

// ---------------------------------------------------------------------------
// checkChainIntegrity -- pipeline contamination
// ---------------------------------------------------------------------------

describe("execution graph -- integrity: pipeline contamination", () => {
  it("detects parent in a different pipeline", () => {
    const parentInA = makeCard({
      title: "parent-in-a",
      chain: { pipeline_id: "pipeline-A", step_index: 0 },
    });
    const childInB = makeCard({
      title: "child-in-b",
      chain: {
        pipeline_id: "pipeline-B",
        step_index: 0,
        parent_execution_id: parentInA.hash,
      },
    });
    const issues = checkChainIntegrity([parentInA, childInB]);
    const contam = issues.filter(
      (i) => i.kind === "pipeline_contamination",
    );
    assert.equal(contam.length, 1);
    assert.equal(contam[0].hash, childInB.hash);
    assert.ok(contam[0].detail.includes("pipeline-A"));
  });

  it("no contamination when parent is in same pipeline", () => {
    const cards = makePipeline("same-pipe", 3);
    const contam = checkChainIntegrity(cards).filter(
      (i) => i.kind === "pipeline_contamination",
    );
    assert.equal(contam.length, 0);
  });
});

// ---------------------------------------------------------------------------
// checkChainIntegrity -- orphan step_index
// ---------------------------------------------------------------------------

describe("execution graph -- integrity: orphan step_index", () => {
  it("detects step_index without pipeline_id", () => {
    const orphan = makeCard({
      title: "orphan-step",
      chain: { step_index: 5 },
    });
    const issues = checkChainIntegrity([orphan]);
    const orphans = issues.filter((i) => i.kind === "orphan_step_index");
    assert.equal(orphans.length, 1);
    assert.ok(orphans[0].detail.includes("step_index=5"));
  });
});

// ---------------------------------------------------------------------------
// getPipelineView
// ---------------------------------------------------------------------------

describe("execution graph -- getPipelineView", () => {
  it("returns ordered steps and empty issues for clean pipeline", () => {
    const cards = makePipeline("view-pipe", 3);
    const view = getPipelineView(cards, "view-pipe");
    assert.ok(view);
    assert.equal(view.pipeline_id, "view-pipe");
    assert.equal(view.steps.length, 3);
    assert.equal(view.issues.length, 0);
  });

  it("returns null for nonexistent pipeline", () => {
    const cards = makePipeline("exists", 2);
    assert.equal(getPipelineView(cards, "nope"), null);
  });

  it("includes issues in the view", () => {
    const a = makeCard({
      title: "dup-view-a",
      chain: { pipeline_id: "dup-view", step_index: 0 },
    });
    const b = makeCard({
      title: "dup-view-b",
      chain: { pipeline_id: "dup-view", step_index: 0 },
    });
    const view = getPipelineView([a, b], "dup-view");
    assert.ok(view);
    assert.ok(view.issues.length > 0);
  });
});

// ---------------------------------------------------------------------------
// listPipelineIds
// ---------------------------------------------------------------------------

describe("execution graph -- listPipelineIds", () => {
  it("returns sorted unique pipeline IDs", () => {
    const a = makeCard({
      title: "lp-a",
      chain: { pipeline_id: "beta" },
    });
    const b = makeCard({
      title: "lp-b",
      chain: { pipeline_id: "alpha" },
    });
    const c = makeCard({
      title: "lp-c",
      chain: { pipeline_id: "beta" },
    });
    const d = makeCard({ title: "no-pipeline" });
    const ids = listPipelineIds([a, b, c, d]);
    assert.deepStrictEqual(ids, ["alpha", "beta"]);
  });

  it("returns empty for cards with no pipeline_id", () => {
    const card = makeCard({ title: "solo" });
    assert.deepStrictEqual(listPipelineIds([card]), []);
  });
});

// ---------------------------------------------------------------------------
// Determinism: results are stable across runs
// ---------------------------------------------------------------------------

describe("execution graph -- determinism", () => {
  it("checkChainIntegrity returns issues in deterministic order", () => {
    const a = makeCard({
      title: "det-a",
      chain: { pipeline_id: "det", step_index: 0 },
    });
    const b = makeCard({
      title: "det-b",
      chain: { pipeline_id: "det", step_index: 0 },
    });
    const c = makeCard({
      title: "det-c",
      chain: { parent_execution_id: "missing123" },
    });
    const issues1 = checkChainIntegrity([a, b, c]);
    const issues2 = checkChainIntegrity([c, b, a]);
    assert.deepStrictEqual(issues1, issues2);
  });
});
