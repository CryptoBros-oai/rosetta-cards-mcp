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
  style?: "default" | "dark" | "light";
};

export const PackPoliciesSchema = z.object({
  search_boost: z.number().min(0).max(1),
  max_results: z.number().int().positive().optional(),
  allowed_tags: z.array(z.string()).optional(),
  blocked_tags: z.array(z.string()).optional(),
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

// --- Vault Context ---

export const DEFAULT_POLICIES: PackPolicies = {
  search_boost: 0,
};

export type VaultContext = {
  activePack: BehaviorPack | null;
  pinHashes: string[];
  policies: PackPolicies;
};
