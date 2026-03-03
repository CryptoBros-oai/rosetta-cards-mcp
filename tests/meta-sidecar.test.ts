/**
 * Meta sidecar tests:
 *   - Strict rejection of unknown keys at root + nested
 *   - Deterministic merge behavior (order independent, union stable)
 *   - Path correctness
 *   - Embeddings merge by (model, dims, embedding_id?)
 *   - Ingest deep merge
 *   - loadMeta / deleteMeta round-trip
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { MetaV1Schema, type MetaV1 } from "../src/kb/schema.js";
import { loadMeta, mergeMeta, deleteMeta, getMetaPath } from "../src/kb/vault.js";

const HASH_A = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const HASH_B = "1111112222223333334444445555556666667777888899990000aaabbbcccddd";

// ---------------------------------------------------------------------------
// Schema strictness
// ---------------------------------------------------------------------------

describe("MetaV1Schema — strict rejection", () => {
  it("rejects unknown keys at root", () => {
    assert.throws(
      () =>
        MetaV1Schema.parse({
          schema_version: "meta.v1",
          artifact_hash: HASH_A,
          artifact_type: "card",
          extra_field: "should reject",
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown keys in ingest", () => {
    assert.throws(
      () =>
        MetaV1Schema.parse({
          schema_version: "meta.v1",
          artifact_hash: HASH_A,
          artifact_type: "card",
          ingest: { pipeline: "test", extra: "nope" },
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown keys in annotations", () => {
    assert.throws(
      () =>
        MetaV1Schema.parse({
          schema_version: "meta.v1",
          artifact_hash: HASH_A,
          artifact_type: "card",
          annotations: { notes: "ok", danger: true },
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown keys in sources entry", () => {
    assert.throws(
      () =>
        MetaV1Schema.parse({
          schema_version: "meta.v1",
          artifact_hash: HASH_A,
          artifact_type: "card",
          sources: [{ kind: "url", value: "http://x.com", extra: true }],
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown keys in embeddings entry", () => {
    assert.throws(
      () =>
        MetaV1Schema.parse({
          schema_version: "meta.v1",
          artifact_hash: HASH_A,
          artifact_type: "card",
          embeddings: [{ model: "ada", dims: 1536, status: "present", extra: 1 }],
        }),
      /unrecognized_keys/,
    );
  });

  it("accepts a valid minimal meta", () => {
    const result = MetaV1Schema.parse({
      schema_version: "meta.v1",
      artifact_hash: HASH_A,
      artifact_type: "event",
    });
    assert.equal(result.schema_version, "meta.v1");
  });

  it("accepts a fully-populated meta", () => {
    const result = MetaV1Schema.parse({
      schema_version: "meta.v1",
      artifact_hash: HASH_A,
      artifact_type: "card",
      occurred_at: "2024-06-15T10:30:00Z",
      sources: [{ kind: "url", value: "https://example.com" }],
      ingest: {
        pipeline: "docx-v1",
        extractor: "mammoth",
        chunker: "paragraph",
        stats: { pages: 10, words: 5000 },
      },
      embeddings: [
        { model: "text-embedding-3-small", dims: 1536, status: "present", updated_at: "2024-06-15T10:30:00Z" },
      ],
      annotations: { notes: "reviewed", meta_tags: ["important", "flagged"] },
    });
    assert.equal(result.sources!.length, 1);
    assert.equal(result.ingest!.stats!.pages, 10);
  });
});

// ---------------------------------------------------------------------------
// Path correctness
// ---------------------------------------------------------------------------

describe("getMetaPath — path correctness", () => {
  it("card meta goes to data/cards/card_<hash12>.meta.json", () => {
    const p = getMetaPath("card", HASH_A);
    assert.ok(p.endsWith(`card_${HASH_A.slice(0, 12)}.meta.json`));
    assert.ok(p.includes(path.join("data", "cards")));
  });

  it("event meta goes to data/events/card_event_<hash12>.meta.json", () => {
    const p = getMetaPath("event", HASH_A);
    assert.ok(p.endsWith(`card_event_${HASH_A.slice(0, 12)}.meta.json`));
    assert.ok(p.includes(path.join("data", "events")));
  });

  it("different hashes produce different paths", () => {
    const pa = getMetaPath("card", HASH_A);
    const pb = getMetaPath("card", HASH_B);
    assert.notEqual(pa, pb);
  });
});

// ---------------------------------------------------------------------------
// FS round-trip: load / merge / delete
// ---------------------------------------------------------------------------

describe("meta FS operations", () => {
  before(async () => {
    // Ensure directories exist
    await fs.mkdir(path.dirname(getMetaPath("card", HASH_A)), { recursive: true });
    await fs.mkdir(path.dirname(getMetaPath("event", HASH_A)), { recursive: true });
  });

  after(async () => {
    // Clean up any test artifacts
    await deleteMeta(HASH_A, "card");
    await deleteMeta(HASH_A, "event");
    await deleteMeta(HASH_B, "card");
  });

  it("loadMeta returns null when no file exists", async () => {
    await deleteMeta(HASH_B, "card");
    const meta = await loadMeta(HASH_B, "card");
    assert.equal(meta, null);
  });

  it("mergeMeta creates new meta from scratch", async () => {
    await deleteMeta(HASH_A, "card");
    const result = await mergeMeta(HASH_A, "card", {
      occurred_at: "2024-01-01T00:00:00Z",
      sources: [{ kind: "url", value: "http://example.com" }],
    });
    assert.equal(result.schema_version, "meta.v1");
    assert.equal(result.artifact_hash, HASH_A);
    assert.equal(result.artifact_type, "card");
    assert.equal(result.occurred_at, "2024-01-01T00:00:00Z");
    assert.equal(result.sources!.length, 1);
  });

  it("loadMeta reads back what mergeMeta wrote", async () => {
    await deleteMeta(HASH_A, "card");
    await mergeMeta(HASH_A, "card", {
      sources: [{ kind: "file", value: "report.pdf" }],
    });
    const loaded = await loadMeta(HASH_A, "card");
    assert.ok(loaded);
    assert.equal(loaded!.sources![0].value, "report.pdf");
  });

  it("deleteMeta removes the file", async () => {
    await mergeMeta(HASH_A, "card", {});
    await deleteMeta(HASH_A, "card");
    const loaded = await loadMeta(HASH_A, "card");
    assert.equal(loaded, null);
  });
});

// ---------------------------------------------------------------------------
// Deterministic merge behavior
// ---------------------------------------------------------------------------

describe("mergeMeta — deterministic merge", () => {
  before(async () => {
    await fs.mkdir(path.dirname(getMetaPath("card", HASH_A)), { recursive: true });
  });

  after(async () => {
    await deleteMeta(HASH_A, "card");
  });

  it("sources: union by (kind, value) — no duplicates", async () => {
    await deleteMeta(HASH_A, "card");
    await mergeMeta(HASH_A, "card", {
      sources: [
        { kind: "url", value: "http://a.com" },
        { kind: "note", value: "manual entry" },
      ],
    });
    const result = await mergeMeta(HASH_A, "card", {
      sources: [
        { kind: "url", value: "http://a.com" }, // duplicate
        { kind: "url", value: "http://b.com" }, // new
      ],
    });
    assert.equal(result.sources!.length, 3);
    const values = result.sources!.map((s) => s.value).sort();
    assert.deepEqual(values, ["http://a.com", "http://b.com", "manual entry"]);
  });

  it("sources: same kind different value are distinct", async () => {
    await deleteMeta(HASH_A, "card");
    const result = await mergeMeta(HASH_A, "card", {
      sources: [
        { kind: "url", value: "http://a.com" },
        { kind: "url", value: "http://b.com" },
      ],
    });
    assert.equal(result.sources!.length, 2);
  });

  it("sources: same value different kind are distinct", async () => {
    await deleteMeta(HASH_A, "card");
    const result = await mergeMeta(HASH_A, "card", {
      sources: [
        { kind: "url", value: "shared" },
        { kind: "note", value: "shared" },
      ],
    });
    assert.equal(result.sources!.length, 2);
  });

  it("embeddings: union by (model, dims, embedding_id?)", async () => {
    await deleteMeta(HASH_A, "card");
    await mergeMeta(HASH_A, "card", {
      embeddings: [
        { model: "ada-002", dims: 1536, status: "present" },
        { model: "cohere-v3", dims: 1024, status: "present" },
      ],
    });
    const result = await mergeMeta(HASH_A, "card", {
      embeddings: [
        { model: "ada-002", dims: 1536, status: "stale" }, // same key, updates status
        { model: "ada-002", dims: 1536, embedding_id: "chunk_1", status: "present" }, // different key (has embedding_id)
      ],
    });
    assert.equal(result.embeddings!.length, 3);
    const adaNoId = result.embeddings!.find(
      (e) => e.model === "ada-002" && e.dims === 1536 && !e.embedding_id,
    );
    assert.equal(adaNoId!.status, "stale", "last-write-wins within same key");
  });

  it("meta_tags: union unique, sorted", async () => {
    await deleteMeta(HASH_A, "card");
    await mergeMeta(HASH_A, "card", {
      annotations: { meta_tags: ["zebra", "alpha"] },
    });
    const result = await mergeMeta(HASH_A, "card", {
      annotations: { meta_tags: ["alpha", "middle"] },
    });
    assert.deepEqual(result.annotations!.meta_tags, ["alpha", "middle", "zebra"]);
  });

  it("annotations.notes: last-write-wins", async () => {
    await deleteMeta(HASH_A, "card");
    await mergeMeta(HASH_A, "card", {
      annotations: { notes: "first" },
    });
    const result = await mergeMeta(HASH_A, "card", {
      annotations: { notes: "second" },
    });
    assert.equal(result.annotations!.notes, "second");
  });

  it("occurred_at: last-write-wins", async () => {
    await deleteMeta(HASH_A, "card");
    await mergeMeta(HASH_A, "card", { occurred_at: "2024-01-01T00:00:00Z" });
    const result = await mergeMeta(HASH_A, "card", { occurred_at: "2024-06-15T00:00:00Z" });
    assert.equal(result.occurred_at, "2024-06-15T00:00:00Z");
  });

  it("ingest: deep merge, last-write-wins per field", async () => {
    await deleteMeta(HASH_A, "card");
    await mergeMeta(HASH_A, "card", {
      ingest: { pipeline: "v1", extractor: "mammoth", stats: { pages: 5 } },
    });
    const result = await mergeMeta(HASH_A, "card", {
      ingest: { pipeline: "v2", stats: { words: 3000 } },
    });
    assert.equal(result.ingest!.pipeline, "v2");
    assert.equal(result.ingest!.extractor, "mammoth"); // preserved from first
    assert.equal(result.ingest!.stats!.pages, 5); // preserved from first
    assert.equal(result.ingest!.stats!.words, 3000); // added from second
  });

  it("merge never deletes existing keys", async () => {
    await deleteMeta(HASH_A, "card");
    await mergeMeta(HASH_A, "card", {
      occurred_at: "2024-01-01T00:00:00Z",
      sources: [{ kind: "url", value: "http://a.com" }],
      annotations: { notes: "important", meta_tags: ["tag1"] },
    });
    // Merge a patch that doesn't mention occurred_at, sources, or notes
    const result = await mergeMeta(HASH_A, "card", {
      annotations: { meta_tags: ["tag2"] },
    });
    assert.equal(result.occurred_at, "2024-01-01T00:00:00Z");
    assert.equal(result.sources!.length, 1);
    assert.equal(result.annotations!.notes, "important");
    assert.deepEqual(result.annotations!.meta_tags, ["tag1", "tag2"]);
  });
});

// ---------------------------------------------------------------------------
// Order-independence (forward vs reverse application)
// ---------------------------------------------------------------------------

describe("mergeMeta — order independence", () => {
  after(async () => {
    await deleteMeta(HASH_A, "card");
  });

  it("forward and reverse patch application yield identical sources and tags", async () => {
    const patches: Partial<MetaV1>[] = [
      { sources: [{ kind: "url", value: "http://a.com" }] },
      { sources: [{ kind: "url", value: "http://b.com" }] },
      { sources: [{ kind: "note", value: "http://a.com" }] }, // same value different kind
      { annotations: { meta_tags: ["z", "a", "m"] } },
      { annotations: { meta_tags: ["a", "b"] } },
    ];

    // Forward
    await deleteMeta(HASH_A, "card");
    for (const p of patches) await mergeMeta(HASH_A, "card", p);
    const fwd = await loadMeta(HASH_A, "card");

    // Reverse
    await deleteMeta(HASH_A, "card");
    for (const p of [...patches].reverse()) await mergeMeta(HASH_A, "card", p);
    const rev = await loadMeta(HASH_A, "card");

    assert.ok(fwd && rev);
    assert.deepEqual(fwd!.sources, rev!.sources, "sources should be identical regardless of order");
    assert.deepEqual(
      fwd!.annotations!.meta_tags,
      rev!.annotations!.meta_tags,
      "meta_tags should be identical regardless of order",
    );
  });
});
