import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalHash, verifyHash } from "../src/kb/canonical.js";

const TEST_ROOT = path.join(process.cwd(), "data-test-root");

describe("round-trip determinism", () => {
  it("card payload survives encode → decode → re-encode with same hash", () => {
    const base = {
      version: "card.v1",
      card_id: "card_roundtrip-test",
      title: "Determinism Test",
      bullets: ["Point A", "Point B", "Point C"],
      tags: ["test", "determinism"],
      sources: [{ doc_id: "doc_test", chunk_id: 0 }],
      created_at: "2025-06-01T12:00:00.000Z",
    };

    // Encode: compute hash
    const hash1 = canonicalHash(base as unknown as Record<string, unknown>);
    const payload1 = { ...base, hash: hash1 };

    // Simulate write-to-disk and read-back
    const serialized = JSON.stringify(payload1, null, 2);
    const deserialized = JSON.parse(serialized);

    // Re-encode: remove hash, compute again
    const { hash: _, ...rest } = deserialized;
    const hash2 = canonicalHash(rest);

    assert.equal(hash2, hash1, "Round-trip hash must be identical");
  });

  it("key reordering doesn't change hash", () => {
    const base = {
      version: "card.v1",
      card_id: "card_order-test",
      title: "Order Test",
      bullets: ["A"],
      tags: ["test"],
      sources: [{ doc_id: "doc_test", chunk_id: 0 }],
      created_at: "2025-06-01T12:00:00.000Z",
    };

    const reordered = {
      created_at: base.created_at,
      sources: base.sources,
      version: base.version,
      title: base.title,
      tags: base.tags,
      card_id: base.card_id,
      bullets: base.bullets,
    };

    assert.equal(
      canonicalHash(base as Record<string, unknown>),
      canonicalHash(reordered as Record<string, unknown>),
      "Key order must not affect hash"
    );
  });

  it("undefined fields don't affect hash vs omitted fields", () => {
    const withUndefined: Record<string, unknown> = {
      version: "card.v1",
      card_id: "card_undef-test",
      title: "Test",
      bullets: ["A"],
      diagram_mermaid: undefined,
      tags: ["test"],
      sources: [],
      created_at: "2025-06-01T12:00:00.000Z",
    };

    const withoutField: Record<string, unknown> = {
      version: "card.v1",
      card_id: "card_undef-test",
      title: "Test",
      bullets: ["A"],
      tags: ["test"],
      sources: [],
      created_at: "2025-06-01T12:00:00.000Z",
    };

    assert.equal(
      canonicalHash(withUndefined),
      canonicalHash(withoutField),
      "undefined fields must be equivalent to omitted"
    );
  });
});

describe("bundle integrity", () => {
  before(async () => {
    const dirs = ["docs", "cards", "index", "bundles", "pinsets", "packs"];
    for (const d of dirs) {
      await fs.mkdir(path.join(TEST_ROOT, "data", d), { recursive: true });
    }
  });

  after(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("detects manifest tampering", async () => {
    // Override cwd for this test
    const origCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { exportBundle, importBundle } = await import("../src/kb/bundle.js");

      const cardDir = path.join(TEST_ROOT, "data", "cards");
      const fakeCard = {
        version: "card.v1",
        card_id: "card_integrity-test",
        title: "Integrity Test",
        bullets: ["Test"],
        tags: ["test"],
        sources: [],
        hash: "abc123",
        created_at: "2025-01-01T00:00:00.000Z",
      };
      await fs.writeFile(
        path.join(cardDir, "card_integrity-test.json"),
        JSON.stringify(fakeCard),
        "utf-8"
      );

      const { bundle_path, manifest } = await exportBundle({
        card_ids: ["card_integrity-test"],
        include_png: false,
      });

      assert.ok(manifest.integrity_hash, "Manifest must have integrity hash");
      assert.equal(manifest.card_count, 1);

      // Tamper with card in bundle
      const bundledCardPath = path.join(
        bundle_path, "cards", "card_integrity-test.json"
      );
      const tamperedCard = { ...fakeCard, title: "TAMPERED" };
      await fs.writeFile(bundledCardPath, JSON.stringify(tamperedCard), "utf-8");

      // Remove original so import doesn't skip
      await fs.unlink(path.join(cardDir, "card_integrity-test.json"));

      const result = await importBundle(bundle_path);
      assert.ok(
        result.failed.includes("card_integrity-test"),
        "Tampered card must be in failed list"
      );
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe("behavior pack hash", () => {
  it("pack hash is deterministic and verifiable", () => {
    const pack: Record<string, unknown> = {
      type: "behavior_pack",
      pack_id: "pack_test-001",
      name: "Test Pack",
      version: "1.0.0",
      pins: ["hash_aaa", "hash_bbb"],
      policies: { search_boost: 0.5 },
      created_at: "2025-06-01T12:00:00.000Z",
    };

    const hash = canonicalHash(pack);
    const withHash = { ...pack, hash };

    const result = verifyHash(withHash, "hash");
    assert.equal(result.valid, true, "Pack hash must verify");
  });
});
