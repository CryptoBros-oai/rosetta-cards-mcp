import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  PromotionBuildBundleInputSchema,
  PromotionPromoteFactsInputSchema,
  RunLocalCorpusImportInputSchema,
} from "../src/kb/schema.js";
import {
  buildPromotionBundle,
  promoteFactCandidates,
  promoteSkillCandidates,
  promoteSummaryCandidate,
} from "../src/kb/promotion.js";

const TEST_ROOT = path.join(process.cwd(), "data-promotion-test-root");
const FIXTURE_ROOT = path.join(TEST_ROOT, "fixtures");
const LOCAL_FIXTURE = path.join(FIXTURE_ROOT, "local");
const origCwd = process.cwd;

async function ensureVaultDirs() {
  const dirs = [
    "docs",
    "cards",
    "index",
    "bundles",
    "pinsets",
    "packs",
    "blobs",
    "text",
    "graphs",
  ];
  for (const dir of dirs) {
    await fs.mkdir(path.join(TEST_ROOT, "data", dir), { recursive: true });
  }
}

async function makeLocalFixture() {
  await fs.mkdir(LOCAL_FIXTURE, { recursive: true });
  await fs.writeFile(
    path.join(LOCAL_FIXTURE, "doc-a.md"),
    "# Doc A\n\nArtifact systems require deterministic identity.\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(LOCAL_FIXTURE, "doc-b.txt"),
    "Execution evidence should be reusable and verifiable.\n",
    "utf-8",
  );
}

before(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await ensureVaultDirs();
  await makeLocalFixture();
  process.cwd = () => TEST_ROOT;
});

beforeEach(async () => {
  await fs.rm(path.join(TEST_ROOT, "data"), { recursive: true, force: true }).catch(() => {});
  await ensureVaultDirs();
});

after(async () => {
  process.cwd = origCwd;
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("MCP schema validation surfaces", () => {
  it("rejects unknown keys on corpus import MCP schemas", () => {
    assert.throws(
      () =>
        RunLocalCorpusImportInputSchema.parse({
          root_path: LOCAL_FIXTURE,
          unknown_key: true,
        } as any),
      /unrecognized key/i,
    );
  });

  it("rejects unknown keys on promotion MCP schemas", () => {
    assert.throws(
      () =>
        PromotionPromoteFactsInputSchema.parse({
          doc_ids: ["abc"],
          rogue: "x",
        } as any),
      /unrecognized key/i,
    );
    assert.throws(
      () =>
        PromotionBuildBundleInputSchema.parse({
          doc_ids: ["abc"],
          bad: true,
        } as any),
      /unrecognized key/i,
    );
  });
});

describe("Pure promotion functions", () => {
  it("produce deterministic facts regardless of input ordering", () => {
    const a = promoteFactCandidates({
      docs: [
        { doc_id: "doc_b", title: "B", snippet: "Second deterministic statement." },
        { doc_id: "doc_a", title: "A", snippet: "First deterministic statement." },
      ],
      tags: ["import"],
    });
    const b = promoteFactCandidates({
      docs: [
        { doc_id: "doc_a", title: "A", snippet: "First deterministic statement." },
        { doc_id: "doc_b", title: "B", snippet: "Second deterministic statement." },
      ],
      tags: ["import"],
    });
    assert.deepEqual(a, b);
  });

  it("produce deterministic skills and summaries regardless of ordering", () => {
    const skillsA = promoteSkillCandidates({
      executions: [
        { execution_id: "e2", title: "Validate", status: "succeeded", pipeline_id: "p1", step_index: 1 },
        { execution_id: "e1", title: "Import", status: "succeeded", pipeline_id: "p1", step_index: 0 },
      ],
      tags: ["pipeline"],
    });
    const skillsB = promoteSkillCandidates({
      executions: [
        { execution_id: "e1", title: "Import", status: "succeeded", pipeline_id: "p1", step_index: 0 },
        { execution_id: "e2", title: "Validate", status: "succeeded", pipeline_id: "p1", step_index: 1 },
      ],
      tags: ["pipeline"],
    });
    assert.deepEqual(skillsA, skillsB);

    const summaryA = promoteSummaryCandidate({
      doc_ids: ["d2", "d1"],
      execution_ids: ["e2", "e1"],
      fact_ids: ["f2", "f1"],
      skill_ids: ["s2", "s1"],
    });
    const summaryB = promoteSummaryCandidate({
      doc_ids: ["d1", "d2"],
      execution_ids: ["e1", "e2"],
      fact_ids: ["f1", "f2"],
      skill_ids: ["s1", "s2"],
    });
    assert.deepEqual(summaryA, summaryB);
  });

  it("builds deterministic bundle payloads", () => {
    const facts = promoteFactCandidates({
      docs: [{ doc_id: "doc_a", snippet: "A statement." }],
    });
    const skills = promoteSkillCandidates({
      executions: [{ execution_id: "e1", title: "Import", status: "succeeded" }],
    });
    const summary = promoteSummaryCandidate({
      doc_ids: ["doc_a"],
      execution_ids: ["e1"],
      fact_ids: [facts[0].hash],
      skill_ids: [skills[0].hash],
    });

    const bundleA = buildPromotionBundle({ facts, skills, summary, tags: ["batch"] });
    const bundleB = buildPromotionBundle({ facts: [...facts], skills: [...skills], summary, tags: ["batch"] });
    assert.deepEqual(bundleA, bundleB);
  });
});

describe("Promotion hooks and end-to-end flow", () => {
  it("corpus hook optional promotion flags generate promoted artifacts deterministically", async () => {
    const { runLocalCorpusImport } = await import("../src/kb/corpus_hooks.js");

    const first = await runLocalCorpusImport({
      root_path: LOCAL_FIXTURE,
      build_cards: true,
      promote_facts: true,
      promote_skills: true,
      promote_summary: true,
      source_label: "alpha",
    });
    const second = await runLocalCorpusImport({
      root_path: LOCAL_FIXTURE,
      build_cards: true,
      promote_facts: true,
      promote_skills: true,
      promote_summary: true,
      source_label: "beta",
    });

    assert.ok(first.promotion.fact_hashes.length > 0);
    assert.ok(first.promotion.skill_hashes.length > 0);
    assert.ok(first.promotion.summary_hash);
    assert.deepEqual(first.promotion.fact_hashes, second.promotion.fact_hashes);
  });

  it("builds a promotion bundle from imported corpus + execution evidence", async () => {
    const { runLocalCorpusImport } = await import("../src/kb/corpus_hooks.js");
    const { buildPromotionBundleHook } = await import("../src/kb/promotion_hooks.js");

    const imported = await runLocalCorpusImport({
      root_path: LOCAL_FIXTURE,
      build_cards: true,
    });

    const bundle = await buildPromotionBundleHook({
      doc_ids: imported.import.doc_ids,
      execution_ids: imported.build.execution_ids,
      include_facts: true,
      include_skills: true,
      include_summary: true,
      label: "local-import-promotion",
    });

    assert.ok(bundle.created_id.startsWith("card_pbundle_"));
    const bundlePath = path.join(TEST_ROOT, "data", "cards", `${bundle.created_id}.json`);
    const raw = await fs.readFile(bundlePath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.schema_version, "promotion.bundle.v1");
    assert.equal(parsed.hash, bundle.bundle_hash);
    assert.ok(parsed.member_hashes.facts.length > 0);
  });
});
