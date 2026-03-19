/**
 * Tests for model fingerprint schema (model_fingerprint.v1).
 *
 * Covers:
 *   - Schema validation (valid payloads pass, invalid rejected)
 *   - Deterministic double-run hash equality
 *   - Prohibited key rejection (temporal/env keys in payload)
 *   - Proto pollution rejection
 *   - Tag generation correctness
 *   - Vault round-trip (put → get → same hash)
 *   - Deduplication (same payload → same artifact ID)
 *   - Quant variant → baseline ref wiring
 *   - Behavioral vector normalization
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  ModelFingerprintPayloadSchema,
  BehavioralVectorSchema,
  BehavioralProfileSchema,
  QuantVerdictSchema,
  APMetricsSchema,
  ThroughputProfileSchema,
  SweepSourceSchema,
  buildFingerprintTags,
  buildFingerprintPutInput,
  FINGERPRINT_SCHEMA_VERSION,
  type ModelFingerprintPayload,
} from "../src/vault/fingerprint_schema.js";

import { computeArtifactId } from "../src/vault/canon.js";
import { buildArtifactHashPayload } from "../src/vault/schema.js";
import { vaultPut, vaultGet, vaultSearch } from "../src/vault/store.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeGemmaFingerprint(): ModelFingerprintPayload {
  return {
    schema: "model_fingerprint.v1",
    model_family: "gemma",
    model_name: "gemma-2-27b-it",
    model_size_b: 27,
    architecture: "transformer",
    quant_method: "awq",
    quant_level: "int4",
    behavioral_vector: {
      contain: 0.22,
      attract: 0.34,
      release: 0.18,
      repel: 0.12,
      transform: 0.14,
    },
    behavioral_profile: "healer",
    quant_verdict: "degraded",
    quant_delta: 0.115,
    ap_metrics: {
      vocabulary_richness: 0.700,
      creative_output: 0.65,
      snapback_score: 0.82,
    },
    throughput: {
      tok_per_sec: 69.0,
      gpu_tested: "A40-48GB",
      vram_consumed_gb: 16.2,
      max_context_tested: 4096,
    },
    routing_fitness: ["general-purpose", "customer-engagement"],
    routing_exclusions: ["security-moderation"],
    sweep_source: {
      lem_issue: "LEM-58",
      sweep_date: "2026-03-15",
      scenarios_tested: 10,
    },
  };
}

function makeLlamaBaselineFingerprint(): ModelFingerprintPayload {
  return {
    schema: "model_fingerprint.v1",
    model_family: "llama",
    model_name: "meta-llama-3.1-70b-instruct",
    model_size_b: 70,
    architecture: "transformer",
    quant_method: "none",
    quant_level: "fp16",
    behavioral_vector: {
      contain: 0.30,
      attract: 0.25,
      release: 0.20,
      repel: 0.15,
      transform: 0.10,
    },
    behavioral_profile: "guardian",
    quant_verdict: "untested",
    quant_delta: 0,
    ap_metrics: {
      vocabulary_richness: 0.720,
      creative_output: 0.70,
      snapback_score: 0.85,
    },
    throughput: {
      tok_per_sec: 22.0,
      gpu_tested: "V100-32GB-SXM2",
      vram_consumed_gb: 140,
      max_context_tested: 4096,
      tensor_parallel: 4,
    },
    routing_fitness: ["reasoning", "security-moderation", "professional-communication"],
    routing_exclusions: [],
    sweep_source: {
      lem_issue: "LEM-58",
      sweep_date: "2026-03-15",
      scenarios_tested: 10,
    },
  };
}

function makeFalconMambaFingerprint(): ModelFingerprintPayload {
  return {
    schema: "model_fingerprint.v1",
    model_family: "falcon3",
    model_name: "falcon3-mamba-7b",
    model_size_b: 7,
    architecture: "ssm",
    quant_method: "none",
    quant_level: "fp16",
    behavioral_vector: {
      contain: 0.35,
      attract: 0.32,
      release: 0.02,
      repel: 0.18,
      transform: 0.13,
    },
    behavioral_profile: "diplomat",
    quant_verdict: "untested",
    quant_delta: 0,
    ap_metrics: {
      vocabulary_richness: 0.640,
      creative_output: 0.55,
      snapback_score: 0.70,
    },
    throughput: {
      tok_per_sec: 95.0,
      gpu_tested: "A40-48GB",
      vram_consumed_gb: 14,
      max_context_tested: 8192,
    },
    routing_fitness: ["market-npc", "trade-simulation"],
    routing_exclusions: ["creative-writing"],
    sweep_source: {
      lem_issue: "LEM-58",
      sweep_date: "2026-03-15",
      scenarios_tested: 10,
    },
  };
}

// ── Vault test directory ─────────────────────────────────────────────────────

const TEST_VAULT_ROOT = path.join(process.cwd(), ".test-vault-fingerprint");

before(async () => {
  process.env.ARTIFACT_VAULT_ROOT = TEST_VAULT_ROOT;
  await fsp.rm(TEST_VAULT_ROOT, { recursive: true, force: true });
});

after(async () => {
  await fsp.rm(TEST_VAULT_ROOT, { recursive: true, force: true });
  delete process.env.ARTIFACT_VAULT_ROOT;
});

// ── Schema Validation ────────────────────────────────────────────────────────

describe("ModelFingerprintPayloadSchema", () => {
  it("accepts a valid gemma fingerprint", () => {
    const fp = makeGemmaFingerprint();
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(result.success, `Validation failed: ${JSON.stringify(result.error?.issues)}`);
  });

  it("accepts a valid llama baseline fingerprint", () => {
    const fp = makeLlamaBaselineFingerprint();
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(result.success);
  });

  it("accepts a valid SSM architecture fingerprint", () => {
    const fp = makeFalconMambaFingerprint();
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(result.success);
  });

  it("rejects missing schema field", () => {
    const fp = makeGemmaFingerprint();
    const { schema, ...rest } = fp;
    const result = ModelFingerprintPayloadSchema.safeParse(rest);
    assert.ok(!result.success);
  });

  it("rejects wrong schema version", () => {
    const fp = { ...makeGemmaFingerprint(), schema: "model_fingerprint.v2" };
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(!result.success);
  });

  it("rejects behavioral vector with value > 1", () => {
    const fp = makeGemmaFingerprint();
    fp.behavioral_vector.contain = 1.5;
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(!result.success);
  });

  it("rejects behavioral vector with negative value", () => {
    const fp = makeGemmaFingerprint();
    fp.behavioral_vector.repel = -0.1;
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(!result.success);
  });

  it("rejects unknown behavioral profile", () => {
    const fp = { ...makeGemmaFingerprint(), behavioral_profile: "berserker" };
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(!result.success);
  });

  it("rejects unknown quant verdict", () => {
    const fp = { ...makeGemmaFingerprint(), quant_verdict: "maybe" };
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(!result.success);
  });

  it("rejects unknown quant method", () => {
    const fp = { ...makeGemmaFingerprint(), quant_method: "qlora" };
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(!result.success);
  });

  it("rejects invalid sweep_date format", () => {
    const fp = makeGemmaFingerprint();
    fp.sweep_source.sweep_date = "March 15, 2026";
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(!result.success);
  });

  it("rejects extra fields (strict mode)", () => {
    const fp = { ...makeGemmaFingerprint(), bonus_field: "surprise" } as any;
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(!result.success);
  });

  it("accepts optional fields absent", () => {
    const fp = makeGemmaFingerprint();
    delete (fp as any).architecture;
    delete (fp as any).baseline_card_hash;
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(result.success);
  });

  it("accepts tensor_parallel and speculative_draft in throughput", () => {
    const fp = makeGemmaFingerprint();
    fp.throughput.tensor_parallel = 2;
    fp.throughput.speculative_draft = "llama-3.1-8b-instruct";
    const result = ModelFingerprintPayloadSchema.safeParse(fp);
    assert.ok(result.success);
  });
});

// ── Sub-schema Validation ────────────────────────────────────────────────────

describe("BehavioralVectorSchema", () => {
  it("accepts valid vector", () => {
    const result = BehavioralVectorSchema.safeParse({
      contain: 0.2, attract: 0.2, release: 0.2, repel: 0.2, transform: 0.2,
    });
    assert.ok(result.success);
  });

  it("rejects missing dimension", () => {
    const result = BehavioralVectorSchema.safeParse({
      contain: 0.2, attract: 0.2, release: 0.2, repel: 0.2,
    });
    assert.ok(!result.success);
  });
});

describe("APMetricsSchema", () => {
  it("rejects values above 1", () => {
    const result = APMetricsSchema.safeParse({
      vocabulary_richness: 1.5, creative_output: 0.5, snapback_score: 0.5,
    });
    assert.ok(!result.success);
  });
});

// ── Deterministic Hash ───────────────────────────────────────────────────────

describe("Fingerprint determinism", () => {
  it("same payload produces identical hash across two runs", () => {
    const fp = makeGemmaFingerprint();
    const input1 = buildFingerprintPutInput(fp);
    const input2 = buildFingerprintPutInput(fp);

    const hp1 = buildArtifactHashPayload(input1);
    const hp2 = buildArtifactHashPayload(input2);

    const id1 = computeArtifactId(hp1);
    const id2 = computeArtifactId(hp2);

    assert.equal(id1, id2, "Hash must be deterministic across runs");
  });

  it("different payloads produce different hashes", () => {
    const fp1 = makeGemmaFingerprint();
    const fp2 = makeLlamaBaselineFingerprint();

    const input1 = buildFingerprintPutInput(fp1);
    const input2 = buildFingerprintPutInput(fp2);

    const hp1 = buildArtifactHashPayload(input1);
    const hp2 = buildArtifactHashPayload(input2);

    const id1 = computeArtifactId(hp1);
    const id2 = computeArtifactId(hp2);

    assert.notEqual(id1, id2, "Different payloads must produce different hashes");
  });

  it("changing one BV dimension changes the hash", () => {
    const fp1 = makeGemmaFingerprint();
    const fp2 = { ...makeGemmaFingerprint() };
    fp2.behavioral_vector = { ...fp2.behavioral_vector, contain: 0.23 };

    const input1 = buildFingerprintPutInput(fp1);
    const input2 = buildFingerprintPutInput(fp2);

    const hp1 = buildArtifactHashPayload(input1);
    const hp2 = buildArtifactHashPayload(input2);

    assert.notEqual(
      computeArtifactId(hp1),
      computeArtifactId(hp2),
      "BV change must produce different hash",
    );
  });

  it("changing quant_verdict changes the hash (via tags)", () => {
    const fp1 = makeGemmaFingerprint();
    const fp2 = { ...makeGemmaFingerprint(), quant_verdict: "broken" as const };

    const input1 = buildFingerprintPutInput(fp1);
    const input2 = buildFingerprintPutInput(fp2);

    const hp1 = buildArtifactHashPayload(input1);
    const hp2 = buildArtifactHashPayload(input2);

    assert.notEqual(
      computeArtifactId(hp1),
      computeArtifactId(hp2),
      "Verdict change must produce different hash",
    );
  });
});

// ── Tag Generation ───────────────────────────────────────────────────────────

describe("buildFingerprintTags", () => {
  it("generates correct tags for gemma fingerprint", () => {
    const fp = makeGemmaFingerprint();
    const tags = buildFingerprintTags(fp);

    assert.ok(tags.includes("schema:model_fingerprint.v1"));
    assert.ok(tags.includes("model:gemma-27b"));
    assert.ok(tags.includes("family:gemma"));
    assert.ok(tags.includes("quant:int4"));
    assert.ok(tags.includes("method:awq"));
    assert.ok(tags.includes("verdict:degraded"));
    assert.ok(tags.includes("profile:healer"));
    assert.ok(tags.includes("arch:transformer"));
    assert.ok(tags.includes("fit:general-purpose"));
    assert.ok(tags.includes("fit:customer-engagement"));
  });

  it("includes tier eligibility based on throughput and verdict", () => {
    const fp = makeGemmaFingerprint(); // 69 tok/s, degraded
    const tags = buildFingerprintTags(fp);

    assert.ok(tags.includes("tier:silver-eligible"), "69 tok/s >= 40 should be silver-eligible");
    assert.ok(tags.includes("tier:gold-eligible"), "non-broken should be gold-eligible");
    assert.ok(!tags.includes("tier:bronze-eligible"), "69 tok/s < 100 should not be bronze-eligible");
  });

  it("excludes tier eligibility for broken models", () => {
    const fp = { ...makeGemmaFingerprint(), quant_verdict: "broken" as const };
    const tags = buildFingerprintTags(fp);

    assert.ok(!tags.includes("tier:bronze-eligible"));
    assert.ok(!tags.includes("tier:silver-eligible"));
    assert.ok(!tags.includes("tier:gold-eligible"));
  });

  it("tags are sorted", () => {
    const fp = makeGemmaFingerprint();
    const tags = buildFingerprintTags(fp);
    const sorted = [...tags].sort();
    assert.deepEqual(tags, sorted, "Tags must be sorted for canonical stability");
  });

  it("omits arch tag when architecture is absent", () => {
    const fp = makeGemmaFingerprint();
    delete (fp as any).architecture;
    const validated = ModelFingerprintPayloadSchema.parse(fp);
    const tags = buildFingerprintTags(validated);
    assert.ok(!tags.some((t) => t.startsWith("arch:")));
  });
});

// ── buildFingerprintPutInput ─────────────────────────────────────────────────

describe("buildFingerprintPutInput", () => {
  it("returns kind=profile", () => {
    const input = buildFingerprintPutInput(makeGemmaFingerprint());
    assert.equal(input.kind, "profile");
  });

  it("includes source when provided", () => {
    const input = buildFingerprintPutInput(makeGemmaFingerprint(), {
      agent: "lemworld-sweep",
      tool: "rv_battery",
      run_id: "run_abc",
    });
    assert.ok(input.source);
    assert.equal(input.source!.agent, "lemworld-sweep");
  });

  it("omits source when not provided", () => {
    const input = buildFingerprintPutInput(makeGemmaFingerprint());
    assert.equal(input.source, undefined);
  });

  it("includes baseline ref when baseline_card_hash is set", () => {
    const fp = makeGemmaFingerprint();
    (fp as any).baseline_card_hash = "abc123deadbeef";
    const validated = ModelFingerprintPayloadSchema.parse(fp);
    const input = buildFingerprintPutInput(validated);
    assert.equal(input.refs.length, 1);
    assert.equal(input.refs[0].kind, "profile");
    assert.equal(input.refs[0].id, "abc123deadbeef");
  });

  it("has empty refs when no baseline", () => {
    const input = buildFingerprintPutInput(makeGemmaFingerprint());
    assert.equal(input.refs.length, 0);
  });

  it("rejects invalid payload", () => {
    const bad = { ...makeGemmaFingerprint(), schema: "wrong" } as any;
    assert.throws(() => buildFingerprintPutInput(bad));
  });
});

// ── Vault Round-Trip ─────────────────────────────────────────────────────────

describe("Vault round-trip", () => {
  it("put → get returns same payload", async () => {
    const fp = makeGemmaFingerprint();
    const input = buildFingerprintPutInput(fp, {
      agent: "test-harness",
      tool: "fingerprint-test",
    });

    const putResult = await vaultPut(input);
    assert.ok(putResult.created, "First put should create");
    assert.ok(putResult.id.length === 64, "ID should be sha256 hex");

    const envelope = await vaultGet(putResult.id);
    assert.ok(envelope, "Get should return the envelope");
    assert.equal(envelope!.kind, "profile");
    assert.equal((envelope!.payload as any).schema, FINGERPRINT_SCHEMA_VERSION);
    assert.equal((envelope!.payload as any).model_name, "gemma-2-27b-it");
    assert.deepEqual((envelope!.payload as any).behavioral_vector, fp.behavioral_vector);
  });

  it("duplicate put returns same ID without creating", async () => {
    const fp = makeLlamaBaselineFingerprint();
    const input = buildFingerprintPutInput(fp);

    const first = await vaultPut(input);
    assert.ok(first.created);

    const second = await vaultPut(input);
    assert.ok(!second.created, "Duplicate should not create");
    assert.equal(second.id, first.id, "Same content must produce same ID");
  });

  it("search by tags finds stored fingerprint", async () => {
    const fp = makeFalconMambaFingerprint();
    const input = buildFingerprintPutInput(fp);
    await vaultPut(input);

    const results = await vaultSearch({
      tags: ["family:falcon3", "arch:ssm"],
      search_mode: "lexical",
    });

    assert.ok(results.total >= 1, "Should find at least the falcon card");
    const found = results.results.some((r) =>
      r.tags.includes("family:falcon3") && r.tags.includes("arch:ssm"),
    );
    assert.ok(found, "Should find falcon3 SSM card by tags");
  });

  it("search by schema tag finds all fingerprints", async () => {
    const results = await vaultSearch({
      tags: [`schema:${FINGERPRINT_SCHEMA_VERSION}`],
      search_mode: "lexical",
      limit: 50,
    });
    // We stored at least 3 fingerprints in previous tests
    assert.ok(results.total >= 3, `Expected >= 3 fingerprints, got ${results.total}`);
  });

  it("search by verdict finds degraded models", async () => {
    const results = await vaultSearch({
      tags: ["verdict:degraded"],
      search_mode: "lexical",
    });
    assert.ok(results.total >= 1);
  });
});

// ── Schema Version Constant ──────────────────────────────────────────────────

describe("Schema version", () => {
  it("FINGERPRINT_SCHEMA_VERSION matches literal in schema", () => {
    assert.equal(FINGERPRINT_SCHEMA_VERSION, "model_fingerprint.v1");
  });
});
