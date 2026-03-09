#!/usr/bin/env node
/**
 * Corpus Battery Runner
 *
 * Runs a bounded battery of phase scans generating a large corpus.
 * Each case produces all scan artifacts + human-readable reports.
 *
 * Usage:
 *   npx tsx scripts/corpus_battery.mjs [--tiny|--standard|--full]
 *
 * Tiers control sweep size:
 *   --tiny     5 seeds, 3 float knob pts, max 1 refinement, max 20 runs
 *   --standard 20 seeds, 5 float knob pts, max 3 refinements, max 100 runs (default)
 *   --full     50 seeds, 8 float knob pts, max 5 refinements, max 500 runs
 */

import { scanPhases, persistPhaseScan } from "../src/kb/vm_phase_scan.js";
import { loadScanData, buildReportModel, writeReport } from "./make_phase_transition_report.mjs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

export const TIERS = {
  tiny: { seeds: 5, float_pts: 3, max_refinements: 1, max_total_runs: 20 },
  standard: { seeds: 20, float_pts: 5, max_refinements: 3, max_total_runs: 100 },
  full: { seeds: 50, float_pts: 8, max_refinements: 5, max_total_runs: 500 },
};

// ---------------------------------------------------------------------------
// Program definitions
// ---------------------------------------------------------------------------

export const budgetAllocator = {
  program_id: "smoke_budget_allocator",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "total", amount: 1000 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "engineering", amount: 500 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "marketing", amount: 300 } },
    { opcode_id: "transform.convert", verb: "Transform", args: { source: "total", dest: "operations", amount: 200 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "engineering", min: 100, max: 600 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "marketing", min: 50, max: 400 } },
    { opcode_id: "contain.clamp", verb: "Contain", args: { bag: "operations", min: 50, max: 300 } },
    { opcode_id: "contain.threshold", verb: "Contain", args: { bag: "engineering", threshold: 400, flag: "eng_above_400" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "engineering" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "marketing" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "operations" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "budget allocation complete" } },
  ],
};

export const filterPipeline = {
  program_id: "smoke_filter_pipeline",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_a", amount: 80 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_b", amount: 30 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_c", amount: 95 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "item_d", amount: 10 } },
    { opcode_id: "repel.filter", verb: "Repel", args: { threshold: 50, bags_list: "item_a,item_b,item_c,item_d" } },
    { opcode_id: "contain.normalize", verb: "Contain", args: { bags_list: "item_a,item_b,item_c,item_d", target: 100 } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "filter pipeline complete" } },
  ],
};

export const provenanceCompiler = {
  program_id: "smoke_provenance_compiler",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "raw_signal", amount: 200 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "noise_floor", amount: 50 } },
    { opcode_id: "transform.derive", verb: "Transform", args: { source: "raw_signal", dest: "amplified", fn: "multiply", param: 3 } },
    { opcode_id: "transform.derive", verb: "Transform", args: { source: "noise_floor", dest: "noise_scaled", fn: "multiply", param: 2 } },
    { opcode_id: "transform.compose", verb: "Transform", args: { a: "amplified", b: "noise_scaled", into: "composite" } },
    { opcode_id: "contain.commit_to_stack", verb: "Contain", args: { bag: "composite" } },
    { opcode_id: "release.finalize", verb: "Release", args: { bag: "final_metric" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "final_metric" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "provenance compilation complete" } },
  ],
};

export const rngPhaseTransitionV2 = {
  program_id: "rng_phase_transition_v2",
  version: "program.v1",
  opcodes: [
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_low", amount: 30 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_mid", amount: 200 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_high", amount: 800 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_a", amount: 1 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_b", amount: 2 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_a,warmup_b", into: "discard1" } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_c", amount: 3 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_d", amount: 4 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_c,warmup_d", into: "discard2" } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_e", amount: 5 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_f", amount: 6 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_e,warmup_f", into: "discard3" } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "pool_low,pool_mid,pool_high", into: "chosen" } },
    { opcode_id: "contain.env_threshold", verb: "Contain", args: { bag: "chosen", threshold_key: "halt_threshold", flag: "is_high" } },
    { opcode_id: "repel.reject", verb: "Repel", args: { flag: "is_high", reason: "threshold exceeded — halting" } },
    { opcode_id: "release.export", verb: "Release", args: { bag: "chosen" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "low value path complete" } },
  ],
};

