import { VmProgramSchema, VmStateSchema, VmEnvSchema } from "./vm_types.js";
import type {
  VmProgram,
  VmState,
  VmEnv,
  VmResult,
  TraceStep,
} from "./vm_types.js";
import { getOpcode } from "./vm_registry.js";
import { createRng } from "./vm_rng.js";
import { checkAllInvariants } from "./vm_invariants.js";
import { computeMetrics } from "./vm_metrics.js";

// ---------------------------------------------------------------------------
// Execution errors
// ---------------------------------------------------------------------------

export class VmHaltError extends Error {
  constructor(
    public readonly reason: string,
    public readonly step: number,
    public readonly opcode_id: string,
  ) {
    super(`VM halted at step ${step} (${opcode_id}): ${reason}`);
    this.name = "VmHaltError";
  }
}

export class VmInvariantError extends Error {
  constructor(
    public readonly violations: string[],
    public readonly step: number,
    public readonly opcode_id: string,
  ) {
    super(
      `Invariant violation at step ${step} (${opcode_id}): ${violations.join("; ")}`,
    );
    this.name = "VmInvariantError";
  }
}

// ---------------------------------------------------------------------------
// Deep clone for trace snapshots (deterministic for our restricted types)
// ---------------------------------------------------------------------------

function snapshot(state: VmState): VmState {
  return JSON.parse(JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Execute options
// ---------------------------------------------------------------------------

export type ExecuteOptions = {
  /** If true, include full state snapshots in trace (default: true) */
  fullTrace?: boolean;
  /** Expected bag total for balance invariant (optional) */
  expectedBagTotal?: number;
  /** Max stack depth (default: 1000) */
  maxStackDepth?: number;
  /** If true, halt on invariant violation instead of throwing (default: false) */
  softHalt?: boolean;
};

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export function execute(
  program: VmProgram,
  state0: VmState,
  env: VmEnv,
  opts?: ExecuteOptions,
): VmResult {
  // 1. Validate inputs
  const validProgram = VmProgramSchema.parse(program);
  const validState = VmStateSchema.parse(state0);
  const validEnv = VmEnvSchema.parse(env);

  // 2. Initialize
  const rng = createRng(validEnv.run_seed, validEnv.world_seed);
  let current = snapshot(validState);
  const trace: TraceStep[] = [];
  const maxSteps = validEnv.max_steps;
  let haltedEarly = false;
  let haltReason: string | undefined;

  // 3. Execute loop
  for (let i = 0; i < validProgram.opcodes.length; i++) {
    if (i >= maxSteps) {
      haltedEarly = true;
      haltReason = `max_steps exceeded (${maxSteps})`;
      break;
    }

    const op = validProgram.opcodes[i];
    const spec = getOpcode(op.opcode_id);
    if (!spec) {
      throw new Error(`Unknown opcode: ${op.opcode_id} at step ${i}`);
    }

    // Verify verb matches registry
    if (spec.verb !== op.verb) {
      throw new Error(
        `Verb mismatch for ${op.opcode_id}: program says "${op.verb}", registry says "${spec.verb}"`,
      );
    }

    const stateBefore =
      opts?.fullTrace !== false ? snapshot(current) : current;

    // Check precondition
    if (spec.precondition) {
      const preErr = spec.precondition(current, op.args);
      if (preErr !== null) {
        trace.push({
          step: i,
          opcode_id: op.opcode_id,
          verb: op.verb,
          args: op.args,
          state_before: stateBefore,
          state_after: snapshot(current),
          error: `precondition failed: ${preErr}`,
        });
        haltedEarly = true;
        haltReason = `precondition failed at step ${i} (${op.opcode_id}): ${preErr}`;
        break;
      }
    }

    // Execute reducer
    const next = spec.reduce(current, op.args, validEnv, rng.next);

    // Check invariants
    const inv = checkAllInvariants(next, {
      expectedTotal: opts?.expectedBagTotal,
      maxStackDepth: opts?.maxStackDepth,
    });

    const traceStep: TraceStep = {
      step: i,
      opcode_id: op.opcode_id,
      verb: op.verb,
      args: op.args,
      state_before: stateBefore,
      state_after: snapshot(next),
    };
    if (!inv.ok) {
      traceStep.error = `invariant: ${inv.violations.join("; ")}`;
    }
    trace.push(traceStep);

    if (!inv.ok) {
      if (opts?.softHalt) {
        haltedEarly = true;
        haltReason = `invariant violation at step ${i}: ${inv.violations.join("; ")}`;
        break;
      }
      throw new VmInvariantError(inv.violations, i, op.opcode_id);
    }

    current = next;
  }

  // 4. Compute metrics
  const metrics = computeMetrics(trace, current, haltedEarly, haltReason);

  return { state: current, trace, metrics };
}
