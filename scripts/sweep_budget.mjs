#!/usr/bin/env node
// sweep_budget.mjs — Demonstrates real phase transitions via RNG-dependent selection
//
// Program uses 3 warm-up attract.select calls to diverge RNG state across seeds,
// then a critical attract.select picks from pool_low/mid/high.
// When mid or high is selected (>=100), contain.threshold + repel.reject halts.
// When low is selected (<100), the program completes normally.
// Result: ~40% of seeds complete, ~60% halt → clear phase transitions.

import { scanPhases, persistPhaseScan } from "../src/kb/vm_phase_scan.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const rngPhaseTransition = {
  program_id: "rng_phase_transition",
  version: "program.v1",
  opcodes: [
    // Seed three pools with different values
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_low", amount: 30 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_mid", amount: 200 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "pool_high", amount: 800 } },
    // RNG warm-up selections (consume RNG state to diverge across seeds)
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_a", amount: 1 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_b", amount: 2 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_a,warmup_b", into: "discard1" } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_c", amount: 3 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_d", amount: 4 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_c,warmup_d", into: "discard2" } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_e", amount: 5 } },
    { opcode_id: "attract.add", verb: "Attract", args: { bag: "warmup_f", amount: 6 } },
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "warmup_e,warmup_f", into: "discard3" } },
    // Critical selection — 4th rng() call, well-diverged across seeds
    { opcode_id: "attract.select", verb: "Attract", args: { candidates: "pool_low,pool_mid,pool_high", into: "chosen" } },
    // Decision gate
    { opcode_id: "contain.threshold", verb: "Contain", args: { bag: "chosen", threshold: 100, flag: "is_high" } },
    { opcode_id: "repel.reject", verb: "Repel", args: { flag: "is_high", reason: "high value selected — halting" } },
    // Only reached when pool_low was selected
    { opcode_id: "release.export", verb: "Release", args: { bag: "chosen" } },
    { opcode_id: "release.emit", verb: "Release", args: { message: "low value path complete" } },
  ],
};

// Sweep across 20 run_seed values to get a mix of halted/completed runs
const result = scanPhases({
  program: rngPhaseTransition,
  state0: { bags: {}, stack: [], flags: {}, notes: [] },
  base_env: { run_seed: 42, world_seed: 7, max_steps: 10000 },
  knobs: [
    { key: "run_seed", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
  ],
  options: { softHalt: true },
  scan_mode: "adaptive",
  adaptive: { max_refinements: 3, max_total_runs: 40 },
});

const scanDir = persistPhaseScan(result);

console.log("\n=== SWEEP RESULTS ===");
console.log("scan_dir:", scanDir);
console.log("grid_size:", result.scan_index.grid_size);
console.log("total_points:", result.scan_index.points.length);
console.log("hints:", result.phase_hints.hints.length);
console.log("dossier_entries:", result.formalized_dossier.entries.length);
console.log("adaptive_all_points:", result.adaptive?.all_points.length ?? "n/a");
console.log("adaptive_refinements:", result.adaptive?.refinements.length ?? "n/a");
console.log("adaptive_all_hints:", result.adaptive?.all_hints.length ?? "n/a");

// Show per-point summary
console.log("\n=== GRID POINTS ===");
for (const pt of result.scan_index.points) {
  const haltLabel = pt.metrics.halted_early ? "HALTED" : "OK";
  console.log(
    `  [${String(pt.index).padStart(2)}] run_seed=${String(pt.knob_values.run_seed).padStart(2)}  steps=${pt.metrics.total_steps}  bag_sum=${pt.metrics.final_bag_sum}  ${haltLabel}`
  );
}

// Show phase hints
if (result.phase_hints.hints.length > 0) {
  console.log("\n=== PHASE HINTS ===");
  for (const hint of result.phase_hints.hints) {
    console.log(`  ${hint.kind}: ${hint.metric}  a=${hint.a_value} b=${hint.b_value}  — ${hint.detail}`);
  }
} else {
  console.log("\n(no phase hints detected)");
}

// Show formalized dossier entries
if (result.formalized_dossier.entries.length > 0) {
  console.log("\n=== FORMALIZED DOSSIER ===");
  for (const entry of result.formalized_dossier.entries) {
    console.log(`  ${entry.candidate_id}: ${entry.hint_type}`);
    console.log(`    evidence: ${entry.hint_evidence.metric} a=${entry.hint_evidence.a_value} b=${entry.hint_evidence.b_value}`);
    if (entry.summary.top_scalar_deltas.length > 0) {
      console.log(`    top scalar deltas: ${entry.summary.top_scalar_deltas.map(d => `${d.metric}=${d.delta}`).join(", ")}`);
    }
    if (entry.summary.top_opcode_deltas.length > 0) {
      console.log(`    top opcode deltas: ${entry.summary.top_opcode_deltas.map(d => `${d.opcode_id}=${d.delta}`).join(", ")}`);
    }
  }
}

// Inspect persisted files
console.log("\n=== PERSISTED FILES ===");
const hintsPath = join(scanDir, "PHASE_HINTS.json");
const dossierPath = join(scanDir, "FORMALIZED_DOSSIER.json");
console.log("PHASE_HINTS.json exists:", existsSync(hintsPath));
console.log("FORMALIZED_DOSSIER.json exists:", existsSync(dossierPath));

if (existsSync(hintsPath)) {
  const hints = JSON.parse(readFileSync(hintsPath, "utf-8"));
  console.log(`  → ${hints.hints.length} hints persisted`);
}
if (existsSync(dossierPath)) {
  const dossier = JSON.parse(readFileSync(dossierPath, "utf-8"));
  console.log(`  → ${dossier.entries.length} dossier entries persisted`);
}
