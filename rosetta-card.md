Boom — I built the ZIP scaffold for the **Rosetta Cards MCP server** and a bootstrap script that installs deps + Playwright Chromium.

**Download:** [rosetta-cards-mcp.zip](sandbox:/mnt/data/rosetta-cards-mcp.zip)

---

## What this implementation inputs and outputs

### Inputs (what you feed it)

Via MCP tool calls:

1. **`kb.add_document`**

```json
{
  "title": "Some title",
  "text": "Your markdown or plain text…",
  "tags": ["optional", "tags"],
  "source_url": "optional pointer"
}
```

2. **`kb.build_card`**

```json
{
  "doc_id": "doc_…",
  "chunk_id": 0,
  "style": "default",
  "include_qr": true
}
```

3. **`kb.search`**

```json
{ "query": "trace instrumentation", "top_k": 5 }
```

4. **`kb.get_card`**

```json
{ "card_id": "card_…" }
```

---

### Outputs (what it produces on disk)

When you add a document:

* `data/docs/<doc_id>.json`
  Contains: title, original text, tags, source_url, **chunks[]**.

When you build a card:

* `data/cards/<card_id>.json`
  A structured **CardPayload v1** with:

  * title
  * 3–7 bullets
  * tags
  * sources pointers
  * **hash** (sha256 of canonical JSON without hash)
  * created_at

* `data/cards/<card_id>.png`
  A 1200×675 infographic card, optionally with a QR code.

Search index:

* `data/index/cards_index.json`
  Simple lexical “cosine” index (works offline now; easy to swap to embeddings later).

**QR payload** (if enabled) is intentionally compact:

```json
{ "version": "card.v1", "card_id": "...", "hash": "...", "sources": [...] }
```

So the image is both human-readable and machine-decodable.

---

## How to use after you unzip

```bash
unzip rosetta-cards-mcp.zip
cd rosetta-cards-mcp
bash scripts/bootstrap.sh
npm run dev
```

Then connect your MCP client to run the tools (stdio server).

---

## What’s “stubbed” vs “real” in v0.1

* ✅ MCP server + file-backed storage + chunking

* ✅ Card rendering to PNG (Playwright)

* ✅ QR payload embedded in card

* ✅ Working search (lexical cosine; no internet, no API keys)

* 🔧 Summarizer is a **naive stub** right now (`src/kb/summarize.ts`)
  Next upgrade: plug in your local model (Ollama/llama.cpp/vLLM) or an API model.

* 🔧 Search can be upgraded to **real embeddings** (`src/kb/embed.ts`)
  Next upgrade: local embedding model for true semantic recall.

---

If you want the next step to be *maximally usable* fast: I’ll give you the drop-in upgrade that makes `summarize.ts` call a local Ollama model (or llama.cpp server), plus an embedding upgrade using a small local embed model — then your cards become genuinely “AI retrievable” instead of just keyword searchable.

