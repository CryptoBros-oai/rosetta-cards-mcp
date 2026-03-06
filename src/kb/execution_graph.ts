/**
 * Execution Graph Query Helpers — deterministic pipeline traversal,
 * parent/child chain walking, ordered step reconstruction, and
 * chain integrity checks.
 *
 * All functions are pure over an ExecutionCard[] snapshot. No I/O.
 * The caller is responsible for loading cards from disk.
 */

import type { ExecutionCard } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChainIssueKind =
  | "missing_parent"
  | "cycle"
  | "duplicate_step_index"
  | "pipeline_contamination"
  | "orphan_step_index";

export type ChainIssue = {
  kind: ChainIssueKind;
  hash: string;
  detail: string;
};

export type PipelineView = {
  pipeline_id: string;
  steps: ExecutionCard[];
  issues: ChainIssue[];
};

// ---------------------------------------------------------------------------
// Index builder (pure, deterministic)
// ---------------------------------------------------------------------------

/** Build lookup maps from a flat list of execution cards. */
function buildIndex(cards: ExecutionCard[]) {
  const byHash = new Map<string, ExecutionCard>();
  const byPipeline = new Map<string, ExecutionCard[]>();
  const childrenOf = new Map<string, string[]>(); // parent_hash -> child_hashes

  for (const card of cards) {
    byHash.set(card.hash, card);

    const chain = card.execution.chain;
    if (!chain) continue;

    if (chain.pipeline_id) {
      const list = byPipeline.get(chain.pipeline_id) ?? [];
      list.push(card);
      byPipeline.set(chain.pipeline_id, list);
    }

    if (chain.parent_execution_id) {
      const children = childrenOf.get(chain.parent_execution_id) ?? [];
      children.push(card.hash);
      childrenOf.set(chain.parent_execution_id, children);
    }
  }

  return { byHash, byPipeline, childrenOf };
}

// ---------------------------------------------------------------------------
// Query: get pipeline by pipeline_id
// ---------------------------------------------------------------------------

/**
 * Return all execution cards sharing a pipeline_id, ordered by step_index.
 * Cards without step_index sort after those with one, then by hash for
 * deterministic tiebreak.
 */
export function getPipeline(
  cards: ExecutionCard[],
  pipelineId: string,
): ExecutionCard[] {
  const matching = cards.filter(
    (c) => c.execution.chain?.pipeline_id === pipelineId,
  );

  return matching.sort((a, b) => {
    const ai = a.execution.chain?.step_index;
    const bi = b.execution.chain?.step_index;
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.hash.localeCompare(b.hash);
  });
}

// ---------------------------------------------------------------------------
// Query: walk parent chain to root
// ---------------------------------------------------------------------------

/**
 * Walk the parent_execution_id chain from a given hash back to the root.
 * Returns the chain in root-first order: [root, ..., parent, self].
 *
 * If a parent is missing from the provided cards, the walk stops at the
 * last known ancestor. The returned array will be shorter than the full
 * chain but always includes the starting card (if found).
 *
 * Detects cycles: if a hash is visited twice, the walk stops to prevent
 * infinite loops. The partial chain up to the cycle is returned.
 */
export function walkParentChain(
  cards: ExecutionCard[],
  hash: string,
): ExecutionCard[] {
  const { byHash } = buildIndex(cards);
  const chain: ExecutionCard[] = [];
  const visited = new Set<string>();
  let current = hash;

  while (current) {
    if (visited.has(current)) break; // cycle
    visited.add(current);

    const card = byHash.get(current);
    if (!card) break; // missing parent
    chain.push(card);

    current = card.execution.chain?.parent_execution_id ?? "";
  }

  chain.reverse(); // root-first
  return chain;
}

// ---------------------------------------------------------------------------
// Query: get children of execution X
// ---------------------------------------------------------------------------

/**
 * Return all execution cards whose parent_execution_id equals the given hash.
 * Sorted by step_index (if present), then by hash for determinism.
 */
export function getChildren(
  cards: ExecutionCard[],
  parentHash: string,
): ExecutionCard[] {
  const children = cards.filter(
    (c) => c.execution.chain?.parent_execution_id === parentHash,
  );

  return children.sort((a, b) => {
    const ai = a.execution.chain?.step_index;
    const bi = b.execution.chain?.step_index;
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.hash.localeCompare(b.hash);
  });
}

// ---------------------------------------------------------------------------
// Query: get siblings in same pipeline ordered by step_index
// ---------------------------------------------------------------------------

/**
 * Return all execution cards in the same pipeline as the given hash,
 * ordered by step_index. The target card is included in the result.
 *
 * Returns empty array if the card has no pipeline_id.
 */
