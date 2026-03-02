import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "../src/kb/canonical.js";

const TEST_ROOT = path.join(process.cwd(), "data-ingest-test-root");
const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "sample-folder");

describe("blob store", () => {
  before(async () => {
    const dirs = ["docs", "cards", "index", "bundles", "pinsets", "packs", "blobs", "text"];
    for (const d of dirs) {
      await fs.mkdir(path.join(TEST_ROOT, "data", d), { recursive: true });
    }
  });

  after(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("putBlob stores and deduplicates by hash", async () => {
    const origCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { putBlob, getBlob } = await import("../src/kb/vault.js");

      const data = Buffer.from("test blob content", "utf-8");
      const expectedHash = hashBytes(data);

      const r1 = await putBlob(data);
      assert.equal(r1.hash, expectedHash);

      // Dedup: same data, same hash
      const r2 = await putBlob(data);
      assert.equal(r2.hash, r1.hash);
      assert.equal(r2.path, r1.path);

      // Can retrieve
      const retrieved = await getBlob(r1.hash);
      assert.deepEqual(retrieved, data);
    } finally {
      process.cwd = origCwd;
    }
  });

  it("putText stores canonical text and deduplicates", async () => {
    const origCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { putText, getText } = await import("../src/kb/vault.js");

      const text = "Hello world\r\nLine two\r\n";
      const r1 = await putText(text);
      assert.equal(r1.hash.length, 64);
      assert.ok(r1.canonical.endsWith("\n"));
      assert.ok(!r1.canonical.includes("\r"));

      // Dedup: same text, same hash
      const r2 = await putText(text);
      assert.equal(r2.hash, r1.hash);

      // Can retrieve
      const retrieved = await getText(r1.hash);
      assert.equal(retrieved, r1.canonical);
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe("file ingestion", () => {
  before(async () => {
    const dirs = ["docs", "cards", "index", "bundles", "pinsets", "packs", "blobs", "text"];
    for (const d of dirs) {
      await fs.mkdir(path.join(TEST_ROOT, "data", d), { recursive: true });
    }
  });

  after(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("ingests a text file with blob and text records", async () => {
    const origCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { ingestFile } = await import("../src/kb/ingest.js");

      const txtPath = path.join(FIXTURES, "readme.txt");
      const result = await ingestFile(txtPath, "readme.txt");

      assert.ok(result.blob_hash, "Must have blob hash");
      assert.ok(result.text_hash, "Must have text hash");
      assert.ok(result.card_hash, "Must have card hash");
      assert.ok(result.card_id, "Must have card ID");
      assert.equal(result.mime, "text/plain");
      assert.ok(result.bytes > 0, "Must have bytes > 0");
    } finally {
      process.cwd = origCwd;
    }
  });

  it("ingests a DOCX file with text extraction", async () => {
    const origCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { ingestFile } = await import("../src/kb/ingest.js");

      const docxPath = path.join(FIXTURES, "test.docx");
      const result = await ingestFile(docxPath, "test.docx");

      assert.ok(result.blob_hash, "Must have blob hash");
      assert.ok(result.text_hash, "DOCX must have extracted text hash");
      assert.ok(result.card_hash, "Must have card hash");
      assert.equal(
        result.mime,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe("folder ingestion", () => {
  before(async () => {
    const dirs = ["docs", "cards", "index", "bundles", "pinsets", "packs", "blobs", "text"];
    for (const d of dirs) {
      await fs.mkdir(path.join(TEST_ROOT, "data", d), { recursive: true });
    }
  });

  after(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("produces folder index card with correct counts", async () => {
    const origCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { ingestFolder } = await import("../src/kb/ingest.js");

      const result = await ingestFolder(FIXTURES);

      assert.ok(result.folder_card_id, "Must have folder card ID");
      assert.ok(result.folder_card_hash, "Must have folder card hash");
      assert.ok(result.counts.files_total >= 3, "Must have at least 3 files");
      assert.equal(result.counts.docx, 1, "Must detect 1 docx");
      assert.ok(
        result.counts.extracted_text_count >= 2,
        "Must extract text from at least txt + docx"
      );

      // All successful files should have hashes
      const successful = result.files.filter((f) => !f.error);
      for (const f of successful) {
        assert.ok(f.blob_hash, `${f.relative_path} must have blob hash`);
        assert.ok(f.card_hash, `${f.relative_path} must have card hash`);
      }
    } finally {
      process.cwd = origCwd;
    }
  });

  it("folder hash is deterministic", async () => {
    const origCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { ingestFolder } = await import("../src/kb/ingest.js");

      const r1 = await ingestFolder(FIXTURES);
      const r2 = await ingestFolder(FIXTURES);

      assert.equal(
        r1.folder_card_hash,
        r2.folder_card_hash,
        "Same folder must produce same hash"
      );
    } finally {
      process.cwd = origCwd;
    }
  });
});
