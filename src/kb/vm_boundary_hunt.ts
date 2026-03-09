/**
 * VM Boundary Hunt — scan mode that expands and refines around phase boundaries.
 *
 * Algorithm: coarse grid → detect regime_transition hints → expand outward
 * until both sides captured → bisect within boundary regions.
 */

import { canonicalHash } from "./canonical.js";
import { execute } from "./vm_engine.js";
import { compareRuns } from "./vm_compare.js";
import { classifyRegime } from "./vm_regime.js";
import type { RegimeClass } from "./vm_regime.js";
import type { CompareResult } from "./vm_compare.js";
import type { VmResult } from "./vm_types.js";
import {
  executeGrid,
  detectPhaseHints,
  isRefinableKnob,
  bisectKnobs,
  applyKnobs,
  buildFormalizedDossier,
  canonicalizeKnobValues,
  compareKnobValues,
} from "./vm_phase_scan.js";
import type {
  ScanDefinition,
  PhaseScanResult,
  PhaseScanIndex,
  PhaseHints,
  PhaseHint,
  GridPointSummary,
  RefinementRound,
  KnobValue,
} from "./vm_phase_scan.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BoundaryHuntOptions = {
  max_refinements?: number;   // default 3
  max_total_runs?: number;    // default 200
  expansion_steps?: number;   // max outward expansion iterations, default 3
  expansion_factor?: number;  // widening multiplier per step, default 2.0
};

export type BoundaryRegion = {
  knob_key: string;
  low: number;
  high: number;
  regime_low: RegimeClass;
  regime_high: RegimeClass;
};

export type ExpansionRound = {
  round: number;
  direction: "low" | "high";
  new_value: number;
  new_regime: RegimeClass;
};

export type BoundaryHuntResult = {
  boundary_regions: BoundaryRegion[];
  expansion_rounds: ExpansionRound[];
  refinement_rounds: RefinementRound[];
  all_points: GridPointSummary[];
  all_hints: PhaseHint[];
};

// ---------------------------------------------------------------------------
// Boundary Hunt Scan Mode
// ---------------------------------------------------------------------------

