/**
 * Export scope tests.
 *
 * Verifies:
 *   - exportActivePackHook exports only pinned cards (pack_only scope)
 *   - exportActivePackHook exports all cards (all scope)
 *   - Cross-vault import of active pack closure
 *   - Deterministic closure export (same pack → same integrity hash)
 *   - Throws when no active pack
 *
 * Each test explicitly sets/restores the active pack to avoid
 * interference from concurrent test files sharing data/.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = path.join(process.cwd(), 'data');

describe('exportActivePackHook', () => {
  let packId: string;
  let pinnedCardId: string;
  let unpinnedCardId: string;
  let pinnedHash: string;
  let unpinnedHash: string;
  let savedActivePack: string | null = null;

  before(async () => {
    const dirs = ['cards', 'packs', 'pinsets', 'docs', 'index', 'bundles', 'blobs', 'text'];
    for (const d of dirs) {
      await fs.mkdir(path.join(DATA_DIR, d), { recursive: true });
    }

    // Save current active pack to restore later
    const { getActivePack } = await import('../src/kb/vault.js');
    savedActivePack = await getActivePack();

    const { canonicalHash } = await import('../src/kb/canonical.js');

    // Create a pinned card
    pinnedCardId = 'card_export-pinned';
    const pinnedBase = {
      version: 'card.v1',
      card_id: pinnedCardId,
      title: 'Pinned Export Card',
      bullets: ['Bullet A', 'Bullet B'],
      tags: ['export', 'test'],
      sources: [{ doc_id: 'doc_test', chunk_id: 0 }],
      created_at: '2025-06-01T00:00:00.000Z',
    };
    pinnedHash = canonicalHash(pinnedBase as Record<string, unknown>);
    await fs.writeFile(
      path.join(DATA_DIR, 'cards', `${pinnedCardId}.json`),
      JSON.stringify({ ...pinnedBase, hash: pinnedHash }, null, 2),
      'utf-8'
    );

    // Create an unpinned card
    unpinnedCardId = 'card_export-unpinned';
    const unpinnedBase = {
      version: 'card.v1',
      card_id: unpinnedCardId,
      title: 'Unpinned Export Card',
      bullets: ['Bullet X'],
      tags: ['other'],
      sources: [{ doc_id: 'doc_test2' }],
      created_at: '2025-06-01T00:00:01.000Z',
    };
    unpinnedHash = canonicalHash(unpinnedBase as Record<string, unknown>);
    await fs.writeFile(
      path.join(DATA_DIR, 'cards', `${unpinnedCardId}.json`),
      JSON.stringify({ ...unpinnedBase, hash: unpinnedHash }, null, 2),
      'utf-8'
    );

    // Create pack with only the pinned card
    const { createBehaviorPack } = await import('../src/kb/vault.js');
    const pack = await createBehaviorPack({
      name: 'Export Scope Test Pack',
      card_ids: [pinnedCardId],
      policies: {
        search_boost: 0.5,
        default_export_scope: 'pack_only',
        allowed_tags: ['export'],
      },
    });
    packId = pack.pack_id;
  });

  after(async () => {
    // Restore the previously active pack
    const { setActivePack } = await import('../src/kb/vault.js');
    await setActivePack(savedActivePack);

    await fs.rm(path.join(DATA_DIR, 'packs', `${packId}.json`), { force: true }).catch(() => {});
    await fs
      .rm(path.join(DATA_DIR, 'cards', `${pinnedCardId}.json`), { force: true })
      .catch(() => {});
    await fs
      .rm(path.join(DATA_DIR, 'cards', `${unpinnedCardId}.json`), { force: true })
      .catch(() => {});
  });

  it('exports only pinned cards with pack_only scope', async () => {
    const { exportPackClosure } = await import('../src/kb/hooks.js');

    // Use explicit pack_id to avoid active-pack race
    const result = await exportPackClosure({ pack_id: packId });

    assert.ok(result.bundle_path, 'Must have bundle path');
    assert.ok(result.manifest, 'Must have manifest');
    assert.equal(result.pack.pack_id, packId);
    assert.equal(result.card_count, 1, 'Only 1 pinned card should be exported');

    // Verify the pinned card is in the bundle
    const bundleCardPath = path.join(result.bundle_path, 'cards', `${pinnedCardId}.json`);
    const bundleCard = JSON.parse(await fs.readFile(bundleCardPath, 'utf-8'));
    assert.equal(bundleCard.card_id, pinnedCardId);

    // Verify the unpinned card is NOT in the bundle
    const unpinnedPath = path.join(result.bundle_path, 'cards', `${unpinnedCardId}.json`);
    await assert.rejects(() => fs.access(unpinnedPath), 'Unpinned card should not be in bundle');

    // Verify pack.json in bundle
    const packJson = JSON.parse(
      await fs.readFile(path.join(result.bundle_path, 'pack.json'), 'utf-8')
    );
    assert.equal(packJson.pack_id, packId);

    await fs.rm(result.bundle_path, { recursive: true, force: true }).catch(() => {});
  });

  it('exportActivePackHook uses the active pack', async () => {
    const { exportActivePackHook } = await import('../src/kb/hooks.js');
    const { setActivePack } = await import('../src/kb/vault.js');

    // Set active pack for this test
    await setActivePack(packId);

    try {
      const result = await exportActivePackHook();
      assert.equal(result.pack.pack_id, packId);
      assert.ok(result.card_count >= 1);
      await fs.rm(result.bundle_path, { recursive: true, force: true }).catch(() => {});
    } finally {
      // Restore
      await setActivePack(savedActivePack);
    }
  });

  it("exports all cards with 'all' scope", async () => {
    const { loadBehaviorPack } = await import('../src/kb/vault.js');
    const { exportActivePackHook } = await import('../src/kb/hooks.js');
    const { setActivePack } = await import('../src/kb/vault.js');

    // Update pack to use "all" scope
    const pack = await loadBehaviorPack(packId);
    pack.policies.default_export_scope = 'all';
    await fs.writeFile(
      path.join(DATA_DIR, 'packs', `${packId}.json`),
      JSON.stringify(pack, null, 2),
      'utf-8'
    );

    // Set active pack for this test
    await setActivePack(packId);

    try {
      const result = await exportActivePackHook();

      // Should include at least both cards
      assert.ok(result.card_count >= 2, `Expected >= 2 cards, got ${result.card_count}`);

      await fs.rm(result.bundle_path, { recursive: true, force: true }).catch(() => {});
    } finally {
      // Restore pack_only scope
      pack.policies.default_export_scope = 'pack_only';
      await fs.writeFile(
        path.join(DATA_DIR, 'packs', `${packId}.json`),
        JSON.stringify(pack, null, 2),
        'utf-8'
      );
      await setActivePack(savedActivePack);
    }
  });

  it('throws when no active pack is set', async () => {
    const { exportActivePackHook } = await import('../src/kb/hooks.js');
    const { setActivePack } = await import('../src/kb/vault.js');

    await setActivePack(null);

    try {
      await assert.rejects(
        () => exportActivePackHook(),
        (err: any) => {
          assert.ok(err.message.includes('No active behavior pack'));
          return true;
        }
      );
    } finally {
      await setActivePack(savedActivePack);
    }
  });

  it('cross-vault import of active pack closure', async () => {
    const { exportPackClosure } = await import('../src/kb/hooks.js');

    // Use explicit pack_id to avoid active-pack race
    const result = await exportPackClosure({ pack_id: packId });

    // Create a temporary vault for import
    const tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'rosetta-export-scope-'));
    const tmpCardDir = path.join(tmpVault, 'data', 'cards');
    await fs.mkdir(tmpCardDir, { recursive: true });

    // Import cards from the bundle
    const bundleCardsDir = path.join(result.bundle_path, 'cards');
    const bundleFiles = await fs.readdir(bundleCardsDir).catch(() => [] as string[]);
    for (const f of bundleFiles) {
      if (f.endsWith('.json')) {
        const content = await fs.readFile(path.join(bundleCardsDir, f), 'utf-8');
        await fs.writeFile(path.join(tmpCardDir, f), content, 'utf-8');
      }
    }

    // Verify pinned card exists in temp vault
    const importedCard = JSON.parse(
      await fs.readFile(path.join(tmpCardDir, `${pinnedCardId}.json`), 'utf-8')
    );
    assert.equal(importedCard.hash, pinnedHash);

    // Clean up
    await fs.rm(result.bundle_path, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tmpVault, { recursive: true, force: true }).catch(() => {});
  });

  it('deterministic: same pack produces same integrity hash', async () => {
    const { exportPackClosure } = await import('../src/kb/hooks.js');

    // Use explicit pack_id to avoid active-pack race
    const result1 = await exportPackClosure({ pack_id: packId });
    const result2 = await exportPackClosure({ pack_id: packId });

    assert.equal(
      result1.manifest.integrity_hash,
      result2.manifest.integrity_hash,
      'Integrity hash should be deterministic'
    );

    await fs.rm(result1.bundle_path, { recursive: true, force: true }).catch(() => {});
    await fs.rm(result2.bundle_path, { recursive: true, force: true }).catch(() => {});
  });
});
