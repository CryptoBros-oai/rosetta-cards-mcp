#!/usr/bin/env node
/**
 * Phase Transition Report Generator
 *
 * Reads a scan directory and produces:
 *   PHASE_TRANSITION_REPORT.md   — human-readable
 *   PHASE_TRANSITION_REPORT.json — structured summary for tooling
 *   PHASE_TRANSITION_REPORT.csv  — grid points for analysis
 *
 * Usage:
 *   npx tsx scripts/make_phase_transition_report.mjs <scan_dir>
 *
 * All outputs are deterministic except meta.generated_at.
 * Set REPORT_TIMESTAMP env var to override for tests.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export function loadScanData(scanDir) {
  const abs = resolve(scanDir);

  const scanIndex = JSON.parse(
    readFileSync(join(abs, "SCAN_INDEX.json"), "utf-8"),
  );
  const phaseHints = JSON.parse(
    readFileSync(join(abs, "PHASE_HINTS.json"), "utf-8"),
  );
  const formalizedDossier = JSON.parse(
    readFileSync(join(abs, "FORMALIZED_DOSSIER.json"), "utf-8"),
  );
  const transitionDossier = JSON.parse(
    readFileSync(join(abs, "TRANSITION_DOSSIER.json"), "utf-8"),
  );

  const refinedPath = join(abs, "PHASE_SCAN_REFINED.json");
  const refined = existsSync(refinedPath)
    ? JSON.parse(readFileSync(refinedPath, "utf-8"))
    : null;

  return { scanIndex, phaseHints, formalizedDossier, transitionDossier, refined };
}

// ---------------------------------------------------------------------------
// Knob type inference
// ---------------------------------------------------------------------------

function inferKnobType(values) {
  if (values.length === 0) return "unknown";
  const types = new Set(values.map((v) => typeof v));
  if (types.size > 1) return "mixed";
  const t = [...types][0];
  if (t === "number") {
    return values.some((v) => !Number.isInteger(v)) ? "float" : "integer";
  }
  return t; // "string" | "boolean"
}

function isRefinableFromValues(values) {
  if (!values.every((v) => typeof v === "number")) return false;
  return values.some((v) => !Number.isInteger(v));
}

// ---------------------------------------------------------------------------
// Report model builder (deterministic)
// ---------------------------------------------------------------------------

export function buildReportModel(scanData) {
  const { scanIndex, phaseHints, formalizedDossier, refined } = scanData;

  const timestamp =
    process.env.REPORT_TIMESTAMP || new Date().toISOString();

  // Extract program_id from scan fingerprint or first point
  // (not stored in scan_index directly, but in formalized_dossier meta if available)
  const engineVersion =
    formalizedDossier.entries.length > 0
      ? formalizedDossier.entries[0].meta.engine_version
      : "rks.v1";

  // Try to infer program_id from the scan data
  const programId = scanIndex.program_id || "unknown";

  // Knob metadata
  const knobs = scanIndex.knobs.map((k) => ({
    name: k.key,
    type: inferKnobType(k.values),
    refinable: isRefinableFromValues(k.values),
    values: k.values,
  }));

  // Regime proportions
  const points = scanIndex.points;
  const halted = points.filter((p) => p.metrics.halted_early).length;
  const completed = points.length - halted;
  const haltFraction =
    points.length > 0 ? Math.round((halted / points.length) * 10000) / 10000 : 0;

  // Transitions
  const transitions = formalizedDossier.entries.map((entry) => {
    const gatedOpcodes = entry.summary.top_opcode_deltas
      .filter((d) => d.delta !== 0)
      .map((d) => d.opcode_id);

    let mechanism;
    if (entry.hint_type === "sign_change" && entry.hint_evidence.metric === "halted_early") {
      const gatedStr =
        gatedOpcodes.length > 0
          ? `gating ${gatedOpcodes.length} opcodes (${gatedOpcodes.join(", ")})`
          : "with no opcode frequency change";
      mechanism = `Knob boundary causes halted_early to flip between points ${entry.candidate_id.replace("transition_", "").replace("_", " and ")}, ${gatedStr}.`;
    } else if (entry.hint_type === "threshold_crossing") {
      const aVal = entry.hint_evidence.a_value;
      const bVal = entry.hint_evidence.b_value;
      const pct =
        aVal !== 0
          ? Math.round((Math.abs(bVal - aVal) / Math.abs(aVal)) * 100)
          : "∞";
      mechanism = `${entry.hint_evidence.metric} shifted ${pct}% between points ${entry.candidate_id.replace("transition_", "").replace("_", " and ")}.`;
    } else if (entry.hint_type === "zero_crossing") {
      mechanism = `${entry.hint_evidence.metric} crosses zero between points ${entry.candidate_id.replace("transition_", "").replace("_", " and ")}.`;
    } else {
      mechanism = entry.hint_evidence.detail;
    }

    return {
      id: entry.candidate_id,
      hint_type: entry.hint_type,
      metric: entry.hint_evidence.metric,
      a_value: entry.hint_evidence.a_value,
      b_value: entry.hint_evidence.b_value,
      detail: entry.hint_evidence.detail,
      run_a_id: entry.run_a_id,
      run_b_id: entry.run_b_id,
      compare_hash: entry.compare_hash,
      top_scalar_deltas: entry.summary.top_scalar_deltas.slice(0, 5),
      top_opcode_deltas: entry.summary.top_opcode_deltas,
      mechanism,
    };
  });

  // Grid points (compact)
  const gridPoints = points.map((p) => ({
    index: p.index,
    knob_values: p.knob_values,
    total_steps: p.metrics.total_steps,
    final_bag_sum: p.metrics.final_bag_sum,
    halted_early: p.metrics.halted_early,
    halt_reason: p.metrics.halt_reason || null,
  }));

  // Adaptive metadata
  const adaptiveRefinements = refined
    ? refined.refinements.length
    : null;

  return {
    schema_version: "phase_transition_report.v1",
    meta: {
      scan_hash: scanIndex.scan_hash,
      scan_hash12: scanIndex.scan_hash.slice(0, 12),
      program_id: programId,
      program_fingerprint: scanIndex.program_fingerprint,
      engine_version: engineVersion,
      generated_at: timestamp,
    },
    summary: {
      grid_size: scanIndex.grid_size,
      total_hints: phaseHints.hints.length,
      dossier_entries: formalizedDossier.entries.length,
      adaptive_refinements: adaptiveRefinements,
      knobs,
    },
    regime_proportions: {
      halted,
      completed,
      total: points.length,
      halt_fraction: haltFraction,
    },
    transitions,
    grid_points: gridPoints,
  };
}

// ---------------------------------------------------------------------------
// Markdown generator
// ---------------------------------------------------------------------------

export function generateMarkdown(model) {
  const lines = [];

  lines.push("# Phase Transition Report");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|-------|-------|");
  lines.push(`| Scan Hash | \`${model.meta.scan_hash12}\` |`);
  lines.push(`| Program | ${model.meta.program_id} |`);
  lines.push(`| Program Fingerprint | \`${model.meta.program_fingerprint.slice(0, 12)}\` |`);
  lines.push(`| Engine | ${model.meta.engine_version} |`);
  lines.push(`| Generated | ${model.meta.generated_at} |`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Grid Points | ${model.summary.grid_size} |`);
  lines.push(`| Phase Hints | ${model.summary.total_hints} |`);
  lines.push(`| Dossier Entries | ${model.summary.dossier_entries} |`);
  if (model.summary.adaptive_refinements !== null) {
    lines.push(`| Adaptive Refinements | ${model.summary.adaptive_refinements} |`);
  }
  lines.push("");

  // Knobs
  lines.push("### Knobs");
  lines.push("");
  lines.push("| Name | Type | Refinable | Values |");
  lines.push("|------|------|-----------|--------|");
  for (const k of model.summary.knobs) {
    const vals =
      k.values.length > 8
        ? `${k.values.slice(0, 4).join(", ")} ... ${k.values.slice(-2).join(", ")} (${k.values.length} total)`
        : k.values.join(", ");
    lines.push(`| ${k.name} | ${k.type} | ${k.refinable} | ${vals} |`);
  }
  lines.push("");

  // Regime Proportions
  lines.push("## Regime Proportions");
  lines.push("");
  lines.push("| Regime | Count | Fraction |");
  lines.push("|--------|-------|----------|");
  lines.push(
    `| Halted | ${model.regime_proportions.halted} | ${(model.regime_proportions.halt_fraction * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| Completed | ${model.regime_proportions.completed} | ${((1 - model.regime_proportions.halt_fraction) * 100).toFixed(1)}% |`,
  );
  lines.push(`| Total | ${model.regime_proportions.total} | |`);
  lines.push("");

  // Transitions
  lines.push("## Transitions");
  lines.push("");

  if (model.transitions.length === 0) {
    lines.push("No phase transitions detected.");
    lines.push("");
  } else {
    for (const t of model.transitions) {
      lines.push(`### ${t.id}`);
      lines.push("");
      lines.push(`- **Type**: ${t.hint_type} on ${t.metric}`);
      lines.push(`- **Evidence**: a=${t.a_value}, b=${t.b_value}`);
      lines.push(`- **Detail**: ${t.detail}`);
      lines.push(`- **Mechanism**: ${t.mechanism}`);
      lines.push(`- **Compare Hash**: \`${t.compare_hash.slice(0, 12)}\``);

      if (t.top_scalar_deltas.length > 0) {
        lines.push(`- **Top Scalar Deltas**: ${t.top_scalar_deltas.map((d) => `${d.metric}=${d.delta}`).join(", ")}`);
      }
      if (t.top_opcode_deltas.length > 0) {
        lines.push(`- **Top Opcode Deltas**: ${t.top_opcode_deltas.map((d) => `${d.opcode_id}=${d.delta > 0 ? "+" : ""}${d.delta}`).join(", ")}`);
      }
      lines.push("");
    }
  }

  // Grid Points
  lines.push("## Grid Points");
  lines.push("");

  const knobNames = model.summary.knobs.map((k) => k.name);
  const header = ["Index", ...knobNames, "Steps", "Bag Sum", "Status"].join(
    " | ",
  );
  const separator = ["---", ...knobNames.map(() => "---"), "---", "---", "---"].join(
    " | ",
  );
  lines.push(`| ${header} |`);
  lines.push(`| ${separator} |`);

  for (const p of model.grid_points) {
    const knobVals = knobNames.map((n) =>
      p.knob_values[n] !== undefined ? String(p.knob_values[n]) : "",
    );
    const status = p.halted_early ? "HALTED" : "OK";
    const row = [p.index, ...knobVals, p.total_steps, p.final_bag_sum, status].join(
      " | ",
    );
    lines.push(`| ${row} |`);
  }
  lines.push("");

  // Artifact Links
  lines.push("## Artifact Links");
  lines.push("");
  lines.push("- SCAN_INDEX.json");
  lines.push("- PHASE_HINTS.json");
  lines.push("- FORMALIZED_DOSSIER.json");
  lines.push("- TRANSITION_DOSSIER.json");
  if (model.summary.adaptive_refinements !== null) {
    lines.push("- PHASE_SCAN_REFINED.json");
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON generator
// ---------------------------------------------------------------------------

export function generateJSON(model) {
  // Strip grid_points values array from knobs (too verbose) and halt_reason nulls
  const compact = {
    schema_version: model.schema_version,
    meta: model.meta,
    summary: {
      ...model.summary,
      knobs: model.summary.knobs.map(({ values, ...rest }) => rest),
    },
    regime_proportions: model.regime_proportions,
    transitions: model.transitions,
    grid_points: model.grid_points.map((p) => {
      const out = { ...p };
      if (out.halt_reason === null) delete out.halt_reason;
      return out;
    }),
  };
  return JSON.stringify(compact, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// CSV generator
// ---------------------------------------------------------------------------

export function generateCSV(model) {
  const knobNames = model.summary.knobs.map((k) => k.name);
  const header = ["index", ...knobNames, "total_steps", "final_bag_sum", "halted_early", "halt_reason"];
  const rows = [header.join(",")];

  for (const p of model.grid_points) {
    const knobVals = knobNames.map((n) => {
      const v = p.knob_values[n];
      return v !== undefined ? String(v) : "";
    });
    const reason = p.halt_reason ? `"${p.halt_reason.replace(/"/g, '""')}"` : "";
    const row = [
      p.index,
      ...knobVals,
      p.total_steps,
      p.final_bag_sum,
      p.halted_early,
      reason,
    ];
    rows.push(row.join(","));
  }

  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export function writeReport(outputDir, model) {
  writeFileSync(join(outputDir, "PHASE_TRANSITION_REPORT.md"), generateMarkdown(model));
  writeFileSync(join(outputDir, "PHASE_TRANSITION_REPORT.json"), generateJSON(model));
  writeFileSync(join(outputDir, "PHASE_TRANSITION_REPORT.csv"), generateCSV(model));
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

const thisFile = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === thisFile ||
  process.argv[1]?.endsWith("/make_phase_transition_report.mjs");

if (isMain) {
  const scanDir = process.argv[2];
  if (!scanDir) {
    console.error("Usage: npx tsx scripts/make_phase_transition_report.mjs <scan_dir>");
    process.exit(1);
  }
  if (!existsSync(scanDir)) {
    console.error(`Scan directory not found: ${scanDir}`);
    process.exit(1);
  }

  const data = loadScanData(scanDir);
  const model = buildReportModel(data);
  writeReport(scanDir, model);

  console.log(`Report generated in ${scanDir}:`);
  console.log(`  PHASE_TRANSITION_REPORT.md  (${generateMarkdown(model).length} bytes)`);
  console.log(`  PHASE_TRANSITION_REPORT.json (${generateJSON(model).length} bytes)`);
  console.log(`  PHASE_TRANSITION_REPORT.csv  (${generateCSV(model).length} bytes)`);
  console.log(`  ${model.summary.total_hints} transitions, ${model.regime_proportions.halted}/${model.regime_proportions.total} halted`);
}
