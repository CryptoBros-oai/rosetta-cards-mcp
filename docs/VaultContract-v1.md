# Vault Contract v1

Content-addressed artifact storage for MCP agents.

## Artifact Envelope

```json
{
  "version": "artifact_v1",
  "kind": "event | fact | decision | skill | profile | tool_obs | summary | project",
  "id": "<sha256 hex>",
  "created_at": "<ISO 8601>",
  "last_seen_at": "<ISO 8601>",
  "source": { "agent": "...", "tool": "...", "repo": "...", "run_id": "..." },
  "tags": ["..."],
  "payload": { ... },
  "refs": [{ "kind": "...", "id": "..." }]
}
```

## Identity Rule

```
id = sha256(canonicalize({ version, kind, payload, tags, refs }))
```

**Structural (hashed):** `version`, `kind`, `payload`, `tags`, `refs`

**Excluded from hash:** `created_at`, `last_seen_at`, `source`

Tags are sorted lexicographically before hashing. Object keys are recursively sorted and strings NFC-normalized (via `kb/canonical.ts`).

## Prohibited Payload Keys

The following keys are rejected in `payload` to prevent determinism contamination:

| Category | Keys |
|----------|------|
| Temporal | `created_at`, `updated_at`, `timestamp`, `now` |
| Environment | `hostname`, `cwd`, `pid`, `ppid`, `uid`, `home`, `user`, `username`, `env` |
| Proto-pollution | `__proto__`, `prototype`, `constructor` |

Nested occurrences are also rejected (recursive check).

## Deduplication

Same structural content (version + kind + payload + tags + refs) always produces the same `id`. On re-put:
- `last_seen_at` is updated in both the blob and index
- `created_at` is preserved from the first write
- Returns `{ created: false }`

## Personal Tag Convention

Tags prefixed with `personal:` mark artifacts as user-private. Examples: `personal:workflow`, `personal:preference`.

- `vault.search` includes personal artifacts by default
- Set `exclude_personal: true` to omit them (for export/sharing scenarios)
- Downstream consumers should filter `personal:*` tags when aggregating shared vaults

## Skill Artifacts

Use `kind: "skill"` for reusable recipes. Convention:
- Add `"blessed"` tag for curated/approved skills
- Agents retrieve skills via `vault.search` with `kind: "skill"` and tag filters

## Storage Layout

```
.vault/                                    (ARTIFACT_VAULT_ROOT env var, default .vault/)
  blobs/<id[0:2]>/<id[2:4]>/<id>.json     (pretty-printed envelope)
  index.jsonl                               (one JSON line per artifact)
```

Configurable via `ARTIFACT_VAULT_ROOT` environment variable.

## JSONL Index Format

One JSON line per artifact:

```json
{ "id": "...", "kind": "...", "tags": [...], "created_at": "...", "last_seen_at": "...", "snippet": "..." }
```

`snippet` is the first 200 characters of `JSON.stringify(payload)`.

## MCP Tools

### vault.put

Store a content-addressed artifact. Deduplicates by structural hash.

**Input:**
```json
{
  "kind": "skill",
  "payload": { "name": "...", "steps": [...] },
  "tags": ["blessed"],
  "refs": [{ "kind": "fact", "id": "abc123..." }],
  "source": { "agent": "my-agent", "tool": "vault.put" }
}
```

**Response:**
```json
{ "id": "1f50587a...", "created": true, "created_at": "...", "last_seen_at": "..." }
```

### vault.get

Retrieve an artifact by ID.

**Input:** `{ "id": "1f50587a..." }`

**Response:** Full artifact envelope, or `{ "error": "NOT_FOUND" }`.

### vault.search

Search artifacts with optional filters.

**Input:**
```json
{
  "query": "deterministic hashing",
  "kind": "skill",
  "tags": ["blessed"],
  "exclude_personal": false,
  "limit": 10,
  "offset": 0
}
```

**Response:**
```json
{
  "total": 42,
  "offset": 0,
  "limit": 10,
  "results": [
    { "id": "...", "kind": "skill", "score": 55, "tags": [...], "created_at": "...", "snippet": "..." }
  ]
}
```

**Search semantics:**
- `kind` — exact match filter
- `tags` — AND logic (all specified tags must be present)
- `query` — tokenized full-text scoring: tag match +25/token, snippet match +5/token, kind match +10
- `exclude_personal` — omit artifacts with any `personal:*` tag
- Results sorted by score desc, then `last_seen_at` desc, then `id` asc

## Error Codes

| Code | When |
|------|------|
| `NOT_FOUND` | `vault.get` with unknown ID |
| `INVALID_ARTIFACT` | `vault.put` with prohibited payload keys or proto-pollution |