export function getSiblings(
  cards: ExecutionCard[],
  hash: string,
): ExecutionCard[] {
  const { byHash } = buildIndex(cards);
  const card = byHash.get(hash);
  if (!card) return [];

  const pipelineId = card.execution.chain?.pipeline_id;
  if (!pipelineId) return [];

  return getPipeline(cards, pipelineId);
}

// ---------------------------------------------------------------------------
// Chain integrity checks
// ---------------------------------------------------------------------------

/**
 * Detect broken chains, cycles, duplicate step_index, and pipeline
 * contamination across a set of execution cards.
 *
 * Returns an array of issues, empty if the graph is clean.
 * This is a deterministic, pure function.
 */
export function checkChainIntegrity(
  cards: ExecutionCard[],
): ChainIssue[] {
  const { byHash, byPipeline } = buildIndex(cards);
  const issues: ChainIssue[] = [];

  for (const card of cards) {
    const chain = card.execution.chain;
    if (!chain) continue;

    // --- Missing parent ---
    if (chain.parent_execution_id && !byHash.has(chain.parent_execution_id)) {
      issues.push({
        kind: "missing_parent",
        hash: card.hash,
        detail: `parent ${chain.parent_execution_id.slice(0, 12)} not found in card set`,
      });
    }

    // --- Orphan step_index (step_index without pipeline_id) ---
    if (chain.step_index !== undefined && !chain.pipeline_id) {
      issues.push({
        kind: "orphan_step_index",
        hash: card.hash,
        detail: `step_index=${chain.step_index} without pipeline_id`,
      });
    }
  }

  // --- Cycle detection (per parent chain) ---
  const checkedForCycles = new Set<string>();
  for (const card of cards) {
    if (checkedForCycles.has(card.hash)) continue;
    if (!card.execution.chain?.parent_execution_id) continue;

    const visited = new Set<string>();
    let current: string | undefined = card.hash;

    while (current) {
      if (visited.has(current)) {
        issues.push({
          kind: "cycle",
          hash: card.hash,
          detail: `cycle detected at ${current.slice(0, 12)}`,
        });
        break;
      }
      visited.add(current);
      checkedForCycles.add(current);

      const c = byHash.get(current);
      current = c?.execution.chain?.parent_execution_id;
    }
  }

  // --- Per-pipeline checks ---
  for (const [pipelineId, pipelineCards] of byPipeline) {
    // Duplicate step_index
    const stepMap = new Map<number, string[]>();
    for (const c of pipelineCards) {
      const idx = c.execution.chain?.step_index;
      if (idx === undefined) continue;
      const existing = stepMap.get(idx) ?? [];
      existing.push(c.hash);
      stepMap.set(idx, existing);
    }
    for (const [idx, hashes] of stepMap) {
      if (hashes.length > 1) {
        for (const h of hashes) {
          issues.push({
            kind: "duplicate_step_index",
            hash: h,
            detail: `step_index=${idx} duplicated in pipeline "${pipelineId}" (${hashes.length} cards)`,
          });
        }
      }
    }

    // Pipeline contamination: parent points to card in a different pipeline
    for (const c of pipelineCards) {
      const parentId = c.execution.chain?.parent_execution_id;
      if (!parentId) continue;
      const parent = byHash.get(parentId);
      if (!parent) continue; // already flagged as missing_parent
      const parentPipeline = parent.execution.chain?.pipeline_id;
      if (parentPipeline && parentPipeline !== pipelineId) {
        issues.push({
          kind: "pipeline_contamination",
          hash: c.hash,
          detail: `parent ${parentId.slice(0, 12)} belongs to pipeline "${parentPipeline}", not "${pipelineId}"`,
        });
      }
    }
  }

  // Sort issues deterministically: by kind, then by hash
  issues.sort((a, b) => {
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) return kindCmp;
    return a.hash.localeCompare(b.hash);
  });

  return issues;
}

// ---------------------------------------------------------------------------
// Composite: get full pipeline view
// ---------------------------------------------------------------------------

/**
 * Build a complete pipeline view: ordered steps + integrity issues.
 * Returns null if no cards match the pipeline_id.
 */
export function getPipelineView(
  cards: ExecutionCard[],
  pipelineId: string,
): PipelineView | null {
  const steps = getPipeline(cards, pipelineId);
  if (steps.length === 0) return null;

  const issues = checkChainIntegrity(steps);
  return { pipeline_id: pipelineId, steps, issues };
}

// ---------------------------------------------------------------------------
// Listing: all pipeline IDs
// ---------------------------------------------------------------------------

/**
 * Return all distinct pipeline_ids found in the card set, sorted.
 */
export function listPipelineIds(cards: ExecutionCard[]): string[] {
  const ids = new Set<string>();
  for (const card of cards) {
    const pid = card.execution.chain?.pipeline_id;
    if (pid) ids.add(pid);
  }
  return [...ids].sort();
}
