# META Artifact v1 — Sidecar Specification
Rosetta Artifact Vault — Provenance & Annotation Sidecar
Version: 1.0
Status: Implemented

## 1. Purpose

`MetaV1` is a **sidecar artifact** — a separately persisted JSON file co-located with
every canonical artifact (card or event). It stores fields that **must not affect
artifact identity** but are important for retrieval, provenance, and operator annotation.

The separation enforces the vault's core identity rule:

> `hash = canonicalHash(payload_without_hash)`
>
> Artifact identity is derived solely from structural content. Time, source, and
> annotations are external to identity.

## 2. Classification

MetaV1 is **not content-addressed**. It has no `hash` field of its own. It is:

- Mutable (merged in place via `mergeMeta`)
- Co-located (lives beside its artifact in the same directory)
- Optional (absence of a sidecar does not invalidate the artifact)
- Derivable (can be rebuilt from provenance logs)

## 3. Schema

### 3.1 File Naming

| Artifact type | Sidecar path |
| --- | --- |
| `card` | `data/cards/card_<hash12>.meta.json` |
| `event` | `data/events/card_event_<hash12>.meta.json` |

`hash12` = first 12 hex characters of the artifact's SHA-256 hash.

### 3.2 Canonical Fields

```json
{
  "schema_version": "meta.v1",
  "artifact_hash": "<sha256-hex>",
  "artifact_type": "card | event",

  "occurred_at": "ISO8601 UTC — when the event/fact happened",
  "ingested_at": "ISO8601 UTC — when the artifact was stored",

  "sources": [
    { "kind": "url | file | agent | system", "value": "string" }
  ],

  "ingest": {
    "pipeline": "string",
    "chunk_index": 0,
    "source_file": "string"
  },

  "embeddings": [
    {
      "model": "string",
      "dims": 0,
      "embedding_id": "string",
      "index_path": "string"
    }
  ],

  "annotations": {
    "notes": "string",
    "meta_tags": ["string"]
  }
}
```

### 3.3 Validation

`MetaV1Schema` uses Zod `.strict()` at the root and all nested objects. Unknown keys
at any level throw `unrecognized_keys` and are rejected before persistence.

`MetaPatchSchema` accepts the same fields **minus identity fields** (`schema_version`,
`artifact_hash`, `artifact_type`). This prevents callers from accidentally overwriting
identity via a patch operation.

## 4. Merge Semantics

`mergeMeta(hash, type, patch)` implements **deterministic union merge**:

| Field | Merge rule |
| --- | --- |
| `occurred_at` | Last-write-wins (most recent call wins) |
| `ingested_at` | Last-write-wins |
| `sources[]` | Union by `(kind, value)` composite key — deduplicates, order preserved |
| `embeddings[]` | Union by `(model, dims, embedding_id?)` — deduplicates |
| `annotations.notes` | Last-write-wins |
| `annotations.meta_tags[]` | Union (sorted, deduplicated) |
| `ingest.*` | Field-level last-write-wins (only present fields are merged) |

Merge is idempotent: applying the same patch twice produces the same result as applying
it once.

## 5. API

```typescript
loadMeta(hash: string, type?: MetaV1["artifact_type"]): Promise<MetaV1 | null>
mergeMeta(hash: string, type: MetaV1["artifact_type"], patch: MetaPatch): Promise<MetaV1>
deleteMeta(hash: string, type: MetaV1["artifact_type"]): Promise<void>
```

MCP tools: `kb.get_meta`, `kb.merge_meta`.

---

## Appendix A — Determinism Threat Model

MetaV1 sidecars are deliberately **outside** the artifact hash. This creates a different
threat surface than the canonical payload: the risk is not identity collision, but
**sidecar corruption** — corrupted or smuggled data persisted alongside a valid artifact.

### A.1 Threat: Root Smuggling

**Description.** A caller passes unknown keys at the root of a patch or sidecar object,
which then get written to disk and later re-read as if valid.

**Example.**

```json
{ "artifact_hash": "abc...", "artifact_type": "card", "rogue_field": "bad" }
```

**Effect.** The sidecar file contains unvalidated data that future readers may act on,
or that makes the sidecar fail schema validation on read (breaking `loadMeta`).

**Mitigations.**

- `MetaV1Schema` and `MetaPatchSchema` use `.strict()` — unknown root keys throw
  `unrecognized_keys` before any write occurs.
- `mergeMeta` always runs the merged result through `MetaV1Schema.parse()` before
  writing to disk, ensuring the persisted file is always valid.

---

### A.2 Threat: Nested Smuggling

