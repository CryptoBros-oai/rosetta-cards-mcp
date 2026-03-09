/**
 * Artifact Vault — filesystem blob store + SQLite index.
 *
 * Layout (under ARTIFACT_VAULT_ROOT, default .vault/):
 *   blobs/<id[0:2]>/<id[2:4]>/<id>.json   (pretty-printed envelope)
 *   index.sqlite                           (SQLite FTS5 index)
 */

import fsp from "node:fs/promises";
import path from "node:path";

import {
  ARTIFACT_VERSION,
  PERSONAL_TAG_PREFIX,
  buildArtifactHashPayload,
  ArtifactEnvelopeSchema,
  type ArtifactEnvelope,
  type ArtifactKind,
  type ArtifactRef,
  type ArtifactSource,
} from "./schema.js";
import { assertVaultPayloadClean, computeArtifactId } from "./canon.js";
import { getDb, type DbIndexRow } from "./db.js";
import { embedSingle, getModelInfo } from "../embeddings/client.js";
import { upsertEmbedding, findSimilar } from "../embeddings/store.js";
import { getCurrentTier } from "../tiers/context.js";
import { assertArtifactCap, assertPutKindAllowed } from "../tiers/policy.js";

// ── Paths ────────────────────────────────────────────────────────────────────

function vaultRoot(): string {
  return process.env.ARTIFACT_VAULT_ROOT ?? path.join(process.cwd(), ".vault");
}

function blobDir(): string {
  return path.join(vaultRoot(), "blobs");
}

function blobPath(id: string): string {
  return path.join(blobDir(), id.slice(0, 2), id.slice(2, 4), `${id}.json`);
}

// ── Blob read/write ──────────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeBlob(envelope: ArtifactEnvelope): Promise<void> {
  const p = blobPath(envelope.id);
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, JSON.stringify(envelope, null, 2) + "\n", "utf-8");
}

