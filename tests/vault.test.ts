import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildArtifactHashPayload } from "../src/vault/schema.js";
import { computeArtifactId, assertVaultPayloadClean } from "../src/vault/canon.js";
import { vaultPut, vaultGet, vaultSearch, isPersonalArtifact } from "../src/vault/store.js";
import { closeDb } from "../src/vault/db.js";
import type { ArtifactKind } from "../src/vault/schema.js";

let tmpDir: string;
let origEnv: string | undefined;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
  origEnv = process.env.ARTIFACT_VAULT_ROOT;
  process.env.ARTIFACT_VAULT_ROOT = tmpDir;
});

after(() => {
  closeDb();
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

// ── SQLite index storage ─────────────────────────────────────────────────────

describe("vault — SQLite index", () => {
  it("index.sqlite is created in vault root", async () => {
    // Trigger DB creation via a put
    await vaultPut({ kind: "fact", payload: { content: "sqlite-check" }, tags: ["sqlite-test"], refs: [] });
    const dbFile = path.join(tmpDir, "index.sqlite");
    assert.ok(fs.existsSync(dbFile), "index.sqlite should exist in vault root");
  });

  it("no index.jsonl is created", async () => {
    const jsonlFile = path.join(tmpDir, "index.jsonl");
    assert.ok(!fs.existsSync(jsonlFile), "index.jsonl should NOT exist");
  });

  it("FTS search returns results matching query", async () => {
    await vaultPut({ kind: "fact", payload: { content: "quantum entanglement discovery" }, tags: ["fts-test"], refs: [] });
    await vaultPut({ kind: "fact", payload: { content: "classical mechanics review" }, tags: ["fts-test"], refs: [] });

    const result = await vaultSearch({ query: "quantum", tags: ["fts-test"] });
    assert.ok(result.results.length >= 1);
    assert.ok(result.results[0].snippet.includes("quantum"));
    assert.ok(result.results[0].score > 0);
  });

  it("FTS search returns empty for non-matching query", async () => {
    const result = await vaultSearch({ query: "zzzznonexistent999", tags: ["fts-test"] });
    assert.equal(result.results.length, 0);
  });
});

// ── JSONL migration ──────────────────────────────────────────────────────────

describe("vault — JSONL migration", () => {
  let migrationDir: string;
  let origRoot: string | undefined;

  before(() => {
    // Close current DB so we can switch vault root
    closeDb();
    migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-migration-"));
    origRoot = process.env.ARTIFACT_VAULT_ROOT;
    process.env.ARTIFACT_VAULT_ROOT = migrationDir;
  });

  after(() => {
    closeDb();
    if (origRoot === undefined) {
      delete process.env.ARTIFACT_VAULT_ROOT;
    } else {
      process.env.ARTIFACT_VAULT_ROOT = origRoot;
    }
    fs.rmSync(migrationDir, { recursive: true, force: true });
  });

  it("migrates JSONL to SQLite and renames to .migrated", async () => {
    // Write a fake JSONL
    const jsonlFile = path.join(migrationDir, "index.jsonl");
    const lines = [
      { id: "aaa111", kind: "fact", tags: ["migration"], created_at: "2026-01-01T00:00:00Z", last_seen_at: "2026-01-02T00:00:00Z", snippet: '{"content":"hello"}' },
      { id: "bbb222", kind: "skill", tags: ["migration", "code"], created_at: "2026-01-03T00:00:00Z", last_seen_at: "2026-01-04T00:00:00Z", snippet: '{"name":"coding"}' },
    ];
    fs.writeFileSync(jsonlFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");

    // Trigger migration by opening the DB
    const { getDb: getDbFresh } = await import("../src/vault/db.js");
    const db = getDbFresh();

    // Verify SQLite has the data
    const rows = db.prepare("SELECT * FROM artifacts ORDER BY id").all() as Array<{ id: string; kind: string; tags: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "aaa111");
    assert.equal(rows[0].kind, "fact");
    assert.deepEqual(JSON.parse(rows[0].tags), ["migration"]);
    assert.equal(rows[1].id, "bbb222");
    assert.equal(rows[1].kind, "skill");

    // JSONL should be renamed
    assert.ok(!fs.existsSync(jsonlFile), "index.jsonl should be removed");
    assert.ok(fs.existsSync(path.join(migrationDir, "index.jsonl.migrated")), "index.jsonl.migrated should exist");
  });
});
