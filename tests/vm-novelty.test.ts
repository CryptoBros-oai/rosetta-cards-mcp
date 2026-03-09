import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import {
  cosineSimilarity,
  signatureToVector,
  buildVocabulary,
  computeNoveltyScores,
} from "../src/kb/vm_novelty.js";
import type { ScanSignature } from "../src/kb/vm_scan_signature.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignature(overrides: Partial<ScanSignature> = {}): ScanSignature {
  return {
    schema_version: "scan_signature.v1",
    scan_id: "aaa000000000",
    program_id: "test_prog",
    knob_summary: { names: ["run_seed"], types: ["integer"] },
    counts: { grid_points: 5, phase_hints: 0, dossier_entries: 0, adaptive_refinements: null },
    regime: { halted: 0, completed: 5, halt_fraction: 0 },
    transition_stats: {
      transition_density: 0,
      avg_delta_magnitude: 0,
      max_delta_magnitude: 0,
      opcode_delta_concentration: 0,
      metric_cliff_score: 0,
    },
    opcode_signature: [],
    metrics_signature: [],
    regime_classes: ["completed"],
    regime_distribution: [{ regime_class: "completed", count: 5, fraction: 1 }],
    ...overrides,
  };
}

function makeTransitionSignature(): ScanSignature {
  return makeSignature({
    scan_id: "bbb111111111",
    counts: { grid_points: 10, phase_hints: 3, dossier_entries: 2, adaptive_refinements: 1 },
    regime: { halted: 4, completed: 6, halt_fraction: 0.4 },
    transition_stats: {
      transition_density: 0.3,
      avg_delta_magnitude: 150,
      max_delta_magnitude: 500,
      opcode_delta_concentration: 0.8,
      metric_cliff_score: 2.5,
    },
    opcode_signature: [
      { opcode: "attract.select", weight: 0.6 },
      { opcode: "contain.env_threshold", weight: 0.4 },
    ],
    metrics_signature: [
      { metric: "final_bag_sum", weight: 0.7 },
      { metric: "total_steps", weight: 0.3 },
    ],
    regime_classes: ["completed", "halt:precondition"],
    regime_distribution: [
      { regime_class: "completed", count: 6, fraction: 0.6 },
      { regime_class: "halt:precondition", count: 4, fraction: 0.4 },
    ],
  });
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("identical vectors return 1.0", () => {
    const a = [1, 2, 3];
    assert.ok(Math.abs(cosineSimilarity(a, a) - 1.0) < 0.001);
  });

  it("orthogonal vectors return 0.0", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 0.001);
  });

  it("opposite vectors return -1.0", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - (-1.0)) < 0.001);
  });

  it("zero vectors return 0.0 (no NaN)", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [0, 0, 0]), 0);
  });

  it("empty arrays return 0.0", () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  it("mismatched lengths return 0.0", () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });
});

// ---------------------------------------------------------------------------
// signatureToVector
// ---------------------------------------------------------------------------

describe("signatureToVector", () => {
  it("returns array of numbers", () => {
    const sig = makeSignature();
    const { opcodeVocab, metricVocab } = buildVocabulary([sig]);
    const vec = signatureToVector(sig, opcodeVocab, metricVocab);
    assert.ok(Array.isArray(vec));
    assert.ok(vec.length > 0);
    for (const v of vec) {
      assert.equal(typeof v, "number");
      assert.ok(Number.isFinite(v), `Non-finite value: ${v}`);
    }
  });

  it("same signature produces identical vector", () => {
    const sig = makeTransitionSignature();
    const { opcodeVocab, metricVocab } = buildVocabulary([sig]);
    const v1 = signatureToVector(sig, opcodeVocab, metricVocab);
    const v2 = signatureToVector(sig, opcodeVocab, metricVocab);
    assert.deepEqual(v1, v2);
  });

  it("different signatures produce different vectors", () => {
    const s1 = makeSignature();
    const s2 = makeTransitionSignature();
    const { opcodeVocab, metricVocab } = buildVocabulary([s1, s2]);
    const v1 = signatureToVector(s1, opcodeVocab, metricVocab);
    const v2 = signatureToVector(s2, opcodeVocab, metricVocab);
    assert.notDeepEqual(v1, v2);
  });

  it("has 12 scalar dimensions plus vocabulary", () => {
    const sig = makeTransitionSignature();
    const { opcodeVocab, metricVocab } = buildVocabulary([sig]);
    const vec = signatureToVector(sig, opcodeVocab, metricVocab);
    assert.equal(vec.length, 12 + opcodeVocab.length + metricVocab.length);
  });
});

// ---------------------------------------------------------------------------
// computeNoveltyScores
// ---------------------------------------------------------------------------

