import { z } from "zod";
import { VmProgramSchema, VmStateSchema, VmEnvSchema } from "./vm_types.js";
import type { VmResult } from "./vm_types.js";
import { execute, VmHaltError, VmInvariantError } from "./vm_engine.js";
import { listOpcodes, listOpcodesByVerb, getOpcode } from "./vm_registry.js";
import { persistRun, listRuns } from "./vm_run_store.js";
import { searchIndex } from "./vm_run_index.js";
import type { SearchResult } from "./vm_run_index.js";
import { searchScanIndex, loadScanIndex } from "./vm_scan_index.js";
import type { ScanSearchResult } from "./vm_scan_index.js";
import { compareRuns } from "./vm_compare.js";
import type { CompareResult } from "./vm_compare.js";
import { scanPhases } from "./vm_phase_scan.js";
import type { PhaseScanResult, Knob } from "./vm_phase_scan.js";
import { loadSignature, buildTopScans, buildTopTransitions, scoreScan } from "./vm_scan_rank.js";
import type { TopScansResult, TopTransitionsResult } from "./vm_scan_rank.js";
import { computeNoveltyScores } from "./vm_novelty.js";
import type { TopNovelScansResult } from "./vm_novelty.js";

// ---------------------------------------------------------------------------
// vm.execute hook
// ---------------------------------------------------------------------------

