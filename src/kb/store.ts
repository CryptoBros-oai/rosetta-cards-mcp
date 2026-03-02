import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { summarizeToCardDraft } from "./summarize.js";
import { renderCardPng } from "./render.js";
import { upsertCardEmbedding, searchByEmbedding } from "./embed.js";
import { CardPayload } from "./schema.js";
import { canonicalHash } from "./canonical.js";

const ROOT = process.cwd();
const DOC_DIR = path.join(ROOT, "data", "docs");
const CARD_DIR = path.join(ROOT, "data", "cards");

type DocRecord = {
  doc_id: string;
  title: string;
  text: string;
  tags: string[];
  source_url?: string;
  chunks: string[];
  created_at: string;
};

function chunkText(text: string, maxChars = 2400): string[] {
  const paras = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    const next = (buf ? buf + "\n\n" : "") + p;
    if (next.length > maxChars && buf.trim().length > 0) {
      chunks.push(buf.trim());
      buf = p;
    } else {
      buf = next;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

async function ensureDirs() {
  await fs.mkdir(DOC_DIR, { recursive: true });
  await fs.mkdir(CARD_DIR, { recursive: true });
  await fs.mkdir(path.join(ROOT, "data", "index"), { recursive: true });
}

export async function addDocument(args: {
  title: string;
  text: string;
  tags?: string[];
  source_url?: string;
}) {
  await ensureDirs();
  const doc_id = "doc_" + crypto.randomUUID();
  const chunks = chunkText(args.text);

  const rec: DocRecord = {
    doc_id,
    title: args.title,
    text: args.text,
    tags: args.tags ?? [],
    source_url: args.source_url,
    chunks,
    created_at: new Date().toISOString()
  };

  await fs.writeFile(path.join(DOC_DIR, `${doc_id}.json`), JSON.stringify(rec, null, 2), "utf-8");
  return { doc_id, chunks_created: chunks.length };
}

async function loadDoc(doc_id: string): Promise<DocRecord> {
  const p = path.join(DOC_DIR, `${doc_id}.json`);
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw);
}

export async function buildCard(args: {
  doc_id: string;
  chunk_id?: number;
  style?: "default" | "dark" | "light";
  include_qr?: boolean;
}) {
  await ensureDirs();
  const doc = await loadDoc(args.doc_id);
  const chunk_id = args.chunk_id ?? 0;
  const chunk = doc.chunks[chunk_id] ?? doc.text;

  const draft = await summarizeToCardDraft({
    title: doc.title,
    text: chunk,
    tags: doc.tags
  });

  const card_id = "card_" + crypto.randomUUID();

  const base: Omit<CardPayload, "hash"> = {
    version: "card.v1",
    card_id,
    title: draft.title,
    bullets: draft.bullets,
    diagram_mermaid: draft.diagram_mermaid,
    tags: Array.from(new Set([...(doc.tags ?? []), ...(draft.tags ?? [])])),
    sources: [{ url: doc.source_url, doc_id: doc.doc_id, chunk_id }],
    created_at: new Date().toISOString()
  };

  const hash = canonicalHash(base as unknown as Record<string, unknown>);
  const payload: CardPayload = { ...base, hash };

  const json_path = path.join(CARD_DIR, `${card_id}.json`);
  await fs.writeFile(json_path, JSON.stringify(payload, null, 2), "utf-8");

  const png_path = path.join(CARD_DIR, `${card_id}.png`);
  await renderCardPng({
    payload,
    png_path,
    style: args.style ?? "default",
    include_qr: args.include_qr ?? true
  });

  await upsertCardEmbedding(payload);

  return { card_id, png_path, json_path };
}

export async function getCard(card_id: string) {
  const json_path = path.join(CARD_DIR, `${card_id}.json`);
  const png_path = path.join(CARD_DIR, `${card_id}.png`);
  const raw = await fs.readFile(json_path, "utf-8");
  return { card_json: JSON.parse(raw), png_path };
}

export async function searchCards(args: { query: string; top_k?: number }) {
  return searchByEmbedding(args.query, args.top_k ?? 8);
}
