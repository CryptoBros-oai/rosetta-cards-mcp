/**
 * Deterministic search scoring module.
 *
 * Fixed-weight constants — no ML, no randomness, no insertion-order dependence.
 * Stable tiebreak: artifact_id (lexicographic) then title (lexicographic).
 */

import type { VaultContext } from './schema.js';

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------
export const SCORE_PINNED = 500;
export const SCORE_EXACT_TITLE = 100;
export const SCORE_TITLE_TOKEN = 40;
export const SCORE_TITLE_TOKEN_CAP = 120;
export const SCORE_TAG_MATCH = 25;
export const SCORE_TAG_MATCH_CAP = 100;
export const SCORE_PACK_TAG = 10;
export const SCORE_PACK_TAG_CAP = 50;
export const SCORE_TEXT_SUBSTRING = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal artifact shape accepted by the scorer. */
export type ScoredArtifact = {
  artifact_id: string;
  title: string;
  tags: string[];
  hash?: string;
  /** Optional full searchable text (title + bullets + tags already concatenated). */
  text?: string;
};

export type RankedResult<T extends ScoredArtifact = ScoredArtifact> = T & {
  score: number;
  pinned: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 1);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score a single artifact against a query in the given vault context.
 */
export function scoreArtifact(
  query: string,
  artifact: ScoredArtifact,
  ctx: VaultContext
): { score: number; pinned: boolean } {
  const queryLower = query.toLowerCase();
  const queryTokens = tokenize(query);
  let score = 0;

  // --- Pinned boost (dominates ordering) ---
  const pinSet = new Set(ctx.pinHashes);
  const pinned = artifact.hash ? pinSet.has(artifact.hash) : false;
  if (pinned) {
    score += SCORE_PINNED;
  }

  // --- Exact title match (case-insensitive) ---
  if (artifact.title.toLowerCase() === queryLower) {
    score += SCORE_EXACT_TITLE;
  }

  // --- Title token matches (+40 each, cap +120) ---
  const titleLower = artifact.title.toLowerCase();
  let titleTokenScore = 0;
  for (const token of queryTokens) {
    if (titleLower.includes(token)) {
      titleTokenScore += SCORE_TITLE_TOKEN;
      if (titleTokenScore >= SCORE_TITLE_TOKEN_CAP) {
        titleTokenScore = SCORE_TITLE_TOKEN_CAP;
        break;
      }
    }
  }
  score += titleTokenScore;

  // --- Tag exact matches (+25 each, cap +100) ---
  const artifactTagsLower = artifact.tags.map(t => t.toLowerCase());
  let tagScore = 0;
  for (const token of queryTokens) {
    if (artifactTagsLower.includes(token)) {
      tagScore += SCORE_TAG_MATCH;
      if (tagScore >= SCORE_TAG_MATCH_CAP) {
        tagScore = SCORE_TAG_MATCH_CAP;
        break;
      }
    }
  }
  score += tagScore;

  // --- Pack allowed_tags matches artifact tags (+10 each, cap +50) ---
  const packTags = ctx.policies.allowed_tags ?? [];
  let packTagScore = 0;
  for (const pt of packTags) {
    if (artifact.tags.includes(pt)) {
      packTagScore += SCORE_PACK_TAG;
      if (packTagScore >= SCORE_PACK_TAG_CAP) {
        packTagScore = SCORE_PACK_TAG_CAP;
        break;
      }
    }
  }
  score += packTagScore;

  // --- Text contains query substring (case-insensitive) ---
  const searchText = artifact.text ?? artifact.title;
  if (searchText.toLowerCase().includes(queryLower)) {
    score += SCORE_TEXT_SUBSTRING;
  }

  return { score, pinned };
}

/**
 * Rank artifacts by deterministic score, descending.
 * Stable tiebreak: artifact_id lexicographic, then title lexicographic.
 */
export function rankArtifacts<T extends ScoredArtifact>(
  query: string,
  artifacts: T[],
  ctx: VaultContext
): RankedResult<T>[] {
  const scored = artifacts.map(a => {
    const { score, pinned } = scoreArtifact(query, a, ctx);
    return { ...a, score, pinned };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const idCmp = a.artifact_id.localeCompare(b.artifact_id);
    if (idCmp !== 0) return idCmp;
    return a.title.localeCompare(b.title);
  });

  return scored;
}
