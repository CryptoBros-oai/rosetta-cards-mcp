/**
 * VM Novelty Ranking — pairwise cosine distance between scan signatures.
 *
 * Converts ScanSignature to a fixed-length numeric vector, computes
 * pairwise cosine distance, ranks by mean distance (novelty).
 * Deterministic, no NaN.
 */

import type { ScanSignature } from "./vm_scan_signature.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoveltyScore = {
  scan_id: string;
  program_id: string;
  novelty: number;           // mean cosine distance to all others
  max_distance: number;
  nearest_distance: number;
  nearest_scan_id: string;
};

export type TopNovelScansResult = {
  schema_version: "top_novel_scans.v1";
  scans: NoveltyScore[];
  total: number;
};

// ---------------------------------------------------------------------------
// Cosine similarity (array-based)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two numeric arrays.
 * Returns 0 for zero-length, mismatched-length, or all-zero vectors.
 * Never returns NaN.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ---------------------------------------------------------------------------
// Signature vectorization
// ---------------------------------------------------------------------------

/**
 * Convert a ScanSignature to a fixed-length numeric vector.
 *
 * The vector has three sections:
 * 1. Scalar features (12 dimensions): counts + regime + transition_stats
 * 2. Opcode weights (one slot per vocab entry, 0 if absent)
 * 3. Metric weights (one slot per vocab entry, 0 if absent)
 *
 * The vocabulary arrays must be shared across all signatures in a batch.
 */
export function signatureToVector(
  sig: ScanSignature,
  opcodeVocab: string[],
  metricVocab: string[],
): number[] {
  const vec: number[] = [];

  // Section 1: scalar features
  vec.push(sig.counts.grid_points);
  vec.push(sig.counts.phase_hints);
  vec.push(sig.counts.dossier_entries);
  vec.push(sig.counts.adaptive_refinements ?? 0);
  vec.push(sig.regime.halted);
  vec.push(sig.regime.completed);
  vec.push(sig.regime.halt_fraction);
  vec.push(sig.transition_stats.transition_density);
  vec.push(sig.transition_stats.avg_delta_magnitude);
  vec.push(sig.transition_stats.max_delta_magnitude);
  vec.push(sig.transition_stats.opcode_delta_concentration);
  vec.push(sig.transition_stats.metric_cliff_score);

  // Section 2: opcode weights
  const opcodeMap = new Map(sig.opcode_signature.map((o) => [o.opcode, o.weight]));
  for (const name of opcodeVocab) {
    vec.push(opcodeMap.get(name) ?? 0);
  }

  // Section 3: metric weights
  const metricMap = new Map(sig.metrics_signature.map((m) => [m.metric, m.weight]));
  for (const name of metricVocab) {
    vec.push(metricMap.get(name) ?? 0);
  }

  return vec;
}

// ---------------------------------------------------------------------------
// Vocabulary builder
// ---------------------------------------------------------------------------

/**
 * Build shared vocabulary from a set of signatures.
 * Returns sorted unique opcode and metric names.
 */
export function buildVocabulary(signatures: ScanSignature[]): {
  opcodeVocab: string[];
  metricVocab: string[];
} {
  const opcodes = new Set<string>();
  const metrics = new Set<string>();

  for (const sig of signatures) {
    for (const o of sig.opcode_signature) opcodes.add(o.opcode);
    for (const m of sig.metrics_signature) metrics.add(m.metric);
  }

  return {
    opcodeVocab: [...opcodes].sort(),
    metricVocab: [...metrics].sort(),
  };
}

// ---------------------------------------------------------------------------
// Novelty scoring
// ---------------------------------------------------------------------------

/**
 * Compute novelty scores for a set of scan signatures.
 *
 * Novelty = mean cosine distance to all other signatures.
 * Single signature → novelty 0. Two identical → novelty 0.
 * All values rounded to 4 decimal places. No NaN.
 */
export function computeNoveltyScores(
  signatures: ScanSignature[],
  limit: number = 50,
): TopNovelScansResult {
  if (signatures.length === 0) {
    return { schema_version: "top_novel_scans.v1", scans: [], total: 0 };
  }

  if (signatures.length === 1) {
    return {
      schema_version: "top_novel_scans.v1",
      scans: [{
        scan_id: signatures[0].scan_id,
        program_id: signatures[0].program_id,
        novelty: 0,
        max_distance: 0,
        nearest_distance: 0,
        nearest_scan_id: signatures[0].scan_id,
      }],
      total: 1,
    };
  }

  // Build shared vocabulary and vectorize
  const { opcodeVocab, metricVocab } = buildVocabulary(signatures);
  const vectors = signatures.map((sig) => signatureToVector(sig, opcodeVocab, metricVocab));

  // Compute pairwise distances
  const n = signatures.length;
  const scores: NoveltyScore[] = [];

  for (let i = 0; i < n; i++) {
    let totalDist = 0;
    let maxDist = 0;
    let minDist = Infinity;
    let nearestIdx = i;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      const dist = 1 - sim;

      totalDist += dist;
      if (dist > maxDist) maxDist = dist;
      if (dist < minDist) {
        minDist = dist;
        nearestIdx = j;
      }
    }

    const novelty = totalDist / (n - 1);

    // Handle edge case: if minDist never updated (shouldn't happen with n>=2)
    if (minDist === Infinity) minDist = 0;

    scores.push({
      scan_id: signatures[i].scan_id,
      program_id: signatures[i].program_id,
      novelty: round4(novelty),
      max_distance: round4(maxDist),
      nearest_distance: round4(minDist),
      nearest_scan_id: signatures[nearestIdx].scan_id,
    });
  }

  // Sort: novelty descending, scan_id ascending for tiebreak
  scores.sort((a, b) => {
    if (b.novelty !== a.novelty) return b.novelty - a.novelty;
    return a.scan_id.localeCompare(b.scan_id);
  });

  return {
    schema_version: "top_novel_scans.v1",
    scans: scores.slice(0, limit),
    total: scores.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
