#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const action = args[0];
const argsPayload = args[1] ? JSON.parse(args[1]) : {};

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
      const pack = await vault.createBehaviorPack({ name: argsPayload.name || 'smoke-pack', card_ids: [], policies: argsPayload.policies });
      console.log(JSON.stringify({ pack }));
      return;
    }
    case 'set_active_pack': {
      await vault.setActivePack(argsPayload.pack_id);
      console.log(JSON.stringify({ ok: true }));
      return;
    }
    case 'ingest_folder': {
      const res = await hooks.ingestFolderHook({ path: argsPayload.path, includeDocxText: false, includePdfText: false, storeBlobs: false, tags: argsPayload.tags || [] });
      console.log(JSON.stringify({ result: res }));
      return;
    }
    case 'drain_context': {
      const res = await hooks.drainContextHook({ title: argsPayload.title, tags: argsPayload.tags || [], chatText: argsPayload.chatText, targetMaxChars: argsPayload.targetMaxChars || 200, chunkChars: argsPayload.chunkChars || 120 });
      console.log(JSON.stringify({ result: res }));
      return;
    }
    case 'export_closure': {
      const res = await hooks.exportPackClosure({ include_png: false, meta: argsPayload.meta });
      console.log(JSON.stringify({ result: res }));
      return;
    }
    case 'import_bundle': {
      const res = await hooks.importBundleHook({ bundle_path: argsPayload.bundle_path });
      console.log(JSON.stringify({ result: res }));
      return;
    }
    case 'list_cards': {
      // Return card payloads along with the originating file name as card_id
      const cardDir = path.join(process.env.VAULT_ROOT ?? process.cwd(), 'data', 'cards');
      const entries = await fs.readdir(cardDir).catch(() => []);
      const out = [];
      for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(cardDir, f), 'utf-8');
          const p = JSON.parse(raw);
          const card_id = f.replace('.json', '');
          out.push({ card_id, payload: p });
        } catch {
          // skip
        }
      }
      console.log(JSON.stringify({ cards: out }));
      return;
    }
    case 'find_by_hash': {
      const entries = await fs.readdir(cardDir).catch(() => []);
      const out = [];
      const targets = Array.isArray(argsPayload.hashes) ? argsPayload.hashes : [];
      for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(cardDir, f), 'utf-8');
          const p = JSON.parse(raw);
          if (p && p.hash && targets.includes(p.hash)) {
            const card_id = f.replace('.json','');
            out.push({ card_id, payload: p });
          }
        } catch {
          // skip corrupt files
        }
      }
      console.log(JSON.stringify({ found: out }));
        } catch {
          // skip corrupt files
        }
      }
      console.log(JSON.stringify({ found: out }));
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
