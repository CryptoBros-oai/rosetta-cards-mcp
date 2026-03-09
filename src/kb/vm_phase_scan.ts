/**
 * VM Phase Scan — cartesian grid over env knobs, execute all points,
 * detect phase transitions via hints. Supports both grid and adaptive modes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash, canonicalize } from "./canonical.js";
import { execute } from "./vm_engine.js";
import { computeProgramFingerprint } from "./vm_run_store.js";
import { compareRuns } from "./vm_compare.js";
import { appendToScanIndex } from "./vm_scan_index.js";
import { buildScanSignature } from "./vm_scan_signature.js";
import type { CompareResult } from "./vm_compare.js";
import type {
  VmProgram,
  VmState,
  VmEnv,
  VmResult,
  VmMetrics,
  TransitionDossier,
  TransitionDossierEntry,
} from "./vm_types.js";
import type { ExecuteOptions } from "./vm_engine.js";
import { classifyRegime, REGIME_CLASS_INDEX } from "./vm_regime.js";
import { scanPhasesBoundaryHunt } from "./vm_boundary_hunt.js";
import type { BoundaryHuntOptions, BoundaryHuntResult } from "./vm_boundary_hunt.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KnobValue = number | string | boolean;

export type Knob = {
  key: string;
  values: KnobValue[];
};

export type ScanMode = "grid" | "adaptive" | "hunt_boundaries";

export type AdaptiveOptions = {
  max_refinements?: number;
  max_total_runs?: number;
};

export type ScanDefinition = {
  program: VmProgram;
  state0: VmState;
  base_env: VmEnv;
  knobs: Knob[];
  include_trace?: boolean;
  options?: ExecuteOptions;
  scan_mode?: ScanMode;
  adaptive?: AdaptiveOptions;
  boundary_hunt?: BoundaryHuntOptions;
};

export type GridPointSummary = {
  index: number;
  knob_values: Record<string, KnobValue>;
  metrics: VmMetrics;
  final_state_hash: string;
  trace?: VmResult["trace"];
};

export type PhaseScanIndex = {
  schema_version: "phase_scan.v1";
  scan_hash: string;
  program_id: string;
  program_fingerprint: string;
  knobs: Knob[];
  grid_size: number;
  points: GridPointSummary[];
};

export type PhaseHintKind = "zero_crossing" | "sign_change" | "threshold_crossing" | "regime_transition";

export type PhaseHint = {
  kind: PhaseHintKind;
  between: [number, number]; // [index_a, index_b]
  metric: string;
  a_value: number;
  b_value: number;
  detail: string;
};

export type PhaseHints = {
  schema_version: "phase_hints.v1";
  scan_hash: string;
  hints: PhaseHint[];
};

export type RefinementRound = {
  round: number;
  new_points: GridPointSummary[];
  new_hints: PhaseHint[];
};

export type AdaptiveScanResult = {
  refinements: RefinementRound[];
  all_points: GridPointSummary[];
  all_hints: PhaseHint[];
  refined_dossier: TransitionDossier;
};

export type PhaseScanResult = {
  scan_index: PhaseScanIndex;
  phase_hints: PhaseHints;
  transition_dossier: CompareResult[];
  formalized_dossier: TransitionDossier;
  adaptive?: AdaptiveScanResult;
  boundary_hunt?: BoundaryHuntResult;
};

// ---------------------------------------------------------------------------
// Cartesian product (deterministic)
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic cartesian product of knob values.
 * Knobs are sorted by key (lexicographic), last knob varies fastest.
 */
