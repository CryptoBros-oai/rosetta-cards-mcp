/**
 * Behavior pack integration tests.
 *
 * Tests that:
 *  - Pack hash is deterministic and verifiable
 *  - Pack card type has a proper schema
 *  - VaultContext correctly loads active pack policies
 *  - Pack creation from pinset works
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalHash,
  verifyHash,
} from "../src/kb/canonical.js";
import {
  BehaviorPackSchema,
  PackPoliciesSchema,
  DEFAULT_POLICIES,
} from "../src/kb/schema.js";

const DATA_DIR = path.join(process.cwd(), "data");

describe("BehaviorPack schema", () => {
  it("validates a correct pack payload", () => {
    const pack = {
      type: "behavior_pack" as const,
      pack_id: "pack_schema-test",
      name: "Schema Test Pack",
      version: "1.0.0",
      description: "A test behavior pack",
      pins: ["abc123", "def456"],
      policies: {
        search_boost: 0.3,
        max_results: 20,
        allowed_tags: ["research"],
        style: "dark" as const,
      },
      created_at: "2025-01-01T00:00:00.000Z",
      hash: "placeholder",
    };
    const result = BehaviorPackSchema.safeParse(pack);
    assert.ok(result.success, "Valid pack must pass schema validation");
  });

  it("rejects invalid search_boost range", () => {
    const policies = { search_boost: 1.5 };
    const result = PackPoliciesSchema.safeParse(policies);
    assert.ok(!result.success, "search_boost > 1.0 must fail");
  });

  it("rejects negative search_boost", () => {
    const policies = { search_boost: -0.1 };
    const result = PackPoliciesSchema.safeParse(policies);
    assert.ok(!result.success, "search_boost < 0 must fail");
  });
});

describe("BehaviorPack hash determinism", () => {
  it("same pack always produces same hash", () => {
    const base = {
      type: "behavior_pack",
      pack_id: "pack_determ-test",
      name: "Determinism Test",
      version: "1.0.0",
      pins: ["hash_aaa", "hash_bbb", "hash_ccc"],
      policies: { search_boost: 0.5, allowed_tags: ["alpha", "beta"] },
      created_at: "2025-06-01T12:00:00.000Z",
    };
    const h1 = canonicalHash(base as Record<string, unknown>);
    const h2 = canonicalHash(base as Record<string, unknown>);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it("hash survives round-trip through JSON", () => {
    const base = {
      type: "behavior_pack",
      pack_id: "pack_roundtrip",
      name: "Round Trip",
      version: "1.0.0",
      pins: ["hash_xxx"],
      policies: { search_boost: 0.2 },
      created_at: "2025-01-01T00:00:00.000Z",
    };
    const hash = canonicalHash(base as Record<string, unknown>);
    const withHash = { ...base, hash };

    // Simulate JSON round-trip
    const serialized = JSON.stringify(withHash);
    const deserialized = JSON.parse(serialized);

    const result = verifyHash(deserialized, "hash");
    assert.ok(result.valid, "Pack hash must survive JSON round-trip");
  });

  it("key order does not affect hash", () => {
    const base1 = {
      type: "behavior_pack",
      pack_id: "pack_order-test",
      name: "Order Test",
      version: "1.0.0",
      pins: ["a"],
      policies: { search_boost: 0.1 },
      created_at: "2025-01-01T00:00:00.000Z",
    };
    const base2 = {
      created_at: "2025-01-01T00:00:00.000Z",
      policies: { search_boost: 0.1 },
      pins: ["a"],
      version: "1.0.0",
      name: "Order Test",
      pack_id: "pack_order-test",
      type: "behavior_pack",
    };
    assert.equal(
      canonicalHash(base1 as Record<string, unknown>),
      canonicalHash(base2 as Record<string, unknown>)
    );
  });
});

describe("DEFAULT_POLICIES", () => {
  it("has search_boost of 0", () => {
    assert.equal(DEFAULT_POLICIES.search_boost, 0);
  });

  it("has no tag filters by default", () => {
    assert.equal(DEFAULT_POLICIES.allowed_tags, undefined);
    assert.equal(DEFAULT_POLICIES.blocked_tags, undefined);
  });
});

describe("VaultContext pack integration", () => {
  before(async () => {
    const dirs = ["cards", "packs", "pinsets"];
    for (const d of dirs) {
      await fs.mkdir(path.join(DATA_DIR, d), { recursive: true });
    }
  });

  it("getVaultContext returns default when no pack active", async () => {
    const { getVaultContext } = await import("../src/kb/vault.js");

    // Clear any active pack
    const activePath = path.join(DATA_DIR, "packs", ".active");
    await fs.rm(activePath, { force: true }).catch(() => {});

    const ctx = await getVaultContext();
    assert.equal(ctx.activePack, null);
    assert.equal(ctx.policies.search_boost, 0);
    assert.deepEqual(ctx.pinHashes, []);
  });

  it("getVaultContext loads active pack policies", async () => {
    const {
      createBehaviorPack,
      setActivePack,
      getVaultContext,
    } = await import("../src/kb/vault.js");

    const pack = await createBehaviorPack({
      name: "Integration Test Pack",
      version: "1.0.0",
      card_ids: [],
      policies: {
        search_boost: 0.7,
        max_results: 5,
        allowed_tags: ["test-tag"],
        style: "dark",
      },
    });

    await setActivePack(pack.pack_id);
    const ctx = await getVaultContext();

    assert.ok(ctx.activePack, "Must have active pack");
    assert.equal(ctx.policies.search_boost, 0.7);
    assert.equal(ctx.policies.max_results, 5);
    assert.deepEqual(ctx.policies.allowed_tags, ["test-tag"]);
    assert.equal(ctx.policies.style, "dark");

    // Clean up
    const activePath = path.join(DATA_DIR, "packs", ".active");
    await fs.rm(activePath, { force: true }).catch(() => {});
    await fs.rm(path.join(DATA_DIR, "packs", `${pack.pack_id}.json`), { force: true }).catch(() => {});
  });
});
