/**
 * Execution card tests -- schema validation, hash determinism, prohibited fields,
 * cross-run equivalence, and builder single-source-of-truth (mirroring event card spec S9).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash, canonicalize, assertNoExecutionProhibitedKeys } from "../src/kb/canonical.js";
import {
  ExecutionCardSchema,
  ExecutionCreateInputSchema,
  buildExecutionHashPayload,
} from "../src/kb/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutionBase() {
  return buildExecutionHashPayload({
    title: "Ingested corpus documents via kb.ingest_folder",
    summary: "Batch ingestion of 12 markdown files from research corpus into card system with text extraction.",
    execution: {
      kind: "import" as const,
      status: "succeeded" as const,
      actor: { type: "agent" as const, name: "Claude Code" },
      target: { type: "tool" as const, name: "kb.ingest_folder" },
      inputs: [
        { ref_type: "url" as const, value: "file:///data/research-corpus/" },
      ],
      outputs: [
        { ref_type: "artifact_id" as const, value: "card_report_a1b2c3d4e5f6" },
      ],
      validation: { state: "self_reported" as const, method: "hash_check" as const },
    },
    tags: ["ingestion", "corpus", "batch"],
    rosetta: {
      verb: "Contain" as const,
      polarity: "+" as const,
      weights: { A: 0, C: 1, L: 0, P: 0, T: 0 },
    },
  });
}

function makeExecutionCard() {
  const base = makeExecutionBase();
  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  return { ...base, hash };
}

// ---------------------------------------------------------------------------
// S9.1 -- Canonicalization stability
// ---------------------------------------------------------------------------

describe("execution card -- canonicalization stability", () => {
  it("same payload produces identical canonical bytes", () => {
    const a = canonicalize(makeExecutionBase() as unknown as Record<string, unknown>);
    const b = canonicalize(makeExecutionBase() as unknown as Record<string, unknown>);
    assert.equal(a, b);
  });

  it("key reordering does not affect canonical output", () => {
    const base = makeExecutionBase();
    const reordered = {
      tags: base.tags,
      artifact_type: base.artifact_type,
      rosetta: base.rosetta,
      execution: base.execution,
      schema_version: base.schema_version,
      title: base.title,
      summary: base.summary,
    };
    const a = canonicalize(base as unknown as Record<string, unknown>);
    const b = canonicalize(reordered as unknown as Record<string, unknown>);
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// S9.2 -- Hash determinism
// ---------------------------------------------------------------------------

describe("execution card -- hash determinism", () => {
  it("same payload produces identical hash across multiple calls", () => {
    const hashes = Array.from({ length: 10 }, () =>
      canonicalHash(makeExecutionBase() as unknown as Record<string, unknown>)
    );
    const unique = new Set(hashes);
    assert.equal(unique.size, 1, `Expected 1 unique hash, got ${unique.size}`);
  });

  it("different title produces different hash", () => {
    const a = makeExecutionBase();
    const b = { ...makeExecutionBase(), title: "Different title" };
    const hashA = canonicalHash(a as unknown as Record<string, unknown>);
    const hashB = canonicalHash(b as unknown as Record<string, unknown>);
    assert.notEqual(hashA, hashB);
  });

  it("different status produces different hash", () => {
    const a = makeExecutionBase();
    const b = buildExecutionHashPayload({
      ...a,
      execution: { ...a.execution, status: "failed" as const },
    });
    const hashA = canonicalHash(a as unknown as Record<string, unknown>);
    const hashB = canonicalHash(b as unknown as Record<string, unknown>);
    assert.notEqual(hashA, hashB);
  });
});

// ---------------------------------------------------------------------------
// S9.3 -- Prohibited fields guard
// ---------------------------------------------------------------------------

describe("execution card -- prohibited fields guard", () => {
  it("rejects occurred_at in hashed payload", () => {
    const card = { ...makeExecutionCard(), occurred_at: "2026-03-05T00:00:00Z" };
    assert.throws(
      () => ExecutionCardSchema.parse(card),
      /unrecognized_keys/i,
      "ExecutionCardSchema.strict() should reject occurred_at"
    );
  });

  it("rejects created_at in hashed payload", () => {
    const card = { ...makeExecutionCard(), created_at: "2026-03-05T00:00:00Z" };
    assert.throws(
      () => ExecutionCardSchema.parse(card),
      /unrecognized_keys/i,
      "ExecutionCardSchema.strict() should reject created_at"
    );
  });

  it("rejects duration_ms in hashed payload", () => {
    const card = { ...makeExecutionCard(), duration_ms: 1234 };
    assert.throws(
      () => ExecutionCardSchema.parse(card),
      /unrecognized_keys/i,
      "ExecutionCardSchema.strict() should reject duration_ms"
    );
  });

  it("rejects runtime in hashed payload", () => {
    const card = { ...makeExecutionCard(), runtime: "node20" };
    assert.throws(
      () => ExecutionCardSchema.parse(card),
      /unrecognized_keys/i,
      "ExecutionCardSchema.strict() should reject runtime"
    );
  });

  it("rejects random extra fields in execution block", () => {
    const base = makeExecutionBase();
    const card = {
      ...base,
      execution: { ...base.execution, timestamp: "2026-03-05T00:00:00Z" },
      hash: "placeholder",
    };
    assert.throws(
      () => ExecutionCardSchema.parse(card),
      /unrecognized_keys/i,
      "execution sub-object should reject unknown fields"
    );
  });

  it("accepts a valid execution card", () => {
    const card = makeExecutionCard();
    const parsed = ExecutionCardSchema.parse(card);
    assert.equal(parsed.artifact_type, "execution");
    assert.equal(parsed.schema_version, "execution.v1");
  });
});

// ---------------------------------------------------------------------------
// S9.4 -- Cross-run equivalence
// ---------------------------------------------------------------------------

describe("execution card -- cross-run equivalence", () => {
  it("creating same execution twice yields identical hash", () => {
    const card1 = makeExecutionCard();
    const card2 = makeExecutionCard();
    assert.equal(card1.hash, card2.hash);
  });

  it("non-hashed metadata differences do not change identity", () => {
    // Two executions with identical canonical payloads should hash the same,
    // even if sidecar metadata would differ (occurred_at, duration_ms, etc.)
    const base1 = makeExecutionBase();
    const base2 = makeExecutionBase();
    const hash1 = canonicalHash(base1 as unknown as Record<string, unknown>);
    const hash2 = canonicalHash(base2 as unknown as Record<string, unknown>);
    assert.equal(hash1, hash2);
  });
});

// ---------------------------------------------------------------------------
// S9.5 -- Golden fixture
// ---------------------------------------------------------------------------

describe("execution card -- golden fixture", () => {
  it("matches expected hash from golden fixture", () => {
    const fixturePath = join(import.meta.dirname ?? __dirname, "fixtures", "golden-execution.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
    const { expected_hash, ...payload } = fixture;
    const computed = canonicalHash(payload as Record<string, unknown>);
    assert.equal(computed, expected_hash, "Golden fixture hash mismatch");
  });

  it("builder produces same hash as golden fixture", () => {
    const fixturePath = join(import.meta.dirname ?? __dirname, "fixtures", "golden-execution.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
    const built = buildExecutionHashPayload({
      title: fixture.title,
      summary: fixture.summary,
      execution: fixture.execution,
      tags: fixture.tags,
      rosetta: fixture.rosetta,
    });
    const hash = canonicalHash(built as unknown as Record<string, unknown>);
    assert.equal(hash, fixture.expected_hash, "Builder should produce golden hash");
  });
});

// ---------------------------------------------------------------------------
// S9.6 -- Prohibited-key tripwire (assertNoExecutionProhibitedKeys)
// ---------------------------------------------------------------------------

describe("execution card -- prohibited-key tripwire", () => {
  it("passes on a clean hash payload", () => {
    const base = makeExecutionBase();
    assert.doesNotThrow(() => assertNoExecutionProhibitedKeys(base));
  });

  for (const key of [
    "occurred_at", "created_at", "updated_at", "timestamp", "time",
    "source", "provenance", "runtime", "duration_ms", "cost_estimate",
    "hostname", "cwd", "pid", "env",
  ]) {
    it(`rejects "${key}" at root level`, () => {
      const poisoned = { ...makeExecutionBase(), [key]: "bad" };
      assert.throws(
        () => assertNoExecutionProhibitedKeys(poisoned),
        /Determinism violation.*prohibited key/,
        `Should reject root-level "${key}"`
      );
    });
  }

  it("rejects prohibited key nested inside execution block", () => {
    const base = makeExecutionBase();
    const poisoned = {
      ...base,
      execution: { ...base.execution, timestamp: "2026-03-05T00:00:00Z" },
    };
    assert.throws(
      () => assertNoExecutionProhibitedKeys(poisoned),
      /Determinism violation.*timestamp.*\$\.execution\.timestamp/,
      "Should detect nested prohibited key with path"
    );
  });

  it("rejects prohibited key deeply nested in inputs array", () => {
    const base = makeExecutionBase();
    const poisoned = {
      ...base,
      execution: {
        ...base.execution,
        inputs: [
          { ref_type: "artifact_id", value: "abc", created_at: "bad" },
        ],
      },
    };
    assert.throws(
      () => assertNoExecutionProhibitedKeys(poisoned),
      /Determinism violation.*created_at/,
      "Should detect prohibited key inside array element"
    );
  });
});

// ---------------------------------------------------------------------------
// S9.7 -- Prototype pollution vectors
// ---------------------------------------------------------------------------

describe("execution card -- prototype pollution guards", () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    it(`assertNoExecutionProhibitedKeys rejects "${key}" at root`, () => {
      const poisoned = { ...makeExecutionBase(), [key]: {} };
      assert.throws(
        () => assertNoExecutionProhibitedKeys(poisoned),
        /Determinism violation.*prohibited key/,
        `Should reject root-level "${key}"`
      );
    });

    it(`assertNoExecutionProhibitedKeys rejects "${key}" nested in execution`, () => {
      const base = makeExecutionBase();
      const poisoned = {
        ...base,
        execution: { ...base.execution, [key]: "injected" },
      };
      assert.throws(
        () => assertNoExecutionProhibitedKeys(poisoned),
        /Determinism violation.*prohibited key/,
        `Should reject nested "${key}"`
      );
    });

    it(`ExecutionCardSchema.strict() rejects "${key}" at root`, () => {
      const card = makeExecutionCard();
      const poisoned = { ...card, [key]: "injected" };
      assert.throws(
        () => ExecutionCardSchema.parse(poisoned),
        /unrecognized_keys/i,
        `Zod strict should also reject root "${key}"`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// S9.8 -- buildExecutionHashPayload single source of truth
// ---------------------------------------------------------------------------

describe("execution card -- buildExecutionHashPayload", () => {
  it("produces only the expected keys", () => {
    const payload = makeExecutionBase();
    const keys = Object.keys(payload).sort();
    assert.deepEqual(keys, [
      "artifact_type", "execution", "rosetta", "schema_version",
      "summary", "tags", "title",
    ]);
  });

  it("hash is identical whether built inline or via builder", () => {
    const inline = {
      schema_version: "execution.v1" as const,
      artifact_type: "execution" as const,
      title: "Test execution",
      summary: "Test summary",
      execution: {
        kind: "tool_call" as const,
        status: "succeeded" as const,
        actor: { type: "agent" as const, name: "test" },
        target: { type: "tool" as const, name: "test_tool" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated" as const, method: "none" as const },
      },
      tags: ["test"],
      rosetta: {
        verb: "Contain" as const,
        polarity: "0" as const,
        weights: { A: 0, C: 1, L: 0, P: 0, T: 0 },
      },
    };

    const built = buildExecutionHashPayload({
      title: "Test execution",
      summary: "Test summary",
      execution: {
        kind: "tool_call",
        status: "succeeded",
        actor: { type: "agent", name: "test" },
        target: { type: "tool", name: "test_tool" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
      },
      tags: ["test"],
      rosetta: {
        verb: "Contain",
        polarity: "0",
        weights: { A: 0, C: 1, L: 0, P: 0, T: 0 },
      },
    });

    const hashInline = canonicalHash(inline as unknown as Record<string, unknown>);
    const hashBuilt = canonicalHash(built as unknown as Record<string, unknown>);
    assert.equal(hashInline, hashBuilt, "Builder must produce hash-identical output to inline");
  });
});

// ---------------------------------------------------------------------------
// Input boundary -- ExecutionCreateInputSchema
// ---------------------------------------------------------------------------

describe("execution card -- input schema boundary", () => {
  it("rejects temporal fields at root", () => {
    const input = {
      title: "test",
      summary: "test",
      execution: {
        kind: "job",
        status: "succeeded",
        actor: { type: "agent", name: "test" },
        target: { type: "tool", name: "test" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
      occurred_at: "2026-03-05T00:00:00Z",
    };
    assert.throws(
      () => ExecutionCreateInputSchema.parse(input),
      /unrecognized_keys/i,
      "Should reject occurred_at in input"
    );
  });

  it("rejects runtime fields at root", () => {
    const input = {
      title: "test",
      summary: "test",
      execution: {
        kind: "job",
        status: "succeeded",
        actor: { type: "agent", name: "test" },
        target: { type: "tool", name: "test" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
      duration_ms: 1234,
    };
    assert.throws(
      () => ExecutionCreateInputSchema.parse(input),
      /unrecognized_keys/i,
      "Should reject duration_ms in input"
    );
  });

  it("accepts valid input", () => {
    const input = {
      title: "test",
      summary: "test",
      execution: {
        kind: "job",
        status: "succeeded",
        actor: { type: "agent", name: "test" },
        target: { type: "tool", name: "test" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
    };
    assert.doesNotThrow(() => ExecutionCreateInputSchema.parse(input));
  });

  it("rejects invalid execution kind", () => {
    const input = {
      title: "test",
      summary: "test",
      execution: {
        kind: "invalid_kind",
        status: "succeeded",
        actor: { type: "agent", name: "test" },
        target: { type: "tool", name: "test" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
    };
    assert.throws(() => ExecutionCreateInputSchema.parse(input));
  });

  it("rejects invalid actor type", () => {
    const input = {
      title: "test",
      summary: "test",
      execution: {
        kind: "job",
        status: "succeeded",
        actor: { type: "robot", name: "test" },
        target: { type: "tool", name: "test" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
    };
    assert.throws(() => ExecutionCreateInputSchema.parse(input));
  });

  it("accepts valid input with chain fields", () => {
    const input = {
      title: "test",
      summary: "test",
      execution: {
        kind: "validation",
        status: "validated",
        actor: { type: "system", name: "checker" },
        target: { type: "artifact", name: "card_123" },
        inputs: [],
        outputs: [],
        validation: { state: "verified", method: "hash_check" },
        chain: {
          pipeline_id: "pipe-1",
          step_index: 1,
          parent_execution_id: "abc123",
          related_execution_ids: ["def456"],
        },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
    };
    assert.doesNotThrow(() => ExecutionCreateInputSchema.parse(input));
  });

  it("rejects unknown keys inside chain", () => {
    const input = {
      title: "test",
      summary: "test",
      execution: {
        kind: "job",
        status: "succeeded",
        actor: { type: "agent", name: "test" },
        target: { type: "tool", name: "test" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
        chain: { pipeline_id: "pipe-1", unknown_field: "bad" },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
    };
    assert.throws(
      () => ExecutionCreateInputSchema.parse(input),
      /unrecognized_keys/i,
      "Chain sub-object should reject unknown keys"
    );
  });
});

// ---------------------------------------------------------------------------
// Execution chain -- golden fixture
// ---------------------------------------------------------------------------

describe("execution card -- chain golden fixture", () => {
  it("all 3 pipeline steps match expected hashes", () => {
    const fixturePath = join(import.meta.dirname ?? __dirname, "fixtures", "golden-execution-chain.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

    for (let i = 0; i < fixture.steps.length; i++) {
      const { expected_hash, ...payload } = fixture.steps[i];
      const computed = canonicalHash(payload as Record<string, unknown>);
      assert.equal(computed, expected_hash, `Step ${i} hash mismatch`);
    }
  });

  it("chain fields affect identity (with vs without chain)", () => {
    const withChain = buildExecutionHashPayload({
      title: "Test",
      summary: "Test",
      execution: {
        kind: "job",
        status: "succeeded",
        actor: { type: "agent", name: "test" },
        target: { type: "tool", name: "test" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
        chain: { pipeline_id: "pipe-1", step_index: 0 },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
    });

    const withoutChain = buildExecutionHashPayload({
      title: "Test",
      summary: "Test",
      execution: {
        kind: "job",
        status: "succeeded",
        actor: { type: "agent", name: "test" },
        target: { type: "tool", name: "test" },
        inputs: [],
        outputs: [],
        validation: { state: "unvalidated", method: "none" },
      },
      tags: ["test"],
      rosetta: { verb: "Contain", polarity: "0", weights: { A: 0, C: 1, L: 0, P: 0, T: 0 } },
    });

    const hashWith = canonicalHash(withChain as unknown as Record<string, unknown>);
    const hashWithout = canonicalHash(withoutChain as unknown as Record<string, unknown>);
    assert.notEqual(hashWith, hashWithout, "Chain fields must affect identity");
  });

  it("parent_execution_id links are consistent across chain", () => {
    const fixturePath = join(import.meta.dirname ?? __dirname, "fixtures", "golden-execution-chain.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

    // Step 1's parent should be step 0's hash
    assert.equal(
      fixture.steps[1].execution.chain.parent_execution_id,
      fixture.steps[0].expected_hash,
      "Step 1 parent should reference step 0"
    );

    // Step 2's parent should be step 1's hash
    assert.equal(
      fixture.steps[2].execution.chain.parent_execution_id,
      fixture.steps[1].expected_hash,
      "Step 2 parent should reference step 1"
    );

    // Step 2's related should include step 0's hash
    assert.ok(
      fixture.steps[2].execution.chain.related_execution_ids.includes(fixture.steps[0].expected_hash),
      "Step 2 related should include step 0"
    );
  });
});
