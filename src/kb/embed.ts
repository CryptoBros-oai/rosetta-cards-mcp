import fs from "node:fs/promises";
import path from "node:path";
import { CardPayload } from "./schema.js";

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, "data", "index", "cards_index.json");

type IndexRow = {
  card_id: string;
  title: string;
  tags: string[];
  text: string; // searchable text blob (title + bullets + tags)
  tf: Record<string, number>;
};

function tokenize(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function tfMap(tokens: string[]) {
  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

function cosine(a: Record<string, number>, b: Record<string, number>) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k in a) na += a[k] * a[k];
  for (const k in b) nb += b[k] * b[k];
  for (const k in a) if (b[k]) dot += a[k] * b[k];
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

async function loadIndex(): Promise<IndexRow[]> {
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveIndex(rows: IndexRow[]) {
  await fs.mkdir(path.dirname(INDEX_PATH), { recursive: true });
  await fs.writeFile(INDEX_PATH, JSON.stringify(rows, null, 2), "utf-8");
}

export async function upsertCardEmbedding(payload: CardPayload) {
  const rows = await loadIndex();
  const text = `${payload.title}\n${payload.bullets.join("\n")}\n${payload.tags.join(" ")}`;
  const tokens = tokenize(text);
  const row: IndexRow = {
    card_id: payload.card_id,
    title: payload.title,
    tags: payload.tags,
    text,
    tf: tfMap(tokens)
  };

  const i = rows.findIndex((r) => r.card_id === payload.card_id);
  if (i >= 0) rows[i] = row;
  else rows.push(row);

  await saveIndex(rows);
}

export async function searchByEmbedding(query: string, topK: number) {
  const rows = await loadIndex();
  const qtf = tfMap(tokenize(query));

  return rows
    .map((r) => ({
      card_id: r.card_id,
      title: r.title,
      tags: r.tags,
      score: cosine(qtf, r.tf)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
