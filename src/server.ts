import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { addDocument, buildCard, searchCards, getCard } from "./kb/store.js";
import { createEventCard, createExecutionArtifact, storagePlanHook, storageApplyHook, storageRestoreHook, executionGetPipelineHook, executionWalkParentsHook, executionGetChildrenHook, executionGetSiblingsHook, executionCheckIntegrityHook, executionGetPipelineViewHook, executionListPipelinesHook } from "./kb/hooks.js";
import { loadMeta, mergeMeta } from "./kb/vault.js";
import { MetaPatchSchema, EventCreateInputSchema, ExecutionCreateInputSchema } from "./kb/schema.js";
import { rebuildIndex, loadIndexSnapshot, SNAPSHOT_PATH } from "./kb/index.js";
import { createWeeklySummary } from "./kb/summary.js";
import { renderCardPngToDerived, renderSummaryPngToDerived, storageReport } from "./kb/derived.js";
import { vmExecuteHook, vmListOpcodesHook, vmValidateProgramHook, vmCompareHook, vmPhaseScanHook, vmListRunsHook, vmSearchRunsHook, vmSearchScansHook, vmGetScanHook, vmTopScansHook, vmTopTransitionsHook, vmTopNovelScansHook } from "./kb/vm_hooks.js";
import { vaultPut, vaultGet, vaultSearch, VaultPutInputSchema, VaultGetInputSchema, VaultSearchInputSchema } from "./vault/index.js";

