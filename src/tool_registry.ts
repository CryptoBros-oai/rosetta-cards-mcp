import { z } from "zod";

import { addDocument, buildCard, searchCards, getCard } from "./kb/store.js";
import { createEventCard, createExecutionArtifact, storagePlanHook, storageApplyHook, storageRestoreHook, executionGetPipelineHook, executionWalkParentsHook, executionGetChildrenHook, executionGetSiblingsHook, executionCheckIntegrityHook, executionGetPipelineViewHook, executionListPipelinesHook, blessArtifactHook, deprecateArtifactHook, supersedeArtifactHook, collectEvidenceHook, buildEvidenceBundleHook } from "./kb/hooks.js";
import { runArxivCorpusImport, runGithubCorpusImport, runLocalCorpusImport, runSyntheticCorpusImport } from "./kb/corpus_hooks.js";
import { buildPromotionBundleHook, promoteFactsHook, promoteSkillsHook, promoteSummaryHook } from "./kb/promotion_hooks.js";
import { loadMeta, mergeMeta } from "./kb/vault.js";
import {
  MetaPatchSchema,
  RunLocalCorpusImportInputSchema,
  RunGithubCorpusImportInputSchema,
  RunArxivCorpusImportInputSchema,
  RunSyntheticCorpusImportInputSchema,
  PromotionPromoteFactsInputSchema,
  PromotionPromoteSkillsInputSchema,
  PromotionPromoteSummaryInputSchema,
  PromotionBuildBundleInputSchema,
} from "./kb/schema.js";
import { rebuildIndex, loadIndexSnapshot, SNAPSHOT_PATH } from "./kb/index.js";
import { createWeeklySummary } from "./kb/summary.js";
import { renderCardPngToDerived, renderSummaryPngToDerived, storageReport } from "./kb/derived.js";
import { vmExecuteHook, vmListOpcodesHook, vmValidateProgramHook, vmCompareHook, vmPhaseScanHook, vmListRunsHook, vmSearchRunsHook, vmSearchScansHook, vmGetScanHook, vmTopScansHook, vmTopTransitionsHook, vmTopNovelScansHook } from "./kb/vm_hooks.js";
import { vaultPut, vaultGet, vaultSearch, VaultPutInputSchema, VaultGetInputSchema, VaultSearchInputSchema } from "./vault/index.js";
import { getDb } from "./vault/db.js";
import { embed, getModelInfo } from "./embeddings/client.js";
import { getMissingIds, upsertEmbedding, closeEmbeddingsDb } from "./embeddings/store.js";
import { ingestTurn, compactBand, getContextWindow } from "./memory/context_window.js";
import { startSession, endSession, getSession, recordTurn } from "./memory/session.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<ToolResult>;
};

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export const registry = new Map<string, ToolDef>();

function register(tool: ToolDef) {
  registry.set(tool.name, tool);
}

// ── kb.* tools ──────────────────────────────────────────────────────────────

register({
  name: "kb.add_document",
  description: "Add a document (markdown/text) to the KB. Splits into chunks and stores metadata.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string" as const },
      text: { type: "string" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
      source_url: { type: "string" as const }
    },
    required: ["title", "text"]
  },
  handler: async (args) => {
    const parsed = z
      .object({
        title: z.string(),
        text: z.string(),
        tags: z.array(z.string()).optional(),
        source_url: z.string().optional()
      })
      .parse(args);
    const out = await addDocument(parsed);
    return jsonResult(out);
  }
});

register({
  name: "kb.build_card",
  description: "Generate a visual card (PNG) + structured JSON for a doc or chunk, optionally embedding a QR payload.",
  inputSchema: {
    type: "object" as const,
    properties: {
      doc_id: { type: "string" as const },
      chunk_id: { type: "number" as const },
      style: { type: "string" as const, enum: ["default", "dark", "light"] },
      include_qr: { type: "boolean" as const }
    },
    required: ["doc_id"]
  },
  handler: async (args) => {
    const parsed = z
      .object({
        doc_id: z.string(),
        chunk_id: z.number().optional(),
        style: z.enum(["default", "dark", "light"]).optional(),
        include_qr: z.boolean().optional()
      })
      .parse(args);
    const out = await buildCard(parsed);
    return jsonResult(out);
  }
});

register({
  name: "kb.search",
  description: "Search over cards (currently lexical cosine; swap to embeddings later).",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string" as const },
      top_k: { type: "number" as const }
    },
    required: ["query"]
  },
  handler: async (args) => {
    const parsed = z
      .object({
        query: z.string(),
        top_k: z.number().optional()
      })
      .parse(args);
    const out = await searchCards(parsed);
    return jsonResult(out);
  }
});

register({
  name: "kb.get_card",
  description: "Fetch a card JSON and PNG path by card_id.",
  inputSchema: {
    type: "object" as const,
    properties: {
      card_id: { type: "string" as const }
    },
    required: ["card_id"]
  },
  handler: async (args) => {
    const parsed = z.object({ card_id: z.string() }).parse(args);
    const out = await getCard(parsed.card_id);
    return jsonResult(out);
  }
});

register({
  name: "kb.create_event",
  description: "Create a deterministic event card (temporal memory atom). Timestamps are excluded from the hashed payload.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string" as const },
      summary: { type: "string" as const },
      event: {
        type: "object" as const,
        properties: {
          kind: { type: "string" as const, enum: ["deployment", "incident", "decision", "meeting", "build", "research", "ops", "personal", "other"] },
          status: { type: "string" as const, enum: ["observed", "confirmed", "resolved", "superseded"] },
          severity: { type: "string" as const, enum: ["info", "low", "medium", "high", "critical"] },
          confidence: { type: "number" as const },
          participants: { type: "array" as const, items: { type: "object" as const, properties: { role: { type: "string" as const }, name: { type: "string" as const } }, required: ["role", "name"] } },
          refs: { type: "array" as const, items: { type: "object" as const, properties: { ref_type: { type: "string" as const, enum: ["artifact_id", "url", "external_id"] }, value: { type: "string" as const } }, required: ["ref_type", "value"] } }
        },
        required: ["kind", "status", "severity", "confidence", "participants", "refs"]
      },
      tags: { type: "array" as const, items: { type: "string" as const } },
      rosetta: {
        type: "object" as const,
        properties: {
          verb: { type: "string" as const, enum: ["Attract", "Contain", "Release", "Repel", "Transform"] },
          polarity: { type: "string" as const, enum: ["+", "0", "-"] },
          weights: { type: "object" as const, properties: { A: { type: "number" as const }, C: { type: "number" as const }, L: { type: "number" as const }, P: { type: "number" as const }, T: { type: "number" as const } }, required: ["A", "C", "L", "P", "T"] }
        },
        required: ["verb", "polarity", "weights"]
      }
    },
    required: ["title", "summary", "event", "tags", "rosetta"]
  },
  handler: async (args) => {
    const out = await createEventCard(args);
    return jsonResult(out);
  }
});

