# Promotion Pipeline v1

Promotion Pipeline v1 adds a deterministic rules-based layer:

```text
corpus import -> execution evidence -> promoted knowledge artifacts
```

No LLM summarization is used in this version.

## Deterministic artifact shapes

All artifacts are content-addressed by canonical hash and stored under `data/cards/`.

## Fact candidate

```json
{
  "schema_version": "promotion.fact.v1",
  "artifact_type": "promotion_fact",
  "title": "...",
  "claim": "...",
  "refs": ["<doc-hash>", "..."],
  "tags": ["promotion", "fact", "..."],
  "hash": "<sha256>"
}
```

## Skill candidate

```json
{
  "schema_version": "promotion.skill.v1",
  "artifact_type": "promotion_skill",
  "title": "...",
  "recipe_steps": ["0. Import ...", "1. Validate ..."],
  "evidence_execution_ids": ["<execution-hash>", "..."],
  "refs": ["<execution-hash>", "..."],
  "tags": ["promotion", "skill", "..."],
  "hash": "<sha256>"
}
```

## Summary candidate

```json
{
  "schema_version": "promotion.summary.v1",
  "artifact_type": "promotion_summary",
  "title": "...",
  "summary_lines": ["docs=...", "executions=...", "facts=...", "skills=...", "refs=..."],
  "refs": ["<artifact-hash>", "..."],
  "tags": ["promotion", "summary", "..."],
  "hash": "<sha256>"
}
```

## Promotion bundle

```json
{
  "schema_version": "promotion.bundle.v1",
  "artifact_type": "promotion_bundle",
  "title": "...",
  "member_hashes": {
    "facts": ["<fact-hash>", "..."],
    "skills": ["<skill-hash>", "..."],
    "summary": "<summary-hash>"
  },
  "refs": ["<fact-hash>", "<skill-hash>", "<summary-hash>"],
  "tags": ["promotion", "bundle", "..."],
  "hash": "<sha256>"
}
```

## Hook-level opt-in (corpus import)

Corpus hooks accept:

- `promote_facts`
- `promote_skills`
- `promote_summary`

These flags are opt-in and default to `false`.

## MCP promotion tools

Available tools:

- `promotion.promote_facts`
- `promotion.promote_skills`
- `promotion.promote_summary`
- `promotion.build_bundle`

`promotion.build_bundle` can generate fact/skill/summary artifacts (configurable via `include_*` flags) and then write a deterministic promotion bundle artifact.

## Invariants

- Canonical hash identity only from structural payload fields.
- No timestamps in promotion identity payloads.
- Stable sort order for all generated arrays and grouping logic.
- Source provenance remains outside identity payloads.
