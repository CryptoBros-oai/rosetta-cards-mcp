/**
 * Derived PNG pipeline tests — Build 1
 *
 * Covers:
 *   - renderCardPngToDerived: ENOENT (missing card), hash mismatch, full render
 *   - renderSummaryPngToDerived: ENOENT (missing summary), hash mismatch, full render
 *   - PNG written to correct derived/ path
 *   - Card MetaV1 render pointer updated (last-write-wins)
 *   - Summary render sidecar (render.v1) written
 *   - Identity invariance: rendering does NOT change card/summary identity hash
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { canonicalHash } from "../src/kb/canonical.js";
import { renderCardPngToDerived, renderSummaryPngToDerived } from "../src/kb/derived.js";
import { loadMeta } from "../src/kb/vault.js";
import type { CardPayload, WeeklySummary } from "../src/kb/schema.js";

// ---------------------------------------------------------------------------
// Isolated vault helper
// ---------------------------------------------------------------------------

async function withVault<T>(fn: (vaultRoot: string) => Promise<T>): Promise<T> {
  const vaultRoot = path.join(os.tmpdir(), `rosetta-dpng-${crypto.randomUUID()}`);
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCardPayload(): CardPayload {
  const cardBase = {
    version: "card.v1" as const,
    card_id: "card_derived_test_001",
    title: "Derived PNG Pipeline Test Card",
    bullets: [
      "Render card PNG to derived/cards/",
      "Update MetaV1 render pointer",
      "PNG never affects identity hash",
    ],
    tags: ["test", "derived", "png"],
    sources: [{ doc_id: "doc_derived_test", chunk_id: 0 }],
    created_at: "2026-03-02T00:00:00.000Z",
  };
  const hash = canonicalHash(cardBase as unknown as Record<string, unknown>);
  return { ...cardBase, hash };
}

function makeWeeklySummary(): WeeklySummary {
  const base = {
    schema_version: "summary.week.v1" as const,
    week_start: "2026-03-02",
    week_end: "2026-03-08",
    references: { events: [], cards: [] },
    highlights: ["Derived pipeline implemented"],
    decisions: ["PNG lives in derived/, never identity"],
    open_loops: ["Add diffing for re-renders"],
    risks: [],
  };
  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  return { ...base, hash };
}

async function writeCard(vaultRoot: string, card: CardPayload) {
  const dir = path.join(vaultRoot, "data", "cards");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `card_${card.hash.slice(0, 12)}.json`),
    JSON.stringify(card, null, 2),
    "utf-8",
  );
}

async function writeSummary(vaultRoot: string, summary: WeeklySummary) {
  const dir = path.join(vaultRoot, "data", "summaries");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(vaultRoot, "data", "summaries", `summary_week_${summary.hash.slice(0, 12)}.json`),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// renderCardPngToDerived — error paths (no Playwright)
// ---------------------------------------------------------------------------

describe("renderCardPngToDerived — error paths", () => {
  it("throws ENOENT for non-existent card hash", async () => {
    await withVault(async () => {
      const fakeHash = "0".repeat(64);
      await assert.rejects(
        () => renderCardPngToDerived(fakeHash),
        (err: Error) => {
          assert.ok(
            err.message.includes("ENOENT") || err.message.includes("no such file"),
            `Expected ENOENT, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  });

  it("throws on hash mismatch between stored card and requested hash", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      // Store card at its correct path, then request with a different hash
      // that happens to produce the same first-12-char prefix
      await writeCard(root, card);

      // Use the correct path but call with a different full hash
      // (same prefix → file found, but card.hash !== requestedHash)
      const wrongHash = card.hash.slice(0, 12) + "f".repeat(52);
      await assert.rejects(
        () => renderCardPngToDerived(wrongHash),
        (err: Error) => {
          assert.ok(
            err.message.includes("Hash mismatch") || err.message.includes("mismatch"),
            `Expected hash mismatch error, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// renderSummaryPngToDerived — error paths (no Playwright)
// ---------------------------------------------------------------------------

describe("renderSummaryPngToDerived — error paths", () => {
  it("throws ENOENT for non-existent summary hash", async () => {
    await withVault(async () => {
      const fakeHash = "1".repeat(64);
      await assert.rejects(
        () => renderSummaryPngToDerived(fakeHash),
        (err: Error) => {
          assert.ok(
            err.message.includes("ENOENT") || err.message.includes("no such file"),
            `Expected ENOENT, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  });

  it("throws on hash mismatch between stored summary and requested hash", async () => {
    await withVault(async (root) => {
      const summary = makeWeeklySummary();
      await writeSummary(root, summary);

      const wrongHash = summary.hash.slice(0, 12) + "e".repeat(52);
      await assert.rejects(
        () => renderSummaryPngToDerived(wrongHash),
        (err: Error) => {
          assert.ok(
            err.message.includes("Hash mismatch") || err.message.includes("mismatch"),
            `Expected hash mismatch error, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// renderCardPngToDerived — full pipeline (Playwright)
// ---------------------------------------------------------------------------

describe("renderCardPngToDerived — full pipeline", { timeout: 30_000 }, () => {
  it("renders PNG to derived/cards/ and returns correct result shape", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      await writeCard(root, card);

      const result = await renderCardPngToDerived(card.hash);

      assert.equal(result.hash, card.hash);
      assert.ok(result.png_path.endsWith(".png"), "png_path ends with .png");
      assert.ok(result.png_path.includes("derived"), "png_path in derived/");
      assert.ok(result.png_relative.startsWith("derived"), "relative path starts with derived/");
      assert.ok(result.template.startsWith("card.v1:"), "template is card.v1:*");
      assert.ok(result.rendered_at.startsWith("20"), "rendered_at is ISO date");
    });
  });

  it("PNG file exists on disk after render", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      await writeCard(root, card);

      const result = await renderCardPngToDerived(card.hash);

      const stat = await fs.stat(result.png_path);
      assert.ok(stat.isFile(), "PNG is a regular file");
      assert.ok(stat.size > 0, "PNG has non-zero size");
    });
  });

  it("PNG is in derived/cards/ — never in identity dir (data/)", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      await writeCard(root, card);

      const result = await renderCardPngToDerived(card.hash);

      assert.ok(
        result.png_path.includes(path.join("derived", "cards")),
        "PNG must be in derived/cards/",
      );
      assert.ok(
        !result.png_path.includes(path.join("data", "cards")),
        "PNG must NOT be in data/cards/",
      );
    });
  });

  it("render pointer is merged into MetaV1 sidecar", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      await writeCard(root, card);

      const result = await renderCardPngToDerived(card.hash);

      const meta = await loadMeta(card.hash, "card");
      assert.ok(meta, "meta sidecar was created");
      assert.ok(meta!.render, "meta has render field");
      assert.equal(meta!.render!.path, result.png_relative);
      assert.equal(meta!.render!.template, result.template);
      assert.equal(meta!.render!.rendered_at, result.rendered_at);
    });
  });

  it("render pointer is last-write-wins (second render overwrites first)", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      await writeCard(root, card);

      const result1 = await renderCardPngToDerived(card.hash);
      const result2 = await renderCardPngToDerived(card.hash);

      const meta = await loadMeta(card.hash, "card");
      assert.ok(meta!.render, "meta has render field after second render");
      assert.equal(meta!.render!.rendered_at, result2.rendered_at);
      // rendered_at from second call should be >= first
      assert.ok(
        new Date(result2.rendered_at) >= new Date(result1.rendered_at),
        "second rendered_at >= first",
      );
    });
  });

  it("style option is reflected in template", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      await writeCard(root, card);

      const result = await renderCardPngToDerived(card.hash, { style: "dark" });
      assert.equal(result.template, "card.v1:dark");
    });
  });

  it("PNG filename is deterministic: card_<hash12>.png", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      await writeCard(root, card);

      const result = await renderCardPngToDerived(card.hash);
      const expectedFilename = `card_${card.hash.slice(0, 12)}.png`;
      assert.ok(
        result.png_path.endsWith(expectedFilename),
        `Expected filename ending in ${expectedFilename}, got ${result.png_path}`,
      );
    });
  });

  it("card identity JSON is not modified by render", async () => {
    await withVault(async (root) => {
      const card = makeCardPayload();
      await writeCard(root, card);

      const identityPathBefore = path.join(root, "data", "cards", `card_${card.hash.slice(0, 12)}.json`);
      const beforeRaw = await fs.readFile(identityPathBefore, "utf-8");

      await renderCardPngToDerived(card.hash);

      const afterRaw = await fs.readFile(identityPathBefore, "utf-8");
      assert.equal(afterRaw, beforeRaw, "card identity JSON must not change after render");
    });
  });
});

// ---------------------------------------------------------------------------
// renderSummaryPngToDerived — full pipeline (Playwright)
// ---------------------------------------------------------------------------

describe("renderSummaryPngToDerived — full pipeline", { timeout: 30_000 }, () => {
  it("renders PNG to derived/summaries/ and returns correct result shape", async () => {
    await withVault(async (root) => {
      const summary = makeWeeklySummary();
      await writeSummary(root, summary);

      const result = await renderSummaryPngToDerived(summary.hash);

      assert.equal(result.hash, summary.hash);
      assert.ok(result.png_path.endsWith(".png"));
      assert.ok(result.png_path.includes("derived"));
      assert.equal(result.template, "summary.week.v1");
      assert.ok(result.rendered_at.startsWith("20"));
    });
  });

  it("PNG file exists on disk after render", async () => {
    await withVault(async (root) => {
      const summary = makeWeeklySummary();
      await writeSummary(root, summary);

      const result = await renderSummaryPngToDerived(summary.hash);

      const stat = await fs.stat(result.png_path);
      assert.ok(stat.isFile());
      assert.ok(stat.size > 0);
    });
  });

  it("PNG is in derived/summaries/ — never in data/", async () => {
    await withVault(async (root) => {
      const summary = makeWeeklySummary();
      await writeSummary(root, summary);

      const result = await renderSummaryPngToDerived(summary.hash);

      assert.ok(result.png_path.includes(path.join("derived", "summaries")));
      assert.ok(!result.png_path.includes(path.join("data", "summaries")));
    });
  });

  it("writes render.v1 sidecar JSON", async () => {
    await withVault(async (root) => {
      const summary = makeWeeklySummary();
      await writeSummary(root, summary);

      const result = await renderSummaryPngToDerived(summary.hash);

      const sidecarRaw = await fs.readFile(result.render_sidecar_path, "utf-8");
      const sidecar = JSON.parse(sidecarRaw);

      assert.equal(sidecar.schema_version, "render.v1");
      assert.equal(sidecar.artifact_hash, summary.hash);
      assert.equal(sidecar.artifact_type, "summary");
      assert.equal(sidecar.path, result.png_relative);
      assert.equal(sidecar.template, "summary.week.v1");
      assert.equal(sidecar.rendered_at, result.rendered_at);
    });
  });

  it("sidecar path is in derived/summaries/", async () => {
    await withVault(async (root) => {
      const summary = makeWeeklySummary();
      await writeSummary(root, summary);

      const result = await renderSummaryPngToDerived(summary.hash);

      assert.ok(result.render_sidecar_path.endsWith(".render.json"));
      assert.ok(result.render_sidecar_path.includes(path.join("derived", "summaries")));
    });
  });

  it("summary identity JSON is not modified by render", async () => {
    await withVault(async (root) => {
      const summary = makeWeeklySummary();
      await writeSummary(root, summary);

      const identityPath = path.join(root, "data", "summaries", `summary_week_${summary.hash.slice(0, 12)}.json`);
      const beforeRaw = await fs.readFile(identityPath, "utf-8");

      await renderSummaryPngToDerived(summary.hash);

      const afterRaw = await fs.readFile(identityPath, "utf-8");
      assert.equal(afterRaw, beforeRaw, "summary identity JSON must not change after render");
    });
  });

  it("PNG filename is deterministic: summary_week_<hash12>.png", async () => {
    await withVault(async (root) => {
      const summary = makeWeeklySummary();
      await writeSummary(root, summary);

      const result = await renderSummaryPngToDerived(summary.hash);
      const expectedFilename = `summary_week_${summary.hash.slice(0, 12)}.png`;
      assert.ok(
        result.png_path.endsWith(expectedFilename),
        `Expected ${expectedFilename}, got ${path.basename(result.png_path)}`,
      );
    });
  });
});