register({
  name: "kb.create_execution",
  description: "Create a deterministic execution artifact (operational evidence atom). Timestamps, duration, and runtime info are excluded from the hashed payload.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string" as const },
      summary: { type: "string" as const },
      execution: {
        type: "object" as const,
        properties: {
          kind: { type: "string" as const, enum: ["job", "tool_call", "model_call", "pipeline", "validation", "import", "export", "other"] },
          status: { type: "string" as const, enum: ["requested", "running", "succeeded", "failed", "partial", "validated", "rejected"] },
          actor: { type: "object" as const, properties: { type: { type: "string" as const, enum: ["human", "agent", "system", "node"] }, name: { type: "string" as const } }, required: ["type", "name"] },
          target: { type: "object" as const, properties: { type: { type: "string" as const, enum: ["artifact", "tool", "model", "node", "external"] }, name: { type: "string" as const } }, required: ["type", "name"] },
          inputs: { type: "array" as const, items: { type: "object" as const, properties: { ref_type: { type: "string" as const, enum: ["artifact_id", "url", "external_id", "inline"] }, value: { type: "string" as const } }, required: ["ref_type", "value"] } },
          outputs: { type: "array" as const, items: { type: "object" as const, properties: { ref_type: { type: "string" as const, enum: ["artifact_id", "url", "external_id", "inline"] }, value: { type: "string" as const } }, required: ["ref_type", "value"] } },
          validation: { type: "object" as const, properties: { state: { type: "string" as const, enum: ["unvalidated", "self_reported", "verified", "disputed"] }, method: { type: "string" as const, enum: ["none", "hash_check", "human_review", "replay", "consensus"] } }, required: ["state", "method"] },
          chain: { type: "object" as const, properties: { parent_execution_id: { type: "string" as const }, pipeline_id: { type: "string" as const }, step_index: { type: "number" as const }, related_execution_ids: { type: "array" as const, items: { type: "string" as const } } }, description: "Optional workflow chain references (structural, affects identity)" }
        },
        required: ["kind", "status", "actor", "target", "inputs", "outputs", "validation"]
      },
      tags: { type: "array" as const, items: { type: "string" as const } },
      rosetta: {
        type: "object" as const,
        properties: {
          verb: { type: "string" as const, enum: ["Attract", "Contain", "Release", "Repel", "Transform"] },
          polarity: { type: "string" as const, enum: ["+", "0", "-"] },
          weights: { type: "object" as const, properties: { A: { type: "number" as const }, C: { type: "number" as const }, L: { type: "number" as const }, P: { type: "number" as const }, T: { type: "number" as const } }, required: ["A", "C", "L", "P", "T"] }
        },
        required: ["verb", "polarity", "weights"]
      }
    },
    required: ["title", "summary", "execution", "tags", "rosetta"]
  },
  handler: async (args) => {
    const out = await createExecutionArtifact(args);
    return jsonResult(out);
  }
});

register({
  name: "kb.get_meta",
  description: "Retrieve the sidecar metadata for an artifact by hash and type.",
  inputSchema: {
    type: "object" as const,
    properties: {
      artifact_hash: { type: "string" as const },
      artifact_type: { type: "string" as const, enum: ["card", "event", "execution"] }
    },
    required: ["artifact_hash", "artifact_type"]
  },
  handler: async (args) => {
    const parsed = z
      .object({
        artifact_hash: z.string(),
        artifact_type: z.enum(["card", "event", "execution"]),
      })
      .strict()
      .parse(args);
    const meta = await loadMeta(parsed.artifact_hash, parsed.artifact_type);
    if (!meta) {
      return jsonResult({ error: "not_found" });
    }
    return jsonResult(meta);
  }
});

register({
  name: "kb.merge_meta",
  description: "Merge a patch into the sidecar metadata for an artifact. Creates the meta file if it does not exist.",
  inputSchema: {
    type: "object" as const,
    properties: {
      artifact_hash: { type: "string" as const },
      artifact_type: { type: "string" as const, enum: ["card", "event", "execution"] },
      patch: { type: "object" as const }
    },
    required: ["artifact_hash", "artifact_type", "patch"]
  },
  handler: async (args) => {
    const parsed = z
      .object({
        artifact_hash: z.string(),
        artifact_type: z.enum(["card", "event", "execution"]),
        patch: z.record(z.unknown()),
      })
      .strict()
      .parse(args);
    const validPatch = MetaPatchSchema.parse(parsed.patch);
    const result = await mergeMeta(
      parsed.artifact_hash,
      parsed.artifact_type,
      validPatch,
    );
    return jsonResult(result);
  }
});

register({
  name: "kb.rebuild_index",
  description: "Scan all on-disk artifacts and meta sidecars and rebuild the index snapshot. Returns summary counts and the snapshot path.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: []
  },
  handler: async () => {
    const snapshot = await rebuildIndex();
    const summary = {
      counts: snapshot.counts,
      snapshot_path: SNAPSHOT_PATH,
      built_at: snapshot.built_at,
    };
    return jsonResult(summary);
  }
});

register({
  name: "kb.index_status",
  description: "Return the current index snapshot if it exists, or {status: 'none'} if not yet built.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: []
  },
  handler: async () => {
    const snapshot = await loadIndexSnapshot();
    if (!snapshot) {
      return jsonResult({ status: "none" });
    }
    return jsonResult(snapshot);
  }
});

