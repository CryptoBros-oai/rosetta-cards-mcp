import type { VmState, InvariantResult } from "./vm_types.js";

/**
 * Check non-negative bag constraint.
 * All bag values must be >= 0 after every step.
 */
export function checkNonNegativeBags(state: VmState): InvariantResult {
  const violations: string[] = [];
  for (const [name, value] of Object.entries(state.bags)) {
    if (value < 0) {
      violations.push(`bag "${name}" is negative: ${value}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Check bag balance constraint.
 * Given an expected total, verify sum of all bags equals it.
 */
export function checkBagBalance(state: VmState, expectedTotal: number): InvariantResult {
  const sum = Object.values(state.bags).reduce((a, b) => a + b, 0);
  if (sum !== expectedTotal) {
    return {
      ok: false,
      violations: [`bag sum ${sum} != expected total ${expectedTotal}`],
    };
  }
  return { ok: true, violations: [] };
}

/**
 * Check stack depth bound.
 */
export function checkStackBound(state: VmState, maxDepth: number): InvariantResult {
  if (state.stack.length > maxDepth) {
    return {
      ok: false,
      violations: [`stack depth ${state.stack.length} exceeds max ${maxDepth}`],
    };
  }
  return { ok: true, violations: [] };
}

/**
 * Check all integer bag values (no NaN/Infinity).
 */
export function checkBagIntegrity(state: VmState): InvariantResult {
  const violations: string[] = [];
  for (const [name, value] of Object.entries(state.bags)) {
    if (!Number.isFinite(value)) {
      violations.push(`bag "${name}" is not finite: ${value}`);
    }
    if (!Number.isInteger(value)) {
      violations.push(`bag "${name}" is not an integer: ${value}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Run all default invariants. Returns combined result.
 */
export function checkAllInvariants(
  state: VmState,
  opts?: { expectedTotal?: number; maxStackDepth?: number },
): InvariantResult {
  const results = [
    checkNonNegativeBags(state),
    checkBagIntegrity(state),
    checkStackBound(state, opts?.maxStackDepth ?? 1000),
  ];
  if (opts?.expectedTotal !== undefined) {
    results.push(checkBagBalance(state, opts.expectedTotal));
  }
  const allViolations = results.flatMap((r) => r.violations);
  return { ok: allViolations.length === 0, violations: allViolations };
}
