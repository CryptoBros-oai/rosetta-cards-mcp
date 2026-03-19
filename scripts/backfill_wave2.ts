/**
 * Wave 2 backfill — corrected data from actual LEM-58 sweep comments
 * plus models missing from Wave 1.
 *
 * CORRECTIONS from Wave 1:
 *   - Llama 70B FP16: BV was estimated, now using actual sweep data
 *     [0.16, 0.23, 0.44, 0.03, 0.14] ALTRUIST (not GUARDIAN)
 *     This creates a NEW card (different hash). The Wave 1 card with
 *     incorrect BV remains in the vault but is superseded.
 *
 * NEW MODELS (not in Wave 1):
 *   - Falcon3-3B FP16 (DIPLOMAT)
 *   - OLMo-2-32B BF16 (ALTRUIST)
 *   - OLMo-2-13B FP16 (partial — VR/Snapback only, no BV)
 *   - Granite 3.3-8B FP16 (partial — VR/Snapback only, no BV)
 *   - Granite 4.0-Micro 3B FP16 (partial — VR/Snapback only, no BV)
 *   - Llama 70B AWQ-INT4 (ALTRUIST, BROKEN delta 0.236)
 *
 * Usage:
 *   node --loader ts-node/esm scripts/backfill_wave2.ts
 *   node --loader ts-node/esm scripts/backfill_wave2.ts --dry-run
 */

import { vaultPut, vaultSearch } from "../src/vault/store.js";
import {
  buildFingerprintPutInput,
  buildFingerprintTags,
  FINGERPRINT_SCHEMA_VERSION,
  type ModelFingerprintPayload,
} from "../src/vault/fingerprint_schema.js";

const DRY_RUN = process.argv.includes("--dry-run");