register({
  name: "kb.create_weekly_summary",
  description: "Create a deterministic weekly summary artifact from referenced events and cards. week_start is normalized to Monday of that ISO week.",
  inputSchema: {
    type: "object" as const,
    properties: {
      week_start: { type: "string" as const, description: "Any date in YYYY-MM-DD; normalized to Monday of that week." },
      references: {
        type: "object" as const,
        properties: {
          events: { type: "array" as const, items: { type: "string" as const } },
          cards: { type: "array" as const, items: { type: "string" as const } }
        }
      },
      highlights: { type: "array" as const, items: { type: "string" as const } },
      decisions: { type: "array" as const, items: { type: "string" as const } },
      open_loops: { type: "array" as const, items: { type: "string" as const } },
      risks: { type: "array" as const, items: { type: "string" as const } },
      rosetta_balance: {
        type: "object" as const,
        properties: {
          A: { type: "number" as const }, C: { type: "number" as const },
          L: { type: "number" as const }, P: { type: "number" as const },
          T: { type: "number" as const }
        }
      }
    },
    required: ["week_start", "references", "highlights", "decisions", "open_loops", "risks"]
  },
  handler: async (args) => {
    const parsed = z
      .object({
        week_start: z.string(),
        references: z.object({
          events: z.array(z.string()).optional(),
          cards: z.array(z.string()).optional(),
        }).strict(),
        highlights: z.array(z.string()),
        decisions: z.array(z.string()),
        open_loops: z.array(z.string()),
        risks: z.array(z.string()),
        rosetta_balance: z
          .object({
            A: z.number(), C: z.number(), L: z.number(),
            P: z.number(), T: z.number(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(args);
    const summary = await createWeeklySummary(parsed);
    return jsonResult(summary);
  }
});

register({
  name: "kb.render_card_png",
  description: "Render a card's PNG into derived/cards/ by hash. Updates the MetaV1 sidecar render pointer. The PNG never affects the card's identity hash.",
  inputSchema: {
    type: "object" as const,
    properties: {
      hash: { type: "string" as const, description: "Full SHA-256 hex hash of the card." },
      style: { type: "string" as const, enum: ["default", "dark", "light"] },
      include_qr: { type: "boolean" as const }
    },
    required: ["hash"]
  },
  handler: async (args) => {
    const parsed = z
      .object({
        hash: z.string(),
        style: z.enum(["default", "dark", "light"]).optional(),
        include_qr: z.boolean().optional(),
      })
      .strict()
      .parse(args);
    const result = await renderCardPngToDerived(parsed.hash, {
      style: parsed.style,
      include_qr: parsed.include_qr,
    });
    return jsonResult(result);
  }
});

register({
  name: "kb.render_weekly_summary_png",
  description: "Render a weekly summary PNG into derived/summaries/ by hash. Writes a lightweight render.v1 sidecar. Never affects the summary's identity hash.",
  inputSchema: {
    type: "object" as const,
    properties: {
      hash: { type: "string" as const, description: "Full SHA-256 hex hash of the weekly summary." }
    },
    required: ["hash"]
  },
  handler: async (args) => {
    const parsed = z
      .object({ hash: z.string() })
      .strict()
      .parse(args);
    const result = await renderSummaryPngToDerived(parsed.hash);
    return jsonResult(result);
  }
});

register({
  name: "kb.storage_report",
  description: "Report vault disk usage across all data/ and derived/ subdirectories with optional budget threshold warnings.",
  inputSchema: {
    type: "object" as const,
    properties: {
      thresholds: {
        type: "object" as const,
        description: "Optional per-directory budget thresholds in GB. Keys: docs_gb, cards_gb, events_gb, blobs_gb, index_gb, derived_gb, total_gb.",
        properties: {
          docs_gb:    { type: "number" as const },
          cards_gb:   { type: "number" as const },
          events_gb:  { type: "number" as const },
          blobs_gb:   { type: "number" as const },
          index_gb:   { type: "number" as const },
          derived_gb: { type: "number" as const },
          total_gb:   { type: "number" as const }
        }
      }
    },
    required: []
  },
  handler: async (args) => {
    const parsed = z
      .object({
        thresholds: z
          .object({
            docs_gb:    z.number().optional(),
            cards_gb:   z.number().optional(),
            events_gb:  z.number().optional(),
            blobs_gb:   z.number().optional(),
            index_gb:   z.number().optional(),
            derived_gb: z.number().optional(),
            total_gb:   z.number().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(args);
    const report = await storageReport(parsed.thresholds ?? {});
    return jsonResult(report);
  }
});

register({
  name: "kb.storage_plan",
  description: "Dry-run: compute what storage actions would be taken (prune derived PNGs, archive cold docs/blobs, vacuum embeddings) without executing anything. Reads data/storage_policy.json if present.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
  handler: async (args) => {
    const out = await storagePlanHook(args ?? {});
    return jsonResult(out);
  }
});

register({
  name: "kb.storage_apply",
  description: "Execute the storage plan safely: prune derived PNGs first, archive cold docs/blobs/text to cold store, vacuum embeddings index, prune old bundles. Never touches identity or meta artifacts.",
  inputSchema: {
    type: "object" as const,
    properties: { dry_run: { type: "boolean" as const } },
    required: []
  },
  handler: async (args) => {
    const out = await storageApplyHook(args ?? {});
    return jsonResult(out);
  }
});

register({
  name: "kb.storage_restore",
  description: "Restore a cold-archived artifact by tier and hash list. For derived PNGs that were pruned (not archived), re-renders from identity JSON.",
  inputSchema: {
    type: "object" as const,
    properties: {
      tier: { type: "string" as const, enum: ["derived", "docs", "blobs", "text", "bundles", "embeddings"] },
      hashes: { type: "array" as const, items: { type: "string" as const } },
      all: { type: "boolean" as const }
    },
    required: ["tier"]
  },
  handler: async (args) => {
    const out = await storageRestoreHook(args);
    return jsonResult(out);
  }
});

// ── vm.* tools ──────────────────────────────────────────────────────────────

register({
  name: "vm.execute",
  description: "Execute a deterministic opcode program against structured state. Returns final state, execution trace, and metrics. Optionally persist the run to disk.",
  inputSchema: {
    type: "object" as const,
    properties: {
      program: { type: "object" as const, description: "VmProgram with program_id, version, and opcodes array" },
      state: { type: "object" as const, description: "Initial VmState with bags, stack, flags, notes" },
      env: { type: "object" as const, description: "VmEnv with run_seed, world_seed, optional max_steps and params" },
      options: {
        type: "object" as const,
        properties: {
          fullTrace: { type: "boolean" as const },
          expectedBagTotal: { type: "number" as const },
          maxStackDepth: { type: "number" as const },
          softHalt: { type: "boolean" as const },
          persist: { type: "boolean" as const, description: "If true, persist the run to data/runs/<hash12>/" },
          tags: { type: "array" as const, items: { type: "string" as const }, description: "Tags to attach to the run index entry (requires persist=true)" }
        }
      }
    },
    required: ["program", "state", "env"]
  },
  handler: async (args) => {
    const out = await vmExecuteHook(args);
    return jsonResult(out);
  }
});

register({
  name: "vm.list_opcodes",
  description: "List all registered opcodes with their verb family, description, and required args. Optionally filter by verb.",
  inputSchema: {
    type: "object" as const,
    properties: {
      verb: { type: "string" as const, enum: ["Attract", "Contain", "Release", "Repel", "Transform"] }
    }
  },
  handler: async (args) => {
    const out = await vmListOpcodesHook(args ?? {});
    return jsonResult(out);
  }
});

register({
  name: "vm.validate_program",
  description: "Validate a program without executing it. Checks all opcode_ids exist, verbs match, and args are well-formed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      program: { type: "object" as const }
    },
    required: ["program"]
  },
  handler: async (args) => {
    const out = await vmValidateProgramHook(args);
    return jsonResult(out);
  }
});

register({
  name: "vm.compare",
  description: "Compare two VmResult objects using configurable alignment (step, opcode_signature, or milestone). Produces deltas for scalars, verb distribution, bag values, opcode frequency, and a summary.",
  inputSchema: {
    type: "object" as const,
    properties: {
      a: { type: "object" as const, description: "First VmResult (state, trace, metrics)" },
      b: { type: "object" as const, description: "Second VmResult (state, trace, metrics)" },
      a_run_hash: { type: "string" as const, description: "Optional run hash for result A" },
      b_run_hash: { type: "string" as const, description: "Optional run hash for result B" },
      align: { type: "string" as const, enum: ["step", "opcode_signature", "milestone"], description: "Alignment mode (default: step)" },
      milestones: { type: "object" as const, properties: { opcode_ids: { type: "array" as const, items: { type: "string" as const } } }, description: "Custom milestone opcode IDs (for milestone alignment)" }
    },
    required: ["a", "b"]
  },
  handler: async (args) => {
    const out = await vmCompareHook(args);
    return jsonResult(out);
  }
});

register({
  name: "vm.phase_scan",
  description: "Run a parameter sweep over env knobs. Supports grid mode (cartesian) and adaptive mode (bisection refinement around phase transitions).",
  inputSchema: {
    type: "object" as const,
    properties: {
      program: { type: "object" as const, description: "VmProgram to scan" },
      state0: { type: "object" as const, description: "Initial VmState" },
      base_env: { type: "object" as const, description: "Base VmEnv (knobs override specific fields)" },
      knobs: { type: "array" as const, items: { type: "object" as const, properties: { key: { type: "string" as const }, values: { type: "array" as const } }, required: ["key", "values"] }, description: "Array of knobs: { key, values[] }" },
      include_trace: { type: "boolean" as const, description: "Include full trace per grid point (default false)" },
      options: { type: "object" as const, properties: { softHalt: { type: "boolean" as const }, expectedBagTotal: { type: "number" as const } } },
      scan_mode: { type: "string" as const, enum: ["grid", "adaptive", "hunt_boundaries"], description: "Scan mode (default: grid)" },
      adaptive: { type: "object" as const, properties: { max_refinements: { type: "number" as const, description: "Max bisection rounds (default 3)" }, max_total_runs: { type: "number" as const, description: "Max total executions (default 100)" } }, description: "Adaptive mode options" },
      boundary_hunt: { type: "object" as const, properties: { max_refinements: { type: "number" as const }, max_total_runs: { type: "number" as const }, expansion_steps: { type: "number" as const }, expansion_factor: { type: "number" as const } }, description: "Boundary hunt mode options" }
    },
    required: ["program", "state0", "base_env", "knobs"]
  },
  handler: async (args) => {
    const out = await vmPhaseScanHook(args);
    return jsonResult(out);
  }
});

register({
  name: "vm.list_runs",
  description: "List all persisted VM run metadata, sorted by hash prefix.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: []
  },
  handler: async (args) => {
    const out = await vmListRunsHook(args ?? {});
    return jsonResult(out);
  }
});

register({
  name: "vm.search_runs",
  description: "Search the run index with filters: program fingerprint/id, env ranges, metric thresholds, tags, halted_early. Supports pagination.",
  inputSchema: {
    type: "object" as const,
    properties: {
      program_fingerprint: { type: "string" as const },
      program_id: { type: "string" as const },
      run_seed_min: { type: "number" as const },
      run_seed_max: { type: "number" as const },
      world_seed_min: { type: "number" as const },
      world_seed_max: { type: "number" as const },
      total_steps_min: { type: "number" as const },
      total_steps_max: { type: "number" as const },
      final_bag_sum_min: { type: "number" as const },
      final_bag_sum_max: { type: "number" as const },
      halted_early: { type: "boolean" as const },
      tags: { type: "array" as const, items: { type: "string" as const }, description: "Filter by tags (AND logic)" },
      limit: { type: "number" as const, description: "Max results (default 50)" },
      offset: { type: "number" as const, description: "Skip first N results (default 0)" }
    }
  },
  handler: async (args) => {
    const out = await vmSearchRunsHook(args ?? {});
    return jsonResult(out);
  }
});

register({
  name: "vm.search_scans",
  description: "Search the scan index with filters: program_id, hint counts, grid size, adaptive mode, halt fraction. Supports pagination.",
  inputSchema: {
    type: "object" as const,
    properties: {
      program_id: { type: "string" as const },
      program_fingerprint: { type: "string" as const },
      min_hints: { type: "number" as const },
      max_hints: { type: "number" as const },
      min_grid_points: { type: "number" as const },
      max_grid_points: { type: "number" as const },
      has_adaptive: { type: "boolean" as const },
      halt_fraction_min: { type: "number" as const },
      halt_fraction_max: { type: "number" as const },
      limit: { type: "number" as const, description: "Max results (default 50)" },
      offset: { type: "number" as const, description: "Skip first N results (default 0)" }
    }
  },
  handler: async (args) => {
    const out = await vmSearchScansHook(args ?? {});
    return jsonResult(out);
  }
});

register({
  name: "vm.get_scan",
  description: "Get a scan by ID (full hash or 12-char prefix). Returns the scan index record plus paths to report and signature files.",
  inputSchema: {
    type: "object" as const,
    properties: {
      scan_id: { type: "string" as const, description: "Scan hash (full or 12-char prefix)" }
    },
    required: ["scan_id"]
  },
  handler: async (args) => {
    const out = await vmGetScanHook(args);
    return jsonResult(out);
  }
});

register({
  name: "vm.top_scans",
  description: "Get the top scans ranked by interestingness score. Scores are based on transition density, metric cliff magnitude, opcode concentration, and adaptive refinements.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number" as const, description: "Max results (default 50)" },
      program_id: { type: "string" as const, description: "Filter by program ID" }
    }
  },
  handler: async (args) => {
    const out = await vmTopScansHook(args ?? {});
    return jsonResult(out);
  }
});

register({
  name: "vm.top_transitions",
  description: "Get the top individual phase transitions ranked by interestingness. Scores transitions by scalar delta magnitude, opcode gating, and cliff significance.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number" as const, description: "Max results (default 200)" },
      program_id: { type: "string" as const, description: "Filter by program ID" }
    }
  },
  handler: async (args) => {
    const out = await vmTopTransitionsHook(args ?? {});
    return jsonResult(out);
  }
});

