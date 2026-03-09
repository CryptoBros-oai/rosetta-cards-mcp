/**
 * VM Scan Ranking — deterministic interestingness scoring + leaderboards.
 *
 * Fixed-weight constants — no ML, no randomness, no insertion-order dependence.
 * Stable tiebreak: scan_id lexicographic.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ScanSignature } from "./vm_scan_signature.js";
import type { TransitionDossierEntry } from "./vm_types.js";

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

export const W_TRANSITION_DENSITY = 100;
export const W_METRIC_CLIFF = 50;
export const W_MAX_DELTA = 30;
export const W_OPCODE_CONCENTRATION = 20;
export const W_NOISE_PENALTY = -15;
export const W_ADAPTIVE_BONUS = 10;

// Transition-level weights
export const W_SCALAR_SUM = 1;
export const W_CLIFF_BONUS = 50;
export const W_OPCODE_GATING = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScoredScan = {
  scan_id: string;
  program_id: string;
  score: number;
  breakdown: {
    density: number;
    cliff: number;
    max_delta: number;
    concentration: number;
    noise: number;
    adaptive: number;
  };
};

export type ScoredTransition = {
  scan_id: string;
  candidate_id: string;
  score: number;
  hint_type: string;
};

export type TopScansResult = {
  schema_version: "top_scans.v1";
  scans: ScoredScan[];
  total: number;
};

export type TopTransitionsResult = {
  schema_version: "top_transitions.v1";
  transitions: ScoredTransition[];
  total: number;
};

// ---------------------------------------------------------------------------
// Scan scoring
// ---------------------------------------------------------------------------

/**
 * Score a single scan signature for interestingness.
 * Higher = more interesting. Control scans score 0.
 */
export function scoreScan(sig: ScanSignature): ScoredScan {
  const ts = sig.transition_stats;
  const gridPoints = sig.counts.grid_points;

  const density = ts.transition_density * W_TRANSITION_DENSITY;
  const cliff = ts.metric_cliff_score * W_METRIC_CLIFF;
  const maxDelta = Math.log1p(ts.max_delta_magnitude) * W_MAX_DELTA;
  const concentration = ts.opcode_delta_concentration * W_OPCODE_CONCENTRATION;

  // Noise penalty: penalize if hints >> expected from density
  const expectedHints = gridPoints * ts.transition_density;
  const excessHints = Math.max(0, sig.counts.phase_hints - 5 * expectedHints);
  const noise =
    gridPoints > 0
      ? W_NOISE_PENALTY * (excessHints / gridPoints)
      : 0;

  const adaptive =
    sig.counts.adaptive_refinements !== null && sig.counts.adaptive_refinements > 0
      ? W_ADAPTIVE_BONUS
      : 0;

  const score = Math.round((density + cliff + maxDelta + concentration + noise + adaptive) * 10000) / 10000;

  return {
    scan_id: sig.scan_id,
    program_id: sig.program_id,
    score,
    breakdown: {
      density: Math.round(density * 10000) / 10000,
      cliff: Math.round(cliff * 10000) / 10000,
      max_delta: Math.round(maxDelta * 10000) / 10000,
      concentration: Math.round(concentration * 10000) / 10000,
      noise: Math.round(noise * 10000) / 10000,
      adaptive,
    },
  };
}

// ---------------------------------------------------------------------------
// Transition scoring
// ---------------------------------------------------------------------------

/**
 * Score a single transition entry for interestingness.
 * Higher = more interesting.
 */