describe("computeNoveltyScores", () => {
  it("empty signatures return empty result", () => {
    const result = computeNoveltyScores([]);
    assert.equal(result.scans.length, 0);
    assert.equal(result.total, 0);
  });

  it("single signature has novelty 0", () => {
    const result = computeNoveltyScores([makeSignature()]);
    assert.equal(result.scans.length, 1);
    assert.equal(result.scans[0].novelty, 0);
  });

  it("two identical signatures have novelty 0", () => {
    const s1 = makeSignature({ scan_id: "aaa000000001" });
    const s2 = makeSignature({ scan_id: "aaa000000002" });
    const result = computeNoveltyScores([s1, s2]);
    assert.equal(result.scans[0].novelty, 0);
    assert.equal(result.scans[1].novelty, 0);
  });

  it("dissimilar signatures have positive novelty", () => {
    const s1 = makeSignature();
    const s2 = makeTransitionSignature();
    const result = computeNoveltyScores([s1, s2]);
    assert.ok(result.scans[0].novelty > 0, `Expected positive novelty, got ${result.scans[0].novelty}`);
  });

  it("result is sorted by novelty descending", () => {
    const s1 = makeSignature({ scan_id: "aaa000000001" });
    const s2 = makeTransitionSignature();
    const s3 = makeSignature({
      scan_id: "ccc333333333",
      counts: { grid_points: 20, phase_hints: 10, dossier_entries: 5, adaptive_refinements: 3 },
      transition_stats: {
        transition_density: 0.5,
        avg_delta_magnitude: 300,
        max_delta_magnitude: 1000,
        opcode_delta_concentration: 0.9,
        metric_cliff_score: 5,
      },
    });
    const result = computeNoveltyScores([s1, s2, s3]);
    for (let i = 0; i < result.scans.length - 1; i++) {
      assert.ok(
        result.scans[i].novelty >= result.scans[i + 1].novelty,
        `Not sorted: ${result.scans[i].novelty} < ${result.scans[i + 1].novelty}`,
      );
    }
  });

  it("respects limit parameter", () => {
    const sigs = [
      makeSignature({ scan_id: "aaa000000001" }),
      makeTransitionSignature(),
      makeSignature({ scan_id: "ccc333333333" }),
    ];
    const result = computeNoveltyScores(sigs, 2);
    assert.equal(result.scans.length, 2);
    assert.equal(result.total, 3);
  });

  it("deterministic: two runs produce identical results", () => {
    const sigs = [makeSignature(), makeTransitionSignature()];
    const r1 = computeNoveltyScores(sigs);
    const r2 = computeNoveltyScores(sigs);
    assert.deepEqual(r1, r2);
  });
});

// ---------------------------------------------------------------------------
// No NaN
// ---------------------------------------------------------------------------

describe("Novelty — no NaN", () => {
  it("JSON output contains no NaN or Infinity", () => {
    const sigs = [makeSignature(), makeTransitionSignature()];
    const result = computeNoveltyScores(sigs);
    const json = JSON.stringify(result);
    assert.ok(!json.includes("NaN"), "Must not contain NaN");
    assert.ok(!json.includes("Infinity"), "Must not contain Infinity");
  });

  it("all-zero signature produces valid result", () => {
    const zero = makeSignature({
      counts: { grid_points: 0, phase_hints: 0, dossier_entries: 0, adaptive_refinements: null },
      regime: { halted: 0, completed: 0, halt_fraction: 0 },
    });
    const result = computeNoveltyScores([zero, makeTransitionSignature()]);
    const json = JSON.stringify(result);
    assert.ok(!json.includes("NaN"), "Must not contain NaN");
  });
});

// ---------------------------------------------------------------------------
// Golden fixture
// ---------------------------------------------------------------------------

describe("Novelty — golden fixture", () => {
  it("matches frozen output", () => {
    const sigs = [
      makeSignature({ scan_id: "control_000000" }),
      makeTransitionSignature(),
      makeSignature({
        scan_id: "adaptive_000000",
        counts: { grid_points: 8, phase_hints: 2, dossier_entries: 1, adaptive_refinements: 2 },
        regime: { halted: 3, completed: 5, halt_fraction: 0.375 },
        transition_stats: {
          transition_density: 0.25,
          avg_delta_magnitude: 100,
          max_delta_magnitude: 300,
          opcode_delta_concentration: 0.7,
          metric_cliff_score: 1.5,
        },
        opcode_signature: [{ opcode: "attract.select", weight: 1 }],
        metrics_signature: [{ metric: "final_bag_sum", weight: 1 }],
        regime_classes: ["completed", "halt:precondition"],
        regime_distribution: [
          { regime_class: "completed", count: 5, fraction: 0.625 },
          { regime_class: "halt:precondition", count: 3, fraction: 0.375 },
        ],
      }),
    ];

    const result = computeNoveltyScores(sigs);

    const frozen = {
      total: result.total,
      scan_ids: result.scans.map((s) => s.scan_id),
      novelties: result.scans.map((s) => s.novelty),
    };

    const goldenPath = "tests/fixtures/golden-vm-novelty.json";
    if (!existsSync(goldenPath)) {
      writeFileSync(goldenPath, JSON.stringify(frozen, null, 2) + "\n");
      console.log("  [golden fixture written — re-run to verify]");
      return;
    }

    const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
    assert.deepEqual(frozen, golden);
  });
});