register({
  name: "vm.top_novel_scans",
  description: "Get the top scans ranked by novelty (cosine distance from other scans). Novel scans explore unique regions of behavior space.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number" as const, description: "Max results (default 50)" },
      program_id: { type: "string" as const, description: "Filter by program ID" }
    }
  },
  handler: async (args) => {
    const out = await vmTopNovelScansHook(args ?? {});
    return jsonResult(out);
  }
});

// ── vault.* tools ───────────────────────────────────────────────────────────

register({
  name: "vault.put",
  description: "Store a content-addressed artifact in the vault. Deduplicates by structural hash of (version, kind, payload, tags, refs). Returns artifact ID and whether it was newly created.",
  inputSchema: {
    type: "object" as const,
    properties: {
      kind: { type: "string" as const, enum: ["event", "fact", "decision", "skill", "profile", "tool_obs", "summary", "project"], description: "Artifact kind" },
      payload: { type: "object" as const, description: "Arbitrary structured payload (no temporal/env keys allowed)" },
      tags: { type: "array" as const, items: { type: "string" as const }, description: "Structural tags (affect identity hash). Use personal: prefix for private artifacts." },
      refs: { type: "array" as const, items: { type: "object" as const, properties: { kind: { type: "string" as const }, id: { type: "string" as const } }, required: ["kind", "id"] }, description: "Referenced artifact IDs" },
      source: { type: "object" as const, properties: { agent: { type: "string" as const }, tool: { type: "string" as const }, repo: { type: "string" as const }, run_id: { type: "string" as const } }, description: "Provenance (excluded from hash)" },
    },
    required: ["kind", "payload"]
  },
  handler: async (args) => {
    try {
      const parsed = VaultPutInputSchema.parse(args);
      const out = await vaultPut(parsed);
      return jsonResult(out);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Determinism violation")) {
        return jsonResult({ error: "INVALID_ARTIFACT", message: msg });
      }
      throw e;
    }
  }
});

