# Rosetta Cards MCP — Knowledge Base

This knowledge base defines the invariants and workflows for the Cortex artifact system.

## Start here (10 minutes)
1. Read **Identity Policy**: `docs/kb/IDENTITY_POLICY.md`
2. Read **Cortex Architecture**: `docs/kb/CORTEX_ARCHITECTURE.md`
3. Run the proof harness: `npm run genesis`

## Key concepts
- **Identity artifacts** are content-addressed JSON objects hashed via canonicalization + SHA-256.
- **Meta sidecars** store mutable context and must not affect identity.
- **Derived outputs** (index, PNG, reports) are rebuildable and must not affect identity.

## Where to look
- Specs: `docs/specs/`
- Artifact schemas: `src/kb/schema.ts`
- Hashing & guards: `src/kb/canonical.ts`
- Storage layout: `src/kb/vault.ts`
- Derived outputs (PNG, reports): `src/kb/derived.ts`, `src/kb/render.ts`
- MCP tools: `src/server.ts`

## Quick commands
- Tests: `npm test`
- Genesis proof: `npm run genesis`
- Rebuild index (MCP): `kb.rebuild_index`
- Storage telemetry (MCP): `kb.storage_report`
- Render PNG (MCP): `kb.render_card_png`, `kb.render_weekly_summary_png`