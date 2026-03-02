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