register({
  name: "vault.get",
  description: "Retrieve an artifact by its content-addressed ID (sha256 hex).",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: { type: "string" as const, description: "Artifact ID (sha256 hex)" },
    },
    required: ["id"]
  },
  handler: async (args) => {
    const parsed = VaultGetInputSchema.parse(args);
    const out = await vaultGet(parsed.id);
    if (!out) {
      return jsonResult({ error: "NOT_FOUND" });
    }
    return jsonResult(out);
  }
});

register({
  name: "vault.search",
  description: "Search artifacts by full-text query over payload+tags+kind, with optional filters. Supports hybrid (FTS + embedding), semantic-only, or lexical-only search modes. Use exclude_personal=true to omit personal: tagged artifacts.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string" as const, description: "Full-text search query" },
      kind: { type: "string" as const, enum: ["event", "fact", "decision", "skill", "profile", "tool_obs", "summary", "project"], description: "Filter by artifact kind" },
      tags: { type: "array" as const, items: { type: "string" as const }, description: "Filter by tags (AND logic)" },
      exclude_personal: { type: "boolean" as const, description: "Exclude artifacts with personal: tags (default false)" },
      limit: { type: "number" as const, description: "Max results (default 10)" },
      offset: { type: "number" as const, description: "Pagination offset (default 0)" },
      search_mode: { type: "string" as const, enum: ["hybrid", "semantic", "lexical"], description: "Search mode: hybrid (FTS + embeddings, default), semantic (embeddings only), or lexical (FTS only)" },
    }
  },
  handler: async (args) => {
    const parsed = VaultSearchInputSchema.parse(args);
    const out = await vaultSearch(parsed);
    return jsonResult(out);
  }
});

