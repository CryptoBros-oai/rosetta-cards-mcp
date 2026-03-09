# Artifact Types

## Identity artifacts
### Card (`card.v1`)
- Purpose: durable “knowledge atom”
- Stored: `data/cards/card_<hash12>.json`
- Hash includes: `created_at`

### Event (`event.v1`)
- Purpose: durable “temporal atom” (structural occurrence)
- Stored: `data/events/card_event_<hash12>.json`
- Hash excludes: all timestamps + provenance

### Weekly summary (`summary.week.v1`)
- Purpose: lossy compression of a time window, with references
- Stored: `data/summaries/summary_week_<hash12>.json`
- Hash stable across reference ordering

## Meta sidecars (`meta.v1`)
- Purpose: mutable context lane (timestamps, provenance, render pointers, embedding refs)
- Stored: alongside each artifact by hash, `*.meta.json`

## Derived outputs
- PNG renders: `derived/.../*.png`
- Index snapshot: `data/index/index_snapshot.json`
- Storage report: computed on demand