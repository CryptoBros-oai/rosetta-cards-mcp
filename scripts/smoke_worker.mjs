#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const action = args[0];
const payload = args[1] ? JSON.parse(args[1]) : {};

async function main() {
  // Import hooks/vault/bundle under the current process.cwd()/VAULT_ROOT
  const hooks = await import('../src/kb/hooks.js');
  const vault = await import('../src/kb/vault.js');
  const bundle = await import('../src/kb/bundle.js');

  switch (action) {
    case 'init': {
      // ensure directories
      await fs.mkdir(path.join(process.cwd(), 'data', 'cards'), { recursive: true });
      await fs.mkdir(path.join(process.cwd(), 'data', 'blobs'), { recursive: true });
      await fs.mkdir(path.join(process.cwd(), 'data', 'text'), { recursive: true });
      await fs.mkdir(path.join(process.cwd(), 'data', 'packs'), { recursive: true });
      console.log(JSON.stringify({ ok: true }));
      return;
    }
    case 'create_pack': {
      const pack = await vault.createBehaviorPack({ name: payload.name || 'smoke-pack', card_ids: [], policies: payload.policies });
      console.log(JSON.stringify({ pack }));
      return;
    }
    case 'set_active_pack': {
      await vault.setActivePack(payload.pack_id);
      console.log(JSON.stringify({ ok: true }));
      return;
    }
    case 'ingest_folder': {
      const res = await hooks.ingestFolderHook({ path: payload.path, includeDocxText: false, includePdfText: false, storeBlobs: false, tags: payload.tags || [] });
      console.log(JSON.stringify({ result: res }));
      return;
    }
    case 'drain_context': {
      const res = await hooks.drainContextHook({ title: payload.title, tags: payload.tags || [], chatText: payload.chatText, targetMaxChars: payload.targetMaxChars || 200, chunkChars: payload.chunkChars || 120 });
      console.log(JSON.stringify({ result: res }));
      return;
    }
    case 'export_closure': {
      const res = await hooks.exportPackClosure({ include_png: false, meta: payload.meta });
      console.log(JSON.stringify({ result: res }));
      return;
    }
    case 'import_bundle': {
      const res = await hooks.importBundleHook({ bundle_path: payload.bundle_path });
      console.log(JSON.stringify({ result: res }));
      return;
    }
    case 'list_cards': {
      const cards = await vault.listCards();
      console.log(JSON.stringify({ cards }));
      return;
    }
    case 'find_by_hash': {
      const cards = await vault.listCards();
      const found = cards.filter((c) => payload.hashes.includes(c.hash));
      console.log(JSON.stringify({ found }));
      return;
    }
    case 'get_text': {
      const txt = await vault.getText(payload.hash);
      console.log(JSON.stringify({ text: txt }));
      return;
    }
    case 'verify_card': {
      const res = await vault.verifyCardHash(payload.card_id);
      console.log(JSON.stringify({ res }));
      return;
    }
    default:
      console.error(JSON.stringify({ error: 'unknown action', action }));
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }));
  process.exit(1);
});