register({
  name: "vault.reindex_embeddings",
  description: "Walk all vault artifacts and compute embeddings for any missing from the embeddings table. Returns count of newly embedded artifacts. Requires a running embedding endpoint.",
  inputSchema: {
    type: "object" as const,
    properties: {
      batch_size: { type: "number" as const, description: "Number of texts to embed per batch (default 32)" },
    }
  },
  handler: async (args) => {
    const batchSize = (args as { batch_size?: number }).batch_size ?? 32;
    const indexDb = getDb();
    const missingIds = getMissingIds(indexDb);

    if (missingIds.length === 0) {
      return jsonResult({ embedded: 0, total: 0, message: "All artifacts already have embeddings." });
    }

    // Get payload_text for missing IDs
    const info = await getModelInfo();
    if (!info) {
      return jsonResult({ error: "ENDPOINT_UNAVAILABLE", message: "Embedding endpoint is not reachable." });
    }

    let embedded = 0;
    for (let i = 0; i < missingIds.length; i += batchSize) {
      const batchIds = missingIds.slice(i, i + batchSize);
      // Get payload text and tags for each
      const placeholders = batchIds.map(() => "?").join(",");
      const rows = indexDb.prepare(
        `SELECT id, payload_text, tags FROM artifacts WHERE id IN (${placeholders})`,
      ).all(...batchIds) as Array<{ id: string; payload_text: string; tags: string }>;

      const texts = rows.map((r) => r.payload_text + " " + (JSON.parse(r.tags) as string[]).join(" "));
      const vectors = await embed(texts);
      if (!vectors) continue;

      for (let j = 0; j < rows.length; j++) {
        if (vectors[j]) {
          upsertEmbedding(rows[j].id, vectors[j], info.model);
          embedded++;
        }
      }
    }

    return jsonResult({ embedded, total: missingIds.length, model: info.model, dim: info.dim });
  }
});

// ── execution.* tools ───────────────────────────────────────────────────────

register({
  name: "execution.get_pipeline",
  description: "Get all execution artifacts in a pipeline, ordered by step_index.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pipeline_id: { type: "string" as const, description: "Pipeline identifier" }
    },
    required: ["pipeline_id"]
  },
  handler: async (args) => {
    const out = await executionGetPipelineHook(args);
    return jsonResult(out);
  }
});

register({
  name: "execution.walk_parents",
  description: "Walk the parent chain from an execution artifact back to the root. Returns root-first order.",
  inputSchema: {
    type: "object" as const,
    properties: {
      hash: { type: "string" as const, description: "Execution artifact hash to start from" }
    },
    required: ["hash"]
  },
  handler: async (args) => {
    const out = await executionWalkParentsHook(args);
    return jsonResult(out);
  }
});

register({
  name: "execution.get_children",
  description: "Get all execution artifacts whose parent_execution_id matches the given hash.",
  inputSchema: {
    type: "object" as const,
    properties: {
      hash: { type: "string" as const, description: "Parent execution artifact hash" }
    },
    required: ["hash"]
  },
  handler: async (args) => {
    const out = await executionGetChildrenHook(args);
    return jsonResult(out);
  }
});

register({
  name: "execution.get_siblings",
  description: "Get all execution artifacts in the same pipeline as the given hash, ordered by step_index.",
  inputSchema: {
    type: "object" as const,
    properties: {
      hash: { type: "string" as const, description: "Execution artifact hash" }
    },
    required: ["hash"]
  },
  handler: async (args) => {
    const out = await executionGetSiblingsHook(args);
    return jsonResult(out);
  }
});

register({
  name: "execution.check_integrity",
  description: "Check chain integrity across execution artifacts. Detects missing parents, cycles, duplicate step_index, and pipeline contamination.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pipeline_id: { type: "string" as const, description: "Optional: check only this pipeline" }
    }
  },
  handler: async (args) => {
    const out = await executionCheckIntegrityHook(args);
    return jsonResult(out);
  }
});

register({
  name: "execution.get_pipeline_view",
  description: "Get a complete pipeline view: ordered steps + integrity issues.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pipeline_id: { type: "string" as const, description: "Pipeline identifier" }
    },
    required: ["pipeline_id"]
  },
  handler: async (args) => {
    const out = await executionGetPipelineViewHook(args);
    return jsonResult(out);
  }
});

register({
  name: "execution.list_pipelines",
  description: "List all distinct pipeline IDs found in execution artifacts.",
  inputSchema: {
    type: "object" as const,
    properties: {}
  },
  handler: async (args) => {
    const out = await executionListPipelinesHook(args);
    return jsonResult(out);
  }
});

register({
  name: "execution.build_evidence_bundle",
  description: "Build a deterministic structured evidence bundle from a pipeline's execution graph.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pipeline_id: { type: "string" as const, description: "Pipeline identifier" }
    },
    required: ["pipeline_id"]
  },
  handler: async (args) => {
    const out = await buildEvidenceBundleHook(args);
    return jsonResult(out);
  }
});

// ── artifact.* tools ────────────────────────────────────────────────────────

register({
  name: "artifact.bless",
  description: "Bless a candidate artifact, promoting it to blessed status with supporting evidence refs. Requires at least one evidence ref. Rejects if integrity issues exist unless override_integrity is set.",
  inputSchema: {
    type: "object" as const,
    properties: {
      target_hash: { type: "string" as const, description: "Hash of the artifact to bless" },
      evidence_refs: { type: "array" as const, items: { type: "object" as const, properties: { ref_type: { type: "string" as const, enum: ["execution_hash", "artifact_hash", "pipeline_id", "external_id", "url"] }, value: { type: "string" as const }, label: { type: "string" as const } }, required: ["ref_type", "value"] }, description: "Supporting evidence references" },
      reason: { type: "string" as const, description: "Reason for blessing" },
      integrity_summary: { type: "object" as const, description: "Optional pipeline integrity summary" },
      override_integrity: { type: "boolean" as const, description: "Override integrity check failures (default false)" },
      tags: { type: "array" as const, items: { type: "string" as const }, description: "Optional tags" }
    },
    required: ["target_hash", "evidence_refs", "reason"]
  },
  handler: async (args) => {
    const out = await blessArtifactHook(args);
    return jsonResult(out);
  }
});

register({
  name: "artifact.deprecate",
  description: "Deprecate an artifact with a reason and optional evidence refs.",
  inputSchema: {
    type: "object" as const,
    properties: {
      target_hash: { type: "string" as const, description: "Hash of the artifact to deprecate" },
      reason: { type: "string" as const, description: "Reason for deprecation" },
      evidence_refs: { type: "array" as const, items: { type: "object" as const, properties: { ref_type: { type: "string" as const }, value: { type: "string" as const }, label: { type: "string" as const } }, required: ["ref_type", "value"] }, description: "Optional evidence references" },
      tags: { type: "array" as const, items: { type: "string" as const }, description: "Optional tags" }
    },
    required: ["target_hash", "reason"]
  },
  handler: async (args) => {
    const out = await deprecateArtifactHook(args);
    return jsonResult(out);
  }
});

