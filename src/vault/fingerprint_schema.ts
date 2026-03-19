/**
 * Model Fingerprint Schema — vault payload contract for LemWorld behavioral data.
 *
 * A model fingerprint captures the complete behavioral identity of a
 * model×quant combination as measured by the LemWorld research platform.
 * It carries enough information for both research consumption (LensForge
 * analysis) and production consumption (ThreadForge routing decisions).
 *
 * Identity rule (inherited from vault):
 *   id = sha256(canonicalize({ version: "artifact_v1", kind: "profile",
 *                              payload, tags, refs }))
 *
 * The payload includes all behavioral and performance data. Temporal fields
 * (sweep_date) live inside payload.sweep_source and are measurement metadata,
 * NOT wall-clock timestamps — they are safe for hashing because the same
 * sweep on the same date with the same results always produces the same card.
 *
 * Fields that vary between environments (hostname, GPU serial, instance ID)
 * belong in the vault envelope's `source` field, which is excluded from the
 * hash per IDENTITY_POLICY.
 */

import { z } from "zod";

// ── Constants ────────────────────────────────────────────────────────────────

export const FINGERPRINT_SCHEMA_VERSION = "model_fingerprint.v1" as const;

// ── Behavioral Vector ────────────────────────────────────────────────────────

/**
 * The 5-dimensional Rosetta Verb Grammar behavioral vector.
 * Values are normalized floats [0, 1] that sum to ~1.0 (within rounding).
 * Each dimension measures the proportion of a model's actions classified
 * under that verb across all RVG scenarios tested.
 */
export const BehavioralVectorSchema = z
  .object({
    contain: z.number().min(0).max(1),
    attract: z.number().min(0).max(1),
    release: z.number().min(0).max(1),
    repel: z.number().min(0).max(1),
    transform: z.number().min(0).max(1),
  })
  .strict();
export type BehavioralVector = z.infer<typeof BehavioralVectorSchema>;

// ── Behavioral Profile Labels ────────────────────────────────────────────────

/**
 * Behavioral profile labels derived from the dominant verb(s) in the vector.
 * These map to ThreadForge routing categories.
 *
 *   guardian    — Contain-dominant (Mistral family pattern)
 *   diplomat    — Attract-dominant, coalition-building (Qwen 2.5 pattern)
 *   negotiator  — Attract-dominant with balanced secondary (Qwen 3.x pattern)
 *   liberator   — Release-dominant, sharing/giving (Qwen 3.5 pattern)
 *   healer      — Attract + Contain balanced (Gemma family pattern)
 *   sentinel    — Repel-dominant, boundary-enforcing
 *   catalyst    — Transform-dominant, change-driving
 *   altruist    — Release + Attract co-dominant
 *   balanced    — No dominant verb (even spread, e.g. Phi-4)
 */
export const BehavioralProfileSchema = z.enum([
  "guardian",
  "diplomat",
  "negotiator",
  "liberator",
  "healer",
  "sentinel",
  "catalyst",
  "altruist",
  "balanced",
]);
export type BehavioralProfile = z.infer<typeof BehavioralProfileSchema>;

// ── Quantization Verdict ─────────────────────────────────────────────────────

/**
 * Quantization verdict from BV-based evaluation.
 *
 *   safe      — BV delta < 0.05, behavioral identity preserved
 *   degraded  — BV delta 0.05–0.20, measurable shift but usable
 *   broken    — BV delta > 0.20 or profile flip, not production-safe
 *   untested  — No quant comparison available (FP16 baseline only)
 */
export const QuantVerdictSchema = z.enum([
  "safe",
  "degraded",
  "broken",
  "untested",
]);
export type QuantVerdict = z.infer<typeof QuantVerdictSchema>;

// ── AP Metrics ───────────────────────────────────────────────────────────────

/**
 * Adversarial Phenomenology metrics from the 47-probe battery.
 * All values are normalized floats [0, 1].
 */
export const APMetricsSchema = z
  .object({
    vocabulary_richness: z.number().min(0).max(1),
    creative_output: z.number().min(0).max(1),
    snapback_score: z.number().min(0).max(1),
  })
  .strict();
export type APMetrics = z.infer<typeof APMetricsSchema>;

// ── Throughput Profile ───────────────────────────────────────────────────────

/**
 * Performance data from inference benchmarking.
 * This data is measurement-specific (varies by GPU) but deterministic
 * for the same model×quant×GPU combination.
 */
export const ThroughputProfileSchema = z
  .object({
    tok_per_sec: z.number().positive(),
    gpu_tested: z.string().min(1),
    vram_consumed_gb: z.number().positive(),
    max_context_tested: z.number().int().positive(),
    tensor_parallel: z.number().int().positive().optional(),
    speculative_draft: z.string().optional(),
  })
  .strict();
export type ThroughputProfile = z.infer<typeof ThroughputProfileSchema>;

// ── Sweep Source ─────────────────────────────────────────────────────────────

/**
 * Research provenance within the payload. This is measurement metadata,
 * not environmental — the same sweep run on the same date with the same
 * scenarios always produces the same source block.
 */
