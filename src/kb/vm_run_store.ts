/**
 * VM Run Store — persist, load, and list VM run artifacts.
 *
 * Each run is stored in `data/runs/<run_hash12>/` with 5 files:
 *   RUN_METADATA.json, TRACE.json, VM_METRICS.json, FINAL_STATE.json, RUN_SUMMARY.md
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash, canonicalize } from "./canonical.js";
import { appendToIndex } from "./vm_run_index.js";
import type {
  VmProgram,
  VmState,
  VmEnv,
  VmResult,
  VmMetrics,
  RunMetadata,
  TraceStep,
} from "./vm_types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNS_DIR = join("data", "runs");

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic identity of a run: hash of { program, state0, env }.
 */
export function computeRunHash(
  program: VmProgram,
  state0: VmState,
  env: VmEnv,
): string {
  return canonicalHash({
    program: program as unknown as Record<string, unknown>,
    state0: state0 as unknown as Record<string, unknown>,
    env: env as unknown as Record<string, unknown>,
  });
}

/**
 * Semantic identity of a program: hash of the full program object.
 */
export function computeProgramFingerprint(program: VmProgram): string {
  return canonicalHash(program as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

export type PersistRunResult = {
  run_hash: string;
  run_dir: string;
};

/**
 * Persist a completed VM run to disk as a 5-file folder.
 */
export function persistRun(
  program: VmProgram,
  state0: VmState,
  env: VmEnv,
  result: VmResult,
  options?: { tags?: string[] },
): PersistRunResult {
  const run_hash = computeRunHash(program, state0, env);
  const run_hash12 = run_hash.slice(0, 12);
  const run_dir = join(RUNS_DIR, run_hash12);

  mkdirSync(run_dir, { recursive: true });

  const initial_state_hash = canonicalHash(
    state0 as unknown as Record<string, unknown>,
  );
  const program_fingerprint = computeProgramFingerprint(program);

  const metadata: RunMetadata = {
    schema_version: "run.v1",
    run_hash,
    program_fingerprint,
    program_id: program.program_id,
    program_version: program.version,
    initial_state_hash,
    env,
    total_steps: result.metrics.total_steps,
    halted_early: result.metrics.halted_early,
    final_bag_sum: result.metrics.final_bag_sum,
    created_at: new Date().toISOString(),
  };
  if (result.metrics.halt_reason !== undefined) {
    metadata.halt_reason = result.metrics.halt_reason;
  }

  // Write deterministic artifacts (canonical JSON for reproducibility)
  writeFileSync(
    join(run_dir, "RUN_METADATA.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  writeFileSync(
    join(run_dir, "TRACE.json"),
    canonicalize(
      { trace: result.trace } as unknown as Record<string, unknown>,
    ) + "\n",
  );
  writeFileSync(
    join(run_dir, "VM_METRICS.json"),
    canonicalize(
      result.metrics as unknown as Record<string, unknown>,
    ) + "\n",
  );
  writeFileSync(
    join(run_dir, "FINAL_STATE.json"),
    canonicalize(
      result.state as unknown as Record<string, unknown>,
    ) + "\n",
  );

  // Derived artifact (human-readable, not hashed)
  const summary = generateRunSummary(metadata, result.metrics);
  writeFileSync(join(run_dir, "RUN_SUMMARY.md"), summary);

  // Append to run index
  appendToIndex(metadata, options?.tags);

  return { run_hash, run_dir };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export type LoadedRun = {
  metadata: RunMetadata;
  trace: TraceStep[];
  metrics: VmMetrics;
  finalState: VmState;
};

/**
 * Load a persisted run by its hash (full or 12-char prefix).
 * Returns null if the run folder doesn't exist.
 */
export function loadRun(runHash: string): LoadedRun | null {
  const prefix = runHash.slice(0, 12);
  const run_dir = join(RUNS_DIR, prefix);

  if (!existsSync(run_dir)) return null;

  const metadata: RunMetadata = JSON.parse(
    readFileSync(join(run_dir, "RUN_METADATA.json"), "utf-8"),
  );
  const traceWrapper = JSON.parse(
    readFileSync(join(run_dir, "TRACE.json"), "utf-8"),
  );
  const metrics: VmMetrics = JSON.parse(
    readFileSync(join(run_dir, "VM_METRICS.json"), "utf-8"),
  );
  const finalState: VmState = JSON.parse(
    readFileSync(join(run_dir, "FINAL_STATE.json"), "utf-8"),
  );

  return {
    metadata,
    trace: traceWrapper.trace,
    metrics,
    finalState,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * List all persisted runs, sorted by directory name (hash prefix).
 */
export function listRuns(): RunMetadata[] {
  if (!existsSync(RUNS_DIR)) return [];

  const entries = readdirSync(RUNS_DIR, { withFileTypes: true });
  const results: RunMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // skip _comparisons, _scans
    const metaPath = join(RUNS_DIR, entry.name, "RUN_METADATA.json");
    if (!existsSync(metaPath)) continue;
    try {
      const metadata: RunMetadata = JSON.parse(
        readFileSync(metaPath, "utf-8"),
      );
      results.push(metadata);
    } catch {
      // skip corrupted entries
    }
  }

  results.sort((a, b) =>
    a.run_hash.slice(0, 12).localeCompare(b.run_hash.slice(0, 12)),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable markdown summary of a run.
 */
export function generateRunSummary(
  metadata: RunMetadata,
  metrics: VmMetrics,
): string {
  const lines: string[] = [];
  lines.push(`# Run Summary`);
  lines.push(``);
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Run Hash | \`${metadata.run_hash.slice(0, 12)}\` |`);
  lines.push(`| Program | ${metadata.program_id} (${metadata.program_version}) |`);
  lines.push(`| Fingerprint | \`${metadata.program_fingerprint.slice(0, 12)}\` |`);
  lines.push(`| Total Steps | ${metrics.total_steps} |`);
  lines.push(`| Final Bag Sum | ${metrics.final_bag_sum} |`);
  lines.push(`| Halted Early | ${metrics.halted_early} |`);
  if (metrics.halt_reason) {
    lines.push(`| Halt Reason | ${metrics.halt_reason} |`);
  }
  lines.push(``);
  lines.push(`## Verb Distribution`);
  lines.push(``);
  lines.push(`| Verb | Count |`);
  lines.push(`|------|-------|`);
  for (const [verb, count] of Object.entries(metrics.verb_distribution)) {
    if (count > 0) {
      lines.push(`| ${verb} | ${count} |`);
    }
  }
  lines.push(``);
  lines.push(`## Opcode Frequency`);
  lines.push(``);
  lines.push(`| Opcode | Count |`);
  lines.push(`|--------|-------|`);
  for (const [opcode, count] of Object.entries(metrics.opcode_frequency)) {
    lines.push(`| ${opcode} | ${count} |`);
  }
  lines.push(``);
  lines.push(`## Environment`);
  lines.push(``);
  lines.push(`| Param | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| run_seed | ${metadata.env.run_seed} |`);
  lines.push(`| world_seed | ${metadata.env.world_seed} |`);
  lines.push(`| max_steps | ${metadata.env.max_steps} |`);
  if (metadata.env.params) {
    for (const [k, v] of Object.entries(metadata.env.params)) {
      lines.push(`| ${k} | ${v} |`);
    }
  }
  lines.push(``);

  return lines.join("\n") + "\n";
}
