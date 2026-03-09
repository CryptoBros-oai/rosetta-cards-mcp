import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertTierAccess,
  assertArtifactCap,
  assertPutKindAllowed,
  TierAccessError,
  TierCapError,
  ARTIFACT_CAPS,
  isTier,
  isBronzeAllowedKind,
} from "../src/tiers/policy.js";
import { getCurrentTier } from "../src/tiers/context.js";
import { vaultPut, getArtifactCount } from "../src/vault/store.js";
import { closeDb } from "../src/vault/db.js";
import { closeEmbeddingsDb } from "../src/embeddings/store.js";

let tmpDir: string;
let origVaultRoot: string | undefined;
let origTier: string | undefined;
let origEmbeddingEndpoint: string | undefined;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-test-"));
  origVaultRoot = process.env.ARTIFACT_VAULT_ROOT;
  origTier = process.env.THREADFORGE_TIER;
  origEmbeddingEndpoint = process.env.EMBEDDING_ENDPOINT;
  process.env.ARTIFACT_VAULT_ROOT = tmpDir;
  process.env.EMBEDDING_ENDPOINT = "http://127.0.0.1:1/v1/embeddings";
});

after(() => {
  closeEmbeddingsDb();
  closeDb();
  if (origVaultRoot === undefined) delete process.env.ARTIFACT_VAULT_ROOT;
  else process.env.ARTIFACT_VAULT_ROOT = origVaultRoot;
  if (origTier === undefined) delete process.env.THREADFORGE_TIER;
  else process.env.THREADFORGE_TIER = origTier;
  if (origEmbeddingEndpoint === undefined) delete process.env.EMBEDDING_ENDPOINT;
  else process.env.EMBEDDING_ENDPOINT = origEmbeddingEndpoint;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tier validation ─────────────────────────────────────────────────────────

describe("tiers — isTier", () => {
  it("accepts valid tier strings", () => {
    assert.equal(isTier("bronze"), true);
    assert.equal(isTier("silver"), true);
    assert.equal(isTier("gold"), true);
  });

  it("rejects invalid tier strings", () => {
    assert.equal(isTier("platinum"), false);
    assert.equal(isTier(""), false);
    assert.equal(isTier("GOLD"), false); // case sensitive
  });
});

// ── Default tier (local dev) ────────────────────────────────────────────────

describe("tiers — getCurrentTier", () => {
  it("defaults to gold when THREADFORGE_TIER is not set", () => {
    delete process.env.THREADFORGE_TIER;
    assert.equal(getCurrentTier(), "gold");
  });

  it("reads bronze from env", () => {
    process.env.THREADFORGE_TIER = "bronze";
    assert.equal(getCurrentTier(), "bronze");
  });

  it("reads silver from env", () => {
    process.env.THREADFORGE_TIER = "silver";
    assert.equal(getCurrentTier(), "silver");
  });

  it("is case-insensitive", () => {
    process.env.THREADFORGE_TIER = "GOLD";
    assert.equal(getCurrentTier(), "gold");
    process.env.THREADFORGE_TIER = "Bronze";
    assert.equal(getCurrentTier(), "bronze");
  });

  it("falls back to gold for invalid values", () => {
    process.env.THREADFORGE_TIER = "platinum";
    assert.equal(getCurrentTier(), "gold");
  });

  after(() => {
    delete process.env.THREADFORGE_TIER;
  });
});

// ── Bronze kind restrictions ────────────────────────────────────────────────

describe("tiers — bronze kind restrictions", () => {
  it("allows fact, event, tool_obs for bronze", () => {
    assert.equal(isBronzeAllowedKind("fact"), true);
    assert.equal(isBronzeAllowedKind("event"), true);
    assert.equal(isBronzeAllowedKind("tool_obs"), true);
  });

  it("rejects skill, decision, profile, summary, project for bronze", () => {
    assert.equal(isBronzeAllowedKind("skill"), false);
    assert.equal(isBronzeAllowedKind("decision"), false);
    assert.equal(isBronzeAllowedKind("profile"), false);
    assert.equal(isBronzeAllowedKind("summary"), false);
    assert.equal(isBronzeAllowedKind("project"), false);
  });
});

// ── assertTierAccess ────────────────────────────────────────────────────────

describe("tiers — assertTierAccess", () => {
  it("gold allows all tools", () => {
    assert.doesNotThrow(() => assertTierAccess("gold", "vm.execute"));
    assert.doesNotThrow(() => assertTierAccess("gold", "corpus.import_arxiv"));
    assert.doesNotThrow(() => assertTierAccess("gold", "vault.put"));
    assert.doesNotThrow(() => assertTierAccess("gold", "artifact.bless"));
  });

  it("bronze allows basic vault and memory tools", () => {
    assert.doesNotThrow(() => assertTierAccess("bronze", "vault.put"));
    assert.doesNotThrow(() => assertTierAccess("bronze", "vault.get"));
    assert.doesNotThrow(() => assertTierAccess("bronze", "vault.search"));
    assert.doesNotThrow(() => assertTierAccess("bronze", "memory.ingest_turn"));
    assert.doesNotThrow(() => assertTierAccess("bronze", "memory.get_context"));
    assert.doesNotThrow(() => assertTierAccess("bronze", "kb.search"));
  });

  it("bronze denies VM, corpus, blessing, promotion", () => {
    assert.throws(() => assertTierAccess("bronze", "vm.execute"), TierAccessError);
    assert.throws(() => assertTierAccess("bronze", "corpus.import_local"), TierAccessError);
    assert.throws(() => assertTierAccess("bronze", "artifact.bless"), TierAccessError);
    assert.throws(() => assertTierAccess("bronze", "promotion.promote_facts"), TierAccessError);
  });

  it("silver allows blessing and promotion", () => {
    assert.doesNotThrow(() => assertTierAccess("silver", "artifact.bless"));
    assert.doesNotThrow(() => assertTierAccess("silver", "artifact.deprecate"));
    assert.doesNotThrow(() => assertTierAccess("silver", "artifact.supersede"));
    assert.doesNotThrow(() => assertTierAccess("silver", "promotion.promote_facts"));
    assert.doesNotThrow(() => assertTierAccess("silver", "corpus.import_local"));
  });

  it("silver denies VM and remote corpus imports", () => {
    assert.throws(() => assertTierAccess("silver", "vm.execute"), TierAccessError);
    assert.throws(() => assertTierAccess("silver", "vm.phase_scan"), TierAccessError);
    assert.throws(() => assertTierAccess("silver", "corpus.import_github"), TierAccessError);
    assert.throws(() => assertTierAccess("silver", "corpus.import_arxiv"), TierAccessError);
    assert.throws(() => assertTierAccess("silver", "corpus.import_synthetic"), TierAccessError);
  });

  it("TierAccessError has correct properties", () => {
    try {
      assertTierAccess("bronze", "vm.execute");
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof TierAccessError);
      assert.equal(e.tier, "bronze");
      assert.equal(e.tool, "vm.execute");
      assert.ok(e.message.includes("bronze"));
      assert.ok(e.message.includes("vm.execute"));
    }
  });
});

// ── assertPutKindAllowed ────────────────────────────────────────────────────

describe("tiers — assertPutKindAllowed", () => {
  it("bronze can put fact, event, tool_obs", () => {
    assert.doesNotThrow(() => assertPutKindAllowed("bronze", "fact"));
    assert.doesNotThrow(() => assertPutKindAllowed("bronze", "event"));
    assert.doesNotThrow(() => assertPutKindAllowed("bronze", "tool_obs"));
  });

  it("bronze cannot put skill, decision, summary, profile, project", () => {
    assert.throws(() => assertPutKindAllowed("bronze", "skill"), TierAccessError);
    assert.throws(() => assertPutKindAllowed("bronze", "decision"), TierAccessError);
    assert.throws(() => assertPutKindAllowed("bronze", "summary"), TierAccessError);
    assert.throws(() => assertPutKindAllowed("bronze", "profile"), TierAccessError);
    assert.throws(() => assertPutKindAllowed("bronze", "project"), TierAccessError);
  });

  it("silver can put all kinds", () => {
    assert.doesNotThrow(() => assertPutKindAllowed("silver", "skill"));
    assert.doesNotThrow(() => assertPutKindAllowed("silver", "decision"));
    assert.doesNotThrow(() => assertPutKindAllowed("silver", "summary"));
  });

  it("gold can put all kinds", () => {
    assert.doesNotThrow(() => assertPutKindAllowed("gold", "project"));
    assert.doesNotThrow(() => assertPutKindAllowed("gold", "profile"));
  });
});

// ── assertArtifactCap ───────────────────────────────────────────────────────

describe("tiers — assertArtifactCap", () => {
  it("bronze cap is 1000", () => {
    assert.equal(ARTIFACT_CAPS.bronze, 1000);
  });

  it("silver cap is 10000", () => {
    assert.equal(ARTIFACT_CAPS.silver, 10000);
  });

  it("gold cap is Infinity", () => {
    assert.equal(ARTIFACT_CAPS.gold, Infinity);
  });

  it("allows when under cap", () => {
    assert.doesNotThrow(() => assertArtifactCap("bronze", 999));
    assert.doesNotThrow(() => assertArtifactCap("silver", 9999));
    assert.doesNotThrow(() => assertArtifactCap("gold", 1_000_000));
  });

  it("throws when at cap", () => {
    assert.throws(() => assertArtifactCap("bronze", 1000), TierCapError);
    assert.throws(() => assertArtifactCap("silver", 10000), TierCapError);
  });

  it("throws when over cap", () => {
    assert.throws(() => assertArtifactCap("bronze", 1001), TierCapError);
  });

  it("TierCapError has correct properties", () => {
    try {
      assertArtifactCap("bronze", 1000);
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof TierCapError);
      assert.equal(e.tier, "bronze");
      assert.equal(e.cap, 1000);
      assert.equal(e.current, 1000);
    }
  });
});

