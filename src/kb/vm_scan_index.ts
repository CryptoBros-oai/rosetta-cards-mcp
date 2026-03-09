/**
 * VM Scan Index — append-only JSONL index for fast scan search.
 *
 * Each line in `data/runs/_scans/index.jsonl` is a JSON record
 * describing a persisted phase scan. Mirrors the pattern of vm_run_index.ts.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PhaseScanResult } from "./vm_phase_scan.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCANS_DIR = join("data", "runs", "_scans");
const SCAN_INDEX_PATH = join(SCANS_DIR, "index.jsonl");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ScanIndexRecordSchema = z.object({
  schema_version: z.literal("scan_index.v1"),
  scan_id: z.string(),
  scan_hash12: z.string(),
  program_id: z.string(),
  program_fingerprint: z.string(),
  knobs: z.array(z.object({
    name: z.string(),
    type: z.string(),
    refinable: z.boolean(),
  }).strict()),
  counts: z.object({
    grid_points: z.number().int().nonnegative(),
    phase_hints: z.number().int().nonnegative(),
    dossier_entries: z.number().int().nonnegative(),
    adaptive_refinements: z.number().int().nonnegative().nullable(),
  }).strict(),
  regime: z.object({
    halted: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    halt_fraction: z.number(),
  }).strict(),
  scan_dir: z.string(),
  created_at: z.string(),
  superseded: z.boolean().optional(),
}).strict();
export type ScanIndexRecord = z.infer<typeof ScanIndexRecordSchema>;

export const ScanSearchFiltersSchema = z.object({
  program_id: z.string().optional(),
  program_fingerprint: z.string().optional(),
  min_hints: z.number().int().nonnegative().optional(),
  max_hints: z.number().int().nonnegative().optional(),
  min_grid_points: z.number().int().nonnegative().optional(),
  max_grid_points: z.number().int().nonnegative().optional(),
  has_adaptive: z.boolean().optional(),
  halt_fraction_min: z.number().optional(),
  halt_fraction_max: z.number().optional(),
  limit: z.number().int().positive().default(50),
  offset: z.number().int().nonnegative().default(0),
}).strict();
export type ScanSearchFilters = z.infer<typeof ScanSearchFiltersSchema>;

export type ScanSearchResult = {
  total: number;
  offset: number;
  limit: number;
  records: ScanIndexRecord[];
};

// ---------------------------------------------------------------------------
// Knob type inference (mirrors make_phase_transition_report.mjs)
// ---------------------------------------------------------------------------

function inferKnobType(values: unknown[]): string {
  if (values.length === 0) return "unknown";
  const types = new Set(values.map((v) => typeof v));
  if (types.size > 1) return "mixed";
  const t = [...types][0];
  if (t === "number") {
    return (values as number[]).some((v) => !Number.isInteger(v)) ? "float" : "integer";
  }
  return t;
}

function isRefinable(values: unknown[]): boolean {
  if (!values.every((v) => typeof v === "number")) return false;
  return (values as number[]).some((v) => !Number.isInteger(v));
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append a scan's summary to the index file.
 * If scan_id already exists, mark old records as superseded.
 */
