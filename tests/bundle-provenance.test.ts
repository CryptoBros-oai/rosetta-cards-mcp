/**
 * Bundle provenance metadata tests.
 *
 * Verifies:
 *   - exportBundle includes provenance when provided
 *   - importBundle surfaces provenance from manifest
 *   - Bundles without provenance still import correctly
 *   - Integrity hash is unaffected by provenance (deterministic)
 *   - exportPackClosure includes provenance automatically
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = path.join(process.cwd(), 'data');

describe('bundle provenance', () => {
  let cardId: string;
  let cardHash: string;
  let packId: string;
  let savedActivePack: string | null = null;

  before(async () => {
    const dirs = ['cards', 'packs', 'pinsets', 'docs', 'index', 'bundles', 'blobs', 'text'];
    for (const d of dirs) {
      await fs.mkdir(path.join(DATA_DIR, d), { recursive: true });
    }

    const { getActivePack } = await import('../src/kb/vault.js');
    savedActivePack = await getActivePack();

    const { canonicalHash } = await import('../src/kb/canonical.js');

    // Create a test card
    cardId = 'card_prov-test';
    const cardBase = {
      version: 'card.v1',
      card_id: cardId,
      title: 'Provenance Test Card',
      bullets: ['Bullet P'],
      tags: ['provenance', 'test'],
      sources: [{ doc_id: 'doc_prov' }],
      created_at: '2025-08-01T00:00:00.000Z',
    };
    cardHash = canonicalHash(cardBase as Record<string, unknown>);
    await fs.writeFile(
      path.join(DATA_DIR, 'cards', `${cardId}.json`),
      JSON.stringify({ ...cardBase, hash: cardHash }, null, 2),
      'utf-8'
    );

    // Create pack with the card pinned
    const { createBehaviorPack } = await import('../src/kb/vault.js');
    const pack = await createBehaviorPack({
      name: 'Provenance Test Pack',
      card_ids: [cardId],
      policies: {
        search_boost: 0,
        default_export_scope: 'pack_only',
      },
    });
    packId = pack.pack_id;
  });

  after(async () => {
    const { setActivePack } = await import('../src/kb/vault.js');
    await setActivePack(savedActivePack);

    await fs.rm(path.join(DATA_DIR, 'packs', `${packId}.json`), { force: true }).catch(() => {});
    await fs.rm(path.join(DATA_DIR, 'cards', `${cardId}.json`), { force: true }).catch(() => {});
  });

  it('exportBundle includes provenance when provided', async () => {
    const { exportBundle } = await import('../src/kb/bundle.js');

    const provenance = {
      generator: 'rosetta-cards-mcp' as const,
      generator_version: '0.1.0',
      export_scope: 'pack_only' as const,
      pack: { pack_id: packId, name: 'Test', hash: 'abc' },
      include_blobs: false,
      include_text: false,
      created_at: '2025-08-01T12:00:00.000Z',
    };

    const { bundle_path, manifest } = await exportBundle({
      card_ids: [cardId],
      provenance,
    });

    try {
      assert.ok(manifest.provenance, 'Manifest should include provenance');
      assert.equal(manifest.provenance!.generator, 'rosetta-cards-mcp');
      assert.equal(manifest.provenance!.generator_version, '0.1.0');
      assert.equal(manifest.provenance!.export_scope, 'pack_only');
      assert.equal(manifest.provenance!.pack?.pack_id, packId);
      assert.equal(manifest.provenance!.include_blobs, false);
      assert.equal(manifest.provenance!.include_text, false);
      assert.equal(manifest.provenance!.created_at, '2025-08-01T12:00:00.000Z');

      // Verify provenance is written to disk
      const diskManifest = JSON.parse(
        await fs.readFile(path.join(bundle_path, 'manifest.json'), 'utf-8')
      );
      assert.ok(diskManifest.provenance);
      assert.equal(diskManifest.provenance.generator, 'rosetta-cards-mcp');
    } finally {
      await fs.rm(bundle_path, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('exportBundle omits provenance when not provided', async () => {
    const { exportBundle } = await import('../src/kb/bundle.js');

    const { bundle_path, manifest } = await exportBundle({
      card_ids: [cardId],
    });

    try {
      assert.equal(manifest.provenance, undefined, 'Provenance should be undefined');
    } finally {
      await fs.rm(bundle_path, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('importBundle surfaces provenance from manifest', async () => {
    const { exportBundle, importBundle } = await import('../src/kb/bundle.js');

    const provenance = {
      generator: 'rosetta-cards-mcp' as const,
      generator_version: '0.1.0',
      export_scope: 'pack_only' as const,
      include_blobs: false,
      include_text: false,
      created_at: '2025-08-01T12:00:00.000Z',
    };

    const { bundle_path } = await exportBundle({
      card_ids: [cardId],
      provenance,
    });

    try {
      // Card already exists in vault → skipped, but provenance is still read
      const result = await importBundle(bundle_path);
      assert.equal(result.integrity_ok, true);
      assert.ok(result.provenance, 'Import result should include provenance');
      assert.equal(result.provenance!.generator, 'rosetta-cards-mcp');
      assert.equal(result.provenance!.export_scope, 'pack_only');
    } finally {
      await fs.rm(bundle_path, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('importBundle handles bundles without provenance', async () => {
    const { exportBundle, importBundle } = await import('../src/kb/bundle.js');

    // Export without provenance
    const { bundle_path } = await exportBundle({
      card_ids: [cardId],
    });

    try {
      // Card already exists in vault → skipped, but integrity is still verified
      const result = await importBundle(bundle_path);
      assert.equal(result.integrity_ok, true);
      assert.equal(result.skipped, 1, 'Card already exists so should be skipped');
      assert.equal(result.provenance, undefined, 'Provenance should be undefined');
    } finally {
      await fs.rm(bundle_path, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('integrity_hash is unaffected by provenance', async () => {
    const { exportBundle } = await import('../src/kb/bundle.js');

    // Export with provenance
    const { bundle_path: bp1, manifest: m1 } = await exportBundle({
      card_ids: [cardId],
      provenance: {
        generator: 'rosetta-cards-mcp',
        generator_version: '0.1.0',
        export_scope: 'pack_only',
        include_blobs: false,
        include_text: false,
        created_at: '2025-08-01T12:00:00.000Z',
      },
    });

    // Export without provenance
    const { bundle_path: bp2, manifest: m2 } = await exportBundle({
      card_ids: [cardId],
    });

    try {
      assert.equal(
        m1.integrity_hash,
        m2.integrity_hash,
        'Integrity hash must be identical regardless of provenance'
      );
    } finally {
      await fs.rm(bp1, { recursive: true, force: true }).catch(() => {});
      await fs.rm(bp2, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('exportPackClosure includes provenance automatically', async () => {
    const { exportPackClosure } = await import('../src/kb/hooks.js');

    const result = await exportPackClosure({ pack_id: packId });

    try {
      assert.ok(result.manifest.provenance, 'Pack closure should include provenance');
      assert.equal(result.manifest.provenance!.generator, 'rosetta-cards-mcp');
      assert.equal(result.manifest.provenance!.export_scope, 'pack_only');
      assert.ok(result.manifest.provenance!.pack);
      assert.equal(result.manifest.provenance!.pack!.pack_id, packId);
      assert.ok(result.manifest.provenance!.created_at);
    } finally {
      await fs.rm(result.bundle_path, { recursive: true, force: true }).catch(() => {});
    }
  });
});
