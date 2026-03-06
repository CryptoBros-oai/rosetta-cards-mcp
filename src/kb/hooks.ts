import { addDocument, buildCard, searchCards, getCard } from './store.js';
import { renderCardPng } from './render.js';
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
  saveEventCard,
  saveExecutionCard,
} from './vault.js';
import {
  exportBundle,
  importBundle,
  listBundles,
  type BundleManifest,
  type BundleProvenance,
  type ImportResult,
} from './bundle.js';
import {
  ingestFile,
  ingestFolder,
  type FileIngestResult,
  type FolderIngestResult,
} from './ingest.js';
import { drainContext, type DrainResult } from '../context_drain.js';
import {
  CardPayload,
  type BehaviorPack,
  type PackPolicies,
  type VaultContext,
  type EventCard,
  type EventDetail,
  type ExecutionCard,
  type ExecutionDetail,
  type RosettaMeta,
  EventCardSchema,
  EventCreateInputSchema,
  buildEventHashPayload,
  ExecutionCardSchema,
  ExecutionCreateInputSchema,
  buildExecutionHashPayload,
  DEFAULT_POLICIES,
  IngestTextInputSchema,
  BuildArtifactCardInputSchema,
  RenderExistingCardInputSchema,
  ExportBundleInputSchema,
  ImportBundleInputSchema,
  SearchArtifactsInputSchema,
  PinSetCreateInputSchema,
  IngestFolderInputSchema,
  DrainContextInputSchema,
  ExportPackClosureInputSchema,
  ExportActivePackInputSchema,
  StoragePlanInputSchema,
  StorageApplyInputSchema,
  StorageRestoreInputSchema,
  type StoragePlan,
  type StorageApplyResult,
  type StorageRestoreResult,
} from './schema.js';
import { rankArtifacts, type ScoredArtifact } from './search_rank.js';
import { canonicalHash, assertNoProhibitedKeys, assertNoExecutionProhibitedKeys } from './canonical.js';
import { storagePlan, storageApply, storageRestore } from './storage_engine.js';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';

