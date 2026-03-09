# Rosetta Cards MCP (v0.1)
See /DOCS/KB FOLDER DOCUMENTS before modifying any schema or hashing logic.

A minimal MCP server that turns plain text / notes into **visual knowledge cards**:

- `card.json` (structured, versioned, hashed)
- `card.png` (1200×675 infographic with optional QR payload)
- a simple searchable index (lexical cosine today; swap to embeddings later)

## What this implementation inputs and outputs

### Inputs

- A document: `{ title, text, tags?, source_url? }`
- Optionally select a `chunk_id` (documents are chunked by paragraphs)

### Outputs

- A **doc record** on disk:
  - `data/docs/<doc_id>.json` (raw + chunks)
- A **card artifact** on disk:
  - `data/cards/<card_id>.json` (CardPayload v1)
  - `data/cards/<card_id>.png` (rendered card image)
- A **search index** on disk:
  - `data/index/cards_index.json` (simple lexical vector index)

QR payload (if enabled) contains a compact pointer:
`{ version, card_id, hash, sources[] }`

## Tools exposed (MCP)

- `kb.add_document`
- `kb.build_card`
- `kb.search`
- `kb.get_card`

## Setup

```bash
bash scripts/bootstrap.sh
```

## Run

```bash
npm run dev
```

Connect your MCP client to the server via stdio.

## Search Ranking

Search results are ranked by a deterministic scoring module (`src/kb/search_rank.ts`)
with fixed-weight constants (no ML, no randomness):

| Signal                                | Points   | Cap  |
| ------------------------------------- | -------- | ---- |
| Pinned in active pack                 | +500     | —    |
| Exact title match (case-insensitive)  | +100     | —    |
| Title token matches                   | +40 each | +120 |
| Tag exact matches                     | +25 each | +100 |
| Pack allowed_tags match artifact tags | +10 each | +50  |
| Text contains query substring         | +30      | —    |

Ties are broken by `artifact_id` (lexicographic), then `title` (lexicographic).

## Export Active Pack

Export only the active behavior pack and its transitive closure:

```typescript
import { exportActivePackHook } from './src/kb/hooks.js';
const result = await exportActivePackHook();
// result.bundle_path, result.manifest, result.card_count, ...
```

The pack's `default_export_scope` policy controls what gets exported:

- `"pack_only"` (default): only pinned cards + blob/text dependencies
- `"all"`: every card in the vault

TUI: Pinsets tab → press `[e]` to preview and export the active pack closure.

### Export Preview (Dry-Run)

Before exporting, a preview modal shows:

- Scope (`pack_only` or `all`)
- Card count, blob count, text count
- Estimated bundle size in KB

Press **Enter** to proceed or **Esc** to cancel.

Programmatic dry-run:

```typescript
import { planExport } from './src/kb/bundle_plan.js';
const plan = await planExport({ pack_id: 'pack_...' });
// plan.artifact_count, plan.estimated_bytes, plan.blob_count, ...
```

### Bundle Provenance

Exported bundles include optional provenance metadata describing their origin:

```json
{
  "provenance": {
    "generator": "rosetta-cards-mcp",
    "generator_version": "0.1.0",
    "export_scope": "pack_only",
    "pack": { "pack_id": "...", "name": "...", "hash": "..." },
    "include_blobs": true,
    "include_text": true,
    "created_at": "2025-08-01T12:00:00.000Z"
  }
}
```

The `integrity_hash` is computed **only** from `card_id:hash` pairs — provenance
and timestamps have zero effect on it. Bundles without provenance are still valid.

## Claude Code Integration

This project ships a `.mcp.json` that registers the server as an MCP tool source
automatically when Claude Code opens the project directory.

### Setup (dev mode — no build step)

The `.mcp.json` in the project root runs `ts-node/esm` directly:

```bash
npm ci   # install dependencies once
# Claude Code will auto-discover .mcp.json on next launch
```

For the compiled version, build first and use the script:

```bash
npm run build
bash scripts/mcp-start.sh
```

See `.mcp.json.example` for all configuration variants.

### Available tool namespaces

| Namespace     | Description                                        |
| ------------- | -------------------------------------------------- |
| `kb.*`        | Knowledge base — documents, cards, search, index   |
| `vault.*`     | Content-addressed artifact vault (put/get/search)  |
| `vm.*`        | Deterministic VM — execute programs, scan, compare |
| `execution.*` | Pipeline traversal, integrity checks               |
| `artifact.*`  | Bless, deprecate, supersede artifacts              |
| `corpus.*`    | Import from local dirs, GitHub, arXiv, synthetic   |
| `promotion.*` | Promote facts, skills, summaries                   |

### Quick example

```text
> vault.put a fact with payload {"content": "Claude Code can use MCP tools"} and tags ["mcp", "demo"]
> vault.search for "MCP tools"
```

### Embedding search

Vault search supports three modes: `hybrid` (default), `semantic`, and `lexical`.

Hybrid and semantic modes require a running local embedding endpoint compatible
with the OpenAI `/v1/embeddings` API. Supported servers:

- **LM Studio** — load any embedding model, runs on `localhost:1234` by default
- **Ollama** — `ollama serve` with an embedding model pulled
- **text-embeddings-inference** — HuggingFace's dedicated server

Set `EMBEDDING_ENDPOINT` in `.mcp.json` env (or shell) to override the default
`http://localhost:1234/v1/embeddings`.

If no embedding endpoint is available, search falls back to lexical (FTS5) automatically.

To backfill embeddings for existing artifacts:

```text
> vault.reindex_embeddings
```

## Notes

- The summarizer is a naive stub: `src/kb/summarize.ts`
  Replace it with your preferred model call.
- KB search uses lexical cosine: `src/kb/embed.ts`
  Vault search uses FTS5 + optional vector embeddings (see above).

## Quickstart: verify it works

Minimum golden path for a new contributor:

```bash
npm ci
npm test
npm run build
npm run tui
```

Quick sample (ingest a folder and inspect artifacts):

```bash
# Ingest a local folder into the vault via the TUI or programmatically
# Example (scripted):
node --loader ts-node/esm scripts/seed.ts  # creates sample cards and artifacts

# Inspect produced artifacts
ls -la data/cards
ls -la data/blobs
ls -la data/text
```

Expected artifacts:

- `data/cards/*.json` — card and index JSON artifacts
- `data/blobs/<hh>/<hh>/<hash>` — stored blobs
- `data/text/<hh>/<hh>/<hash>.txt` — canonicalized text records

## Smoke Test

Run:

```bash
npm run smoke
```

Validates:

- Folder ingestion (fixture → cards + blobs)
- Context drain (chat text → chunks + index)
- Behavior pack enforcement
- Bundle export/import across vaults
- Cross-vault hash equality
- Deterministic re-ingestion (same input → same hashes)

On first run, establishes a golden reference at `scripts/smoke.golden.json`.
On subsequent runs, compares computed hashes and counts against golden.
If any value drifts, smoke exits non-zero with a diff.

To refresh golden reference after intentional schema changes:

```bash
npm run smoke -- --refresh-golden
```
