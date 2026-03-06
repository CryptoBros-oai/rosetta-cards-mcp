/**
 * Cortex Index Snapshot — rebuildable derived index over on-disk artifacts + meta sidecars.
 *
 * The snapshot is always derivable from the artifact store; it is never a
 * source of truth for artifact identity. It can be discarded and rebuilt at
 * any time with rebuildIndex().
 *
 * Layout:
 *   data/index/index_snapshot.json
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  EventCardSchema,
  ExecutionCardSchema,
  MetaV1Schema,
  IndexSnapshotV1Schema,
  type IndexSnapshotV1,
  type MetaV1,
} from "./schema.js";

const DEFAULT_ROOT = process.env.VAULT_ROOT ?? process.cwd();

export function indexPaths(vaultRoot = DEFAULT_ROOT) {
  return {
    CARD_DIR: path.join(vaultRoot, "data", "cards"),
    EVENT_DIR: path.join(vaultRoot, "data", "events"),
    INDEX_DIR: path.join(vaultRoot, "data", "index"),
    SNAPSHOT_PATH: path.join(vaultRoot, "data", "index", "index_snapshot.json"),
  };
}

/** Default snapshot path (uses process.env.VAULT_ROOT or cwd). */
export const SNAPSHOT_PATH = indexPaths().SNAPSHOT_PATH;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Add hash to a Record<string, string[]>, keeping lists sorted. */
function addToIndex(
  record: Record<string, string[]>,
  key: string,
  hash: string,
): void {
  if (!record[key]) record[key] = [];
  if (!record[key].includes(hash)) record[key].push(hash);
}

/** Relative path from a given base for storage. */
function rel(base: string, absolute: string): string {
  return path.relative(base, absolute);
}

/** Try to read + parse a JSON file; returns null on any error. */
async function tryReadJson(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Compute the co-located meta sidecar path within a given vault root.
 * Mirrors getMetaPath() in vault.ts but takes root as a parameter so
 * rebuildIndex() works with any isolated vault (e.g., test fixtures).
 */
function metaPathFor(
  vaultRoot: string,
  type: MetaV1["artifact_type"],
  hash: string,
): string {
  const h12 = hash.slice(0, 12);
  if (type === "event") {
    return path.join(vaultRoot, "data", "events", `card_event_${h12}.meta.json`);
  }
  if (type === "execution") {
    return path.join(vaultRoot, "data", "cards", `card_execution_${h12}.meta.json`);
  }
  return path.join(vaultRoot, "data", "cards", `card_${h12}.meta.json`);
}

/** Detect artifact type from parsed JSON. */
function detectType(obj: Record<string, unknown>): "card" | "event" | "execution" {
  if (obj.schema_version === "event.v1" && obj.artifact_type === "event") {
    return "event";
  }
  if (obj.schema_version === "execution.v1" && obj.artifact_type === "execution") {
    return "execution";
  }
  return "card";
}

/** Scan a directory for artifact .json files (excludes .meta.json and .png). */
async function scanDir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return []; // directory doesn't exist yet
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function rebuildIndex(
  opts: { built_at?: string; vaultRoot?: string } = {},
): Promise<IndexSnapshotV1> {
  const { CARD_DIR, EVENT_DIR, INDEX_DIR, SNAPSHOT_PATH } = indexPaths(opts.vaultRoot);
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const builtAt = opts.built_at ?? new Date().toISOString();

  // Accumulators
  const byHash: IndexSnapshotV1["by_hash"] = {};
  const tags: Record<string, string[]> = {};
  const rosettaVerb: Record<string, string[]> = {};
  const rosettaPolarity: Record<string, string[]> = {};
  const timeEntries: Array<{ hash: string; occurred_at: string }> = [];

  let cardCount = 0;
  let eventCount = 0;
  let executionCount = 0;
  let metaCount = 0;

  // Effective root for relative paths
  const root = opts.vaultRoot ?? DEFAULT_ROOT;

  // Collect all artifact files from both dirs, sorted for determinism
  const allFiles = [
    ...(await scanDir(CARD_DIR)),
    ...(await scanDir(EVENT_DIR)),
  ];

  for (const filePath of allFiles) {
    const obj = await tryReadJson(filePath);
    if (!obj || typeof obj !== "object") continue;

    const rec = obj as Record<string, unknown>;
    const hash = typeof rec.hash === "string" ? rec.hash : null;
    if (!hash) continue; // all known artifact types have a hash field

    // Skip if we already processed this hash (dedup across card/event dirs)
    if (byHash[hash]) continue;

    const artifactType = detectType(rec);

    // --- Tag index ---
    if (Array.isArray(rec.tags)) {
      for (const tag of rec.tags) {
        if (typeof tag === "string") addToIndex(tags, tag, hash);
      }
    }

    // --- Rosetta index (events and executions) ---
    if (artifactType === "event") {
      try {
        const parsed = EventCardSchema.parse(obj);
        addToIndex(rosettaVerb, parsed.rosetta.verb, hash);
        addToIndex(rosettaPolarity, parsed.rosetta.polarity, hash);
        eventCount++;
      } catch {
        cardCount++;
      }
    } else if (artifactType === "execution") {
      try {
        const parsed = ExecutionCardSchema.parse(obj);
        addToIndex(rosettaVerb, parsed.rosetta.verb, hash);
        addToIndex(rosettaPolarity, parsed.rosetta.polarity, hash);
        executionCount++;
      } catch {
        cardCount++;
      }
    } else {
      cardCount++;
    }

    // --- Meta sidecar ---
    const metaFilePath = metaPathFor(root, artifactType, hash);
    let metaRelPath: string | undefined;

    const metaObj = await tryReadJson(metaFilePath);
    if (metaObj) {
      try {
        const parsed = MetaV1Schema.parse(metaObj);
        metaRelPath = rel(root, metaFilePath);
        metaCount++;

        // Time index (from meta, not artifact — keeps identity clean)
        if (parsed.occurred_at) {
          timeEntries.push({ hash, occurred_at: parsed.occurred_at });
        }
      } catch {
        // Invalid meta — skip, don't count
      }
    }

    byHash[hash] = {
      artifact_type: artifactType,
      path: rel(root, filePath),
      ...(metaRelPath ? { meta_path: metaRelPath } : {}),
    };
  }

  // --- Sort all index lists for determinism ---
  for (const k of Object.keys(tags)) tags[k].sort();
  for (const k of Object.keys(rosettaVerb)) rosettaVerb[k].sort();
  for (const k of Object.keys(rosettaPolarity)) rosettaPolarity[k].sort();

  timeEntries.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  const snapshot: IndexSnapshotV1 = IndexSnapshotV1Schema.parse({
    schema_version: "index_snapshot.v1",
    built_at: builtAt,
    counts: { cards: cardCount, events: eventCount, executions: executionCount, metas: metaCount },
    by_hash: byHash,
    tags,
    rosetta: { verb: rosettaVerb, polarity: rosettaPolarity },
    time: { occurred_at: timeEntries },
  });

  const snapshotPath = indexPaths(opts.vaultRoot).SNAPSHOT_PATH;
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
  return snapshot;
}

export async function loadIndexSnapshot(
  vaultRoot?: string,
): Promise<IndexSnapshotV1 | null> {
  const snapshotPath = indexPaths(vaultRoot).SNAPSHOT_PATH;
  try {
    const raw = await fs.readFile(snapshotPath, "utf-8");
    return IndexSnapshotV1Schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
