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

This follows the Vault's core rule: **identity is derived from canonical bytes**.
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
- "Deployed Rosetta VM v0.6 to production"
- "User onboarding flow broke on /join"
- "Completed export preview feature"
- "Decision: switch OpenWebUI to dedicated host"

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
```

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

* same canonical payload -> same `artifact_id` / hash across runs
* across machines (CI) with same toolchain

### 9.3 Prohibited Fields Guard

* ensure timestamp fields cannot enter hashed payload
* negative tests: attempt to include `occurred_at` inside hashed structure should fail schema validation

### 9.4 Cross-Run Equivalence

* ingest identical event twice -> identical artifact hash/id
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

## Appendix A — Determinism Threat Model

The identity rule `hash = canonicalHash(payload_without_hash)` is only as strong as
our ability to keep nondeterministic data **out** of the hashed payload. This appendix
catalogs known attack surfaces and their mitigations.

### A.1 Threat: Root Smuggling

**Description.** A prohibited key (`occurred_at`, `created_at`, `updated_at`,
`ingested_at`, `hash`, etc.) is placed directly at the root of the hashed payload —
either by a careless caller or an erroneous merge.

**Example.**

```json
{ "schema_version": "event.v1", "artifact_type": "event", "title": "...",
  "occurred_at": "2026-01-01T00:00:00Z" }
```

**Effect.** Two ingests of the same event at different times produce different hashes —
the artifact appears as two separate identities in the vault.

**Mitigations.**

- `EventCardSchema` uses `.strict()` — any unrecognized root key throws a Zod
  `unrecognized_keys` validation error before the payload reaches `canonicalHash`.
- `canonicalHash()` in `canonical.ts` maintains an explicit `PROHIBITED_KEYS` tripwire:
  any object passed to the hasher that contains a prohibited key throws immediately.
- The two defenses are redundant by design; either alone is sufficient, but both must
  stay active.

---

### A.2 Threat: Nested Smuggling

**Description.** A prohibited key is placed inside a nested object (`event`, `rosetta`,
`event.participants[]`, etc.) rather than at root, bypassing a root-only check.

**Example.**

```json
{ "event": { "kind": "deployment", "occurred_at": "2026-01-01T00:00:00Z" } }
```

**Mitigations.**

- All nested Zod schemas also use `.strict()` — `EventCardSchema.event`,
  `EventCardSchema.rosetta`, etc. reject unknown keys recursively.
- `canonicalHash()` walks the entire object graph recursively and checks
  `PROHIBITED_KEYS` at every node, not just the root.

---

### A.3 Threat: Protocol Smuggling (Spread / Merge Injection)

**Description.** A prohibited key enters the payload through an object spread or
merge operation that happens *before* validation:

```typescript
const payload = { ...baseCard, ...extraMetadata }; // extraMetadata has occurred_at
const hash = canonicalHash(payload); // tripwire catches it, but too late to blame
```

Or more subtly, a helper function returns an object that carries extra keys which then
get spread into the payload.

**Mitigations.**

- Builder functions (`buildEventCard`, `createWeeklySummary`, etc.) use **explicit field
  picking** — they construct the payload object key-by-key from typed inputs, never
  via spread of arbitrary input objects.
- Schema validation (`.parse()`) is called on the fully assembled payload before it
  reaches `canonicalHash`, so any smuggled field is caught at the schema gate.
- The `canonicalHash` tripwire acts as a final backstop — it is intentionally placed
  *after* schema validation so a double failure must occur to produce a silent collision.

---

### A.4 Threat: Refactor Drift

**Description.** During refactoring, a field that was previously stored only in sidecar
metadata gets moved into the main payload (or vice versa), silently changing the hash
of all future ingests while old artifacts keep the old hash. The vault now holds two
identity classes for what should be the same logical entity.

**Example.** A developer moves `tags` from the hashed payload to the MetaV1 sidecar
"to reduce clutter", causing every existing tag-bearing event to diverge from new ingests.

**Mitigations.**

- The canonical payload schema is **versioned** (`schema_version: "event.v1"`). Any
  structural change must bump the version, not silently alter the existing schema.
- Schema fields are documented in this spec; reviewers must approve changes that affect
  which fields are hashed.
- The smoke test golden fixture (`scripts/smoke.golden.json`) pins known artifact hashes;
  any hash regression fails CI immediately.

---

### A.5 Threat: Prototype Pollution

**Description.** Attacker-controlled JSON input sets `__proto__` or `constructor`
keys, which in older JS engines or naive merge paths can elevate into the prototype
chain and inject arbitrary properties into all objects, including the hashed payload.

**Example.**

```json
{ "__proto__": { "occurred_at": "2026-01-01T00:00:00Z" } }
```

After a naive `Object.assign({}, payload, userInput)`, every object in scope may
acquire `occurred_at` as an inherited property that appears in `JSON.stringify`.

**Mitigations.**

- `canonicalHash()` uses `JSON.parse(JSON.stringify(...))` normalization which produces
  a fresh object — breaking prototype chain inheritance before key enumeration.
- Zod `.strict()` rejects `__proto__` and `constructor` as unrecognized keys at parse
  time — MCP tool inputs never reach the builder with polluted prototypes.
- Node 20+ and V8 modern handling prevent `__proto__` from being treated as a prototype
  setter in `JSON.parse` output, providing an additional runtime-level defense.

---

### A.6 Defense Summary

| Defense | Where Applied | Catches |
| --- | --- | --- |
| Zod `.strict()` at all nesting levels | Schema parse, MCP ingress | Root + nested smuggling, prototype pollution |
| Explicit field picking in builders | `buildEventCard`, `createWeeklySummary`, etc. | Spread/merge injection |
| `PROHIBITED_KEYS` tripwire in `canonicalHash` | Hasher entry point | All of the above (redundant backstop) |
| Versioned `schema_version` field | Schema, builder | Refactor drift |
| Golden smoke fixture in CI | `scripts/smoke.mjs` | Refactor drift (hash regression) |
| Sidecar separation (`MetaV1`) | Storage layer | Time contamination of identity |

**Rule of thumb:** *If a field could change between two ingests of the same logical
event, it must not appear in the hashed payload.* Use the MetaV1 sidecar for
time, provenance, and operator annotations.
