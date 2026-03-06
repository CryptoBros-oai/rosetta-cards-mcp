import { z } from "zod";

// --- Card ---

export type CardPayload = {
  version: "card.v1";
  card_id: string;
  title: string;
  bullets: string[]; // 3–7 recommended
  diagram_mermaid?: string;
  tags: string[];
  sources: { url?: string; doc_id: string; chunk_id?: number }[];
  hash: string;       // sha256 over canonical JSON (without hash)
  created_at: string; // ISO timestamp
};

export const CardPayloadSchema = z.object({
  version: z.literal("card.v1"),
  card_id: z.string(),
  title: z.string(),
  bullets: z.array(z.string()),
  diagram_mermaid: z.string().optional(),
  tags: z.array(z.string()),
  sources: z.array(
    z.object({
      url: z.string().optional(),
      doc_id: z.string(),
      chunk_id: z.number().optional(),
    })
  ),
  hash: z.string(),
  created_at: z.string(),
});

// --- Behavior Pack ---

export type PackPolicies = {
  search_boost: number;   // 0.0–1.0
  max_results?: number;
  allowed_tags?: string[];
  blocked_tags?: string[];
  default_export_scope?: "pack_only" | "all";
  style?: "default" | "dark" | "light";
};

export const PackPoliciesSchema = z.object({
  search_boost: z.number().min(0).max(1),
  max_results: z.number().int().positive().optional(),
  allowed_tags: z.array(z.string()).optional(),
  blocked_tags: z.array(z.string()).optional(),
  default_export_scope: z.enum(["pack_only", "all"]).optional(),
  style: z.enum(["default", "dark", "light"]).optional(),
});

export type BehaviorPack = {
  type: "behavior_pack";
  pack_id: string;
  name: string;
  version: string;
  description?: string;
  pins: string[];           // card hashes (content-addressed)
  policies: PackPolicies;
  created_at: string;
  hash: string;
};

export const BehaviorPackSchema = z.object({
  type: z.literal("behavior_pack"),
  pack_id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  pins: z.array(z.string()),
  policies: PackPoliciesSchema,
  created_at: z.string(),
  hash: z.string(),
});

// --- File Artifact ---

export type FileArtifactSource = {
  relative_path: string;
  original_name: string;
};

export type BlobRef = {
  hash: string;
  bytes: number;
  mime: string;
};

export type TextRef = {
  hash: string;
  chars: number;
  extractor: { name: string; version: string };
};

export type FileArtifact = {
  type: "file_artifact";
  spec_version: "1.0";
  title: string;
  tags: string[];
  source: FileArtifactSource;
  blob: BlobRef;
  text?: TextRef;
  hash: string;
};

export const FileArtifactSchema = z.object({
  type: z.literal("file_artifact"),
  spec_version: z.literal("1.0"),
  title: z.string(),
  tags: z.array(z.string()),
  source: z.object({
    relative_path: z.string(),
    original_name: z.string(),
  }),
  blob: z.object({
    hash: z.string(),
    bytes: z.number(),
    mime: z.string(),
  }),
  text: z
    .object({
      hash: z.string(),
      chars: z.number(),
      extractor: z.object({ name: z.string(), version: z.string() }),
    })
    .optional(),
  hash: z.string(),
});

// --- Folder Index ---

export type FolderFileEntry = {
  relative_path: string;
  blob_hash: string;
  text_hash?: string;
  card_hash: string;
  bytes: number;
  mime: string;
};

export type FolderCounts = {
  files_total: number;
  docx: number;
  pdf: number;
  other: number;
  extracted_text_count: number;
};

export type FolderIndex = {
  type: "folder_index";
  spec_version: "1.0";
  title: string;
  source: { root_path: string };
  files: FolderFileEntry[];
  counts: FolderCounts;
  hash: string;
};

export const FolderIndexSchema = z.object({
  type: z.literal("folder_index"),
  spec_version: z.literal("1.0"),
  title: z.string(),
  source: z.object({ root_path: z.string() }),
  files: z.array(
    z.object({
      relative_path: z.string(),
      blob_hash: z.string(),
      text_hash: z.string().optional(),
      card_hash: z.string(),
      bytes: z.number(),
      mime: z.string(),
    })
  ),
  counts: z.object({
    files_total: z.number(),
    docx: z.number(),
    pdf: z.number(),
    other: z.number(),
    extracted_text_count: z.number(),
  }),
  hash: z.string(),
});

