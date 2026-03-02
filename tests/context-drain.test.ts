import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chunkAtParagraphs, drainContext } from "../src/context_drain.js";

const DATA_DIR = path.join(process.cwd(), "data");

describe("chunkAtParagraphs", () => {
  it("splits at paragraph boundaries", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = chunkAtParagraphs(text, 30);
    assert.ok(chunks.length >= 2, "Must produce multiple chunks");
    // Rejoining with \n\n should reconstruct the original
    assert.equal(chunks.join("\n\n"), text);
  });

  it("keeps short text as single chunk", () => {
    const text = "Short text.";
    const chunks = chunkAtParagraphs(text, 1000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], text);
  });

  it("is deterministic — same input same output", () => {
    const text = "A\n\nB\n\nC\n\nD\n\nE";
    const c1 = chunkAtParagraphs(text, 5);
    const c2 = chunkAtParagraphs(text, 5);
    assert.deepEqual(c1, c2);
  });

  it("handles empty input", () => {
    const chunks = chunkAtParagraphs("", 100);
    assert.equal(chunks.length, 0, "Empty string produces no chunks");
  });

  it("hard splits when no paragraph boundary exists", () => {
    // Single long paragraph with no \n\n — must hard split at chunkChars
    const text = "x".repeat(100);
    const chunks = chunkAtParagraphs(text, 30);
    assert.ok(chunks.length >= 4, `Must hard split into 4+ chunks, got ${chunks.length}`);
    assert.equal(chunks.join(""), text, "Concatenation must reconstruct original");
    for (const c of chunks) {
      assert.ok(c.length <= 30, `Each chunk must be <= 30 chars, got ${c.length}`);
    }
  });
});

describe("drainContext", () => {
  // Cards are written to the real data/cards/ dir (vault.ts caches paths at load time)
  const createdCardIds: string[] = [];

  before(async () => {
    const dirs = ["cards", "blobs", "text"];
    for (const d of dirs) {
      await fs.mkdir(path.join(DATA_DIR, d), { recursive: true });
    }
  });

  after(async () => {
    // Clean up cards created during tests
    for (const cardId of createdCardIds) {
      await fs.rm(path.join(DATA_DIR, "cards", `${cardId}.json`), { force: true }).catch(() => {});
    }
  });

  it("returns drained:false when below threshold", async () => {
    const result = await drainContext({
      title: "Test Chat",
      chat_text: "Short chat.",
      target_max_chars: 1000,
      chunk_chars: 100,
    });
    assert.equal(result.drained, false);
  });

  it("drains text above threshold into chunks", async () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) {
      paragraphs.push(`Paragraph ${i}: ${"x".repeat(50)}`);
    }
    const chatText = paragraphs.join("\n\n");
    assert.ok(chatText.length >= 800, `Text length ${chatText.length} must be >= 800`);

    const result = await drainContext({
      title: "Test Chat Log",
      tags: ["test"],
      chat_text: chatText,
      target_max_chars: 1000,
      chunk_chars: 200,
    });

    assert.equal(result.drained, true);
    if (result.drained) {
      assert.ok(result.index_card_id, "Must have index card ID");
      assert.ok(result.index_card_hash, "Must have index card hash");
      assert.ok(result.chunk_card_ids.length > 0, "Must have chunk cards");
      assert.equal(result.chunk_count, result.chunk_card_ids.length);
      createdCardIds.push(result.index_card_id, ...result.chunk_card_ids);
    }
  });

  it("produces deterministic results for same input", async () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) {
      paragraphs.push(`Determinism test paragraph ${i}: ${"y".repeat(50)}`);
    }
    const chatText = paragraphs.join("\n\n");

    const r1 = await drainContext({
      title: "Determinism Test",
      chat_text: chatText,
      target_max_chars: 1000,
      chunk_chars: 200,
    });

    const r2 = await drainContext({
      title: "Determinism Test",
      chat_text: chatText,
      target_max_chars: 1000,
      chunk_chars: 200,
    });

    assert.equal(r1.drained, true);
    assert.equal(r2.drained, true);
    if (r1.drained && r2.drained) {
      assert.equal(
        r1.index_card_hash,
        r2.index_card_hash,
        "Same input must produce same index hash"
      );
      assert.deepEqual(
        r1.chunk_card_ids,
        r2.chunk_card_ids,
        "Same input must produce same chunk card IDs"
      );
      createdCardIds.push(r1.index_card_id, ...r1.chunk_card_ids);
    }
  });

  it("chunk cards conform to spec schema", async () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) {
      paragraphs.push(`Schema test paragraph ${i}: ${"w".repeat(50)}`);
    }
    const chatText = paragraphs.join("\n\n");

    const result = await drainContext({
      title: "Schema Test",
      chat_text: chatText,
      target_max_chars: 1000,
      chunk_chars: 200,
    });

    assert.equal(result.drained, true);
    if (result.drained) {
      // Read a chunk card and verify spec fields
      const cardPath = path.join(DATA_DIR, "cards", `${result.chunk_card_ids[0]}.json`);
      const chunk = JSON.parse(await fs.readFile(cardPath, "utf-8"));
      assert.equal(chunk.type, "chat_chunk");
      assert.equal(chunk.spec_version, "1.0");
      assert.equal(chunk.index, 1, "First chunk index must be 1 (1-based)");
      assert.ok(chunk.total > 0, "total must be positive");
      assert.ok(chunk.text, "Must have text sub-object");
      assert.ok(chunk.text.hash, "text must have hash");
      assert.ok(chunk.text.chars > 0, "text must have chars > 0");

      // Read the index card and verify chunking sub-object
      const indexPath = path.join(DATA_DIR, "cards", `${result.index_card_id}.json`);
      const idx = JSON.parse(await fs.readFile(indexPath, "utf-8"));
      assert.equal(idx.type, "chat_log_index");
      assert.ok(idx.chunking, "Must have chunking sub-object");
      assert.equal(idx.chunking.target_max_chars, 1000);
      assert.equal(idx.chunking.threshold, 0.8);
      assert.equal(idx.chunking.chunk_chars, 200);
      assert.ok(Array.isArray(idx.chunks), "chunks must be array");
      assert.equal(idx.chunks.length, result.chunk_count);

      createdCardIds.push(result.index_card_id, ...result.chunk_card_ids);
    }
  });

  it("chunk cards have correct tags", async () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) {
      paragraphs.push(`Tag test paragraph ${i}: ${"z".repeat(50)}`);
    }
    const chatText = paragraphs.join("\n\n");

    const result = await drainContext({
      title: "Tag Test",
      tags: ["session"],
      chat_text: chatText,
      target_max_chars: 1000,
      chunk_chars: 200,
    });

    assert.equal(result.drained, true);
    if (result.drained) {
      // Read back a chunk card from the real data dir
      const cardPath = path.join(
        DATA_DIR,
        "cards",
        `${result.chunk_card_ids[0]}.json`
      );
      const cardRaw = await fs.readFile(cardPath, "utf-8");
      const card = JSON.parse(cardRaw);
      assert.ok(card.tags.includes("chat"), "Chunk must have 'chat' tag");
      assert.ok(card.tags.includes("drain"), "Chunk must have 'drain' tag");
      assert.ok(card.tags.includes("session"), "Chunk must have user tag");
      createdCardIds.push(result.index_card_id, ...result.chunk_card_ids);
    }
  });
});