**Description.** A prohibited or unknown key is placed inside a nested object
(`sources[]`, `embeddings[]`, `ingest`, `annotations`) rather than at root.

**Example.**

```json
{ "ingest": { "pipeline": "x", "secret_key": "leaked" } }
```

**Mitigations.**

- All nested schemas (`IngestMetaSchema`, `EmbeddingMetaSchema`, `AnnotationsSchema`,
  `SourceSchema`) use `.strict()` — unknown keys at any depth are rejected.
- The terminal `.parse()` in `mergeMeta` validates the entire merged tree before write.

---

### A.3 Threat: Protocol Smuggling (Identity Field Overwrite)

**Description.** A patch operation tries to overwrite identity-bearing fields
(`schema_version`, `artifact_hash`, `artifact_type`) through the public `mergeMeta`
API — either accidentally or maliciously.

**Example.**

```typescript
await mergeMeta(hash, "card", {
  artifact_hash: "different_hash",  // attempt to re-point the sidecar
  occurred_at: "2026-01-01T00:00:00Z",
});
```

**Effect.** If accepted, the sidecar would point to a different artifact, breaking the
co-location invariant and potentially creating phantom metadata associations.

**Mitigations.**

- `MetaPatchSchema` structurally excludes `schema_version`, `artifact_hash`, and
  `artifact_type` — these fields are not present in the patch schema and cannot be
  passed through `kb.merge_meta`.
- `mergeMeta` re-stamps identity fields from its own parameters (not from the patch),
  so even a direct TypeScript call with a cast cannot overwrite them.

---

### A.4 Threat: Refactor Drift

**Description.** A field currently stored only in MetaV1 gets copied into the canonical
payload during a refactor (or vice versa), creating a class of future artifacts that
have both representations — making it ambiguous which is authoritative.

**Example.** A developer copies `annotations.meta_tags` into the hashed payload as
`tags` in order to make them searchable — but forgets to remove them from MetaV1.

**Effect.** The tag appears in two places with potentially diverging values. Hash
changes for all future ingests that include tags.

**Mitigations.**

- The split between canonical payload and sidecar is **documented in spec** (this file
  and EVENT_ARTIFACT_V1.md). The rule is explicit: anything that could change between
  two ingests of the same logical artifact goes in the sidecar.
- `MetaV1Schema` and `EventCardSchema` are in the same `schema.ts` file — cross-schema
  review is easy, and schema reviewers must verify no field appears in both.
- The smoke golden fixture pins artifact hashes, immediately surfacing any accidental
  payload expansion.

---

### A.5 Threat: Prototype Pollution

**Description.** Attacker-controlled JSON input (e.g., from an MCP tool call) includes
`__proto__` or `constructor` keys that pollute the JavaScript prototype chain, injecting
unexpected properties into all subsequently created objects — including merged sidecars.

**Example.**

```json
{ "__proto__": { "occurred_at": "2026-01-01T00:00:00Z" } }
```

**Effect.** Sidecar objects acquire inherited properties that appear in serialization,
corrupting the persisted file.

**Mitigations.**

- `MetaPatchSchema.parse()` at the MCP ingress point rejects `__proto__` and
  `constructor` as unrecognized keys (Zod `.strict()`).
- `mergeMeta` uses structured spread onto an explicit object literal — no
  `Object.assign(target, untrustedSource)` patterns.
- Node 20+ `JSON.parse` does not treat `__proto__` as a prototype setter, providing
  a runtime-level backstop for data arriving via JSON deserialization.

---

### A.6 Defense Summary

| Defense | Where Applied | Catches |
| --- | --- | --- |
| Zod `.strict()` at all nesting levels | `MetaV1Schema`, `MetaPatchSchema`, MCP ingress | Root + nested smuggling, prototype pollution |
| `MetaPatchSchema` excludes identity fields | Patch API | Protocol smuggling (identity overwrite) |
| `mergeMeta` re-stamps identity from parameters | Storage layer | Protocol smuggling (identity overwrite) |
| Terminal `MetaV1Schema.parse()` before write | `mergeMeta` | Any smuggling that survives merge |
| Explicit field construction in merge helpers | `mergeSources`, `mergeAnnotations`, etc. | Spread/merge injection |
| Spec-documented canonical/sidecar split | This document + EVENT_ARTIFACT_V1.md | Refactor drift |
| Golden smoke fixture in CI | `scripts/smoke.mjs` | Refactor drift (hash regression) |

**Rule of thumb:** *The sidecar is the right place for anything that can change after
the artifact is created.* The canonical payload is sealed at ingest. If in doubt,
put it in MetaV1.
