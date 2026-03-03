/**
 * Storage Report tests — Build 2
 *
 * Covers:
 *   - Empty vault → zero counts, no warnings
 *   - Files in subdirectories → correct per-dir and total counts
 *   - Threshold exceeded → warning generated
 *   - Total threshold exceeded → total warning
 *   - Custom thresholds override defaults
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { storageReport } from "../src/kb/derived.js";

// ---------------------------------------------------------------------------
// Isolated vault (derived.ts reads process.env.VAULT_ROOT at call time)
// ---------------------------------------------------------------------------

async function withVault<T>(fn: (vaultRoot: string) => Promise<T>): Promise<T> {
  const vaultRoot = path.join(os.tmpdir(), `rosetta-store-${crypto.randomUUID()}`);
  await fs.mkdir(vaultRoot, { recursive: true });
  const prev = process.env.VAULT_ROOT;
  process.env.VAULT_ROOT = vaultRoot;
  try {
    return await fn(vaultRoot);
  } finally {
    if (prev === undefined) delete process.env.VAULT_ROOT;
    else process.env.VAULT_ROOT = prev;
    await fs.rm(vaultRoot, { recursive: true, force: true });
  }
}

async function writeFile(p: string, content: string) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
}

// ---------------------------------------------------------------------------

describe("storageReport — empty vault", () => {
  it("returns zero counts and no warnings when no dirs exist", async () => {
    await withVault(async () => {
      const report = await storageReport();
      assert.equal(report.totals.file_count, 0);
      assert.equal(report.totals.total_bytes, 0);
      assert.equal(report.warnings.length, 0);
      assert.equal(report.directories.length, 6);
      for (const dir of report.directories) {
        assert.equal(dir.file_count, 0);
        assert.equal(dir.total_bytes, 0);
      }
    });
  });

  it("reports include generated_at and vault_root", async () => {
    await withVault(async (root) => {
      const report = await storageReport();
      assert.ok(report.generated_at.startsWith("20"), "generated_at is ISO date");
      assert.equal(report.vault_root, root);
    });
  });
});

describe("storageReport — file counting", () => {
  it("counts files in data/cards", async () => {
    await withVault(async (root) => {
      await writeFile(path.join(root, "data", "cards", "card_aaa.json"), '{"test":1}');
      await writeFile(path.join(root, "data", "cards", "card_bbb.json"), '{"test":2}');

      const report = await storageReport();
      const cardsDir = report.directories.find((d) => d.name === "cards");
      assert.ok(cardsDir, "cards dir present");
      assert.equal(cardsDir!.file_count, 2);
      assert.ok(cardsDir!.total_bytes > 0);
      assert.equal(report.totals.file_count, 2);
    });
  });

  it("counts files across multiple directories", async () => {
    await withVault(async (root) => {
      await writeFile(path.join(root, "data", "docs", "doc1.json"), "aaa");
      await writeFile(path.join(root, "data", "cards", "card1.json"), "bb");
      await writeFile(path.join(root, "data", "events", "event1.json"), "cccc");
      await writeFile(path.join(root, "derived", "cards", "card.png"), "x");

      const report = await storageReport();
      assert.equal(report.totals.file_count, 4);

      const docs = report.directories.find((d) => d.name === "docs")!;
      const cards = report.directories.find((d) => d.name === "cards")!;
      const events = report.directories.find((d) => d.name === "events")!;
      const derived = report.directories.find((d) => d.name === "derived")!;

      assert.equal(docs.file_count, 1);
      assert.equal(cards.file_count, 1);
      assert.equal(events.file_count, 1);
      assert.equal(derived.file_count, 1);
    });
  });

  it("walks nested subdirectories within derived/", async () => {
    await withVault(async (root) => {
      await writeFile(path.join(root, "derived", "cards", "c1.png"), "png1");
      await writeFile(path.join(root, "derived", "summaries", "s1.png"), "png2");
      await writeFile(path.join(root, "derived", "summaries", "s1.render.json"), "{}");

      const report = await storageReport();
      const derived = report.directories.find((d) => d.name === "derived")!;
      assert.equal(derived.file_count, 3);
    });
  });

  it("total_bytes sums correctly across dirs", async () => {
    await withVault(async (root) => {
      const content = "1234567890"; // 10 bytes
      await writeFile(path.join(root, "data", "cards", "card1.json"), content);
      await writeFile(path.join(root, "data", "docs", "doc1.json"), content);

      const report = await storageReport();
      assert.equal(report.totals.total_bytes, 20);
    });
  });
});

describe("storageReport — directory paths", () => {
  it("directory paths are relative to vault root", async () => {
    await withVault(async () => {
      const report = await storageReport();
      const cards = report.directories.find((d) => d.name === "cards")!;
      assert.ok(!path.isAbsolute(cards.path), "path should be relative");
      assert.equal(cards.path, path.join("data", "cards"));
    });
  });

  it("includes all 6 expected directories", async () => {
    await withVault(async () => {
      const report = await storageReport();
      const names = report.directories.map((d) => d.name);
      assert.deepEqual(names.sort(), ["blobs", "cards", "derived", "docs", "events", "index"]);
    });
  });
});

describe("storageReport — threshold warnings", () => {
  it("no warnings when under threshold", async () => {
    await withVault(async (root) => {
      await writeFile(path.join(root, "data", "cards", "card1.json"), "small file");
      const report = await storageReport({ cards_gb: 1 }); // 1 GB threshold, tiny file
      assert.equal(report.warnings.length, 0);
    });
  });

  it("generates warning when threshold exceeded", async () => {
    await withVault(async (root) => {
      // Write 10 bytes, set threshold to 0 GB → always exceeds
      await writeFile(path.join(root, "data", "cards", "card1.json"), "tenBytes!!!");
      const report = await storageReport({ cards_gb: 0 });

      const cardWarning = report.warnings.find((w) => w.directory === "cards");
      assert.ok(cardWarning, "cards warning should be present");
      assert.equal(cardWarning!.threshold_gb, 0);
      assert.ok(cardWarning!.message.includes("cards"));
    });
  });

  it("generates total warning when total threshold exceeded", async () => {
    await withVault(async (root) => {
      await writeFile(path.join(root, "data", "docs", "doc1.json"), "some content here");
      const report = await storageReport({ total_gb: 0 });

      const totalWarning = report.warnings.find((w) => w.directory === "total");
      assert.ok(totalWarning, "total warning should be present");
    });
  });

  it("generates multiple warnings for multiple exceeded dirs", async () => {
    await withVault(async (root) => {
      await writeFile(path.join(root, "data", "cards", "c1.json"), "data");
      await writeFile(path.join(root, "data", "docs", "d1.json"), "data");
      const report = await storageReport({ cards_gb: 0, docs_gb: 0 });

      const names = report.warnings.map((w) => w.directory);
      assert.ok(names.includes("cards"), "cards warning present");
      assert.ok(names.includes("docs"), "docs warning present");
    });
  });

  it("warning includes threshold_gb and current_gb", async () => {
    await withVault(async (root) => {
      await writeFile(path.join(root, "data", "events", "e1.json"), "event data");
      const report = await storageReport({ events_gb: 0 });

      const w = report.warnings.find((w) => w.directory === "events")!;
      assert.ok(w, "events warning present");
      assert.equal(w.threshold_gb, 0);
      assert.ok(typeof w.current_gb === "number");
      assert.ok(w.current_gb >= 0);
    });
  });

  it("custom thresholds override defaults", async () => {
    await withVault(async (root) => {
      // With default derived_gb=10 no warning; with custom 0 → warning
      await writeFile(path.join(root, "derived", "cards", "c.png"), "png data");

      const defaultReport = await storageReport();
      assert.equal(defaultReport.warnings.filter((w) => w.directory === "derived").length, 0);

      const customReport = await storageReport({ derived_gb: 0 });
      assert.ok(customReport.warnings.some((w) => w.directory === "derived"));
    });
  });
});

describe("storageReport — totals", () => {
  it("total_gb field is present and numeric", async () => {
    await withVault(async () => {
      const report = await storageReport();
      assert.ok(typeof report.totals.total_gb === "number");
      assert.ok(report.totals.total_gb >= 0);
    });
  });

  it("total_mb rounds to 2 decimal places", async () => {
    await withVault(async (root) => {
      await writeFile(path.join(root, "data", "cards", "c.json"), "x".repeat(1024));
      const report = await storageReport();
      const cards = report.directories.find((d) => d.name === "cards")!;
      // total_mb should be rounded to 2 decimal places (Math.round * 100 / 100)
      const asStr = cards.total_mb.toString();
      const decimals = asStr.includes(".") ? asStr.split(".")[1].length : 0;
      assert.ok(decimals <= 2, `total_mb has at most 2 decimal places, got ${asStr}`);
    });
  });
});
