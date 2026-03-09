/**
 * VM Scan Signature — deterministic behavior feature vector for a phase scan.
 *
 * Computed from the report model + formalized dossier.
 * Produces SCAN_SIGNATURE.json — a compact, comparable summary.
 */

import type { TransitionDossier } from "./vm_types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScanSignature = {
  schema_version: "scan_signature.v1";
  scan_id: string;
  program_id: string;
  knob_summary: { names: string[]; types: string[] };
  counts: {
    grid_points: number;
    phase_hints: number;
    dossier_entries: number;
    adaptive_refinements: number | null;
  };
  regime: {
    halted: number;
    completed: number;
    halt_fraction: number;
  };
  transition_stats: {
    transition_density: number;
    avg_delta_magnitude: number;
    max_delta_magnitude: number;
    opcode_delta_concentration: number;
    metric_cliff_score: number;
  };
  opcode_signature: { opcode: string; weight: number }[];
  metrics_signature: { metric: string; weight: number }[];
  regime_classes: string[];
  regime_distribution: { regime_class: string; count: number; fraction: number }[];
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a scan signature from a report model and formalized dossier.
 *
 * The reportModel is the object returned by buildReportModel() from
 * make_phase_transition_report.mjs. The formalizedDossier is the
 * TransitionDossier from the scan result.
 *
 * All outputs are deterministic. Control scans (0 transitions) produce
 * valid zero-valued signatures with empty arrays — no NaN.
 */
