/**
 * Blessing workflow — pure functions for artifact lifecycle transitions.
 *
 * All functions are pure over their inputs. No I/O. The caller (hooks layer)
 * is responsible for loading cards from disk and persisting results.
 *
 * Transitions:
 *   candidate -> blessed    (bless)
 *   candidate -> deprecated (deprecate)
 *   blessed   -> deprecated (deprecate)
 *   blessed   -> deprecated (supersede, with new_hash link)
 *   any       -> deprecated (deprecate with reason)
 *
 * A BlessingRecord is itself a content-addressed artifact. It references
 * the target artifact by hash and includes evidence refs, not in-place mutation.
 */

import type {
  BlessingRecord,
  BlessingHashPayload,
  BlessingTransition,
  ArtifactLifecycleStatus,
  EvidenceRef,
  IntegritySummary,
} from "./schema.js";
import { buildBlessingHashPayload } from "./schema.js";
import { canonicalHash } from "./canonical.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type BlessingValidationError = {
  code: string;
  message: string;
};

/**
 * Validate a blessing transition. Returns an array of errors (empty = valid).
 *
 * Rules:
 * - bless: requires at least one evidence ref
 * - bless: rejects if integrity_summary has issues unless override_integrity
 * - supersede: requires both old_hash and new_hash, and they must differ
 * - deprecate: requires a non-empty reason (enforced by schema, checked here too)
 */
export function validateBlessingInput(input: {
  transition: BlessingTransition;
  target_hash: string;
  evidence_refs: EvidenceRef[];
  reason: string;
  integrity_summary?: IntegritySummary;
  override_integrity?: boolean;
  superseded_by?: string;
  supersedes?: string;
}): BlessingValidationError[] {
  const errors: BlessingValidationError[] = [];

  if (!input.reason || input.reason.trim().length === 0) {
    errors.push({ code: "EMPTY_REASON", message: "Reason must not be empty" });
  }

  if (input.transition === "bless") {
    if (input.evidence_refs.length === 0) {
      errors.push({
        code: "NO_EVIDENCE",
        message: "Blessing requires at least one evidence ref",
      });
    }
    if (
      input.integrity_summary &&
      !input.integrity_summary.clean &&
      !input.override_integrity
    ) {
      errors.push({
        code: "INTEGRITY_ISSUES",
        message: `Pipeline has ${input.integrity_summary.issue_count} integrity issue(s); set override_integrity=true to proceed`,
      });
    }
  }

  if (input.transition === "supersede") {
    if (!input.superseded_by) {
      errors.push({
        code: "MISSING_SUPERSEDED_BY",
        message: "Supersede transition requires superseded_by (new artifact hash)",
      });
    }
    if (input.superseded_by && input.superseded_by === input.target_hash) {
      errors.push({
        code: "SELF_SUPERSEDE",
        message: "An artifact cannot supersede itself",
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Pure blessing builders
// ---------------------------------------------------------------------------

/**
 * Build a BlessingRecord for blessing a candidate artifact.
 * Throws if validation fails.
 */
export function blessArtifact(input: {
  target_hash: string;
  evidence_refs: EvidenceRef[];
  reason: string;
  integrity_summary?: IntegritySummary;
  override_integrity?: boolean;
  tags?: string[];
}): BlessingRecord {
  const errors = validateBlessingInput({
    transition: "bless",
    target_hash: input.target_hash,
    evidence_refs: input.evidence_refs,
    reason: input.reason,
    integrity_summary: input.integrity_summary,
    override_integrity: input.override_integrity,
  });
  if (errors.length > 0) {
    throw new Error(`Blessing validation failed: ${errors.map((e) => e.message).join("; ")}`);
  }

  const payload = buildBlessingHashPayload({
    transition: "bless",
    target_hash: input.target_hash,
    new_status: "blessed",
    evidence_refs: sortRefs(input.evidence_refs),
    reason: input.reason,
    integrity_summary: input.integrity_summary,
    override_integrity: input.override_integrity ?? false,
    tags: [...(input.tags ?? [])].sort(),
  });

  return finalize(payload);
}

/**
 * Build a BlessingRecord for deprecating an artifact.
 */
export function deprecateArtifact(input: {
  target_hash: string;
  reason: string;
  evidence_refs?: EvidenceRef[];
  tags?: string[];
}): BlessingRecord {
  const errors = validateBlessingInput({
    transition: "deprecate",
    target_hash: input.target_hash,
    evidence_refs: input.evidence_refs ?? [],
    reason: input.reason,
  });
  if (errors.length > 0) {
    throw new Error(`Deprecation validation failed: ${errors.map((e) => e.message).join("; ")}`);
  }

  const payload = buildBlessingHashPayload({
    transition: "deprecate",
    target_hash: input.target_hash,
    new_status: "deprecated",
    evidence_refs: sortRefs(input.evidence_refs ?? []),
    reason: input.reason,
    override_integrity: false,
    tags: [...(input.tags ?? [])].sort(),
  });

  return finalize(payload);
}

/**
 * Build a BlessingRecord for superseding one artifact with another.
 * Creates two linked records: deprecate old + bless new (caller may choose to use just one).
 * This function returns the supersession record that deprecates old_hash and links to new_hash.
 */
export function supersedeArtifact(input: {
  old_hash: string;
  new_hash: string;
  reason: string;
  evidence_refs?: EvidenceRef[];
  tags?: string[];
}): BlessingRecord {
  const errors = validateBlessingInput({
    transition: "supersede",
    target_hash: input.old_hash,
    evidence_refs: input.evidence_refs ?? [],
    reason: input.reason,
    superseded_by: input.new_hash,
  });
  if (errors.length > 0) {
    throw new Error(`Supersession validation failed: ${errors.map((e) => e.message).join("; ")}`);
  }

  const payload = buildBlessingHashPayload({
    transition: "supersede",
    target_hash: input.old_hash,
    new_status: "deprecated",
    evidence_refs: sortRefs(input.evidence_refs ?? []),
    superseded_by: input.new_hash,
    supersedes: input.old_hash,
    reason: input.reason,
    override_integrity: false,
    tags: [...(input.tags ?? [])].sort(),
  });

  return finalize(payload);
}

// ---------------------------------------------------------------------------
// Evidence ref collection (pure)
// ---------------------------------------------------------------------------

/**
 * Collect evidence refs from a mix of artifact hashes, execution hashes,
 * and pipeline IDs into a sorted, deduplicated EvidenceRef array.
 */
export function collectEvidenceRefs(input: {
  pipeline_ids?: string[];
  execution_hashes?: string[];
  artifact_hashes?: string[];
}): EvidenceRef[] {
  const refs: EvidenceRef[] = [];

  for (const id of input.pipeline_ids ?? []) {
    refs.push({ ref_type: "pipeline_id", value: id });
  }
  for (const h of input.execution_hashes ?? []) {
    refs.push({ ref_type: "execution_hash", value: h });
  }
  for (const h of input.artifact_hashes ?? []) {
    refs.push({ ref_type: "artifact_hash", value: h });
  }

  return sortRefs(dedupeRefs(refs));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortRefs(refs: EvidenceRef[]): EvidenceRef[] {
  return [...refs].sort((a, b) => {
    const typeCmp = a.ref_type.localeCompare(b.ref_type);
    if (typeCmp !== 0) return typeCmp;
    return a.value.localeCompare(b.value);
  });
}

function dedupeRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.ref_type}:${r.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finalize(payload: BlessingHashPayload): BlessingRecord {
  const hash = canonicalHash(payload as unknown as Record<string, unknown>);
  return { ...payload, hash };
}