export function cartesianProduct(
  knobs: Knob[],
): Record<string, KnobValue>[] {
  const sorted = [...knobs].sort((a, b) => a.key.localeCompare(b.key));
  if (sorted.length === 0) return [{}];

  const result: Record<string, KnobValue>[] = [];
  const indices = new Array(sorted.length).fill(0);
  const sizes = sorted.map((k) => k.values.length);

  // Guard against empty knob values
  if (sizes.some((s) => s === 0)) return [];

  const totalPoints = sizes.reduce((a, b) => a * b, 1);

  for (let p = 0; p < totalPoints; p++) {
    const point: Record<string, KnobValue> = {};
    for (let k = 0; k < sorted.length; k++) {
      point[sorted[k].key] = sorted[k].values[indices[k]];
    }
    result.push(point);

    // Odometer increment (last varies fastest)
    for (let k = sorted.length - 1; k >= 0; k--) {
      indices[k]++;
      if (indices[k] < sizes[k]) break;
      indices[k] = 0;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Knob application
// ---------------------------------------------------------------------------

/** Direct env keys that knobs can override */
const DIRECT_ENV_KEYS = new Set(["run_seed", "world_seed", "max_steps"]);

/**
 * Apply knob values to a base env, producing a new VmEnv.
 * run_seed, world_seed, max_steps are applied directly; all others go to env.params.
 */
export function applyKnobs(
  baseEnv: VmEnv,
  knobValues: Record<string, KnobValue>,
): VmEnv {
  const env: VmEnv = {
    ...baseEnv,
    params: { ...(baseEnv.params ?? {}) },
  };

  for (const [key, value] of Object.entries(knobValues)) {
    if (DIRECT_ENV_KEYS.has(key)) {
      (env as any)[key] = value;
    } else {
      env.params![key] = value;
    }
  }

  return env;
}

// ---------------------------------------------------------------------------
// Phase hint detection
// ---------------------------------------------------------------------------

/**
 * Detect phase hints between adjacent grid points.
 */
export function detectPhaseHints(
  points: GridPointSummary[],
): PhaseHint[] {
  const hints: PhaseHint[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];

    // Check scalar metrics
    checkScalarHints(hints, i, a.metrics, b.metrics, "final_bag_sum",
      a.metrics.final_bag_sum, b.metrics.final_bag_sum);
    checkScalarHints(hints, i, a.metrics, b.metrics, "total_steps",
      a.metrics.total_steps, b.metrics.total_steps);

    // Check halted_early sign change
    if (a.metrics.halted_early !== b.metrics.halted_early) {
      hints.push({
        kind: "sign_change",
        between: [i, i + 1],
        metric: "halted_early",
        a_value: a.metrics.halted_early ? 1 : 0,
        b_value: b.metrics.halted_early ? 1 : 0,
        detail: `halted_early flipped from ${a.metrics.halted_early} to ${b.metrics.halted_early}`,
      });
    }

    // Check regime class transition
    const regimeA = classifyRegime(a.metrics);
    const regimeB = classifyRegime(b.metrics);
    if (regimeA !== regimeB) {
      hints.push({
        kind: "regime_transition",
        between: [i, i + 1],
        metric: "regime_class",
        a_value: REGIME_CLASS_INDEX[regimeA] ?? 8,
        b_value: REGIME_CLASS_INDEX[regimeB] ?? 8,
        detail: `regime: ${regimeA} → ${regimeB}`,
      });
    }
  }

  return hints;
}

function checkScalarHints(
  hints: PhaseHint[],
  idx: number,
  _aMetrics: VmMetrics,
  _bMetrics: VmMetrics,
  metricName: string,
  aVal: number,
  bVal: number,
): void {
  // Zero crossing
  if ((aVal > 0 && bVal < 0) || (aVal < 0 && bVal > 0)) {
    hints.push({
      kind: "zero_crossing",
      between: [idx, idx + 1],
      metric: metricName,
      a_value: aVal,
      b_value: bVal,
      detail: `${metricName} crosses zero: ${aVal} → ${bVal}`,
    });
  }

  // Threshold crossing (>50% shift)
  if (aVal !== 0) {
    const ratio = Math.abs(bVal - aVal) / Math.abs(aVal);
    if (ratio > 0.5) {
      hints.push({
        kind: "threshold_crossing",
        between: [idx, idx + 1],
        metric: metricName,
        a_value: aVal,
        b_value: bVal,
        detail: `${metricName} shifted ${Math.round(ratio * 100)}%: ${aVal} → ${bVal}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Refinability + Bisection (for adaptive mode)
// ---------------------------------------------------------------------------

/**
 * A knob is refinable if all values are numbers AND at least one is non-integer.
 * Integer-only knobs are treated as discrete and not bisected.
 */
export function isRefinableKnob(knob: Knob): boolean {
  if (!knob.values.every((v) => typeof v === "number")) return false;
  return knob.values.some((v) => !Number.isInteger(v as number));
}

/**
 * Bisect knob values between two grid points.
 * Refinable (float) knobs get arithmetic midpoint; discrete knobs keep A's value.
 */
export function bisectKnobs(
  a_knobs: Record<string, KnobValue>,
  b_knobs: Record<string, KnobValue>,
  refinableKeys: Set<string>,
): Record<string, KnobValue> {
  const result: Record<string, KnobValue> = {};
  for (const key of Object.keys(a_knobs).sort()) {
    if (refinableKeys.has(key)) {
      result[key] = ((a_knobs[key] as number) + (b_knobs[key] as number)) / 2;
    } else {
      result[key] = a_knobs[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal: execute a grid of points
// ---------------------------------------------------------------------------

export type ExecutedGrid = {
  points: GridPointSummary[];
  results: VmResult[];
  scan_hash: string;
  program_id: string;
  program_fingerprint: string;
};

export function executeGrid(definition: ScanDefinition): ExecutedGrid {
  const {
    program,
    state0,
    base_env,
    knobs,
    include_trace = false,
    options,
  } = definition;

  const grid = cartesianProduct(knobs);
  const program_fingerprint = computeProgramFingerprint(program);

  const points: GridPointSummary[] = [];
  const results: VmResult[] = [];

  for (let i = 0; i < grid.length; i++) {
    const env = applyKnobs(base_env, grid[i]);
    const result = execute(program, state0, env, options);
    results.push(result);

    const final_state_hash = canonicalHash(
      result.state as unknown as Record<string, unknown>,
    );

    const point: GridPointSummary = {
      index: i,
      knob_values: grid[i],
      metrics: result.metrics,
      final_state_hash,
    };
    if (include_trace) {
      point.trace = result.trace;
    }
    points.push(point);
  }

  // Compute scan hash from deterministic inputs
  const scanInput = {
    program_fingerprint,
    knobs: [...knobs].sort((a, b) => a.key.localeCompare(b.key)),
    base_env: base_env as unknown as Record<string, unknown>,
    state0: state0 as unknown as Record<string, unknown>,
  };
  const scan_hash = canonicalHash(
    scanInput as unknown as Record<string, unknown>,
  );

  return { points, results, scan_hash, program_id: program.program_id, program_fingerprint };
}

// ---------------------------------------------------------------------------
// Scan dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a phase scan: grid, adaptive, or hunt_boundaries mode.
 */
export function scanPhases(definition: ScanDefinition): PhaseScanResult {
  if (definition.scan_mode === "adaptive") {
    return scanPhasesAdaptive(definition);
  }
  if (definition.scan_mode === "hunt_boundaries") {
    return scanPhasesBoundaryHunt(definition);
  }
  return scanPhasesGrid(definition);
}

// ---------------------------------------------------------------------------
// Grid scan (existing behavior, extracted)
// ---------------------------------------------------------------------------

function scanPhasesGrid(definition: ScanDefinition): PhaseScanResult {
  const { points, results, scan_hash, program_id, program_fingerprint } = executeGrid(definition);
  const knobs = [...definition.knobs].sort((a, b) => a.key.localeCompare(b.key));

  const scan_index: PhaseScanIndex = {
    schema_version: "phase_scan.v1",
    scan_hash,
    program_id,
    program_fingerprint,
    knobs,
    grid_size: points.length,
    points,
  };

  const hints = detectPhaseHints(points);
  const phase_hints: PhaseHints = {
    schema_version: "phase_hints.v1",
    scan_hash,
    hints,
  };

  const transition_dossier: CompareResult[] = [];
  for (let i = 0; i < results.length - 1; i++) {
    transition_dossier.push(compareRuns(results[i], results[i + 1]));
  }

  const formalized_dossier = buildFormalizedDossier(
    scan_hash, points, hints, transition_dossier,
  );

  return { scan_index, phase_hints, transition_dossier, formalized_dossier };
}

// ---------------------------------------------------------------------------
// Adaptive scan
// ---------------------------------------------------------------------------

function scanPhasesAdaptive(definition: ScanDefinition): PhaseScanResult {
  const maxRefinements = definition.adaptive?.max_refinements ?? 3;
  const maxTotalRuns = definition.adaptive?.max_total_runs ?? 100;
  const { program, state0, base_env, include_trace = false, options } = definition;

  // Step 1: Coarse grid scan
  const {
    points: coarsePoints,
    results: coarseResults,
    scan_hash,
    program_id,
    program_fingerprint,
  } = executeGrid(definition);
  const knobs = [...definition.knobs].sort((a, b) => a.key.localeCompare(b.key));

  // Build coarse result
  const coarseScanIndex: PhaseScanIndex = {
    schema_version: "phase_scan.v1",
    scan_hash,
    program_id,
    program_fingerprint,
    knobs,
    grid_size: coarsePoints.length,
    points: coarsePoints,
  };

  const coarseHints = detectPhaseHints(coarsePoints);
  const coarsePhaseHints: PhaseHints = {
    schema_version: "phase_hints.v1",
    scan_hash,
    hints: coarseHints,
  };

  const coarseDossier: CompareResult[] = [];
  for (let i = 0; i < coarseResults.length - 1; i++) {
    coarseDossier.push(compareRuns(coarseResults[i], coarseResults[i + 1]));
  }

  const coarseFormalizedDossier = buildFormalizedDossier(
    scan_hash, coarsePoints, coarseHints, coarseDossier,
  );

  // Determine refinable keys
  const refinableKeys = new Set(
    definition.knobs.filter(isRefinableKnob).map((k) => k.key),
  );

  // If nothing is refinable, return coarse result with empty adaptive
  if (refinableKeys.size === 0) {
    return {
      scan_index: coarseScanIndex,
      phase_hints: coarsePhaseHints,
      transition_dossier: coarseDossier,
      formalized_dossier: coarseFormalizedDossier,
      adaptive: {
        refinements: [],
        all_points: coarsePoints,
        all_hints: coarseHints,
        refined_dossier: coarseFormalizedDossier,
      },
    };
  }

  // Step 2: Adaptive refinement
  let allPoints: GridPointSummary[] = [...coarsePoints];
  let allResults: VmResult[] = [...coarseResults];
  let currentHints = coarseHints;
  let totalRuns = coarsePoints.length;
  const seenKnobKeys = new Set<string>(
    allPoints.map((p) => canonicalizeKnobValues(p.knob_values)),
  );
  const refinements: RefinementRound[] = [];

  for (let round = 0; round < maxRefinements; round++) {
    if (currentHints.length === 0) break;
    if (totalRuns >= maxTotalRuns) break;

    // Deduplicate hint pairs (sorted indices)
    const pairSet = new Set<string>();
    const hintPairs: Array<[number, number]> = [];
    for (const hint of currentHints) {
      const key = `${hint.between[0]}_${hint.between[1]}`;
      if (!pairSet.has(key)) {
        pairSet.add(key);
        hintPairs.push(hint.between);
      }
    }

    // Sort by first index for determinism
    hintPairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const roundPoints: GridPointSummary[] = [];
    const roundResults: VmResult[] = [];

    for (const [idxA, idxB] of hintPairs) {
      if (totalRuns >= maxTotalRuns) break;

      const pointA = allPoints[idxA];
      const pointB = allPoints[idxB];

      // Bisect
      const midKnobs = bisectKnobs(
        pointA.knob_values, pointB.knob_values, refinableKeys,
      );

      // Skip if midpoint already exists
      const midKey = canonicalizeKnobValues(midKnobs);
      if (seenKnobKeys.has(midKey)) continue;
      seenKnobKeys.add(midKey);

      // Execute midpoint
      const env = applyKnobs(base_env, midKnobs);
      const result = execute(program, state0, env, options);
      totalRuns++;

      const final_state_hash = canonicalHash(
        result.state as unknown as Record<string, unknown>,
      );
      const point: GridPointSummary = {
        index: 0, // Will be re-indexed after sorting
        knob_values: midKnobs,
        metrics: result.metrics,
        final_state_hash,
      };
      if (include_trace) {
        point.trace = result.trace;
      }

      roundPoints.push(point);
      roundResults.push(result);
    }

    if (roundPoints.length === 0) break;

    // Add new points + results
    allPoints = [...allPoints, ...roundPoints];
    allResults = [...allResults, ...roundResults];

    // Re-sort all points by knob values for correct adjacency
    const sortedIndices = allPoints
      .map((_, i) => i)
      .sort((a, b) => compareKnobValues(allPoints[a].knob_values, allPoints[b].knob_values));

    allPoints = sortedIndices.map((origIdx, newIdx) => ({
      ...allPoints[origIdx],
      index: newIdx,
    }));
    allResults = sortedIndices.map((origIdx) => allResults[origIdx]);

    // Detect hints on the expanded, sorted point set
    const newHints = detectPhaseHints(allPoints);

    refinements.push({
      round: round + 1,
      new_points: roundPoints,
      new_hints: newHints,
    });

    currentHints = newHints;
  }

  // Final comparisons and dossier over all sorted points
  const allComparisons: CompareResult[] = [];
  for (let i = 0; i < allResults.length - 1; i++) {
    allComparisons.push(compareRuns(allResults[i], allResults[i + 1]));
  }

  const allHints = detectPhaseHints(allPoints);
  const refinedDossier = buildFormalizedDossier(
    scan_hash, allPoints, allHints, allComparisons,
  );

  return {
    scan_index: coarseScanIndex,
    phase_hints: coarsePhaseHints,
    transition_dossier: coarseDossier,
    formalized_dossier: coarseFormalizedDossier,
    adaptive: {
      refinements,
      all_points: allPoints,
      all_hints: allHints,
      refined_dossier: refinedDossier,
    },
  };
}

/**
 * Deterministic string key for a set of knob values, for deduplication.
 */
export function canonicalizeKnobValues(knobs: Record<string, KnobValue>): string {
  return JSON.stringify(
    Object.keys(knobs).sort().map((k) => [k, knobs[k]]),
  );
}

/**
 * Compare two knob value records for sorting. Keys compared lexicographically,
 * then values: numbers by magnitude, others by string representation.
 */
export function compareKnobValues(
  a: Record<string, KnobValue>,
  b: Record<string, KnobValue>,
): number {
  const keys = [
    ...new Set([...Object.keys(a), ...Object.keys(b)]),
  ].sort();
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (av === bv) continue;
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Formalized Dossier Builder
// ---------------------------------------------------------------------------

const ENGINE_VERSION = "rks.v1";
const TOP_OPCODE_COUNT = 5;

/**
 * Build a formalized dossier: one entry per phase hint, with structured
 * evidence, top deltas, and compare linkage.
 */
export function buildFormalizedDossier(
  scan_hash: string,
  points: GridPointSummary[],
  hints: PhaseHint[],
  comparisons: CompareResult[],
): TransitionDossier {
  const entries: TransitionDossierEntry[] = hints.map((hint) => {
    const [idxA, idxB] = hint.between;

    // The comparison for adjacent pair (idxA, idxB) is at index idxA
    // in the comparisons array (comparisons for pairs 0-1, 1-2, ...)
    const cmp = comparisons[idxA];

    // Top scalar deltas: bag_variance sorted by |delta|
    const top_scalar_deltas = [...cmp.bag_variance]
      .filter((bv) => bv.delta !== null && bv.delta !== 0)
      .sort((a, b) => Math.abs(b.delta as number) - Math.abs(a.delta as number))
      .map((bv) => ({ metric: bv.bag, delta: bv.delta as number }));

    // Top opcode deltas: opcode_frequency sorted by |delta|, top 5
    const top_opcode_deltas = [...cmp.opcode_frequency]
      .filter((od) => od.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, TOP_OPCODE_COUNT)
      .map((od) => ({ opcode_id: od.opcode_id, delta: od.delta }));

    return {
      candidate_id: `transition_${idxA}_${idxB}`,
      hint_type: hint.kind,
      hint_evidence: {
        metric: hint.metric,
        a_value: hint.a_value,
        b_value: hint.b_value,
        detail: hint.detail,
      },
      run_a_id: points[idxA].final_state_hash,
      run_b_id: points[idxB].final_state_hash,
      compare_hash: cmp.compare_hash,
      summary: {
        top_scalar_deltas,
        top_opcode_deltas,
      },
      paths: {},
      meta: {
        engine_version: ENGINE_VERSION,
        schema_version: "transition_dossier.v1" as const,
      },
    };
  });

  return {
    schema_version: "transition_dossier.v1",
    scan_hash,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

const SCANS_DIR = join("data", "runs", "_scans");

/**
 * Persist a phase scan result to `data/runs/_scans/<scan_hash12>/`.
 */
export function persistPhaseScan(result: PhaseScanResult): string {
  const hash12 = result.scan_index.scan_hash.slice(0, 12);
  const scanDir = join(SCANS_DIR, hash12);
  mkdirSync(scanDir, { recursive: true });

  writeFileSync(
    join(scanDir, "SCAN_INDEX.json"),
    canonicalize(
      result.scan_index as unknown as Record<string, unknown>,
    ) + "\n",
  );
  writeFileSync(
    join(scanDir, "PHASE_HINTS.json"),
    canonicalize(
      result.phase_hints as unknown as Record<string, unknown>,
    ) + "\n",
  );
  writeFileSync(
    join(scanDir, "TRANSITION_DOSSIER.json"),
    canonicalize({
      dossier: result.transition_dossier,
    } as unknown as Record<string, unknown>) + "\n",
  );
  writeFileSync(
    join(scanDir, "FORMALIZED_DOSSIER.json"),
    canonicalize(
      result.formalized_dossier as unknown as Record<string, unknown>,
    ) + "\n",
  );

  if (result.adaptive) {
    writeFileSync(
      join(scanDir, "PHASE_SCAN_REFINED.json"),
      canonicalize(
        result.adaptive as unknown as Record<string, unknown>,
      ) + "\n",
    );
  }

  if (result.boundary_hunt) {
    writeFileSync(
      join(scanDir, "BOUNDARY_HUNT.json"),
      canonicalize(
        result.boundary_hunt as unknown as Record<string, unknown>,
      ) + "\n",
    );
  }

  // Build scan signature from in-memory data
  const si = result.scan_index;
  const points = si.points;
  const halted = points.filter((p) => p.metrics.halted_early).length;
  const total = points.length;
  const haltFraction = total > 0
    ? Math.round((halted / total) * 10000) / 10000
    : 0;

  const knobTypes = si.knobs.map((k) => {
    const vals = k.values;
    if (vals.length === 0) return "unknown";
    if (vals.every((v) => typeof v === "number")) {
      return (vals as number[]).some((v) => !Number.isInteger(v)) ? "float" : "integer";
    }
    return typeof vals[0];
  });

  const miniReportModel = {
    meta: {
      scan_hash: si.scan_hash,
      program_id: si.program_id,
    },
    summary: {
      grid_size: si.grid_size,
      total_hints: result.phase_hints.hints.length,
      knobs: si.knobs.map((k, i) => ({ name: k.key, type: knobTypes[i] })),
      adaptive_refinements: result.adaptive
        ? result.adaptive.refinements.length
        : null,
    },
    regime_proportions: {
      halted,
      completed: total - halted,
      halt_fraction: haltFraction,
    },
    grid_points: points.map((p) => ({
      final_bag_sum: p.metrics.final_bag_sum,
      regime_class: classifyRegime(p.metrics),
    })),
  };

  const signature = buildScanSignature(miniReportModel, result.formalized_dossier);
  writeFileSync(
    join(scanDir, "SCAN_SIGNATURE.json"),
    canonicalize(signature as unknown as Record<string, unknown>) + "\n",
  );

  // Append to scan index
  appendToScanIndex(result, scanDir);

  return scanDir;
}