export function buildScanSignature(
  reportModel: any,
  formalizedDossier: TransitionDossier,
): ScanSignature {
  const entries = formalizedDossier.entries;
  const gridPoints = reportModel.grid_points;
  const gridSize = reportModel.summary.grid_size;
  const hintCount = reportModel.summary.total_hints;

  // Regime
  const halted = reportModel.regime_proportions.halted;
  const completed = reportModel.regime_proportions.completed;
  const haltFraction = reportModel.regime_proportions.halt_fraction;

  // Mean final_bag_sum across grid points (for normalization)
  const meanBagSum =
    gridSize > 0
      ? gridPoints.reduce((s: number, p: any) => s + p.final_bag_sum, 0) / gridSize
      : 1;
  const normDivisor = Math.max(Math.abs(meanBagSum), 1);

  // Aggregate scalar deltas across all transitions
  const scalarDeltas: { metric: string; absDelta: number }[] = [];
  const opcodeDeltas: { opcode: string; absDelta: number }[] = [];

  for (const entry of entries) {
    for (const sd of entry.summary.top_scalar_deltas) {
      scalarDeltas.push({ metric: sd.metric, absDelta: Math.abs(sd.delta) });
    }
    for (const od of entry.summary.top_opcode_deltas) {
      opcodeDeltas.push({ opcode: od.opcode_id, absDelta: Math.abs(od.delta) });
    }
  }

  // transition_density
  const transitionDensity = gridSize > 0 ? hintCount / gridSize : 0;

  // avg_delta_magnitude — mean of all |scalar deltas| across all transitions
  const avgDeltaMagnitude =
    scalarDeltas.length > 0
      ? scalarDeltas.reduce((s, d) => s + d.absDelta, 0) / scalarDeltas.length
      : 0;

  // max_delta_magnitude — max single |scalar delta|
  const maxDeltaMagnitude =
    scalarDeltas.length > 0
      ? Math.max(...scalarDeltas.map((d) => d.absDelta))
      : 0;

  // opcode_delta_concentration — top-2 opcode share
  const opcodeByName = new Map<string, number>();
  for (const od of opcodeDeltas) {
    opcodeByName.set(od.opcode, (opcodeByName.get(od.opcode) ?? 0) + od.absDelta);
  }
  const opcodeTotals = [...opcodeByName.entries()]
    .map(([opcode, total]) => ({ opcode, total }))
    .sort((a, b) => b.total - a.total);
  const totalOpcodeAbs = opcodeTotals.reduce((s, o) => s + o.total, 0);
  const top2OpcodeAbs =
    opcodeTotals.length >= 2
      ? opcodeTotals[0].total + opcodeTotals[1].total
      : opcodeTotals.length === 1
        ? opcodeTotals[0].total
        : 0;
  const opcodeConcentration =
    totalOpcodeAbs > 0 ? top2OpcodeAbs / totalOpcodeAbs : 0;

  // metric_cliff_score — max single cliff normalized by mean bag sum
  let metricCliffScore = 0;
  for (const entry of entries) {
    if (entry.summary.top_scalar_deltas.length > 0) {
      const maxCliff = Math.max(
        ...entry.summary.top_scalar_deltas.map((d: any) => Math.abs(d.delta)),
      );
      const normalized = maxCliff / normDivisor;
      if (normalized > metricCliffScore) {
        metricCliffScore = normalized;
      }
    }
  }

  // opcode_signature — aggregate by opcode, normalize, top 20
  const opcodeWeights = buildWeightedList(opcodeByName, 20);
  const opcodeSignature = opcodeWeights.map((e) => ({ opcode: e.name, weight: e.weight }));

  // metrics_signature — aggregate by metric name, top 10
  const metricByName = new Map<string, number>();
  for (const sd of scalarDeltas) {
    metricByName.set(sd.metric, (metricByName.get(sd.metric) ?? 0) + sd.absDelta);
  }
  const metricWeights = buildWeightedList(metricByName, 10);
  const metricsSignature = metricWeights.map((e) => ({ metric: e.name, weight: e.weight }));

  // Regime distribution from grid points
  const regimeCounts = new Map<string, number>();
  for (const p of gridPoints) {
    const rc: string = p.regime_class ?? "completed";
    regimeCounts.set(rc, (regimeCounts.get(rc) ?? 0) + 1);
  }
  const regime_classes = [...regimeCounts.keys()].sort();
  const regime_distribution = regime_classes.map((rc) => ({
    regime_class: rc,
    count: regimeCounts.get(rc)!,
    fraction: gridSize > 0
      ? Math.round((regimeCounts.get(rc)! / gridSize) * 10000) / 10000
      : 0,
  }));

  return {
    schema_version: "scan_signature.v1",
    scan_id: reportModel.meta.scan_hash,
    program_id: reportModel.meta.program_id,
    knob_summary: {
      names: reportModel.summary.knobs.map((k: any) => k.name),
      types: reportModel.summary.knobs.map((k: any) => k.type),
    },
    counts: {
      grid_points: gridSize,
      phase_hints: hintCount,
      dossier_entries: entries.length,
      adaptive_refinements: reportModel.summary.adaptive_refinements,
    },
    regime: {
      halted,
      completed,
      halt_fraction: haltFraction,
    },
    transition_stats: {
      transition_density: transitionDensity,
      avg_delta_magnitude: avgDeltaMagnitude,
      max_delta_magnitude: maxDeltaMagnitude,
      opcode_delta_concentration: opcodeConcentration,
      metric_cliff_score: metricCliffScore,
    },
    opcode_signature: opcodeSignature,
    metrics_signature: metricsSignature,
    regime_classes,
    regime_distribution,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WeightedEntry = { name: string; weight: number };

function buildWeightedList(
  aggregated: Map<string, number>,
  topN: number,
): WeightedEntry[] {
  const sorted = [...aggregated.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => {
      const d = b.total - a.total;
      if (d !== 0) return d;
      return a.name.localeCompare(b.name); // stable tiebreak
    })
    .slice(0, topN);

  const totalAbs = sorted.reduce((s, e) => s + e.total, 0);
  if (totalAbs === 0) return [];

  return sorted.map((e) => ({
    name: e.name,
    weight: Math.round((e.total / totalAbs) * 10000) / 10000,
  }));
}
