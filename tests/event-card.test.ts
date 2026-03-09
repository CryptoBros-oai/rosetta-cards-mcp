/**
 * Event card tests — schema validation, hash determinism, prohibited fields,
 * cross-run equivalence, and search ordering (spec §9).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalHash, canonicalize, assertNoProhibitedKeys } from "../src/kb/canonical.js";
import { EventCardSchema, buildEventHashPayload } from "../src/kb/schema.js";
import { scoreArtifact, rankArtifacts } from "../src/kb/search_rank.js";
import type { VaultContext } from "../src/kb/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventBase() {
  return buildEventHashPayload({
    title: "Deployed export preview modal to Pinsets",
    summary: "Added deterministic dry-run export plan preview in TUI before exporting bundles.",
    event: {
      kind: "deployment" as const,
      status: "confirmed" as const,
      severity: "info" as const,
      confidence: 0.95,
      participants: [
        { role: "builder", name: "Claude Code" },
        { role: "reviewer", name: "Brock" },
      ],
      refs: [
        { ref_type: "artifact_id" as const, value: "card_abc123def456" },
      ],
    },
    tags: ["export", "tui", "determinism"],
    rosetta: {
      verb: "Transform" as const,
      polarity: "+" as const,
      weights: { A: 0, C: 0, L: 0, P: 0, T: 1 },
    },
  });
}

function makeEventCard() {
  const base = makeEventBase();
  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  return { ...base, hash };
}

const emptyCtx: VaultContext = {
  activePack: null,
  pinHashes: [],
  policies: { search_boost: 0 },
};

// ---------------------------------------------------------------------------
// §9.1 — Canonicalization stability
// ---------------------------------------------------------------------------

describe("event card — canonicalization stability", () => {
  it("same payload produces identical canonical bytes", () => {
    const a = canonicalize(makeEventBase() as unknown as Record<string, unknown>);
    const b = canonicalize(makeEventBase() as unknown as Record<string, unknown>);
    assert.equal(a, b);
  });

  it("key reordering does not affect canonical output", () => {
    const base = makeEventBase();
    const reordered = {
      tags: base.tags,
      artifact_type: base.artifact_type,
      rosetta: base.rosetta,
      event: base.event,
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
// §9.2 — Hash determinism
// ---------------------------------------------------------------------------

describe("event card — hash determinism", () => {
  it("same payload produces identical hash across multiple calls", () => {
    const hashes = Array.from({ length: 10 }, () =>
      canonicalHash(makeEventBase() as unknown as Record<string, unknown>)
    );
    const unique = new Set(hashes);
    assert.equal(unique.size, 1, `Expected 1 unique hash, got ${unique.size}`);
  });

  it("different title produces different hash", () => {
    const a = makeEventBase();
    const b = { ...makeEventBase(), title: "Different title" };
    const hashA = canonicalHash(a as unknown as Record<string, unknown>);
    const hashB = canonicalHash(b as unknown as Record<string, unknown>);
    assert.notEqual(hashA, hashB);
  });
});

// ---------------------------------------------------------------------------
// §9.3 — Prohibited fields guard
// ---------------------------------------------------------------------------

describe("event card — prohibited fields guard", () => {
  it("rejects occurred_at in hashed payload", () => {
    const card = { ...makeEventCard(), occurred_at: "2026-03-02T20:15:00Z" };
    assert.throws(
      () => EventCardSchema.parse(card),
      /unrecognized_keys/i,
      "EventCardSchema.strict() should reject occurred_at"
    );
  });

  it("rejects created_at in hashed payload", () => {
    const card = { ...makeEventCard(), created_at: "2026-03-02T20:15:00Z" };
    assert.throws(
      () => EventCardSchema.parse(card),
      /unrecognized_keys/i,
      "EventCardSchema.strict() should reject created_at"
    );
  });

  it("rejects source in hashed payload", () => {
    const card = { ...makeEventCard(), source: "system:ci" };
    assert.throws(
      () => EventCardSchema.parse(card),
      /unrecognized_keys/i,
      "EventCardSchema.strict() should reject source"
    );
  });

  it("rejects random extra fields in event block", () => {
    const base = makeEventBase();
    const card = {
      ...base,
      event: { ...base.event, timestamp: "2026-03-02T00:00:00Z" },
      hash: "placeholder",
    };
    assert.throws(
      () => EventCardSchema.parse(card),
      /unrecognized_keys/i,
      "event sub-object should reject unknown fields"
    );
  });

  it("accepts a valid event card", () => {
    const card = makeEventCard();
    const parsed = EventCardSchema.parse(card);
    assert.equal(parsed.artifact_type, "event");
    assert.equal(parsed.schema_version, "event.v1");
  });
});

// ---------------------------------------------------------------------------
// §9.4 — Cross-run equivalence
// ---------------------------------------------------------------------------

describe("event card — cross-run equivalence", () => {
  it("creating same event twice yields identical hash", () => {
    const card1 = makeEventCard();
    const card2 = makeEventCard();
    assert.equal(card1.hash, card2.hash);
  });
});

// ---------------------------------------------------------------------------
// §9.5 — Search ordering regression
// ---------------------------------------------------------------------------

describe("event card — search ordering", () => {
  it("events with identical scores are ordered by artifact_id then title", () => {
    const events = [
      { artifact_id: "card_event_zzz", title: "Zulu event", tags: ["deploy"], hash: "h1" },
      { artifact_id: "card_event_aaa", title: "Alpha event", tags: ["deploy"], hash: "h2" },
      { artifact_id: "card_event_mmm", title: "Mike event", tags: ["deploy"], hash: "h3" },
    ];

    const ranked = rankArtifacts("deploy", events, emptyCtx);
    assert.equal(ranked[0].artifact_id, "card_event_aaa");
    assert.equal(ranked[1].artifact_id, "card_event_mmm");
    assert.equal(ranked[2].artifact_id, "card_event_zzz");
  });

  it("pinned event dominates unpinned", () => {
    const pinnedHash = "pinned_hash_123";
    const ctx: VaultContext = {
      activePack: null,
      pinHashes: [pinnedHash],
      policies: { search_boost: 0 },
    };
    const events = [
      { artifact_id: "card_event_aaa", title: "Unpinned event", tags: ["deploy"], hash: "other" },
      { artifact_id: "card_event_zzz", title: "Pinned event", tags: ["deploy"], hash: pinnedHash },
    ];

    const ranked = rankArtifacts("event", events, ctx);
    assert.equal(ranked[0].artifact_id, "card_event_zzz", "Pinned should rank first");
    assert.equal(ranked[0].pinned, true);
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe("event card — schema validation", () => {
  it("rejects invalid event kind", () => {
    const card = makeEventCard();
    const invalid = { ...card, event: { ...card.event, kind: "invalid_kind" } };
    assert.throws(() => EventCardSchema.parse(invalid));
  });

  it("rejects invalid status", () => {
    const card = makeEventCard();
    const invalid = { ...card, event: { ...card.event, status: "unknown" } };
    assert.throws(() => EventCardSchema.parse(invalid));
  });

  it("rejects invalid severity", () => {
    const card = makeEventCard();
    const invalid = { ...card, event: { ...card.event, severity: "extreme" } };
    assert.throws(() => EventCardSchema.parse(invalid));
  });

  it("rejects confidence out of range", () => {
    const card = makeEventCard();
    const invalid = { ...card, event: { ...card.event, confidence: 1.5 } };
    assert.throws(() => EventCardSchema.parse(invalid));
  });

  it("rejects invalid rosetta verb", () => {
    const card = makeEventCard();
    const invalid = { ...card, rosetta: { ...card.rosetta, verb: "Destroy" } };
    assert.throws(() => EventCardSchema.parse(invalid));
  });

  it("rejects invalid ref_type", () => {
    const card = makeEventCard();
    const invalid = {
      ...card,
      event: {
        ...card.event,
        refs: [{ ref_type: "invalid", value: "abc" }],
      },
    };
    assert.throws(() => EventCardSchema.parse(invalid));
  });
});

// ---------------------------------------------------------------------------
// §9.6 — Prohibited-key tripwire (assertNoProhibitedKeys)
// ---------------------------------------------------------------------------

describe("event card — prohibited-key tripwire", () => {
  it("passes on a clean hash payload", () => {
    const base = makeEventBase();
    assert.doesNotThrow(() => assertNoProhibitedKeys(base));
  });

  for (const key of ["occurred_at", "created_at", "updated_at", "timestamp", "time", "source", "provenance"]) {
    it(`rejects "${key}" at root level`, () => {
      const poisoned = { ...makeEventBase(), [key]: "bad" };
      assert.throws(
        () => assertNoProhibitedKeys(poisoned),
        /Determinism violation.*prohibited key/,
        `Should reject root-level "${key}"`
      );
    });
  }

  it("rejects prohibited key nested inside event block", () => {
    const base = makeEventBase();
    const poisoned = {
      ...base,
      event: { ...base.event, timestamp: "2026-03-02T00:00:00Z" },
    };
    assert.throws(
      () => assertNoProhibitedKeys(poisoned),
      /Determinism violation.*timestamp.*\$\.event\.timestamp/,
      "Should detect nested prohibited key with path"
    );
  });

  it("rejects prohibited key deeply nested in array", () => {
    const base = makeEventBase();
    const poisoned = {
      ...base,
      event: {
        ...base.event,
        participants: [
          { role: "builder", name: "Claude", created_at: "bad" },
        ],
      },
    };
    assert.throws(
      () => assertNoProhibitedKeys(poisoned),
      /Determinism violation.*created_at/,
      "Should detect prohibited key inside array element"
    );
  });
});

// ---------------------------------------------------------------------------
// §9.7 — Prototype pollution vectors
// ---------------------------------------------------------------------------

describe("event card — prototype pollution guards", () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    it(`assertNoProhibitedKeys rejects "${key}" at root`, () => {
      const poisoned = { ...makeEventBase(), [key]: {} };
      assert.throws(
        () => assertNoProhibitedKeys(poisoned),
        /Determinism violation.*prohibited key/,
        `Should reject root-level "${key}"`
      );
    });

    it(`assertNoProhibitedKeys rejects "${key}" nested in event`, () => {
      const base = makeEventBase();
      const poisoned = {
        ...base,
        event: { ...base.event, [key]: "injected" },
      };
      assert.throws(
        () => assertNoProhibitedKeys(poisoned),
        /Determinism violation.*prohibited key/,
        `Should reject nested "${key}"`
      );
    });

    it(`EventCardSchema.strict() rejects "${key}" at root`, () => {
      const card = makeEventCard();
      const poisoned = { ...card, [key]: "injected" };
      assert.throws(
        () => EventCardSchema.parse(poisoned),
        /unrecognized_keys/i,
        `Zod strict should also reject root "${key}"`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// §9.8 — buildEventHashPayload single source of truth
// ---------------------------------------------------------------------------

describe("event card — buildEventHashPayload", () => {
  it("produces only the expected keys", () => {
    const payload = makeEventBase();
    const keys = Object.keys(payload).sort();
    assert.deepEqual(keys, [
      "artifact_type", "event", "rosetta", "schema_version",
      "summary", "tags", "title",
    ]);
  });

  it("hash is identical whether built inline or via builder", () => {
    // Inline assembly (old way)
    const inline = {
      schema_version: "event.v1" as const,
      artifact_type: "event" as const,
      title: "Test",
      summary: "Test summary",
      event: {
        kind: "deployment" as const,
        status: "observed" as const,
        severity: "info" as const,
        confidence: 1,
        participants: [],
        refs: [],
      },
      tags: ["test"],
      rosetta: {
        verb: "Contain" as const,
        polarity: "0" as const,
        weights: { A: 0, C: 1, L: 0, P: 0, T: 0 },
      },
    };

    // Builder assembly (new way)
    const built = buildEventHashPayload({
      title: "Test",
      summary: "Test summary",
      event: {
        kind: "deployment",
        status: "observed",
        severity: "info",
        confidence: 1,
        participants: [],
        refs: [],
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
