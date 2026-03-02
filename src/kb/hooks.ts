import { addDocument, buildCard, searchCards, getCard } from "./store.js";
import { renderCardPng } from "./render.js";
import {
  listCards,
  loadCard,
  verifyCardHash,
  cardPngPath,
  listDocs,
  loadDoc,
  createPinset,
  listPinsets,
  setActivePinset,
  getActivePinset,
  getActivePinsetCards,
  createBehaviorPack,
  createBehaviorPackFromPinset,
  listBehaviorPacks,
  loadBehaviorPack,
  deleteBehaviorPack,
  setActivePack,
  getActivePack,
  getVaultContext,
  putBlob,
  getBlob,
  putText,
  getText,
  PolicyViolationError,
  enforceBlockedTags,
} from "./vault.js";
import {
  exportBundle,
  importBundle,
  listBundles,
  type BundleManifest,
  type ImportResult,
} from "./bundle.js";
import {
  ingestFile,
  ingestFolder,
  type FileIngestResult,
  type FolderIngestResult,
} from "./ingest.js";
import {
  drainContext,
  type DrainResult,
} from "../context_drain.js";
import {
  CardPayload,
  type BehaviorPack,
  type PackPolicies,
  type VaultContext,
  DEFAULT_POLICIES,
} from "./schema.js";
import { exec } from "node:child_process";

// Policy enforcement provided by vault module

// --- Encode hooks ---

export type IngestResult = {
  doc_id: string;
  chunks: number;
};

export async function ingestText(args: {
  title: string;
  text: string;
  tags?: string[];
  source_url?: string;
  override_blocked?: boolean;
}): Promise<IngestResult> {
  const ctx = await getVaultContext();
  let tags = args.tags ?? [];

  // Enforce blocked_tags
  enforceBlockedTags(tags, ctx.policies.blocked_tags, args.override_blocked);

  // Auto-tag with allowed_tags
  if (ctx.policies.allowed_tags?.length) {
    tags = Array.from(new Set([...tags, ...ctx.policies.allowed_tags]));
  }

  const result = await addDocument({ ...args, tags });
  return { doc_id: result.doc_id, chunks: result.chunks_created };
}

export type BuildCardResult = {
  card_id: string;
  png_path?: string;
};

export async function buildArtifactCard(args: {
  title?: string;
  text: string;
  tags?: string[];
  source?: string;
  render_png?: boolean;
}): Promise<BuildCardResult> {
  const ctx = await getVaultContext();
  const style = ctx.policies.style ?? "default";

  const doc = await addDocument({
    title: args.title ?? "Untitled Card",
    text: args.text,
    tags: args.tags,
    source_url: args.source,
  });

  const card = await buildCard({
    doc_id: doc.doc_id,
    chunk_id: 0,
    style,
    include_qr: true,
  });

  return {
    card_id: card.card_id,
    png_path: args.render_png !== false ? card.png_path : undefined,
  };
}

export async function renderExistingCard(args: {
  card_id: string;
  style?: "default" | "dark" | "light";
}): Promise<{ png_path: string }> {
  const payload = await loadCard(args.card_id);
  const png_path = cardPngPath(args.card_id);
  await renderCardPng({
    payload,
    png_path,
    style: args.style ?? "default",
    include_qr: true,
  });
  return { png_path };
}

export async function exportBundleHook(args: {
  select: { card_ids?: string[]; tags_any?: string[]; tags_all?: string[] };
  include_png?: boolean;
  meta?: {
    description?: string;
    license_spdx?: string;
    created_by?: { name?: string };
  };
}): Promise<{ bundle_path: string; manifest: BundleManifest }> {
  let card_ids = args.select.card_ids ?? [];

  if (
    (args.select.tags_any?.length || args.select.tags_all?.length) &&
    card_ids.length === 0
  ) {
    const allCards = await listCards();
    card_ids = allCards
      .filter((c) => {
        if (
          args.select.tags_any?.length &&
          !args.select.tags_any.some((t) => c.tags.includes(t))
        )
          return false;
        if (
          args.select.tags_all?.length &&
          !args.select.tags_all.every((t) => c.tags.includes(t))
        )
          return false;
        return true;
      })
      .map((c) => c.card_id);
  }

  return exportBundle({
    card_ids,
    include_png: args.include_png,
    meta: args.meta,
  });
}

export async function importBundleHook(args: {
  bundle_path: string;
}): Promise<ImportResult> {
  return importBundle(args.bundle_path);
}

// --- Decode hooks ---

export type SearchResult = {
  card_id: string;
  title: string;
  score: number;
  tags: string[];
  png_path?: string;
  hash_valid?: boolean;
  pinned?: boolean;
};

