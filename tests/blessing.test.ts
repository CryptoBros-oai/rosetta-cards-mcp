/**
 * Blessing workflow tests — candidate/blessed/deprecated transitions,
 * validation rules, evidence collection, supersession chains,
 * integrity-aware rejection/override, deterministic hashing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blessArtifact,
  deprecateArtifact,
  supersedeArtifact,
  collectEvidenceRefs,
  validateBlessingInput,
} from "../src/kb/blessing.js";
import { canonicalHash } from "../src/kb/canonical.js";
import type { EvidenceRef, IntegritySummary } from "../src/kb/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRefs(count: number): EvidenceRef[] {
  return Array.from({ length: count }, (_, i) => ({
    ref_type: "execution_hash" as const,
    value: `hash_${String(i).padStart(3, "0")}`,
  }));
}

function cleanIntegrity(): IntegritySummary {
  return { total_cards: 3, issue_count: 0, clean: true, issues: [] };
}

function dirtyIntegrity(): IntegritySummary {
  return {
    total_cards: 3,
    issue_count: 1,
    clean: false,
    issues: [{ kind: "missing_parent", hash: "abc", detail: "parent not found" }],
  };
}

// ---------------------------------------------------------------------------
// blessArtifact
// ---------------------------------------------------------------------------

describe("blessing -- blessArtifact", () => {
  it("creates a blessed record with valid inputs", () => {
    const record = blessArtifact({
      target_hash: "target_abc",
      evidence_refs: makeRefs(2),
      reason: "Verified via pipeline",
    });
    assert.equal(record.schema_version, "blessing.v1");
    assert.equal(record.transition, "bless");
    assert.equal(record.new_status, "blessed");
    assert.equal(record.target_hash, "target_abc");
    assert.equal(record.override_integrity, false);
    assert.ok(record.hash.length === 64);
  });

  it("throws when no evidence refs provided", () => {
    assert.throws(
      () =>
        blessArtifact({
          target_hash: "target_abc",
          evidence_refs: [],
          reason: "No evidence",
        }),
      /NO_EVIDENCE|at least one evidence/i,
    );
  });

  it("throws when integrity issues exist without override", () => {
    assert.throws(
      () =>
        blessArtifact({
          target_hash: "target_abc",
          evidence_refs: makeRefs(1),
          reason: "Test",
          integrity_summary: dirtyIntegrity(),
        }),
      /INTEGRITY_ISSUES|integrity issue/i,
    );
  });

  it("succeeds with integrity issues when override_integrity is set", () => {
    const record = blessArtifact({
      target_hash: "target_abc",
      evidence_refs: makeRefs(1),
      reason: "Overriding known issue",
      integrity_summary: dirtyIntegrity(),
      override_integrity: true,
    });
    assert.equal(record.new_status, "blessed");
    assert.equal(record.override_integrity, true);
    assert.ok(record.integrity_summary);
    assert.equal(record.integrity_summary!.clean, false);
  });

  it("succeeds with clean integrity without override", () => {
    const record = blessArtifact({
      target_hash: "target_abc",
      evidence_refs: makeRefs(1),
      reason: "Clean pipeline",
      integrity_summary: cleanIntegrity(),
    });
    assert.equal(record.new_status, "blessed");
    assert.equal(record.integrity_summary!.clean, true);
  });

  it("sorts evidence refs deterministically", () => {
    const refs: EvidenceRef[] = [
      { ref_type: "pipeline_id", value: "pipe-z" },
      { ref_type: "artifact_hash", value: "art-a" },
      { ref_type: "execution_hash", value: "exec-m" },
    ];
    const record = blessArtifact({
      target_hash: "t",
      evidence_refs: refs,
      reason: "Test sort",
    });
    assert.equal(record.evidence_refs[0].ref_type, "artifact_hash");
    assert.equal(record.evidence_refs[1].ref_type, "execution_hash");
    assert.equal(record.evidence_refs[2].ref_type, "pipeline_id");
  });

  it("sorts tags deterministically", () => {
    const record = blessArtifact({
      target_hash: "t",
      evidence_refs: makeRefs(1),
      reason: "Test",
      tags: ["zebra", "alpha", "middle"],
    });
    assert.deepStrictEqual(record.tags, ["alpha", "middle", "zebra"]);
  });
});

// ---------------------------------------------------------------------------
// deprecateArtifact
// ---------------------------------------------------------------------------

describe("blessing -- deprecateArtifact", () => {
  it("creates a deprecated record", () => {
    const record = deprecateArtifact({
      target_hash: "target_xyz",
      reason: "Outdated information",
    });
    assert.equal(record.transition, "deprecate");
    assert.equal(record.new_status, "deprecated");
    assert.equal(record.target_hash, "target_xyz");
  });

  it("includes optional evidence refs", () => {
    const record = deprecateArtifact({
      target_hash: "t",
      reason: "Replaced",
      evidence_refs: makeRefs(2),
    });
    assert.equal(record.evidence_refs.length, 2);
  });

  it("throws on empty reason", () => {
    assert.throws(
      () =>
        deprecateArtifact({
          target_hash: "t",
          reason: "",
        }),
      /EMPTY_REASON|empty/i,
    );
  });
});

// ---------------------------------------------------------------------------
// supersedeArtifact
// ---------------------------------------------------------------------------

describe("blessing -- supersedeArtifact", () => {
  it("creates a supersession record with old->new linkage", () => {
    const record = supersedeArtifact({
      old_hash: "old_abc",
      new_hash: "new_xyz",
      reason: "Improved version",
    });
    assert.equal(record.transition, "supersede");
    assert.equal(record.new_status, "deprecated");
    assert.equal(record.target_hash, "old_abc");
    assert.equal(record.superseded_by, "new_xyz");
    assert.equal(record.supersedes, "old_abc");
  });

  it("throws when new_hash equals old_hash", () => {
    assert.throws(
      () =>
        supersedeArtifact({
          old_hash: "same",
          new_hash: "same",
          reason: "Self-supersede",
        }),
      /SELF_SUPERSEDE|cannot supersede itself/i,
    );
  });
});

// ---------------------------------------------------------------------------
// collectEvidenceRefs
// ---------------------------------------------------------------------------

describe("blessing -- collectEvidenceRefs", () => {
  it("collects and sorts refs from mixed inputs", () => {
    const refs = collectEvidenceRefs({
      pipeline_ids: ["pipe-b", "pipe-a"],
      execution_hashes: ["exec-1"],
      artifact_hashes: ["art-2", "art-1"],
    });
    assert.equal(refs.length, 5);
    // Should be sorted by ref_type then value
    assert.equal(refs[0].ref_type, "artifact_hash");
    assert.equal(refs[0].value, "art-1");
    assert.equal(refs[1].ref_type, "artifact_hash");
    assert.equal(refs[1].value, "art-2");
    assert.equal(refs[2].ref_type, "execution_hash");
    assert.equal(refs[3].ref_type, "pipeline_id");
    assert.equal(refs[3].value, "pipe-a");
  });

  it("deduplicates identical refs", () => {
    const refs = collectEvidenceRefs({
      artifact_hashes: ["same", "same", "same"],
    });
    assert.equal(refs.length, 1);
  });

  it("returns empty array for no inputs", () => {
    const refs = collectEvidenceRefs({});
    assert.equal(refs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// validateBlessingInput
// ---------------------------------------------------------------------------

describe("blessing -- validateBlessingInput", () => {
  it("returns no errors for valid bless input", () => {
    const errors = validateBlessingInput({
      transition: "bless",
      target_hash: "t",
      evidence_refs: makeRefs(1),
      reason: "Good reason",
    });
    assert.equal(errors.length, 0);
  });

  it("returns NO_EVIDENCE for bless with empty refs", () => {
    const errors = validateBlessingInput({
      transition: "bless",
      target_hash: "t",
      evidence_refs: [],
      reason: "Test",
    });
    assert.ok(errors.some((e) => e.code === "NO_EVIDENCE"));
  });

  it("returns INTEGRITY_ISSUES for dirty pipeline without override", () => {
    const errors = validateBlessingInput({
      transition: "bless",
      target_hash: "t",
      evidence_refs: makeRefs(1),
      reason: "Test",
      integrity_summary: dirtyIntegrity(),
    });
    assert.ok(errors.some((e) => e.code === "INTEGRITY_ISSUES"));
  });

  it("no INTEGRITY_ISSUES when override_integrity is true", () => {
    const errors = validateBlessingInput({
      transition: "bless",
      target_hash: "t",
      evidence_refs: makeRefs(1),
      reason: "Test",
      integrity_summary: dirtyIntegrity(),
      override_integrity: true,
    });
    assert.ok(!errors.some((e) => e.code === "INTEGRITY_ISSUES"));
  });

  it("returns MISSING_SUPERSEDED_BY for supersede without new hash", () => {
    const errors = validateBlessingInput({
      transition: "supersede",
      target_hash: "old",
      evidence_refs: [],
      reason: "Test",
    });
    assert.ok(errors.some((e) => e.code === "MISSING_SUPERSEDED_BY"));
  });

  it("returns SELF_SUPERSEDE when old equals new", () => {
    const errors = validateBlessingInput({
      transition: "supersede",
      target_hash: "same",
      evidence_refs: [],
      reason: "Test",
      superseded_by: "same",
    });
    assert.ok(errors.some((e) => e.code === "SELF_SUPERSEDE"));
  });

  it("returns EMPTY_REASON for blank reason", () => {
    const errors = validateBlessingInput({
      transition: "deprecate",
      target_hash: "t",
      evidence_refs: [],
      reason: "   ",
    });
    assert.ok(errors.some((e) => e.code === "EMPTY_REASON"));
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("blessing -- determinism", () => {
  it("same inputs produce identical hashes", () => {
    const a = blessArtifact({
      target_hash: "target_det",
      evidence_refs: [{ ref_type: "pipeline_id", value: "p1" }],
      reason: "Determinism test",
      tags: ["beta", "alpha"],
    });
    const b = blessArtifact({
      target_hash: "target_det",
      evidence_refs: [{ ref_type: "pipeline_id", value: "p1" }],
      reason: "Determinism test",
      tags: ["beta", "alpha"],
    });
    assert.equal(a.hash, b.hash);
  });

  it("different inputs produce different hashes", () => {
    const a = blessArtifact({
      target_hash: "target_a",
      evidence_refs: makeRefs(1),
      reason: "Reason A",
    });
    const b = blessArtifact({
      target_hash: "target_b",
      evidence_refs: makeRefs(1),
      reason: "Reason B",
    });
    assert.notEqual(a.hash, b.hash);
  });

  it("hash verifies against canonical payload", () => {
    const record = blessArtifact({
      target_hash: "verify_target",
      evidence_refs: makeRefs(1),
      reason: "Hash verification",
    });
    const { hash, ...payload } = record;
    const computed = canonicalHash(payload as unknown as Record<string, unknown>);
    assert.equal(hash, computed);
  });
});

// ---------------------------------------------------------------------------
// Schema validation (BlessingRecordSchema)
// ---------------------------------------------------------------------------

describe("blessing -- schema validation", () => {
  it("BlessingRecordSchema accepts a valid record", async () => {
    const { BlessingRecordSchema } = await import("../src/kb/schema.js");
    const record = blessArtifact({
      target_hash: "t",
      evidence_refs: makeRefs(1),
      reason: "Valid",
    });
    const parsed = BlessingRecordSchema.parse(record);
    assert.equal(parsed.hash, record.hash);
  });

  it("BlessingRecordSchema rejects unknown keys", async () => {
    const { BlessingRecordSchema } = await import("../src/kb/schema.js");
    const record = blessArtifact({
      target_hash: "t",
      evidence_refs: makeRefs(1),
      reason: "Valid",
    });
    assert.throws(() => {
      BlessingRecordSchema.parse({ ...record, unknown_key: "bad" });
    });
  });
});
