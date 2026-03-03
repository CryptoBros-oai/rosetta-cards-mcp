/**
 * Derived artifact pipeline — PNG rendering and storage reporting.
 *
 * Key invariants:
 *  - PNGs are written to derived/ subdirectories, never to the identity dirs.
 *  - PNG path and rendered_at are stored in the MetaV1 sidecar's `render`
 *    field (last-write-wins) — they NEVER enter the hashed payload.
 *  - Re-rendering the same hash is always safe; the derived file is overwritten
 *    in-place (same path, deterministic naming by hash12).
 *  - For weekly summaries (not MetaV1 artifacts), render info is written to
 *    a lightweight JSON sidecar: derived/summaries/summary_week_<hash12>.render.json
 */

import fs from "node:fs/promises";
import path from "node:path";

import { renderCardPng, renderSummaryPng } from "./render.js";
import { mergeMeta } from "./vault.js";
import { CardPayloadSchema, WeeklySummarySchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function vaultRoot(): string {
  return process.env.VAULT_ROOT ?? process.cwd();
}

function derivedCardPngPath(hash: string): string {
  return path.join(vaultRoot(), "derived", "cards", `card_${hash.slice(0, 12)}.png`);
}

function derivedSummaryPngPath(hash: string): string {
  return path.join(
    vaultRoot(), "derived", "summaries",
    `summary_week_${hash.slice(0, 12)}.png`,
  );
}

function derivedSummaryRenderSidecarPath(hash: string): string {
  return path.join(
    vaultRoot(), "derived", "summaries",
    `summary_week_${hash.slice(0, 12)}.render.json`,
  );
}

function cardArtifactPath(hash: string): string {
  return path.join(vaultRoot(), "data", "cards", `card_${hash.slice(0, 12)}.json`);
}

function summaryArtifactPath(hash: string): string {
  return path.join(
    vaultRoot(), "data", "summaries",
    `summary_week_${hash.slice(0, 12)}.json`,
  );
}

// ---------------------------------------------------------------------------
// Build 1a — Render card PNG
// ---------------------------------------------------------------------------

export type RenderCardResult = {
  hash: string;
  png_path: string;           // absolute path
  png_relative: string;       // relative from vault root (stored in meta)
  template: string;
  rendered_at: string;
};

/**
 * Render a card's derived PNG into derived/cards/.
 *
 * The card identity JSON is NOT modified. Render metadata is merged into
 * the card's MetaV1 sidecar under the `render` field (last-write-wins).
 */
export async function renderCardPngToDerived(
  hash: string,
  opts: {
    style?: "default" | "dark" | "light";
    include_qr?: boolean;
  } = {},
): Promise<RenderCardResult> {
  const root = vaultRoot();

  // Load and validate the card
  const raw = await fs.readFile(cardArtifactPath(hash), "utf-8");
  const card = CardPayloadSchema.parse(JSON.parse(raw));

  // Confirm the hash matches what's on disk
  if (card.hash !== hash) {
    throw new Error(
      `Hash mismatch: requested ${hash.slice(0, 12)} but card.hash=${card.hash.slice(0, 12)}`,
    );
  }

  const png_path = derivedCardPngPath(hash);
  await fs.mkdir(path.dirname(png_path), { recursive: true });

  await renderCardPng({
    payload: card,
    png_path,
    style: opts.style ?? "default",
    include_qr: opts.include_qr ?? true,
  });

  const template = `card.v1:${opts.style ?? "default"}`;
  const rendered_at = new Date().toISOString();
  const png_relative = path.relative(root, png_path);

  // Merge render pointer into the card's MetaV1 sidecar (identity file unchanged)
  await mergeMeta(hash, "card", {
    render: { path: png_relative, template, rendered_at },
  });

  return { hash, png_path, png_relative, template, rendered_at };
}

// ---------------------------------------------------------------------------
// Build 1b — Render weekly summary PNG
// ---------------------------------------------------------------------------

export type RenderSummaryResult = {
  hash: string;
  png_path: string;
  png_relative: string;
  render_sidecar_path: string;
  template: string;
  rendered_at: string;
};

/** Lightweight render sidecar schema for weekly summaries. */
export type SummaryRenderInfo = {
  schema_version: "render.v1";
  artifact_hash: string;
  artifact_type: "summary";
  path: string;
  template: string;
  rendered_at: string;
};

/**
 * Render a weekly summary's derived PNG into derived/summaries/.
 *
 * The summary identity JSON is NOT modified. Render info is written to
 * a lightweight JSON sidecar: derived/summaries/summary_week_<hash12>.render.json
 */
export async function renderSummaryPngToDerived(
  hash: string,
): Promise<RenderSummaryResult> {
  const root = vaultRoot();

  // Load and validate the summary
  const raw = await fs.readFile(summaryArtifactPath(hash), "utf-8");
  const summary = WeeklySummarySchema.parse(JSON.parse(raw));

  if (summary.hash !== hash) {
    throw new Error(
      `Hash mismatch: requested ${hash.slice(0, 12)} but summary.hash=${summary.hash.slice(0, 12)}`,
    );
  }

  const png_path = derivedSummaryPngPath(hash);
  await fs.mkdir(path.dirname(png_path), { recursive: true });

  await renderSummaryPng({ payload: summary, png_path });

  const template = "summary.week.v1";
  const rendered_at = new Date().toISOString();
  const png_relative = path.relative(root, png_path);

  // Write render sidecar (lightweight — WeeklySummary is not a MetaV1 artifact)
  const renderSidecar: SummaryRenderInfo = {
    schema_version: "render.v1",
    artifact_hash: hash,
    artifact_type: "summary",
    path: png_relative,
    template,
    rendered_at,
  };
  const sidecarPath = derivedSummaryRenderSidecarPath(hash);
  await fs.writeFile(sidecarPath, JSON.stringify(renderSidecar, null, 2), "utf-8");

  return {
    hash,
    png_path,
    png_relative,
    render_sidecar_path: sidecarPath,
    template,
    rendered_at,
  };
}

// ---------------------------------------------------------------------------
// Build 2 — Storage Report
// ---------------------------------------------------------------------------

export type DirReport = {
  name: string;
  path: string;
  file_count: number;
  total_bytes: number;
  total_mb: number;
};

export type StorageReport = {
  generated_at: string;
  vault_root: string;
  directories: DirReport[];
  totals: {
    file_count: number;
    total_bytes: number;
    total_gb: number;
  };
  warnings: {
    directory: string;
    threshold_gb: number;
    current_gb: number;
    message: string;
  }[];
};

export type StorageThresholds = {
  docs_gb?: number;
  cards_gb?: number;
  events_gb?: number;
  blobs_gb?: number;
  index_gb?: number;
  derived_gb?: number;
  total_gb?: number;
};

const DEFAULT_THRESHOLDS: Required<StorageThresholds> = {
  docs_gb: 5,
  cards_gb: 5,
  events_gb: 1,
  blobs_gb: 20,
  index_gb: 10,
  derived_gb: 10,
  total_gb: 50,
};

async function dirStats(dirPath: string): Promise<{ file_count: number; total_bytes: number }> {
  let file_count = 0;
  let total_bytes = 0;

  async function walk(p: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          file_count++;
          total_bytes += stat.size;
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(dirPath);
  return { file_count, total_bytes };
}

/**
 * Generate a storage report for the vault.
 * Walks data/ and derived/ subdirectories and checks against budget thresholds.
 */
export async function storageReport(
  thresholds: StorageThresholds = {},
): Promise<StorageReport> {
  const root = vaultRoot();
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const generated_at = new Date().toISOString();

  const dirsToScan: Array<{ name: string; dir: string; threshold_key: keyof typeof t }> = [
    { name: "docs",    dir: path.join(root, "data", "docs"),       threshold_key: "docs_gb" },
    { name: "cards",   dir: path.join(root, "data", "cards"),      threshold_key: "cards_gb" },
    { name: "events",  dir: path.join(root, "data", "events"),     threshold_key: "events_gb" },
    { name: "blobs",   dir: path.join(root, "data", "blobs"),      threshold_key: "blobs_gb" },
    { name: "index",   dir: path.join(root, "data", "index"),      threshold_key: "index_gb" },
    { name: "derived", dir: path.join(root, "derived"),             threshold_key: "derived_gb" },
  ];

  const directories: DirReport[] = [];
  const warnings: StorageReport["warnings"] = [];

  let total_files = 0;
  let total_bytes_all = 0;

  for (const { name, dir, threshold_key } of dirsToScan) {
    const { file_count, total_bytes } = await dirStats(dir);
    const total_mb = total_bytes / (1024 * 1024);
    const current_gb = total_bytes / (1024 * 1024 * 1024);
    const threshold_gb = t[threshold_key] as number;

    directories.push({
      name,
      path: path.relative(root, dir),
      file_count,
      total_bytes,
      total_mb: Math.round(total_mb * 100) / 100,
    });

    total_files += file_count;
    total_bytes_all += total_bytes;

    if (current_gb >= threshold_gb) {
      warnings.push({
        directory: name,
        threshold_gb,
        current_gb: Math.round(current_gb * 1000) / 1000,
        message: `${name} is ${(current_gb * 1024).toFixed(0)} MB — at or above ${threshold_gb} GB budget threshold`,
      });
    }
  }

  const total_gb = total_bytes_all / (1024 * 1024 * 1024);
  if (total_gb >= t.total_gb) {
    warnings.push({
      directory: "total",
      threshold_gb: t.total_gb,
      current_gb: Math.round(total_gb * 1000) / 1000,
      message: `Total vault size ${(total_gb * 1024).toFixed(0)} MB — at or above ${t.total_gb} GB total budget`,
    });
  }

  return {
    generated_at,
    vault_root: root,
    directories,
    totals: {
      file_count: total_files,
      total_bytes: total_bytes_all,
      total_gb: Math.round(total_gb * 10000) / 10000,
    },
    warnings,
  };
}