export async function searchArtifacts(args: {
  query: string;
  top_k?: number;
  tags_any?: string[];
  tags_all?: string[];
}): Promise<SearchResult[]> {
  const ctx = await getVaultContext();
  const maxResults = ctx.policies.max_results ?? args.top_k ?? 10;

  // Fetch more than needed so we can boost and re-rank
  let results = await searchCards({
    query: args.query,
    top_k: Math.max(maxResults * 2, 20),
  });

  // Apply tag filters from args
  if (args.tags_any?.length) {
    results = results.filter((r: any) =>
      args.tags_any!.some((t) => r.tags?.includes(t))
    );
  }
  if (args.tags_all?.length) {
    results = results.filter((r: any) =>
      args.tags_all!.every((t) => r.tags?.includes(t))
    );
  }

  // Apply pack-level tag filters
  if (ctx.policies.allowed_tags?.length) {
    results = results.filter((r: any) =>
      ctx.policies.allowed_tags!.some((t) => r.tags?.includes(t))
    );
  }
  if (ctx.policies.blocked_tags?.length) {
    results = results.filter((r: any) =>
      !ctx.policies.blocked_tags!.some((t) => r.tags?.includes(t))
    );
  }

  // Deterministic scoring weights (fixed, no ML)
  const EXACT_TITLE_BOOST = 0.3;
  const TAG_MATCH_BOOST = 0.15;
  const PACK_TAG_BOOST = 0.1;

  // Build pin hash set for boost
  const pinSet = new Set(ctx.pinHashes);
  const pinBoost = ctx.policies.search_boost;
  const queryLower = args.query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);
  const packTags = new Set(ctx.policies.allowed_tags ?? []);

  // Map to SearchResult with deterministic scoring
  const mapped: SearchResult[] = await Promise.all(
    results.map(async (r: any) => {
      let cardHash: string | undefined;
      try {
        const card = await loadCard(r.card_id);
        cardHash = card.hash;
      } catch {
        // card might not load
      }

      let score = r.score ?? 0;
      const tags: string[] = r.tags ?? [];

      // Exact title match boost
      if (r.title && r.title.toLowerCase() === queryLower) {
        score += EXACT_TITLE_BOOST;
      }

      // Tag match boost: query terms appearing in tags
      for (const term of queryTerms) {
        if (tags.some((t) => t.toLowerCase() === term)) {
          score += TAG_MATCH_BOOST;
          break; // one boost per result
        }
      }

      // Pack tag match boost
      if (packTags.size > 0 && tags.some((t) => packTags.has(t))) {
        score += PACK_TAG_BOOST;
      }

      // Pinned card boost
      const isPinned = cardHash ? pinSet.has(cardHash) : false;
      if (isPinned) {
        score += pinBoost;
      }

      return {
        card_id: r.card_id,
        title: r.title,
        score: Math.min(1, score),
        tags,
        png_path: cardPngPath(r.card_id),
        pinned: isPinned,
      };
    })
  );

  // Re-sort by boosted score, then limit
  return mapped
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

export async function getCardDetails(card_id: string): Promise<{
  card: CardPayload;
  png_path: string;
  hash_valid: boolean;
}> {
  const card = await loadCard(card_id);
  const verification = await verifyCardHash(card_id);
  return {
    card,
    png_path: cardPngPath(card_id),
    hash_valid: verification.valid,
  };
}

export function openPng(png_path: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${png_path}"`);
}

export async function pinSetCreate(args: {
  name: string;
  card_ids: string[];
  description?: string;
}): Promise<{ pinset_id: string }> {
  const pinset = await createPinset(args);
  return { pinset_id: pinset.pinset_id };
}

// --- Folder ingestion hook ---

export async function ingestFolderHook(args: {
  path: string;
  tags?: string[];
  includeDocxText?: boolean;
  includePdfText?: boolean;
  storeBlobs?: boolean;
  override_blocked?: boolean;
}): Promise<FolderIngestResult> {
  const ctx = await getVaultContext();

  // Enforce blocked_tags against user-supplied tags
  const userTags = args.tags ?? [];
  enforceBlockedTags(userTags, ctx.policies.blocked_tags, args.override_blocked);

  // Merge allowed_tags
  const extraTags = Array.from(
    new Set([...userTags, ...(ctx.policies.allowed_tags ?? [])])
  );

  return ingestFolder(args.path, {
    includeDocxText: args.includeDocxText,
    includePdfText: args.includePdfText,
    storeBlobs: args.storeBlobs,
    extraTags,
  });
}

// --- Context drain hook ---

export async function drainContextHook(args: {
  title: string;
  tags?: string[];
  chatText: string;
  targetMaxChars?: number;
  chunkChars?: number;
  override_blocked?: boolean;
}): Promise<DrainResult> {
  const ctx = await getVaultContext();
  let tags = args.tags ?? [];

  // Enforce blocked_tags
  enforceBlockedTags(tags, ctx.policies.blocked_tags, args.override_blocked);

  // Auto-tag with allowed_tags
  if (ctx.policies.allowed_tags?.length) {
    tags = Array.from(new Set([...tags, ...ctx.policies.allowed_tags]));
  }

  return drainContext({
    title: args.title,
    tags,
    chat_text: args.chatText,
    target_max_chars: args.targetMaxChars,
    chunk_chars: args.chunkChars,
  });
}

