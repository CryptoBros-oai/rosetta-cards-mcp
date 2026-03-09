# Corpus Import v0.1

Corpus Import v0.1 seeds the Vault with test-ready source material through a shared hook surface used by both CLI and TUI.

## Supported corpus types

1. Local folders (`.md`, `.txt` by default)
2. Public GitHub docs/text files
3. arXiv metadata imports (title + abstract)
4. Deterministic synthetic corpora

## CLI usage

Run via:

```bash
npm run corpus:local -- --root ./samples/rust-rfcs --tags rfc,design
npm run corpus:github -- --repo https://github.com/rust-lang/rfcs --path docs/ --max-files 50
npm run corpus:arxiv -- --query "transformer inference optimization" --max-results 20
npm run corpus:synthetic -- --theme "gpu inference" --doc-count 20 --pipeline-count 4
```

Optional post-actions:

- `--build-cards true`
- `--export-graph true`
- `--promote-facts true`
- `--promote-skills true`
- `--promote-summary true`

Scriptable output:

```text
Imported 20 docs
Built 20 cards
Exported graph to /.../data/graphs/corpus_graph_...
```

## TUI workflow

Open Corpus Import with:

- tab `5`
- key `i`

Screen options:

```text
Corpus Import
  [1] Local Folder
  [2] GitHub Repo
  [3] arXiv Query
  [4] Synthetic Corpus
```

After import:

- `b` build cards now
- `g` export graph now
- `o` browse imported artifact IDs
- `Enter` confirm import
- `Esc` cancel prompt

## Deterministic guarantees

- Input schemas are strict (`.strict()`) with explicit defaults.
- Traversal and source lists are sorted deterministically.
- Imported artifacts are content-addressed (`doc_ids` are artifact hashes).
- Synthetic corpora are fully deterministic for the same config.
- Graph export path is content-derived and deterministic.

## Provenance boundary

Source pointers are kept in sidecar metadata (`meta.v1`), not in identity-bearing payload fields:

- repo URL, GitHub path
- arXiv ID and source URL
- local root path
- source label

This keeps identity tied to canonical content while preserving source traceability.

## MCP endpoints

Corpus import is available through MCP tools:

- `corpus.import_local`
- `corpus.import_github`
- `corpus.import_arxiv`
- `corpus.import_synthetic`

These tools call the same shared hook layer as CLI/TUI and return deterministic structured results:

- `imported_count`
- `doc_ids`
- optional `card_ids` / `execution_ids`
- optional `graph_path`
- optional promotion outputs (`fact_ids`, `skill_ids`, `summary_id`)
- source summaries (`source_summary`)

Promotion MCP tools (for post-import artifact promotion):

- `promotion.promote_facts`
- `promotion.promote_skills`
- `promotion.promote_summary`
- `promotion.build_bundle`

## Recommended starter corpora

1. Rust RFCs (`https://github.com/rust-lang/rfcs`)
2. Public docs-heavy GitHub repos (`docs/` + `README.md` paths)
3. Focused arXiv abstract queries
4. Synthetic `"gpu inference"` corpora for graph/pipeline tests