export function appendToScanIndex(
  result: PhaseScanResult,
  scanDir: string,
): ScanIndexRecord {
  const si = result.scan_index;
  const hints = result.phase_hints.hints;
  const dossier = result.formalized_dossier;

  const halted = si.points.filter((p) => p.metrics.halted_early).length;
  const total = si.points.length;
  const completed = total - halted;
  const haltFraction = total > 0
    ? Math.round((halted / total) * 10000) / 10000
    : 0;

  const record: ScanIndexRecord = {
    schema_version: "scan_index.v1",
    scan_id: si.scan_hash,
    scan_hash12: si.scan_hash.slice(0, 12),
    program_id: si.program_id,
    program_fingerprint: si.program_fingerprint,
    knobs: si.knobs.map((k) => ({
      name: k.key,
      type: inferKnobType(k.values),
      refinable: isRefinable(k.values),
    })),
    counts: {
      grid_points: si.grid_size,
      phase_hints: hints.length,
      dossier_entries: dossier.entries.length,
      adaptive_refinements: result.adaptive
        ? result.adaptive.refinements.length
        : null,
    },
    regime: { halted, completed, total, halt_fraction: haltFraction },
    scan_dir: scanDir,
    created_at: new Date().toISOString(),
  };

  // Read existing lines, mark superseded if needed, append new record
  let lines: string[] = [];
  if (existsSync(SCAN_INDEX_PATH)) {
    const content = readFileSync(SCAN_INDEX_PATH, "utf-8").trim();
    if (content) {
      lines = content.split("\n");
    }
  }

  const updatedLines = lines.map((line) => {
    try {
      const existing = JSON.parse(line) as ScanIndexRecord;
      if (existing.scan_id === record.scan_id && !existing.superseded) {
        return JSON.stringify({ ...existing, superseded: true });
      }
    } catch {
      // keep malformed lines as-is
    }
    return line;
  });

  updatedLines.push(JSON.stringify(record));
  writeFileSync(SCAN_INDEX_PATH, updatedLines.join("\n") + "\n");

  return record;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load all non-superseded scan index records from disk.
 * Sorted by created_at descending, ties broken by scan_id lexicographic.
 */
export function loadScanIndex(): ScanIndexRecord[] {
  if (!existsSync(SCAN_INDEX_PATH)) return [];

  const content = readFileSync(SCAN_INDEX_PATH, "utf-8").trim();
  if (!content) return [];

  const records: ScanIndexRecord[] = [];
  for (const line of content.split("\n")) {
    try {
      const parsed = JSON.parse(line) as ScanIndexRecord;
      if (!parsed.superseded) {
        records.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }

  records.sort((a, b) => {
    const dateCmp = b.created_at.localeCompare(a.created_at);
    if (dateCmp !== 0) return dateCmp;
    return a.scan_id.localeCompare(b.scan_id);
  });

  return records;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search the scan index with filters.
 * Default sort: created_at descending, ties by scan_id.
 */
export function searchScanIndex(
  rawFilters: z.input<typeof ScanSearchFiltersSchema>,
): ScanSearchResult {
  const filters = ScanSearchFiltersSchema.parse(rawFilters);
  let records = loadScanIndex();

  if (filters.program_id !== undefined) {
    records = records.filter((r) => r.program_id === filters.program_id);
  }
  if (filters.program_fingerprint !== undefined) {
    records = records.filter((r) => r.program_fingerprint === filters.program_fingerprint);
  }
  if (filters.min_hints !== undefined) {
    records = records.filter((r) => r.counts.phase_hints >= filters.min_hints!);
  }
  if (filters.max_hints !== undefined) {
    records = records.filter((r) => r.counts.phase_hints <= filters.max_hints!);
  }
  if (filters.min_grid_points !== undefined) {
    records = records.filter((r) => r.counts.grid_points >= filters.min_grid_points!);
  }
  if (filters.max_grid_points !== undefined) {
    records = records.filter((r) => r.counts.grid_points <= filters.max_grid_points!);
  }
  if (filters.has_adaptive !== undefined) {
    if (filters.has_adaptive) {
      records = records.filter((r) => r.counts.adaptive_refinements !== null);
    } else {
      records = records.filter((r) => r.counts.adaptive_refinements === null);
    }
  }
  if (filters.halt_fraction_min !== undefined) {
    records = records.filter((r) => r.regime.halt_fraction >= filters.halt_fraction_min!);
  }
  if (filters.halt_fraction_max !== undefined) {
    records = records.filter((r) => r.regime.halt_fraction <= filters.halt_fraction_max!);
  }

  const total = records.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  const paged = records.slice(offset, offset + limit);

  return { total, offset, limit, records: paged };
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild scan index from disk scan directories.
 * Used for recovery if index.jsonl is corrupted or deleted.
 */
export function rebuildScanIndex(): ScanIndexRecord[] {
  if (!existsSync(SCANS_DIR)) return [];

  const entries = readdirSync(SCANS_DIR, { withFileTypes: true });
  const records: ScanIndexRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const scanDir = join(SCANS_DIR, entry.name);
    const scanIndexPath = join(scanDir, "SCAN_INDEX.json");
    const hintsPath = join(scanDir, "PHASE_HINTS.json");
    const dossierPath = join(scanDir, "FORMALIZED_DOSSIER.json");
    if (!existsSync(scanIndexPath) || !existsSync(hintsPath)) continue;

    try {
      const si = JSON.parse(readFileSync(scanIndexPath, "utf-8"));
      const ph = JSON.parse(readFileSync(hintsPath, "utf-8"));
      const fd = existsSync(dossierPath)
        ? JSON.parse(readFileSync(dossierPath, "utf-8"))
        : { entries: [] };

      // Check for adaptive
      const refinedPath = join(scanDir, "PHASE_SCAN_REFINED.json");
      const refined = existsSync(refinedPath)
        ? JSON.parse(readFileSync(refinedPath, "utf-8"))
        : null;

      const halted = si.points.filter((p: any) => p.metrics.halted_early).length;
      const total = si.points.length;
      const completed = total - halted;
      const haltFraction = total > 0
        ? Math.round((halted / total) * 10000) / 10000
        : 0;

      records.push({
        schema_version: "scan_index.v1",
        scan_id: si.scan_hash,
        scan_hash12: si.scan_hash.slice(0, 12),
        program_id: si.program_id || "unknown",
        program_fingerprint: si.program_fingerprint,
        knobs: (si.knobs || []).map((k: any) => ({
          name: k.key,
          type: inferKnobType(k.values || []),
          refinable: isRefinable(k.values || []),
        })),
        counts: {
          grid_points: si.grid_size,
          phase_hints: ph.hints.length,
          dossier_entries: fd.entries.length,
          adaptive_refinements: refined ? (refined.refinements?.length ?? 0) : null,
        },
        regime: { halted, completed, total, halt_fraction: haltFraction },
        scan_dir: scanDir,
        created_at: new Date().toISOString(),
      });
    } catch {
      // skip corrupted entries
    }
  }

  records.sort((a, b) => {
    const dateCmp = b.created_at.localeCompare(a.created_at);
    if (dateCmp !== 0) return dateCmp;
    return a.scan_id.localeCompare(b.scan_id);
  });

  const lines = records.map((r) => JSON.stringify(r));
  writeFileSync(SCAN_INDEX_PATH, lines.join("\n") + "\n");

  return records;
}
