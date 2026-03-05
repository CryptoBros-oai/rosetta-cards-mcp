import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildArtifactHashPayload } from "../src/vault/schema.js";
import { computeArtifactId, assertVaultPayloadClean } from "../src/vault/canon.js";
import { vaultPut, vaultGet, vaultSearch, isPersonalArtifact } from "../src/vault/store.js";
import type { ArtifactKind } from "../src/vault/schema.js";

let tmpDir: string;
let origEnv: string | undefined;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
  origEnv = process.env.ARTIFACT_VAULT_ROOT;
  process.env.ARTIFACT_VAULT_ROOT = tmpDir;
});

after(() => {
  if (origEnv === undefined) {
    delete process.env.ARTIFACT_VAULT_ROOT;
  } else {
    process.env.ARTIFACT_VAULT_ROOT = origEnv;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Deterministic hash tests ─────────────────────────────────────────────────

describe("vault — deterministic hashing", () => {
  it("same inputs produce same id across calls", () => {
    const hp1 = buildArtifactHashPayload({
      kind: "skill",
      payload: { name: "test" },
      tags: ["a"],
      refs: [],
    });
    const hp2 = buildArtifactHashPayload({
      kind: "skill",
      payload: { name: "test" },
      tags: ["a"],
      refs: [],
    });
    assert.equal(computeArtifactId(hp1), computeArtifactId(hp2));
  });

  it("created_at is excluded — same structural fields always produce same id", async () => {
    const r1 = await vaultPut({
      kind: "fact",
      payload: { content: "time-test" },
      tags: [],
      refs: [],
    });
    // re-putting same content should dedup (same id regardless of wall clock)
    const r2 = await vaultPut({
      kind: "fact",
      payload: { content: "time-test" },
      tags: [],
      refs: [],
    });
    assert.equal(r1.id, r2.id);
  });

  it("source is excluded from hash", async () => {
    const hp1 = buildArtifactHashPayload({
      kind: "fact",
      payload: { content: "source-test" },
      tags: [],
      refs: [],
    });
    // source is not in hash payload at all, so the ID is the same
    const id = computeArtifactId(hp1);
    const r = await vaultPut({
      kind: "fact",
      payload: { content: "source-test" },
      tags: [],
      refs: [],
      source: { agent: "test-agent", tool: "vault.put" },
    });
    assert.equal(r.id, id);
  });

  it("different tags produce different id", () => {
    const hp1 = buildArtifactHashPayload({
      kind: "skill",
      payload: { name: "same" },
      tags: ["alpha"],
      refs: [],
    });
    const hp2 = buildArtifactHashPayload({
      kind: "skill",
      payload: { name: "same" },
      tags: ["beta"],
      refs: [],
    });
    assert.notEqual(computeArtifactId(hp1), computeArtifactId(hp2));
  });

  it("golden fixture hash matches computed id", () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname!, "fixtures", "golden-vault-artifact.json"),
        "utf-8",
      ),
    );
    const hp = buildArtifactHashPayload({
      kind: fixture.kind as ArtifactKind,
      payload: fixture.payload,
      tags: fixture.tags,
      refs: fixture.refs,
    });
    assert.equal(computeArtifactId(hp), fixture.expected_hash);
  });
});

// ── Put / Get / Dedup ────────────────────────────────────────────────────────

describe("vault — put/get/dedup", () => {
  it("dedup returns created=false on re-put", async () => {
    const r1 = await vaultPut({
      kind: "decision",
      payload: { title: "dedup-test" },
      tags: ["test"],
      refs: [],
    });
    assert.equal(r1.created, true);

    const r2 = await vaultPut({
      kind: "decision",
      payload: { title: "dedup-test" },
      tags: ["test"],
      refs: [],
    });
    assert.equal(r2.created, false);
    assert.equal(r2.id, r1.id);
  });

  it("dedup updates last_seen_at", async () => {
    const r1 = await vaultPut({
      kind: "fact",
      payload: { content: "last-seen-test" },
      tags: [],
      refs: [],
    });
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await vaultPut({
      kind: "fact",
      payload: { content: "last-seen-test" },
      tags: [],
      refs: [],
    });
    assert.ok(r2.last_seen_at >= r1.last_seen_at);
  });

  it("get returns exact payload", async () => {
    const payload = { title: "get-test", nested: { a: 1, b: [2, 3] } };
    const r = await vaultPut({
      kind: "tool_obs",
      payload,
      tags: ["obs"],
      refs: [{ kind: "fact", id: "abc123" }],
    });
    const envelope = await vaultGet(r.id);
    assert.ok(envelope);
    assert.deepEqual(envelope.payload, payload);
    assert.deepEqual(envelope.refs, [{ kind: "fact", id: "abc123" }]);
    assert.equal(envelope.kind, "tool_obs");
    assert.deepEqual(envelope.tags, ["obs"]);
  });

  it("get returns null for missing id", async () => {
    const result = await vaultGet("0000000000000000000000000000000000000000000000000000000000000000");
    assert.equal(result, null);
  });
});

// ── Prohibited keys ──────────────────────────────────────────────────────────

describe("vault — prohibited keys", () => {
  it("rejects payload with hostname", () => {
    assert.throws(
      () => assertVaultPayloadClean({ hostname: "evil.com" }),
      /prohibited key "hostname"/,
    );
  });

  it("rejects payload with nested created_at", () => {
    assert.throws(
      () => assertVaultPayloadClean({ data: { created_at: "2026-01-01" } }),
      /prohibited key "created_at"/,
    );
  });

  it("rejects __proto__ in payload", () => {
    assert.throws(
      () => assertVaultPayloadClean({ ["__proto__"]: {} }),
      /prohibited key "__proto__"/,
    );
  });
});

// ── Search ───────────────────────────────────────────────────────────────────

describe("vault — search", () => {
  it("filters by kind", async () => {
    await vaultPut({ kind: "skill", payload: { name: "skill-search-a" }, tags: ["search-test"], refs: [] });
    await vaultPut({ kind: "skill", payload: { name: "skill-search-b" }, tags: ["search-test"], refs: [] });
    await vaultPut({ kind: "project", payload: { name: "proj-search" }, tags: ["search-test"], refs: [] });

    const result = await vaultSearch({ kind: "skill", tags: ["search-test"] });
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.kind === "skill"));
  });

  it("filters by tags (AND logic)", async () => {
    await vaultPut({ kind: "skill", payload: { name: "tag-and-1" }, tags: ["alpha", "beta", "tag-and-test"], refs: [] });
    await vaultPut({ kind: "skill", payload: { name: "tag-and-2" }, tags: ["alpha", "tag-and-test"], refs: [] });

    const result = await vaultSearch({ tags: ["alpha", "beta", "tag-and-test"] });
    assert.equal(result.results.length, 1);
    assert.ok(result.results[0].tags.includes("beta"));
  });

  it("exclude_personal filters personal: tags", async () => {
    await vaultPut({ kind: "fact", payload: { content: "personal-test" }, tags: ["personal:workflow", "ep-test"], refs: [] });
    await vaultPut({ kind: "fact", payload: { content: "public-test" }, tags: ["public", "ep-test"], refs: [] });

    const withPersonal = await vaultSearch({ tags: ["ep-test"] });
    assert.equal(withPersonal.results.length, 2);

    const withoutPersonal = await vaultSearch({ tags: ["ep-test"], exclude_personal: true });
    assert.equal(withoutPersonal.results.length, 1);
    assert.ok(!isPersonalArtifact(withoutPersonal.results[0].tags));
  });
});