async function readBlob(id: string): Promise<ArtifactEnvelope | null> {
  const p = blobPath(id);
  try {
    const raw = await fsp.readFile(p, "utf-8");
    return ArtifactEnvelopeSchema.parse(JSON.parse(raw));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// ── Index types (public, unchanged) ──────────────────────────────────────────

export interface IndexLine {
  id: string;
  kind: string;
  tags: string[];
  created_at: string;
  last_seen_at: string;
  snippet: string;
}

// ── SQLite index operations ──────────────────────────────────────────────────

function makeSnippet(payload: Record<string, unknown>): string {
  return JSON.stringify(payload).slice(0, 200);
}

function makePayloadText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function insertIndex(line: IndexLine & { payload_text: string }): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO artifacts (id, kind, tags, created_at, last_seen_at, snippet, payload_text)
    VALUES (@id, @kind, @tags, @created_at, @last_seen_at, @snippet, @payload_text)
  `).run({
    id: line.id,
    kind: line.kind,
    tags: JSON.stringify(line.tags),
    created_at: line.created_at,
    last_seen_at: line.last_seen_at,
    snippet: line.snippet,
    payload_text: line.payload_text,
  });
}

function updateLastSeen(id: string, ts: string): void {
  const db = getDb();
  db.prepare("UPDATE artifacts SET last_seen_at = @ts WHERE id = @id").run({ id, ts });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isPersonalArtifact(tags: string[]): boolean {
  return tags.some((t) => t.startsWith(PERSONAL_TAG_PREFIX));
}

function embeddingText(payload: Record<string, unknown>, tags: string[]): string {
  return JSON.stringify(payload) + " " + tags.join(" ");
}

/**
 * Async, fire-and-forget embedding. Never throws — embedding failure
 * must never block or fail a vault put.
 */
function embedArtifactAsync(id: string, payload: Record<string, unknown>, tags: string[]): void {
  const text = embeddingText(payload, tags);
  (async () => {
    try {
      const vec = await embedSingle(text);
      if (!vec) return; // endpoint unreachable, skip silently
      const info = await getModelInfo();
      upsertEmbedding(id, vec, info?.model ?? "unknown");
    } catch {
      // never fail a put due to embedding
    }
  })();
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface PutResult {
  id: string;
  created: boolean;
  created_at: string;
  last_seen_at: string;
}

export function getArtifactCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM artifacts").get() as { c: number };
  return row.c;
}

export async function vaultPut(input: {
  kind: ArtifactKind;
  payload: Record<string, unknown>;
  tags: string[];
  refs: ArtifactRef[];
  source?: ArtifactSource;
}): Promise<PutResult> {
  // Validate payload determinism
  assertVaultPayloadClean(input.payload);

  // Tier enforcement: kind restriction + artifact cap
  const tier = getCurrentTier();
  assertPutKindAllowed(tier, input.kind);

  // Build structural hash payload and compute ID
  const hp = buildArtifactHashPayload({
    kind: input.kind,
    payload: input.payload,
    tags: input.tags,
    refs: input.refs,
  });
  const id = computeArtifactId(hp);

  // Check for existing blob (dedup)
  const existing = await readBlob(id);
  if (existing) {
    const now = new Date().toISOString();
    existing.last_seen_at = now;
    await writeBlob(existing);
    updateLastSeen(id, now);
    return {
      id,
      created: false,
      created_at: existing.created_at,
      last_seen_at: now,
    };
  }

  // Tier enforcement: artifact cap (only for new artifacts)
  assertArtifactCap(tier, getArtifactCount());

  // Build full envelope
  const now = new Date().toISOString();
  const envelope: ArtifactEnvelope = {
    version: ARTIFACT_VERSION,
    kind: input.kind,
    id,
    created_at: now,
    last_seen_at: now,
    ...(input.source ? { source: input.source } : {}),
    tags: [...input.tags].sort(),
    payload: input.payload,
    refs: [...input.refs],
  };

  await writeBlob(envelope);
  insertIndex({
    id,
    kind: input.kind,
    tags: envelope.tags,
    created_at: now,
    last_seen_at: now,
    snippet: makeSnippet(input.payload),
    payload_text: makePayloadText(input.payload),
  });

  // Fire-and-forget embedding — never blocks or fails the put
  embedArtifactAsync(id, input.payload, envelope.tags);

  return { id, created: true, created_at: now, last_seen_at: now };
}

export async function vaultGet(
  id: string,
): Promise<ArtifactEnvelope | null> {
  return readBlob(id);
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface SearchHit {
  id: string;
  kind: string;
  score: number;
  tags: string[];
  created_at: string;
  snippet: string;
}

export interface SearchResult {
  total: number;
  offset: number;
  limit: number;
  results: SearchHit[];
  search_mode: "hybrid" | "semantic" | "lexical";
}

export type SearchMode = "hybrid" | "semantic" | "lexical";

export async function vaultSearch(filters: {
  query?: string;
  kind?: ArtifactKind;
  tags?: string[];
  exclude_personal?: boolean;
  limit?: number;
  offset?: number;
  search_mode?: SearchMode;
}): Promise<SearchResult> {
  const limit = filters.limit ?? 10;
  const offset = filters.offset ?? 0;
  const requestedMode = filters.search_mode ?? "hybrid";
  const db = getDb();

  // Build WHERE clauses and params
  const whereClauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.kind) {
    whereClauses.push("a.kind = @kind");
    params.kind = filters.kind;
  }

  if (filters.exclude_personal) {
    whereClauses.push("a.tags NOT LIKE '%\"personal:%'");
  }

  // Tag AND filtering: each required tag must appear in the JSON array
  if (filters.tags && filters.tags.length > 0) {
    for (let i = 0; i < filters.tags.length; i++) {
      const paramName = `tag_${i}`;
      whereClauses.push(
        `(a.tags LIKE @${paramName}_a OR a.tags LIKE @${paramName}_b)`
      );
      params[`${paramName}_a`] = `[${JSON.stringify(filters.tags[i])}%`;
      params[`${paramName}_b`] = `%,${JSON.stringify(filters.tags[i])}%`;
    }
  }

  const whereStr = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

  if (!filters.query) {
    // No query: sort by last_seen_at desc, then id asc
    const countSql = `SELECT COUNT(*) as total FROM artifacts a ${whereStr}`;
    const dataSql = `
      SELECT a.id, a.kind, a.tags, a.created_at, a.last_seen_at, a.snippet
      FROM artifacts a
      ${whereStr}
      ORDER BY a.last_seen_at DESC, a.id ASC
      LIMIT @limit OFFSET @offset
    `;

    params.limit = limit;
    params.offset = offset;

    const totalRow = db.prepare(countSql).get(params) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const rows = db.prepare(dataSql).all(params) as DbIndexRow[];

    return {
      total,
      offset,
      limit,
      search_mode: "lexical",
      results: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        score: 0,
        tags: JSON.parse(r.tags) as string[],
        created_at: r.created_at,
        snippet: r.snippet,
      })),
    };
  }

  // We have a query — determine effective mode
  const useSemantic = requestedMode === "semantic" || requestedMode === "hybrid";
  const useLexical = requestedMode === "lexical" || requestedMode === "hybrid";

  // Try to get a query embedding if semantic is requested
  let queryVec: number[] | null = null;
  if (useSemantic) {
    try {
      queryVec = await embedSingle(filters.query);
    } catch {
      queryVec = null;
    }
  }

  // Determine effective mode based on what's available
  let effectiveMode: SearchMode;
  if (queryVec && useSemantic && !useLexical) {
    effectiveMode = "semantic";
  } else if (queryVec && useSemantic && useLexical) {
    effectiveMode = "hybrid";
  } else {
    effectiveMode = "lexical";
  }

  if (effectiveMode === "semantic") {
    // Pure semantic: get all candidate IDs from SQL filters, then rank by cosine
    const candidateSql = `
      SELECT a.id, a.kind, a.tags, a.created_at, a.snippet
      FROM artifacts a
      ${whereStr}
    `;
    const candidates = db.prepare(candidateSql).all(params) as DbIndexRow[];
    const candidateIds = candidates.map((c) => c.id);
    const similarities = findSimilar(queryVec!, limit + offset, candidateIds);
    const simMap = new Map(similarities.map((s) => [s.id, s.score]));
    const candidateMap = new Map(candidates.map((c) => [c.id, c]));

    const ranked = similarities
      .filter((s) => candidateMap.has(s.id))
      .slice(offset, offset + limit);

    return {
      total: similarities.length,
      offset,
      limit,
      search_mode: "semantic",
      results: ranked.map((s) => {
        const c = candidateMap.get(s.id)!;
        return {
          id: c.id,
          kind: c.kind,
          score: s.score,
          tags: JSON.parse(c.tags) as string[],
          created_at: c.created_at,
          snippet: c.snippet,
        };
      }),
    };
  }

  // Lexical or Hybrid: always start with FTS
  const ftsQuery = filters.query
    .split(/[\s]+/)
    .filter((t) => t.length >= 1)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");

  if (!ftsQuery) {
    return { total: 0, offset, limit, search_mode: effectiveMode, results: [] };
  }

  if (effectiveMode === "lexical") {
    // Pure FTS
    const countSql = `
      SELECT COUNT(*) as total
      FROM artifacts_fts f
      JOIN artifacts a ON a.rowid = f.rowid
      ${whereStr ? whereStr + " AND" : "WHERE"} artifacts_fts MATCH @query
    `;
    const dataSql = `
      SELECT a.id, a.kind, a.tags, a.created_at, a.last_seen_at, a.snippet,
             (-rank) as score
      FROM artifacts_fts f
      JOIN artifacts a ON a.rowid = f.rowid
      ${whereStr ? whereStr + " AND" : "WHERE"} artifacts_fts MATCH @query
      ORDER BY rank, a.last_seen_at DESC, a.id ASC
      LIMIT @limit OFFSET @offset
    `;

    params.query = ftsQuery;
    params.limit = limit;
    params.offset = offset;

    const totalRow = db.prepare(countSql).get(params) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;
    const rows = db.prepare(dataSql).all(params) as Array<DbIndexRow & { score: number }>;

    return {
      total,
      offset,
      limit,
      search_mode: "lexical",
      results: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        score: r.score,
        tags: JSON.parse(r.tags) as string[],
        created_at: r.created_at,
        snippet: r.snippet,
      })),
    };
  }

  // Hybrid: combine FTS scores with cosine similarity
  // Get a larger FTS candidate pool to re-rank with embeddings
  const poolSize = Math.max(limit * 5, 50);
  const ftsPoolSql = `
    SELECT a.id, a.kind, a.tags, a.created_at, a.last_seen_at, a.snippet,
           (-rank) as fts_score
    FROM artifacts_fts f
    JOIN artifacts a ON a.rowid = f.rowid
    ${whereStr ? whereStr + " AND" : "WHERE"} artifacts_fts MATCH @query
    ORDER BY rank
    LIMIT @pool_size
  `;

  params.query = ftsQuery;
  params.pool_size = poolSize;

  const ftsPool = db.prepare(ftsPoolSql).all(params) as Array<DbIndexRow & { fts_score: number }>;

  if (ftsPool.length === 0) {
    return { total: 0, offset, limit, search_mode: "hybrid", results: [] };
  }

  // Get cosine similarities for FTS candidates
  const ftsIds = ftsPool.map((r) => r.id);
  const similarities = findSimilar(queryVec!, ftsPool.length, ftsIds);
  const simMap = new Map(similarities.map((s) => [s.id, s.score]));

  // Normalize FTS scores to [0, 1]
  const maxFts = Math.max(...ftsPool.map((r) => r.fts_score), 1e-9);

  // Compute hybrid score: 0.6 * normalized_fts + 0.4 * cosine
  const hybridResults = ftsPool.map((r) => ({
    id: r.id,
    kind: r.kind,
    tags: JSON.parse(r.tags) as string[],
    created_at: r.created_at,
    snippet: r.snippet,
    score: 0.6 * (r.fts_score / maxFts) + 0.4 * (simMap.get(r.id) ?? 0),
  }));

  hybridResults.sort((a, b) => b.score - a.score);

  const total = hybridResults.length;
  const page = hybridResults.slice(offset, offset + limit);

  return {
    total,
    offset,
    limit,
    search_mode: "hybrid",
    results: page,
  };
}