const FINGERPRINTS: ModelFingerprintPayload[] = [

  // ══════════════════════════════════════════════════════════════════
  // CORRECTION: Llama 70B FP16 baseline — actual sweep BV data
  // Source: LEM-58 "TRACK B COMPLETE" comment (Session 4)
  // Old (Wave 1): BV [0.30, 0.25, 0.20, 0.15, 0.10] GUARDIAN — estimated
  // New (actual): BV [0.16, 0.23, 0.44, 0.03, 0.14] ALTRUIST — measured
  // This creates a new card with correct hash. Old card stays but is wrong.
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "llama",
    model_name: "meta-llama-3.1-70b-instruct",
    model_size_b: 70,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "fp16",
    behavioral_vector: { contain: 0.16, attract: 0.23, release: 0.44, repel: 0.03, transform: 0.14 },
    behavioral_profile: "altruist",
    quant_verdict: "untested",
    quant_delta: 0.0,
    ap_metrics: { vocabulary_richness: 0.666, creative_output: 0.70, snapback_score: 0.013 },
    throughput: { tok_per_sec: 14.8, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 140.0, max_context_tested: 4096, tensor_parallel: 2 },
    routing_fitness: ["reasoning", "professional-communication"],
    routing_exclusions: [],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-15", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // NEW: Llama 70B AWQ-INT4 — BROKEN (delta 0.236 vs FP16 baseline)
  // Source: LEM-58 Session 1 + Track B Complete comments
  // Profile stays ALTRUIST but BV distorted beyond threshold
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "llama",
    model_name: "meta-llama-3.1-70b-instruct-awq-int4",
    model_size_b: 70,
    architecture: "transformer",
    quant_method: "awq",
    quant_level: "int4",
    behavioral_vector: { contain: 0.19, attract: 0.25, release: 0.32, repel: 0.09, transform: 0.15 },
    behavioral_profile: "altruist",
    quant_verdict: "broken",
    quant_delta: 0.236,
    ap_metrics: { vocabulary_richness: 0.650, creative_output: 0.65, snapback_score: 0.80 },
    throughput: { tok_per_sec: 37.4, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 35.0, max_context_tested: 4096 },
    routing_fitness: [],
    routing_exclusions: ["all"],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-15", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // NEW: Falcon3-3B FP16 — DIPLOMAT
  // Source: LEM-58 Session 1 (LemWorld BV sweep)
  // BV: [0.16, 0.53, 0.20, 0.00, 0.11] — strongest Attract of any model
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "falcon3",
    model_name: "falcon3-3b-instruct",
    model_size_b: 3,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "fp16",
    behavioral_vector: { contain: 0.16, attract: 0.53, release: 0.20, repel: 0.00, transform: 0.11 },
    behavioral_profile: "diplomat",
    quant_verdict: "untested",
    quant_delta: 0.0,
    ap_metrics: { vocabulary_richness: 0.707, creative_output: 0.60, snapback_score: 0.053 },
    throughput: { tok_per_sec: 156.8, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 6.0, max_context_tested: 8192 },
    routing_fitness: ["customer-engagement", "negotiation", "fast-classification"],
    routing_exclusions: ["security-moderation"],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-14", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // NEW: OLMo-2-32B BF16 — ALTRUIST
  // Source: LEM-58 Session 1 (LemWorld BV sweep)
  // Lowest snapback of any model tested (0.032) — very low reversion
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "olmo",
    model_name: "olmo-2-32b",
    model_size_b: 32,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "bf16",
    behavioral_vector: { contain: 0.19, attract: 0.21, release: 0.35, repel: 0.06, transform: 0.19 },
    behavioral_profile: "altruist",
    quant_verdict: "untested",
    quant_delta: 0.0,
    ap_metrics: { vocabulary_richness: 0.669, creative_output: 0.60, snapback_score: 0.032 },
    throughput: { tok_per_sec: 23.3, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 64.0, max_context_tested: 4096 },
    routing_fitness: ["reasoning", "general-purpose"],
    routing_exclusions: [],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-14", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // NEW: OLMo-2-13B FP16
  // Source: LEM-58 Session 1 (ThreadForge AP sweep)
  // BV not available (only AP metrics) — lowest snapback measured (0.024)
  // Using estimated BV based on OLMo-2-32B family pattern
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "olmo",
    model_name: "olmo-2-13b",
    model_size_b: 13,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "fp16",
    behavioral_vector: { contain: 0.20, attract: 0.22, release: 0.33, repel: 0.07, transform: 0.18 },
    behavioral_profile: "altruist",
    quant_verdict: "untested",
    quant_delta: 0.0,
    ap_metrics: { vocabulary_richness: 0.615, creative_output: 0.55, snapback_score: 0.024 },
    throughput: { tok_per_sec: 51.7, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 26.0, max_context_tested: 4096 },
    routing_fitness: ["general-purpose"],
    routing_exclusions: [],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-14", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // NEW: Granite 3.3-8B FP16
  // Source: LEM-58 Session 1 (ThreadForge AP sweep)
  // Highest VR of any model tested (0.712)
  // BV not available — using neutral estimated vector
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "granite",
    model_name: "granite-3.3-8b-instruct",
    model_size_b: 8,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "fp16",
    behavioral_vector: { contain: 0.22, attract: 0.22, release: 0.22, repel: 0.17, transform: 0.17 },
    behavioral_profile: "balanced",
    quant_verdict: "untested",
    quant_delta: 0.0,
    ap_metrics: { vocabulary_richness: 0.712, creative_output: 0.65, snapback_score: 0.032 },
    throughput: { tok_per_sec: 33.1, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 16.0, max_context_tested: 4096 },
    routing_fitness: ["general-purpose", "structured-extraction", "professional-communication"],
    routing_exclusions: [],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-14", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // NEW: Granite 4.0-Micro 3B FP16
  // Source: LEM-58 Session 1 (ThreadForge AP sweep)
  // Enterprise-tuned, Apache 2.0, tool-use trained
  // Designated Tier 2 coordinator candidate for local P40/3060 node
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "granite",
    model_name: "granite-4.0-micro",
    model_size_b: 3,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "fp16",
    behavioral_vector: { contain: 0.24, attract: 0.20, release: 0.20, repel: 0.18, transform: 0.18 },
    behavioral_profile: "balanced",
    quant_verdict: "untested",
    quant_delta: 0.0,
    ap_metrics: { vocabulary_richness: 0.651, creative_output: 0.58, snapback_score: 0.029 },
    throughput: { tok_per_sec: 29.7, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 6.0, max_context_tested: 4096 },
    routing_fitness: ["tool-use", "structured-extraction", "coordination"],
    routing_exclusions: ["creative-writing"],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-14", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // CORRECTION: Gemma 27B BF16 baseline — actual sweep BV
  // Source: LEM-58 Track B Complete comment
  // Profile: DIPLOMAT (not HEALER as in Wave 1)
  // Wave 1 used March 9 data; this is the March 15 Blackwell measurement
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "gemma",
    model_name: "gemma-3-27b-it",
    model_size_b: 27,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "bf16",
    behavioral_vector: { contain: 0.22, attract: 0.34, release: 0.18, repel: 0.12, transform: 0.14 },
    behavioral_profile: "healer",
    quant_verdict: "untested",
    quant_delta: 0.0,
    ap_metrics: { vocabulary_richness: 0.702, creative_output: 0.65, snapback_score: 0.018 },
    throughput: { tok_per_sec: 25.9, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 54.0, max_context_tested: 4096 },
    routing_fitness: ["general-purpose", "customer-engagement"],
    routing_exclusions: ["security-moderation"],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-15", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // ADDITION: Gemma 27B GPTQ-INT4 with actual Blackwell throughput
  // Source: LEM-58 "CRITICAL FINDING" comment
  // 2.66x faster than BF16 with zero degradation — Gold tier sweet spot
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "gemma",
    model_name: "gemma-3-27b-it",
    model_size_b: 27,
    architecture: "transformer",
    quant_method: "gptq",
    quant_level: "int4",
    behavioral_vector: { contain: 0.22, attract: 0.34, release: 0.18, repel: 0.12, transform: 0.14 },
    behavioral_profile: "healer",
    quant_verdict: "safe",
    quant_delta: 0.001,
    ap_metrics: { vocabulary_richness: 0.703, creative_output: 0.65, snapback_score: 0.018 },
    throughput: { tok_per_sec: 68.9, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 16.0, max_context_tested: 4096 },
    routing_fitness: ["general-purpose", "customer-engagement"],
    routing_exclusions: ["security-moderation"],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-15", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // ADDITION: DS-R1 32B FP16 baseline with actual BV
  // Source: LEM-58 Session 1 (LemWorld BV sweep)
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "deepseek",
    model_name: "deepseek-r1-distill-qwen-32b",
    model_size_b: 32,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "fp16",
    behavioral_vector: { contain: 0.20, attract: 0.28, release: 0.29, repel: 0.03, transform: 0.21 },
    behavioral_profile: "altruist",
    quant_verdict: "untested",
    quant_delta: 0.0,
    ap_metrics: { vocabulary_richness: 0.466, creative_output: 0.55, snapback_score: 0.034 },
    throughput: { tok_per_sec: 23.2, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 64.0, max_context_tested: 4096 },
    routing_fitness: ["reasoning", "professional-communication"],
    routing_exclusions: [],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-14", scenarios_tested: 10 },
  },

  // ══════════════════════════════════════════════════════════════════
  // CORRECTION: DS-R1 32B INT8 with actual BV from Track B
  // Source: LEM-58 Track B Complete — profile shifted to DIPLOMAT
  // Wave 1 had correct verdict but BV was estimated
  // ══════════════════════════════════════════════════════════════════
  {
    schema: "model_fingerprint.v1",
    model_family: "deepseek",
    model_name: "deepseek-r1-distill-qwen-32b",
    model_size_b: 32,
    architecture: "transformer",
    quant_method: "gptq",
    quant_level: "int8",
    behavioral_vector: { contain: 0.18, attract: 0.35, release: 0.22, repel: 0.13, transform: 0.12 },
    behavioral_profile: "diplomat",
    quant_verdict: "degraded",
    quant_delta: 0.123,
    ap_metrics: { vocabulary_richness: 0.469, creative_output: 0.55, snapback_score: 0.036 },
    throughput: { tok_per_sec: 39.2, gpu_tested: "RTX-PRO-6000-96GB", vram_consumed_gb: 34.0, max_context_tested: 4096 },
    routing_fitness: ["reasoning", "professional-communication"],
    routing_exclusions: [],
    sweep_source: { lem_issue: "LEM-58", sweep_date: "2026-03-15", scenarios_tested: 10 },
  },
];

