/**
 * Embedding vector store — SQLite-backed, Tier 2 (derived/rebuildable).
 *
 * Stored in .vault/embeddings.sqlite (separate from index.sqlite).
 * Vectors are stored as Float32Array blobs.
 * Cosine similarity computed in JS.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// ── DB connection ───────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

function vaultRoot(): string {
  return process.env.ARTIFACT_VAULT_ROOT ?? path.join(process.cwd(), ".vault");
}

function embeddingsDbPath(): string {
  return path.join(vaultRoot(), "embeddings.sqlite");
}

function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id         TEXT PRIMARY KEY,
      vector     BLOB NOT NULL,
      model      TEXT NOT NULL DEFAULT 'unknown',
      dim        INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function getEmbeddingsDb(): Database.Database {
  const expected = embeddingsDbPath();
  if (_db && _db.name !== expected) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
  if (!_db) {
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    _db = new Database(expected);
    initSchema(_db);
  }
  return _db;
}

export function closeEmbeddingsDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

// ── Vector serialization ────────────────────────────────────────────────────

export function vectorToBlob(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

export function blobToVector(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

// ── Cosine similarity ───────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-9) return 0;
  return dot / denom;
}

// ── Store / retrieve ────────────────────────────────────────────────────────

export function upsertEmbedding(id: string, vector: number[], model: string): void {
  const db = getEmbeddingsDb();
  const blob = vectorToBlob(vector);
  db.prepare(`
    INSERT INTO embeddings (id, vector, model, dim, created_at)
    VALUES (@id, @vector, @model, @dim, @created_at)
    ON CONFLICT(id) DO UPDATE SET vector = @vector, model = @model, dim = @dim, created_at = @created_at
  `).run({
    id,
    vector: blob,
    model,
    dim: vector.length,
    created_at: new Date().toISOString(),
  });
}

export function getEmbedding(id: string): number[] | null {
  const db = getEmbeddingsDb();
  const row = db.prepare("SELECT vector FROM embeddings WHERE id = @id").get({ id }) as { vector: Buffer } | undefined;
  if (!row) return null;
  return blobToVector(row.vector);
}

export function hasEmbedding(id: string): boolean {
  const db = getEmbeddingsDb();
  const row = db.prepare("SELECT 1 FROM embeddings WHERE id = @id").get({ id });
  return row !== undefined;
}

/**
 * Get all artifact IDs that are in the index but not in the embeddings table.
 * Uses the main vault index DB to enumerate IDs.
 */
export function getMissingIds(indexDb: Database.Database): string[] {
  const embDb = getEmbeddingsDb();
  const allIds = indexDb.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>;
  const embeddedIds = new Set(
    (embDb.prepare("SELECT id FROM embeddings").all() as Array<{ id: string }>).map((r) => r.id),
  );
  return allIds.filter((r) => !embeddedIds.has(r.id)).map((r) => r.id);
}

// ── Similarity search ───────────────────────────────────────────────────────

export interface SimilarityHit {
  id: string;
  score: number;
}

/**
 * Find artifacts most similar to a query vector.
 * Loads candidate vectors into memory and computes cosine similarity.
 * If filterIds is provided, only consider those IDs.
 */
export function findSimilar(
  queryVec: number[],
  limit: number,
  filterIds?: string[],
): SimilarityHit[] {
  const db = getEmbeddingsDb();

  let rows: Array<{ id: string; vector: Buffer }>;
  if (filterIds && filterIds.length > 0) {
    // SQLite parameter limit: use temp table for large sets
    if (filterIds.length <= 500) {
      const placeholders = filterIds.map(() => "?").join(",");
      rows = db.prepare(
        `SELECT id, vector FROM embeddings WHERE id IN (${placeholders})`,
      ).all(...filterIds) as Array<{ id: string; vector: Buffer }>;
    } else {
      // Fallback: load all and filter in JS
      rows = (db.prepare("SELECT id, vector FROM embeddings").all() as Array<{ id: string; vector: Buffer }>)
        .filter((r) => {
          const s = new Set(filterIds);
          return s.has(r.id);
        });
    }
  } else {
    rows = db.prepare("SELECT id, vector FROM embeddings").all() as Array<{ id: string; vector: Buffer }>;
  }

  const scored: SimilarityHit[] = rows.map((r) => ({
    id: r.id,
    score: cosineSimilarity(queryVec, blobToVector(r.vector)),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
