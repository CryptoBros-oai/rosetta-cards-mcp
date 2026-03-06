# EXECUTION Artifact v1
Rosetta Artifact Vault -- Operational Evidence Extension
Version: 1.0
Status: Proposed (implementation target)

## 1. Purpose

`execution` is an **operational evidence atom** representing a discrete unit of
machine/human/agent work: tool invocations, model calls, pipeline runs,
validation records, import/export operations, and workflow completions.

This artifact type bridges:
- **Knowledge artifacts** (docs/cards/bundles/packs)
- **Event artifacts** (something happened)
- **Operational history** (what was actually done, by whom, with what evidence)

Execution artifacts are structured evidence of work, not loose logs.

**Critical constraint:** execution identity remains **structural**, not temporal.
Timestamps, duration, cost, runtime info, and provenance are stored as metadata
but must not contaminate deterministic identity.

This follows the Vault's core rule: **identity is derived from canonical bytes**.
Do not introduce nondeterministic inputs into hashed payload.

## 2. Classification

The Vault is a deterministic artifact graph: content-addressed, immutable,
pack-aware, exportable by closure.
`execution` is a new **card** type within that system. It must obey:
- canonical JSON rules
- deterministic hashing
- no in-place mutation
- deterministic search ranking and tiebreaks
- deterministic export closure

## 3. Artifact Definition

### 3.1 Type
- `artifact_type`: `"execution"`

### 3.2 Semantics
An execution describes work that was performed, requested, or validated.

Examples:
- "Ingested 47 documents from /data/corpus via kb.ingest_folder"
- "Model call: Claude summarized 12 cards into weekly report"
- "Validated bundle integrity: 8/8 cards hash-verified"
- "Pipeline: corpus ingestion -> card build -> pack closure -> export"
- "Human review: approved 3 event cards for weekly summary"

An execution can optionally:
- reference input/output artifacts (evidence chain)
- carry validation state
- belong to a workflow or pipeline
- carry Rosetta tags (A/C/L/P/T + polarity)

## 4. Canonical Payload (Hashed)

### 4.1 Canonical Card Schema (ExecutionCard v1)

This is the **hashed** payload.
Everything in this structure affects identity and therefore must remain
deterministic.

```json
{
  "schema_version": "execution.v1",
  "artifact_type": "execution",
  "title": "string",
  "summary": "string",
  "execution": {
    "kind": "job | tool_call | model_call | pipeline | validation | import | export | other",
    "status": "requested | running | succeeded | failed | partial | validated | rejected",
    "actor": {
      "type": "human | agent | system | node",
      "name": "string"
    },
    "target": {
      "type": "artifact | tool | model | node | external",
      "name": "string"
    },
    "inputs": [
      { "ref_type": "artifact_id | url | external_id | inline", "value": "string" }
    ],
    "outputs": [
      { "ref_type": "artifact_id | url | external_id | inline", "value": "string" }
    ],
    "validation": {
      "state": "unvalidated | self_reported | verified | disputed",
      "method": "none | hash_check | human_review | replay | consensus"
    }
  },
  "tags": ["string"],
  "rosetta": {
    "verb": "Attract | Contain | Release | Repel | Transform",
    "polarity": "+ | 0 | -",
    "weights": { "A": 0, "C": 0, "L": 0, "P": 0, "T": 0 }
  },
  "hash": "sha256-hex (computed from all fields above except hash)"
}
```

### 4.2 Identity Rule

```
hash = sha256(canonicalize({
  schema_version, artifact_type, title, summary, execution, tags, rosetta
}))
```

Same rules as event cards:
- Keys sorted recursively (lexicographic)
- NFC-normalized strings
- undefined omitted, null preserved
- Compact JSON (no whitespace)

### 4.3 Fields That Affect Identity

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| schema_version | literal "execution.v1" | yes | |
| artifact_type | literal "execution" | yes | |
| title | string | yes | Short description of the work |
| summary | string | yes | Detailed description |
| execution | ExecutionDetail | yes | Structured execution record |
| tags | string[] | yes | Structural tags (sorted for stability) |
| rosetta | RosettaMeta | yes | Rosetta classification |
| hash | string | yes (computed) | SHA-256 of canonical payload |

### 4.4 ExecutionDetail Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| kind | enum | yes | Category of execution |
| status | enum | yes | Current status |
| actor | {type, name} | yes | Who/what performed the work |
| target | {type, name} | yes | What was acted upon |
| inputs | ExecutionRef[] | yes | Input references (may be empty) |
| outputs | ExecutionRef[] | yes | Output references (may be empty) |
| validation | {state, method} | yes | Validation status |

## 5. Non-Hashed Metadata (Sidecar)

These fields live in the MetaV1 sidecar (`.meta.json`) and MUST NOT affect
identity.

| Field | Type | Notes |
|-------|------|-------|
| occurred_at | ISO 8601 | When the execution occurred |
| created_at | ISO 8601 | When this artifact was created |
| duration_ms | number | Execution duration |
| toolchain_version | string | Version of the toolchain |
| runtime | string | Runtime environment |
| host | string | Host/node identifier |
| cost_estimate | object | Cost metadata (tokens, dollars, etc.) |
| provenance_notes | string | Free-text provenance notes |

## 6. Prohibited Keys in Hashed Payload

The following keys MUST NEVER appear in the hashed canonical payload.
The runtime guard (`assertNoExecutionProhibitedKeys`) rejects them recursively:

- occurred_at, created_at, updated_at
- timestamp, time
- source, provenance
- runtime, duration_ms, cost_estimate
- hostname, cwd, pid, ppid, uid, home, user, username, env

## 7. Hash Payload Builder

All hashing MUST flow through `buildExecutionHashPayload()`.
This is the single source of truth for execution card identity.

```typescript
function buildExecutionHashPayload(parsed: {
  title: string;
  summary: string;
  execution: ExecutionDetail;
  tags: string[];
  rosetta: RosettaMeta;
}): ExecutionHashPayload
```

No duplicate "assemble payload" logic in multiple places.

## 8. Storage

Execution cards are stored alongside other cards:
```
data/cards/card_execution_<hash[0:12]>.json
```

This follows the existing convention:
- `card_event_<hash12>.json` for events
- `card_file_<hash12>.json` for file artifacts
- `card_chunk_<hash12>.json` for chat chunks

## 9. Input Boundary

`ExecutionCreateInputSchema` is the strict input surface.
It rejects unknown keys at all nesting levels.
Temporal fields are structurally absent from the input schema.

## 10. Contributor Discipline

- Do NOT introduce timestamps, random IDs, or environment data into the hashed payload.
- Do NOT bypass the hash payload builder.
- Do NOT add keys to ExecutionDetail without updating the prohibited-key guard.
- Do NOT store sidecar data inside the hashed structure.
- Run the tripwire guard before every hash computation.
