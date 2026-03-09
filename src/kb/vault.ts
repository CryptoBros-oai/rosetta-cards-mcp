import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  CardPayload,
  BehaviorPack,
  PackPolicies,
  DEFAULT_POLICIES,
  VaultContext,
  type FileArtifact,
  type FolderIndex,
  type FolderFileEntry,
  type FolderCounts,
  type BlobRef,
  type TextRef,
  type ChatChunk,
  type ChatLogIndex,
  type IngestReport,
  type EventCard,
  type ExecutionCard,
  type MetaV1,
  type MetaPatch,
  MetaV1Schema,
} from "./schema.js";
// Policy enforcement utilities
export class PolicyViolationError extends Error {
  public readonly blocked: string[];
  constructor(blocked: string[]) {
    super(`Pack policy violation: tags [${blocked.join(", ")}] are blocked by active behavior pack`);
    this.name = "PolicyViolationError";
    this.blocked = blocked;
  }
}

export function enforceBlockedTags(
  tags: string[],
  blockedTags: string[] | undefined,
  override?: boolean,
): void {
  if (override || !blockedTags?.length) return;
  const violations = tags.filter((t) => blockedTags.includes(t));
  if (violations.length > 0) {
    throw new PolicyViolationError(violations);
  }
}
import {
  canonicalHash,
  verifyHash,
  hashBytes,
  canonicalizeText,
  hashText,
} from "./canonical.js";

const ROOT = process.env.VAULT_ROOT ?? process.cwd();
const CARD_DIR = path.join(ROOT, "data", "cards");
const DOC_DIR = path.join(ROOT, "data", "docs");
const PINSET_DIR = path.join(ROOT, "data", "pinsets");
const PACK_DIR = path.join(ROOT, "data", "packs");
const BUNDLE_DIR = path.join(ROOT, "data", "bundles");
const BLOB_DIR = path.join(ROOT, "data", "blobs");
const TEXT_DIR = path.join(ROOT, "data", "text");
const ACTIVE_PINSET_PATH = path.join(PINSET_DIR, "active.json");
const ACTIVE_PACK_PATH = path.join(PACK_DIR, "active.json");

export type DocRecord = {
  doc_id: string;
  title: string;
  text: string;
  tags: string[];
  source_url?: string;
  chunks: string[];
  created_at: string;
};

export type Pinset = {
  pinset_id: string;
  name: string;
  description?: string;
  card_ids: string[];
  created_at: string;
};

export type HashVerification = {
  card_id: string;
  expected_hash: string;
  computed_hash: string;
  valid: boolean;
};

async function ensureDirs() {
  await fs.mkdir(CARD_DIR, { recursive: true });
  await fs.mkdir(DOC_DIR, { recursive: true });
  await fs.mkdir(PINSET_DIR, { recursive: true });
  await fs.mkdir(PACK_DIR, { recursive: true });
  await fs.mkdir(BUNDLE_DIR, { recursive: true });
}

// --- Blob store ---

function blobPath(hash: string): string {
  return path.join(BLOB_DIR, hash.slice(0, 2), hash.slice(2, 4), hash);
}

export async function putBlob(
  data: Buffer
): Promise<{ hash: string; path: string }> {
  const hash = hashBytes(data);
  const dest = blobPath(hash);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.access(dest);
    // already exists — dedup
  } catch {
    await fs.writeFile(dest, data);
  }
  return { hash, path: dest };
}

export async function getBlob(hash: string): Promise<Buffer> {
  return fs.readFile(blobPath(hash));
}

// --- Text store ---

function textPath(hash: string): string {
  return path.join(TEXT_DIR, hash.slice(0, 2), hash.slice(2, 4), `${hash}.txt`);
}

export async function putText(
  rawText: string
): Promise<{ hash: string; path: string; canonical: string }> {
  const canonical = canonicalizeText(rawText);
  const hash = hashText(rawText);
  const dest = textPath(hash);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.access(dest);
  } catch {
    await fs.writeFile(dest, canonical, "utf-8");
  }
  return { hash, path: dest, canonical };
}

export async function getText(hash: string): Promise<string> {
  return fs.readFile(textPath(hash), "utf-8");
}

// --- File artifact card ---

export async function saveFileArtifactCard(
  artifact: FileArtifact
): Promise<string> {
  await ensureDirs();
  const cardId = `card_file_${artifact.blob.hash.slice(0, 12)}`;
  const dest = path.join(CARD_DIR, `${cardId}.json`);
  await fs.writeFile(dest, JSON.stringify(artifact, null, 2), "utf-8");
  return cardId;
}

