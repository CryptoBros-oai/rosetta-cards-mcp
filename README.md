# Rosetta Cards MCP (v0.1)

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

## Notes
- The summarizer is a naive stub: `src/kb/summarize.ts`
  Replace it with your preferred model call.
- Search is lexical cosine: `src/kb/embed.ts`
  Replace with embeddings once you pick a local embedding model / API.

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

If you want help adding a tiny example repo for ingestion, I can add an
`examples/` folder with a small folder and an invocation script.