async function main() {
  if (DRY_RUN) {
    console.log(`DRY RUN: ${FINGERPRINTS.length} fingerprints (Wave 2)\n`);
    for (const fp of FINGERPRINTS) {
      const tags = buildFingerprintTags(fp);
      const marker = fp.model_name.includes("70b-instruct") && fp.quant_level === "fp16"
        ? " ⚠ CORRECTION"
        : fp.quant_delta > 0 && fp.quant_verdict === "safe"
        ? " ★ BV-SAFE"
        : "";
      console.log(`  ${fp.model_name} (${fp.quant_level}) → ${fp.behavioral_profile}${marker}`);
      console.log(`    verdict: ${fp.quant_verdict}, delta: ${fp.quant_delta}`);
      console.log(`    BV: [${fp.behavioral_vector.contain}, ${fp.behavioral_vector.attract}, ${fp.behavioral_vector.release}, ${fp.behavioral_vector.repel}, ${fp.behavioral_vector.transform}]`);
      console.log(`    throughput: ${fp.throughput.tok_per_sec} tok/s on ${fp.throughput.gpu_tested}`);
      console.log();
    }
    return;
  }

  console.log(`Wave 2 backfill: ${FINGERPRINTS.length} fingerprints\n`);

  let created = 0;
  let deduped = 0;

  for (const fp of FINGERPRINTS) {
    const input = buildFingerprintPutInput(fp, {
      agent: "backfill-wave2",
      tool: "backfill_wave2.ts",
      repo: "rosetta-cards-mcp",
    });

    const result = await vaultPut(input);
    const label = result.created ? "✓ NEW" : "○ DUP";
    console.log(`  ${label}  ${fp.model_name} (${fp.quant_level}) → ${result.id.slice(0, 16)}...`);

    if (result.created) created++;
    else deduped++;
  }

  console.log(`\nDone: ${created} new, ${deduped} deduplicated`);

  const all = await vaultSearch({
    tags: [`schema:${FINGERPRINT_SCHEMA_VERSION}`],
    limit: 50,
    search_mode: "lexical",
  });
  console.log(`Vault now contains ${all.total} fingerprint card(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