async function getGeneratorVersion(): Promise<string> {
  try {
    const pkgRaw = await readFile(
      pathJoin(process.env.VAULT_ROOT ?? process.cwd(), 'package.json'),
      'utf-8'
    );
    return JSON.parse(pkgRaw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Policy enforcement provided by vault module

// --- Encode hooks ---

export type IngestResult = {
  doc_id: string;
  chunks: number;
};

export async function ingestText(args: unknown): Promise<IngestResult> {
  const parsed = IngestTextInputSchema.parse(args);
  const ctx = await getVaultContext();
  let tags = parsed.tags ?? [];

  // Enforce blocked_tags
  enforceBlockedTags(tags, ctx.policies.blocked_tags, parsed.override_blocked);

  // Auto-tag with allowed_tags
  if (ctx.policies.allowed_tags?.length) {
    tags = Array.from(new Set([...tags, ...ctx.policies.allowed_tags]));
  }

  const result = await addDocument({ ...parsed, tags });
  return { doc_id: result.doc_id, chunks: result.chunks_created };
}

export type BuildCardResult = {
  card_id: string;
  png_path?: string;
};

export async function buildArtifactCard(args: unknown): Promise<BuildCardResult> {
  const parsed = BuildArtifactCardInputSchema.parse(args);
  const ctx = await getVaultContext();
  const style = ctx.policies.style ?? 'default';

  const doc = await addDocument({
    title: parsed.title ?? 'Untitled Card',
    text: parsed.text,
    tags: parsed.tags,
    source_url: parsed.source,
  });

  const card = await buildCard({
    doc_id: doc.doc_id,
    chunk_id: 0,
    style,
    include_qr: true,
  });

  return {
    card_id: card.card_id,
    png_path: parsed.render_png !== false ? card.png_path : undefined,
  };
}

export async function renderExistingCard(args: unknown): Promise<{ png_path: string }> {
  const parsed = RenderExistingCardInputSchema.parse(args);
  const payload = await loadCard(parsed.card_id);
  const png_path = cardPngPath(parsed.card_id);
  await renderCardPng({
    payload,
    png_path,
    style: parsed.style ?? 'default',
    include_qr: true,
  });
  return { png_path };
}

export async function exportBundleHook(args: unknown): Promise<{ bundle_path: string; manifest: BundleManifest }> {
  const parsed = ExportBundleInputSchema.parse(args);
  let card_ids = parsed.select.card_ids ?? [];

  if ((parsed.select.tags_any?.length || parsed.select.tags_all?.length) && card_ids.length === 0) {
    const allCards = await listCards();
    card_ids = allCards
      .filter(c => {
        if (parsed.select.tags_any?.length && !parsed.select.tags_any.some(t => c.tags.includes(t)))
          return false;
        if (parsed.select.tags_all?.length && !parsed.select.tags_all.every(t => c.tags.includes(t)))
          return false;
        return true;
      })
      .map(c => c.card_id);
  }

  return exportBundle({
    card_ids,
    include_png: parsed.include_png,
    meta: parsed.meta,
  });
}

export async function importBundleHook(args: unknown): Promise<ImportResult> {
  const parsed = ImportBundleInputSchema.parse(args);
  return importBundle(parsed.bundle_path);
}

// --- Event card hook ---

export type CreateEventResult = {
  card_id: string;
  card_hash: string;
};

export async function createEventCard(args: unknown): Promise<CreateEventResult> {
  const parsed = EventCreateInputSchema.parse(args);
  const ctx = await getVaultContext();
  let tags = parsed.tags ?? [];

  enforceBlockedTags(tags, ctx.policies.blocked_tags, parsed.override_blocked);
  if (ctx.policies.allowed_tags?.length) {
    tags = Array.from(new Set([...tags, ...ctx.policies.allowed_tags]));
  }

  const base = buildEventHashPayload({
    title: parsed.title,
    summary: parsed.summary,
    event: parsed.event,
    tags,
    rosetta: parsed.rosetta,
  });

  // Validate via strict schema (rejects prohibited fields like timestamps)
  EventCardSchema.omit({ hash: true }).strict().parse(base);

  // Belt-and-suspenders: paranoid guard at hash membrane
  assertNoProhibitedKeys(base);

  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  const card: EventCard = { ...base, hash };

  const cardId = await saveEventCard(card);
  return { card_id: cardId, card_hash: hash };
}

// --- Execution card hook ---

export type CreateExecutionResult = {
  card_id: string;
  card_hash: string;
};

export async function createExecutionArtifact(args: unknown): Promise<CreateExecutionResult> {
  const parsed = ExecutionCreateInputSchema.parse(args);
  const ctx = await getVaultContext();
  let tags = parsed.tags ?? [];

  enforceBlockedTags(tags, ctx.policies.blocked_tags, parsed.override_blocked);
  if (ctx.policies.allowed_tags?.length) {
    tags = Array.from(new Set([...tags, ...ctx.policies.allowed_tags]));
  }

  const base = buildExecutionHashPayload({
    title: parsed.title,
    summary: parsed.summary,
    execution: parsed.execution,
    tags,
    rosetta: parsed.rosetta,
  });

  // Validate via strict schema (rejects prohibited fields like timestamps)
  ExecutionCardSchema.omit({ hash: true }).strict().parse(base);

  // Belt-and-suspenders: paranoid guard at hash membrane
  assertNoExecutionProhibitedKeys(base);

  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  const card: ExecutionCard = { ...base, hash };

  const cardId = await saveExecutionCard(card);
  return { card_id: cardId, card_hash: hash };
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

export async function searchArtifacts(args: unknown): Promise<SearchResult[]> {
  const parsed = SearchArtifactsInputSchema.parse(args);
  const ctx = await getVaultContext();
  const maxResults = ctx.policies.max_results ?? parsed.top_k ?? 10;

  // Fetch more than needed so we can re-rank with deterministic scoring
  let results = await searchCards({
    query: parsed.query,
    top_k: Math.max(maxResults * 2, 20),
  });

  // Apply tag filters from args
  if (parsed.tags_any?.length) {
    results = results.filter((r: any) => parsed.tags_any!.some(t => r.tags?.includes(t)));
  }
  if (parsed.tags_all?.length) {
    results = results.filter((r: any) => parsed.tags_all!.every(t => r.tags?.includes(t)));
  }

  // Apply pack-level tag filters
  if (ctx.policies.allowed_tags?.length) {
    results = results.filter((r: any) => ctx.policies.allowed_tags!.some(t => r.tags?.includes(t)));
  }
  if (ctx.policies.blocked_tags?.length) {
    results = results.filter(
      (r: any) => !ctx.policies.blocked_tags!.some(t => r.tags?.includes(t))
    );
  }

  // Resolve card hashes for pin detection, build ScoredArtifact[]
  const artifacts: (ScoredArtifact & { png_path: string })[] = await Promise.all(
    results.map(async (r: any) => {
      let cardHash: string | undefined;
      let text: string | undefined;
      try {
        const card = await loadCard(r.card_id);
        cardHash = card.hash;
        // Build searchable text from card content
        if (card.bullets) {
          text = `${card.title}\n${card.bullets.join('\n')}\n${(card.tags ?? []).join(' ')}`;
        }
      } catch {
        // card might not load
      }

      return {
        artifact_id: r.card_id,
        title: r.title ?? '',
        tags: r.tags ?? [],
        hash: cardHash,
        text,
        png_path: cardPngPath(r.card_id),
      };
    })
  );

  // Rank with deterministic scoring module
  const ranked = rankArtifacts(parsed.query, artifacts, ctx);

  return ranked.slice(0, maxResults).map(r => ({
    card_id: r.artifact_id,
    title: r.title,
    score: r.score,
    tags: r.tags,
    png_path: r.png_path,
    pinned: r.pinned,
  }));
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
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${png_path}"`);
}

export async function pinSetCreate(args: unknown): Promise<{ pinset_id: string }> {
  const parsed = PinSetCreateInputSchema.parse(args);
  const pinset = await createPinset(parsed);
  return { pinset_id: pinset.pinset_id };
}

// --- Folder ingestion hook ---

export async function ingestFolderHook(args: unknown): Promise<FolderIngestResult> {
  const parsed = IngestFolderInputSchema.parse(args);
  const ctx = await getVaultContext();
  const userTags = parsed.tags ?? [];

  // Enforce blocked_tags against user-supplied tags
  enforceBlockedTags(userTags, ctx.policies.blocked_tags, parsed.override_blocked);

  // Merge allowed_tags
  const extraTags = Array.from(new Set([...userTags, ...(ctx.policies.allowed_tags ?? [])]));

  return ingestFolder(parsed.path, {
    includeDocxText: parsed.includeDocxText,
    includePdfText: parsed.includePdfText,
    storeBlobs: parsed.storeBlobs,
    extraTags,
    blockedTags: ctx.policies.blocked_tags,
    overrideBlocked: parsed.override_blocked,
  });
}

// --- Context drain hook ---

export async function drainContextHook(args: unknown): Promise<DrainResult> {
  const parsed = DrainContextInputSchema.parse(args);
  const ctx = await getVaultContext();
  let tags = parsed.tags ?? [];

  // Enforce blocked_tags
  enforceBlockedTags(tags, ctx.policies.blocked_tags, parsed.override_blocked);

  // Auto-tag with allowed_tags
  if (ctx.policies.allowed_tags?.length) {
    tags = Array.from(new Set([...tags, ...ctx.policies.allowed_tags]));
  }

  return drainContext({
    title: parsed.title,
    tags,
    chat_text: parsed.chatText,
    target_max_chars: parsed.targetMaxChars,
    chunk_chars: parsed.chunkChars,
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
export async function exportPackClosure(args?: unknown): Promise<PackClosureResult> {
  const parsed = ExportPackClosureInputSchema.parse(args ?? {});
  // Resolve pack
  const packId = parsed.pack_id ?? (await getActivePack());
  if (!packId) {
    throw new Error('No active behavior pack and no pack_id specified');
  }
  const pack = await loadBehaviorPack(packId);

  // Scan all card JSON files for pinned hashes.
  // Uses filename-derived card_id so it works for ALL artifact types
  // (CardPayload, file_artifact, chat_chunk, etc.)
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const vaultRoot = process.env.VAULT_ROOT ?? process.cwd();
  const cardDir = path.join(vaultRoot, 'data', 'cards');
  const pinSet = new Set(pack.pins);
  const allPinnedIds: string[] = [];
  const blobHashes = new Set<string>();
  const textHashes = new Set<string>();

  const allCardFiles = await fs.readdir(cardDir).catch(() => [] as string[]);
  for (const f of allCardFiles) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(cardDir, f), 'utf-8');
      const card = JSON.parse(raw);
      if (card.hash && pinSet.has(card.hash)) {
        const cardId = f.replace('.json', '');
        allPinnedIds.push(cardId);

        // Collect blob/text dependencies from file artifacts
        if (card.type === 'file_artifact') {
          if (card.blob?.hash) blobHashes.add(card.blob.hash);
          if (card.text?.hash) textHashes.add(card.text.hash);
        }
        // Collect text dependencies from chat chunks
        if (card.type === 'chat_chunk') {
          if (card.text?.hash) textHashes.add(card.text.hash);
        }
      }
    } catch {
      // skip corrupt files
    }
  }

  // Build provenance metadata
  const provenance: BundleProvenance = {
    generator: 'rosetta-cards-mcp',
    generator_version: await getGeneratorVersion(),
    export_scope: 'pack_only',
    pack: { pack_id: packId, name: pack.name, hash: pack.hash },
    include_blobs: blobHashes.size > 0,
    include_text: textHashes.size > 0,
    created_at: new Date().toISOString(),
  };

  // Export bundle with all pinned cards
  const { bundle_path, manifest } = await exportBundle({
    card_ids: allPinnedIds,
    include_png: parsed.include_png,
    meta: {
      description: parsed.meta?.description ?? `Pack closure: ${pack.name}`,
      license_spdx: parsed.meta?.license_spdx,
      created_by: parsed.meta?.created_by,
    },
    provenance,
  });

  // Copy blobs into bundle
  const blobsOut = path.join(bundle_path, 'blobs');
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
  const textOut = path.join(bundle_path, 'text');
  let textCount = 0;
  for (const hash of textHashes) {
    try {
      const textData = await getText(hash);
      const dest = path.join(textOut, hash.slice(0, 2), hash.slice(2, 4), `${hash}.txt`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, textData, 'utf-8');
      textCount++;
    } catch {
      // text might not exist
    }
  }

  // Write pack card into bundle root
  await fs.writeFile(path.join(bundle_path, 'pack.json'), JSON.stringify(pack, null, 2), 'utf-8');

  return {
    bundle_path,
    manifest,
    pack,
    card_count: allPinnedIds.length,
    blob_count: blobCount,
    text_count: textCount,
  };
}

// --- Export active pack hook ---

/**
 * Export only the active behavior pack and its transitive closure.
 *
 * Respects `default_export_scope` in pack policies:
 * - "pack_only" (default): export only pinned cards + their blob/text deps
 * - "all": export every card in the vault
 *
 * Throws if no active pack is set.
 */
export async function exportActivePackHook(args?: unknown): Promise<PackClosureResult> {
  const parsed = ExportActivePackInputSchema.parse(args ?? {});
  const packId = await getActivePack();
  if (!packId) {
    throw new Error('No active behavior pack set');
  }

  const pack = await loadBehaviorPack(packId);
  const scope = pack.policies.default_export_scope ?? 'pack_only';

  if (scope === 'all') {
    // Export all cards in the vault
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const vaultRoot = process.env.VAULT_ROOT ?? process.cwd();
    const cardDir = pathMod.join(vaultRoot, 'data', 'cards');
    const allCardFiles = await fs.readdir(cardDir).catch(() => [] as string[]);
    const allIds: string[] = [];
    for (const f of allCardFiles) {
      if (f.endsWith('.json')) allIds.push(f.replace('.json', ''));
    }

    const allProvenance: BundleProvenance = {
      generator: 'rosetta-cards-mcp',
      generator_version: await getGeneratorVersion(),
      export_scope: 'all',
      pack: { pack_id: packId, name: pack.name, hash: pack.hash },
      include_blobs: false,
      include_text: false,
      created_at: new Date().toISOString(),
    };

    const { bundle_path, manifest } = await exportBundle({
      card_ids: allIds,
      include_png: parsed.include_png,
      meta: {
        description: parsed.meta?.description ?? `Full vault export via pack: ${pack.name}`,
        license_spdx: parsed.meta?.license_spdx,
        created_by: parsed.meta?.created_by,
      },
      provenance: allProvenance,
    });

    return {
      bundle_path,
      manifest,
      pack,
      card_count: allIds.length,
      blob_count: 0,
      text_count: 0,
    };
  }

  // Default: pack_only — delegate to exportPackClosure
  return exportPackClosure({
    pack_id: packId,
    include_png: parsed.include_png,
    meta: parsed.meta,
  });
}

// --- Storage Policy Engine hooks ---

export async function storagePlanHook(args: unknown): Promise<StoragePlan> {
  StoragePlanInputSchema.parse(args);
  return storagePlan();
}

export async function storageApplyHook(args: unknown): Promise<StorageApplyResult> {
  StorageApplyInputSchema.parse(args);
  const plan = await storagePlan();
  return storageApply(plan);
}

export async function storageRestoreHook(args: unknown): Promise<StorageRestoreResult> {
  const parsed = StorageRestoreInputSchema.parse(args);
  return storageRestore(parsed);
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
