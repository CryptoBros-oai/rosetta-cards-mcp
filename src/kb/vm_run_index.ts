/**
 * VM Run Index — append-only JSONL index for fast run search.
 *
 * Each line in `data/runs/index.jsonl` is a JSON record describing a persisted run.
 * On re-persist of same run_id, old records are marked superseded.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RunMetadata } from "./vm_types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_PATH = join("data", "runs", "index.jsonl");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const IndexRecordSchema = z.object({
  schema_version: z.literal("run_index.v1"),
  run_id: z.string(),
  run_hash12: z.string(),
  program_fingerprint: z.string(),
  program_id: z.string(),
  program_version: z.string(),
  env: z.object({
    run_seed: z.number().int(),
    world_seed: z.number().int(),
    max_steps: z.number().int(),
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  }),
  total_steps: z.number().int().nonnegative(),
  halted_early: z.boolean(),
  halt_reason: z.string().optional(),
  final_bag_sum: z.number(),
  created_at: z.string(),
  tags: z.array(z.string()).optional(),
  superseded: z.boolean().optional(),
}).strict();
export type IndexRecord = z.infer<typeof IndexRecordSchema>;

export const SearchFiltersSchema = z.object({
  program_fingerprint: z.string().optional(),
  program_id: z.string().optional(),
  run_seed_min: z.number().int().optional(),
  run_seed_max: z.number().int().optional(),
  world_seed_min: z.number().int().optional(),
  world_seed_max: z.number().int().optional(),
  total_steps_min: z.number().int().optional(),
  total_steps_max: z.number().int().optional(),
  final_bag_sum_min: z.number().optional(),
  final_bag_sum_max: z.number().optional(),
  halted_early: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().positive().default(50),
  offset: z.number().int().nonnegative().default(0),
}).strict();
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export type SearchResult = {
  total: number;
  offset: number;
  limit: number;
  records: IndexRecord[];
};

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append a run's metadata to the index file.
 * If run_id already exists, mark old records as superseded.
 */
