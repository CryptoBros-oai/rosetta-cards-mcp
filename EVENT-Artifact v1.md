# EVENT Artifact v1
Rosetta Artifact Vault — Temporal Atom Extension  
Version: 1.0  
Status: Proposed (implementation target)

## 1. Purpose

`event` is a **temporal memory atom** representing a discrete occurrence in a system (human activity, agent action, deployment, decision, meeting, incident, etc.).

This artifact type is designed to enable:
- Time-aware capture and recall
- Deterministic indexing and export
- Later synthesis/compression layers (weekly/monthly) built on evidence trails

**Critical constraint:** event identity remains **structural**, not temporal.  
Time is stored as metadata but must not contaminate deterministic identity.

This follows the Vault’s core rule: **identity is derived from canonical bytes**.  
Do not introduce nondeterministic inputs into hashed payload.  
(See Contributor discipline.)  

## 2. Classification

The Vault is a deterministic artifact graph: content-addressed, immutable, pack-aware, exportable by closure.  
`event` is a new **card** type within that system. It must obey:
- canonical JSON rules
- deterministic hashing
- no in-place mutation
- deterministic search ranking and tiebreaks
- deterministic export closure

## 3. Artifact Definition

### 3.1 Type
- `artifact_type`: `"event"`

### 3.2 Semantics
An event describes something that happened, observed, or recorded.

Examples:
- “Deployed Rosetta VM v0.6 to production”
- “User onboarding flow broke on /join”
- “Completed export preview feature”
- “Decision: switch OpenWebUI to dedicated host”

An event can optionally:
- reference artifacts (evidence)
- belong to a thread/project
- carry Rosetta tags (A/C/L/P/T + polarity)
- carry severity/priority

## 4. Canonical Payload (Hashed)

### 4.1 Canonical Card Schema (EventCard v1)

This is the **hashed** payload.  
Everything in this structure affects identity and therefore must remain deterministic.

```json
{
  "schema_version": "event.v1",
  "artifact_type": "event",

  "title": "string",
  "summary": "string",

  "event": {
    "kind": "deployment | incident | decision | meeting | build | research | ops | personal | other",
    "status": "observed | confirmed | resolved | superseded",
    "severity": "info | low | medium | high | critical",
    "confidence": 0.0,

    "participants": [
      { "role": "string", "name": "string" }
    ],

    "refs": [
      { "ref_type": "artifact_id | url | external_id", "value": "string" }
    ]
  },

  "tags": ["string"],

  "rosetta": {
    "verb": "Attract | Contain | Release | Repel | Transform",
    "polarity": "+ | 0 | -",
    "weights": { "A": 0, "C": 0, "L": 0, "P": 0, "T": 0 }
  }
}