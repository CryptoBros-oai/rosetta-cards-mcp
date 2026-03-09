#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const REFRESH_GOLDEN = process.argv.includes("--refresh-golden");
const GOLDEN_PATH = path.join(process.cwd(), "scripts", "smoke.golden.json");

// ---------------------------------------------------------------------------
// Worker harness
// ---------------------------------------------------------------------------
function runWorker(vaultRoot, action, payload = {}) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(
      os.tmpdir(),
      `smoke-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
    const env = { ...process.env, VAULT_ROOT: vaultRoot, SMOKE_OUT_PATH: outPath };
    const worker = path.join(process.cwd(), "scripts", "smoke_worker.mjs");
    const args = [
      "--loader",
      "ts-node/esm",
      worker,
      action,
      JSON.stringify(payload),
    ];

    execFile(
      process.execPath,
      args,
      { env, cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || (err && err.message) || "worker error";
          return reject(new Error(msg + "\n" + stdout));
        }

        const finalizeFromFile = async () => {
          try {
            const raw = await fs.readFile(outPath, "utf-8");
            await fs.rm(outPath).catch(() => {});
            return resolve(JSON.parse(raw));
          } catch (fileErr) {
            console.error(
              `[smoke] worker produced empty stdout (action=${action}) stderr=${JSON.stringify(
                stderr
              )}`
            );
            return resolve(null);
          }
        };

        const out = stdout.trim();
        if (!out) return void finalizeFromFile();
        try {
          const json = JSON.parse(out);
          return resolve(json);
        } catch (e) {
          return void finalizeFromFile();
        }
      }
    );
  });
}

function ensureOk(res, name) {
  if (!res) throw new Error(`No response for ${name}`);
}

// ---------------------------------------------------------------------------
// Golden comparison helpers
// ---------------------------------------------------------------------------
async function loadGolden() {
  try {
    const raw = await fs.readFile(GOLDEN_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveGolden(summary) {
  await fs.writeFile(GOLDEN_PATH, JSON.stringify(summary, null, 2) + "\n", "utf-8");
}

function compareGolden(actual, expected) {
  const diffs = [];
  for (const key of Object.keys(expected)) {
    const exp = JSON.stringify(expected[key]);
    const act = JSON.stringify(actual[key]);
    if (exp !== act) {
      diffs.push({ field: key, expected: expected[key], actual: actual[key] });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Main smoke run
// ---------------------------------------------------------------------------
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rosetta-vault-"));
  const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), "rosetta-vault-"));
  console.log("VAULT_A:", tmp);
  console.log("VAULT_B:", tmpB);

  // Ensure worker initialized vault dirs
  await runWorker(tmp, "init");
  await runWorker(tmpB, "init");

  // Create an initial behavior pack (empty, for tag enforcement during ingest)
  const initPackRes = await runWorker(tmp, "create_pack", {
    name: "smoke-pack-init",
    policies: { allowed_tags: ["smoke"], blocked_tags: ["blocked-smoke"] },
  });
  ensureOk(initPackRes, "create_pack");
  await runWorker(tmp, "set_active_pack", {
    pack_id: initPackRes.pack.pack_id,
  });
  console.log("Created initial enforcement pack:", initPackRes.pack.pack_id);

  // Ingest fixture folder from repo into VAULT_A
  const fixture = path.join(process.cwd(), "examples", "smoke-fixture");
  console.log("Ingesting fixture folder:", fixture);
  const ingestRes = await runWorker(tmp, "ingest_folder", {
    path: fixture,
    tags: ["smoke"],
  });
  ensureOk(ingestRes, "ingest_folder");
  const folderResult = ingestRes.result;
  console.log(
    "Ingest result summary:",
    folderResult.folder_card_hash,
    "files:",
    folderResult.files.length,
  );

  // Verify cards exist and their hashes validate
  const cardsList = await runWorker(tmp, "list_cards");
  const hashesToCheck = [];
  if (folderResult.report_card_hash)
    hashesToCheck.push(folderResult.report_card_hash);
  if (folderResult.folder_card_hash)
    hashesToCheck.push(folderResult.folder_card_hash);
  for (const f of folderResult.files) {
    if (f.card_hash) hashesToCheck.push(f.card_hash);
  }

  const found = await runWorker(tmp, "find_by_hash", {
    hashes: hashesToCheck,
  });
  const foundHashes = (found.found || []).map((c) => c.payload.hash);
  for (const h of hashesToCheck) {
    if (!foundHashes.includes(h))
      throw new Error(`Missing hash in VAULT_A: ${h}`);
  }
  console.log("All ingested hashes present in VAULT_A");

  // Drain context (create chat chunks)
  const chatText =
    "User: Hello\nAssistant: Hi there.\nUser: Tell me about smoke testing.\nAssistant: Smoke tests validate basic flows.\n".repeat(
      3,
    );
  const drainRes = await runWorker(tmp, "drain_context", {
    title: "smoke-chat",
    tags: ["smoke"],
    chatText,
    chunkChars: 80,
    targetMaxChars: 200,
  });
  ensureOk(drainRes, "drain_context");
  const drain = drainRes.result;
  console.log(
    "Drain produced index hash:",
    drain.index_card_hash,
    "chunks:",
    drain.chunk_count,
  );
  console.log("Chunk card ids:", JSON.stringify(drain.chunk_card_ids));

  // Ensure chunk cards exist and text reconstructs
  const listRes = await runWorker(tmp, "list_cards");
  const cards = listRes.cards || [];
  console.log("Cards present count:", cards.length);
  console.log(
    "Some card ids:",
    cards.slice(0, 5).map((c) => c.card_id),
  );
  const chunkCards = cards.filter((c) =>
    drain.chunk_card_ids.includes(c.card_id),
  );
  if (chunkCards.length !== drain.chunk_card_ids.length)
    throw new Error("Some chunk cards missing after drain");

  // Reconstruct canonical text from chunk text references
  let reconstructed = "";
  for (const entry of chunkCards) {
    const c = entry.payload;
    if (!c.text || !c.text.hash) throw new Error("Chunk missing text.hash");
    const txt = await runWorker(tmp, "get_text", { hash: c.text.hash });
    reconstructed += txt.text;
  }
  // Basic sanity check: reconstructed chunks should contain a known phrase from the original chatText
  if (!reconstructed.includes("Smoke tests validate basic flows.")) {
    throw new Error("Reconstructed chunk texts do not contain expected phrase");
  }
  console.log("Chunk text reconstruction sanity check passed");

  // Re-create pack with ALL card IDs so closure has pins
  const allCardIds = cards.map((c) => c.card_id);
  const packRes = await runWorker(tmp, "create_pack", {
    name: "smoke-pack",
    card_ids: allCardIds,
    policies: { allowed_tags: ["smoke"], blocked_tags: ["blocked-smoke"] },
  });
  ensureOk(packRes, "create_pack");
  await runWorker(tmp, "set_active_pack", {
    pack_id: packRes.pack.pack_id,
  });
  console.log(
    "Created closure pack with",
    allCardIds.length,
    "cards:",
    packRes.pack.pack_id,
  );

  // Export pack closure (includes pinned cards) from VAULT_A
  const closure = await runWorker(tmp, "export_closure", {
    meta: { description: "smoke closure" },
  });
  ensureOk(closure, "export_closure");
  const bundlePath = closure.result.bundle_path;
  console.log("Exported bundle at", bundlePath);

  // Use the manifest's integrity_hash — deterministic (sorted card_id:hash pairs)
  // NOT the raw manifest hash, which includes non-deterministic bundle_id/created_at
  const bundleIntegrityHash =
    closure.result.manifest?.integrity_hash ?? null;

  // Import bundle into VAULT_B
  const importRes = await runWorker(tmpB, "import_bundle", {
    bundle_path: bundlePath,
  });
  ensureOk(importRes, "import_bundle");
  if (!importRes.result.integrity_ok)
    throw new Error("Bundle integrity mismatch");
  if ((importRes.result.failed || []).length > 0)
    throw new Error(
      "Import had failed entries: " + JSON.stringify(importRes.result.failed),
    );
  console.log(
    "Bundle imported into VAULT_B:",
    importRes.result.imported,
    "imported,",
    importRes.result.skipped,
    "skipped",
  );

  // Prepare chunkHashes (card payload hashes) for cross-vault comparison
  const chunkHashes = chunkCards.map((e) => e.payload.hash);

  // Verify cross-vault equality: ensure every hash in hashesToCheck + chunkHashes + drain.index_card_hash exists in VAULT_B
  const allHashes = [
    ...new Set([...hashesToCheck, ...chunkHashes, drain.index_card_hash]),
  ];
  const foundInB = await runWorker(tmpB, "find_by_hash", {
    hashes: allHashes,
  });
  const foundInBHashes = (foundInB.found || []).map((c) => c.payload.hash);
  for (const h of allHashes) {
    if (!foundInBHashes.includes(h))
      throw new Error(`Hash ${h} missing after import into VAULT_B`);
  }
  console.log("All hashes present in VAULT_B after import");

  // -------------------------------------------------------------------------
  // Re-ingest into a fresh vault to verify determinism
  // -------------------------------------------------------------------------
  const tmpC = await fs.mkdtemp(path.join(os.tmpdir(), "rosetta-vault-"));
  await runWorker(tmpC, "init");
  const packResC = await runWorker(tmpC, "create_pack", {
    name: "smoke-pack",
    policies: { allowed_tags: ["smoke"], blocked_tags: ["blocked-smoke"] },
  });
  await runWorker(tmpC, "set_active_pack", {
    pack_id: packResC.pack.pack_id,
  });
  const reingestRes = await runWorker(tmpC, "ingest_folder", {
    path: fixture,
    tags: ["smoke"],
  });
  ensureOk(reingestRes, "reingest_folder");
  const reingestHash = reingestRes.result.folder_card_hash;
  const deterministic = reingestHash === folderResult.folder_card_hash;
  console.log(
    deterministic
      ? "deterministic: true"
      : `deterministic: FALSE (${folderResult.folder_card_hash} vs ${reingestHash})`,
  );
  if (!deterministic) {
    throw new Error("Non-deterministic re-ingestion detected");
  }
  await fs.rm(tmpC, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // Build golden summary
  // -------------------------------------------------------------------------
  const fileArtifactHashes = folderResult.files
    .filter((f) => f.card_hash)
    .map((f) => f.card_hash)
    .sort();
  const blobCount = folderResult.files.filter((f) => f.blob_hash).length;

  const summary = {
    folder_index_hash: folderResult.folder_card_hash,
    report_hash: folderResult.report_card_hash || null,
    chat_index_hash: drain.index_card_hash,
    chunk_count: drain.chunk_count,
    chunk_hashes: chunkHashes.sort(),
    file_artifact_count: fileArtifactHashes.length,
    file_artifact_hashes: fileArtifactHashes,
    blob_count: blobCount,
    bundle_integrity_hash: bundleIntegrityHash,
    import_ok: true,
    deterministic: true,
  };

  // -------------------------------------------------------------------------
  // Golden comparison
  // -------------------------------------------------------------------------
  const golden = await loadGolden();

  if (REFRESH_GOLDEN || !golden) {
    await saveGolden(summary);
    if (REFRESH_GOLDEN) {
      console.log("\n=== GOLDEN REFRESHED ===");
    } else {
      console.log("\n=== GOLDEN BASELINE ESTABLISHED ===");
    }
    console.log("Wrote:", GOLDEN_PATH);
  } else {
    const diffs = compareGolden(summary, golden);
    if (diffs.length > 0) {
      console.error("\n=== SMOKE FAILED: non-deterministic drift detected ===");
      for (const d of diffs) {
        console.error(
          `  ${d.field}:\n    expected: ${JSON.stringify(d.expected)}\n    actual:   ${JSON.stringify(d.actual)}`,
        );
      }
      console.error("===");
      console.error(
        "To accept these changes:  npm run smoke -- --refresh-golden",
      );
      // Clean up before exit
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(tmpB, { recursive: true, force: true });
      process.exit(2);
    }
    console.log("\n=== GOLDEN MATCH ===");
  }

  // Print summary
  console.log("\n=== SMOKE SUMMARY ===");
  console.log("folder_index_hash: ", summary.folder_index_hash);
  console.log("report_hash:       ", summary.report_hash);
  console.log("chat_index_hash:   ", summary.chat_index_hash);
  console.log("chunk_count:       ", summary.chunk_count);
  console.log("file_artifact_count:", summary.file_artifact_count);
  console.log("blob_count:        ", summary.blob_count);
  console.log("bundle_integrity:  ", summary.bundle_integrity_hash);
  console.log("import_ok:         ", summary.import_ok);
  console.log("deterministic:     ", summary.deterministic);
  console.log("=====================\n");

  // Clean up
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(tmpB, { recursive: true, force: true });

  console.log("SMOKE_OK");
}

main().catch((err) => {
  console.error("SMOKE_FAILED", err && err.message ? err.message : err);
  console.error(err.stack || "");
  process.exit(2);
});
