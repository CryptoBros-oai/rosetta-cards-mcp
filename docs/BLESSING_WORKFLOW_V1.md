# Blessing Workflow v1

## Overview

The blessing workflow provides a deterministic lifecycle for knowledge artifacts
in the Rosetta Cards vault. Artifacts progress through explicit states:

```
candidate  -->  blessed  -->  deprecated
                  |
                  +--> superseded (deprecated + link to replacement)
```

Every state transition produces a content-addressed **BlessingRecord** artifact.
Blessing records reference target artifacts by hash and include evidence refs,
preserving immutability — no in-place mutation of existing artifacts.

## Lifecycle States

| Status       | Meaning                                           |
|-------------|---------------------------------------------------|
| `candidate` | Default. Newly created, not yet reviewed.          |
| `blessed`   | Promoted with supporting evidence. Production-ready. |
| `deprecated`| Retired. May have been superseded by another artifact. |

## Transitions

### bless (candidate -> blessed)

**Requires:**
- At least one evidence ref (execution hash, artifact hash, pipeline ID, etc.)
- Clean pipeline integrity (unless `override_integrity=true`)
- Non-empty reason

**MCP tool:** `artifact.bless`

```json
{
  "target_hash": "abc123...",
  "evidence_refs": [
    { "ref_type": "pipeline_id", "value": "ingest-pipeline-001" },
    { "ref_type": "execution_hash", "value": "def456..." }
  ],
  "reason": "Validated via 3-step ingestion pipeline with clean integrity"
}
```

### deprecate (any -> deprecated)

**Requires:**
- Non-empty reason

**MCP tool:** `artifact.deprecate`

```json
{
  "target_hash": "abc123...",
  "reason": "Superseded by updated corpus analysis"
}
```

### supersede (blessed -> deprecated, with link to replacement)

**Requires:**
- Both `old_hash` and `new_hash` (must differ)
- Non-empty reason

**MCP tool:** `artifact.supersede`

```json
{
  "old_hash": "abc123...",
  "new_hash": "xyz789...",
  "reason": "Updated skill artifact with corrected parameters"
}
```

## Evidence Bundles

Before blessing, use `execution.build_evidence_bundle` to gather structured
evidence from an execution pipeline:

```json
{
  "pipeline_id": "ingest-pipeline-001"
}
```

Returns:
- Ordered execution steps with status/kind
- Parent/child chains
- Integrity summary (issues, clean flag)
- Deduplicated evidence refs (pipeline, execution, artifact refs)

Use `artifact.collect_evidence` to gather refs from arbitrary hashes:

```json
{
  "pipeline_id": "ingest-pipeline-001",
  "artifact_hashes": ["abc123..."],
  "execution_hashes": ["def456..."]
}
```

## Integrity-Aware Blessing

By default, `artifact.bless` rejects if the provided `integrity_summary`
has issues. To override:

```json
{
  "target_hash": "abc123...",
  "evidence_refs": [...],
  "reason": "Blessing despite missing parent in pipeline (non-critical)",
  "integrity_summary": { "total_cards": 3, "issue_count": 1, "clean": false, "issues": [...] },
  "override_integrity": true
}
```

The override is recorded in the BlessingRecord for auditability.

## Examples

### Candidate skill from execution trace

1. Run a pipeline: execution cards created
2. `execution.build_evidence_bundle` -> structured evidence
3. Create skill artifact (starts as candidate)
4. `artifact.bless` with evidence refs from the bundle

### Blessing a fact with supporting refs

1. `artifact.collect_evidence` with relevant pipeline/artifact/execution hashes
2. `artifact.bless` target fact hash with collected refs

### Superseding an outdated skill

1. Create new improved skill artifact
2. `artifact.supersede` old_hash -> new_hash with reason

### Deprecating a bad artifact

1. `artifact.deprecate` with reason explaining why

## Design Invariants

- BlessingRecords are content-addressed (hash = SHA-256 of canonical payload)
- Evidence refs are sorted deterministically (by ref_type, then value)
- Tags are sorted before hashing
- No in-place mutation of existing artifacts
- Supersession creates explicit bidirectional links (supersedes/superseded_by)
- Override flags are recorded in the record itself for audit trails
- All transitions require a non-empty reason string
