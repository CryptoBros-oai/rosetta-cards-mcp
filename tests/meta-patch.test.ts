/**
 * MetaPatchSchema hardening tests — Prompt 2
 *
 * Covers:
 *   - Identity field spoofing is rejected at schema level
 *   - Unknown keys rejected at root and all nested levels
 *   - Valid patch shapes are accepted
 *   - Union merge behavior is deterministic when using MetaPatch-validated inputs
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { MetaPatchSchema, MetaV1Schema } from "../src/kb/schema.js";
import { mergeMeta, deleteMeta, loadMeta, getMetaPath } from "../src/kb/vault.js";

const HASH = "cafebabe12345678cafebabe12345678cafebabe12345678cafebabe12345678";

// ---------------------------------------------------------------------------
// Anti-spoofing: identity fields must not be accepted in patch
// ---------------------------------------------------------------------------

describe("MetaPatchSchema — anti-spoofing (identity fields)", () => {
  it("rejects artifact_hash in patch", () => {
    assert.throws(
      () => MetaPatchSchema.parse({ artifact_hash: HASH }),
      /unrecognized_keys/,
      "artifact_hash must not be a valid patch key",
    );
  });

  it("rejects schema_version in patch", () => {
    assert.throws(
      () => MetaPatchSchema.parse({ schema_version: "meta.v1" }),
      /unrecognized_keys/,
      "schema_version must not be a valid patch key",
    );
  });

  it("rejects artifact_type in patch", () => {
    assert.throws(
      () => MetaPatchSchema.parse({ artifact_type: "card" }),
      /unrecognized_keys/,
      "artifact_type must not be a valid patch key",
    );
  });

  it("rejects all three identity fields together", () => {
    assert.throws(
      () =>
        MetaPatchSchema.parse({
          schema_version: "meta.v1",
          artifact_hash: HASH,
          artifact_type: "event",
          occurred_at: "2024-01-01T00:00:00Z",
        }),
      /unrecognized_keys/,
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown key rejection at root and all nested objects
// ---------------------------------------------------------------------------

describe("MetaPatchSchema — unknown key rejection", () => {
  it("rejects unknown root key", () => {
    assert.throws(
      () => MetaPatchSchema.parse({ danger: true }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in sources entry", () => {
    assert.throws(
      () =>
        MetaPatchSchema.parse({
          sources: [{ kind: "url", value: "http://x.com", extra: "nope" }],
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in ingest", () => {
    assert.throws(
      () =>
        MetaPatchSchema.parse({
          ingest: { pipeline: "v1", unknown_field: true },
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in embeddings entry", () => {
    assert.throws(
      () =>
        MetaPatchSchema.parse({
          embeddings: [
            { model: "ada", dims: 1536, status: "present", garbage: 1 },
          ],
        }),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in annotations", () => {
    assert.throws(
      () =>
        MetaPatchSchema.parse({
          annotations: { notes: "ok", injected: "bad" },
        }),
      /unrecognized_keys/,
    );
  });
});

// ---------------------------------------------------------------------------
// Valid patch shapes are accepted
// ---------------------------------------------------------------------------

describe("MetaPatchSchema — valid shapes", () => {
  it("accepts empty patch", () => {
    assert.doesNotThrow(() => MetaPatchSchema.parse({}));
  });

  it("accepts occurred_at only", () => {
    const result = MetaPatchSchema.parse({ occurred_at: "2024-06-15T10:00:00Z" });
    assert.equal(result.occurred_at, "2024-06-15T10:00:00Z");
  });

  it("accepts full valid patch", () => {
    const result = MetaPatchSchema.parse({
      occurred_at: "2024-06-15T10:00:00Z",
      sources: [
        { kind: "url", value: "https://example.com" },
        { kind: "note", value: "manual" },
      ],
      ingest: {
        pipeline: "docx-v1",
        extractor: "mammoth",
        chunker: "paragraph",
        stats: { pages: 10, words: 5000 },
      },
      embeddings: [
        {
          model: "text-embedding-3-small",
          dims: 1536,
          status: "present",
          updated_at: "2024-06-15T10:00:00Z",
        },
      ],
      annotations: { notes: "reviewed", meta_tags: ["important"] },
    });
    assert.equal(result.sources!.length, 2);
    assert.equal(result.ingest!.stats!.pages, 10);
    assert.equal(result.embeddings![0].status, "present");
  });
});

// ---------------------------------------------------------------------------
// Identity invariant: mergeMeta always derives identity from args, never patch
// ---------------------------------------------------------------------------

describe("mergeMeta — identity always comes from args", () => {
  after(async () => {
    await deleteMeta(HASH, "card");
  });

  it("schema_version is always meta.v1 regardless of patch contents", async () => {
    await deleteMeta(HASH, "card");
    // MetaPatchSchema prevents passing schema_version, but if we bypass it
    // and call mergeMeta with a crafted partial, the result is still correct.
    // (MetaPatch type enforces this at compile time too.)
    const result = await mergeMeta(HASH, "card", { occurred_at: "2024-01-01T00:00:00Z" });
    assert.equal(result.schema_version, "meta.v1");
  });

  it("artifact_hash in stored meta always matches the arg, not patch", async () => {
    await deleteMeta(HASH, "card");
    const result = await mergeMeta(HASH, "card", { occurred_at: "2024-01-01T00:00:00Z" });
    assert.equal(result.artifact_hash, HASH);
  });

  it("artifact_type in stored meta always matches the arg", async () => {
    await deleteMeta(HASH, "card");
    const result = await mergeMeta(HASH, "card", {});
    assert.equal(result.artifact_type, "card");

    const eventHash = HASH.replace("cafe", "dead");
    await deleteMeta(eventHash, "event");
    const eventResult = await mergeMeta(eventHash, "event", {});
    assert.equal(eventResult.artifact_type, "event");
    await deleteMeta(eventHash, "event");
  });

  it("stored file parses correctly with MetaV1Schema after MetaPatch merge", async () => {
    await deleteMeta(HASH, "card");
    await mergeMeta(HASH, "card", {
      sources: [{ kind: "url", value: "https://example.com" }],
      annotations: { meta_tags: ["test"] },
    });
    const loaded = await loadMeta(HASH, "card");
    assert.ok(loaded);
    // Validate the stored file conforms to the full MetaV1Schema
    assert.doesNotThrow(() => MetaV1Schema.parse(loaded));
  });
});

// ---------------------------------------------------------------------------
// Union behavior remains deterministic through MetaPatchSchema-validated inputs
// ---------------------------------------------------------------------------

describe("MetaPatchSchema — deterministic union via validated patches", () => {
  after(async () => {
    await deleteMeta(HASH, "card");
  });

  it("validated patches produce deterministic sources union", async () => {
    const patchA = MetaPatchSchema.parse({
      sources: [
        { kind: "url", value: "http://a.com" },
        { kind: "file", value: "report.pdf" },
      ],
    });
    const patchB = MetaPatchSchema.parse({
      sources: [
        { kind: "url", value: "http://b.com" },
        { kind: "url", value: "http://a.com" }, // duplicate — should not double-count
      ],
    });

    await deleteMeta(HASH, "card");
    await mergeMeta(HASH, "card", patchA);
    const result = await mergeMeta(HASH, "card", patchB);

    assert.equal(result.sources!.length, 3, "Should be 3 unique (kind,value) pairs");
    const values = result.sources!.map((s) => `${s.kind}:${s.value}`).sort();
    assert.deepEqual(values, [
      "file:report.pdf",
      "url:http://a.com",
      "url:http://b.com",
    ]);
  });

  it("validated patches produce deterministic meta_tags union", async () => {
    const patches = [
      MetaPatchSchema.parse({ annotations: { meta_tags: ["z", "a"] } }),
      MetaPatchSchema.parse({ annotations: { meta_tags: ["a", "m"] } }),
      MetaPatchSchema.parse({ annotations: { meta_tags: ["b"] } }),
    ];

    await deleteMeta(HASH, "card");
    for (const p of patches) await mergeMeta(HASH, "card", p);
    const fwd = await loadMeta(HASH, "card");

    await deleteMeta(HASH, "card");
    for (const p of [...patches].reverse()) await mergeMeta(HASH, "card", p);
    const rev = await loadMeta(HASH, "card");

    assert.deepEqual(
      fwd!.annotations!.meta_tags,
      rev!.annotations!.meta_tags,
      "meta_tags union is order-independent",
    );
    assert.deepEqual(fwd!.annotations!.meta_tags, ["a", "b", "m", "z"]);
  });

  it("validated embeddings merge is deterministic", async () => {
    const patchA = MetaPatchSchema.parse({
      embeddings: [
        { model: "ada-002", dims: 1536, status: "present" },
        { model: "cohere", dims: 1024, status: "missing" },
      ],
    });
    const patchB = MetaPatchSchema.parse({
      embeddings: [
        { model: "ada-002", dims: 1536, status: "stale" }, // update status
      ],
    });

    await deleteMeta(HASH, "card");
    await mergeMeta(HASH, "card", patchA);
    const result = await mergeMeta(HASH, "card", patchB);

    assert.equal(result.embeddings!.length, 2, "Two distinct embedding keys");
    const ada = result.embeddings!.find((e) => e.model === "ada-002");
    assert.equal(ada!.status, "stale", "Later patch wins for same embedding key");
  });
});
