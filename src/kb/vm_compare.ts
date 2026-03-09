/**
 * VM Compare — multi-mode comparison of two VM run results.
 *
 * Alignment modes:
 *   "step"              — positional alignment (default, backward compatible)
 *   "opcode_signature"  — LCS alignment on opcode_id sequences
 *   "milestone"         — anchor on milestone opcodes, zip between anchors
 *
 * Produces structured deltas for scalars, verb distribution, bag values,
 * opcode frequency, and per-step bag state alignment.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash, canonicalize } from "./canonical.js";
import type { VmResult, VmVerb, TraceStep } from "./vm_types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlignMode = "step" | "opcode_signature" | "milestone";

export type ScalarDelta = { a: number; b: number; delta: number };
export type VerbDelta = { verb: string; a: number; b: number; delta: number };
export type OpcodeDelta = { opcode_id: string; a: number; b: number; delta: number };

export type BagDelta = {
  bag: string;
  a: number | null;
  b: number | null;
  delta: number | null;
  missing?: boolean;
};

export type StepDelta = {
  step: number;
  a_index?: number | null;
  b_index?: number | null;
  a_bags: Record<string, number> | null;
  b_bags: Record<string, number> | null;
  bag_deltas: BagDelta[];
  missing?: boolean;
};

export type CompareSummary = {
  most_changed_bags: string[];
  most_shifted_verbs: string[];
  a_halted: boolean;
  b_halted: boolean;
};

export type CompareResult = {
  schema_version: "compare.v1";
  a_run_hash?: string;
  b_run_hash?: string;
  align_mode?: AlignMode;
  scalars: {
    total_steps: ScalarDelta;
    final_bag_sum: ScalarDelta;
  };
  verb_distribution: VerbDelta[];
  bag_variance: BagDelta[];
  opcode_frequency: OpcodeDelta[];
  step_deltas: StepDelta[];
  summary: CompareSummary;
  compare_hash: string;
};

export type CompareOptions = {
  a_run_hash?: string;
  b_run_hash?: string;
  align?: AlignMode;
  milestones?: { opcode_ids: string[] };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_VERBS: VmVerb[] = ["Attract", "Contain", "Release", "Repel", "Transform"];

export const DEFAULT_MILESTONES: string[] = [
  "contain.threshold",
  "contain.commit_to_stack",
  "release.finalize",
  "repel.guard",
];

// ---------------------------------------------------------------------------
// Core LCS — O(n*m) DP producing matched index pairs
// ---------------------------------------------------------------------------

/**
 * Standard LCS on string arrays. Returns matched index pairs (ascending).
 * Tie-breaking: prefer advancing `a` (deterministic).
 */
