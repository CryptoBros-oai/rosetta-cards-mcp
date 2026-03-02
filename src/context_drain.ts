/**
 * Context Drain — encode chat logs nearing context length into the Vault.
 *
 * Takes a chat log, detects if it is near the context limit, and flushes it
 * into deterministic Vault artifacts (chunk cards + index card).
 */

import {
  type ChatChunk,
  type ChatLogIndex,
} from "./kb/schema.js";
import {
  canonicalHash,
  canonicalizeText,
  hashText,
} from "./kb/canonical.js";
import {
  putText,
  saveChatChunkCard,
  saveChatLogIndexCard,
} from "./kb/vault.js";

export type DrainResult =
  | { drained: false }
  | {
      drained: true;
      index_card_id: string;
      index_card_hash: string;
      chunk_card_ids: string[];
      chunk_count: number;
    };

const DEFAULT_THRESHOLD = 0.8;

/**
 * Deterministically split text into chunks at paragraph boundaries.
 * Same input always produces the same chunks.
 *
 * Per INGESTION.md §6.2:
 *  - Prefer splitting at nearest \n\n at or before chunkChars
 *  - If no paragraph boundary exists within range, split exactly at chunkChars
 */
export function chunkAtParagraphs(
  text: string,
  chunkChars: number
): string[] {
  if (text.length === 0) return [];

  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let buf = "";

  for (const para of paragraphs) {
    const candidate = buf ? buf + "\n\n" + para : para;
    if (candidate.length > chunkChars && buf.length > 0) {
      chunks.push(buf);
      buf = para;
    } else {
      buf = candidate;
    }
  }
  if (buf.length > 0) {
    chunks.push(buf);
  }

  // Hard split: break any chunk that still exceeds chunkChars
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= chunkChars) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += chunkChars) {
        result.push(chunk.slice(i, i + chunkChars));
      }
    }
  }

  return result;
}

/**
 * Drain a chat log into the Vault.
 *
 * If chat_text is below threshold * target_max_chars, returns { drained: false }.
 * Otherwise, chunks the text and creates deterministic cards.
 */
export async function drainContext(args: {
  title: string;
  tags?: string[];
  chat_text: string;
  target_max_chars?: number;
  chunk_chars?: number;
}): Promise<DrainResult> {
  const targetMaxChars = args.target_max_chars ?? 120_000;
  const chunkChars = args.chunk_chars ?? 12_000;
  const threshold = DEFAULT_THRESHOLD;
  const baseTags = [...(args.tags ?? []), "chat", "drain"];

  if (args.chat_text.length < threshold * targetMaxChars) {
    return { drained: false };
  }

  const chunks = chunkAtParagraphs(args.chat_text, chunkChars);
  const totalChunks = chunks.length;
  const fullTextHash = hashText(args.chat_text);

  // Phase 1: Build chunk card bases (without prev/next links)
  type ChunkBase = Omit<ChatChunk, "hash" | "prev_hash" | "next_hash">;
  const chunkBases: ChunkBase[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunkText = chunks[i];
    await putText(chunkText);
    const chunkTextHash = hashText(chunkText);
    const canonicalChars = canonicalizeText(chunkText).length;

    chunkBases.push({
      type: "chat_chunk",
      spec_version: "1.0",
      title: `${args.title} [${i + 1}/${totalChunks}]`,
      tags: baseTags,
      index: i + 1,   // 1-based per spec §6.3
      total: totalChunks,
      text: { hash: chunkTextHash, chars: canonicalChars },
    });
  }

  // Phase 2: Compute hashes for each chunk card (without links first)
  const chunkHashes: string[] = [];
  for (const base of chunkBases) {
    chunkHashes.push(canonicalHash(base as unknown as Record<string, unknown>));
  }

  // Phase 3: Build final chunk cards with prev/next links and save
  const chunkCardIds: string[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const withLinks: Omit<ChatChunk, "hash"> = {
      ...chunkBases[i],
      prev_hash: i > 0 ? chunkHashes[i - 1] : undefined,
      next_hash: i < totalChunks - 1 ? chunkHashes[i + 1] : undefined,
    };
    const finalHash = canonicalHash(withLinks as unknown as Record<string, unknown>);
    const chunkCard: ChatChunk = { ...withLinks, hash: finalHash };
    const cardId = await saveChatChunkCard(chunkCard);
    chunkCardIds.push(cardId);
    chunkHashes[i] = finalHash;
  }

  // Phase 4: Build index card
  const indexBase: Omit<ChatLogIndex, "hash"> = {
    type: "chat_log_index",
    spec_version: "1.0",
    title: args.title,
    tags: baseTags,
    chat_text_hash: fullTextHash,
    chunking: {
      target_max_chars: targetMaxChars,
      threshold,
      chunk_chars: chunkChars,
    },
    chunks: chunkHashes,
  };

  const indexHash = canonicalHash(indexBase as unknown as Record<string, unknown>);
  const indexCard: ChatLogIndex = { ...indexBase, hash: indexHash };
  const indexCardId = await saveChatLogIndexCard(indexCard);

  return {
    drained: true,
    index_card_id: indexCardId,
    index_card_hash: indexHash,
    chunk_card_ids: chunkCardIds,
    chunk_count: totalChunks,
  };
}
