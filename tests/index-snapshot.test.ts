/**
 * Cortex Index Snapshot tests — Prompt 3
 *
 * Uses an isolated temp vault per describe block so tests don't pollute
 * or depend on real data. rebuildIndex() and loadIndexSnapshot() both
 * accept vaultRoot so no env mutation is needed.
 *
 * Covers:
 *   - IndexSnapshotV1Schema strictness
 *   - rebuildIndex: deterministic ordering (same inputs → identical bytes, modulo built_at)
 *   - by_hash pointers present and correct
 *   - tag index stable and sorted
 *   - rosetta index populated for events
 *   - time index sorted ascending by occurred_at from meta sidecars
 *   - meta count reflects sidecars found
 *   - loadIndexSnapshot: null before rebuild, data after
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { IndexSnapshotV1Schema, buildEventHashPayload } from "../src/kb/schema.js";
import { canonicalHash } from "../src/kb/canonical.js";
import { rebuildIndex, loadIndexSnapshot } from "../src/kb/index.js";

// ---------------------------------------------------------------------------
// Isolated vault helpers
// ---------------------------------------------------------------------------

async function makeVault(): Promise<string> {
  const dir = path.join(os.tmpdir(), `rosetta-test-${crypto.randomUUID()}`);
  await fs.mkdir(path.join(dir, "data", "cards"), { recursive: true });
  await fs.mkdir(path.join(dir, "data", "events"), { recursive: true });
  await fs.mkdir(path.join(dir, "data", "index"), { recursive: true });
  return dir;
}

async function rmVault(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeCardPayload(seed: string) {
  const base = {
    version: "card.v1",
    card_id: `card_${seed}`,
    title: `Card ${seed}`,
    bullets: [`Bullet for ${seed}`],
    tags: ["test", seed],
    sources: [{ doc_id: `doc_${seed}` }],
    created_at: "2024-01-01T00:00:00Z",
  };
  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  return { ...base, hash };
}

function makeEventPayload(
  seed: string,
  verb: "Attract" | "Contain" | "Release" | "Repel" | "Transform",
  polarity: "+" | "0" | "-",
) {
  const base = buildEventHashPayload({
    title: `Event ${seed}`,
    summary: `Summary of ${seed}`,
    event: {
      kind: "deployment" as const,
      status: "confirmed" as const,
      severity: "info" as const,
      confidence: 0.9,
      participants: [],
      refs: [],
    },
    tags: ["event", seed],
    rosetta: { verb, polarity, weights: { A: 0, C: 0, L: 0, P: 0, T: 1 } },
  });
  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  return { ...base, hash };
}

function metaFor(
  vaultRoot: string,
  artifactType: "card" | "event",
  hash: string,
): string {
  const h12 = hash.slice(0, 12);
  if (artifactType === "event") {
    return path.join(vaultRoot, "data", "events", `card_event_${h12}.meta.json`);
  }
  return path.join(vaultRoot, "data", "cards", `card_${h12}.meta.json`);
}

// ---------------------------------------------------------------------------
// Schema strictness — no FS needed
// ---------------------------------------------------------------------------

describe("IndexSnapshotV1Schema — strict validation", () => {
  const minimal = {
    schema_version: "index_snapshot.v1",
    built_at: "2024-06-15T10:00:00Z",
    counts: { cards: 0, events: 0, metas: 0 },
    by_hash: {},
    tags: {},
    rosetta: { verb: {}, polarity: {} },
    time: { occurred_at: [] },
  };

  it("accepts a minimal valid snapshot", () => {
    assert.doesNotThrow(() => IndexSnapshotV1Schema.parse(minimal));
  });

  it("rejects unknown root key", () => {
    assert.throws(
      () => IndexSnapshotV1Schema.parse({ ...minimal, extra: "nope" }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in counts", () => {
    assert.throws(
      () =>
        IndexSnapshotV1Schema.parse({
          ...minimal,
          counts: { cards: 0, events: 0, metas: 0, other: 1 },
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in by_hash entry", () => {
    assert.throws(
      () =>
        IndexSnapshotV1Schema.parse({
          ...minimal,
          by_hash: { abc: { artifact_type: "card", path: "x.json", extra: true } },
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in rosetta", () => {
    assert.throws(
      () =>
        IndexSnapshotV1Schema.parse({
          ...minimal,
          rosetta: { verb: {}, polarity: {}, extra: {} },
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in time.occurred_at entry", () => {
    assert.throws(
      () =>
        IndexSnapshotV1Schema.parse({
          ...minimal,
          time: {
            occurred_at: [{ hash: "abc", occurred_at: "2024-01-01T00:00:00Z", bad: true }],
          },
        }),
      /unrecognized_keys/,
    );
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — basic correctness
// ---------------------------------------------------------------------------

describe("rebuildIndex — basic correctness", () => {
  let vaultRoot: string;
  let cardA: ReturnType<typeof makeCardPayload>;
  let cardB: ReturnType<typeof makeCardPayload>;
  let event1: ReturnType<typeof makeEventPayload>;

  before(async () => {
    vaultRoot = await makeVault();
    cardA = makeCardPayload("alpha");
    cardB = makeCardPayload("beta");
    event1 = makeEventPayload("ev1", "Transform", "+");

    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_${cardA.hash.slice(0, 12)}.json`),
      cardA,
    );
    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_${cardB.hash.slice(0, 12)}.json`),
      cardB,
    );
    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_event_${event1.hash.slice(0, 12)}.json`),
      event1,
    );
  });

  after(() => rmVault(vaultRoot));

  it("snapshot validates against IndexSnapshotV1Schema", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.doesNotThrow(() => IndexSnapshotV1Schema.parse(snap));
  });

  it("counts: 2 cards, 1 event, 0 metas", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.equal(snap.counts.cards, 2);
    assert.equal(snap.counts.events, 1);
    assert.equal(snap.counts.metas, 0);
  });

  it("by_hash has entries for all three artifacts", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.equal(Object.keys(snap.by_hash).length, 3);
  });

  it("by_hash card entry has artifact_type 'card'", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.equal(snap.by_hash[cardA.hash]?.artifact_type, "card");
    assert.ok(snap.by_hash[cardA.hash].path.includes("data/cards"));
  });

  it("by_hash event entry has artifact_type 'event'", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.equal(snap.by_hash[event1.hash]?.artifact_type, "event");
  });

  it("tag 'test' contains both card hashes, sorted", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    const testHashes = snap.tags["test"];
    assert.ok(Array.isArray(testHashes));
    assert.equal(testHashes.length, 2);
    assert.deepEqual(testHashes, [...testHashes].sort());
  });

  it("rosetta.verb['Transform'] contains event hash", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.ok(snap.rosetta.verb["Transform"]?.includes(event1.hash));
  });

  it("rosetta.polarity['+'] contains event hash", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.ok(snap.rosetta.polarity["+"]?.includes(event1.hash));
  });

  it("time.occurred_at is empty when no metas have occurred_at", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.equal(snap.time.occurred_at.length, 0);
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — meta sidecar integration
// ---------------------------------------------------------------------------

describe("rebuildIndex — meta sidecar integration", () => {
  let vaultRoot: string;
  let cardA: ReturnType<typeof makeCardPayload>;
  let cardB: ReturnType<typeof makeCardPayload>;

  before(async () => {
    vaultRoot = await makeVault();
    cardA = makeCardPayload("metaA");
    cardB = makeCardPayload("metaB");

    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_${cardA.hash.slice(0, 12)}.json`),
      cardA,
    );
    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_${cardB.hash.slice(0, 12)}.json`),
      cardB,
    );

    // cardA meta: later date
    await writeJson(metaFor(vaultRoot, "card", cardA.hash), {
      schema_version: "meta.v1",
      artifact_hash: cardA.hash,
      artifact_type: "card",
      occurred_at: "2024-03-01T00:00:00Z",
      sources: [{ kind: "url", value: "http://example.com" }],
    });
    // cardB meta: earlier date
    await writeJson(metaFor(vaultRoot, "card", cardB.hash), {
      schema_version: "meta.v1",
      artifact_hash: cardB.hash,
      artifact_type: "card",
      occurred_at: "2024-01-15T00:00:00Z",
    });
  });

  after(() => rmVault(vaultRoot));

  it("metas count is 2", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.equal(snap.counts.metas, 2);
  });

  it("by_hash entry with meta includes meta_path", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.ok(snap.by_hash[cardA.hash]?.meta_path?.endsWith(".meta.json"));
  });

  it("by_hash entry without meta has no meta_path", async () => {
    const cardC = makeCardPayload("noMeta");
    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_${cardC.hash.slice(0, 12)}.json`),
      cardC,
    );
    const snap = await rebuildIndex({ vaultRoot });
    assert.equal(snap.by_hash[cardC.hash]?.meta_path, undefined);
  });

  it("time.occurred_at sorted ascending, cardB (earlier) first", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    assert.ok(snap.time.occurred_at.length >= 2);
    for (let i = 1; i < snap.time.occurred_at.length; i++) {
      assert.ok(
        snap.time.occurred_at[i - 1].occurred_at <=
          snap.time.occurred_at[i].occurred_at,
      );
    }
    // cardB has Jan, cardA has Mar
    const hashes = snap.time.occurred_at.map((e) => e.hash);
    const bIdx = hashes.indexOf(cardB.hash);
    const aIdx = hashes.indexOf(cardA.hash);
    assert.ok(bIdx < aIdx, "cardB (earlier date) should appear before cardA");
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

describe("rebuildIndex — determinism", () => {
  let vaultRoot: string;

  before(async () => {
    vaultRoot = await makeVault();
    const FROZEN = "2024-06-15T12:00:00Z";
    for (const seed of ["z_last", "a_first", "m_mid"]) {
      const c = makeCardPayload(seed);
      await writeJson(
        path.join(vaultRoot, "data", "cards", `card_${c.hash.slice(0, 12)}.json`),
        c,
      );
    }
    const ev1 = makeEventPayload("ev1", "Attract", "+");
    const ev2 = makeEventPayload("ev2", "Contain", "0");
    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_event_${ev1.hash.slice(0, 12)}.json`),
      ev1,
    );
    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_event_${ev2.hash.slice(0, 12)}.json`),
      ev2,
    );
    // Prime with first rebuild (unused, just ensures file exists)
    await rebuildIndex({ vaultRoot, built_at: FROZEN });
  });

  after(() => rmVault(vaultRoot));

  it("two rebuilds with same built_at produce identical JSON bytes", async () => {
    const FROZEN = "2024-06-15T12:00:00Z";
    const s1 = await rebuildIndex({ vaultRoot, built_at: FROZEN });
    const s2 = await rebuildIndex({ vaultRoot, built_at: FROZEN });
    assert.equal(
      JSON.stringify(s1, null, 2),
      JSON.stringify(s2, null, 2),
    );
  });

  it("all tag lists are sorted", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    for (const [tag, hashes] of Object.entries(snap.tags)) {
      assert.deepEqual(hashes, [...hashes].sort(), `tag "${tag}" should be sorted`);
    }
  });

  it("rosetta verb and polarity lists are sorted", async () => {
    const snap = await rebuildIndex({ vaultRoot });
    for (const [k, v] of Object.entries(snap.rosetta.verb)) {
      assert.deepEqual(v, [...v].sort(), `rosetta.verb["${k}"] should be sorted`);
    }
    for (const [k, v] of Object.entries(snap.rosetta.polarity)) {
      assert.deepEqual(v, [...v].sort(), `rosetta.polarity["${k}"] should be sorted`);
    }
  });

  it("counts are stable across rebuilds", async () => {
    const s1 = await rebuildIndex({ vaultRoot });
    const s2 = await rebuildIndex({ vaultRoot });
    assert.deepEqual(s1.counts, s2.counts);
  });
});

// ---------------------------------------------------------------------------
// loadIndexSnapshot
// ---------------------------------------------------------------------------

describe("loadIndexSnapshot", () => {
  let vaultRoot: string;

  before(async () => { vaultRoot = await makeVault(); });
  after(() => rmVault(vaultRoot));

  it("returns null before any rebuild", async () => {
    const result = await loadIndexSnapshot(vaultRoot);
    assert.equal(result, null);
  });

  it("returns snapshot after rebuild", async () => {
    const card = makeCardPayload("load_test");
    await writeJson(
      path.join(vaultRoot, "data", "cards", `card_${card.hash.slice(0, 12)}.json`),
      card,
    );
    const built = await rebuildIndex({ vaultRoot });
    const loaded = await loadIndexSnapshot(vaultRoot);
    assert.ok(loaded);
    assert.equal(loaded!.schema_version, "index_snapshot.v1");
    assert.deepEqual(loaded!.counts, built.counts);
  });
});
