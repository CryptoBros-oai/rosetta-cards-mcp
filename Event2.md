Awesome — here’s an **upload-ready** spec for `docs/specs/EVENT_ARTIFACT_V1.md` that Claude Code can implement directly. It’s written to obey your determinism doctrine (identity from canonical bytes, no time/env in hashed payload) and aligns with the Vault’s “kernel” framing and pipelines.  

---

````markdown
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
````

### 4.2 Canonicalization Rules

Use existing canonical JSON policy:

* UTF-8
* deep key sort (lexicographic)
* arrays preserve order **as provided** (therefore caller must sort when order is not meaningful)
* no undefined values
* stable stringification
* newline normalization handled by the existing card writer

### 4.3 Hash Input

Hash exactly the canonical bytes of the card JSON.

**Prohibited in hashed payload:**

* timestamps (created_at, occurred_at, etc.)
* random IDs
* absolute paths
* hostnames, OS-specific separators
* environment-dependent metadata

(If needed, store these in non-hashable provenance metadata; see Section 5.)

## 5. Non-Hashed Metadata (Allowed)

Events are temporal, so we need time — but time must not corrupt identity.

Store non-hashed metadata **outside** the canonical payload, or in an explicitly excluded `provenance` envelope that is never used for integrity hash.

Recommended non-hashed metadata fields:

* `occurred_at` (ISO8601, UTC preferred)
* `created_at` (ingest time)
* `source` (human/agent/system identifier)
* `location` (optional)
* `toolchain_version`
* `provenance_notes`

If your implementation uses a single JSON file for the card, you MUST ensure:

* metadata is excluded from the hash computation
* metadata has an explicit section name like `"provenance"` that is ignored by hashing

## 6. Relationships & Graph Edges

`event` can link to other artifacts using existing link mechanisms.

Preferred link types:

* `supports` (evidence supports event)
* `derived_from` (event derived from raw logs, chat chunks, etc.)
* `relates_to` (weak association)
* `supersedes` (event replaced by later corrected event)
* `contradicts` (explicit conflict)

Determinism rule:

* link traversal order must sort by `artifact_id` (lexicographic)
* export closure uses deterministic ordering (existing bundle closure discipline)

## 7. Search & Ranking Expectations

Search must remain deterministic:

* fixed weights
* deterministic tie-break (artifact_id, then title)

Events should rank similarly to cards:

* title match, tag match, pack boost, contains, pinned dominance
* no stochastic ranking signals

## 8. Export / Closure Expectations

Events export like any other card:

* included if pinned / referenced / within scope policy
* dependencies pulled via closure deterministically

If events reference URLs/external IDs:

* those do not create closure dependencies unless explicitly modeled as artifacts

## 9. Required Tests

### 9.1 Canonicalization Stability

* given the same EventCard payload, canonical bytes are identical
* JSON key order normalized
* no hidden nondeterminism

### 9.2 Hash Determinism

* same canonical payload → same `artifact_id` / hash across runs
* across machines (CI) with same toolchain

### 9.3 Prohibited Fields Guard

* ensure timestamp fields cannot enter hashed payload
* negative tests: attempt to include `occurred_at` inside hashed structure should fail schema validation

### 9.4 Cross-Run Equivalence

* ingest identical event twice → identical artifact hash/id
* export/import cycle preserves identity

### 9.5 Search Ordering Regression

* events with identical scores must be ordered by stable tiebreak

## 10. Example Payloads

### 10.1 Deployment Event (Hashed Card)

```json
{
  "schema_version": "event.v1",
  "artifact_type": "event",
  "title": "Deployed export preview modal to Pinsets",
  "summary": "Added deterministic dry-run export plan preview in TUI before exporting bundles.",
  "event": {
    "kind": "deployment",
    "status": "confirmed",
    "severity": "info",
    "confidence": 0.95,
    "participants": [
      { "role": "builder", "name": "Claude Code" },
      { "role": "reviewer", "name": "Brock" }
    ],
    "refs": [
      { "ref_type": "artifact_id", "value": "card_..." }
    ]
  },
  "tags": ["export", "tui", "determinism"],
  "rosetta": {
    "verb": "Transform",
    "polarity": "+",
    "weights": { "A": 0, "C": 0, "L": 0, "P": 0, "T": 1 }
  }
}
```

### 10.2 Optional Non-Hashed Provenance (Illustrative Only)

```json
{
  "occurred_at": "2026-03-02T20:15:00Z",
  "source": "system:ci",
  "toolchain_version": "rosetta-vault@0.1.0"
}
```

This metadata must not affect identity.

## 11. Implementation Checklist

1. Add TS type for EventCard v1
2. Add Zod schema validation
3. Enforce prohibited fields (timestamps) in hashed payload
4. Extend card registry to include `event`
5. Ensure hashing uses canonical bytes of the hashed payload only
6. Add unit + determinism tests
7. Update smoke fixture to include at least one event and verify golden stability

---

End of spec.

```

---

### Hand-off notes for Claude Code (so it “clicks” instantly)
- Treat `event` as **just another card type** with strict schema + canonical bytes hashing.
- **Time lives outside the hash** (or in a `provenance` block excluded from hashing).
- Add a negative test specifically proving that timestamps cannot sneak into the hashed payload. That’s the classic “determinism regression” gremlin. :contentReference[oaicite:2]{index=2}

If you paste that into your repo and point Claude Code at it, you’ll get a clean PR-sized implementation: schema + registry + tests + smoke fixture update.
```