export function lcsMatches(
  a_ids: string[],
  b_ids: string[],
): Array<[number, number]> {
  const n = a_ids.length;
  const m = b_ids.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a_ids[i - 1] === b_ids[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack — tie-break: prefer advancing a (go up when equal)
  const matches: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a_ids[i - 1] === b_ids[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  matches.reverse();
  return matches;
}

// ---------------------------------------------------------------------------
// Opcode-signature alignment (LCS on full opcode_id sequence)
// ---------------------------------------------------------------------------

export function lcsOpcodeAlignment(
  a_trace: TraceStep[],
  b_trace: TraceStep[],
): Array<[number | null, number | null]> {
  const a_ids = a_trace.map((s) => s.opcode_id);
  const b_ids = b_trace.map((s) => s.opcode_id);
  const matches = lcsMatches(a_ids, b_ids);

  const pairs: Array<[number | null, number | null]> = [];
  let ai = 0;
  let bi = 0;

  for (const [ma, mb] of matches) {
    while (ai < ma) {
      pairs.push([ai, null]);
      ai++;
    }
    while (bi < mb) {
      pairs.push([null, bi]);
      bi++;
    }
    pairs.push([ai, bi]);
    ai++;
    bi++;
  }
  while (ai < a_trace.length) {
    pairs.push([ai, null]);
    ai++;
  }
  while (bi < b_trace.length) {
    pairs.push([null, bi]);
    bi++;
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Milestone alignment
// ---------------------------------------------------------------------------

export function milestoneAlignment(
  a_trace: TraceStep[],
  b_trace: TraceStep[],
  milestoneOpcodes?: string[],
): Array<[number | null, number | null]> {
  const msSet = new Set(milestoneOpcodes ?? DEFAULT_MILESTONES);

  // Extract milestone positions
  const a_ms: { idx: number; id: string }[] = [];
  const b_ms: { idx: number; id: string }[] = [];
  for (let i = 0; i < a_trace.length; i++) {
    if (msSet.has(a_trace[i].opcode_id)) a_ms.push({ idx: i, id: a_trace[i].opcode_id });
  }
  for (let i = 0; i < b_trace.length; i++) {
    if (msSet.has(b_trace[i].opcode_id)) b_ms.push({ idx: i, id: b_trace[i].opcode_id });
  }

  // LCS on milestone opcode_ids → anchor pairs in trace-index space
  const msMatches = lcsMatches(
    a_ms.map((m) => m.id),
    b_ms.map((m) => m.id),
  );
  const anchors: Array<[number, number]> = msMatches.map(
    ([mi, mj]) => [a_ms[mi].idx, b_ms[mj].idx],
  );

  // Build alignment: zip non-anchor steps between consecutive anchors
  const pairs: Array<[number | null, number | null]> = [];
  let prevA = -1;
  let prevB = -1;

  for (const [ancA, ancB] of anchors) {
    zipRange(pairs, prevA + 1, ancA, prevB + 1, ancB);
    pairs.push([ancA, ancB]);
    prevA = ancA;
    prevB = ancB;
  }
  // Remaining steps after last anchor
  zipRange(pairs, prevA + 1, a_trace.length, prevB + 1, b_trace.length);

  return pairs;
}

function zipRange(
  out: Array<[number | null, number | null]>,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): void {
  const aLen = aEnd - aStart;
  const bLen = bEnd - bStart;
  const min = Math.min(aLen, bLen);
  for (let i = 0; i < min; i++) out.push([aStart + i, bStart + i]);
  for (let i = min; i < aLen; i++) out.push([aStart + i, null]);
  for (let i = min; i < bLen; i++) out.push([null, bStart + i]);
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/**
 * Compare two VmResults using the specified alignment mode.
 * Deterministic and synchronous.
 */
export function compareRuns(
  a: VmResult,
  b: VmResult,
  opts?: CompareOptions,
): CompareResult {
  const align: AlignMode = opts?.align ?? "step";

  // Scalar deltas (alignment-independent)
  const scalars = {
    total_steps: makeDelta(a.metrics.total_steps, b.metrics.total_steps),
    final_bag_sum: makeDelta(a.metrics.final_bag_sum, b.metrics.final_bag_sum),
  };

  // Verb distribution (all 5 verbs, alignment-independent)
  const verb_distribution: VerbDelta[] = ALL_VERBS.map((verb) => ({
    verb,
    a: a.metrics.verb_distribution[verb] ?? 0,
    b: b.metrics.verb_distribution[verb] ?? 0,
    delta: (b.metrics.verb_distribution[verb] ?? 0) - (a.metrics.verb_distribution[verb] ?? 0),
  }));

  // Bag variance (alignment-independent)
  const allBagKeys = new Set([
    ...Object.keys(a.metrics.bag_variance),
    ...Object.keys(b.metrics.bag_variance),
  ]);
  const bag_variance: BagDelta[] = [...allBagKeys].sort().map((bag) => ({
    bag,
    a: a.metrics.bag_variance[bag] ?? 0,
    b: b.metrics.bag_variance[bag] ?? 0,
    delta: (b.metrics.bag_variance[bag] ?? 0) - (a.metrics.bag_variance[bag] ?? 0),
  }));

  // Opcode frequency (alignment-independent)
  const allOpcodes = new Set([
    ...Object.keys(a.metrics.opcode_frequency),
    ...Object.keys(b.metrics.opcode_frequency),
  ]);
  const opcode_frequency: OpcodeDelta[] = [...allOpcodes].sort().map((opcode_id) => ({
    opcode_id,
    a: a.metrics.opcode_frequency[opcode_id] ?? 0,
    b: b.metrics.opcode_frequency[opcode_id] ?? 0,
    delta: (b.metrics.opcode_frequency[opcode_id] ?? 0) - (a.metrics.opcode_frequency[opcode_id] ?? 0),
  }));

  // Step deltas (alignment-dependent)
  let step_deltas: StepDelta[];
  if (align === "step") {
    step_deltas = buildStepAlignedDeltas(a, b);
  } else if (align === "opcode_signature") {
    const alignment = lcsOpcodeAlignment(a.trace, b.trace);
    step_deltas = buildNonStepDeltas(a, b, alignment);
  } else {
    const alignment = milestoneAlignment(a.trace, b.trace, opts?.milestones?.opcode_ids);
    step_deltas = buildNonStepDeltas(a, b, alignment);
  }

  // Summary
  const changedBags = bag_variance
    .filter((bv) => bv.delta !== 0)
    .sort((x, y) => Math.abs(y.delta!) - Math.abs(x.delta!))
    .map((bv) => bv.bag);

  const shiftedVerbs = verb_distribution
    .filter((vd) => vd.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .map((vd) => vd.verb);

  const summary: CompareSummary = {
    most_changed_bags: changedBags,
    most_shifted_verbs: shiftedVerbs,
    a_halted: a.metrics.halted_early,
    b_halted: b.metrics.halted_early,
  };

  // Build result — conditionally include optional fields to avoid undefined keys
  const result: CompareResult = {
    schema_version: "compare.v1",
    scalars,
    verb_distribution,
    bag_variance,
    opcode_frequency,
    step_deltas,
    summary,
    compare_hash: "",
  };
  if (opts?.a_run_hash !== undefined) {
    result.a_run_hash = opts.a_run_hash;
  }
  if (opts?.b_run_hash !== undefined) {
    result.b_run_hash = opts.b_run_hash;
  }
  if (align !== "step") {
    result.align_mode = align;
  }

  // Compute hash of everything except compare_hash itself
  const { compare_hash: _, ...hashInput } = result;
  result.compare_hash = canonicalHash(
    hashInput as unknown as Record<string, unknown>,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Step-aligned delta builder (preserves exact Sprint 2 behavior)
// ---------------------------------------------------------------------------

function buildStepAlignedDeltas(a: VmResult, b: VmResult): StepDelta[] {
  const maxSteps = Math.max(a.trace.length, b.trace.length);
  const deltas: StepDelta[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const a_bags = i < a.trace.length ? a.trace[i].state_after.bags : null;
    const b_bags = i < b.trace.length ? b.trace[i].state_after.bags : null;

    const stepBagKeys = new Set([
      ...(a_bags ? Object.keys(a_bags) : []),
      ...(b_bags ? Object.keys(b_bags) : []),
    ]);
    const bag_deltas: BagDelta[] = [...stepBagKeys].sort().map((bag) => ({
      bag,
      a: a_bags?.[bag] ?? 0,
      b: b_bags?.[bag] ?? 0,
      delta: (b_bags?.[bag] ?? 0) - (a_bags?.[bag] ?? 0),
    }));

    deltas.push({ step: i, a_bags, b_bags, bag_deltas });
  }

  return deltas;
}

// ---------------------------------------------------------------------------
// Non-step delta builder (for LCS / milestone modes — nullable, missing flags)
// ---------------------------------------------------------------------------

function buildNonStepDeltas(
  a: VmResult,
  b: VmResult,
  alignment: Array<[number | null, number | null]>,
): StepDelta[] {
  return alignment.map(([ai, bi], step) => {
    const a_bags = ai !== null ? a.trace[ai].state_after.bags : null;
    const b_bags = bi !== null ? b.trace[bi].state_after.bags : null;
    const isMissing = ai === null || bi === null;

    const stepBagKeys = new Set([
      ...(a_bags ? Object.keys(a_bags) : []),
      ...(b_bags ? Object.keys(b_bags) : []),
    ]);
    const bag_deltas: BagDelta[] = [...stepBagKeys].sort().map((bag) => {
      const aVal = a_bags?.[bag] ?? null;
      const bVal = b_bags?.[bag] ?? null;
      const delta = aVal !== null && bVal !== null ? bVal - aVal : null;
      const bd: BagDelta = { bag, a: aVal, b: bVal, delta };
      if (isMissing) bd.missing = true;
      return bd;
    });

    const sd: StepDelta = {
      step,
      a_index: ai,
      b_index: bi,
      a_bags,
      b_bags,
      bag_deltas,
    };
    if (isMissing) sd.missing = true;
    return sd;
  });
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

const COMPARISONS_DIR = join("data", "runs", "_comparisons");

export function persistCompare(result: CompareResult): string {
  mkdirSync(COMPARISONS_DIR, { recursive: true });
  const filename = `compare_${result.compare_hash.slice(0, 12)}.json`;
  const filepath = join(COMPARISONS_DIR, filename);
  writeFileSync(
    filepath,
    canonicalize(result as unknown as Record<string, unknown>) + "\n",
  );
  return filepath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDelta(a: number, b: number): ScalarDelta {
  return { a, b, delta: b - a };
}
