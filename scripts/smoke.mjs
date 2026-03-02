#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

function runWorker(vaultRoot, action, payload = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, VAULT_ROOT: vaultRoot };
    const worker = path.join(process.cwd(), 'scripts', 'smoke_worker.mjs');
    const args = ['--loader', 'ts-node/esm', worker, action, JSON.stringify(payload)];
    execFile(process.execPath, args, { env, cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr || (err && err.message) || 'worker error';
        return reject(new Error(msg + '\n' + stdout));
      }
      try {
        const out = stdout.trim();
        if (!out) return resolve(null);
        const json = JSON.parse(out);
        return resolve(json);
      } catch (e) {
        return reject(e);
      }
    });
  });
}

function ensureOk(res, name) {
  if (!res) throw new Error(`No response for ${name}`);
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rosetta-vault-'));
  const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'rosetta-vault-'));
  console.log('VAULT_A:', tmp);
  console.log('VAULT_B:', tmpB);

  // Ensure worker initialized vault dirs
  await runWorker(tmp, 'init');
  await runWorker(tmpB, 'init');

  // Create a behavior pack in VAULT_A and set it active
  const packRes = await runWorker(tmp, 'create_pack', { name: 'smoke-pack', policies: { allowed_tags: ['smoke'], blocked_tags: ['blocked-smoke'] } });
  ensureOk(packRes, 'create_pack');
  const pack = packRes.pack;
  await runWorker(tmp, 'set_active_pack', { pack_id: pack.pack_id });
  console.log('Created and activated pack:', pack.pack_id);

  // Ingest fixture folder from repo into VAULT_A
  const fixture = path.join(process.cwd(), 'examples', 'smoke-fixture');
  console.log('Ingesting fixture folder:', fixture);
  const ingestRes = await runWorker(tmp, 'ingest_folder', { path: fixture, tags: ['smoke'] });
  ensureOk(ingestRes, 'ingest_folder');
  const folderResult = ingestRes.result;
  console.log('Ingest result summary:', folderResult.folder_card_hash, 'files:', folderResult.files.length);

  // Verify cards exist and their hashes validate
  const cardsList = await runWorker(tmp, 'list_cards');
  const hashesToCheck = [];
  if (folderResult.report_card_hash) hashesToCheck.push(folderResult.report_card_hash);
  if (folderResult.folder_card_hash) hashesToCheck.push(folderResult.folder_card_hash);
  for (const f of folderResult.files) {
    if (f.card_hash) hashesToCheck.push(f.card_hash);
  }

  const found = await runWorker(tmp, 'find_by_hash', { hashes: hashesToCheck });
  const foundHashes = (found.found || []).map((c) => c.hash);
  for (const h of hashesToCheck) {
    if (!foundHashes.includes(h)) throw new Error(`Missing hash in VAULT_A: ${h}`);
  }
  console.log('All ingested hashes present in VAULT_A');

  // Drain context (create chat chunks)
  const chatText = 'User: Hello\nAssistant: Hi there.\nUser: Tell me about smoke testing.\nAssistant: Smoke tests validate basic flows.\n'.repeat(3);
  const drainRes = await runWorker(tmp, 'drain_context', { title: 'smoke-chat', tags: ['smoke'], chatText, chunkChars: 80, targetMaxChars: 200 });
  ensureOk(drainRes, 'drain_context');
  const drain = drainRes.result;
  console.log('Drain produced index hash:', drain.index.hash, 'chunks:', drain.chunks.length);

  // Ensure chunk cards exist and text reconstructs
  const chunkHashes = drain.chunks.map((c) => c.hash);
  const foundChunks = await runWorker(tmp, 'find_by_hash', { hashes: chunkHashes });
  const foundChunkHashes = (foundChunks.found || []).map((c) => c.hash);
  for (const h of chunkHashes) {
    if (!foundChunkHashes.includes(h)) throw new Error(`Missing chunk hash in VAULT_A: ${h}`);
  }

  // Reconstruct canonical text from text records
  let reconstructed = '';
  for (const c of drain.chunks) {
    if (!c.text || !c.text.hash) throw new Error('Chunk missing text.hash');
    const txt = await runWorker(tmp, 'get_text', { hash: c.text.hash });
    reconstructed += txt.text;
  }
  const canonicalOriginal = (await runWorker(tmp, 'get_text', { hash: drain.index.text.hash })).text;
  if (!canonicalOriginal) throw new Error('Missing canonical chat text');
  if (!reconstructed.includes(canonicalOriginal.slice(0, 50))) {
    // basic sanity check
    throw new Error('Reconstructed chunk texts do not contain original canonical text');
  }
  console.log('Chunk text reconstruction sanity check passed');

  // Export pack closure (includes pinned cards) from VAULT_A
  const closure = await runWorker(tmp, 'export_closure', { meta: { description: 'smoke closure' } });
  ensureOk(closure, 'export_closure');
  const bundlePath = closure.result.bundle_path;
  console.log('Exported bundle at', bundlePath);

  // Import bundle into VAULT_B
  const importRes = await runWorker(tmpB, 'import_bundle', { bundle_path: bundlePath });
  ensureOk(importRes, 'import_bundle');
  if (!importRes.result.integrity_ok) throw new Error('Bundle integrity mismatch');
  if ((importRes.result.failed || []).length > 0) throw new Error('Import had failed entries: ' + JSON.stringify(importRes.result.failed));
  console.log('Bundle imported into VAULT_B:', importRes.result.imported, 'imported,', importRes.result.skipped, 'skipped');

  // Verify cross-vault equality: ensure every hash in hashesToCheck + chunkHashes + drain.index.hash exists in VAULT_B
  const allHashes = [...new Set([...hashesToCheck, ...chunkHashes, drain.index.hash])];
  const foundInB = await runWorker(tmpB, 'find_by_hash', { hashes: allHashes });
  const foundInBHashes = (foundInB.found || []).map((c) => c.hash);
  for (const h of allHashes) {
    if (!foundInBHashes.includes(h)) throw new Error(`Hash ${h} missing after import into VAULT_B`);
  }
  console.log('All hashes present in VAULT_B after import');

  console.log('Smoke test succeeded — cleaning up temp vaults');
  // Clean up
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(tmpB, { recursive: true, force: true });

  console.log('SMOKE_OK');
}

main().catch((err) => {
  console.error('SMOKE_FAILED', err && err.message ? err.message : err);
  console.error(err.stack || '');
  process.exit(2);
});