const server = new Server(
  { name: "rosetta-cards-kb", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
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
        }
      },
      {
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
        }
      },
      {
        name: "kb.search",
        description: "Search over cards (currently lexical cosine; swap to embeddings later).",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string" as const },
            top_k: { type: "number" as const }
          },
          required: ["query"]
        }
      },
      {
        name: "kb.get_card",
        description: "Fetch a card JSON and PNG path by card_id.",
        inputSchema: {
          type: "object" as const,
          properties: {
            card_id: { type: "string" as const }
          },
          required: ["card_id"]
        }
      },
      {
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
        }
      },
      {
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
        }
      },
      {
        name: "kb.get_meta",
        description: "Retrieve the sidecar metadata for an artifact by hash and type.",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifact_hash: { type: "string" as const },
            artifact_type: { type: "string" as const, enum: ["card", "event", "execution"] }
          },
          required: ["artifact_hash", "artifact_type"]
        }
      },
      {
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
        }
      },
      {
        name: "kb.rebuild_index",
        description: "Scan all on-disk artifacts and meta sidecars and rebuild the index snapshot. Returns summary counts and the snapshot path.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: []
        }
      },
      {
        name: "kb.index_status",
        description: "Return the current index snapshot if it exists, or {status: 'none'} if not yet built.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: []
        }
      },
      {
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
        }
      },
      {
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
        }
      },
      {
        name: "kb.render_weekly_summary_png",
        description: "Render a weekly summary PNG into derived/summaries/ by hash. Writes a lightweight render.v1 sidecar. Never affects the summary's identity hash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            hash: { type: "string" as const, description: "Full SHA-256 hex hash of the weekly summary." }
          },
          required: ["hash"]
        }
      },
      {
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
        }
      },
      {
        name: "kb.storage_plan",
        description: "Dry-run: compute what storage actions would be taken (prune derived PNGs, archive cold docs/blobs, vacuum embeddings) without executing anything. Reads data/storage_policy.json if present.",
        inputSchema: { type: "object" as const, properties: {}, required: [] }
      },
      {
        name: "kb.storage_apply",
        description: "Execute the storage plan safely: prune derived PNGs first, archive cold docs/blobs/text to cold store, vacuum embeddings index, prune old bundles. Never touches identity or meta artifacts.",
        inputSchema: {
          type: "object" as const,
          properties: { dry_run: { type: "boolean" as const } },
          required: []
        }
      },
      {
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
        }
      },
      {
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
        }
      },
      {
        name: "vm.list_opcodes",
        description: "List all registered opcodes with their verb family, description, and required args. Optionally filter by verb.",
        inputSchema: {
          type: "object" as const,
          properties: {
            verb: { type: "string" as const, enum: ["Attract", "Contain", "Release", "Repel", "Transform"] }
          }
        }
      },
      {
        name: "vm.validate_program",
        description: "Validate a program without executing it. Checks all opcode_ids exist, verbs match, and args are well-formed.",
        inputSchema: {
          type: "object" as const,
          properties: {
            program: { type: "object" as const }
          },
          required: ["program"]
        }
      },
      {
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
        }
      },
      {
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
        }
      },
      {
        name: "vm.list_runs",
        description: "List all persisted VM run metadata, sorted by hash prefix.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: []
        }
      },
      {
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
        }
      },
      {
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
        }
      },
      {
        name: "vm.get_scan",
        description: "Get a scan by ID (full hash or 12-char prefix). Returns the scan index record plus paths to report and signature files.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scan_id: { type: "string" as const, description: "Scan hash (full or 12-char prefix)" }
          },
          required: ["scan_id"]
        }
      },
      {
        name: "vm.top_scans",
        description: "Get the top scans ranked by interestingness score. Scores are based on transition density, metric cliff magnitude, opcode concentration, and adaptive refinements.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: { type: "number" as const, description: "Max results (default 50)" },
            program_id: { type: "string" as const, description: "Filter by program ID" }
          }
        }
      },
      {
        name: "vm.top_transitions",
        description: "Get the top individual phase transitions ranked by interestingness. Scores transitions by scalar delta magnitude, opcode gating, and cliff significance.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: { type: "number" as const, description: "Max results (default 200)" },
            program_id: { type: "string" as const, description: "Filter by program ID" }
          }
        }
      },
      {
        name: "vm.top_novel_scans",
        description: "Get the top scans ranked by novelty (cosine distance from other scans). Novel scans explore unique regions of behavior space.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: { type: "number" as const, description: "Max results (default 50)" },
            program_id: { type: "string" as const, description: "Filter by program ID" }
          }
        }
      },
      {
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
        }
      },
      {
        name: "vault.get",
        description: "Retrieve an artifact by its content-addressed ID (sha256 hex).",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, description: "Artifact ID (sha256 hex)" },
          },
          required: ["id"]
        }
      },
      {
        name: "vault.search",
        description: "Search artifacts by full-text query over payload+tags+kind, with optional filters. Use exclude_personal=true to omit personal: tagged artifacts.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string" as const, description: "Full-text search query" },
            kind: { type: "string" as const, enum: ["event", "fact", "decision", "skill", "profile", "tool_obs", "summary", "project"], description: "Filter by artifact kind" },
            tags: { type: "array" as const, items: { type: "string" as const }, description: "Filter by tags (AND logic)" },
            exclude_personal: { type: "boolean" as const, description: "Exclude artifacts with personal: tags (default false)" },
            limit: { type: "number" as const, description: "Max results (default 10)" },
            offset: { type: "number" as const, description: "Pagination offset (default 0)" },
          }
        }
      },
      {
        name: "execution.get_pipeline",
        description: "Get all execution artifacts in a pipeline, ordered by step_index.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pipeline_id: { type: "string" as const, description: "Pipeline identifier" }
          },
          required: ["pipeline_id"]
        }
      },
      {
        name: "execution.walk_parents",
        description: "Walk the parent chain from an execution artifact back to the root. Returns root-first order.",
        inputSchema: {
          type: "object" as const,
          properties: {
            hash: { type: "string" as const, description: "Execution artifact hash to start from" }
          },
          required: ["hash"]
        }
      },
      {
        name: "execution.get_children",
        description: "Get all execution artifacts whose parent_execution_id matches the given hash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            hash: { type: "string" as const, description: "Parent execution artifact hash" }
          },
          required: ["hash"]
        }
      },
      {
        name: "execution.get_siblings",
        description: "Get all execution artifacts in the same pipeline as the given hash, ordered by step_index.",
        inputSchema: {
          type: "object" as const,
          properties: {
            hash: { type: "string" as const, description: "Execution artifact hash" }
          },
          required: ["hash"]
        }
      },
      {
        name: "execution.check_integrity",
        description: "Check chain integrity across execution artifacts. Detects missing parents, cycles, duplicate step_index, and pipeline contamination.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pipeline_id: { type: "string" as const, description: "Optional: check only this pipeline" }
          }
        }
      },
      {
        name: "execution.get_pipeline_view",
        description: "Get a complete pipeline view: ordered steps + integrity issues.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pipeline_id: { type: "string" as const, description: "Pipeline identifier" }
          },
          required: ["pipeline_id"]
        }
      },
      {
        name: "execution.list_pipelines",
        description: "List all distinct pipeline IDs found in execution artifacts.",
        inputSchema: {
          type: "object" as const,
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "kb.add_document") {
    const parsed = z
      .object({
        title: z.string(),
        text: z.string(),
        tags: z.array(z.string()).optional(),
        source_url: z.string().optional()
      })
      .parse(args);
    const out = await addDocument(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.build_card") {
    const parsed = z
      .object({
        doc_id: z.string(),
        chunk_id: z.number().optional(),
        style: z.enum(["default", "dark", "light"]).optional(),
        include_qr: z.boolean().optional()
      })
      .parse(args);
    const out = await buildCard(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.search") {
    const parsed = z
      .object({
        query: z.string(),
        top_k: z.number().optional()
      })
      .parse(args);
    const out = await searchCards(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.get_card") {
    const parsed = z.object({ card_id: z.string() }).parse(args);
    const out = await getCard(parsed.card_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.create_event") {
    // Validation is fully delegated to createEventCard (uses EventCreateInputSchema internally)
    const out = await createEventCard(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.create_execution") {
    const out = await createExecutionArtifact(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.get_meta") {
    const parsed = z
      .object({
        artifact_hash: z.string(),
        artifact_type: z.enum(["card", "event", "execution"]),
      })
      .strict()
      .parse(args);
    const meta = await loadMeta(parsed.artifact_hash, parsed.artifact_type);
    if (!meta) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(meta, null, 2) }] };
  }

  if (name === "kb.merge_meta") {
    const parsed = z
      .object({
        artifact_hash: z.string(),
        artifact_type: z.enum(["card", "event", "execution"]),
        patch: z.record(z.unknown()),
      })
      .strict()
      .parse(args);
    // Validate with MetaPatchSchema — identity fields are structurally absent,
    // so any attempt to spoof schema_version / artifact_hash / artifact_type
    // is rejected as an unrecognized key.
    const validPatch = MetaPatchSchema.parse(parsed.patch);
    const result = await mergeMeta(
      parsed.artifact_hash,
      parsed.artifact_type,
      validPatch,
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "kb.create_weekly_summary") {
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
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  }

  if (name === "kb.rebuild_index") {
    const snapshot = await rebuildIndex();
    const summary = {
      counts: snapshot.counts,
      snapshot_path: SNAPSHOT_PATH,
      built_at: snapshot.built_at,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  }

  if (name === "kb.index_status") {
    const snapshot = await loadIndexSnapshot();
    if (!snapshot) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "none" }) }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }] };
  }

  if (name === "kb.render_card_png") {
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
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "kb.render_weekly_summary_png") {
    const parsed = z
      .object({ hash: z.string() })
      .strict()
      .parse(args);
    const result = await renderSummaryPngToDerived(parsed.hash);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "kb.storage_report") {
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
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  }

  if (name === "kb.storage_plan") {
    const out = await storagePlanHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.storage_apply") {
    const out = await storageApplyHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.storage_restore") {
    const out = await storageRestoreHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.execute") {
    const out = await vmExecuteHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.list_opcodes") {
    const out = await vmListOpcodesHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.validate_program") {
    const out = await vmValidateProgramHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.compare") {
    const out = await vmCompareHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.phase_scan") {
    const out = await vmPhaseScanHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.list_runs") {
    const out = await vmListRunsHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.search_runs") {
    const out = await vmSearchRunsHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.search_scans") {
    const out = await vmSearchScansHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.get_scan") {
    const out = await vmGetScanHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.top_scans") {
    const out = await vmTopScansHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.top_transitions") {
    const out = await vmTopTransitionsHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vm.top_novel_scans") {
    const out = await vmTopNovelScansHook(args ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vault.put") {
    try {
      const parsed = VaultPutInputSchema.parse(args);
      const out = await vaultPut(parsed);
      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Determinism violation")) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "INVALID_ARTIFACT", message: msg }) }] };
      }
      throw e;
    }
  }

  if (name === "vault.get") {
    const parsed = VaultGetInputSchema.parse(args);
    const out = await vaultGet(parsed.id);
    if (!out) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "NOT_FOUND" }) }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "vault.search") {
    const parsed = VaultSearchInputSchema.parse(args);
    const out = await vaultSearch(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "execution.get_pipeline") {
    const out = await executionGetPipelineHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "execution.walk_parents") {
    const out = await executionWalkParentsHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "execution.get_children") {
    const out = await executionGetChildrenHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "execution.get_siblings") {
    const out = await executionGetSiblingsHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "execution.check_integrity") {
    const out = await executionCheckIntegrityHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "execution.get_pipeline_view") {
    const out = await executionGetPipelineViewHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "execution.list_pipelines") {
    const out = await executionListPipelinesHook(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "kb://cards",
        name: "Cards index (file-backed)",
        description: "Cards are stored on disk under data/cards/*.json and *.png",
        mimeType: "application/json"
      }
    ]
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
