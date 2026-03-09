/**
 * Execution evidence bundle helpers — deterministic structured evidence
 * derived from execution graph queries.
 *
 * All functions are pure over their inputs. No I/O. They leverage
 * execution_graph.ts functions rather than reimplementing traversal.
 */

import type { ExecutionCard } from "./schema.js";
import type { EvidenceRef, IntegritySummary } from "./schema.js";
import type { ChainIssue, PipelineView } from "./execution_graph.js";
import {
  getPipeline,
  getChildren,
  walkParentChain,
  checkChainIntegrity,
  getPipelineView,
  listPipelineIds,
} from "./execution_graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionEvidenceBundle = {
  pipeline_id: string;
  steps: Array<{
    hash: string;
    title: string;
    step_index?: number;
    status: string;
    kind: string;
  }>;
  parent_chains: Record<string, string[]>;
  children: Record<string, string[]>;
  integrity: IntegritySummary;
  evidence_refs: EvidenceRef[];
};

export type PipelineArtifactContext = {
  pipeline_id: string;
  input_refs: EvidenceRef[];
  output_refs: EvidenceRef[];
  execution_refs: EvidenceRef[];
  integrity: IntegritySummary;
};

// ---------------------------------------------------------------------------
// Evidence bundle builder
// ---------------------------------------------------------------------------

/**
 * Build a deterministic evidence bundle from a pipeline.
 * Returns structured evidence suitable for blessing promotion.
 */
export function buildExecutionEvidenceBundle(
  pipelineId: string,
  cards: ExecutionCard[],
): ExecutionEvidenceBundle {
  const steps = getPipeline(cards, pipelineId);
  const issues = checkChainIntegrity(steps);

  const parentChains: Record<string, string[]> = {};
  const childrenMap: Record<string, string[]> = {};

  for (const step of steps) {
    const chain = walkParentChain(cards, step.hash);
    if (chain.length > 1) {
      parentChains[step.hash] = chain.map((c) => c.hash);
    }
    const kids = getChildren(cards, step.hash);
    if (kids.length > 0) {
      childrenMap[step.hash] = kids.map((c) => c.hash);
    }
  }

  const evidenceRefs = collectPipelineRefs(pipelineId, cards);

  return {
    pipeline_id: pipelineId,
    steps: steps.map((c) => ({
      hash: c.hash,
      title: c.title,
      step_index: c.execution.chain?.step_index,
      status: c.execution.status,
      kind: c.execution.kind,
    })),
    parent_chains: parentChains,
    children: childrenMap,
    integrity: summarizeIntegrityIssues(steps, issues),
    evidence_refs: evidenceRefs,
  };
}

// ---------------------------------------------------------------------------
// Pipeline ref collection
// ---------------------------------------------------------------------------

/**
 * Collect sorted, deduplicated EvidenceRef entries from a pipeline's cards.
 * Includes: pipeline_id ref, execution_hash for each step, artifact_hash
 * for all inputs/outputs.
 */
export function collectPipelineRefs(
  pipelineId: string,
  cards: ExecutionCard[],
): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();

  function add(ref: EvidenceRef) {
    const key = `${ref.ref_type}:${ref.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  }

  add({ ref_type: "pipeline_id", value: pipelineId });

  const steps = getPipeline(cards, pipelineId);
  for (const step of steps) {
    add({ ref_type: "execution_hash", value: step.hash });

    for (const inp of step.execution.inputs) {
      if (inp.ref_type === "artifact_id") {
        add({ ref_type: "artifact_hash", value: inp.value });
      }
    }
    for (const out of step.execution.outputs) {
      if (out.ref_type === "artifact_id") {
        add({ ref_type: "artifact_hash", value: out.value });
      }
    }
  }

  return refs.sort((a, b) => {
    const typeCmp = a.ref_type.localeCompare(b.ref_type);
    if (typeCmp !== 0) return typeCmp;
    return a.value.localeCompare(b.value);
  });
}

// ---------------------------------------------------------------------------
// Integrity summarization
// ---------------------------------------------------------------------------

/**
 * Summarize chain integrity issues into a structured summary.
 */
export function summarizeIntegrityIssues(
  cards: ExecutionCard[],
  issues?: ChainIssue[],
): IntegritySummary {
  const resolvedIssues = issues ?? checkChainIntegrity(cards);
  return {
    total_cards: cards.length,
    issue_count: resolvedIssues.length,
    clean: resolvedIssues.length === 0,
    issues: resolvedIssues.map((i) => ({
      kind: i.kind,
      hash: i.hash,
      detail: i.detail,
    })),
  };
}

// ---------------------------------------------------------------------------
// Pipeline artifact context
// ---------------------------------------------------------------------------

/**
 * Build a structured context for a pipeline suitable for artifact promotion.
 * Separates inputs, outputs, and execution refs for clarity.
 */
export function buildPipelineArtifactContext(
  pipelineId: string,
  cards: ExecutionCard[],
): PipelineArtifactContext {
  const steps = getPipeline(cards, pipelineId);
  const issues = checkChainIntegrity(steps);

  const inputRefs: EvidenceRef[] = [];
  const outputRefs: EvidenceRef[] = [];
  const executionRefs: EvidenceRef[] = [];
  const seen = new Set<string>();

  function addUnique(list: EvidenceRef[], ref: EvidenceRef) {
    const key = `${ref.ref_type}:${ref.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(ref);
  }

  for (const step of steps) {
    addUnique(executionRefs, { ref_type: "execution_hash", value: step.hash });

    for (const inp of step.execution.inputs) {
      if (inp.ref_type === "artifact_id") {
        addUnique(inputRefs, { ref_type: "artifact_hash", value: inp.value });
      }
    }
    for (const out of step.execution.outputs) {
      if (out.ref_type === "artifact_id") {
        addUnique(outputRefs, { ref_type: "artifact_hash", value: out.value });
      }
    }
  }

  const sortFn = (a: EvidenceRef, b: EvidenceRef) => a.value.localeCompare(b.value);

  return {
    pipeline_id: pipelineId,
    input_refs: inputRefs.sort(sortFn),
    output_refs: outputRefs.sort(sortFn),
    execution_refs: executionRefs.sort(sortFn),
    integrity: summarizeIntegrityIssues(steps, issues),
  };
}
