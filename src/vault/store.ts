/**
 * Artifact Vault — filesystem blob store + JSONL index.
 *
 * Layout (under ARTIFACT_VAULT_ROOT, default .vault/):
 *   blobs/<id[0:2]>/<id[2:4]>/<id>.json   (pretty-printed envelope)
 *   index.jsonl                             (one JSON line per artifact)
 */

import fs from "node:fs";
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

// ── Paths ────────────────────────────────────────────────────────────────────

function vaultRoot(): string {
  return process.env.ARTIFACT_VAULT_ROOT ?? path.join(process.cwd(), ".vault");
}

function blobDir(): string {
  return path.join(vaultRoot(), "blobs");
}

function indexPath(): string {
  return path.join(vaultRoot(), "index.jsonl");
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

// ── JSONL index ──────────────────────────────────────────────────────────────

export interface IndexLine {
  id: string;
  kind: string;
  tags: string[];
  created_at: string;
  last_seen_at: string;
  snippet: string;
}

function loadIndex(): IndexLine[] {
  const p = indexPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const lines: IndexLine[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed) as IndexLine);
      } catch {
        // skip corrupt lines
      }
    }
    return lines;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function appendIndex(line: IndexLine): Promise<void> {
  const p = indexPath();
  await ensureDir(path.dirname(p));
  await fsp.appendFile(p, JSON.stringify(line) + "\n", "utf-8");
}

async function updateLastSeen(id: string, ts: string): Promise<void> {
  const lines = loadIndex();
  const updated = lines.map((l) =>
    l.id === id ? { ...l, last_seen_at: ts } : l,
  );
  const p = indexPath();
  await fsp.writeFile(
    p,
    updated.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSnippet(payload: Record<string, unknown>): string {
  return JSON.stringify(payload).slice(0, 200);
}

export function isPersonalArtifact(tags: string[]): boolean {
  return tags.some((t) => t.startsWith(PERSONAL_TAG_PREFIX));
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface PutResult {
  id: string;
  created: boolean;
  created_at: string;
  last_seen_at: string;
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
    await updateLastSeen(id, now);
    return {
      id,
      created: false,
      created_at: existing.created_at,
      last_seen_at: now,
    };
  }

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
  await appendIndex({
    id,
    kind: input.kind,
    tags: envelope.tags,
    created_at: now,
    last_seen_at: now,
    snippet: makeSnippet(input.payload),
  });

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
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((t) => t.length >= 2);
}

export async function vaultSearch(filters: {
  query?: string;
  kind?: ArtifactKind;
  tags?: string[];
  exclude_personal?: boolean;
  limit?: number;
  offset?: number;
}): Promise<SearchResult> {
  const limit = filters.limit ?? 10;
  const offset = filters.offset ?? 0;

  let entries = loadIndex();

  // Filter by kind
  if (filters.kind) {
    entries = entries.filter((e) => e.kind === filters.kind);
  }

  // Filter by tags (AND)
  if (filters.tags && filters.tags.length > 0) {
    const required = new Set(filters.tags);
    entries = entries.filter((e) =>
      [...required].every((t) => e.tags.includes(t)),
    );
  }

  // Exclude personal artifacts
  if (filters.exclude_personal) {
    entries = entries.filter((e) => !isPersonalArtifact(e.tags));
  }

  // Score and sort
  let scored: (IndexLine & { score: number })[];
  if (filters.query) {
    const queryTokens = tokenize(filters.query);
    scored = entries.map((e) => {
      let score = 0;
      // Kind match
      if (queryTokens.includes(e.kind.toLowerCase())) score += 10;
      // Tag matches
      const lowerTags = e.tags.map((t) => t.toLowerCase());
      for (const qt of queryTokens) {
        for (const lt of lowerTags) {
          if (lt.includes(qt)) score += 25;
        }
      }
      // Snippet token matches
      const snippetTokens = tokenize(e.snippet);
      for (const qt of queryTokens) {
        for (const st of snippetTokens) {
          if (st.includes(qt)) score += 5;
        }
      }
      return { ...e, score };
    });
    // Sort by score desc, then last_seen_at desc, then id asc
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.last_seen_at.localeCompare(a.last_seen_at) ||
        a.id.localeCompare(b.id),
    );
  } else {
    // No query: sort by last_seen_at desc, then id asc
    scored = entries
      .map((e) => ({ ...e, score: 0 }))
      .sort(
        (a, b) =>
          b.last_seen_at.localeCompare(a.last_seen_at) ||
          a.id.localeCompare(b.id),
      );
  }

  const total = scored.length;
  const page = scored.slice(offset, offset + limit);

  return {
    total,
    offset,
    limit,
    results: page.map((e) => ({
      id: e.id,
      kind: e.kind,
      score: e.score,
      tags: e.tags,
      created_at: e.created_at,
      snippet: e.snippet,
    })),
  };
}