export const VmExecuteInputSchema = z
  .object({
    program: VmProgramSchema,
    state: VmStateSchema,
    env: VmEnvSchema,
    options: z
      .object({
        fullTrace: z.boolean().optional(),
        expectedBagTotal: z.number().int().optional(),
        maxStackDepth: z.number().int().positive().optional(),
        softHalt: z.boolean().optional(),
        persist: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function vmExecuteHook(
  args: unknown,
): Promise<(VmResult & { run_hash?: string }) | { error: string }> {
  const parsed = VmExecuteInputSchema.parse(args);
  try {
    const result = execute(parsed.program, parsed.state, parsed.env, parsed.options);

    if (parsed.options?.persist) {
      const { run_hash } = persistRun(
        parsed.program,
        parsed.state,
        parsed.env,
        result,
        parsed.options?.tags ? { tags: parsed.options.tags } : undefined,
      );
      return { ...result, run_hash };
    }

    return result;
  } catch (err) {
    if (err instanceof VmHaltError || err instanceof VmInvariantError) {
      return { error: err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// vm.list_opcodes hook
// ---------------------------------------------------------------------------

export async function vmListOpcodesHook(
  args: unknown,
): Promise<{
  opcodes: Array<{
    opcode_id: string;
    verb: string;
    description: string;
    required_args: string[];
  }>;
}> {
  const parsed = z
    .object({
      verb: z
        .enum(["Attract", "Contain", "Release", "Repel", "Transform"])
        .optional(),
    })
    .strict()
    .parse(args ?? {});

  const specs = parsed.verb
    ? listOpcodesByVerb(parsed.verb)
    : listOpcodes();

  return {
    opcodes: specs.map((s) => ({
      opcode_id: s.opcode_id,
      verb: s.verb,
      description: s.description,
      required_args: s.required_args,
    })),
  };
}

// ---------------------------------------------------------------------------
// vm.validate_program hook
// ---------------------------------------------------------------------------

export async function vmValidateProgramHook(
  args: unknown,
): Promise<{ valid: boolean; errors: string[] }> {
  const parsed = z.object({ program: z.unknown() }).strict().parse(args);
  const errors: string[] = [];

  let program;
  try {
    program = VmProgramSchema.parse(parsed.program);
  } catch (e: any) {
    return { valid: false, errors: [`Schema validation failed: ${e.message}`] };
  }

  for (let i = 0; i < program.opcodes.length; i++) {
    const op = program.opcodes[i];
    const spec = getOpcode(op.opcode_id);
    if (!spec) {
      errors.push(`Step ${i}: unknown opcode "${op.opcode_id}"`);
      continue;
    }
    if (spec.verb !== op.verb) {
      errors.push(
        `Step ${i}: verb mismatch for "${op.opcode_id}" — expected "${spec.verb}", got "${op.verb}"`,
      );
    }
    for (const req of spec.required_args) {
      if (!(req in op.args)) {
        errors.push(
          `Step ${i}: missing required arg "${req}" for "${op.opcode_id}"`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// vm.compare hook
// ---------------------------------------------------------------------------

const VmResultInlineSchema = z.object({
  state: VmStateSchema,
  trace: z.array(z.unknown()),
  metrics: z.unknown(),
}).passthrough();

export async function vmCompareHook(
  args: unknown,
): Promise<CompareResult | { error: string }> {
  const parsed = z
    .object({
      a: VmResultInlineSchema,
      b: VmResultInlineSchema,
      a_run_hash: z.string().optional(),
      b_run_hash: z.string().optional(),
      align: z.enum(["step", "opcode_signature", "milestone"]).optional(),
      milestones: z
        .object({
          opcode_ids: z.array(z.string()),
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(args);

  try {
    return compareRuns(
      parsed.a as unknown as VmResult,
      parsed.b as unknown as VmResult,
      {
        a_run_hash: parsed.a_run_hash,
        b_run_hash: parsed.b_run_hash,
        align: parsed.align,
        milestones: parsed.milestones,
      },
    );
  } catch (err: any) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// vm.phase_scan hook
// ---------------------------------------------------------------------------

const KnobSchema = z.object({
  key: z.string(),
  values: z.array(z.union([z.number(), z.string(), z.boolean()])),
});

export async function vmPhaseScanHook(
  args: unknown,
): Promise<PhaseScanResult | { error: string }> {
  const parsed = z
    .object({
      program: VmProgramSchema,
      state0: VmStateSchema,
      base_env: VmEnvSchema,
      knobs: z.array(KnobSchema),
      include_trace: z.boolean().optional(),
      options: z
        .object({
          softHalt: z.boolean().optional(),
          expectedBagTotal: z.number().int().optional(),
        })
        .strict()
        .optional(),
      scan_mode: z.enum(["grid", "adaptive", "hunt_boundaries"]).optional(),
      adaptive: z
        .object({
          max_refinements: z.number().int().nonnegative().optional(),
          max_total_runs: z.number().int().positive().optional(),
        })
        .strict()
        .optional(),
      boundary_hunt: z
        .object({
          max_refinements: z.number().int().nonnegative().optional(),
          max_total_runs: z.number().int().positive().optional(),
          expansion_steps: z.number().int().positive().optional(),
          expansion_factor: z.number().positive().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(args);

  try {
    return scanPhases({
      program: parsed.program,
      state0: parsed.state0,
      base_env: parsed.base_env,
      knobs: parsed.knobs as Knob[],
      include_trace: parsed.include_trace,
      options: parsed.options,
      scan_mode: parsed.scan_mode,
      adaptive: parsed.adaptive,
      boundary_hunt: parsed.boundary_hunt,
    });
  } catch (err: any) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// vm.list_runs hook
// ---------------------------------------------------------------------------

export async function vmListRunsHook(
  _args: unknown,
): Promise<{ runs: ReturnType<typeof listRuns> }> {
  return { runs: listRuns() };
}

// ---------------------------------------------------------------------------
// vm.search_runs hook
// ---------------------------------------------------------------------------

export async function vmSearchRunsHook(
  args: unknown,
): Promise<SearchResult> {
  const parsed = z
    .object({
      program_fingerprint: z.string().optional(),
      program_id: z.string().optional(),
      run_seed_min: z.number().int().optional(),
      run_seed_max: z.number().int().optional(),
      world_seed_min: z.number().int().optional(),
      world_seed_max: z.number().int().optional(),
      total_steps_min: z.number().int().optional(),
      total_steps_max: z.number().int().optional(),
      final_bag_sum_min: z.number().optional(),
      final_bag_sum_max: z.number().optional(),
      halted_early: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    .strict()
    .parse(args ?? {});

  return searchIndex(parsed);
}

// ---------------------------------------------------------------------------
// vm.search_scans hook
// ---------------------------------------------------------------------------

export async function vmSearchScansHook(
  args: unknown,
): Promise<ScanSearchResult> {
  const parsed = z
    .object({
      program_id: z.string().optional(),
      program_fingerprint: z.string().optional(),
      min_hints: z.number().int().nonnegative().optional(),
      max_hints: z.number().int().nonnegative().optional(),
      min_grid_points: z.number().int().nonnegative().optional(),
      max_grid_points: z.number().int().nonnegative().optional(),
      has_adaptive: z.boolean().optional(),
      halt_fraction_min: z.number().optional(),
      halt_fraction_max: z.number().optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    .strict()
    .parse(args ?? {});

  return searchScanIndex(parsed);
}

// ---------------------------------------------------------------------------
// vm.get_scan hook
// ---------------------------------------------------------------------------

export async function vmGetScanHook(
  args: unknown,
): Promise<{ found: boolean; record?: any; report_path?: string; signature_path?: string }> {
  const parsed = z
    .object({
      scan_id: z.string(),
    })
    .strict()
    .parse(args);

  const records = loadScanIndex();
  const record = records.find(
    (r) => r.scan_id === parsed.scan_id || r.scan_hash12 === parsed.scan_id,
  );

  if (!record) {
    return { found: false };
  }

  return {
    found: true,
    record,
    report_path: `${record.scan_dir}/PHASE_TRANSITION_REPORT.json`,
    signature_path: `${record.scan_dir}/SCAN_SIGNATURE.json`,
  };
}

// ---------------------------------------------------------------------------
// vm.top_scans hook
// ---------------------------------------------------------------------------

export async function vmTopScansHook(
  args: unknown,
): Promise<TopScansResult> {
  const parsed = z
    .object({
      limit: z.number().int().positive().default(50),
      program_id: z.string().optional(),
    })
    .strict()
    .parse(args ?? {});

  const records = loadScanIndex();
  const filtered = parsed.program_id
    ? records.filter((r) => r.program_id === parsed.program_id)
    : records;

  const signatures = filtered
    .map((r) => loadSignature(r.scan_dir))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return buildTopScans(signatures, parsed.limit);
}

// ---------------------------------------------------------------------------
// vm.top_transitions hook
// ---------------------------------------------------------------------------

export async function vmTopTransitionsHook(
  args: unknown,
): Promise<TopTransitionsResult> {
  const parsed = z
    .object({
      limit: z.number().int().positive().default(200),
      program_id: z.string().optional(),
    })
    .strict()
    .parse(args ?? {});

  const records = loadScanIndex();
  const filtered = parsed.program_id
    ? records.filter((r) => r.program_id === parsed.program_id)
    : records;

  const allEntries: Array<{
    entry: import("./vm_types.js").TransitionDossierEntry;
    scan_id: string;
    meanBagSum: number;
  }> = [];

  for (const rec of filtered) {
    const sig = loadSignature(rec.scan_dir);
    if (!sig || sig.counts.dossier_entries === 0) continue;

    // Load formalized dossier from disk
    const dossierPath = `${rec.scan_dir}/FORMALIZED_DOSSIER.json`;
    try {
      const { readFileSync } = await import("node:fs");
      const dossier = JSON.parse(readFileSync(dossierPath, "utf-8"));

      // Compute mean bag sum from scan index points
      const scanIndexPath = `${rec.scan_dir}/SCAN_INDEX.json`;
      const scanIndex = JSON.parse(readFileSync(scanIndexPath, "utf-8"));
      const points = scanIndex.points || [];
      const meanBagSum =
        points.length > 0
          ? points.reduce((s: number, p: any) => s + (p.metrics?.final_bag_sum ?? 0), 0) / points.length
          : 1;

      for (const entry of dossier.entries) {
        allEntries.push({
          entry,
          scan_id: rec.scan_id,
          meanBagSum,
        });
      }
    } catch {
      // skip if dossier not readable
    }
  }

  return buildTopTransitions(allEntries, parsed.limit);
}

// ---------------------------------------------------------------------------
// vm.top_novel_scans hook
// ---------------------------------------------------------------------------

export async function vmTopNovelScansHook(
  args: unknown,
): Promise<TopNovelScansResult> {
  const parsed = z
    .object({
      limit: z.number().int().positive().default(50),
      program_id: z.string().optional(),
    })
    .strict()
    .parse(args ?? {});

  const records = loadScanIndex();
  const filtered = parsed.program_id
    ? records.filter((r) => r.program_id === parsed.program_id)
    : records;

  const signatures = filtered
    .map((r) => loadSignature(r.scan_dir))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return computeNoveltyScores(signatures, parsed.limit);
}