// --- Chat Chunk ---

export type ChunkTextRef = {
  hash: string;
  chars: number;
};

export type ChatChunk = {
  type: "chat_chunk";
  spec_version: "1.0";
  title: string;
  tags: string[];
  index: number;       // 1-based
  total: number;
  text: ChunkTextRef;
  prev_hash?: string;
  next_hash?: string;
  hash: string;
};

export const ChatChunkSchema = z.object({
  type: z.literal("chat_chunk"),
  spec_version: z.literal("1.0"),
  title: z.string(),
  tags: z.array(z.string()),
  index: z.number().int().min(1),
  total: z.number().int().min(1),
  text: z.object({
    hash: z.string(),
    chars: z.number(),
  }),
  prev_hash: z.string().optional(),
  next_hash: z.string().optional(),
  hash: z.string(),
});

// --- Chat Log Index ---

export type ChunkingParams = {
  target_max_chars: number;
  threshold: number;
  chunk_chars: number;
};

export type ChatLogIndex = {
  type: "chat_log_index";
  spec_version: "1.0";
  title: string;
  tags: string[];
  chat_text_hash: string;
  chunking: ChunkingParams;
  chunks: string[];  // card_hash references in order
  hash: string;
};

export const ChatLogIndexSchema = z.object({
  type: z.literal("chat_log_index"),
  spec_version: z.literal("1.0"),
  title: z.string(),
  tags: z.array(z.string()),
  chat_text_hash: z.string(),
  chunking: z.object({
    target_max_chars: z.number(),
    threshold: z.number(),
    chunk_chars: z.number(),
  }),
  chunks: z.array(z.string()),
  hash: z.string(),
});

// --- Ingest Report ---

export type IngestReportFileEntry = {
  relative_path: string;
  card_hash: string;
  blob_hash: string;
  text_hash?: string;
  bytes: number;
  mime: string;
  error?: string;
};

export type IngestReport = {
  type: "ingest_report";
  spec_version: "1.0";
  title: string;
  tags: string[];
  source: { root_path: string };
  folder_card_hash: string;
  files: IngestReportFileEntry[];
  counts: FolderCounts;
  hash: string;
};

export const IngestReportSchema = z.object({
  type: z.literal("ingest_report"),
  spec_version: z.literal("1.0"),
  title: z.string(),
  tags: z.array(z.string()),
  source: z.object({ root_path: z.string() }),
  folder_card_hash: z.string(),
  files: z.array(
    z.object({
      relative_path: z.string(),
      card_hash: z.string(),
      blob_hash: z.string(),
      text_hash: z.string().optional(),
      bytes: z.number(),
      mime: z.string(),
      error: z.string().optional(),
    })
  ),
  counts: z.object({
    files_total: z.number(),
    docx: z.number(),
    pdf: z.number(),
    other: z.number(),
    extracted_text_count: z.number(),
  }),
  hash: z.string(),
});

// --- Event Card ---

export type EventParticipant = {
  role: string;
  name: string;
};

export type EventRef = {
  ref_type: "artifact_id" | "url" | "external_id";
  value: string;
};

export type EventKind =
  | "deployment" | "incident" | "decision" | "meeting"
  | "build" | "research" | "ops" | "personal" | "other";

export type EventStatus = "observed" | "confirmed" | "resolved" | "superseded";
export type EventSeverity = "info" | "low" | "medium" | "high" | "critical";
export type RosettaVerb = "Attract" | "Contain" | "Release" | "Repel" | "Transform";
export type RosettaPolarity = "+" | "0" | "-";

export type EventDetail = {
  kind: EventKind;
  status: EventStatus;
  severity: EventSeverity;
  confidence: number;
  participants: EventParticipant[];
  refs: EventRef[];
};

export type RosettaMeta = {
  verb: RosettaVerb;
  polarity: RosettaPolarity;
  weights: { A: number; C: number; L: number; P: number; T: number };
};

export type EventCard = {
  schema_version: "event.v1";
  artifact_type: "event";
  title: string;
  summary: string;
  event: EventDetail;
  tags: string[];
  rosetta: RosettaMeta;
  hash: string;
};