// ---------------------------------------------------------------------------
// Case builder
// ---------------------------------------------------------------------------

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function linspaceFloat(lo, hi, n) {
  if (n === 1) return [lo];
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    // Add 0.5 to ensure non-integer for isRefinableKnob
    return Math.round((lo + t * (hi - lo)) * 10) / 10 + 0.5;
  });
}

export function buildCases(tierName) {
  const tier = TIERS[tierName];
  if (!tier) throw new Error(`Unknown tier: ${tierName}`);

  const seeds = range(1, tier.seeds);
  const floatThresholds = linspaceFloat(10, 900, tier.float_pts);
  // Bracket points around known pool boundaries (30, 200, 800)
  const bracketThresholds = [25.5, 35.5, 195.5, 205.5, 795.5, 805.5];
  const thresholdsWithBrackets = [
    ...new Set([...floatThresholds, ...bracketThresholds]),
  ].sort((a, b) => a - b);
  const baseEnv = { run_seed: 1, world_seed: 7, max_steps: 10000 };

  return [
    // Case 1: rng_v2 seed sweep (grid)
    {
      name: "rng_v2_seed",
      program: rngPhaseTransitionV2,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: { ...baseEnv, params: { halt_threshold: 100 } },
      knobs: [{ key: "run_seed", values: seeds }],
      options: { softHalt: true },
    },

    // Case 2: rng_v2 threshold sweep (adaptive) — includes bracket points
    {
      name: "rng_v2_threshold",
      program: rngPhaseTransitionV2,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: baseEnv,
      knobs: [{ key: "halt_threshold", values: thresholdsWithBrackets }],
      options: { softHalt: true },
      scan_mode: "adaptive",
      adaptive: {
        max_refinements: tier.max_refinements,
        max_total_runs: tier.max_total_runs,
      },
    },

    // Case 3: rng_v2 mixed (seed × threshold grid)
    {
      name: "rng_v2_mixed",
      program: rngPhaseTransitionV2,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: baseEnv,
      knobs: [
        { key: "run_seed", values: seeds.slice(0, Math.min(3, seeds.length)) },
        { key: "halt_threshold", values: floatThresholds.slice(0, Math.min(3, floatThresholds.length)) },
      ],
      options: { softHalt: true },
    },

    // Case 4: budget allocator with varying max_steps
    {
      name: "budget_steps",
      program: budgetAllocator,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: { run_seed: 1, world_seed: 7, max_steps: 20 },
      knobs: [{ key: "max_steps", values: [1, 3, 5, 8, 12, 20] }],
    },

    // Case 5: filter pipeline control (no transitions expected)
    {
      name: "filter_control",
      program: filterPipeline,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: baseEnv,
      knobs: [{ key: "run_seed", values: seeds.slice(0, 3) }],
    },

    // Case 6: provenance compiler control (no transitions expected)
    {
      name: "provenance_control",
      program: provenanceCompiler,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: baseEnv,
      knobs: [{ key: "run_seed", values: seeds.slice(0, 3) }],
    },

    // Case 7: rng_v2 wide threshold sweep (more refinement)
    {
      name: "rng_v2_threshold_wide",
      program: rngPhaseTransitionV2,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: baseEnv,
      knobs: [{ key: "halt_threshold", values: linspaceFloat(1, 1000, tier.float_pts + 2) }],
      options: { softHalt: true },
      scan_mode: "adaptive",
      adaptive: {
        max_refinements: tier.max_refinements + 1,
        max_total_runs: tier.max_total_runs,
      },
    },

    // Case 8: budget allocator multi-seed × steps grid
    {
      name: "budget_multiseed",
      program: budgetAllocator,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: { run_seed: 1, world_seed: 7, max_steps: 20 },
      knobs: [
        { key: "run_seed", values: seeds.slice(0, 3) },
        { key: "max_steps", values: [5, 12] },
      ],
    },

    // Case 9: rng_v2 low thresholds (nearly all halt)
    {
      name: "rng_v2_low_threshold",
      program: rngPhaseTransitionV2,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: baseEnv,
      knobs: [{ key: "halt_threshold", values: [0.5, 5.5, 15.5, 25.5] }],
      options: { softHalt: true },
    },

    // Case 10: rng_v2 boundary hunt — expand + refine around phase boundaries
    {
      name: "rng_v2_boundary_hunt",
      program: rngPhaseTransitionV2,
      state0: { bags: {}, stack: [], flags: {}, notes: [] },
      base_env: baseEnv,
      knobs: [{ key: "halt_threshold", values: linspaceFloat(10, 900, tier.float_pts) }],
      options: { softHalt: true },
      scan_mode: "hunt_boundaries",
      boundary_hunt: {
        max_refinements: tier.max_refinements,
        max_total_runs: tier.max_total_runs,
        expansion_steps: 3,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Battery runner
// ---------------------------------------------------------------------------

export function runBattery(tierName, { quiet = false } = {}) {
  const cases = buildCases(tierName);
  const results = [];

  for (const casedef of cases) {
    const { name, ...scanDef } = casedef;
    const result = scanPhases(scanDef);
    const scanDir = persistPhaseScan(result);

    // Generate report
    const scanData = loadScanData(scanDir);
    const model = buildReportModel(scanData);
    writeReport(scanDir, model);

    const summary = {
      name,
      scanDir,
      scan_hash: result.scan_index.scan_hash.slice(0, 12),
      program_id: result.scan_index.program_id,
      grid_size: result.scan_index.grid_size,
      hints: result.phase_hints.hints.length,
      halted: result.scan_index.points.filter((p) => p.metrics.halted_early).length,
      completed: result.scan_index.points.filter((p) => !p.metrics.halted_early).length,
      adaptive: result.adaptive
        ? {
            refinements: result.adaptive.refinements.length,
            total_points: result.adaptive.all_points.length,
          }
        : null,
    };

    results.push(summary);

    if (!quiet) {
      const regime = `${summary.halted}H/${summary.completed}C`;
      const adaptiveStr = summary.adaptive
        ? ` [adaptive: ${summary.adaptive.refinements} refinements, ${summary.adaptive.total_points} pts]`
        : "";
      console.log(
        `  ${name.padEnd(22)} ${summary.scan_hash}  grid=${String(summary.grid_size).padStart(3)}  hints=${String(summary.hints).padStart(2)}  ${regime.padEnd(8)}${adaptiveStr}`,
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

const thisFile = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === thisFile ||
  process.argv[1]?.endsWith("/corpus_battery.mjs");

if (isMain) {
  const arg = process.argv[2] || "--standard";
  const tierName = arg.replace(/^--/, "");

  if (!TIERS[tierName]) {
    console.error(`Unknown tier: ${tierName}`);
    console.error("Usage: npx tsx scripts/corpus_battery.mjs [--tiny|--standard|--full]");
    process.exit(1);
  }

  const tier = TIERS[tierName];
  console.log(`\nCorpus Battery — ${tierName} tier`);
  console.log(`  seeds=${tier.seeds}  float_pts=${tier.float_pts}  max_refine=${tier.max_refinements}  max_runs=${tier.max_total_runs}\n`);

  const results = runBattery(tierName);

  console.log(`\nDone: ${results.length} cases completed.`);
  const totalHints = results.reduce((acc, r) => acc + r.hints, 0);
  const totalPoints = results.reduce((acc, r) => acc + r.grid_size, 0);
  console.log(`Total: ${totalPoints} grid points, ${totalHints} phase hints.\n`);
}