export function scoreTransition(
  entry: TransitionDossierEntry,
  meanBagSum: number,
): ScoredTransition {
  const scalarSum = entry.summary.top_scalar_deltas.reduce(
    (s, d) => s + Math.abs(d.delta),
    0,
  );
  const opcodeGating = entry.summary.top_opcode_deltas.length * W_OPCODE_GATING;

  // Cliff bonus: if max scalar delta exceeds 50% of mean bag sum
  const maxScalar =
    entry.summary.top_scalar_deltas.length > 0
      ? Math.max(...entry.summary.top_scalar_deltas.map((d) => Math.abs(d.delta)))
      : 0;
  const normMean = Math.max(Math.abs(meanBagSum), 1);
  const cliffBonus = maxScalar / normMean > 0.5 ? W_CLIFF_BONUS : 0;

  const score = Math.round((scalarSum * W_SCALAR_SUM + opcodeGating + cliffBonus) * 10000) / 10000;

  return {
    scan_id: entry.meta.schema_version === "transition_dossier.v1"
      ? entry.compare_hash.slice(0, 12) // fallback
      : "",
    candidate_id: entry.candidate_id,
    score,
    hint_type: entry.hint_type,
  };
}

// ---------------------------------------------------------------------------
// Leaderboard builders
// ---------------------------------------------------------------------------

/**
 * Build top scans leaderboard from signatures.
 * Sorted by score descending, ties broken by scan_id ascending.
 */
export function buildTopScans(
  signatures: ScanSignature[],
  limit: number = 50,
): TopScansResult {
  const scored = signatures.map((sig) => scoreScan(sig));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.scan_id.localeCompare(b.scan_id);
  });

  return {
    schema_version: "top_scans.v1",
    scans: scored.slice(0, limit),
    total: scored.length,
  };
}

/**
 * Build top transitions leaderboard.
 * Sorted by score descending, ties by candidate_id ascending.
 */
export function buildTopTransitions(
  entries: Array<{ entry: TransitionDossierEntry; scan_id: string; meanBagSum: number }>,
  limit: number = 200,
): TopTransitionsResult {
  const scored = entries.map(({ entry, scan_id, meanBagSum }) => {
    const result = scoreTransition(entry, meanBagSum);
    result.scan_id = scan_id;
    return result;
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const scanCmp = a.scan_id.localeCompare(b.scan_id);
    if (scanCmp !== 0) return scanCmp;
    return a.candidate_id.localeCompare(b.candidate_id);
  });

  return {
    schema_version: "top_transitions.v1",
    transitions: scored.slice(0, limit),
    total: scored.length,
  };
}

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

/**
 * Write leaderboard files to the given directory.
 */
export function writeLeaderboards(
  outDir: string,
  topScans: TopScansResult,
  topTransitions: TopTransitionsResult,
): void {
  writeFileSync(
    join(outDir, "TOP_SCANS.json"),
    JSON.stringify(topScans, null, 2) + "\n",
  );

  writeFileSync(
    join(outDir, "TOP_TRANSITIONS.json"),
    JSON.stringify(topTransitions, null, 2) + "\n",
  );

  // Markdown summary
  const lines: string[] = [
    "# Top Scans Leaderboard",
    "",
    `Total: ${topScans.total} scans scored`,
    "",
    "| Rank | Scan ID | Program | Score | Density | Cliff | Max Δ | Conc | Noise | Adaptive |",
    "|------|---------|---------|-------|---------|-------|-------|------|-------|----------|",
  ];

  for (let i = 0; i < topScans.scans.length; i++) {
    const s = topScans.scans[i];
    const b = s.breakdown;
    lines.push(
      `| ${i + 1} | \`${s.scan_id.slice(0, 12)}\` | ${s.program_id} | ${s.score} | ${b.density} | ${b.cliff} | ${b.max_delta} | ${b.concentration} | ${b.noise} | ${b.adaptive} |`,
    );
  }

  lines.push("");
  writeFileSync(join(outDir, "TOP_SCANS.md"), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Signature loader (from disk)
// ---------------------------------------------------------------------------

/**
 * Load a scan signature from a scan directory.
 * Returns null if not found.
 */
export function loadSignature(scanDir: string): ScanSignature | null {
  const sigPath = join(scanDir, "SCAN_SIGNATURE.json");
  if (!existsSync(sigPath)) return null;
  return JSON.parse(readFileSync(sigPath, "utf-8"));
}
