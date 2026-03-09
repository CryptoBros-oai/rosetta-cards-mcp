# Rosetta Cards MCP Server

Content-addressed knowledge vault exposed as MCP tools over stdio.

## Architecture

Four subsystems:

1. **KB layer** (`src/kb/`) — Document ingestion, card generation (JSON + PNG), lexical search, behavior packs, bundle export/import. ~40 files.
2. **Artifact Vault** (`src/vault/`) — Content-addressed blob store with JSONL index. Eight artifact kinds: event, fact, decision, skill, profile, tool_obs, summary, project. Full lifecycle: candidate -> blessed -> deprecated/superseded.
3. **Execution Graph** (`src/kb/execution_graph.ts`, `evidence.ts`, `blessing.ts`) — Pipeline provenance, parent/child chains, integrity checking, evidence bundles for blessing.
4. **Rosetta VM** (`src/kb/vm_*.ts`) — Deterministic opcode VM mapped to five verbs (Attract, Contain, Release, Repel, Transform). Phase scanning, boundary hunting, novelty detection.

## Critical Invariants

- **Identity rule**: `id = sha256(canonicalize({version, kind, payload, tags, refs}))`. Temporal and environmental fields NEVER enter the hash. See `IDENTITY_POLICY.mdd` and `docs/kb/CORTEX_ARCHITECTURE.md`.
- **Prohibited keys in hashed payloads**: `created_at`, `updated_at`, `timestamp`, `now`, `hostname`, `cwd`, `pid`, `ppid`, `uid`, `home`, `user`, `username`, `env`, `__proto__`, `prototype`, `constructor`. Enforced recursively by `src/kb/canonical.ts` and `src/vault/canon.ts`.
- **Canonicalization**: NFC Unicode normalization, recursive key sort, undefined stripped, compact JSON, UTF-8 no BOM. Implemented in `src/kb/canonical.ts`.
- **Cortex tiers**: Tier 0 (identity, immutable) -> Tier 1 (meta sidecars, mutable) -> Tier 2 (derived/rebuildable) -> Tier 3 (heavy payloads). Never mix tiers.

## Tech Stack

- TypeScript, ES2022 modules, Bundler resolution
- Node.js test runner (`node:test`)
- Zod for schema validation
- MCP SDK (`@modelcontextprotocol/sdk`) over stdio
- No database — file-backed JSONL indexes + content-addressed blobs

## File Conventions

- Artifact files: `data/cards/card_<hash12>.json`, `data/events/card_event_<hash12>.json`
- Meta sidecars: `<artifact>.meta.json` (same directory)
- Vault blobs: `.vault/blobs/<id[0:2]>/<id[2:4]>/<id>.json`
- Vault index: `.vault/index.jsonl`
- VM runs: `data/runs/<hash12>/`

## Project Structure

- `src/server.ts` — MCP server bootstrap (stdio transport, request routing)
- `src/tool_registry.ts` — All MCP tool definitions (name, description, inputSchema, handler)
- `src/kb/` — Knowledge base: ingestion, cards, events, executions, search, storage
- `src/vault/` — Content-addressed artifact vault
- `src/tui/` — Terminal UI screens
- `tests/` — 53 test files, Node.js test runner. Golden fixtures in `tests/fixtures/`

## Test Suite

Run: `npm test`
Smoke: `npm run smoke`

## Commands

- `npm run dev` — Start MCP server (stdio)
- `npm run build` — TypeScript compile
- `npm test` — Full test suite
- `npm run smoke` — Golden hash regression
- `npm run tui` — Terminal UI

## When Modifying

- NEVER add temporal/env keys to any hashed payload
- ALWAYS run `npm test` after changes
- If you change `canonical.ts` or `vault/canon.ts`, run `npm run smoke -- --refresh-golden` ONLY after confirming the change is intentional
- New MCP tools: add to `src/tool_registry.ts` (registry pattern with `Map<string, ToolDef>`)
- New artifact types need: schema in `schema.ts`, prohibited-key tests, determinism double-run test, golden fixture
