import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/kb/vm_types.js";
import {
  TransitionDossierEntrySchema,
  TransitionDossierSchema,
} from "../src/kb/vm_types.js";
import type { VmProgram, VmEnv } from "../src/kb/vm_types.js";
import {
  scanPhases,
  buildFormalizedDossier,
  detectPhaseHints,
} from "../src/kb/vm_phase_scan.js";
import type { GridPointSummary, Knob } from "../src/kb/vm_phase_scan.js";
import { execute } from "../src/kb/vm_engine.js";
import { compareRuns } from "../src/kb/vm_compare.js";

const ENV: VmEnv = { run_seed: 42, world_seed: 7, max_steps: 10000 };

const budgetAllocator: VmProgram = {
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

const filterPipeline: VmProgram = {
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

describe("VM Transition Dossier", () => {
  // -------------------------------------------------------------------------
  // Schema validation
  // -------------------------------------------------------------------------

  describe("schema validation", () => {
    it("formalized_dossier validates against TransitionDossierSchema", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      const parsed = TransitionDossierSchema.safeParse(result.formalized_dossier);
      assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    });

    it("each entry validates against TransitionDossierEntrySchema", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      for (const entry of result.formalized_dossier.entries) {
        const parsed = TransitionDossierEntrySchema.safeParse(entry);
        assert.ok(parsed.success, `Entry ${entry.candidate_id} failed: ${JSON.stringify(parsed.error?.issues)}`);
      }
    });

    it("schema_version is transition_dossier.v1", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [42] }],
      });

      assert.equal(result.formalized_dossier.schema_version, "transition_dossier.v1");
    });
  });

  // -------------------------------------------------------------------------
  // Structure and linkage
  // -------------------------------------------------------------------------

  describe("structure and linkage", () => {
    it("one entry per hint", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      assert.equal(
        result.formalized_dossier.entries.length,
        result.phase_hints.hints.length,
      );
    });

    it("scan_hash matches scan_index", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2] }],
      });

      assert.equal(
        result.formalized_dossier.scan_hash,
        result.scan_index.scan_hash,
      );
    });

    it("candidate_id follows transition_<idxA>_<idxB> pattern", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      for (const entry of result.formalized_dossier.entries) {
        assert.match(entry.candidate_id, /^transition_\d+_\d+$/);
      }
    });

    it("run_a_id and run_b_id are 64-char hashes from points", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      const pointHashes = new Set(result.scan_index.points.map((p) => p.final_state_hash));

      for (const entry of result.formalized_dossier.entries) {
        assert.equal(entry.run_a_id.length, 64);
        assert.equal(entry.run_b_id.length, 64);
        assert.ok(pointHashes.has(entry.run_a_id), `run_a_id not found in points`);
        assert.ok(pointHashes.has(entry.run_b_id), `run_b_id not found in points`);
      }
    });

    it("compare_hash links to transition_dossier entry", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      const cmpHashes = new Set(result.transition_dossier.map((c) => c.compare_hash));

      for (const entry of result.formalized_dossier.entries) {
        assert.ok(cmpHashes.has(entry.compare_hash), `compare_hash ${entry.compare_hash.slice(0, 12)} not in transition_dossier`);
      }
    });

    it("hint_evidence matches the corresponding PhaseHint", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      for (let i = 0; i < result.phase_hints.hints.length; i++) {
        const hint = result.phase_hints.hints[i];
        const entry = result.formalized_dossier.entries[i];

        assert.equal(entry.hint_type, hint.kind);
        assert.equal(entry.hint_evidence.metric, hint.metric);
        assert.equal(entry.hint_evidence.a_value, hint.a_value);
        assert.equal(entry.hint_evidence.b_value, hint.b_value);
        assert.equal(entry.hint_evidence.detail, hint.detail);
      }
    });

    it("meta has engine_version and correct schema_version", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2] }],
      });

      for (const entry of result.formalized_dossier.entries) {
        assert.equal(entry.meta.schema_version, "transition_dossier.v1");
        assert.ok(entry.meta.engine_version.length > 0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Summary quality
  // -------------------------------------------------------------------------

  describe("summary quality", () => {
    it("top_opcode_deltas has at most 5 entries", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      for (const entry of result.formalized_dossier.entries) {
        assert.ok(entry.summary.top_opcode_deltas.length <= 5);
      }
    });

    it("top_scalar_deltas sorted by |delta| descending", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      for (const entry of result.formalized_dossier.entries) {
        for (let i = 0; i < entry.summary.top_scalar_deltas.length - 1; i++) {
          assert.ok(
            Math.abs(entry.summary.top_scalar_deltas[i].delta) >=
              Math.abs(entry.summary.top_scalar_deltas[i + 1].delta),
          );
        }
      }
    });

    it("top_opcode_deltas sorted by |delta| descending", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }],
      });

      for (const entry of result.formalized_dossier.entries) {
        for (let i = 0; i < entry.summary.top_opcode_deltas.length - 1; i++) {
          assert.ok(
            Math.abs(entry.summary.top_opcode_deltas[i].delta) >=
              Math.abs(entry.summary.top_opcode_deltas[i + 1].delta),
          );
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Empty / edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("no hints produces empty entries", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [42] }],
      });

      assert.equal(result.formalized_dossier.entries.length, 0);
    });

    it("single-point scan produces empty dossier", () => {
      const result = scanPhases({
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1] }],
      });

      assert.equal(result.formalized_dossier.entries.length, 0);
      assert.equal(result.formalized_dossier.schema_version, "transition_dossier.v1");
    });
  });

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------

  describe("determinism", () => {
    it("formalized dossier is deterministic", () => {
      const def = {
        program: budgetAllocator,
        state0: emptyState(),
        base_env: ENV,
        knobs: [{ key: "run_seed", values: [1, 2, 3] }] as Knob[],
      };
      const r1 = scanPhases(def);
      const r2 = scanPhases(def);
      assert.deepEqual(r1.formalized_dossier, r2.formalized_dossier);
    });
  });
});
