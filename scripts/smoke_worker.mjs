#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const action = args[0];
const argsPayload = args[1] ? JSON.parse(args[1]) : {};
const outPath = process.env.SMOKE_OUT_PATH;

async function respond(obj) {
  const json = JSON.stringify(obj);
  if (outPath) await fs.writeFile(outPath, json, "utf-8");
  console.log(json);
}

async function main() {
  // Import hooks/vault/bundle under the current process (VAULT_ROOT read at import)
  const hooks = await import('../src/kb/hooks.js');
  const vault = await import('../src/kb/vault.js');
  const bundle = await import('../src/kb/bundle.js');

  const vaultRoot = process.env.VAULT_ROOT ?? process.cwd();
  const cardDir = path.join(vaultRoot, 'data', 'cards');

  switch (action) {
    case 'init': {
      await fs.mkdir(path.join(vaultRoot, 'data', 'cards'), { recursive: true });
      await fs.mkdir(path.join(vaultRoot, 'data', 'blobs'), { recursive: true });
      await fs.mkdir(path.join(vaultRoot, 'data', 'text'), { recursive: true });
      await fs.mkdir(path.join(vaultRoot, 'data', 'packs'), { recursive: true });
      await respond({ ok: true });
      return;
    }

    case 'create_pack': {
      const pack = await vault.createBehaviorPack({ name: argsPayload.name || 'smoke-pack', card_ids: argsPayload.card_ids || [], policies: argsPayload.policies });
      await respond({ pack });
      return;
    }

    case 'set_active_pack': {
      await vault.setActivePack(argsPayload.pack_id);
      await respond({ ok: true });
      return;
    }

    case 'ingest_folder': {
      const res = await hooks.ingestFolderHook({ path: argsPayload.path, includeDocxText: false, includePdfText: false, storeBlobs: false, tags: argsPayload.tags || [] });
      await respond({ result: res });
      return;
    }

    case 'drain_context': {
      const res = await hooks.drainContextHook({ title: argsPayload.title, tags: argsPayload.tags || [], chatText: argsPayload.chatText, targetMaxChars: argsPayload.targetMaxChars || 200, chunkChars: argsPayload.chunkChars || 120 });
      await respond({ result: res });
      return;
    }

    case 'export_closure': {
      const res = await hooks.exportPackClosure({ include_png: false, meta: argsPayload.meta });
      await respond({ result: res });
      return;
    }

    case 'import_bundle': {
      const res = await hooks.importBundleHook({ bundle_path: argsPayload.bundle_path });
      await respond({ result: res });
      return;
    }

    case 'list_cards': {
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
      await respond({ cards: out });
      return;
    }

    case 'find_by_hash': {
      const targets = Array.isArray(argsPayload.hashes) ? argsPayload.hashes : [];
      const entries = await fs.readdir(cardDir).catch(() => []);
      const out = [];
      for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(cardDir, f), 'utf-8');
          const p = JSON.parse(raw);
          if (p && p.hash && targets.includes(p.hash)) {
            const card_id = f.replace('.json', '');
            out.push({ card_id, payload: p });
          }
        } catch {
          // skip corrupt
        }
      }
      await respond({ found: out });
      return;
    }

    case 'get_text': {
      const txt = await vault.getText(argsPayload.hash);
      await respond({ text: txt });
      return;
    }

    case 'verify_card': {
      const res = await vault.verifyCardHash(argsPayload.card_id);
      await respond({ res });
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
