# Cortex Architecture

## Layers (do not mix)
### Tier 0 — Identity (immutable)
- `data/cards/*.json`
- `data/events/*.json`
- `data/summaries/*.json`

Identity is determined ONLY by the canonicalized JSON payload hashed by `canonicalHash()`.

### Tier 1 — Meta (mutable sidecars)
- `*.meta.json` files keyed by artifact hash
- Stores time/provenance/ingest/embeddings refs/render pointers/notes

Meta MUST NOT affect identity hashes.

### Tier 2 — Derived (rebuildable / disposable)
- Index snapshots
- PNG renders
- Storage reports
- Anything that can be regenerated from identity + meta

Derived artifacts MUST NOT affect identity hashes.

### Tier 3 — Heavy payloads (large / often cold)
- Docs, extracted text, chunk stores
- Embedding vector payloads (store pointers in meta; payloads live elsewhere)

## Directory conventions
- Identity:
  - `data/cards/card_<hash12>.json`
  - `data/events/card_event_<hash12>.json`
  - `data/summaries/summary_week_<hash12>.json`
- Meta:
  - `data/cards/card_<hash12>.meta.json`
  - `data/events/card_event_<hash12>.meta.json`
  - `data/summaries/summary_week_<hash12>.meta.json` (if used)
- Derived:
  - `derived/cards/card_<hash12>.png`
  - `derived/summaries/summary_week_<hash12>.png`
  - `data/index/index_snapshot.json`

## Rebuildability
Indexes and renders must be deletable and regenerable without loss of identity artifacts.