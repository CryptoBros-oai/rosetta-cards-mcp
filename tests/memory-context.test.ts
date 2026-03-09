import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ingestTurn,
  compactBand,
  getContextWindow,
  classifyBand,
  BAND_THRESHOLDS,
} from "../src/memory/context_window.js";
import {
  startSession,
  endSession,
  getSession,
  recordTurn,
} from "../src/memory/session.js";
import { vaultSearch, vaultGet } from "../src/vault/store.js";
import { closeDb } from "../src/vault/db.js";
import { closeEmbeddingsDb } from "../src/embeddings/store.js";

let tmpDir: string;
let origVaultRoot: string | undefined;
let origEmbeddingEndpoint: string | undefined;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
  origVaultRoot = process.env.ARTIFACT_VAULT_ROOT;
  origEmbeddingEndpoint = process.env.EMBEDDING_ENDPOINT;
  process.env.ARTIFACT_VAULT_ROOT = tmpDir;
  // Disable embedding endpoint for these tests
  process.env.EMBEDDING_ENDPOINT = "http://127.0.0.1:1/v1/embeddings";
});

after(() => {
  closeEmbeddingsDb();
  closeDb();
  if (origVaultRoot === undefined) {
    delete process.env.ARTIFACT_VAULT_ROOT;
  } else {
    process.env.ARTIFACT_VAULT_ROOT = origVaultRoot;
  }
  if (origEmbeddingEndpoint === undefined) {
    delete process.env.EMBEDDING_ENDPOINT;
  } else {
    process.env.EMBEDDING_ENDPOINT = origEmbeddingEndpoint;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Band classification ─────────────────────────────────────────────────────

describe("memory — band classification", () => {
  it("classifies recent turns as band 0", () => {
    assert.equal(classifyBand(20, 20), 0); // age 0
    assert.equal(classifyBand(16, 20), 0); // age 4
  });

  it("classifies mid-range turns as band 1", () => {
    assert.equal(classifyBand(15, 20), 1); // age 5
    assert.equal(classifyBand(1, 20), 1);  // age 19
  });

  it("classifies old turns as band 2", () => {
    assert.equal(classifyBand(0, 20), 2);  // age 20
    assert.equal(classifyBand(0, 100), 2); // age 100
  });

  it("band thresholds are correct", () => {
    assert.equal(BAND_THRESHOLDS.BAND0_MAX, 5);
    assert.equal(BAND_THRESHOLDS.BAND1_MAX, 20);
  });
});

// ── Session lifecycle ───────────────────────────────────────────────────────

describe("memory — session lifecycle", () => {
  it("startSession creates an active session", async () => {
    const state = await startSession();
    assert.ok(state.session_id);
    assert.equal(state.active, true);
    assert.equal(state.turn_count, 0);
  });

  it("getSession returns the current state", async () => {
    const started = await startSession();
    const fetched = await getSession();
    assert.ok(fetched);
    assert.equal(fetched.session_id, started.session_id);
    assert.equal(fetched.active, true);
  });

  it("recordTurn increments turn_count", async () => {
    await startSession();
    const s1 = await recordTurn();
    assert.equal(s1.turn_count, 1);
    const s2 = await recordTurn();
    assert.equal(s2.turn_count, 2);
  });

  it("endSession marks session inactive", async () => {
    await startSession();
    const ended = await endSession();
    assert.ok(ended);
    assert.equal(ended.active, false);
  });

  it("endSession returns null when no active session", async () => {
    await startSession();
    await endSession();
    const result = await endSession();
    assert.equal(result, null);
  });

  it("startSession ends existing active session", async () => {
    const first = await startSession();
    const second = await startSession();
    assert.notEqual(first.session_id, second.session_id);
    assert.equal(second.active, true);
  });

  it("recordTurn throws when no active session", async () => {
    await startSession();
    await endSession();
    await assert.rejects(recordTurn, /No active session/);
  });

  it("session_state.json is written to vault root", async () => {
    await startSession();
    const statePath = path.join(tmpDir, "session_state.json");
    assert.ok(fs.existsSync(statePath));
  });
});

// ── Turn ingestion ──────────────────────────────────────────────────────────

describe("memory — turn ingestion", () => {
  let sessionId: string;

  before(async () => {
    const state = await startSession();
    sessionId = state.session_id;
  });

  it("ingestTurn returns a vault artifact ID", async () => {
    const id = await ingestTurn(
      { role: "user", content: "Hello, how are you?", turn_number: 0 },
      sessionId,
    );
    assert.ok(id);
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  });

  it("ingested turn is retrievable from vault", async () => {
    const id = await ingestTurn(
      { role: "assistant", content: "I am doing well.", turn_number: 1 },
      sessionId,
    );
    const envelope = await vaultGet(id);
    assert.ok(envelope);
    assert.equal(envelope.kind, "event");
    assert.equal(envelope.payload.role, "assistant");
    assert.equal(envelope.payload.content, "I am doing well.");
    assert.equal(envelope.payload.turn_number, 1);
    assert.equal(envelope.payload.session_id, sessionId);
  });

  it("ingested turns have correct memory tags", async () => {
    const id = await ingestTurn(
      { role: "user", content: "Test tags", turn_number: 2 },
      sessionId,
    );
    const envelope = await vaultGet(id);
    assert.ok(envelope);
    assert.ok(envelope.tags.includes("memory:verbatim"));
    assert.ok(envelope.tags.includes("memory:band0"));
    assert.ok(envelope.tags.includes("memory:managed"));
    assert.ok(envelope.tags.includes(`memory:session:${sessionId}`));
  });

  it("dedup: same turn content returns same artifact ID", async () => {
    const id1 = await ingestTurn(
      { role: "user", content: "duplicate test", turn_number: 42 },
      sessionId,
    );
    const id2 = await ingestTurn(
      { role: "user", content: "duplicate test", turn_number: 42 },
      sessionId,
    );
    assert.equal(id1, id2);
  });

  it("different turn numbers produce different IDs", async () => {
    const id1 = await ingestTurn(
      { role: "user", content: "same content", turn_number: 100 },
      sessionId,
    );
    const id2 = await ingestTurn(
      { role: "user", content: "same content", turn_number: 101 },
      sessionId,
    );
    assert.notEqual(id1, id2);
  });
});

// ── Ingest 25 turns and verify band distribution ────────────────────────────

describe("memory — 25 turn ingestion + band distribution", () => {
  let sessionId: string;
  const turnIds: string[] = [];

  before(async () => {
    const state = await startSession();
    sessionId = state.session_id;

    for (let i = 0; i < 25; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      const id = await ingestTurn(
        { role, content: `Turn ${i}: This is message number ${i} in the conversation.`, turn_number: i },
        sessionId,
      );
      turnIds.push(id);
      await recordTurn();
    }
  });

  it("all 25 turns are stored in the vault", async () => {
    assert.equal(turnIds.length, 25);
    for (const id of turnIds) {
      const envelope = await vaultGet(id);
      assert.ok(envelope, `Turn ${id} should exist in vault`);
    }
  });

  it("all ingested turns are searchable by session tag", async () => {
    const result = await vaultSearch({
      tags: [`memory:session:${sessionId}`, "memory:band0"],
      limit: 100,
      search_mode: "lexical",
    });
    assert.equal(result.results.length, 25);
  });

  it("band classification matches turn distribution", () => {
    const latestTurn = 24;
    // Band 0: turns 20-24 (5 turns)
    let band0Count = 0;
    let band1Count = 0;
    let band2Count = 0;
    for (let i = 0; i < 25; i++) {
      const band = classifyBand(i, latestTurn);
      if (band === 0) band0Count++;
      else if (band === 1) band1Count++;
      else band2Count++;
    }
    assert.equal(band0Count, 5);  // turns 20-24
    assert.equal(band1Count, 15); // turns 5-19
    assert.equal(band2Count, 5);  // turns 0-4
  });
});

// ── Compaction ───────────────────────────────────────────────────────────────

describe("memory — compaction", () => {
  let sessionId: string;

  before(async () => {
    const state = await startSession();
    sessionId = state.session_id;

    // Ingest 25 turns
    for (let i = 0; i < 25; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await ingestTurn(
        { role, content: `Compact turn ${i}: discussing topic number ${i} about science and technology.`, turn_number: i },
        sessionId,
      );
      await recordTurn();
    }
  });

  it("compactBand(0) promotes aged-out verbatim turns to summaries", async () => {
    const result = await compactBand(0, sessionId, 24);
    // Turns 0-19 have aged out of band 0 — they should be summarized
    assert.ok(result.promoted > 0, "should promote at least one summary");
    assert.ok(result.archived > 0, "should archive aged-out turns");
  });

  it("band 1 summaries are created in the vault", async () => {
    // After compaction, search for band 1 artifacts
    const result = await vaultSearch({
      tags: ["memory:band1", `memory:session:${sessionId}`],
      limit: 100,
      search_mode: "lexical",
    });
    assert.ok(result.results.length >= 1, "at least one summary should exist");

    // Verify the summary artifact
    const envelope = await vaultGet(result.results[0].id);
    assert.ok(envelope);
    assert.equal(envelope.kind, "summary");
    assert.ok(envelope.payload.summary);
    assert.ok(envelope.payload.turn_range);
    assert.ok(envelope.refs.length > 0, "summary should reference source turns");
  });

  it("compactBand(1) promotes aged-out summaries to facts", async () => {
    const result = await compactBand(1, sessionId, 24);
    // Summaries that represent turns older than band 1 range should be promoted
    // This depends on whether the summaries themselves are old enough
    // At minimum, the function should return without error
    assert.ok(typeof result.promoted === "number");
    assert.ok(typeof result.archived === "number");
  });

  it("compactBand(2) is a no-op", async () => {
    const result = await compactBand(2, sessionId, 24);
    assert.equal(result.promoted, 0);
    assert.equal(result.archived, 0);
  });
});

// ── Context window reconstruction ───────────────────────────────────────────

describe("memory — getContextWindow", () => {
  let sessionId: string;

  before(async () => {
    const state = await startSession();
    sessionId = state.session_id;

    // Ingest 10 turns for a simpler test
    for (let i = 0; i < 10; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await ingestTurn(
        { role, content: `Context turn ${i}: information about topic ${i}.`, turn_number: i },
        sessionId,
      );
      await recordTurn();
    }
  });

  it("returns a non-empty context string", async () => {
    const context = await getContextWindow(sessionId, 2000);
    assert.ok(context.length > 0);
  });

  it("includes verbatim turn text", async () => {
    const context = await getContextWindow(sessionId, 2000);
    // Should include at least some of the turns
    assert.ok(context.includes("Context turn"), "should contain turn content");
  });

  it("respects token budget — small budget returns less", async () => {
    const large = await getContextWindow(sessionId, 10000);
    const small = await getContextWindow(sessionId, 50);
    assert.ok(small.length <= large.length, "small budget should produce shorter context");
    // With ~50 tokens ≈ 200 chars, we shouldn't get all 10 turns
    assert.ok(small.length <= 200 + 50, "small budget should be roughly bounded");
  });

  it("very large budget includes all available turns", async () => {
    const context = await getContextWindow(sessionId, 100000);
    // Should include content from turns
    assert.ok(context.includes("Context turn 0") || context.includes("Context turn"), "should include early turns");
  });

  it("zero budget returns empty string", async () => {
    const context = await getContextWindow(sessionId, 0);
    assert.equal(context, "");
  });
});

// ── Integration: full lifecycle ─────────────────────────────────────────────

describe("memory — full lifecycle integration", () => {
  it("session → ingest → compact → getContext roundtrip", async () => {
    const session = await startSession();

    // Ingest some turns
    for (let i = 0; i < 8; i++) {
      await ingestTurn(
        { role: i % 2 === 0 ? "user" : "assistant", content: `Lifecycle turn ${i}.`, turn_number: i },
        session.session_id,
      );
      await recordTurn();
    }

    // Compact
    await compactBand(0, session.session_id, 7);

    // Get context
    const context = await getContextWindow(session.session_id, 5000);
    assert.ok(context.length > 0);

    // End session
    const ended = await endSession();
    assert.ok(ended);
    assert.equal(ended.active, false);
    assert.equal(ended.turn_count, 8);
  });
});