export async function saveFolderIndexCard(
  index: FolderIndex
): Promise<string> {
  await ensureDirs();
  const hashPrefix = index.hash.slice(0, 12);
  const cardId = `card_folder_${hashPrefix}`;
  const dest = path.join(CARD_DIR, `${cardId}.json`);
  await fs.writeFile(dest, JSON.stringify(index, null, 2), "utf-8");
  return cardId;
}

export async function saveChatChunkCard(
  chunk: ChatChunk
): Promise<string> {
  await ensureDirs();
  const hashPrefix = chunk.hash.slice(0, 12);
  const cardId = `card_chunk_${hashPrefix}`;
  const dest = path.join(CARD_DIR, `${cardId}.json`);
  await fs.writeFile(dest, JSON.stringify(chunk, null, 2), "utf-8");
  return cardId;
}

export async function saveChatLogIndexCard(
  index: ChatLogIndex
): Promise<string> {
  await ensureDirs();
  const hashPrefix = index.hash.slice(0, 12);
  const cardId = `card_chatlog_${hashPrefix}`;
  const dest = path.join(CARD_DIR, `${cardId}.json`);
  await fs.writeFile(dest, JSON.stringify(index, null, 2), "utf-8");
  return cardId;
}

export async function saveIngestReportCard(
  report: IngestReport
): Promise<string> {
  await ensureDirs();
  const hashPrefix = report.hash.slice(0, 12);
  const cardId = `card_report_${hashPrefix}`;
  const dest = path.join(CARD_DIR, `${cardId}.json`);
  await fs.writeFile(dest, JSON.stringify(report, null, 2), "utf-8");
  return cardId;
}

// --- Event card ---

export async function saveEventCard(
  event: EventCard
): Promise<string> {
  await ensureDirs();
  const cardId = `card_event_${event.hash.slice(0, 12)}`;
  const dest = path.join(CARD_DIR, `${cardId}.json`);
  await fs.writeFile(dest, JSON.stringify(event, null, 2), "utf-8");
  return cardId;
}

// --- Execution card ---

export async function saveExecutionCard(
  execution: ExecutionCard
): Promise<string> {
  await ensureDirs();
  const cardId = `card_execution_${execution.hash.slice(0, 12)}`;
  const dest = path.join(CARD_DIR, `${cardId}.json`);
  await fs.writeFile(dest, JSON.stringify(execution, null, 2), "utf-8");
  return cardId;
}

/**
 * Load all execution cards from disk. Used by graph query helpers.
 * Returns only cards that pass ExecutionCardSchema validation.
 */
export async function loadAllExecutionCards(): Promise<ExecutionCard[]> {
  await ensureDirs();
  const { ExecutionCardSchema } = await import("./schema.js");
  const files = await fs.readdir(CARD_DIR);
  const results: ExecutionCard[] = [];
  for (const f of files) {
    if (!f.startsWith("card_execution_") || !f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(CARD_DIR, f), "utf-8");
      const parsed = ExecutionCardSchema.parse(JSON.parse(raw));
      results.push(parsed);
    } catch {
      // skip corrupt / invalid files
    }
  }
  return results;
}

/**
 * Save a blessing record to the card directory.
 * Returns a stable card_id based on the record hash.
 */
export async function saveBlessingRecord(
  record: import("./schema.js").BlessingRecord
): Promise<string> {
  await ensureDirs();
  const cardId = `blessing_${record.hash.slice(0, 12)}`;
  const dest = path.join(CARD_DIR, `${cardId}.json`);
  await fs.writeFile(dest, JSON.stringify(record, null, 2), "utf-8");
  return cardId;
}

/**
 * Load all blessing records from disk.
 * Returns only records that pass BlessingRecordSchema validation.
 */
export async function loadAllBlessingRecords(): Promise<import("./schema.js").BlessingRecord[]> {
  await ensureDirs();
  const { BlessingRecordSchema } = await import("./schema.js");
  const files = await fs.readdir(CARD_DIR);
  const results: import("./schema.js").BlessingRecord[] = [];
  for (const f of files) {
    if (!f.startsWith("blessing_") || !f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(CARD_DIR, f), "utf-8");
      const parsed = BlessingRecordSchema.parse(JSON.parse(raw));
      results.push(parsed);
    } catch {
      // skip corrupt / invalid files
    }
  }
  return results;
}

// --- Card operations ---

