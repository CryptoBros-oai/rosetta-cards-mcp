# Contributing: Adding a new artifact type

## Checklist
1) Define schema in `src/kb/schema.ts` with `.strict()` at all nested levels
2) Define hash payload builder function (single source of truth)
3) Define filename convention keyed by `<hash12>`
4) Ensure prohibited keys are enforced appropriately (artifact-specific)
5) Add MCP tools (strict input schemas)
6) Add tests:
   - golden fixture (if appropriate)
   - determinism double-run
   - negative prohibited keys
   - proto pollution
7) Run full test suite

## Never
- mix meta fields into identity payload
- include environment/time randomness in hashed payload unless explicitly part of identity policy
- let derived outputs modify identity files