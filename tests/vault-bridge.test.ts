import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bridgeDocsToVault, bridgeCardsToVault } from "../src/kb/vault_bridge.js";
import { vaultSearch, vaultGet } from "../src/vault/store.js";
import { closeDb } from "../src/vault/db.js";
import { closeEmbeddingsDb } from "../src/embeddings/store.js";

let tmpDir: string;
let origVaultRoot: string | undefined;
let origEmbeddingEndpoint: string | undefined;

// Write fixtures directly to data/docs/ and data/cards/ inside tmpDir
function writeDocFixture(dir: string, doc: Record<string, unknown>): void {
  const docsDir = path.join(dir, "data", "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(
    path.join(docsDir, `${doc.doc_id}.json`),
    JSON.stringify(doc, null, 2),
  );
}

function writeCardFixture(dir: string, card: Record<string, unknown>): void {
  const cardsDir = path.join(dir, "data", "cards");
  fs.mkdirSync(cardsDir, { recursive: true });
  fs.writeFileSync(
    path.join(cardsDir, `${card.card_id}.json`),
    JSON.stringify(card, null, 2),
  );
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-bridge-test-"));
  origVaultRoot = process.env.ARTIFACT_VAULT_ROOT;
  origEmbeddingEndpoint = process.env.EMBEDDING_ENDPOINT;
  process.env.ARTIFACT_VAULT_ROOT = path.join(tmpDir, ".vault");
  process.env.EMBEDDING_ENDPOINT = "http://127.0.0.1:1/v1/embeddings";
  // Point VAULT_ROOT so loadDoc/loadCard find fixtures
  process.env.VAULT_ROOT = tmpDir;
});

after(() => {
  closeEmbeddingsDb();
  closeDb();
  if (origVaultRoot === undefined) delete process.env.ARTIFACT_VAULT_ROOT;
  else process.env.ARTIFACT_VAULT_ROOT = origVaultRoot;
  if (origEmbeddingEndpoint === undefined) delete process.env.EMBEDDING_ENDPOINT;
  else process.env.EMBEDDING_ENDPOINT = origEmbeddingEndpoint;
  delete process.env.VAULT_ROOT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── bridgeDocsToVault ──────────────────────────────────────────────────────

describe("vault-bridge — bridgeDocsToVault", () => {
  it("bridges a doc into the vault as a fact", async () => {
    const doc = {
      doc_id: "doc_bridge_test_001",
      title: "Content Addressing Explained",
      text: "Content addressing uses SHA-256 hashes to identify artifacts by their content rather than by location.",
      tags: ["hashing", "vault"],
      chunks: ["Content addressing uses SHA-256 hashes to identify artifacts by their content rather than by location."],
      created_at: new Date().toISOString(),
    };
    writeDocFixture(tmpDir, doc);

    const result = await bridgeDocsToVault(["doc_bridge_test_001"]);
    assert.equal(result.bridged, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors.length, 0);
  });

  it("bridged doc is findable via vault.search", async () => {
    const results = await vaultSearch({
      query: "content addressing SHA-256",
      limit: 10,
      search_mode: "lexical",
    });
    assert.ok(results.total > 0, "should find at least one result");
    const hit = results.results.find((r: any) =>
      r.snippet.includes("Content Addressing Explained") ||
      r.snippet.includes("content addressing") ||
      r.snippet.includes("SHA-256"),
    );
    assert.ok(hit, "should find the bridged doc in vault search results");
    assert.equal(hit.kind, "fact");
  });

  it("re-bridging the same doc is a dedup (created=false)", async () => {
    const result = await bridgeDocsToVault(["doc_bridge_test_001"]);
    assert.equal(result.bridged, 0);
    assert.equal(result.skipped, 1);
  });

  it("truncates text to 2000 chars", async () => {
    const longText = "A".repeat(5000);
    const doc = {
      doc_id: "doc_bridge_long_text",
      title: "Long Document",
      text: longText,
      tags: ["long"],
      chunks: [longText],
      created_at: new Date().toISOString(),
    };
    writeDocFixture(tmpDir, doc);

    const result = await bridgeDocsToVault(["doc_bridge_long_text"]);
    assert.equal(result.bridged, 1);

    // Verify the stored payload has truncated text
    const search = await vaultSearch({
      query: "Long Document",
      kind: "fact",
      limit: 5,
      search_mode: "lexical",
    });
    assert.ok(search.total > 0);
  });

  it("handles missing doc gracefully", async () => {
    const result = await bridgeDocsToVault(["doc_nonexistent_xyz"]);
    assert.equal(result.bridged, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes("doc_nonexistent_xyz"));
  });
});

// ── bridgeCardsToVault ─────────────────────────────────────────────────────

describe("vault-bridge — bridgeCardsToVault", () => {
  it("bridges a card with bullets as 'skill'", async () => {
    const card = {
      version: "card.v1",
      card_id: "card_bridge_skill_001",
      title: "Deploy Docker Containers",
      bullets: [
        "Pull the image from the registry",
        "Run docker-compose up -d",
        "Verify health endpoints",
      ],
      tags: ["docker", "deployment"],
      sources: [],
      created_at: new Date().toISOString(),
      hash: "abc123fake",
    };
    writeCardFixture(tmpDir, card);

    const result = await bridgeCardsToVault(["card_bridge_skill_001"]);
    assert.equal(result.bridged, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors.length, 0);

    // Verify it was stored as "skill"
    const search = await vaultSearch({
      query: "Deploy Docker",
      kind: "skill",
      limit: 5,
      search_mode: "lexical",
    });
    assert.ok(search.total > 0, "should find the bridged card as a skill");
  });

  it("bridges a card without bullets as 'fact'", async () => {
    const card = {
      version: "card.v1",
      card_id: "card_bridge_fact_001",
      title: "Water Boiling Point",
      bullets: [],
      tags: ["science"],
      sources: [],
      created_at: new Date().toISOString(),
      hash: "def456fake",
    };
    writeCardFixture(tmpDir, card);

    const result = await bridgeCardsToVault(["card_bridge_fact_001"]);
    assert.equal(result.bridged, 1);

    const search = await vaultSearch({
      query: "Water Boiling Point",
      kind: "fact",
      limit: 5,
      search_mode: "lexical",
    });
    assert.ok(search.total > 0, "should find the bridged card as a fact");
  });

  it("re-bridging same card is a dedup", async () => {
    const result = await bridgeCardsToVault(["card_bridge_skill_001"]);
    assert.equal(result.bridged, 0);
    assert.equal(result.skipped, 1);
  });

  it("handles missing card gracefully", async () => {
    const result = await bridgeCardsToVault(["card_nonexistent_xyz"]);
    assert.equal(result.bridged, 0);
    assert.equal(result.errors.length, 1);
  });
});

// ── Tags ───────────────────────────────────────────────────────────────────

describe("vault-bridge — kb-bridge tag", () => {
  it("all bridged artifacts have the kb-bridge tag", async () => {
    const search = await vaultSearch({
      tags: ["kb-bridge"],
      limit: 50,
    });
    assert.ok(search.total >= 4, `expected at least 4 bridged artifacts, got ${search.total}`);
    for (const hit of search.results) {
      assert.ok(
        (hit.tags as string[]).includes("kb-bridge"),
        `artifact ${hit.id} missing kb-bridge tag`,
      );
    }
  });
});
