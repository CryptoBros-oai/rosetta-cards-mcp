# Rosetta Cards MCP -- User Guide

**Version 0.1.0**

This guide covers every feature, tool, terminal interface screen, and use case
in the Rosetta Cards MCP system. It is written for humans who want to understand
what the software does and how to use it, from first launch to advanced
operations.

---

## Table of Contents

1. [What Is Rosetta Cards MCP?](#1-what-is-rosetta-cards-mcp)
2. [Installation and First Run](#2-installation-and-first-run)
3. [Core Concepts](#3-core-concepts)
   - [Artifacts](#31-artifacts)
   - [Content Addressing](#32-content-addressing)
   - [The Vault](#33-the-vault)
   - [Knowledge Cards](#34-knowledge-cards)
   - [NFT Tiers](#35-nft-tiers)
4. [The Terminal Interface (TUI)](#4-the-terminal-interface-tui)
   - [Global Navigation](#41-global-navigation)
   - [Screen 1 -- Browse](#42-screen-1----browse)
   - [Screen 2 -- Build Card](#43-screen-2----build-card)
   - [Screen 3 -- Bundles](#44-screen-3----bundles)
   - [Screen 4 -- Pinsets and Behavior Packs](#45-screen-4----pinsets-and-behavior-packs)
   - [Screen 5 -- Corpus Import](#46-screen-5----corpus-import)
5. [MCP Tools Reference](#5-mcp-tools-reference)
   - [vault.* -- Artifact Vault](#51-vault----artifact-vault)
   - [kb.* -- Knowledge Base](#52-kb----knowledge-base)
   - [memory.* -- Session Memory](#53-memory----session-memory)
   - [vm.* -- Virtual Machine](#54-vm----virtual-machine)
   - [execution.* -- Pipeline Traversal](#55-execution----pipeline-traversal)
   - [artifact.* -- Lifecycle Management](#56-artifact----lifecycle-management)
   - [corpus.* -- Corpus Import](#57-corpus----corpus-import)
   - [promotion.* -- Knowledge Promotion](#58-promotion----knowledge-promotion)
6. [Search: Lexical, Semantic, and Hybrid](#6-search-lexical-semantic-and-hybrid)
7. [Embedding Setup](#7-embedding-setup)
8. [Progressive Memory](#8-progressive-memory)
9. [The Deterministic VM](#9-the-deterministic-vm)
10. [Corpus Import Workflows](#10-corpus-import-workflows)
11. [Artifact Blessing and Promotion](#11-artifact-blessing-and-promotion)
12. [Bundles, Pinsets, and Behavior Packs](#12-bundles-pinsets-and-behavior-packs)
13. [Storage Management](#13-storage-management)
14. [Claude Code Integration](#14-claude-code-integration)
15. [Environment Variables](#15-environment-variables)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. What Is Rosetta Cards MCP?

Rosetta Cards MCP is a knowledge management system built as a Model Context
Protocol (MCP) server. It turns text, documents, and operational data into
structured, versioned, content-addressed **artifacts** that can be searched,
bundled, and shared.

It works in two ways:

- **As an MCP server** -- an AI assistant (Claude, or any MCP-compatible client)
  calls its tools to store, search, and manage knowledge.
- **As a terminal application (TUI)** -- a human opens the interactive interface
  to browse cards, import documents, create bundles, and manage behavior packs.

Every artifact the system creates is assigned a SHA-256 identity hash computed
from its content. If two artifacts have identical content, they get the same
hash, which means there are never duplicates. Timestamps and provenance metadata
are excluded from the hash, so the same knowledge always produces the same ID
regardless of when or where it was created.

---

## 2. Installation and First Run

### Requirements

- **Node.js 20** or newer (the system uses ESM modules and modern APIs)
- **npm** (ships with Node.js)

### Install

```bash
git clone <repository-url> rosetta-cards-mcp
cd rosetta-cards-mcp
npm ci
```

### Verify everything works

```bash
npm test          # run the test suite
npm run build     # compile TypeScript
npm run smoke     # run the smoke test (deterministic hash validation)
```

### Start the TUI (terminal interface)

```bash
npm run tui
```

### Start the MCP server (for AI assistant use)

```bash
npm run dev       # development mode (ts-node, no build step)
npm run start     # production mode (requires npm run build first)
```

The MCP server communicates over stdio. Connect your MCP client to it.

---

## 3. Core Concepts

### 3.1 Artifacts

An **artifact** is any piece of knowledge the system stores. Every artifact has:

| Field        | Description                                               |
| ------------ | --------------------------------------------------------- |
| `id`         | SHA-256 hash of the artifact's structural content         |
| `version`    | Schema version (currently `artifact_v1`)                  |
| `kind`       | One of: fact, event, decision, skill, profile, tool_obs, summary, project |
| `payload`    | The actual content (arbitrary JSON object)                |
| `tags`       | Labels that are part of the artifact's identity           |
| `refs`       | References to other artifacts (`[{kind, id}]`)            |
| `created_at` | When the artifact was first stored (not part of the hash) |
| `source`     | Provenance info: agent, tool, repo (not part of the hash) |

**Artifact kinds explained:**

- **fact** -- A factual claim. Example: "The boiling point of water is 100C."
- **event** -- Something that happened at a point in time. Example: "Deployment to production at 3pm."
- **decision** -- A choice that was made. Example: "We chose PostgreSQL over MySQL."
- **skill** -- A procedure or capability. Example: "How to deploy a Docker container."
- **profile** -- A description of an entity. Example: "Alice -- backend engineer, Python specialist."
- **tool_obs** -- An observation from a tool. Example: "CPU usage hit 95% at 14:32."
- **summary** -- A condensed view of other artifacts. Example: weekly summary.
- **project** -- Project-level metadata. Example: "Project Alpha -- Q3 2026 roadmap."

### 3.2 Content Addressing

Every artifact gets its identity from a SHA-256 hash of its structural content.
The hash is computed from these fields only:

- `version` (always "artifact_v1")
- `kind`
- `payload`
- `tags` (sorted alphabetically)
- `refs`

These fields are **excluded** from the hash:

- `created_at` and `last_seen_at` (timestamps)
- `source` (provenance -- who/what created it)

This means:

- Storing the same content twice returns the same ID (deduplication).
- You can re-store an artifact from a different machine and get the same hash.
- Timestamps update on re-put, but the identity stays the same.

**Prohibited payload keys:** To prevent accidental non-determinism, the system
rejects payloads containing keys like `created_at`, `timestamp`, `hostname`,
`pid`, `cwd`, `env`, or prototype pollution vectors (`__proto__`, `constructor`).

### 3.3 The Vault

The vault is the storage layer. It stores artifacts in two places simultaneously:

1. **Blob files on disk** -- each artifact is saved as a JSON file at
   `.vault/blobs/<first-2-chars>/<next-2-chars>/<full-hash>.json`. This sharded
   directory structure keeps any single folder from getting too large.

2. **SQLite index** -- a database at `.vault/index.sqlite` provides full-text
   search (FTS5) over artifact content. It also stores metadata for fast
   filtering by kind, tags, and timestamps.

3. **Embeddings database** (optional) -- at `.vault/embeddings.sqlite`, stores
   vector embeddings for semantic search. Requires a running embedding endpoint.

The vault root defaults to `.vault/` in the project directory. Override it with
the `ARTIFACT_VAULT_ROOT` environment variable.

### 3.4 Knowledge Cards

A knowledge card is a visual representation of a knowledge artifact. It consists of:

- `card.json` -- structured data with title, bullet points, tags, diagram, and sources
- `card.png` -- a 1200x675 infographic image, optionally with a QR code

Cards are built from documents. When you add a document to the system, it gets
chunked into paragraphs. You can then build a card from any chunk, producing
both the JSON and the rendered PNG.

### 3.5 NFT Tiers

The system supports three access tiers, designed for integration with
ThreadForge's NFT-based access model. When running locally, the default tier is
**Gold** (unrestricted).

| Tier     | Artifact Cap | Allowed Kinds             | Tool Access                                    |
| -------- | ------------ | ------------------------- | ---------------------------------------------- |
| **Bronze** | 1,000      | fact, event, tool_obs     | Vault, memory, basic KB                        |
| **Silver** | 10,000     | All kinds                 | Bronze + promotion, blessing, corpus, execution, storage |
| **Gold**   | Unlimited  | All kinds                 | Everything (all tools, no restrictions)         |

Set the tier via the `THREADFORGE_TIER` environment variable. If unset, defaults
to `gold`.

---

## 4. The Terminal Interface (TUI)

The TUI is a full-screen terminal application built with neo-blessed. Launch it
with:

```bash
npm run tui
```

### 4.1 Global Navigation

The TUI has five screens. Switch between them at any time using the number keys:

| Key  | Screen           | Purpose                                   |
| ---- | ---------------- | ----------------------------------------- |
| `1`  | Browse           | Search and inspect cards                  |
| `2`  | Build Card       | Create new knowledge cards                |
| `3`  | Bundles          | Export and import card bundles             |
| `4`  | Pinsets           | Manage card collections and behavior packs |
| `5`  | Corpus Import    | Import documents from various sources     |
| `q`  | Quit             | Exit the application                      |

The active tab is highlighted in cyan in the top tab bar. You can also press
`Ctrl+C` to quit. The key `i` is an alias for `5` (Corpus Import).

**Common controls across all screens:**

- Arrow keys or `j`/`k` (vim-style) to navigate lists
- `Enter` to select or confirm
- `Escape` to cancel a dialog
- `Space` to toggle selection (where applicable)

---

### 4.2 Screen 1 -- Browse

**What it does:** Search your knowledge cards, view their details, and verify
their content hashes.

**Layout:**

```
+--[ Search: __________________ ]--+
|                                   |
|  Results List    |  Card Details  |
|  (left half)     |  (right half)  |
|                  |                |
|  > Card A  0.95  |  card_id: ... |
|    Card B  0.82  |  hash: ...    |
|    Card C  0.71  |  bullets: ... |
|                  |  tags: ...    |
+-----------------------------------+
| [/] Search  [p] PNG  [h] Hash     |
+-----------------------------------+
```

**How to use it:**

1. Press `/` to focus the search box.
2. Type a query and press `Enter`. Results appear ranked by relevance.
3. Use arrow keys to highlight a result. The details pane updates automatically.
4. Press `Enter` on a result to load its full details.

**Keybindings:**

| Key   | Action                                  |
| ----- | --------------------------------------- |
| `/`   | Focus the search input box              |
| `Enter` | Show full details for selected card   |
| `p`   | Open the PNG image for the selected card |
| `h`   | Verify the card's hash integrity        |
| `r`   | Refresh -- reload all cards             |

**Hash verification:** When you press `h`, the system recomputes the card's
hash from its content and compares it to the stored hash. You will see:

- A green checkmark if the hash matches (integrity confirmed).
- A red X if the hash does not match, along with the expected vs. computed
  values and possible causes (manual editing, serialization changes, file
  corruption, or incompatible imports).

**Details shown for each card:**

- Card ID, hash (first 16 characters)
- Creation timestamp
- Bullet points (the card's main content)
- Tags (up to 3 shown in the list, all shown in details)
- Source URLs
- A green dot indicates pinned cards (cards that belong to the active behavior pack)

---

### 4.3 Screen 2 -- Build Card

**What it does:** Create a new knowledge card from scratch by entering a title,
tags, and text content. Also supports bulk folder import.

**Layout:**

```
+--[ Step 1 of 3 ]--+
|                    |
| Title: [________]  |
| Tags:  [________]  |
| Text:              |
| [                ] |
| [                ] |
|                    |
+--------------------+
| [Tab] Next  [Ctrl+S] Build  [f] Folder Import |
+--------------------+
```

**How to use it:**

1. Enter a title in the first field.
2. Press `Tab` to move to the tags field. Enter comma-separated tags.
3. Press `Tab` to move to the text area. Type or paste your content.
4. Press `Ctrl+S` to build the card.
5. On success, you see the new card ID and can press `p` to view the PNG or
   `n` to start a new card.

**Keybindings:**

| Key      | Action                                   |
| -------- | ---------------------------------------- |
| `Tab`    | Move to the next input field             |
| `Ctrl+S` | Build the card from current fields      |
| `f`      | Open folder import dialog                |
| `p`      | View PNG of the last built card          |
| `n`      | Reset form for a new card                |

**Folder import:** Press `f` to import an entire folder of documents. A dialog
asks for the folder path. The system processes `.docx` and `.pdf` files,
extracts their text, stores the file blobs, and reports how many files were
processed, how many had text extracted, and how many failed.

---

### 4.4 Screen 3 -- Bundles

**What it does:** Export your cards into portable bundles and import bundles from
other sources. A bundle is a self-contained package of cards with an integrity
hash.

**Layout:**

```
+--[ Bundles ]--+
|                                   |
|  Bundle List     | Bundle Details |
|  (left half)     | (right half)   |
|                  |                |
|  > abc123...  5  | ID: abc123... |
|    def456...  12 | Version: 1    |
|                  | Cards: 5      |
|                  | Hash: e7f...  |
+-----------------------------------+
| [e] Export  [i] Import  [r] Refresh |
+-----------------------------------+
```

**How to use it:**

- Press `e` to export all current cards into a new bundle. The system collects
  cards, includes PNGs, computes an integrity hash, and saves the bundle.
- Press `i` to import a bundle from a file path. A dialog asks for the path.
  After import, you see counts of imported, skipped (duplicate), and failed cards,
  plus the integrity check result.
- Press `r` to refresh the bundle list.

**Keybindings:**

| Key | Action                                     |
| --- | ------------------------------------------ |
| `e` | Export all cards to a new bundle            |
| `i` | Import a bundle from a file path           |
| `r` | Refresh the bundle list                    |

**Details shown for each bundle:**

- Bundle ID (first 20 characters)
- Version number
- Number of cards
- Creation timestamp
- Integrity hash (first 16 characters)
- Description, license (SPDX), and author (if present)

**Integrity verification:** The integrity hash is computed from the sorted list
of `card_id:hash` pairs in the bundle. Provenance metadata and timestamps do not
affect it. When you import a bundle, the system verifies this hash and shows a
green checkmark or red X.

---

### 4.5 Screen 4 -- Pinsets and Behavior Packs

**What it does:** Organize cards into named collections (pinsets) and promote
them to behavior packs that control search ranking and export scope.

**Layout:**

```
+--[ Pinsets & Packs ]--+
|                                       |
|  [PACK] My Analysis Pack  ACTIVE |  Name: My Analysis Pack |
|  [PIN]  Research Notes           |  Pack ID: pack_...      |
|  [PIN]  Meeting Cards            |  Version: 1             |
|                                  |  Policies:              |
|                                  |    search_boost: 500    |
|                                  |    allowed_tags: [...]   |
|                                  |  Pins: 5 cards          |
+-----------------------------------------+
| [c] Create  [a] Activate  [b] Pack  [e] Export  [d] Delete |
+-----------------------------------------+
```

**Understanding pinsets vs. behavior packs:**

- A **pinset** is a simple list of card IDs with a name. Think of it as a
  bookmark folder. It has no policies and does not affect search.
- A **behavior pack** is a promoted pinset that includes policies. An active
  pack boosts its pinned cards in search results (+500 points), controls which
  tags are allowed or blocked, and defines the export scope.

**How to use it:**

1. Press `c` to create a new pinset. Enter a name, then select cards from a
   multi-select list (press `Space` to toggle, `Enter` to confirm).
2. Select a pinset and press `b` to promote it to a behavior pack.
3. Press `a` to activate or deactivate the selected item. Only one pack can be
   active at a time. The active pack is marked with a green "ACTIVE" label.
4. Press `e` to export the active pack. A preview shows the export plan
   (scope, card count, blob count, estimated size). Press `Enter` to proceed
   or `Escape` to cancel.
5. Press `d` to delete a pinset or pack (with confirmation).

**Keybindings:**

| Key | Action                                           |
| --- | ------------------------------------------------ |
| `c` | Create a new pinset                              |
| `a` | Activate/deactivate the selected item            |
| `b` | Promote a pinset to a behavior pack              |
| `e` | Export the active pack (with preview)             |
| `d` | Delete the selected item (with confirmation)     |
| `r` | Refresh the list                                 |

**Pack policies (set during promotion):**

- `search_boost` -- extra points for pinned cards in search results
- `max_results` -- limit on search result count
- `allowed_tags` -- only cards with these tags are searchable
- `blocked_tags` -- cards with these tags are excluded
- `style` -- visual style for rendered PNGs
- `default_export_scope` -- `"pack_only"` (default) or `"all"`

---

### 4.6 Screen 5 -- Corpus Import

**What it does:** Import documents from four different sources, build cards from
them, and optionally export a knowledge graph.

**Layout:**

```
+--[ Corpus Import ]--+
|                                   |
|  Mode Selector   | Details       |
|  (left 35%)      | (right 65%)   |
|                  |               |
|  > Local Folder  | Status: idle  |
|    GitHub Repo   |               |
|    arXiv Query   |               |
|    Synthetic     |               |
+-----------------------------------+
| [Enter/i] Import  [b] Build  [g] Graph  [o] Browse |
+-----------------------------------+
```

**Four import modes:**

#### Local Folder

Import markdown and text files from a directory on your machine.

1. Select "Local Folder" and press `Enter`.
2. Enter the folder path when prompted.
3. Choose file extensions (default: `.md,.txt`).
4. Choose whether to recurse into subdirectories (default: yes).
5. Enter tags and a source label.
6. The system reads each file, extracts text, and stores it as a vault artifact.

#### GitHub Repo

Import documents from a public GitHub repository.

1. Select "GitHub Repo" and press `Enter`.
2. Enter the repository URL (e.g., `https://github.com/user/repo`).
3. Optionally specify a branch, path filters, and max file count (default: 100).
4. Enter tags and a source label.
5. The system clones or fetches the repo and imports matching files.

#### arXiv Query

Import paper titles and abstracts from arXiv.

1. Select "arXiv Query" and press `Enter`.
2. Enter a search query (e.g., `"transformer attention mechanisms"`).
3. Set max results (default: 25) and whether to import abstracts only (default: yes).
4. Enter tags and a source label.
5. The system fetches matching papers from the arXiv API.

#### Synthetic Corpus

Generate synthetic test documents for development and testing.

1. Select "Synthetic" and press `Enter`.
2. Enter a theme (default: "artifact vault workflows").
3. Set document count (default: 12) and pipeline count (default: 3).
4. Enter tags.
5. The system generates synthetic documents, execution records, and events.

**Post-import actions (available after any import):**

| Key | Action                                        |
| --- | --------------------------------------------- |
| `b` | Build cards from the last imported documents  |
| `g` | Export a knowledge graph from the import       |
| `o` | Browse the imported documents                  |

**Quick-select keys:** Press `1`-`4` to jump directly to a mode without
navigating the list.

---

## 5. MCP Tools Reference

These tools are available when the system is running as an MCP server. An AI
assistant (or any MCP client) calls them by name with JSON arguments.

### 5.1 vault.* -- Artifact Vault

#### vault.put

Store a content-addressed artifact in the vault.

```
Arguments:
  kind     (required)  "fact" | "event" | "decision" | "skill" | "profile" |
                       "tool_obs" | "summary" | "project"
  payload  (required)  JSON object -- the artifact's content
  tags     (optional)  string array -- structural labels (affect the hash)
  refs     (optional)  array of {kind, id} -- references to other artifacts
  source   (optional)  {agent?, tool?, repo?, run_id?} -- provenance (not hashed)

Returns: {id, created, created_at, last_seen_at}
```

If an artifact with the same content already exists, `created` is `false` and
the existing ID is returned. The `last_seen_at` timestamp is updated.

#### vault.get

Retrieve an artifact by its SHA-256 ID.

```
Arguments:
  id  (required)  SHA-256 hex string

Returns: The full artifact envelope, or {error: "NOT_FOUND"}
```

#### vault.search

Search artifacts with full-text, semantic, or hybrid scoring.

```
Arguments:
  query             (optional)  search text
  kind              (optional)  filter by artifact kind
  tags              (optional)  string array -- all must match (AND logic)
  exclude_personal  (optional)  filter out "personal:*" tagged artifacts
  limit             (optional)  default 10
  offset            (optional)  default 0
  search_mode       (optional)  "hybrid" (default) | "semantic" | "lexical"

Returns: {total, offset, limit, search_mode, results: [{id, kind, score, tags, created_at, snippet}]}
```

#### vault.reindex_embeddings

Compute embeddings for all artifacts that are missing them.

```
Arguments:
  batch_size  (optional)  default 32

Returns: {embedded, total, model, dim} or {error: "ENDPOINT_UNAVAILABLE"}
```

---

### 5.2 kb.* -- Knowledge Base

#### kb.add_document

Add a text document to the knowledge base. The document is chunked by paragraphs.

```
Arguments:
  title       (required)  document title
  text        (required)  document body text
  tags        (optional)  string array
  source_url  (optional)  origin URL

Returns: Document metadata with chunk IDs and storage paths
```

#### kb.build_card

Generate a visual card (JSON + PNG) from a document or chunk.

```
Arguments:
  doc_id      (required)  document ID
  chunk_id    (optional)  specific chunk number
  style       (optional)  "default" | "dark" | "light"
  include_qr  (optional)  embed a QR code in the PNG

Returns: Card JSON, PNG path, QR code data
```

#### kb.search

Search cards in the knowledge base by lexical cosine similarity.

```
Arguments:
  query  (required)  search text
  top_k  (optional)  number of results

Returns: Matching cards with scores and metadata
```

#### kb.get_card

Fetch a card by its ID.

```
Arguments:
  card_id  (required)

Returns: Complete card object and PNG file path
```

#### kb.create_event

Create a deterministic event card (temporal memory atom).

```
Arguments:
  title, summary                          (required)
  event.kind                              "deployment" | "incident" | "decision" |
                                          "meeting" | "build" | "research" | "ops" |
                                          "personal" | "other"
  event.status                            "observed" | "confirmed" | "resolved" | "superseded"
  event.severity                          "info" | "low" | "medium" | "high" | "critical"
  event.confidence                        number (0-1)
  event.participants, event.refs          arrays
  tags                                    string array
  rosetta.verb                            "Attract" | "Contain" | "Release" | "Repel" | "Transform"
  rosetta.polarity                        "+" | "0" | "-"
  rosetta.weights                         {A, C, L, P, T} -- numbers

Returns: Event card with deterministic SHA-256 hash (timestamps excluded)
```

#### kb.create_execution

Create a deterministic execution artifact (operational evidence).

```
Arguments:
  title, summary                          (required)
  execution.kind                          "job" | "tool_call" | "model_call" | "pipeline" |
                                          "validation" | "import" | "export" | "other"
  execution.status                        "requested" | "running" | "succeeded" | "failed" |
                                          "partial" | "validated" | "rejected"
  execution.actor                         {type: "human"|"agent"|"system"|"node", id, label?}
  execution.target                        {type: "artifact"|"tool"|"model"|"node"|"external", id, label?}
  execution.inputs, execution.outputs     arrays
  execution.validation                    {state, method}
  execution.parent_execution_id           (optional) chain to parent
  execution.pipeline_id                   (optional) group into pipeline
  execution.step_index                    (optional) order within pipeline

Returns: Execution card with deterministic hash
```

#### kb.get_meta / kb.merge_meta

Read or update sidecar metadata for an artifact.

```
kb.get_meta arguments:
  artifact_hash  (required)
  artifact_type  (required)  "card" | "event" | "execution"

kb.merge_meta arguments:
  artifact_hash  (required)
  artifact_type  (required)
  patch          (required)  JSON object to merge

Returns: MetaV1 sidecar object
```

#### kb.create_weekly_summary

Create a deterministic weekly summary referencing events and cards.

```
Arguments:
  week_start   (required)  YYYY-MM-DD (normalized to Monday)
  references   (required)  {events: [], cards: []}
  highlights, decisions, open_loops, risks  (arrays)
  rosetta_balance  (optional)

Returns: Summary artifact with deterministic hash
```

#### kb.rebuild_index / kb.index_status

Rebuild or check the status of the artifact index.

```
kb.rebuild_index: Scans all on-disk artifacts, rebuilds the index snapshot.
  Returns: {counts, snapshot_path, built_at}

kb.index_status: Returns current index snapshot or {status: 'none'}.
```

#### kb.render_card_png / kb.render_weekly_summary_png

Render PNG images for cards or weekly summaries.

```
kb.render_card_png arguments:
  hash        (required)  SHA-256 hex
  style       (optional)  rendering style
  include_qr  (optional)

kb.render_weekly_summary_png arguments:
  hash  (required)  SHA-256 hex

Returns: {path: PNG file path}
```

#### kb.storage_report / kb.storage_plan / kb.storage_apply / kb.storage_restore

Manage vault disk usage with tiered storage policies.

```
kb.storage_report: Report disk usage with optional budget thresholds.
kb.storage_plan:   Dry-run compute storage cleanup actions.
kb.storage_apply:  Execute the storage plan (prune PNGs, archive cold docs, vacuum).
kb.storage_restore: Restore cold-archived artifacts by tier and hash.
```

---

### 5.3 memory.* -- Session Memory

These tools manage conversation memory with progressive summarization.

#### memory.session_start

Start a new memory session. Ends any existing active session.

```
Returns: {session_id, active: true, turn_count: 0, created_at}
```

#### memory.session_end

End the current memory session.

```
Returns: Final session state or {message: "No active session."}
```

#### memory.ingest_turn

Store a conversation turn as a vault artifact.

```
Arguments:
  role         (required)  "user" | "assistant" | "system"
  content      (required)  the turn text
  turn_number  (required)  sequential number

Returns: {id, session_id, turn_number}
```

#### memory.compact

Trigger progressive compaction: age verbatim turns into summaries, age summaries
into extracted facts.

```
Returns: {session_id, turn_count, band0_compact, band1_compact}
```

#### memory.get_context

Reconstruct a context string from memory artifacts within a token budget.

```
Arguments:
  token_budget  (optional)  default 2000

Returns: {session_id, context, approx_tokens}
```

---

### 5.4 vm.* -- Virtual Machine

These tools run deterministic programs against structured state.

#### vm.execute

Run an opcode program.

```
Arguments:
  program   (required)  {program_id, version, opcodes: [{opcode_id, verb, args}]}
  state     (required)  {bags: {}, stack: [], flags: {}, notes: []}
  env       (required)  {run_seed, world_seed, max_steps}
  options   (optional)  {fullTrace, expectedBagTotal, maxStackDepth, softHalt, persist, tags}

Returns: {state, trace, metrics}
```

#### vm.list_opcodes

List all registered opcodes, optionally filtered by verb family.

```
Arguments:
  verb  (optional)  "Attract" | "Contain" | "Release" | "Repel" | "Transform"

Returns: Array of opcode specifications
```

#### vm.validate_program

Check a program for correctness without running it.

```
Arguments:
  program  (required)

Returns: {valid, errors: []}
```

#### vm.compare

Compare two VM execution results.

```
Arguments:
  a, b          (required)  VmResult objects
  align         (optional)  "step" | "opcode_signature" | "milestone"
  milestones    (optional)  array of opcode_ids for milestone alignment

Returns: Structured diff with scalar, verb, bag, and opcode deltas
```

#### vm.phase_scan

Run a parameter sweep and detect phase transitions.

```
Arguments:
  program     (required)
  state0      (required)  initial state
  base_env    (required)
  knobs       (required)  [{key, values: []}] -- parameters to sweep
  scan_mode   (optional)  "grid" | "adaptive" | "hunt_boundaries"
  include_trace (optional)

Returns: Scan report with grid points, phase hints, metrics
```

#### vm.list_runs / vm.search_runs

Browse and search persisted VM runs.

```
vm.list_runs: List all persisted run metadata.

vm.search_runs arguments:
  program_fingerprint, program_id       (optional filters)
  run_seed_min/max, world_seed_min/max  (optional ranges)
  total_steps_min/max                   (optional range)
  halted_early                          (optional boolean)
  tags                                  (optional, AND logic)
  limit, offset                         (pagination)

Returns: Array of run metadata
```

#### vm.search_scans / vm.get_scan / vm.top_scans / vm.top_transitions / vm.top_novel_scans

Browse, rank, and analyze phase scans.

```
vm.search_scans:       Search scans by program, hint counts, grid size.
vm.get_scan:           Get a scan by ID (full or 12-char prefix).
vm.top_scans:          Get scans ranked by interestingness score.
vm.top_transitions:    Get individual phase transitions ranked by interestingness.
vm.top_novel_scans:    Get scans ranked by novelty (cosine distance from others).
```

---

### 5.5 execution.* -- Pipeline Traversal

These tools navigate execution chains and pipelines.

#### execution.get_pipeline

Get all execution artifacts in a pipeline, ordered by step index.

```
Arguments:
  pipeline_id  (required)
```

#### execution.walk_parents

Walk the parent chain from an execution back to the root.

```
Arguments:
  hash  (required)  execution artifact hash
```

#### execution.get_children / execution.get_siblings

Get child or sibling execution artifacts.

```
Arguments:
  hash  (required)
```

#### execution.check_integrity

Check chain integrity across execution artifacts. Detects missing parents,
cycles, duplicate step indices, and pipeline contamination.

```
Arguments:
  pipeline_id  (optional)  check only this pipeline

Returns: {valid, issues: [], summary}
```

#### execution.get_pipeline_view

Get complete pipeline view with ordered steps and integrity issues.

```
Arguments:
  pipeline_id  (required)
```

#### execution.list_pipelines

List all distinct pipeline IDs.

#### execution.build_evidence_bundle

Build a structured evidence bundle from a pipeline's execution graph.

```
Arguments:
  pipeline_id  (required)

Returns: Evidence bundle with artifact, metadata, and verification proofs
```

---

### 5.6 artifact.* -- Lifecycle Management

#### artifact.bless

Promote an artifact to "blessed" status with supporting evidence.

```
Arguments:
  target_hash         (required)  the artifact to bless
  evidence_refs       (required)  at least one: [{ref_type, value, label?}]
  reason              (required)  why this artifact is being blessed
  integrity_summary   (optional)  pipeline integrity context
  override_integrity  (optional)  override integrity check failures
  tags                (optional)

Returns: {blessed: true, hash, evidence_chain}
```

Evidence ref types: `execution_hash`, `artifact_hash`, `pipeline_id`, `external_id`, `url`.

#### artifact.deprecate

Mark an artifact as deprecated with a reason.

```
Arguments:
  target_hash    (required)
  reason         (required)
  evidence_refs  (optional)
  tags           (optional)

Returns: {deprecated: true, hash, metadata}
```

#### artifact.supersede

Replace one artifact with another, creating an explicit old-to-new link.

```
Arguments:
  old_hash       (required)
  new_hash       (required)
  reason         (required)
  evidence_refs  (optional)
  tags           (optional)

Returns: {superseded: true, old_hash, new_hash, linkage}
```

#### artifact.collect_evidence

Gather evidence refs from pipelines and artifacts for use in blessing.

```
Arguments:
  pipeline_id       (optional)
  artifact_hashes   (optional)  string array
  execution_hashes  (optional)  string array

Returns: Array of evidence refs ready for blessing
```

---

### 5.7 corpus.* -- Corpus Import

#### corpus.import_local

Import a local folder of documents.

```
Arguments:
  root_path           (required)
  include_extensions  (optional)  default [".md", ".txt"]
  recursive           (optional)  default true
  tags                (optional)
  source_label        (optional)
  build_cards         (optional)  also build cards from imported docs
  export_graph        (optional)  also export a knowledge graph
  promote_facts/skills/summary  (optional)  also run promotion pipeline

Returns: {imported_count, doc_ids, card_ids, execution_ids, graph_path, promotion, errors}
```

#### corpus.import_github

Import from a public GitHub repository.

```
Arguments:
  repo_url            (required)
  branch              (optional)
  path_filter         (optional)  string array
  include_extensions  (optional)
  max_files           (optional)  default 100
  tags, source_label  (optional)
  build_cards, export_graph, promote_*  (optional)

Returns: Similar to import_local with source_summary
```

#### corpus.import_arxiv

Import paper titles and abstracts from arXiv.

```
Arguments:
  query                  (required)
  max_results            (optional)  default 25
  include_abstract_only  (optional)  default true
  tags, source_label     (optional)
  build_cards, export_graph, promote_*  (optional)
```

#### corpus.import_synthetic

Generate a synthetic test corpus.

```
Arguments:
  theme           (optional)  default "artifact vault workflows"
  doc_count       (optional)  default 12
  pipeline_count  (optional)  default 3
  tags            (optional)
  build_cards, export_graph, promote_*  (optional)
```

---

### 5.8 promotion.* -- Knowledge Promotion

#### promotion.promote_facts

Extract and promote factual claims from imported documents.

```
Arguments:
  doc_ids       (required)  string array of document IDs
  tags          (optional)
  source_label  (optional)

Returns: Array of promoted fact artifacts
```

#### promotion.promote_skills

Extract and promote skill descriptions from execution evidence.

```
Arguments:
  execution_ids  (optional)
  pipeline_id    (optional)
  tags           (optional)
```

#### promotion.promote_summary

Create a summary artifact spanning documents, executions, facts, and skills.

```
Arguments:
  doc_ids, execution_ids, fact_ids, skill_ids  (at least one required)
  label  (optional)
  tags   (optional)
```

#### promotion.build_bundle

Build a promotion bundle from corpus references and generated promotions.

```
Arguments:
  doc_ids, execution_ids  (optional)
  include_facts, include_skills, include_summary  (optional, default true)
  label, tags  (optional)
```

---

## 6. Search: Lexical, Semantic, and Hybrid

The vault supports three search modes. You choose one with the `search_mode`
parameter in `vault.search`.

### Lexical (FTS5)

The default fallback. Uses SQLite's FTS5 full-text search engine.

- Tokenizes your query into words.
- Matches against artifact payloads, tags, and kinds.
- Ranks by FTS5 relevance score.
- Works without any external services.

**Best for:** exact keyword lookups, known terms.

### Semantic (Embeddings)

Uses vector embeddings to find artifacts by meaning rather than exact words.

- Your query is embedded into a vector using a local embedding model.
- All candidate artifacts are compared by cosine similarity.
- Results are ranked by how semantically close they are to your query.
- Requires a running embedding endpoint.

**Best for:** fuzzy queries, concept-based search, questions.

### Hybrid (FTS + Embeddings)

The default mode. Combines both approaches.

- First, a pool of FTS candidates is retrieved (5x the limit or at least 50).
- Each candidate is scored by cosine similarity against the query embedding.
- Final score = 60% FTS score (normalized) + 40% cosine similarity.
- Results are ranked by the combined score.

**Best for:** general-purpose search that balances keyword precision with
semantic understanding.

**Fallback behavior:** If the embedding endpoint is unavailable, hybrid and
semantic modes automatically fall back to lexical search. You never get an error
from a missing embedding server -- you just get keyword-only results.

---

## 7. Embedding Setup

Embedding search requires a local server that implements the OpenAI
`/v1/embeddings` API format. Three options:

### LM Studio

1. Download LM Studio from https://lmstudio.ai
2. Load an embedding model (e.g., `nomic-embed-text-v1.5`).
3. Start the local server (default port: 1234).
4. The system connects to `http://localhost:1234/v1/embeddings` by default.

### Ollama

1. Install Ollama.
2. Pull an embedding model: `ollama pull nomic-embed-text`
3. Run `ollama serve`.
4. Set `EMBEDDING_ENDPOINT=http://localhost:11434/v1/embeddings`.

### text-embeddings-inference (HuggingFace)

1. Run the container with your model of choice.
2. Set `EMBEDDING_ENDPOINT` to the container's URL.

### Backfilling embeddings

After starting your embedding server, run this to compute vectors for all
existing artifacts:

```
vault.reindex_embeddings
```

This processes artifacts in batches (default batch size: 32) and reports how many
were embedded, the total count, and the model/dimension info.

New artifacts get embedded automatically when stored via `vault.put`. Embedding
is fire-and-forget -- it never blocks or fails the put operation.

---

## 8. Progressive Memory

The memory system provides session-based conversation memory with progressive
summarization. It keeps recent turns verbatim, compresses older turns into
summaries, and distills the oldest summaries into extracted facts.

### The three bands

| Band | Age           | Content   | How it is created                        |
| ---- | ------------- | --------- | ---------------------------------------- |
| 0    | Last 5 turns  | Verbatim  | Stored directly by `memory.ingest_turn`  |
| 1    | Turns 6-20    | Summaries | Created by `memory.compact` from Band 0  |
| 2    | Turns 20+     | Facts     | Created by `memory.compact` from Band 1  |

### Typical session workflow

1. **Start a session:** Call `memory.session_start`. This creates a session ID
   and prepares for turn tracking.

2. **Ingest turns:** After each conversation turn, call `memory.ingest_turn`
   with the role, content, and turn number. Each turn is stored as a vault
   artifact with `memory:*` tags.

3. **Compact periodically:** Call `memory.compact` to age older turns out of
   Band 0 into Band 1 (summaries), and older summaries from Band 1 into Band 2
   (facts). The compact operation is idempotent -- calling it multiple times
   only processes turns that have actually aged.

4. **Get context:** Call `memory.get_context` with a token budget. The system
   assembles a context string by loading the most recent verbatim turns first
   (Band 0), then summaries (Band 1), then facts (Band 2), stopping when the
   budget is filled.

5. **End the session:** Call `memory.session_end`. The session is marked
   inactive. All artifacts remain in the vault for future reference.

### How context reconstruction works

When you call `memory.get_context` with a budget of 2000 tokens (approximately
8000 characters):

1. Band 0 turns are formatted as:
   ```
   [Turn 3] user: What is the weather today?
   [Turn 4] assistant: The weather is sunny and 72F.
   ```

2. Band 1 summaries are formatted as:
   ```
   [Summary turns 0-2]: User discussed project setup and asked about dependencies...
   ```

3. Band 2 facts are formatted as:
   ```
   [Extracted facts]:
   - Project uses TypeScript with ESM modules
   - Database is SQLite with FTS5
   ```

Content is added in priority order until the budget is reached. Recent verbatim
turns always take priority over older summaries and facts.

---

## 9. The Deterministic VM

The VM executes structured programs against a state machine with deterministic
results. Given the same program, state, and environment, you always get the same
output.

### State structure

```
{
  bags:  { "energy": 100, "momentum": 50 }     -- named numeric containers
  stack: []                                      -- execution stack
  flags: { "threshold_met": true }               -- boolean flags
  notes: ["Step completed"]                      -- annotation strings
}
```

### Environment

```
{
  run_seed:    42        -- seed for deterministic randomness
  world_seed:  7         -- world configuration seed
  max_steps:   10000     -- step limit before halt
  params:      {}        -- additional parameters (used by knobs in scans)
}
```

### Opcodes

Programs are sequences of opcodes. Each opcode belongs to one of five verb
families inspired by the Rosetta framework:

**Attract** -- gather, collect, add:
- `attract.add` -- add a value to a bag
- `attract.collect` -- sum multiple bags into one
- `attract.select` -- randomly pick from candidates
- `attract.increment` -- add 1 to a bag

**Contain** -- constrain, limit, validate:
- `contain.threshold` -- set a flag when a bag reaches a threshold
- `contain.clamp` -- keep a bag within min/max bounds
- `contain.normalize` -- redistribute bags proportionally
- `contain.commit_to_stack` -- push a bag value onto the stack
- `contain.pop_from_stack` -- pop from stack into a bag

**Release** -- split, output, finalize:
- `release.split` -- divide a bag into N parts
- `release.finalize` -- scale and commit a final value
- `release.merge` -- combine multiple bags
- `release.conditional` -- branch based on a flag

**Repel** -- guard, reject, prevent:
- `repel.guard` -- halt if a bag is below a threshold
- `repel.negate` -- invert a boolean flag
- `repel.scatter` -- distribute a bag to random targets
- `repel.suppress` -- zero out a bag if a condition is met

**Transform** -- modify, convert, exchange:
- `transform.map` -- apply f(x) = a*x + b
- `transform.smooth` -- exponential moving average
- `transform.exchange` -- swap two bags

### Phase scanning

A phase scan sweeps over parameter ranges (knobs) and runs the program at every
combination. It detects **phase transitions** -- points where the system's
behavior changes qualitatively:

- **Zero crossing** -- a metric crosses zero
- **Sign change** -- a metric changes sign
- **Threshold crossing** -- a metric crosses a threshold
- **Regime transition** -- the halt behavior changes (e.g., from completing normally to hitting a precondition)

Three scan modes:

- **grid** -- execute every point in the Cartesian product of knob values
- **adaptive** -- start with a grid, then iteratively refine around detected transitions
- **hunt_boundaries** -- expand outward from detected boundaries, then bisect to narrow them down

### Running a VM program -- example

To execute a program that distributes energy across three bags:

```json
{
  "program": {
    "program_id": "energy-distribution",
    "version": "program.v1",
    "opcodes": [
      {"opcode_id": "attract.add", "verb": "Attract", "args": {"bag": "pool", "amount": 100}},
      {"opcode_id": "release.split", "verb": "Release", "args": {"source": "pool", "targets": "a,b,c", "n": 3}},
      {"opcode_id": "contain.threshold", "verb": "Contain", "args": {"bag": "a", "threshold": 30, "flag": "a_ready"}}
    ]
  },
  "state": {"bags": {}, "stack": [], "flags": {}, "notes": []},
  "env": {"run_seed": 42, "world_seed": 1, "max_steps": 100}
}
```

This produces a deterministic trace showing how state evolves at each step, plus
metrics summarizing opcode frequencies, bag variances, and the halt reason.

---

## 10. Corpus Import Workflows

Corpus import is a pipeline for ingesting external documents and optionally
processing them into promoted knowledge artifacts.

### Basic import: local folder

```
corpus.import_local({
  root_path: "/path/to/docs",
  include_extensions: [".md", ".txt"],
  recursive: true,
  tags: ["project-alpha"],
  source_label: "internal docs"
})
```

Result: documents are stored in the vault as artifacts. You get back an array of
`doc_ids` that reference the imported content.

### Full pipeline: import + cards + promotion

```
corpus.import_local({
  root_path: "/path/to/docs",
  tags: ["project-alpha"],
  build_cards: true,        // also build visual cards
  export_graph: true,       // also export a knowledge graph
  promote_facts: true,      // also extract and promote facts
  promote_skills: true,     // also extract skills from execution records
  promote_summary: true     // also create a summary spanning all imports
})
```

This runs the full pipeline:
1. Import documents into the vault.
2. Build visual cards (JSON + PNG) from each document.
3. Export a knowledge graph connecting cards and documents.
4. Extract factual claims and store them as `fact` artifacts.
5. Extract skills from any execution records and store them as `skill` artifacts.
6. Create a `summary` artifact spanning all imported content.

### CLI shortcuts

```bash
npm run corpus:local     # interactive local folder import
npm run corpus:github    # interactive GitHub import
npm run corpus:arxiv     # interactive arXiv import
npm run corpus:synthetic # generate synthetic test data
```

---

## 11. Artifact Blessing and Promotion

### What is blessing?

Blessing is the process of marking an artifact as verified and trustworthy.
A blessed artifact has been reviewed, tested, or otherwise validated with
supporting evidence.

### Blessing workflow

1. **Collect evidence:** Use `artifact.collect_evidence` to gather references
   from pipelines, execution hashes, and artifact hashes.

2. **Bless the artifact:** Use `artifact.bless` with the target artifact hash,
   evidence refs, and a reason. The system checks chain integrity and creates
   a `BlessingRecord` artifact.

3. **Optional lifecycle transitions:**
   - `artifact.deprecate` marks an artifact as outdated with a reason.
   - `artifact.supersede` replaces one artifact with another, creating an
     explicit linkage between old and new.

### What is promotion?

Promotion extracts higher-order knowledge from raw imports:

- **promote_facts** -- extracts factual claims from document snippets
- **promote_skills** -- extracts procedural knowledge from execution evidence
- **promote_summary** -- creates a summary spanning multiple sources
- **build_bundle** -- packages all promoted artifacts into a single bundle

Each promoted artifact is deterministically hashed and deduplicated, so
re-promoting the same source data produces the same artifacts.

---

## 12. Bundles, Pinsets, and Behavior Packs

### Bundles

A bundle is a portable package of cards. Use it to share knowledge between
vaults, back up your cards, or transfer data between machines.

**Export:** Collects cards (optionally filtered by pack scope), includes PNGs,
computes an integrity hash from all `card_id:hash` pairs, and writes a manifest.

**Import:** Reads the manifest, verifies the integrity hash, copies cards to the
vault (skipping duplicates), and reports results.

### Pinsets

A pinset is a named list of card IDs. Think of it as a bookmark folder or
playlist. It has no policies and does not affect system behavior.

Create one from the TUI (Screen 4, press `c`) or programmatically.

### Behavior Packs

A behavior pack is a pinset promoted with policies. It actively changes how the
system works:

- **Search boost:** Pinned cards get +500 points in search rankings, making them
  appear first.
- **Tag filtering:** `allowed_tags` and `blocked_tags` control which cards are
  visible in search.
- **Export scope:** `pack_only` exports just pinned cards; `all` exports everything.
- **Style:** Sets the visual style for rendered PNGs.

Only one pack can be active at a time. Activate it from the TUI (press `a`) or
programmatically.

---

## 13. Storage Management

The storage system organizes vault data into tiers with different retention
policies.

### Storage tiers

| Tier       | Policy       | Description                                    |
| ---------- | ------------ | ---------------------------------------------- |
| identity   | always_local | Hashed artifacts -- never pruned               |
| meta       | always_local | Sidecar metadata -- never pruned               |
| derived    | local_cache  | PNGs, renders -- prunable via LRU              |
| docs       | local_warm   | Document records -- archivable to cold storage |
| blobs      | local_warm   | Binary files -- archivable to cold storage     |
| text       | local_warm   | Canonical text -- archivable to cold storage   |
| bundles    | local_cache  | Exported bundles -- prunable via LRU           |
| embeddings | local_warm   | Vector store -- vacuumable                     |

### Storage workflow

1. **Check usage:** `kb.storage_report` shows disk usage by tier with optional
   budget threshold warnings.

2. **Plan cleanup:** `kb.storage_plan` computes what actions would be taken
   (prune derived PNGs, archive cold docs, vacuum embeddings) without executing
   them.

3. **Execute cleanup:** `kb.storage_apply` runs the plan. Supports `dry_run`
   mode. Never touches identity or meta artifacts.

4. **Restore archived data:** `kb.storage_restore` brings cold-archived
   artifacts back to local storage by tier and hash list.

### Cold storage backends

- **local:** Archives to a cold directory on disk.
- **s3:** Archives to an S3 bucket with configurable prefix, region, and manifest.

Configure via `data/storage_policy.json`.

---

## 14. Claude Code Integration

The project includes a `.mcp.json` file that Claude Code auto-discovers when you
open the project directory. This registers the MCP server as a tool source.

### Setup

```bash
npm ci   # install dependencies
# Claude Code auto-discovers .mcp.json on next launch
```

For compiled mode:

```bash
npm run build
bash scripts/mcp-start.sh
```

### Using tools in Claude Code

Once connected, you can ask Claude to use any of the tools directly:

```
> Store a fact that "TypeScript supports structural typing" with tags ["typescript", "types"]
> Search the vault for "type system"
> Create an event card for today's deployment
> Start a memory session and ingest this conversation
```

Claude Code sees all registered tools and their schemas. It knows how to
construct the right arguments.

---

## 15. Environment Variables

| Variable              | Default                               | Description                              |
| --------------------- | ------------------------------------- | ---------------------------------------- |
| `ARTIFACT_VAULT_ROOT` | `.vault`                              | Root directory for vault storage         |
| `EMBEDDING_ENDPOINT`  | `http://localhost:1234/v1/embeddings` | URL of the embedding API endpoint        |
| `EMBEDDING_MODEL`     | `default`                             | Model name to send to the endpoint       |
| `THREADFORGE_TIER`    | `gold`                                | NFT tier: bronze, silver, or gold        |

### Tier override

Set `THREADFORGE_TIER` to restrict the system to a lower tier:

```bash
THREADFORGE_TIER=bronze npm run dev    # limited to basic vault + memory
THREADFORGE_TIER=silver npm run dev    # adds promotion, blessing, corpus
```

The default (`gold`) has no restrictions. Case-insensitive. Invalid values fall
back to `gold`.

---

## 16. Troubleshooting

### "ENDPOINT_UNAVAILABLE" when using vault.search with semantic mode

The embedding endpoint is not running. Either start your embedding server (see
[Embedding Setup](#7-embedding-setup)) or switch to lexical search mode. The
system will fall back to lexical automatically if you use hybrid mode.

### "TierAccessError: Tier 'bronze' does not have access to tool 'vm.execute'"

Your `THREADFORGE_TIER` is set to a tier that does not have access to this tool.
Either upgrade the tier (set `THREADFORGE_TIER=gold`) or use a tool that is
available at your tier.

### "TierCapError: Artifact cap reached"

Your tier's artifact limit has been reached (Bronze: 1,000, Silver: 10,000).
Upgrade your tier to store more artifacts. Note: re-putting existing artifacts
(deduplication) does not count against the cap.

### "Determinism violation" when using vault.put

Your payload contains a prohibited key (like `timestamp`, `hostname`, `pid`,
`cwd`, or `__proto__`). Remove these keys from your payload. They are banned
because they would make the artifact's hash non-deterministic.

### Hash mismatch in Browse screen (red X on hash verify)

The card's content on disk does not match its hash. Possible causes:

- The card file was manually edited after creation.
- A different serialization library was used to write the file.
- File corruption (rare).
- The card was imported from a system using an incompatible schema version.

### TUI shows blank screen or crashes

Make sure you are using Node.js 20 or newer. The TUI uses neo-blessed which
requires a compatible terminal emulator. Try running in a standard terminal
(not inside VS Code's integrated terminal if it causes issues).

### npm test fails with SyntaxError

Make sure you are using Node.js 20+. Older versions do not support the ESM
module syntax used throughout the project.

```bash
node --version   # should be v20.x or newer
```

### Smoke test hash drift

If `npm run smoke` fails with hash differences, it means the computed hashes no
longer match the golden reference. This is expected after intentional schema
changes. Refresh the golden reference:

```bash
npm run smoke -- --refresh-golden
```

---

*End of User Guide*
