/**
 * Dry-run export plan tests.
 *
 * Verifies:
 *   - planExport returns correct counts for pack_only scope
 *   - planExport returns correct counts for all scope
 *   - artifact_ids are sorted lexicographically (deterministic)
 *   - Throws when no active pack
 *   - Estimated bytes are non-negative
 *   - Deterministic: same vault state → same plan
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');

describe('planExport', () => {
  let packId: string;
  let pinnedCardId: string;
  let unpinnedCardId: string;
  let savedActivePack: string | null = null;

  before(async () => {
    const dirs = ['cards', 'packs', 'pinsets', 'docs', 'index', 'bundles', 'blobs', 'text'];
    for (const d of dirs) {
      await fs.mkdir(path.join(DATA_DIR, d), { recursive: true });
    }

    const { getActivePack } = await import('../src/kb/vault.js');
    savedActivePack = await getActivePack();

    const { canonicalHash } = await import('../src/kb/canonical.js');

    // Create a pinned card
    pinnedCardId = 'card_plan-pinned';
    const pinnedBase = {
      version: 'card.v1',
      card_id: pinnedCardId,
      title: 'Pinned Plan Card',
      bullets: ['Bullet 1'],
      tags: ['plan', 'test'],
      sources: [{ doc_id: 'doc_plan' }],
      created_at: '2025-07-01T00:00:00.000Z',
    };
    const pinnedHash = canonicalHash(pinnedBase as Record<string, unknown>);
    await fs.writeFile(
      path.join(DATA_DIR, 'cards', `${pinnedCardId}.json`),
      JSON.stringify({ ...pinnedBase, hash: pinnedHash }, null, 2),
      'utf-8'
    );

    // Create an unpinned card
    unpinnedCardId = 'card_plan-unpinned';
    const unpinnedBase = {
      version: 'card.v1',
      card_id: unpinnedCardId,
      title: 'Unpinned Plan Card',
      bullets: ['Bullet X'],
      tags: ['other'],
      sources: [{ doc_id: 'doc_plan2' }],
      created_at: '2025-07-01T00:00:01.000Z',
    };
    const unpinnedHash = canonicalHash(unpinnedBase as Record<string, unknown>);
    await fs.writeFile(
      path.join(DATA_DIR, 'cards', `${unpinnedCardId}.json`),
      JSON.stringify({ ...unpinnedBase, hash: unpinnedHash }, null, 2),
      'utf-8'
    );

    // Create pack with only the pinned card
    const { createBehaviorPack } = await import('../src/kb/vault.js');
    const pack = await createBehaviorPack({
      name: 'Plan Test Pack',
      card_ids: [pinnedCardId],
      policies: {
        search_boost: 0.5,
        default_export_scope: 'pack_only',
        allowed_tags: ['plan'],
      },
    });
    packId = pack.pack_id;
  });

  after(async () => {
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

  it('returns correct counts for pack_only scope', async () => {
    const { planExport } = await import('../src/kb/bundle_plan.js');
    const plan = await planExport({ pack_id: packId });

    assert.equal(plan.scope, 'pack_only');
    assert.equal(plan.artifact_count, 1, 'Only 1 pinned card');
    assert.ok(plan.artifact_ids.includes(pinnedCardId));
    assert.ok(!plan.artifact_ids.includes(unpinnedCardId));
    assert.equal(plan.pack?.pack_id, packId);
  });

  it('returns correct counts for all scope', async () => {
    const { loadBehaviorPack } = await import('../src/kb/vault.js');
    const { planExport } = await import('../src/kb/bundle_plan.js');

    // Temporarily set scope to 'all'
    const pack = await loadBehaviorPack(packId);
    pack.policies.default_export_scope = 'all';
    await fs.writeFile(
      path.join(DATA_DIR, 'packs', `${packId}.json`),
      JSON.stringify(pack, null, 2),
      'utf-8'
    );

    try {
      const plan = await planExport({ pack_id: packId });
      assert.equal(plan.scope, 'all');
      assert.ok(plan.artifact_count >= 2, `Expected >= 2 cards, got ${plan.artifact_count}`);
    } finally {
      pack.policies.default_export_scope = 'pack_only';
      await fs.writeFile(
        path.join(DATA_DIR, 'packs', `${packId}.json`),
        JSON.stringify(pack, null, 2),
        'utf-8'
      );
    }
  });

  it('artifact_ids are sorted lexicographically', async () => {
    const { loadBehaviorPack } = await import('../src/kb/vault.js');
    const { planExport } = await import('../src/kb/bundle_plan.js');

    // Use 'all' scope to get multiple cards
    const pack = await loadBehaviorPack(packId);
    pack.policies.default_export_scope = 'all';
    await fs.writeFile(
      path.join(DATA_DIR, 'packs', `${packId}.json`),
      JSON.stringify(pack, null, 2),
      'utf-8'
    );

    try {
      const plan = await planExport({ pack_id: packId });
      const sorted = [...plan.artifact_ids].sort();
      assert.deepEqual(plan.artifact_ids, sorted, 'artifact_ids must be sorted');
    } finally {
      pack.policies.default_export_scope = 'pack_only';
      await fs.writeFile(
        path.join(DATA_DIR, 'packs', `${packId}.json`),
        JSON.stringify(pack, null, 2),
        'utf-8'
      );
    }
  });

  it('throws when no active pack and no pack_id', async () => {
    const { planExport } = await import('../src/kb/bundle_plan.js');
    const { setActivePack } = await import('../src/kb/vault.js');

    await setActivePack(null);

    try {
      await assert.rejects(
        () => planExport(),
        (err: any) => {
          assert.ok(err.message.includes('No active behavior pack'));
          return true;
        }
      );
    } finally {
      await setActivePack(savedActivePack);
    }
  });

  it('estimated_bytes is non-negative', async () => {
    const { planExport } = await import('../src/kb/bundle_plan.js');
    const plan = await planExport({ pack_id: packId });
    assert.ok(plan.estimated_bytes >= 0);
  });

  it('deterministic: same state produces same plan', async () => {
    const { planExport } = await import('../src/kb/bundle_plan.js');

    const plan1 = await planExport({ pack_id: packId });
    const plan2 = await planExport({ pack_id: packId });

    assert.equal(plan1.scope, plan2.scope);
    assert.equal(plan1.artifact_count, plan2.artifact_count);
    assert.deepEqual(plan1.artifact_ids, plan2.artifact_ids);
    assert.equal(plan1.blob_count, plan2.blob_count);
    assert.equal(plan1.text_count, plan2.text_count);
  });
});
