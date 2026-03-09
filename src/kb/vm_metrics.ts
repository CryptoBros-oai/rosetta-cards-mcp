import type { VmState, VmMetrics, TraceStep, VmVerb } from "./vm_types.js";

/**
 * Compute bag variance across all trace steps.
 * For each bag, computes variance of its values over the trace.
 */
function computeBagVariance(trace: TraceStep[]): Record<string, number> {
  if (trace.length === 0) return {};

  const bagNames = new Set<string>();
  for (const step of trace) {
    for (const name of Object.keys(step.state_after.bags)) {
      bagNames.add(name);
    }
  }

  const result: Record<string, number> = {};
  for (const name of [...bagNames].sort()) {
    const values = trace.map((s) => s.state_after.bags[name] ?? 0);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
    // Round to 3 decimal places for cross-platform determinism
    result[name] = Math.round(variance * 1000) / 1000;
  }
  return result;
}

/**
 * Compute run metrics from a completed trace.
 */
export function computeMetrics(
  trace: TraceStep[],
  finalState: VmState,
  haltedEarly: boolean,
  haltReason?: string,
): VmMetrics {
  const opcodeFreq: Record<string, number> = {};
  const verbDist: Record<VmVerb, number> = {
    Attract: 0,
    Contain: 0,
    Release: 0,
    Repel: 0,
    Transform: 0,
  };

  for (const step of trace) {
    opcodeFreq[step.opcode_id] = (opcodeFreq[step.opcode_id] ?? 0) + 1;
    verbDist[step.verb as VmVerb] = (verbDist[step.verb as VmVerb] ?? 0) + 1;
  }

  // Sort opcode_frequency keys for determinism
  const sortedFreq: Record<string, number> = {};
  for (const key of Object.keys(opcodeFreq).sort()) {
    sortedFreq[key] = opcodeFreq[key];
  }

  const finalBagSum = Object.values(finalState.bags).reduce(
    (a, b) => a + b,
    0,
  );

  const result: VmMetrics = {
    total_steps: trace.length,
    opcode_frequency: sortedFreq,
    verb_distribution: verbDist,
    bag_variance: computeBagVariance(trace),
    final_bag_sum: finalBagSum,
    halted_early: haltedEarly,
  };
  if (haltReason !== undefined) {
    result.halt_reason = haltReason;
  }
  return result;
}