export function scanPhasesBoundaryHunt(definition: ScanDefinition): PhaseScanResult {
  const maxRefinements = definition.boundary_hunt?.max_refinements ?? 3;
  const maxTotalRuns = definition.boundary_hunt?.max_total_runs ?? 200;
  const expansionSteps = definition.boundary_hunt?.expansion_steps ?? 3;
  const expansionFactor = definition.boundary_hunt?.expansion_factor ?? 2.0;
  const { program, state0, base_env, include_trace = false, options } = definition;

  // Step 1: Coarse grid
  const {
    points: coarsePoints,
    results: coarseResults,
    scan_hash,
    program_id,
    program_fingerprint,
  } = executeGrid(definition);
  const knobs = [...definition.knobs].sort((a, b) => a.key.localeCompare(b.key));

  // Build coarse scan result
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

  // Determine refinable float knob keys
  const refinableKeys = new Set(
    definition.knobs.filter(isRefinableKnob).map((k) => k.key),
  );

  // Compute original knob ranges (min/max of knob values per key)
  const knobRanges = new Map<string, { min: number; max: number }>();
  for (const knob of definition.knobs) {
    if (refinableKeys.has(knob.key)) {
      const nums = knob.values.filter((v): v is number => typeof v === "number");
      if (nums.length > 0) {
        knobRanges.set(knob.key, {
          min: Math.min(...nums),
          max: Math.max(...nums),
        });
      }
    }
  }

  // If nothing is refinable, return coarse result
  if (refinableKeys.size === 0) {
    return {
      scan_index: coarseScanIndex,
      phase_hints: coarsePhaseHints,
      transition_dossier: coarseDossier,
      formalized_dossier: coarseFormalizedDossier,
      boundary_hunt: {
        boundary_regions: [],
        expansion_rounds: [],
        refinement_rounds: [],
        all_points: coarsePoints,
        all_hints: coarseHints,
      },
    };
  }

  // Step 2: Detect candidate boundary regions from regime_transition hints
  let allPoints: GridPointSummary[] = [...coarsePoints];
  let allResults: VmResult[] = [...coarseResults];
  let totalRuns = coarsePoints.length;
  const seenKnobKeys = new Set<string>(
    allPoints.map((p) => canonicalizeKnobValues(p.knob_values)),
  );

  const boundaryRegions: BoundaryRegion[] = [];
  const expansionRounds: ExpansionRound[] = [];

  // Find regime_transition hints on refinable knobs
  const regimeHints = coarseHints.filter((h) => h.kind === "regime_transition");

  // Build initial boundary candidates: deduplicate by pair index
  const candidatePairs = new Set<string>();
  for (const hint of regimeHints) {
    const [idxA, idxB] = hint.between;
    const key = `${idxA}_${idxB}`;
    if (candidatePairs.has(key)) continue;
    candidatePairs.add(key);

    const pointA = allPoints[idxA];
    const pointB = allPoints[idxB];

    // Find the refinable knob that changes between these points
    for (const knobKey of refinableKeys) {
      const valA = pointA.knob_values[knobKey];
      const valB = pointB.knob_values[knobKey];
      if (typeof valA === "number" && typeof valB === "number" && valA !== valB) {
        const regimeA = classifyRegime(pointA.metrics);
        const regimeB = classifyRegime(pointB.metrics);
        if (regimeA !== regimeB) {
          boundaryRegions.push({
            knob_key: knobKey,
            low: Math.min(valA, valB),
            high: Math.max(valA, valB),
            regime_low: valA < valB ? regimeA : regimeB,
            regime_high: valA < valB ? regimeB : regimeA,
          });
        }
      }
    }
  }

  // Sort boundary regions for determinism
  boundaryRegions.sort((a, b) =>
    a.knob_key.localeCompare(b.knob_key) || a.low - b.low,
  );

  // Step 3: Range expansion
  for (let ri = 0; ri < boundaryRegions.length; ri++) {
    const region = boundaryRegions[ri];
    const range = knobRanges.get(region.knob_key);
    if (!range) continue;

    for (let step = 0; step < expansionSteps; step++) {
      if (totalRuns >= maxTotalRuns) break;

      const gap = region.high - region.low;

      // Expand low
      const expandLow = Math.max(range.min, region.low - gap * expansionFactor);
      if (expandLow < region.low) {
        const lowKnobs: Record<string, KnobValue> = { ...allPoints[0].knob_values };
        lowKnobs[region.knob_key] = expandLow;
        const lowKey = canonicalizeKnobValues(lowKnobs);
        if (!seenKnobKeys.has(lowKey)) {
          seenKnobKeys.add(lowKey);
          const env = applyKnobs(base_env, lowKnobs);
          const result = execute(program, state0, env, options);
          totalRuns++;

          const final_state_hash = canonicalHash(
            result.state as unknown as Record<string, unknown>,
          );
          const point: GridPointSummary = {
            index: 0,
            knob_values: lowKnobs,
            metrics: result.metrics,
            final_state_hash,
          };
          if (include_trace) point.trace = result.trace;

          allPoints.push(point);
          allResults.push(result);

          const newRegime = classifyRegime(result.metrics);
          expansionRounds.push({
            round: step + 1,
            direction: "low",
            new_value: expandLow,
            new_regime: newRegime,
          });

          if (newRegime === region.regime_low) {
            region.low = expandLow;
          }
        }
      }

      if (totalRuns >= maxTotalRuns) break;

      // Expand high
      const expandHigh = Math.min(range.max, region.high + gap * expansionFactor);
      if (expandHigh > region.high) {
        const highKnobs: Record<string, KnobValue> = { ...allPoints[0].knob_values };
        highKnobs[region.knob_key] = expandHigh;
        const highKey = canonicalizeKnobValues(highKnobs);
        if (!seenKnobKeys.has(highKey)) {
          seenKnobKeys.add(highKey);
          const env = applyKnobs(base_env, highKnobs);
          const result = execute(program, state0, env, options);
          totalRuns++;

          const final_state_hash = canonicalHash(
            result.state as unknown as Record<string, unknown>,
          );
          const point: GridPointSummary = {
            index: 0,
            knob_values: highKnobs,
            metrics: result.metrics,
            final_state_hash,
          };
          if (include_trace) point.trace = result.trace;

          allPoints.push(point);
          allResults.push(result);

          const newRegime = classifyRegime(result.metrics);
          expansionRounds.push({
            round: step + 1,
            direction: "high",
            new_value: expandHigh,
            new_regime: newRegime,
          });

          if (newRegime === region.regime_high) {
            region.high = expandHigh;
          }
        }
      }
    }
  }

  // Re-sort all points by knob values
  const sortedIndices = allPoints
    .map((_, i) => i)
    .sort((a, b) => compareKnobValues(allPoints[a].knob_values, allPoints[b].knob_values));
  allPoints = sortedIndices.map((origIdx, newIdx) => ({
    ...allPoints[origIdx],
    index: newIdx,
  }));
  allResults = sortedIndices.map((origIdx) => allResults[origIdx]);

  // Step 4: Refinement (bisection within boundary regions)
  let currentHints = detectPhaseHints(allPoints);
  const refinementRounds: RefinementRound[] = [];

  for (let round = 0; round < maxRefinements; round++) {
    if (currentHints.length === 0) break;
    if (totalRuns >= maxTotalRuns) break;

    // Deduplicate hint pairs
    const pairSet = new Set<string>();
    const hintPairs: Array<[number, number]> = [];
    for (const hint of currentHints) {
      // Only refine regime_transition hints for boundary hunting
      if (hint.kind !== "regime_transition") continue;
      const key = `${hint.between[0]}_${hint.between[1]}`;
      if (!pairSet.has(key)) {
        pairSet.add(key);
        hintPairs.push(hint.between);
      }
    }

    hintPairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const roundPoints: GridPointSummary[] = [];
    const roundResults: VmResult[] = [];

    for (const [idxA, idxB] of hintPairs) {
      if (totalRuns >= maxTotalRuns) break;

      const pointA = allPoints[idxA];
      const pointB = allPoints[idxB];

      const midKnobs = bisectKnobs(
        pointA.knob_values, pointB.knob_values, refinableKeys,
      );

      const midKey = canonicalizeKnobValues(midKnobs);
      if (seenKnobKeys.has(midKey)) continue;
      seenKnobKeys.add(midKey);

      const env = applyKnobs(base_env, midKnobs);
      const result = execute(program, state0, env, options);
      totalRuns++;

      const final_state_hash = canonicalHash(
        result.state as unknown as Record<string, unknown>,
      );
      const point: GridPointSummary = {
        index: 0,
        knob_values: midKnobs,
        metrics: result.metrics,
        final_state_hash,
      };
      if (include_trace) point.trace = result.trace;

      roundPoints.push(point);
      roundResults.push(result);
    }

    if (roundPoints.length === 0) break;

    allPoints = [...allPoints, ...roundPoints];
    allResults = [...allResults, ...roundResults];

    // Re-sort
    const sorted = allPoints
      .map((_, i) => i)
      .sort((a, b) => compareKnobValues(allPoints[a].knob_values, allPoints[b].knob_values));
    allPoints = sorted.map((origIdx, newIdx) => ({
      ...allPoints[origIdx],
      index: newIdx,
    }));
    allResults = sorted.map((origIdx) => allResults[origIdx]);

    const newHints = detectPhaseHints(allPoints);
    refinementRounds.push({
      round: round + 1,
      new_points: roundPoints,
      new_hints: newHints,
    });

    currentHints = newHints;
  }

  // Final comparisons and dossier
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
    boundary_hunt: {
      boundary_regions: boundaryRegions,
      expansion_rounds: expansionRounds,
      refinement_rounds: refinementRounds,
      all_points: allPoints,
      all_hints: allHints,
    },
  };
}
