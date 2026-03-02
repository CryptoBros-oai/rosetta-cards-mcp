# Ingestion Behavior

This document summarizes ingestion behaviour relevant to pack policies and
how tags are applied and enforced during file and folder imports.

## Tagging rules

- Files ingested with `ingestFile` / `ingestFolder` are automatically tagged
  with `file` and a tag derived from their extension (e.g., `pdf`, `docx`,
  `txt`). Additional tags passed by callers are merged with these auto-tags.
- All tags are normalized as plain strings and are included in artifact JSON
  subject to canonicalization rules in `docs/FORMAT.md`.

## Pack policy enforcement during ingestion

- When a Behavior Pack is active, its `policies.blocked_tags` list is checked
  against the final tag set for every artifact created during ingestion.
- If any artifact's final tags intersect with `blocked_tags`, the ingestion
  operation will fail with a `PolicyViolationError` unless the caller passes
  `override_blocked: true` to the hook.
- For `ingestFolder` / folder-level imports, a policy violation for any single
  file causes the whole folder import to abort and the `PolicyViolationError`
  to be surfaced. This avoids silently producing partial imports that violate
  pack constraints.

## Context drain enforcement

- `drainContext` / `drainContextHook` also enforces `blocked_tags` against the
  tags provided for the chat log. If a blocked tag is present and
  `override_blocked` is not provided, the drain will fail with a
  `PolicyViolationError`.

## Override

- The `override_blocked: true` option is supported on hooks that create
  artifacts (`ingestFolderHook`, `ingestText`, `drainContextHook`) and will
  bypass `blocked_tags` checks for that operation only. Use with caution —
  packs exist to constrain export and surface policies deterministically.

## Determinism notes

- Policy checks are side-effect free: they do not change canonical bytes,
  hashes, or artifact content. They only prevent the creation of artifacts
  that would violate the pack's `blocked_tags` constraints, preserving
  existing determinism invariants.