register({
  name: "artifact.supersede",
  description: "Supersede an old artifact with a new one, creating an explicit old->new linkage.",
  inputSchema: {
    type: "object" as const,
    properties: {
      old_hash: { type: "string" as const, description: "Hash of the artifact being superseded" },
      new_hash: { type: "string" as const, description: "Hash of the replacement artifact" },
      reason: { type: "string" as const, description: "Reason for supersession" },
      evidence_refs: { type: "array" as const, items: { type: "object" as const, properties: { ref_type: { type: "string" as const }, value: { type: "string" as const }, label: { type: "string" as const } }, required: ["ref_type", "value"] }, description: "Optional evidence references" },
      tags: { type: "array" as const, items: { type: "string" as const }, description: "Optional tags" }
    },
    required: ["old_hash", "new_hash", "reason"]
  },
  handler: async (args) => {
    const out = await supersedeArtifactHook(args);
    return jsonResult(out);
  }
});

register({
  name: "artifact.collect_evidence",
  description: "Gather evidence refs from pipelines, execution hashes, and artifact hashes for later use in blessing.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pipeline_id: { type: "string" as const, description: "Optional pipeline ID to include" },
      artifact_hashes: { type: "array" as const, items: { type: "string" as const }, description: "Artifact hashes to include" },
      execution_hashes: { type: "array" as const, items: { type: "string" as const }, description: "Execution hashes to include" }
    }
  },
  handler: async (args) => {
    const out = await collectEvidenceHook(args);
    return jsonResult(out);
  }
});

// ── corpus.* tools ──────────────────────────────────────────────────────────

register({
  name: "corpus.import_local",
  description: "Deterministically import a local corpus folder into normal vault artifacts.",
  inputSchema: {
    type: "object" as const,
    properties: {
      root_path: { type: "string" as const },
      include_extensions: { type: "array" as const, items: { type: "string" as const } },
      recursive: { type: "boolean" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
      source_label: { type: "string" as const },
      build_cards: { type: "boolean" as const },
      export_graph: { type: "boolean" as const },
      promote_facts: { type: "boolean" as const },
      promote_skills: { type: "boolean" as const },
      promote_summary: { type: "boolean" as const }
    },
    required: ["root_path"]
  },
  handler: async (args) => {
    const parsed = RunLocalCorpusImportInputSchema.parse(args);
    const out = await runLocalCorpusImport(parsed);
    const result = {
      imported_count: out.import.imported_count,
      skipped_count: out.import.skipped_count,
      doc_ids: out.import.doc_ids,
      card_ids: out.build.built_card_ids,
      execution_ids: out.build.execution_ids,
      graph_path: out.graph.graph_path,
      promotion: out.promotion,
      errors: out.import.errors,
      source_summary: {
        root_path: parsed.root_path,
        recursive: parsed.recursive,
      },
    };
    return jsonResult(result);
  }
});

register({
  name: "corpus.import_github",
  description: "Deterministically import docs/text from a public GitHub repository.",
  inputSchema: {
    type: "object" as const,
    properties: {
      repo_url: { type: "string" as const },
      branch: { type: "string" as const },
      path_filter: { type: "array" as const, items: { type: "string" as const } },
      include_extensions: { type: "array" as const, items: { type: "string" as const } },
      max_files: { type: "number" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
      source_label: { type: "string" as const },
      build_cards: { type: "boolean" as const },
      export_graph: { type: "boolean" as const },
      promote_facts: { type: "boolean" as const },
      promote_skills: { type: "boolean" as const },
      promote_summary: { type: "boolean" as const }
    },
    required: ["repo_url"]
  },
  handler: async (args) => {
    const parsed = RunGithubCorpusImportInputSchema.parse(args);
    const out = await runGithubCorpusImport(parsed);
    const result = {
      imported_count: out.import.imported_count,
      skipped_count: out.import.skipped_count,
      doc_ids: out.import.doc_ids,
      card_ids: out.build.built_card_ids,
      execution_ids: out.build.execution_ids,
      graph_path: out.graph.graph_path,
      promotion: out.promotion,
      source_summary: out.import.source_summary,
      errors: out.import.errors,
    };
    return jsonResult(result);
  }
});

register({
  name: "corpus.import_arxiv",
  description: "Deterministically import arXiv title/abstract corpus snippets.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string" as const },
      max_results: { type: "number" as const },
      include_abstract_only: { type: "boolean" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
      source_label: { type: "string" as const },
      build_cards: { type: "boolean" as const },
      export_graph: { type: "boolean" as const },
      promote_facts: { type: "boolean" as const },
      promote_skills: { type: "boolean" as const },
      promote_summary: { type: "boolean" as const }
    },
    required: ["query"]
  },
  handler: async (args) => {
    const parsed = RunArxivCorpusImportInputSchema.parse(args);
    const out = await runArxivCorpusImport(parsed);
    const result = {
      imported_count: out.import.imported_count,
      doc_ids: out.import.doc_ids,
      card_ids: out.build.built_card_ids,
      execution_ids: out.build.execution_ids,
      graph_path: out.graph.graph_path,
      promotion: out.promotion,
      source_summary: out.import.source_summary,
      errors: out.import.errors,
    };
    return jsonResult(result);
  }
});

register({
  name: "corpus.import_synthetic",
  description: "Generate a deterministic synthetic corpus with optional graph/promotion actions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      theme: { type: "string" as const },
      doc_count: { type: "number" as const },
      pipeline_count: { type: "number" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
      build_cards: { type: "boolean" as const },
      export_graph: { type: "boolean" as const },
      promote_facts: { type: "boolean" as const },
      promote_skills: { type: "boolean" as const },
      promote_summary: { type: "boolean" as const }
    }
  },
  handler: async (args) => {
    const parsed = RunSyntheticCorpusImportInputSchema.parse(args);
    const out = await runSyntheticCorpusImport(parsed);
    const result = {
      imported_count: out.import.imported_count,
      doc_ids: out.import.doc_ids,
      generated_execution_count: out.import.generated_execution_count,
      generated_event_count: out.import.generated_event_count,
      generated_execution_ids: out.import.generated_execution_ids,
      generated_event_ids: out.import.generated_event_ids,
      card_ids: out.build.built_card_ids,
      execution_ids: out.build.execution_ids,
      graph_path: out.graph.graph_path,
      promotion: out.promotion,
      source_summary: {
        theme: parsed.theme,
        doc_count: parsed.doc_count,
        pipeline_count: parsed.pipeline_count,
      },
    };
    return jsonResult(result);
  }
});

