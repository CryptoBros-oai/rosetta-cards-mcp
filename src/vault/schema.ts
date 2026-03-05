/**
 * Zod schemas for the Artifact Vault envelope, hash payload, and MCP tool inputs.
 *
 * Identity rule:
 *   id = sha256(canonicalize({ version, kind, payload, tags, refs }))
 *
 * Fields excluded from hash: created_at, last_seen_at, source.
 */

import { z } from "zod";

// ── Constants ────────────────────────────────────────────────────────────────

export const ARTIFACT_VERSION = "artifact_v1" as const;

export const PERSONAL_TAG_PREFIX = "personal:";

// ── Kind enum ────────────────────────────────────────────────────────────────

export const ArtifactKindSchema = z.enum([
  "event",
  "fact",
  "decision",
  "skill",
  "profile",
  "tool_obs",
  "summary",
  "project",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// ── Ref ──────────────────────────────────────────────────────────────────────

export const ArtifactRefSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// ── Source (provenance, excluded from hash) ──────────────────────────────────

export const ArtifactSourceSchema = z
  .object({
    agent: z.string().optional(),
    tool: z.string().optional(),
    repo: z.string().optional(),
    run_id: z.string().optional(),
  })
  .strict();
export type ArtifactSource = z.infer<typeof ArtifactSourceSchema>;

// ── Full envelope (stored on disk) ───────────────────────────────────────────

export const ArtifactEnvelopeSchema = z
  .object({
    version: z.literal(ARTIFACT_VERSION),
    kind: ArtifactKindSchema,
    id: z.string(),
    created_at: z.string(),
    last_seen_at: z.string(),
    source: ArtifactSourceSchema.optional(),
    tags: z.array(z.string()),
    payload: z.record(z.unknown()),
    refs: z.array(ArtifactRefSchema),
  })
  .strict();
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;

// ── Hash payload (structural fields only) ────────────────────────────────────

export const ArtifactHashPayloadSchema = z
  .object({
    version: z.literal(ARTIFACT_VERSION),
    kind: ArtifactKindSchema,
    payload: z.record(z.unknown()),
    tags: z.array(z.string()),
    refs: z.array(ArtifactRefSchema),
  })
  .strict();
export type ArtifactHashPayload = z.infer<typeof ArtifactHashPayloadSchema>;

/**
 * Single source of truth for building the subset of fields that determine
 * artifact identity. Tags are sorted for canonical stability.
 */
export function buildArtifactHashPayload(input: {
  kind: ArtifactKind;
  payload: Record<string, unknown>;
  tags: string[];
  refs: ArtifactRef[];
}): ArtifactHashPayload {
  return {
    version: ARTIFACT_VERSION,
    kind: input.kind,
    payload: input.payload,
    tags: [...input.tags].sort(),
    refs: [...input.refs],
  };
}

// ── MCP tool input schemas ───────────────────────────────────────────────────

export const VaultPutInputSchema = z
  .object({
    kind: ArtifactKindSchema,
    payload: z.record(z.unknown()),
    tags: z.array(z.string()).default([]),
    refs: z.array(ArtifactRefSchema).default([]),
    source: ArtifactSourceSchema.optional(),
  })
  .strict();

export const VaultGetInputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export const VaultSearchInputSchema = z
  .object({
    query: z.string().optional(),
    kind: ArtifactKindSchema.optional(),
    tags: z.array(z.string()).optional(),
    exclude_personal: z.boolean().default(false),
    limit: z.number().int().positive().default(10),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