export async function loadCard(card_id: string): Promise<CardPayload> {
  const raw = await fs.readFile(
    path.join(CARD_DIR, `${card_id}.json`),
    "utf-8"
  );
  return JSON.parse(raw);
}

export async function listCards(): Promise<CardPayload[]> {
  await ensureDirs();
  const files = await fs.readdir(CARD_DIR);
  const cards: CardPayload[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(CARD_DIR, f), "utf-8");
      cards.push(JSON.parse(raw));
    } catch {
      // skip corrupt files
    }
  }
  return cards.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function verifyCardHash(
  card_id: string
): Promise<HashVerification> {
  const payload = await loadCard(card_id);
  const result = verifyHash(
    payload as unknown as Record<string, unknown>,
    "hash"
  );
  return {
    card_id,
    expected_hash: result.expected,
    computed_hash: result.computed,
    valid: result.valid,
  };
}

export async function deleteCard(card_id: string): Promise<void> {
  const jsonPath = path.join(CARD_DIR, `${card_id}.json`);
  const pngPath = path.join(CARD_DIR, `${card_id}.png`);
  await fs.unlink(jsonPath).catch(() => {});
  await fs.unlink(pngPath).catch(() => {});
}

export function cardPngPath(card_id: string): string {
  return path.join(CARD_DIR, `${card_id}.png`);
}

// --- Doc operations ---

export async function loadDoc(doc_id: string): Promise<DocRecord> {
  const raw = await fs.readFile(
    path.join(DOC_DIR, `${doc_id}.json`),
    "utf-8"
  );
  return JSON.parse(raw);
}

export async function listDocs(): Promise<DocRecord[]> {
  await ensureDirs();
  const files = await fs.readdir(DOC_DIR);
  const docs: DocRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(DOC_DIR, f), "utf-8");
      docs.push(JSON.parse(raw));
    } catch {
      // skip
    }
  }
  return docs.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

// --- Pinset operations ---

export async function createPinset(args: {
  name: string;
  description?: string;
  card_ids: string[];
}): Promise<Pinset> {
  await ensureDirs();
  const pinset_id = "pinset_" + crypto.randomUUID();
  const pinset: Pinset = {
    pinset_id,
    name: args.name,
    description: args.description,
    card_ids: args.card_ids,
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(PINSET_DIR, `${pinset_id}.json`),
    JSON.stringify(pinset, null, 2),
    "utf-8"
  );
  return pinset;
}

export async function listPinsets(): Promise<Pinset[]> {
  await ensureDirs();
  const files = await fs.readdir(PINSET_DIR);
  const pinsets: Pinset[] = [];
  for (const f of files) {
    if (!f.startsWith("pinset_") || !f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(PINSET_DIR, f), "utf-8");
      pinsets.push(JSON.parse(raw));
    } catch {
      // skip
    }
  }
  return pinsets.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function loadPinset(pinset_id: string): Promise<Pinset> {
  const raw = await fs.readFile(
    path.join(PINSET_DIR, `${pinset_id}.json`),
    "utf-8"
  );
  return JSON.parse(raw);
}

export async function deletePinset(pinset_id: string): Promise<void> {
  await fs.unlink(path.join(PINSET_DIR, `${pinset_id}.json`)).catch(() => {});
  const active = await getActivePinset();
  if (active === pinset_id) {
    await setActivePinset(null);
  }
}

export async function setActivePinset(
  pinset_id: string | null
): Promise<void> {
  await ensureDirs();
  await fs.writeFile(
    ACTIVE_PINSET_PATH,
    JSON.stringify({ active_pinset_id: pinset_id }, null, 2),
    "utf-8"
  );
}

export async function getActivePinset(): Promise<string | null> {
  try {
    const raw = await fs.readFile(ACTIVE_PINSET_PATH, "utf-8");
    const data = JSON.parse(raw);
    return data.active_pinset_id ?? null;
  } catch {
    return null;
  }
}

export async function getActivePinsetCards(): Promise<CardPayload[]> {
  const pinset_id = await getActivePinset();
  if (!pinset_id) return [];
  try {
    const pinset = await loadPinset(pinset_id);
    const cards: CardPayload[] = [];
    for (const id of pinset.card_ids) {
      try {
        cards.push(await loadCard(id));
      } catch {
        // card might have been deleted
      }
    }
    return cards;
  } catch {
    return [];
  }
}

// --- Behavior Pack operations ---

