import { z } from "zod";

// ---------------------------------------------------------------------------
// Rosetta Verb (mirrors existing RosettaVerb from schema.ts)
// ---------------------------------------------------------------------------

export const VmVerbSchema = z.enum([
  "Attract", "Contain", "Release", "Repel", "Transform",
]);
export type VmVerb = z.infer<typeof VmVerbSchema>;

// ---------------------------------------------------------------------------
// VM State
// ---------------------------------------------------------------------------

export const VmStateSchema = z.object({
  bags:  z.record(z.string(), z.number().int()),
  stack: z.array(z.unknown()),
  flags: z.record(z.string(), z.boolean()),
  notes: z.array(z.string()),
}).strict();
export type VmState = z.infer<typeof VmStateSchema>;

// ---------------------------------------------------------------------------
// VM Environment (immutable per run)
// ---------------------------------------------------------------------------

export const VmEnvSchema = z.object({
  run_seed:   z.number().int(),
  world_seed: z.number().int(),
  max_steps:  z.number().int().positive().default(10_000),
  params:     z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
}).strict();
export type VmEnv = z.infer<typeof VmEnvSchema>;

// ---------------------------------------------------------------------------
// Opcode
// ---------------------------------------------------------------------------

export const OpcodeSchema = z.object({
  opcode_id: z.string(),
  verb:      VmVerbSchema,
  args:      z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
}).strict();
export type Opcode = z.infer<typeof OpcodeSchema>;

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export const VmProgramSchema = z.object({
  program_id: z.string(),
  version:    z.string().default("program.v1"),
  opcodes:    z.array(OpcodeSchema),
}).strict();
export type VmProgram = z.infer<typeof VmProgramSchema>;

// ---------------------------------------------------------------------------
// Trace Step
// ---------------------------------------------------------------------------

export const TraceStepSchema = z.object({
  step:         z.number().int().nonnegative(),
  opcode_id:    z.string(),
  verb:         VmVerbSchema,
  args:         z.record(z.string(), z.unknown()),
  state_before: VmStateSchema,
  state_after:  VmStateSchema,
  error:        z.string().optional(),
}).strict();
export type TraceStep = z.infer<typeof TraceStepSchema>;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const VmMetricsSchema = z.object({
  total_steps:       z.number().int().nonnegative(),
  opcode_frequency:  z.record(z.string(), z.number().int()),
  verb_distribution: z.record(VmVerbSchema, z.number().int()),
  bag_variance:      z.record(z.string(), z.number()),
  final_bag_sum:     z.number(),
  halted_early:      z.boolean(),
  halt_reason:       z.string().optional(),
}).strict();
export type VmMetrics = z.infer<typeof VmMetricsSchema>;

// ---------------------------------------------------------------------------
// Execution Result
// ---------------------------------------------------------------------------

export const VmResultSchema = z.object({
  state:   VmStateSchema,
  trace:   z.array(TraceStepSchema),
  metrics: VmMetricsSchema,
}).strict();
export type VmResult = z.infer<typeof VmResultSchema>;

// ---------------------------------------------------------------------------
// Opcode Spec (for registry, not serialized)
// ---------------------------------------------------------------------------

export type OpcodeReducer = (
  state: VmState,
  args: Record<string, number | string | boolean>,
  env: VmEnv,
  rng: () => number,
) => VmState;

export type OpcodeSpec = {
  opcode_id: string;
  verb: VmVerb;
  description: string;
  required_args: string[];
  optional_args?: string[];
  precondition?: (state: VmState, args: Record<string, number | string | boolean>) => string | null;
  reduce: OpcodeReducer;
};

// ---------------------------------------------------------------------------
// Invariant result
// ---------------------------------------------------------------------------

export type InvariantResult = {
  ok: boolean;
  violations: string[];
};

// ---------------------------------------------------------------------------
// Run Metadata (for persisted runs)
// ---------------------------------------------------------------------------

export const RunMetadataSchema = z.object({
  schema_version: z.literal("run.v1"),
  run_hash: z.string(),
  program_fingerprint: z.string(),
  program_id: z.string(),
  program_version: z.string(),
  initial_state_hash: z.string(),
  env: VmEnvSchema,
  total_steps: z.number().int().nonnegative(),
  halted_early: z.boolean(),
  halt_reason: z.string().optional(),
  final_bag_sum: z.number(),
  created_at: z.string(),
}).strict();
export type RunMetadata = z.infer<typeof RunMetadataSchema>;

// ---------------------------------------------------------------------------
// Transition Dossier (formalized phase transition evidence)
// ---------------------------------------------------------------------------

export const TransitionDossierEntrySchema = z.object({
  candidate_id: z.string(),
  hint_type: z.enum(["zero_crossing", "sign_change", "threshold_crossing", "regime_transition"]),
  hint_evidence: z.object({
    metric: z.string(),
    a_value: z.number(),
    b_value: z.number(),
    detail: z.string(),
  }).strict(),
  run_a_id: z.string(),
  run_b_id: z.string(),
  compare_hash: z.string(),
  summary: z.object({
    top_scalar_deltas: z.array(z.object({
      metric: z.string(),
      delta: z.number(),
    }).strict()),
    top_opcode_deltas: z.array(z.object({
      opcode_id: z.string(),
      delta: z.number(),
    }).strict()),
    notes: z.string().optional(),
  }).strict(),
  paths: z.object({
    run_a_dir: z.string().optional(),
    run_b_dir: z.string().optional(),
  }).strict(),
  meta: z.object({
    engine_version: z.string(),
    schema_version: z.literal("transition_dossier.v1"),
  }).strict(),
}).strict();
export type TransitionDossierEntry = z.infer<typeof TransitionDossierEntrySchema>;

export const TransitionDossierSchema = z.object({
  schema_version: z.literal("transition_dossier.v1"),
  scan_hash: z.string(),
  entries: z.array(TransitionDossierEntrySchema),
}).strict();
export type TransitionDossier = z.infer<typeof TransitionDossierSchema>;

// ---------------------------------------------------------------------------
// Helper: create empty state
// ---------------------------------------------------------------------------

export function emptyState(): VmState {
  return { bags: {}, stack: [], flags: {}, notes: [] };
}
