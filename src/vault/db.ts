/**
 * Vault SQLite index — replaces JSONL index with better-sqlite3.
 *
 * Schema:
 *   artifacts(id TEXT PK, kind TEXT, tags TEXT, created_at TEXT,
 *             last_seen_at TEXT, snippet TEXT, payload_text TEXT)
 *   artifacts_fts — FTS5 virtual table over id, kind, tags, snippet, payload_text
 *
 * The SQLite DB is purely an index — blob storage remains on disk.
 * If deleted, the DB can be rebuilt from blobs.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DbIndexRow = {
  id: string;
  kind: string;
  tags: string;       // JSON array string
  created_at: string;
  last_seen_at: string;
  snippet: string;
  payload_text: string;
};

let _db: Database.Database | null = null;

function vaultRoot(): string {
  return process.env.ARTIFACT_VAULT_ROOT ?? path.join(process.cwd(), ".vault");
}

function dbPath(): string {
  return path.join(vaultRoot(), "index.sqlite");
}

function jsonlPath(): string {
  return path.join(vaultRoot(), "index.jsonl");
}

function migratedPath(): string {
  return path.join(vaultRoot(), "index.jsonl.migrated");
}

function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      tags         TEXT NOT NULL DEFAULT '[]',
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      snippet      TEXT NOT NULL DEFAULT '',
      payload_text TEXT NOT NULL DEFAULT ''
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
      id, kind, tags, snippet, payload_text,
      content=artifacts,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
      INSERT INTO artifacts_fts(rowid, id, kind, tags, snippet, payload_text)
        VALUES (new.rowid, new.id, new.kind, new.tags, new.snippet, new.payload_text);
    END;

    CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
      INSERT INTO artifacts_fts(artifacts_fts, rowid, id, kind, tags, snippet, payload_text)
        VALUES ('delete', old.rowid, old.id, old.kind, old.tags, old.snippet, old.payload_text);
    END;

    CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
      INSERT INTO artifacts_fts(artifacts_fts, rowid, id, kind, tags, snippet, payload_text)
        VALUES ('delete', old.rowid, old.id, old.kind, old.tags, old.snippet, old.payload_text);
      INSERT INTO artifacts_fts(rowid, id, kind, tags, snippet, payload_text)
        VALUES (new.rowid, new.id, new.kind, new.tags, new.snippet, new.payload_text);
    END;
  `);
}

function migrateFromJsonl(db: Database.Database): void {
  const jp = jsonlPath();
  const sp = dbPath();

  // Only migrate if JSONL exists and SQLite was just created (empty)
  if (!fs.existsSync(jp)) return;

  const count = (db.prepare("SELECT COUNT(*) as c FROM artifacts").get() as { c: number }).c;
  if (count > 0) return; // already has data, skip migration

  let raw: string;
  try {
    raw = fs.readFileSync(jp, "utf-8");
  } catch {
    return;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO artifacts (id, kind, tags, created_at, last_seen_at, snippet, payload_text)
    VALUES (@id, @kind, @tags, @created_at, @last_seen_at, @snippet, @payload_text)
  `);

  const insertMany = db.transaction((lines: string[]) => {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          id: string;
          kind: string;
          tags: string[];
          created_at: string;
          last_seen_at: string;
          snippet: string;
        };
        insert.run({
          id: parsed.id,
          kind: parsed.kind,
          tags: JSON.stringify(parsed.tags ?? []),
          created_at: parsed.created_at,
          last_seen_at: parsed.last_seen_at,
          snippet: parsed.snippet ?? "",
          payload_text: parsed.snippet ?? "",
        });
      } catch {
        // skip corrupt lines
      }
    }
  });

  insertMany(raw.split("\n"));

  // Rename JSONL to .migrated
  try {
    fs.renameSync(jp, migratedPath());
  } catch {
    // non-fatal: the data is in SQLite now
  }
}

/**
 * Get (or create) the singleton DB connection for the current vault root.
 * Handles schema init and JSONL migration on first open.
 */
export function getDb(): Database.Database {
  const expected = dbPath();

  // If vault root changed (e.g., tests switching ARTIFACT_VAULT_ROOT),
  // close old connection and open a new one.
  if (_db && _db.name !== expected) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }

  if (!_db) {
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    _db = new Database(expected);
    initSchema(_db);
    migrateFromJsonl(_db);
  }

  return _db;
}

/**
 * Close the DB connection. Used by tests for cleanup.
 */
export function closeDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}