export const EventCardSchema = z.object({
  schema_version: z.literal("event.v1"),
  artifact_type: z.literal("event"),
  title: z.string(),
  summary: z.string(),
  event: z.object({
    kind: z.enum([
      "deployment", "incident", "decision", "meeting",
      "build", "research", "ops", "personal", "other",
    ]),
    status: z.enum(["observed", "confirmed", "resolved", "superseded"]),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    confidence: z.number().min(0).max(1),
    participants: z.array(z.object({ role: z.string(), name: z.string() }).strict()),
    refs: z.array(z.object({
      ref_type: z.enum(["artifact_id", "url", "external_id"]),
      value: z.string(),
    })),
  }).strict(),
  tags: z.array(z.string()),
  rosetta: z.object({
    verb: z.enum(["Attract", "Contain", "Release", "Repel", "Transform"]),
    polarity: z.enum(["+", "0", "-"]),
    weights: z.object({
      A: z.number(), C: z.number(), L: z.number(),
      P: z.number(), T: z.number(),
    }).strict(),
  }).strict(),
  hash: z.string(),
}).strict();

// Reusable sub-schemas for input validation at hook/tool boundaries
export const EventDetailSchema = z
  .object({
    kind: z.enum([
      "deployment",
      "incident",
      "decision",
      "meeting",
      "build",
      "research",
      "ops",
      "personal",
      "other",
    ]),
    status: z.enum(["observed", "confirmed", "resolved", "superseded"]),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    confidence: z.number().min(0).max(1),
    participants: z.array(z.object({ role: z.string(), name: z.string() }).strict()),
    refs: z.array(z.object({ ref_type: z.enum(["artifact_id", "url", "external_id"]), value: z.string() }).strict()),
  })
  .strict();

export const RosettaMetaSchema = z
  .object({
    verb: z.enum(["Attract", "Contain", "Release", "Repel", "Transform"]),
    polarity: z.enum(["+", "0", "-"]),
    weights: z.object({ A: z.number(), C: z.number(), L: z.number(), P: z.number(), T: z.number() }).strict(),
  })
  .strict();

// Input schema used at the hook/tool boundary to reject unknown root keys early.
export const EventCreateInputSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    event: EventDetailSchema,
    tags: z.array(z.string()).optional(),
    rosetta: RosettaMetaSchema,
    override_blocked: z.boolean().optional(),
  })
  .strict();

// --- Execution Card ---

export type ExecutionKind =
  | "job" | "tool_call" | "model_call" | "pipeline"
  | "validation" | "import" | "export" | "other";

export type ExecutionStatus =
  | "requested" | "running" | "succeeded" | "failed"
  | "partial" | "validated" | "rejected";

export type ActorType = "human" | "agent" | "system" | "node";
export type TargetType = "artifact" | "tool" | "model" | "node" | "external";
export type ExecutionRefType = "artifact_id" | "url" | "external_id" | "inline";
export type ValidationState = "unvalidated" | "self_reported" | "verified" | "disputed";
export type ValidationMethod = "none" | "hash_check" | "human_review" | "replay" | "consensus";

export type ExecutionActor = {
  type: ActorType;
  name: string;
};

export type ExecutionTarget = {
  type: TargetType;
  name: string;
};

export type ExecutionRef = {
  ref_type: ExecutionRefType;
  value: string;
};

export type ExecutionValidation = {
  state: ValidationState;
  method: ValidationMethod;
};

export type ExecutionChain = {
  parent_execution_id?: string;
  pipeline_id?: string;
  step_index?: number;
  related_execution_ids?: string[];
};

export type ExecutionDetail = {
  kind: ExecutionKind;
  status: ExecutionStatus;
  actor: ExecutionActor;
  target: ExecutionTarget;
  inputs: ExecutionRef[];
  outputs: ExecutionRef[];
  validation: ExecutionValidation;
  chain?: ExecutionChain;
};

export type ExecutionCard = {
  schema_version: "execution.v1";
  artifact_type: "execution";
  title: string;
  summary: string;
  execution: ExecutionDetail;
  tags: string[];
  rosetta: RosettaMeta;
  hash: string;
};

const ExecutionActorSchema = z.object({
  type: z.enum(["human", "agent", "system", "node"]),
  name: z.string(),
}).strict();

const ExecutionTargetSchema = z.object({
  type: z.enum(["artifact", "tool", "model", "node", "external"]),
  name: z.string(),
}).strict();

