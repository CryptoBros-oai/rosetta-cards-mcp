/**
 * NFT tier policy — capability matrix and enforcement.
 *
 * Tiers:
 *   Bronze — basic vault + memory, limited kinds, 1,000 artifact cap
 *   Silver — all vault kinds, promotion, blessing, 10,000 artifact cap
 *   Gold   — full access, no cap (default for local dev)
 */

// ── Tier enum ───────────────────────────────────────────────────────────────

export const TIERS = ["bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class TierAccessError extends Error {
  public readonly tier: Tier;
  public readonly tool: string;

  constructor(tier: Tier, tool: string) {
    super(`Tier "${tier}" does not have access to tool "${tool}". Upgrade your tier to use this feature.`);
    this.name = "TierAccessError";
    this.tier = tier;
    this.tool = tool;
  }
}

export class TierCapError extends Error {
  public readonly tier: Tier;
  public readonly cap: number;
  public readonly current: number;

  constructor(tier: Tier, cap: number, current: number) {
    super(`Artifact cap reached for tier "${tier}": ${current}/${cap}. Upgrade your tier to store more artifacts.`);
    this.name = "TierCapError";
    this.tier = tier;
    this.cap = cap;
    this.current = current;
  }
}

// ── Artifact caps ───────────────────────────────────────────────────────────

export const ARTIFACT_CAPS: Record<Tier, number> = {
  bronze: 1_000,
  silver: 10_000,
  gold: Infinity,
};

// ── Bronze kind restrictions ────────────────────────────────────────────────

const BRONZE_ALLOWED_KINDS = new Set(["fact", "event", "tool_obs"]);

export function isBronzeAllowedKind(kind: string): boolean {
  return BRONZE_ALLOWED_KINDS.has(kind);
}

// ── Capability matrix ───────────────────────────────────────────────────────

/**
 * Tool access rules per tier.
 *
 * A tool is allowed if:
 *   1. It appears in the tier's explicit allow list, OR
 *   2. It matches a namespace prefix in the tier's allowed namespaces
 *
 * Gold has unrestricted access — every tool is allowed.
 */

const BRONZE_TOOLS = new Set([
  "vault.put",
  "vault.get",
  "vault.search",
  "vault.reindex_embeddings",
  "memory.session_start",
  "memory.session_end",
  "memory.ingest_turn",
  "memory.compact",
  "memory.get_context",
  "kb.add_document",
  "kb.build_card",
  "kb.search",
  "kb.get_card",
  "kb.get_meta",
  "kb.rebuild_index",
  "kb.index_status",
  "kb.bridge_to_vault",
]);

const SILVER_TOOLS = new Set([
  // All of Bronze
  ...BRONZE_TOOLS,
  // Plus promotion
  "promotion.promote_facts",
  "promotion.promote_skills",
  "promotion.promote_summary",
  "promotion.build_bundle",
  // Plus blessing
  "artifact.bless",
  "artifact.deprecate",
  "artifact.supersede",
  "artifact.collect_evidence",
  // Plus local corpus import
  "corpus.import_local",
  // Plus more KB tools
  "kb.create_event",
  "kb.create_execution",
  "kb.merge_meta",
  "kb.create_weekly_summary",
  "kb.render_card_png",
  "kb.render_weekly_summary_png",
  "kb.storage_report",
  "kb.storage_plan",
  "kb.storage_apply",
  "kb.storage_restore",
  // Plus execution tools
  "execution.get_pipeline",
  "execution.walk_parents",
  "execution.get_children",
  "execution.get_siblings",
  "execution.check_integrity",
  "execution.get_pipeline_view",
  "execution.list_pipelines",
  "execution.build_evidence_bundle",
]);

// Gold: no restrictions — all tools allowed

function tierAllowsToolExact(tier: Tier, toolName: string): boolean {
  if (tier === "gold") return true;
  if (tier === "silver") return SILVER_TOOLS.has(toolName);
  return BRONZE_TOOLS.has(toolName);
}

// ── Public assertions ───────────────────────────────────────────────────────

/**
 * Assert that the given tier has access to the named tool.
 * Throws TierAccessError if denied.
 */
export function assertTierAccess(tier: Tier, toolName: string): void {
  if (!tierAllowsToolExact(tier, toolName)) {
    throw new TierAccessError(tier, toolName);
  }
}

/**
 * Assert that the artifact count has not exceeded the tier cap.
 * Throws TierCapError if at or over the limit.
 */
export function assertArtifactCap(tier: Tier, currentCount: number): void {
  const cap = ARTIFACT_CAPS[tier];
  if (currentCount >= cap) {
    throw new TierCapError(tier, cap, currentCount);
  }
}

/**
 * Check if vault.put is allowed for a specific artifact kind at the given tier.
 * Bronze is restricted to fact, event, tool_obs.
 * Silver and Gold can put any kind.
 */
export function assertPutKindAllowed(tier: Tier, kind: string): void {
  if (tier === "bronze" && !isBronzeAllowedKind(kind)) {
    throw new TierAccessError(tier, `vault.put(kind="${kind}")`);
  }
}