export async function createBehaviorPack(args: {
  name: string;
  version?: string;
  description?: string;
  card_ids: string[];
  policies?: Partial<PackPolicies>;
}): Promise<BehaviorPack> {
  await ensureDirs();

  // Resolve card hashes (content-addressed pins)
  const pins: string[] = [];
  for (const id of args.card_ids) {
    try {
      const card = await loadCard(id);
      pins.push(card.hash);
    } catch {
      // skip missing cards
    }
  }

  const pack_id = "pack_" + crypto.randomUUID();
  const policies: PackPolicies = {
    search_boost: args.policies?.search_boost ?? 0.5,
    max_results: args.policies?.max_results,
    allowed_tags: args.policies?.allowed_tags,
    blocked_tags: args.policies?.blocked_tags,
    default_export_scope: args.policies?.default_export_scope,
    style: args.policies?.style,
  };

  const base: Omit<BehaviorPack, "hash"> = {
    type: "behavior_pack",
    pack_id,
    name: args.name,
    version: args.version ?? "1.0.0",
    description: args.description,
    pins,
    policies,
    created_at: new Date().toISOString(),
  };

  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  const pack: BehaviorPack = { ...base, hash };

  await fs.writeFile(
    path.join(PACK_DIR, `${pack_id}.json`),
    JSON.stringify(pack, null, 2),
    "utf-8"
  );

  return pack;
}

export async function createBehaviorPackFromPinset(
  pinset_id: string,
  policies?: Partial<PackPolicies>
): Promise<BehaviorPack> {
  const pinset = await loadPinset(pinset_id);
  return createBehaviorPack({
    name: pinset.name,
    description: pinset.description,
    card_ids: pinset.card_ids,
    policies,
  });
}

export async function loadBehaviorPack(
  pack_id: string
): Promise<BehaviorPack> {
  const raw = await fs.readFile(
    path.join(PACK_DIR, `${pack_id}.json`),
    "utf-8"
  );
  return JSON.parse(raw);
}

export async function listBehaviorPacks(): Promise<BehaviorPack[]> {
  await ensureDirs();
  const files = await fs.readdir(PACK_DIR);
  const packs: BehaviorPack[] = [];
  for (const f of files) {
    if (!f.startsWith("pack_") || !f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(PACK_DIR, f), "utf-8");
      packs.push(JSON.parse(raw));
    } catch {
      // skip
    }
  }
  return packs.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function deleteBehaviorPack(pack_id: string): Promise<void> {
  await fs.unlink(path.join(PACK_DIR, `${pack_id}.json`)).catch(() => {});
  const active = await getActivePack();
  if (active === pack_id) {
    await setActivePack(null);
  }
}

export async function setActivePack(
  pack_id: string | null
): Promise<void> {
  await ensureDirs();
  await fs.writeFile(
    ACTIVE_PACK_PATH,
    JSON.stringify({ active_pack_id: pack_id }, null, 2),
    "utf-8"
  );
}

export async function getActivePack(): Promise<string | null> {
  try {
    const raw = await fs.readFile(ACTIVE_PACK_PATH, "utf-8");
    const data = JSON.parse(raw);
    return data.active_pack_id ?? null;
  } catch {
    return null;
  }
}



// --- Meta (sidecar) operations ---

const EVENT_DIR = path.join(ROOT, "data", "events");

function metaDir(type: MetaV1["artifact_type"]): string {
  switch (type) {
    case "card":
      return CARD_DIR;
    case "event":
      return EVENT_DIR;
    case "execution":
      return CARD_DIR; // execution cards live alongside other cards
    default:
      throw new Error(`Unknown artifact type: ${type}`);
  }
}

/**
 * Co-located meta sidecar path.
 *   cards:  data/cards/card_<hash12>.meta.json
 *   events: data/events/card_event_<hash12>.meta.json
 */
export function getMetaPath(
  type: MetaV1["artifact_type"],
  hash: string,
): string {
  const h12 = hash.slice(0, 12);
  const prefix = type === "event" ? `card_event_${h12}` : `card_${h12}`;
  return path.join(metaDir(type), `${prefix}.meta.json`);
}

/** @deprecated use getMetaPath — kept briefly for migration */
export const metaPath = (hash: string) => getMetaPath("card", hash);