const ExecutionRefSchema = z.object({
  ref_type: z.enum(["artifact_id", "url", "external_id", "inline"]),
  value: z.string(),
}).strict();

const ExecutionValidationSchema = z.object({
  state: z.enum(["unvalidated", "self_reported", "verified", "disputed"]),
  method: z.enum(["none", "hash_check", "human_review", "replay", "consensus"]),
}).strict();

const ExecutionChainSchema = z.object({
  parent_execution_id: z.string().optional(),
  pipeline_id: z.string().optional(),
  step_index: z.number().int().nonnegative().optional(),
  related_execution_ids: z.array(z.string()).optional(),
}).strict();

export const ExecutionDetailSchema = z.object({
  kind: z.enum([
    "job", "tool_call", "model_call", "pipeline",
    "validation", "import", "export", "other",
  ]),
  status: z.enum([
    "requested", "running", "succeeded", "failed",
    "partial", "validated", "rejected",
  ]),
  actor: ExecutionActorSchema,
  target: ExecutionTargetSchema,
  inputs: z.array(ExecutionRefSchema),
  outputs: z.array(ExecutionRefSchema),
  validation: ExecutionValidationSchema,
  chain: ExecutionChainSchema.optional(),
}).strict();

export const ExecutionCardSchema = z.object({
  schema_version: z.literal("execution.v1"),
  artifact_type: z.literal("execution"),
  title: z.string(),
  summary: z.string(),
  execution: ExecutionDetailSchema,
  tags: z.array(z.string()),
  rosetta: RosettaMetaSchema,
  hash: z.string(),
}).strict();

// Input schema used at the hook/tool boundary to reject unknown root keys early.
export const ExecutionCreateInputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  execution: ExecutionDetailSchema,
  tags: z.array(z.string()).optional(),
  rosetta: RosettaMetaSchema,
  override_blocked: z.boolean().optional(),
}).strict();

// --- Execution card hash payload builder (single source of truth) ---

export type ExecutionHashPayload = Omit<ExecutionCard, "hash">;

/**
 * Build the exact object that gets canonicalized and hashed for an execution card.
 * This is the **single source of truth** for execution card identity.
 *
 * All code paths (hook, MCP, tests) must hash only this builder's output.
 */
export function buildExecutionHashPayload(parsed: {
  title: string;
  summary: string;
  execution: ExecutionDetail;
  tags: string[];
  rosetta: RosettaMeta;
}): ExecutionHashPayload {
  return {
    schema_version: "execution.v1",
    artifact_type: "execution",
    title: parsed.title,
    summary: parsed.summary,
    execution: parsed.execution,
    tags: parsed.tags,
    rosetta: parsed.rosetta,
  };
}

// --- Event card hash payload builder (single source of truth) ---

export type EventHashPayload = Omit<EventCard, "hash">;

/**
 * Build the exact object that gets canonicalized and hashed for an event card.
 * This is the **single source of truth** for event card identity.
 *
 * All code paths (hook, MCP, tests) must hash only this builder's output.
 */
export function buildEventHashPayload(parsed: {
  title: string;
  summary: string;
  event: EventDetail;
  tags: string[];
  rosetta: RosettaMeta;
}): EventHashPayload {
  return {
    schema_version: "event.v1",
    artifact_type: "event",
    title: parsed.title,
    summary: parsed.summary,
    event: parsed.event,
    tags: parsed.tags,
    rosetta: parsed.rosetta,
  };
}

// --- Hook input schemas (strict boundary validation) ---

/** Shared sub-schema for bundle export metadata. */
const BundleMetaInputSchema = z.object({
  description: z.string().optional(),
  license_spdx: z.string().optional(),
  created_by: z.object({ name: z.string().optional() }).strict().optional(),
}).strict();

export const IngestTextInputSchema = z.object({
  title: z.string(),
  text: z.string(),
  tags: z.array(z.string()).optional(),
  source_url: z.string().optional(),
  override_blocked: z.boolean().optional(),
}).strict();