// --- Pack closure export ---

export type PackClosureResult = {
  bundle_path: string;
  manifest: BundleManifest;
  pack: BehaviorPack;
  card_count: number;
  blob_count: number;
  text_count: number;
};

/**
 * Export the active (or specified) pack + all dependencies as a portable bundle.
 *
 * Closure includes:
 *   1. The pack card itself (as JSON in bundle root)
 *   2. All pinned cards (resolved from pin hashes)
 *   3. All blobs referenced by file_artifact cards
 *   4. All text records referenced by file_artifact/chat_chunk cards
 */
export async function exportPackClosure(args?: {
  pack_id?: string;
  include_png?: boolean;
  meta?: {
    description?: string;
    license_spdx?: string;
    created_by?: { name?: string };
  };
}): Promise<PackClosureResult> {
  // Resolve pack
  const packId = args?.pack_id ?? (await getActivePack());
  if (!packId) {
    throw new Error("No active behavior pack and no pack_id specified");
  }
  const pack = await loadBehaviorPack(packId);

  // Find all cards whose hash matches a pin
  const pinSet = new Set(pack.pins);
  const allCards = await listCards();
  const pinnedCards = allCards.filter((c) => pinSet.has(c.hash));
  const pinnedCardIds = pinnedCards.map((c) => c.card_id);

  // Also scan for non-CardPayload cards (file_artifact, chat_chunk, etc.)
  // that might have matching hashes by reading all card JSON files
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const cardDir = path.join(process.cwd(), "data", "cards");
  const allCardFiles = await fs.readdir(cardDir).catch(() => [] as string[]);
  const extraCardIds: string[] = [];
  const blobHashes = new Set<string>();
  const textHashes = new Set<string>();

  for (const f of allCardFiles) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(cardDir, f), "utf-8");
      const card = JSON.parse(raw);
      if (card.hash && pinSet.has(card.hash)) {
        const cardId = f.replace(".json", "");
        if (!pinnedCardIds.includes(cardId)) {
          extraCardIds.push(cardId);
        }

        // Collect blob/text dependencies from file artifacts
        if (card.type === "file_artifact") {
          if (card.blob?.hash) blobHashes.add(card.blob.hash);
          if (card.text?.hash) textHashes.add(card.text.hash);
        }
        // Collect text dependencies from chat chunks
        if (card.type === "chat_chunk") {
          if (card.text?.hash) textHashes.add(card.text.hash);
        }
      }
    } catch {
      // skip corrupt files
    }
  }

  const allPinnedIds = [...pinnedCardIds, ...extraCardIds];

  // Export bundle with all pinned cards
  const { bundle_path, manifest } = await exportBundle({
    card_ids: allPinnedIds,
    include_png: args?.include_png,
    meta: {
      description: args?.meta?.description ?? `Pack closure: ${pack.name}`,
      license_spdx: args?.meta?.license_spdx,
      created_by: args?.meta?.created_by,
    },
  });

  // Copy blobs into bundle
  const blobsOut = path.join(bundle_path, "blobs");
  let blobCount = 0;
  for (const hash of blobHashes) {
    try {
      const blobData = await getBlob(hash);
      const dest = path.join(blobsOut, hash.slice(0, 2), hash.slice(2, 4), hash);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, blobData);
      blobCount++;
    } catch {
      // blob might not exist
    }
  }

  // Copy text records into bundle
  const textOut = path.join(bundle_path, "text");
  let textCount = 0;
  for (const hash of textHashes) {
    try {
      const textData = await getText(hash);
      const dest = path.join(textOut, hash.slice(0, 2), hash.slice(2, 4), `${hash}.txt`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, textData, "utf-8");
      textCount++;
    } catch {
      // text might not exist
    }
  }

  // Write pack card into bundle root
  await fs.writeFile(
    path.join(bundle_path, "pack.json"),
    JSON.stringify(pack, null, 2),
    "utf-8"
  );

  return {
    bundle_path,
    manifest,
    pack,
    card_count: allPinnedIds.length,
    blob_count: blobCount,
    text_count: textCount,
  };
}

// Re-export vault/bundle/ingest functions for TUI convenience
export {
  listCards,
  listDocs,
  loadDoc,
  listPinsets,
  setActivePinset,
  getActivePinset,
  getActivePinsetCards,
  listBundles,
  exportBundle,
  createBehaviorPack,
  createBehaviorPackFromPinset,
  listBehaviorPacks,
  loadBehaviorPack,
  deleteBehaviorPack,
  setActivePack,
  getActivePack,
  getVaultContext,
  putBlob,
  getBlob,
  putText,
  getText,
  ingestFile,
  ingestFolder,
  drainContext,
  PolicyViolationError,
  enforceBlockedTags,
};
