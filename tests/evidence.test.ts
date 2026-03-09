/**
 * Evidence bundle tests — deterministic pipeline evidence extraction,
 * ref collection, integrity summarization, pipeline artifact context.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalHash } from "../src/kb/canonical.js";
import { buildExecutionHashPayload } from "../src/kb/schema.js";
import type { ExecutionCard, ExecutionChain } from "../src/kb/schema.js";
import {
  buildExecutionEvidenceBundle,
  collectPipelineRefs,
  summarizeIntegrityIssues,
  buildPipelineArtifactContext,
} from "../src/kb/evidence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;

function makeCard(opts: {
  title?: string;
  chain?: ExecutionChain;
  inputs?: Array<{ ref_type: "artifact_id" | "url"; value: string }>;
  outputs?: Array<{ ref_type: "artifact_id" | "url"; value: string }>;
}): ExecutionCard {
  counter++;
  const payload = buildExecutionHashPayload({
    title: opts.title ?? `ev-step-${counter}`,
    summary: `Evidence test step ${counter}`,
    execution: {
      kind: "job" as const,
      status: "succeeded" as const,
      actor: { type: "agent" as const, name: "test" },
      target: { type: "tool" as const, name: "test.tool" },
      inputs: (opts.inputs ?? []) as any[],
      outputs: (opts.outputs ?? []) as any[],
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
  const hash = canonicalHash(payload as unknown as Record<string, unknown>);
  return { ...payload, hash };
}

function makePipeline(
  pipelineId: string,
  count: number,
  opts?: {
    inputs?: Array<{ ref_type: "artifact_id" | "url"; value: string }>;
    outputs?: Array<{ ref_type: "artifact_id" | "url"; value: string }>;
  },
): ExecutionCard[] {
  const cards: ExecutionCard[] = [];
  for (let i = 0; i < count; i++) {
    const chain: ExecutionChain = {
      pipeline_id: pipelineId,
      step_index: i,
      ...(i > 0 ? { parent_execution_id: cards[i - 1].hash } : {}),
    };
    cards.push(
      makeCard({
        title: `${pipelineId}-step-${i}`,
        chain,
        inputs: i === 0 ? opts?.inputs : undefined,
        outputs: i === count - 1 ? opts?.outputs : undefined,
      }),
    );
  }
  return cards;
}

// ---------------------------------------------------------------------------
// buildExecutionEvidenceBundle
// ---------------------------------------------------------------------------

describe("evidence -- buildExecutionEvidenceBundle", () => {
  it("returns structured evidence for a pipeline", () => {
    const cards = makePipeline("ev-pipe", 3);
    const bundle = buildExecutionEvidenceBundle("ev-pipe", cards);

    assert.equal(bundle.pipeline_id, "ev-pipe");
    assert.equal(bundle.steps.length, 3);
    assert.equal(bundle.steps[0].step_index, 0);
    assert.equal(bundle.steps[2].step_index, 2);
    assert.ok(bundle.integrity.clean);
    assert.equal(bundle.integrity.issue_count, 0);
  });

  it("includes parent chains for non-root steps", () => {
    const cards = makePipeline("chain-pipe", 3);
    const bundle = buildExecutionEvidenceBundle("chain-pipe", cards);

    // Step 0 has no parent chain (it IS the root)
    assert.ok(!bundle.parent_chains[cards[0].hash]);
    // Step 2 has a chain of 3 (root -> step1 -> step2)
    assert.ok(bundle.parent_chains[cards[2].hash]);
    assert.equal(bundle.parent_chains[cards[2].hash].length, 3);
  });

  it("includes children for parent steps", () => {
    const cards = makePipeline("kids-pipe", 3);
    const bundle = buildExecutionEvidenceBundle("kids-pipe", cards);

    // Step 0 should have step 1 as child
    assert.ok(bundle.children[cards[0].hash]);
    assert.equal(bundle.children[cards[0].hash].length, 1);
    // Last step has no children
    assert.ok(!bundle.children[cards[2].hash]);
  });

  it("returns empty steps for unknown pipeline", () => {
    const cards = makePipeline("exists", 2);
    const bundle = buildExecutionEvidenceBundle("nope", cards);
    assert.equal(bundle.steps.length, 0);
    assert.equal(bundle.evidence_refs.length, 1); // just the pipeline_id ref
  });

  it("evidence refs include pipeline, execution, and artifact refs", () => {
    const cards = makePipeline("ref-pipe", 2, {
      inputs: [{ ref_type: "artifact_id", value: "input-art" }],
      outputs: [{ ref_type: "artifact_id", value: "output-art" }],
    });
    const bundle = buildExecutionEvidenceBundle("ref-pipe", cards);

    const refTypes = new Set(bundle.evidence_refs.map((r) => r.ref_type));
    assert.ok(refTypes.has("pipeline_id"));
    assert.ok(refTypes.has("execution_hash"));
    assert.ok(refTypes.has("artifact_hash"));
  });
});

// ---------------------------------------------------------------------------
// collectPipelineRefs
// ---------------------------------------------------------------------------

describe("evidence -- collectPipelineRefs", () => {
  it("returns sorted deduplicated refs", () => {
    const cards = makePipeline("coll-pipe", 2);
    const refs = collectPipelineRefs("coll-pipe", cards);

    // Should have: 1 pipeline_id + 2 execution_hashes = 3 minimum
    assert.ok(refs.length >= 3);
    // Sorted by ref_type then value
    for (let i = 1; i < refs.length; i++) {
      const cmp = refs[i - 1].ref_type.localeCompare(refs[i].ref_type);
      if (cmp === 0) {
        assert.ok(refs[i - 1].value.localeCompare(refs[i].value) <= 0);
      } else {
        assert.ok(cmp < 0);
      }
    }
  });

  it("deduplicates refs across steps", () => {
    // Two steps referencing the same artifact
    const shared = "shared-artifact-hash";
    const step0 = makeCard({
      title: "dup-ref-0",
      chain: { pipeline_id: "dup-ref", step_index: 0 },
      inputs: [{ ref_type: "artifact_id", value: shared }],
    });
    const step1 = makeCard({
      title: "dup-ref-1",
      chain: { pipeline_id: "dup-ref", step_index: 1 },
      outputs: [{ ref_type: "artifact_id", value: shared }],
    });
    const refs = collectPipelineRefs("dup-ref", [step0, step1]);
    const artRefs = refs.filter(
      (r) => r.ref_type === "artifact_hash" && r.value === shared,
    );
    assert.equal(artRefs.length, 1);
  });
});

// ---------------------------------------------------------------------------
// summarizeIntegrityIssues
// ---------------------------------------------------------------------------

describe("evidence -- summarizeIntegrityIssues", () => {
  it("returns clean summary for valid pipeline", () => {
    const cards = makePipeline("clean-pipe", 3);
    const summary = summarizeIntegrityIssues(cards);
    assert.equal(summary.total_cards, 3);
    assert.equal(summary.issue_count, 0);
    assert.ok(summary.clean);
    assert.equal(summary.issues.length, 0);
  });

  it("returns issues for broken pipeline", () => {
    const orphan = makeCard({
      title: "orphan",
      chain: { parent_execution_id: "nonexistent" },
    });
    const summary = summarizeIntegrityIssues([orphan]);
    assert.equal(summary.clean, false);
    assert.ok(summary.issue_count > 0);
    assert.ok(summary.issues.length > 0);
  });

  it("accepts pre-computed issues", () => {
    const cards = makePipeline("pre-issues", 2);
    const fakeIssues = [{ kind: "cycle" as const, hash: "abc", detail: "test cycle" }];
    const summary = summarizeIntegrityIssues(cards, fakeIssues);
    assert.equal(summary.issue_count, 1);
    assert.equal(summary.clean, false);
  });
});

// ---------------------------------------------------------------------------
// buildPipelineArtifactContext
// ---------------------------------------------------------------------------

describe("evidence -- buildPipelineArtifactContext", () => {
  it("separates input, output, and execution refs", () => {
    const cards = makePipeline("ctx-pipe", 2, {
      inputs: [{ ref_type: "artifact_id", value: "in-art" }],
      outputs: [{ ref_type: "artifact_id", value: "out-art" }],
    });
    const ctx = buildPipelineArtifactContext("ctx-pipe", cards);

    assert.equal(ctx.pipeline_id, "ctx-pipe");
    assert.ok(ctx.input_refs.some((r) => r.value === "in-art"));
    assert.ok(ctx.output_refs.some((r) => r.value === "out-art"));
    assert.equal(ctx.execution_refs.length, 2);
    assert.ok(ctx.integrity.clean);
  });

  it("returns empty refs for unknown pipeline", () => {
    const ctx = buildPipelineArtifactContext("nope", []);
    assert.equal(ctx.input_refs.length, 0);
    assert.equal(ctx.output_refs.length, 0);
    assert.equal(ctx.execution_refs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("evidence -- determinism", () => {
  it("evidence bundle is stable across input order", () => {
    const cards = makePipeline("det-pipe", 3);
    const shuffled = [cards[2], cards[0], cards[1]];

    const a = buildExecutionEvidenceBundle("det-pipe", cards);
    const b = buildExecutionEvidenceBundle("det-pipe", shuffled);

    // Steps should be in same order (sorted by step_index)
    assert.deepStrictEqual(
      a.steps.map((s) => s.hash),
      b.steps.map((s) => s.hash),
    );
    // Evidence refs should be identical
    assert.deepStrictEqual(a.evidence_refs, b.evidence_refs);
  });

  it("pipeline refs are stable across input order", () => {
    const cards = makePipeline("ref-det", 3);
    const shuffled = [cards[2], cards[0], cards[1]];

    const a = collectPipelineRefs("ref-det", cards);
    const b = collectPipelineRefs("ref-det", shuffled);
    assert.deepStrictEqual(a, b);
  });
});