export const BuildArtifactCardInputSchema = z.object({
  title: z.string().optional(),
  text: z.string(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  render_png: z.boolean().optional(),
}).strict();

export const RenderExistingCardInputSchema = z.object({
  card_id: z.string(),
  style: z.enum(["default", "dark", "light"]).optional(),
}).strict();

export const ExportBundleInputSchema = z.object({
  select: z.object({
    card_ids: z.array(z.string()).optional(),
    tags_any: z.array(z.string()).optional(),
    tags_all: z.array(z.string()).optional(),
  }).strict(),
  include_png: z.boolean().optional(),
  meta: BundleMetaInputSchema.optional(),
}).strict();

export const ImportBundleInputSchema = z.object({
  bundle_path: z.string(),
}).strict();

export const SearchArtifactsInputSchema = z.object({
  query: z.string(),
  top_k: z.number().int().positive().optional(),
  tags_any: z.array(z.string()).optional(),
  tags_all: z.array(z.string()).optional(),
}).strict();

export const PinSetCreateInputSchema = z.object({
  name: z.string(),
  card_ids: z.array(z.string()),
  description: z.string().optional(),
}).strict();

export const IngestFolderInputSchema = z.object({
  path: z.string(),
  tags: z.array(z.string()).optional(),
  includeDocxText: z.boolean().optional(),
  includePdfText: z.boolean().optional(),
  storeBlobs: z.boolean().optional(),
  override_blocked: z.boolean().optional(),
}).strict();

export const DrainContextInputSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()).optional(),
  chatText: z.string(),
  targetMaxChars: z.number().int().positive().optional(),
  chunkChars: z.number().int().positive().optional(),
  override_blocked: z.boolean().optional(),
}).strict();

export const ExportPackClosureInputSchema = z.object({
  pack_id: z.string().optional(),
  include_png: z.boolean().optional(),
  meta: BundleMetaInputSchema.optional(),
}).strict();

export const ExportActivePackInputSchema = z.object({
  include_png: z.boolean().optional(),
  meta: BundleMetaInputSchema.optional(),
}).strict();

// Storage hook input schemas
export const StoragePlanInputSchema = z.object({}).strict();

export const StorageApplyInputSchema = z.object({
  dry_run: z.boolean().optional(),
}).strict();

export const StorageRestoreInputSchema = z.object({
  tier: z.enum(["derived", "docs", "blobs", "text", "bundles", "embeddings"]),
  hashes: z.array(z.string()).optional(),
  all: z.boolean().optional(),
}).strict();

// Storage operation output types

export type PlanAction = {
  action: "prune" | "archive" | "vacuum" | "skip";
  tier: string;
  path: string;
  reason: string;
  bytes: number;
  reversible: boolean;
  last_modified_at?: string;
};

export type StoragePlan = {
  schema_version: "storage_plan.v1";
  generated_at: string;
  policy_source: "file" | "default";
  actions: PlanAction[];
  summary: {
    prune_count: number;
    archive_count: number;
    estimated_freed_bytes: number;
    estimated_cold_bytes: number;
  };
};

export type ApplyRecord = {
  action: "pruned" | "archived" | "vacuumed" | "skipped" | "failed";
  tier: string;
  path: string;
  bytes: number;
  reason: string;
};

export type StorageApplyResult = {
  schema_version: "storage_apply.v1";
  applied_at: string;
  actions_executed: ApplyRecord[];
  freed_bytes: number;
  cold_bytes: number;
  errors: string[];
};

export type StorageRestoreResult = {
  restored: Array<{ path: string; tier: string; bytes: number }>;
  re_rendered: Array<{ hash: string; png_path: string }>;
  errors: string[];
};

// --- Meta (Sidecar Artifact) ---

export type MetaV1 = {
    schema_version: "meta.v1";
    artifact_hash: string;
    artifact_type: "card" | "event" | "execution";
    occurred_at?: string; // ISO 8601
    sources?: Array<{ kind: "url" | "note" | "file" | "system"; value: string }>;
    ingest?: { pipeline?: string; extractor?: string; chunker?: string; stats?: Record<string, number> };
    embeddings?: Array<{ model: string; dims: number; embedding_id?: string; status: "present" | "missing" | "stale"; updated_at?: string }>;
    annotations?: { notes?: string; meta_tags?: string[] };
    /** Pointer to the last derived PNG render of this artifact. Never affects identity. */
    render?: { path: string; template: string; rendered_at: string };
};

const SourceSchema = z.object({
    kind: z.enum(["url", "note", "file", "system"]),
    value: z.string(),
}).strict();

const IngestSchema = z.object({
    pipeline: z.string().optional(),
    extractor: z.string().optional(),
    chunker: z.string().optional(),
    stats: z.record(z.number()).optional(),
}).strict();

