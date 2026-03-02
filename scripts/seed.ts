#!/usr/bin/env node
/**
 * Seed script — creates sample documents, cards, and a behavior pack
 * so the TUI has something to browse.
 *
 * Usage:  npm run seed
 *
 * Skips PNG rendering (no Playwright needed). Cards are JSON-only.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalHash } from "../src/kb/canonical.js";
import { upsertCardEmbedding } from "../src/kb/embed.js";
import { createBehaviorPack, setActivePack } from "../src/kb/vault.js";
import type { CardPayload } from "../src/kb/schema.js";

const ROOT = process.cwd();
const DOC_DIR = path.join(ROOT, "data", "docs");
const CARD_DIR = path.join(ROOT, "data", "cards");
const INDEX_DIR = path.join(ROOT, "data", "index");

const SAMPLES = [
  {
    title: "RKS-VM: Opcode Tagging Plan",
    bullets: [
      "Define opcode_tags.json with verb-class taxonomy",
      "Add TRACE instrumentation to every dispatch",
      "Build verb balance reducer for real-time analysis",
      "Run deterministic baseline on reference workload",
      "Sweep noise floor and plot opcode frequency histogram",
      "Identify hot paths for selective JIT compilation",
    ],
    tags: ["rosetta", "rks-vm", "opcodes"],
  },
  {
    title: "Canonical Hashing Specification",
    bullets: [
      "All artifacts are hashed using SHA-256 over canonical JSON",
      "Keys are sorted recursively, undefined values stripped",
      "Strings are normalized to Unicode NFC before hashing",
      "The hash field itself is excluded from the input",
      "CRLF and bare CR are normalized to LF for text hashes",
      "This ensures cross-platform deterministic hashes",
    ],
    tags: ["spec", "hashing", "canonical"],
  },
  {
    title: "Behavior Pack Architecture",
    bullets: [
      "Packs are content-addressed policy bundles",
      "Each pack pins specific card hashes for reproducibility",
      "Policies include search_boost, blocked_tags, allowed_tags",
      "Active pack is stored in data/packs/active.json",
      "Pack closure export collects all transitive dependencies",
      "Deterministic scoring uses fixed weight constants",
    ],
    tags: ["architecture", "packs", "policy"],
  },
  {
    title: "Context Drain Protocol",
    bullets: [
      "Drain detects when chat text exceeds targetMaxChars",
      "Text is chunked at paragraph boundaries respecting chunkChars",
      "Each chunk becomes a ChatChunk card with prev/next pointers",
      "A ChatLogIndex card references all chunks in order",
      "Original text hash is preserved for deduplication",
      "Drain returns drained:false when text is below threshold",
    ],
    tags: ["protocol", "drain", "chunking"],
  },
  {
    title: "File Ingestion Pipeline",
    bullets: [
      "Binary files are stored as content-addressed blobs",
      "Text extraction supports DOCX (mammoth) and PDF (pdf-parse)",
      "Each file produces a FileArtifact card with blob and text refs",
      "Folder ingestion creates a FolderIndex card with file list",
      "An IngestReport card summarizes the ingestion run",
      "All hashes are deterministic for deduplication",
    ],
    tags: ["ingestion", "pipeline", "files"],
  },
  {
    title: "MCP Server Tool Interface",
    bullets: [
      "kb.add_document — ingest text with tags and source URL",
      "kb.build_card — render a card from a document chunk",
      "kb.search — lexical cosine search with pack-aware scoring",
      "kb.get_card — retrieve card JSON and PNG path by ID",
      "Server uses stdio transport for editor integration",
      "Schema-first design using Zod for all payloads",
    ],
    tags: ["mcp", "server", "tools", "api"],
  },
];

async function main() {
  // Ensure directories
  for (const d of ["docs", "cards", "index", "bundles", "pinsets", "packs", "blobs", "text"]) {
    await fs.mkdir(path.join(ROOT, "data", d), { recursive: true });
  }

  console.log("Seeding sample data...\n");

  const cardIds: string[] = [];

  for (const sample of SAMPLES) {
    // Create doc
    const doc_id = "doc_" + crypto.randomUUID();
    const doc = {
      doc_id,
      title: sample.title,
      text: sample.bullets.join("\n"),
      tags: sample.tags,
      chunks: [sample.bullets.join("\n")],
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(DOC_DIR, `${doc_id}.json`),
      JSON.stringify(doc, null, 2),
      "utf-8",
    );

    // Create card (JSON only, no PNG)
    const card_id = "card_" + crypto.randomUUID();
    const base: Omit<CardPayload, "hash"> = {
      version: "card.v1",
      card_id,
      title: sample.title,
      bullets: sample.bullets,
      tags: sample.tags,
      sources: [{ doc_id, chunk_id: 0 }],
      created_at: doc.created_at,
    };
    const hash = canonicalHash(base as unknown as Record<string, unknown>);
    const card: CardPayload = { ...base, hash };

    await fs.writeFile(
      path.join(CARD_DIR, `${card_id}.json`),
      JSON.stringify(card, null, 2),
      "utf-8",
    );

    // Index for search
    await upsertCardEmbedding(card);

    cardIds.push(card_id);
    console.log(`  ${sample.title}`);
    console.log(`    doc:  ${doc_id}`);
    console.log(`    card: ${card_id}\n`);
  }

  // Create a behavior pack with all cards
  const pack = await createBehaviorPack({
    name: "Rosetta Core",
    card_ids: cardIds,
    policies: {
      search_boost: 0.5,
      blocked_tags: ["secret", "private"],
      allowed_tags: ["rosetta", "spec", "architecture"],
      default_export_scope: "pack_only",
    },
  });
  await setActivePack(pack.pack_id);

  console.log(`Pack: ${pack.name} (${pack.pack_id})`);
  console.log(`  ${pack.pins.length} pinned cards, set as active\n`);

  console.log(`Done! Created ${cardIds.length} cards + 1 pack.`);
  console.log("Run the TUI with:  npm run tui");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