export const SweepSourceSchema = z
  .object({
    lem_issue: z.string().min(1),
    sweep_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    scenarios_tested: z.number().int().positive(),
    temperatures_tested: z.array(z.number()).optional(),
  })
  .strict();
export type SweepSource = z.infer<typeof SweepSourceSchema>;

// ── Full Fingerprint Payload ─────────────────────────────────────────────────

/**
 * Complete model fingerprint payload for vault storage.
 *
 * Usage:
 *   await vaultPut({
 *     kind: "profile",
 *     payload: ModelFingerprintPayloadSchema.parse(data),
 *     tags: buildFingerprintTags(data),
 *     refs: [],
 *     source: { agent: "lemworld-sweep", tool: "rv_battery", run_id: "..." },
 *   });
 */
export const ModelFingerprintPayloadSchema = z
  .object({
    // Schema identifier (for vault queries and versioning)
    schema: z.literal(FINGERPRINT_SCHEMA_VERSION),

    // Model identity
    model_family: z.string().min(1),
    model_name: z.string().min(1),
    model_size_b: z.number().positive(),
    architecture: z.string().optional(), // "transformer", "ssm", "hybrid"

    // Quantization
    quant_method: z.enum(["fp16", "bf16", "fp32", "gptq", "awq", "gguf", "exl2", "none"]),
    quant_level: z.enum(["fp16", "bf16", "fp32", "int8", "int4", "int3", "int2", "q8_0", "q6_k", "q5_k_m", "q4_k_m", "q3_k_m", "q2_k", "none"]),

    // Behavioral measurement (RVG)
    behavioral_vector: BehavioralVectorSchema,
    behavioral_profile: BehavioralProfileSchema,

    // Quantization impact
    quant_verdict: QuantVerdictSchema,
    quant_delta: z.number().min(0).max(2), // BV euclidean distance from FP16 baseline
    baseline_card_hash: z.string().optional(), // hash of the FP16 baseline card, if this is a quant variant

    // Adversarial Phenomenology
    ap_metrics: APMetricsSchema,

    // Performance
    throughput: ThroughputProfileSchema,

    // Routing intelligence
    routing_fitness: z.array(z.string()), // task categories this model is fit for
    routing_exclusions: z.array(z.string()), // task categories to avoid

    // Research provenance (deterministic — same inputs = same values)
    sweep_source: SweepSourceSchema,
  })
  .strict();
export type ModelFingerprintPayload = z.infer<typeof ModelFingerprintPayloadSchema>;

// ── Tag Builder ──────────────────────────────────────────────────────────────

/**
 * Build standardized tags for a fingerprint artifact.
 * Tags enable efficient vault.search queries:
 *   vault.search({ tags: ["model:gemma-27b", "quant:int4"] })
 */
export function buildFingerprintTags(fp: ModelFingerprintPayload): string[] {
  const tags: string[] = [
    `schema:${FINGERPRINT_SCHEMA_VERSION}`,
    `model:${fp.model_family}-${fp.model_size_b}b`,
    `family:${fp.model_family}`,
    `quant:${fp.quant_level}`,
    `method:${fp.quant_method}`,
    `verdict:${fp.quant_verdict}`,
    `profile:${fp.behavioral_profile}`,
  ];

  // Add architecture tag if present
  if (fp.architecture) {
    tags.push(`arch:${fp.architecture}`);
  }

  // Add routing fitness tags
  for (const fit of fp.routing_fitness) {
    tags.push(`fit:${fit}`);
  }

  // Add tier recommendation based on throughput + quality
  if (fp.throughput.tok_per_sec >= 100 && fp.quant_verdict !== "broken") {
    tags.push("tier:bronze-eligible");
  }
  if (fp.throughput.tok_per_sec >= 40 && fp.quant_verdict !== "broken") {
    tags.push("tier:silver-eligible");
  }
  if (fp.quant_verdict !== "broken") {
    tags.push("tier:gold-eligible");
  }

  return tags.sort();
}

// ── Convenience Builder ──────────────────────────────────────────────────────

/**
 * Build a complete vault.put input from a fingerprint payload.
 * Validates the payload, builds tags, and returns a ready-to-store object.
 *
 * Usage:
 *   const input = buildFingerprintPutInput(data, {
 *     agent: "lemworld-sweep",
 *     tool: "rv_battery",
 *     run_id: "run_abc123",
 *   });
 *   const result = await vaultPut(input);
 */
export function buildFingerprintPutInput(
  data: ModelFingerprintPayload,
  source?: { agent?: string; tool?: string; repo?: string; run_id?: string },
): {
  kind: "profile";
  payload: Record<string, unknown>;
  tags: string[];
  refs: Array<{ kind: string; id: string }>;
  source?: { agent?: string; tool?: string; repo?: string; run_id?: string };
} {
  // Validate
  const validated = ModelFingerprintPayloadSchema.parse(data);

  return {
    kind: "profile",
    payload: validated as unknown as Record<string, unknown>,
    tags: buildFingerprintTags(validated),
    refs: validated.baseline_card_hash
      ? [{ kind: "profile", id: validated.baseline_card_hash }]
      : [],
    ...(source ? { source } : {}),
  };
}
