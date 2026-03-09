/**
 * Dry-run export planning — computes what would be exported without writing files.
 *
 * Deterministic: same vault state always produces the same plan
 * (artifact_ids sorted lexicographically, stable counts).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getActivePack, loadBehaviorPack } from './vault.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportPlan = {
  scope: 'pack_only' | 'all';
  pack?: { pack_id: string; name: string; hash: string };
  artifact_count: number;
  artifact_ids: string[];
  blob_count: number;
  text_count: number;
  estimated_bytes: number;
  notes: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function statSize(filePath: string): Promise<number> {
  try {
    const s = await fs.stat(filePath);
    return s.size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan an export without writing any files.
 *
 * Resolves the same closure as exportPackClosure / exportActivePackHook
 * and returns counts + estimated byte sizes.
 */
export async function planExport(args?: { pack_id?: string }): Promise<ExportPlan> {
  const vaultRoot = process.env.VAULT_ROOT ?? process.cwd();
  const cardDir = path.join(vaultRoot, 'data', 'cards');
  const blobDir = path.join(vaultRoot, 'data', 'blobs');
  const textDir = path.join(vaultRoot, 'data', 'text');

  // Resolve pack
  const packId = args?.pack_id ?? (await getActivePack());
  if (!packId) {
    throw new Error('No active behavior pack and no pack_id specified');
  }
  const pack = await loadBehaviorPack(packId);
  const scope = pack.policies.default_export_scope ?? 'pack_only';

  const allCardFiles = await fs.readdir(cardDir).catch(() => [] as string[]);
  const notes: string[] = [];

  if (scope === 'all') {
    // All cards in the vault
    const artifactIds: string[] = [];
    let estimatedBytes = 0;

    for (const f of allCardFiles) {
      if (!f.endsWith('.json')) continue;
      const cardId = f.replace('.json', '');
      artifactIds.push(cardId);
      estimatedBytes += await statSize(path.join(cardDir, f));
    }

    artifactIds.sort();

    return {
      scope: 'all',
      pack: { pack_id: packId, name: pack.name, hash: pack.hash },
      artifact_count: artifactIds.length,
      artifact_ids: artifactIds,
      blob_count: 0,
      text_count: 0,
      estimated_bytes: estimatedBytes,
      notes: ['Scope "all": every card in the vault will be exported'],
    };
  }

  // pack_only: resolve pinned closure
  const pinSet = new Set(pack.pins);
  const artifactIds: string[] = [];
  const blobHashes = new Set<string>();
  const textHashes = new Set<string>();
  let estimatedBytes = 0;

  for (const f of allCardFiles) {
    if (!f.endsWith('.json')) continue;
    try {
      const filePath = path.join(cardDir, f);
      const raw = await fs.readFile(filePath, 'utf-8');
      const card = JSON.parse(raw);
      if (card.hash && pinSet.has(card.hash)) {
        const cardId = f.replace('.json', '');
        artifactIds.push(cardId);
        estimatedBytes += await statSize(filePath);

        if (card.type === 'file_artifact') {
          if (card.blob?.hash) blobHashes.add(card.blob.hash);
          if (card.text?.hash) textHashes.add(card.text.hash);
        }
        if (card.type === 'chat_chunk') {
          if (card.text?.hash) textHashes.add(card.text.hash);
        }
      }
    } catch {
      // skip corrupt files
    }
  }

  // Estimate blob sizes
  for (const hash of blobHashes) {
    const blobPath = path.join(blobDir, hash.slice(0, 2), hash.slice(2, 4), hash);
    estimatedBytes += await statSize(blobPath);
  }

  // Estimate text sizes
  for (const hash of textHashes) {
    const textPath = path.join(textDir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.txt`);
    estimatedBytes += await statSize(textPath);
  }

  artifactIds.sort();

  if (artifactIds.length === 0) {
    notes.push('No pinned cards found — bundle will be empty');
  }

  return {
    scope: 'pack_only',
    pack: { pack_id: packId, name: pack.name, hash: pack.hash },
    artifact_count: artifactIds.length,
    artifact_ids: artifactIds,
    blob_count: blobHashes.size,
    text_count: textHashes.size,
    estimated_bytes: estimatedBytes,
    notes,
  };
}
