# Flows

## Genesis proof
Run:
- `npm run genesis`

Expected:
- "CORTEX GENESIS: PASS"
- identical hashes across consecutive runs

Proofs include:
- identity hash recomputation
- schema rejection of prohibited keys
- meta merge idempotence
- summary order-independence
- index rebuildability

## Common workflows
- Create card from doc chunk
- Create event + attach occurred_at in meta
- Render PNG for card/summary
- Rebuild index
- Storage budget report