// ── Integration: vault.put with tier enforcement ────────────────────────────

describe("tiers — vault.put integration", () => {
  it("bronze can put a fact", async () => {
    process.env.THREADFORGE_TIER = "bronze";
    const result = await vaultPut({
      kind: "fact",
      payload: { content: "bronze fact test" },
      tags: ["tier-test"],
      refs: [],
    });
    assert.ok(result.id);
    assert.equal(result.created, true);
  });

  it("bronze can put an event", async () => {
    process.env.THREADFORGE_TIER = "bronze";
    const result = await vaultPut({
      kind: "event",
      payload: { content: "bronze event test" },
      tags: ["tier-test"],
      refs: [],
    });
    assert.ok(result.id);
  });

  it("bronze cannot put a skill", async () => {
    process.env.THREADFORGE_TIER = "bronze";
    await assert.rejects(
      () => vaultPut({
        kind: "skill",
        payload: { content: "bronze skill test" },
        tags: ["tier-test"],
        refs: [],
      }),
      TierAccessError,
    );
  });

  it("bronze cannot put a decision", async () => {
    process.env.THREADFORGE_TIER = "bronze";
    await assert.rejects(
      () => vaultPut({
        kind: "decision",
        payload: { content: "bronze decision test" },
        tags: ["tier-test"],
        refs: [],
      }),
      TierAccessError,
    );
  });

  it("silver can put a skill", async () => {
    process.env.THREADFORGE_TIER = "silver";
    const result = await vaultPut({
      kind: "skill",
      payload: { content: "silver skill test" },
      tags: ["tier-test"],
      refs: [],
    });
    assert.ok(result.id);
  });

  it("gold can put any kind", async () => {
    process.env.THREADFORGE_TIER = "gold";
    const result = await vaultPut({
      kind: "project",
      payload: { content: "gold project test" },
      tags: ["tier-test"],
      refs: [],
    });
    assert.ok(result.id);
  });

  it("dedup re-put succeeds even at cap (no new artifact)", async () => {
    // First put as gold to create the artifact
    process.env.THREADFORGE_TIER = "gold";
    const first = await vaultPut({
      kind: "fact",
      payload: { content: "dedup cap test" },
      tags: ["cap-dedup-test"],
      refs: [],
    });
    assert.equal(first.created, true);

    // Now switch to bronze — re-putting the same content is a dedup, not new
    process.env.THREADFORGE_TIER = "bronze";
    const second = await vaultPut({
      kind: "fact",
      payload: { content: "dedup cap test" },
      tags: ["cap-dedup-test"],
      refs: [],
    });
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
  });

  after(() => {
    delete process.env.THREADFORGE_TIER;
  });
});

// ── Integration: getArtifactCount ───────────────────────────────────────────

describe("tiers — getArtifactCount", () => {
  it("returns a number", () => {
    const count = getArtifactCount();
    assert.equal(typeof count, "number");
    assert.ok(count >= 0);
  });

  it("increments after vault.put", async () => {
    delete process.env.THREADFORGE_TIER; // gold
    const before = getArtifactCount();
    await vaultPut({
      kind: "fact",
      payload: { content: `count-test-${Date.now()}` },
      tags: ["count-test"],
      refs: [],
    });
    const after = getArtifactCount();
    assert.equal(after, before + 1);
  });
});
