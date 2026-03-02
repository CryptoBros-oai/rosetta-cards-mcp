# Behavior Pack Specification

Version: 1.0

## Overview

A **Behavior Pack** is a named, versioned, hashable collection of cards plus
policy constraints. When activated, it modifies how hooks (search, build,
ingest) operate — effectively loading a "register context" into the vault
runtime.

## Schema

```
type: "behavior_pack"
pack_id: string          // "pack_" + UUID
name: string             // human label
version: string          // semver
description?: string
pins: string[]           // card hashes (not IDs — content-addressed)
policies: PackPolicies
created_at: string       // ISO 8601
hash: string             // SHA-256 of canonical JSON (without hash field)
```

### PackPolicies

```
search_boost: number     // 0.0–1.0, how much to boost pinned cards in search
max_results?: number     // cap search results
allowed_tags?: string[]  // only surface cards with these tags
blocked_tags?: string[]  // exclude cards with these tags
style?: "default" | "dark" | "light"  // default render style
```

## Lifecycle

1. **Create** from a pinset or manually
2. **Activate** — at most one pack is active at a time
3. **Apply** — hooks read the active pack's context on every call
4. **Deactivate** — hooks revert to default behavior
5. **Export** — packs are included in bundles
6. **Import** — hash verified on import

## Storage

- `data/packs/<pack_id>.json`
- `data/packs/active.json` → `{ active_pack_id: string | null }`

## VaultContext

Every hook receives context about the active pack:

```ts
type VaultContext = {
  activePack: BehaviorPack | null;
  pinHashes: string[];
  policies: PackPolicies;
};
```

When no pack is active, `policies` uses defaults (no boost, no filters).

## Effect on Hooks

| Hook              | Effect when pack active                       |
|-------------------|-----------------------------------------------|
| searchArtifacts   | Boost pinned cards by `search_boost`          |
|                   | Filter by allowed/blocked tags                |
| buildArtifactCard | Use pack's default style                      |
| ingestText        | Auto-tag with pack's allowed_tags if set      |
| exportBundle      | Include active pack in bundle                 |

## Determinism

Packs are hashed identically to cards (see docs/FORMAT.md). Two packs with
the same pins and policies hash identically regardless of platform.
