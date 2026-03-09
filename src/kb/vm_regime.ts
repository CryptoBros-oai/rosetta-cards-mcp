/**
 * VM Regime Classifier — deterministic classification of run outcomes.
 *
 * Derives a RegimeClass from VmMetrics halt_reason strings.
 * Pure function, no side effects, no external deps.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegimeClass =
  | "completed"
  | "halt:max_steps"
  | "halt:precondition"
  | "halt:invariant:negative_bag"
  | "halt:invariant:non_integer"
  | "halt:invariant:stack_overflow"
  | "halt:invariant:balance"
  | "halt:invariant:unknown"
  | "halt:unknown";

/**
 * Deterministic integer index for each RegimeClass.
 * Used in phase hints for numeric a_value / b_value encoding.
 */
export const REGIME_CLASS_INDEX: Record<RegimeClass, number> = {
  "completed": 0,
  "halt:max_steps": 1,
  "halt:precondition": 2,
  "halt:invariant:negative_bag": 3,
  "halt:invariant:non_integer": 4,
  "halt:invariant:stack_overflow": 5,
  "halt:invariant:balance": 6,
  "halt:invariant:unknown": 7,
  "halt:unknown": 8,
};

/** All regime classes in index order. */
export const ALL_REGIME_CLASSES: RegimeClass[] = [
  "completed",
  "halt:max_steps",
  "halt:precondition",
  "halt:invariant:negative_bag",
  "halt:invariant:non_integer",
  "halt:invariant:stack_overflow",
  "halt:invariant:balance",
  "halt:invariant:unknown",
  "halt:unknown",
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a run's outcome into a deterministic RegimeClass.
 *
 * Parses the halt_reason string produced by vm_engine.ts:
 * - "max_steps exceeded (N)"
 * - "precondition failed at step N (opcode): reason"
 * - "invariant violation at step N: violation1; violation2"
 *
 * And vm_invariants.ts violation patterns:
 * - 'bag "name" is negative: N'
 * - 'bag "name" is not finite: N' / 'bag "name" is not an integer: N'
 * - 'stack depth N exceeds max M'
 * - 'bag sum N != expected total M'
 */
export function classifyRegime(
  metrics: { halted_early: boolean; halt_reason?: string },
): RegimeClass {
  if (!metrics.halted_early) {
    return "completed";
  }

  const reason = metrics.halt_reason;
  if (reason === undefined) {
    return "halt:unknown";
  }

  if (reason.startsWith("max_steps exceeded")) {
    return "halt:max_steps";
  }

  if (reason.startsWith("precondition failed")) {
    return "halt:precondition";
  }

  if (reason.startsWith("invariant violation")) {
    const body = reason.slice(reason.indexOf(":") + 1);

    if (body.includes("negative")) {
      return "halt:invariant:negative_bag";
    }
    if (body.includes("not an integer") || body.includes("not finite")) {
      return "halt:invariant:non_integer";
    }
    if (body.includes("stack depth") || body.includes("exceeds max")) {
      return "halt:invariant:stack_overflow";
    }
    if (body.includes("bag sum") || body.includes("expected total")) {
      return "halt:invariant:balance";
    }

    return "halt:invariant:unknown";
  }

  return "halt:unknown";
}