export async function loadMeta(
  hash: string,
  type: MetaV1["artifact_type"],
): Promise<MetaV1 | null> {
  try {
    const raw = await fs.readFile(getMetaPath(type, hash), "utf-8");
    return MetaV1Schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// --- Deterministic merge helpers ---

/** Union sources by (kind, value) tuple, sorted for determinism. */
function mergeSources(
  a: MetaV1["sources"],
  b: MetaV1["sources"],
): NonNullable<MetaV1["sources"]> {
  const map = new Map<string, NonNullable<MetaV1["sources"]>[number]>();
  for (const s of [...(a ?? []), ...(b ?? [])]) {
    map.set(`${s.kind}\0${s.value}`, s);
  }
  return [...map.values()].sort((x, y) =>
    `${x.kind}\0${x.value}`.localeCompare(`${y.kind}\0${y.value}`),
  );
}

/** Embedding key: model + dims + optional embedding_id */
function embeddingKey(e: { model: string; dims: number; embedding_id?: string }): string {
  return `${e.model}\0${e.dims}\0${e.embedding_id ?? ""}`;
}

/** Union embeddings by (model, dims, embedding_id?), last-write-wins per key, sorted. */
function mergeEmbeddings(
  a: MetaV1["embeddings"],
  b: MetaV1["embeddings"],
): NonNullable<MetaV1["embeddings"]> {
  const map = new Map<string, NonNullable<MetaV1["embeddings"]>[number]>();
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    map.set(embeddingKey(e), e);
  }
  return [...map.values()].sort((x, y) =>
    embeddingKey(x).localeCompare(embeddingKey(y)),
  );
}

/** Merge annotations: notes is last-write-wins, meta_tags is union-unique-sorted. */
function mergeAnnotations(
  a: MetaV1["annotations"],
  b: MetaV1["annotations"],
): MetaV1["annotations"] {
  if (!a && !b) return undefined;
  const notes = b?.notes ?? a?.notes;
  const tags = [...new Set([...(a?.meta_tags ?? []), ...(b?.meta_tags ?? [])])].sort();
  const result: NonNullable<MetaV1["annotations"]> = {};
  if (notes !== undefined) result.notes = notes;
  if (tags.length > 0) result.meta_tags = tags;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Merge ingest: last-write-wins per field, stats keys merged. */
function mergeIngest(
  a: MetaV1["ingest"],
  b: MetaV1["ingest"],
): MetaV1["ingest"] {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return {
    pipeline: b.pipeline ?? a.pipeline,
    extractor: b.extractor ?? a.extractor,
    chunker: b.chunker ?? a.chunker,
    stats: (a.stats || b.stats)
      ? { ...a.stats, ...b.stats }
      : undefined,
  };
}

export async function mergeMeta(
  hash: string,
  type: MetaV1["artifact_type"],
  patch: MetaPatch,
): Promise<MetaV1> {
  const existing = await loadMeta(hash, type);

  const merged: MetaV1 = {
    schema_version: "meta.v1",
    artifact_hash: hash,
    artifact_type: type,
    // Scalar: last-write-wins
    occurred_at: patch.occurred_at ?? existing?.occurred_at,
    // Array-of-objects: union by stable key
    sources: mergeSources(existing?.sources, patch.sources),
    // Deep-merge object
    ingest: mergeIngest(existing?.ingest, patch.ingest),
    // Array-of-objects: union by stable key
    embeddings: mergeEmbeddings(existing?.embeddings, patch.embeddings),
    // Mixed: notes LWW, meta_tags union-sorted
    annotations: mergeAnnotations(existing?.annotations, patch.annotations),
    // Render pointer: last-write-wins (each render supersedes the previous)
    render: patch.render ?? existing?.render,
  };

  // Strip undefined optional fields before validation
  const clean = JSON.parse(JSON.stringify(merged));
  const final: MetaV1 = MetaV1Schema.parse(clean);

  const dest = getMetaPath(type, hash);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify(final, null, 2), "utf-8");
  return final;
}

export async function deleteMeta(
  hash: string,
  type: MetaV1["artifact_type"],
): Promise<void> {
  await fs.unlink(getMetaPath(type, hash)).catch(() => {});
}



/**

 * Build the VaultContext for the currently active pack.

 * This is the core state object that hooks consume.

 */
export async function getVaultContext(): Promise<VaultContext> {
  const pack_id = await getActivePack();
  if (!pack_id) {
    return {
      activePack: null,
      pinHashes: [],
      policies: DEFAULT_POLICIES,
    };
  }

  try {
    const pack = await loadBehaviorPack(pack_id);
    return {
      activePack: pack,
      pinHashes: pack.pins,
      policies: pack.policies,
    };
  } catch {
    return {
      activePack: null,
      pinHashes: [],
      policies: DEFAULT_POLICIES,
    };
  }
}