const EmbeddingSchema = z.object({
    model: z.string(),
    dims: z.number(),
    embedding_id: z.string().optional(),
    status: z.enum(["present", "missing", "stale"]),
    updated_at: z.string().optional(),
}).strict();

const AnnotationsSchema = z.object({
    notes: z.string().optional(),
    meta_tags: z.array(z.string()).optional(),
}).strict();

const RenderInfoSchema = z.object({
    path: z.string(),        // relative path from vault root
    template: z.string(),    // template identifier used to produce the PNG
    rendered_at: z.string(), // ISO 8601 — never hashed, lives in sidecar only
}).strict();

export const MetaV1Schema = z.object({
    schema_version: z.literal("meta.v1"),
    artifact_hash: z.string(),
    artifact_type: z.enum(["card", "event", "execution"]),
    occurred_at: z.string().optional(),
    sources: z.array(SourceSchema).optional(),
    ingest: IngestSchema.optional(),
    embeddings: z.array(EmbeddingSchema).optional(),
    annotations: AnnotationsSchema.optional(),
    render: RenderInfoSchema.optional(),
}).strict();

/**
 * MetaPatchSchema — the only safe input surface for kb.merge_meta.
 *
 * Intentionally excludes identity fields (schema_version, artifact_hash,
 * artifact_type) so callers cannot spoof them via the patch payload.
 * All nested schemas inherit .strict() so unknown keys at any level
 * are rejected immediately.
 */
export const MetaPatchSchema = z.object({
    occurred_at: z.string().optional(),
    sources: z.array(SourceSchema).optional(),
    ingest: IngestSchema.optional(),
    embeddings: z.array(EmbeddingSchema).optional(),
    annotations: AnnotationsSchema.optional(),
    render: RenderInfoSchema.optional(),
}).strict();

export type MetaPatch = z.infer<typeof MetaPatchSchema>;

// --- Index Snapshot ---

const ByHashEntrySchema = z.object({
  artifact_type: z.enum(["card", "event", "execution"]),
  path: z.string(),
  meta_path: z.string().optional(),
}).strict();

export const IndexSnapshotV1Schema = z.object({
  schema_version: z.literal("index_snapshot.v1"),
  built_at: z.string(), // ISO 8601; derived field, not part of identity
  counts: z.object({
    cards: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    executions: z.number().int().nonnegative().optional(),
    metas: z.number().int().nonnegative(),
  }).strict(),
  by_hash: z.record(ByHashEntrySchema),
  tags: z.record(z.array(z.string())),
  rosetta: z.object({
    verb: z.record(z.array(z.string())),
    polarity: z.record(z.array(z.string())),
  }).strict(),
  time: z.object({
    occurred_at: z.array(
      z.object({
        hash: z.string(),
        occurred_at: z.string(),
      }).strict(),
    ),
  }).strict(),
}).strict();

export type IndexSnapshotV1 = z.infer<typeof IndexSnapshotV1Schema>;

// --- Weekly Summary ---

/**
 * WeeklySummarySchema — derived synthesis artifact.
 *
 * Identity rule: hash = canonicalHash(all fields except hash).
 * week_start must be normalized to the Monday of that ISO week (YYYY-MM-DD).
 * week_end is the following Sunday (week_start + 6 days).
 * references.events and references.cards must be sorted before hashing
 * (callers may supply them in any order; the create function sorts them).
 */
export const WeeklySummarySchema = z.object({
  schema_version: z.literal("summary.week.v1"),
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "week_start must be YYYY-MM-DD"),
  week_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "week_end must be YYYY-MM-DD"),
  references: z.object({
    events: z.array(z.string()),
    cards: z.array(z.string()),
  }).strict(),
  highlights: z.array(z.string()),
  decisions: z.array(z.string()),
  open_loops: z.array(z.string()),
  risks: z.array(z.string()),
  rosetta_balance: z.object({
    A: z.number(), C: z.number(), L: z.number(), P: z.number(), T: z.number(),
  }).strict().optional(),
  hash: z.string(),
}).strict();

export type WeeklySummary = z.infer<typeof WeeklySummarySchema>;

// --- Vault Context ---

export const DEFAULT_POLICIES: PackPolicies = {
  search_boost: 0,
};

export type VaultContext = {
  activePack: BehaviorPack | null;
  pinHashes: string[];
  policies: PackPolicies;
};