export function appendToIndex(
  metadata: RunMetadata,
  tags?: string[],
): IndexRecord {
  const record: IndexRecord = {
    schema_version: "run_index.v1",
    run_id: metadata.run_hash,
    run_hash12: metadata.run_hash.slice(0, 12),
    program_fingerprint: metadata.program_fingerprint,
    program_id: metadata.program_id,
    program_version: metadata.program_version,
    env: {
      run_seed: metadata.env.run_seed,
      world_seed: metadata.env.world_seed,
      max_steps: metadata.env.max_steps,
    },
    total_steps: metadata.total_steps,
    halted_early: metadata.halted_early,
    final_bag_sum: metadata.final_bag_sum,
    created_at: metadata.created_at,
  };
  if (metadata.halt_reason !== undefined) {
    record.halt_reason = metadata.halt_reason;
  }
  if (metadata.env.params && Object.keys(metadata.env.params).length > 0) {
    record.env.params = metadata.env.params;
  }
  if (tags && tags.length > 0) {
    record.tags = tags;
  }

  // Read existing lines, mark superseded if needed, append new record
  let lines: string[] = [];
  if (existsSync(INDEX_PATH)) {
    const content = readFileSync(INDEX_PATH, "utf-8").trim();
    if (content) {
      lines = content.split("\n");
    }
  }

  // Mark old records with same run_id as superseded
  const updatedLines = lines.map((line) => {
    try {
      const existing = JSON.parse(line) as IndexRecord;
      if (existing.run_id === record.run_id && !existing.superseded) {
        return JSON.stringify({ ...existing, superseded: true });
      }
    } catch {
      // keep malformed lines as-is
    }
    return line;
  });

  updatedLines.push(JSON.stringify(record));
  writeFileSync(INDEX_PATH, updatedLines.join("\n") + "\n");

  return record;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load all non-superseded index records from disk.
 * Sorted by created_at descending, ties broken by run_id lexicographic.
 */
export function loadIndex(): IndexRecord[] {
  if (!existsSync(INDEX_PATH)) return [];

  const content = readFileSync(INDEX_PATH, "utf-8").trim();
  if (!content) return [];

  const records: IndexRecord[] = [];
  for (const line of content.split("\n")) {
    try {
      const parsed = JSON.parse(line) as IndexRecord;
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
    return a.run_id.localeCompare(b.run_id);
  });

  return records;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search the index with filters.
 * Default sort: created_at descending, ties by run_id.
 */
export function searchIndex(rawFilters: z.input<typeof SearchFiltersSchema>): SearchResult {
  const filters = SearchFiltersSchema.parse(rawFilters);
  let records = loadIndex();

  if (filters.program_fingerprint !== undefined) {
    records = records.filter((r) => r.program_fingerprint === filters.program_fingerprint);
  }
  if (filters.program_id !== undefined) {
    records = records.filter((r) => r.program_id === filters.program_id);
  }
  if (filters.run_seed_min !== undefined) {
    records = records.filter((r) => r.env.run_seed >= filters.run_seed_min!);
  }
  if (filters.run_seed_max !== undefined) {
    records = records.filter((r) => r.env.run_seed <= filters.run_seed_max!);
  }
  if (filters.world_seed_min !== undefined) {
    records = records.filter((r) => r.env.world_seed >= filters.world_seed_min!);
  }
  if (filters.world_seed_max !== undefined) {
    records = records.filter((r) => r.env.world_seed <= filters.world_seed_max!);
  }
  if (filters.total_steps_min !== undefined) {
    records = records.filter((r) => r.total_steps >= filters.total_steps_min!);
  }
  if (filters.total_steps_max !== undefined) {
    records = records.filter((r) => r.total_steps <= filters.total_steps_max!);
  }
  if (filters.final_bag_sum_min !== undefined) {
    records = records.filter((r) => r.final_bag_sum >= filters.final_bag_sum_min!);
  }
  if (filters.final_bag_sum_max !== undefined) {
    records = records.filter((r) => r.final_bag_sum <= filters.final_bag_sum_max!);
  }
  if (filters.halted_early !== undefined) {
    records = records.filter((r) => r.halted_early === filters.halted_early);
  }
  if (filters.tags && filters.tags.length > 0) {
    const requiredTags = filters.tags;
    records = records.filter((r) =>
      requiredTags.every((t) => r.tags?.includes(t)),
    );
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

const RUNS_DIR = join("data", "runs");

/**
 * Rebuild index.jsonl from all on-disk RUN_METADATA.json files.
 * Used for recovery if the index is corrupted or deleted.
 */
export function rebuildRunIndex(): IndexRecord[] {
  if (!existsSync(RUNS_DIR)) return [];

  const entries = readdirSync(RUNS_DIR, { withFileTypes: true });
  const records: IndexRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;
    const metaPath = join(RUNS_DIR, entry.name, "RUN_METADATA.json");
    if (!existsSync(metaPath)) continue;
    try {
      const metadata: RunMetadata = JSON.parse(
        readFileSync(metaPath, "utf-8"),
      );
      const record: IndexRecord = {
        schema_version: "run_index.v1",
        run_id: metadata.run_hash,
        run_hash12: metadata.run_hash.slice(0, 12),
        program_fingerprint: metadata.program_fingerprint,
        program_id: metadata.program_id,
        program_version: metadata.program_version,
        env: {
          run_seed: metadata.env.run_seed,
          world_seed: metadata.env.world_seed,
          max_steps: metadata.env.max_steps,
        },
        total_steps: metadata.total_steps,
        halted_early: metadata.halted_early,
        final_bag_sum: metadata.final_bag_sum,
        created_at: metadata.created_at,
      };
      if (metadata.halt_reason !== undefined) {
        record.halt_reason = metadata.halt_reason;
      }
      if (metadata.env.params && Object.keys(metadata.env.params).length > 0) {
        record.env.params = metadata.env.params;
      }
      records.push(record);
    } catch {
      // skip corrupted entries
    }
  }

  // Sort and write
  records.sort((a, b) => {
    const dateCmp = b.created_at.localeCompare(a.created_at);
    if (dateCmp !== 0) return dateCmp;
    return a.run_id.localeCompare(b.run_id);
  });

  const lines = records.map((r) => JSON.stringify(r));
  writeFileSync(INDEX_PATH, lines.join("\n") + "\n");

  return records;
}
