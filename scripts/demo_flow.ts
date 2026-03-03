#!/usr/bin/env node
/**
 * Demo script implementing the requested flow:
 * 1. Build a card for chunk 0 (simulating kb.build_card)
 * 2. Search (simulating kb.search)
 * 3. Get card (simulating kb.get_card)
 *
 * Usage:
 *   node --loader ts-node/esm scripts/demo_flow.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { upsertCardEmbedding } from "../src/kb/embed.js";
import { type CardPayload, CardPayloadSchema } from "../src/kb/schema.js";
import {
  nowISO,
  safeCanonicalHash,
  loadJsonStrict,
  loadSearch,
  type SearchResult,
} from "./demo_utils.js";

const ROOT = process.cwd();
const DOC_DIR = path.join(ROOT, "data", "docs");
const CARD_DIR = path.join(ROOT, "data", "cards");

async function main() {
  const search = await loadSearch();

  // --- PRE-REQUISITE: Create a Doc to reference ---
  // We need a doc_id to pass to build_card.
  const docId = "doc_" + crypto.randomUUID();
  const docTitle = "RKS-VM: Opcode Tagging Plan";
  const docText = "Define opcode_tags.json with verb-class taxonomy\nAdd TRACE instrumentation to every dispatch\nBuild verb balance reducer for real-time analysis";
  const createdAt = nowISO();
  
  await fs.mkdir(DOC_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DOC_DIR, `${docId}.json`),
    JSON.stringify({
      doc_id: docId,
      title: docTitle,
      text: docText,
      tags: ["rosetta", "rks-vm", "opcodes"],
      chunks: [docText], // chunk 0 is the whole text for this demo
      created_at: createdAt,
    }, null, 2)
  );
  console.log(`[Setup] Created document: ${docId}`);

  // --- STEP 2: Build a card for chunk 0 ---
  console.log(`\n[Action] kb.build_card { doc_id: "${docId}", chunk_id: 0, ... }`);
  
  const cardId = "card_" + crypto.randomUUID();
  const cardBase: Omit<CardPayload, "hash"> = {
    version: "card.v1",
    card_id: cardId,
    title: docTitle,
    bullets: docText.split("\n"),
    tags: ["rosetta", "rks-vm", "opcodes"], // Inferred from doc or passed in
    sources: [{ doc_id: docId, chunk_id: 0 }],
    created_at: createdAt,
    // Metadata from 'style' and 'include_qr' params would go here or affect rendering
    metadata: {
      style: "default",
      include_qr: true
    }
  };
  
  // The cast here is consistent with other scripts like seed.ts
  const hash = safeCanonicalHash(cardBase as unknown as Record<string, unknown>);
  const card: CardPayload = { ...cardBase, hash };
  
  await fs.mkdir(CARD_DIR, { recursive: true });
  await fs.writeFile(
    path.join(CARD_DIR, `${cardId}.json`),
    JSON.stringify(card, null, 2)
  );
  
  // Indexing
  await upsertCardEmbedding(card);
  console.log(`[Result] Created card: ${cardId}`);
  console.log(`         Hash: ${hash}`);

  // --- STEP 3: Search ---
  const query = "trace instrumentation verb balance reducer";
  console.log(`\n[Action] kb.search { query: "${query}", top_k: 5 }`);
  
  const results = await search(query, { top_k: 5 });
  if (results.length === 0) {
    console.log("  (No results returned from search implementation, or mocked)");
  } else {
    results.forEach((r: SearchResult) =>
      console.log(`  Found: ${r.card_id} (score: ${r.score.toFixed(4)})`),
    );
  }

  // --- STEP 4: Get card ---
  console.log(`\n[Action] kb.get_card { card_id: "${cardId}" }`);
  
  const readPath = path.join(CARD_DIR, `${cardId}.json`);
  // Validate the loaded card against the schema to catch any corruption or drift.
  const loadedCard = await loadJsonStrict(readPath, CardPayloadSchema);
  
  console.log(`[Result] Retrieved card content:`);
  console.log(JSON.stringify(loadedCard, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});