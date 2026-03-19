/**
 * Corpus-to-Vault bridge.
 *
 * Mirrors KB artifacts (data/docs/, data/cards/) into the content-addressed
 * vault (.vault/) so they are searchable via vault.search (FTS + embeddings).
 *
 * Deduplication is automatic — re-bridging the same doc/card is a no-op
 * because vault.put returns created=false for identical content.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { vaultPut } from "../vault/store.js";

export type BridgeResult = {
  bridged: number;
  skipped: number;
  errors: string[];
};

/** Resolve KB data root at call time (not import time). */
function kbRoot(): string {
  return path.join(process.env.VAULT_ROOT ?? process.cwd(), "data");
}

async function readDocJson(doc_id: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(kbRoot(), "docs", `${doc_id}.json`), "utf-8");
  return JSON.parse(raw);
}

async function readCardJson(card_id: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(kbRoot(), "cards", `${card_id}.json`), "utf-8");
  return JSON.parse(raw);
}

async function listDocIds(): Promise<string[]> {
  const dir = path.join(kbRoot(), "docs");
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

async function listCardIds(): Promise<string[]> {
  const dir = path.join(kbRoot(), "cards");
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Bridge KB docs into the vault as "fact" artifacts.
 * Payload: { title, text (first 2000 chars), source_doc_id }
 */
export async function bridgeDocsToVault(doc_ids: string[]): Promise<BridgeResult> {
  let bridged = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const doc_id of doc_ids) {
    try {
      const doc = await readDocJson(doc_id);
      const title = (doc.title as string) ?? "";
      const text = ((doc.text as string) ?? "").slice(0, 2000);
      const tags = (doc.tags as string[]) ?? [];

      const result = await vaultPut({
        kind: "fact",
        payload: {
          title,
          text,
          source_doc_id: doc_id,
        },
        tags: [...tags, "kb-bridge"],
        refs: [],
      });
      if (result.created) {
        bridged++;
      } else {
        skipped++;
      }
    } catch (e: unknown) {
      errors.push(`doc ${doc_id}: ${(e as Error).message}`);
    }
  }

  return { bridged, skipped, errors };
}

/**
 * Bridge KB cards into the vault.
 * Kind: "skill" if the card has bullets (step-like), "fact" otherwise.
 * Payload: { title, bullets, source_card_id }
 */
export async function bridgeCardsToVault(card_ids: string[]): Promise<BridgeResult> {
  let bridged = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const card_id of card_ids) {
    try {
      const card = await readCardJson(card_id);
      const bullets = (card.bullets as string[]) ?? [];
      const hasBullets = bullets.length > 0;
      const kind = hasBullets ? "skill" : "fact";
      const tags = (card.tags as string[]) ?? [];

      const result = await vaultPut({
        kind,
        payload: {
          title: (card.title as string) ?? "",
          bullets,
          source_card_id: card_id,
        },
        tags: [...tags, "kb-bridge"],
        refs: [],
      });
      if (result.created) {
        bridged++;
      } else {
        skipped++;
      }
    } catch (e: unknown) {
      errors.push(`card ${card_id}: ${(e as Error).message}`);
    }
  }

  return { bridged, skipped, errors };
}

/**
 * Bridge ALL existing KB docs and cards into the vault.
 * Useful for retroactive backfill.
 */
export async function bridgeAllToVault(): Promise<{
  docs: BridgeResult;
  cards: BridgeResult;
}> {
  const docIds = await listDocIds();
  const cardIds = await listCardIds();

  const docs = await bridgeDocsToVault(docIds);
  const cards = await bridgeCardsToVault(cardIds);

  return { docs, cards };
}
