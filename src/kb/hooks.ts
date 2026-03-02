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
}): Promise<IngestResult> {
  // If a pack is active with allowed_tags, auto-tag
  const ctx = await getVaultContext();
  let tags = args.tags ?? [];
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

  // Build pin hash set for boost
  const pinSet = new Set(ctx.pinHashes);
  const boost = ctx.policies.search_boost;

  // Map to SearchResult with boost applied
  const mapped: SearchResult[] = await Promise.all(
    results.map(async (r: any) => {
      let cardHash: string | undefined;
      try {
        const card = await loadCard(r.card_id);
        cardHash = card.hash;
      } catch {
        // card might not load
      }

      const isPinned = cardHash ? pinSet.has(cardHash) : false;
      const boostedScore = isPinned
        ? Math.min(1, r.score + boost)
        : r.score;

      return {
        card_id: r.card_id,
        title: r.title,
        score: boostedScore,
        tags: r.tags ?? [],
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
  includeDocxText?: boolean;
  includePdfText?: boolean;
  storeBlobs?: boolean;
}): Promise<FolderIngestResult> {
  return ingestFolder(args.path, {
    includeDocxText: args.includeDocxText,
    includePdfText: args.includePdfText,
    storeBlobs: args.storeBlobs,
  });
}

// --- Context drain hook ---

export async function drainContextHook(args: {
  title: string;
  tags?: string[];
  chatText: string;
  targetMaxChars?: number;
  chunkChars?: number;
}): Promise<DrainResult> {
  return drainContext({
    title: args.title,
    tags: args.tags,
    chat_text: args.chatText,
    target_max_chars: args.targetMaxChars,
    chunk_chars: args.chunkChars,
  });
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
};