// ── promotion.* tools ───────────────────────────────────────────────────────

register({
  name: "promotion.promote_facts",
  description: "Promote deterministic fact candidates from imported document artifact references.",
  inputSchema: {
    type: "object" as const,
    properties: {
      doc_ids: { type: "array" as const, items: { type: "string" as const } },
      tags: { type: "array" as const, items: { type: "string" as const } },
      source_label: { type: "string" as const }
    },
    required: ["doc_ids"]
  },
  handler: async (args) => {
    const parsed = PromotionPromoteFactsInputSchema.parse(args);
    const out = await promoteFactsHook(parsed);
    return jsonResult(out);
  }
});

register({
  name: "promotion.promote_skills",
  description: "Promote deterministic skill candidates from execution evidence references.",
  inputSchema: {
    type: "object" as const,
    properties: {
      execution_ids: { type: "array" as const, items: { type: "string" as const } },
      pipeline_id: { type: "string" as const },
      tags: { type: "array" as const, items: { type: "string" as const } }
    }
  },
  handler: async (args) => {
    const parsed = PromotionPromoteSkillsInputSchema.parse(args);
    const out = await promoteSkillsHook(parsed);
    return jsonResult(out);
  }
});

register({
  name: "promotion.promote_summary",
  description: "Promote a deterministic summary candidate over doc/execution/fact/skill references.",
  inputSchema: {
    type: "object" as const,
    properties: {
      doc_ids: { type: "array" as const, items: { type: "string" as const } },
      execution_ids: { type: "array" as const, items: { type: "string" as const } },
      fact_ids: { type: "array" as const, items: { type: "string" as const } },
      skill_ids: { type: "array" as const, items: { type: "string" as const } },
      label: { type: "string" as const },
      tags: { type: "array" as const, items: { type: "string" as const } }
    }
  },
  handler: async (args) => {
    const parsed = PromotionPromoteSummaryInputSchema.parse(args);
    const out = await promoteSummaryHook(parsed);
    return jsonResult(out);
  }
});

register({
  name: "promotion.build_bundle",
  description: "Build a deterministic promotion bundle from corpus references and optional generated promotions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      doc_ids: { type: "array" as const, items: { type: "string" as const } },
      execution_ids: { type: "array" as const, items: { type: "string" as const } },
      include_facts: { type: "boolean" as const },
      include_skills: { type: "boolean" as const },
      include_summary: { type: "boolean" as const },
      label: { type: "string" as const },
      tags: { type: "array" as const, items: { type: "string" as const } }
    }
  },
  handler: async (args) => {
    const parsed = PromotionBuildBundleInputSchema.parse(args);
    const out = await buildPromotionBundleHook(parsed);
    return jsonResult(out);
  }
});

// ── memory.* tools ──────────────────────────────────────────────────────────

register({
  name: "memory.session_start",
  description: "Start a new memory session. Ends any existing active session first. Returns the new session state with a unique session_id.",
  inputSchema: {
    type: "object" as const,
    properties: {}
  },
  handler: async () => {
    const state = await startSession();
    return jsonResult(state);
  }
});

register({
  name: "memory.session_end",
  description: "End the current memory session. Returns the final session state, or null if no session was active.",
  inputSchema: {
    type: "object" as const,
    properties: {}
  },
  handler: async () => {
    const state = await endSession();
    return jsonResult(state ?? { message: "No active session." });
  }
});

register({
  name: "memory.ingest_turn",
  description: "Ingest a conversation turn into the memory layer. Stores as a content-addressed vault artifact with memory:* tags. Returns the artifact ID.",
  inputSchema: {
    type: "object" as const,
    properties: {
      role: { type: "string" as const, description: "Turn role (user, assistant, system)" },
      content: { type: "string" as const, description: "Turn content text" },
      turn_number: { type: "number" as const, description: "Sequential turn number within the session" },
    },
    required: ["role", "content", "turn_number"]
  },
  handler: async (args) => {
    const { role, content, turn_number } = args as { role: string; content: string; turn_number: number };
    const session = await getSession();
    if (!session?.active) {
      return jsonResult({ error: "NO_ACTIVE_SESSION", message: "Start a session first with memory.session_start." });
    }
    const id = await ingestTurn({ role, content, turn_number }, session.session_id);
    await recordTurn();
    return jsonResult({ id, session_id: session.session_id, turn_number });
  }
});

register({
  name: "memory.compact",
  description: "Trigger progressive compaction across all memory bands. Band 0 verbatim turns age into Band 1 summaries, and Band 1 summaries age into Band 2 extracted facts.",
  inputSchema: {
    type: "object" as const,
    properties: {}
  },
  handler: async () => {
    const session = await getSession();
    if (!session?.active) {
      return jsonResult({ error: "NO_ACTIVE_SESSION", message: "Start a session first." });
    }
    const band0 = await compactBand(0, session.session_id, session.turn_count);
    const band1 = await compactBand(1, session.session_id, session.turn_count);
    return jsonResult({
      session_id: session.session_id,
      turn_count: session.turn_count,
      band0_compact: band0,
      band1_compact: band1,
    });
  }
});

register({
  name: "memory.get_context",
  description: "Reconstruct a context string from memory artifacts. Pulls Band 0 verbatim turns + Band 1 summaries + Band 2 facts, fitting within the token budget.",
  inputSchema: {
    type: "object" as const,
    properties: {
      token_budget: { type: "number" as const, description: "Maximum tokens for the context window (default 2000)" },
    }
  },
  handler: async (args) => {
    const { token_budget } = args as { token_budget?: number };
    const session = await getSession();
    if (!session?.active) {
      return jsonResult({ error: "NO_ACTIVE_SESSION", message: "Start a session first." });
    }
    const context = await getContextWindow(session.session_id, token_budget ?? 2000);
    return jsonResult({ session_id: session.session_id, context, approx_tokens: Math.ceil(context.length / 4) });
  }
});
