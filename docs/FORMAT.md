# Rosetta Cards — Canonical Serialization Format

Version: 1.0

## Purpose

Every Rosetta Card artifact (card, bundle manifest, behavior pack) must hash
identically on any platform. This document defines the exact rules.

## Canonical JSON Rules

### 1. Key Ordering

All object keys are sorted **recursively** in lexicographic (Unicode codepoint)
order. This applies at every nesting depth.

### 2. String Normalization

All string values are normalized to **Unicode NFC** before serialization.

### 3. Undefined vs Null

- `undefined` values are **omitted** (key not present in output).
- `null` values are **preserved** as `null`.

### 4. Compact Output

Canonical JSON is **compact** — no whitespace between tokens. This is the form
used as hash input. Storage on disk may use pretty-printed JSON for
readability, but hashing always uses the compact canonical form.

### 5. Line Endings

The canonical form contains no line breaks (compact JSON). Stored files use
`\n` (LF) only, no `\r\n`.

### 6. Encoding

UTF-8 without BOM.

### 7. Number Representation

Numbers use JavaScript's default `JSON.stringify` behavior (no trailing zeros,
no leading zeros except for `0.x`, no `+` prefix).

## Hash Computation

```
hash = SHA-256( canonicalize(payload_without_hash_field) )
```

Where `canonicalize()` applies rules 1-7 above and returns compact JSON bytes.

### Card Hash Scope

For `CardPayload`, the hash covers all fields **except** the `hash` field
itself. The `created_at` timestamp IS included in the hash — a card with a
different timestamp is a different card.

### Bundle Integrity Hash

```
integrity_input = sort(cards.map(c => `${c.card_id}:${c.hash}`)).join("\n")
integrity_hash  = SHA-256(UTF-8(integrity_input))
```

### Behavior Pack Hash

Same as card hash: all fields except `hash`, canonicalized and SHA-256'd.

## Canonical Text Rules

Extracted text (from DOCX, PDF, chat logs, etc.) is canonicalized before
hashing to ensure determinism.

### 1. Line Endings

All `\r\n` (CRLF) and bare `\r` (CR) sequences are normalized to `\n` (LF).

### 2. Unicode Normalization

All text is normalized to **Unicode NFC**.

### 3. Trailing Newline

Canonical text always ends with exactly one `\n`. Leading/trailing whitespace
on the full text is NOT stripped (only the final newline is enforced).

### 4. Encoding

UTF-8 without BOM.

### 5. Hash Computation

```
text_hash = SHA-256( UTF-8( canonicalizeText(extracted_text) ) )
```

## Blob Storage

Raw file bytes are content-addressed using their SHA-256 hash:

```
blob_hash  = SHA-256(raw_bytes)
blob_path  = data/blobs/<hash[0:2]>/<hash[2:4]>/<hash>
```

The 2-level prefix directory structure prevents flat-directory performance
issues at scale. Blobs are deduplicated by hash — storing the same file twice
is a no-op.

## Extracted Text Storage

Canonicalized extracted text is content-addressed:

```
text_hash  = SHA-256( UTF-8( canonicalizeText(text) ) )
text_path  = data/text/<hash[0:2]>/<hash[2:4]>/<hash>.txt
```

## File Artifact Card

A `file_artifact` card represents a single ingested file:

```json
{
  "type": "file_artifact",
  "spec_version": "1.0",
  "title": "report.docx",
  "tags": ["file", "docx"],
  "source": { "relative_path": "docs/report.docx", "original_name": "report.docx" },
  "blob": { "hash": "<sha256>", "bytes": 12345, "mime": "application/vnd.openxmlformats..." },
  "text": {
    "hash": "<sha256>",
    "chars": 5000,
    "extractor": { "name": "mammoth", "version": "1.x" }
  },
  "hash": "<computed>"
}
```

`created_at` is deliberately excluded from the hashed payload of file artifacts
since the file content itself is the identity.

## Folder Index Card

A `folder_index` card summarizes a folder ingestion:

```json
{
  "type": "folder_index",
  "spec_version": "1.0",
  "title": "my-folder",
  "source": { "root_path": "imports/my-folder" },
  "files": [
    {
      "relative_path": "report.docx",
      "blob_hash": "...",
      "text_hash": "...",
      "card_hash": "...",
      "bytes": 12345,
      "mime": "..."
    }
  ],
  "counts": { "files_total": 10, "docx": 3, "pdf": 2, "other": 5, "extracted_text_count": 5 }
}
```

## Text Extraction Determinism

- **DOCX** (via mammoth): Paragraph-order text extraction. Deterministic for
  a pinned mammoth version.
- **PDF** (via pdf-parse): Page-order text extraction. Best-effort deterministic
  under a pinned extractor version. Reading order may vary for complex layouts.
- **OCR**: Out of scope. Not implemented.

The `extractor` field in text records pins the tool name and version so that
hash stability can be verified against a known toolchain.

## Bundle Provenance

Exported bundles may include an optional `provenance` object in the manifest:

```json
{
  "provenance": {
    "generator": "rosetta-cards-mcp",
    "generator_version": "0.1.0",
    "export_scope": "pack_only",
    "pack": { "pack_id": "pack_abc", "name": "My Pack", "hash": "..." },
    "include_blobs": true,
    "include_text": true,
    "created_at": "2025-08-01T12:00:00.000Z"
  }
}
```

### Provenance and Integrity Hashing

The `integrity_hash` is computed **exclusively** from `card_id:hash` pairs (see
Bundle Integrity Hash above). The `provenance` object, `created_at`, and all
other manifest-level metadata are **not** inputs to the integrity hash.

This means:

- Adding or removing provenance does not change the integrity hash
- Two bundles with the same cards produce the same integrity hash regardless of
  provenance or timestamps
- Import verification works identically with or without provenance

Bundles exported before provenance was introduced (without a `provenance` field)
are still valid and importable.

## Implementation

See `src/kb/canonical.ts` for the reference implementation.

## Verification

Golden test fixtures live in `tests/fixtures/`. The CI pipeline runs
canonicalization tests on every commit.
