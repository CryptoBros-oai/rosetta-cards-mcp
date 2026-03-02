# RA-ISA: Rosetta Artifact Instruction Set Architecture

Version: 0.1 (conceptual)

## Overview

RA-ISA defines the semantic microcode for the Rosetta Cards vault runtime.
It maps vault operations to a register-based instruction model, making
behavior packs equivalent to "loadable register contexts."

## Registers

| Register | Description                        | Type           |
|----------|------------------------------------|----------------|
| R0       | Active behavior pack               | BehaviorPack?  |
| R1       | Active pin hashes                  | string[]       |
| R2       | Current query                      | string         |
| R3       | Current task/intent                | string         |
| R4       | Policy constraints                 | PackPolicies   |
| R5       | Search result buffer               | SearchResult[] |
| R6       | Card build buffer                  | CardPayload?   |
| R7       | Bundle staging area                | card_id[]      |

## Instruction Set

### Pack Management

| Opcode       | Args           | Effect                              |
|--------------|----------------|-------------------------------------|
| LOAD_PACK    | pack_id        | R0 = pack; R1 = pack.pins; R4 = pack.policies |
| UNLOAD_PACK  | —              | R0 = null; R1 = []; R4 = defaults  |
| CREATE_PACK  | name, card_ids, policies | Create + store pack        |

### Pin Operations

| Opcode       | Args           | Effect                              |
|--------------|----------------|-------------------------------------|
| PIN_ADD      | card_hash      | R1 = [...R1, card_hash]            |
| PIN_REMOVE   | card_hash      | R1 = R1.filter(h != card_hash)     |
| PIN_CLEAR    | —              | R1 = []                             |

### Search & Query

| Opcode       | Args           | Effect                              |
|--------------|----------------|-------------------------------------|
| SEARCH       | query, top_k   | R2 = query; R5 = search(R2, R4)    |
| FILTER_TAGS  | tags_any, tags_all | R5 = filter(R5, tags)           |
| BOOST_PINNED | —              | R5 = boost(R5, R1, R4.search_boost)|

### Card Operations

| Opcode       | Args           | Effect                              |
|--------------|----------------|-------------------------------------|
| INGEST       | title, text, tags | Create doc, chunk, index         |
| BUILD_CARD   | doc_id, chunk_id | R6 = new card; render PNG         |
| RENDER       | card_id, style | Re-render existing card to PNG      |
| VERIFY       | card_id        | Check hash integrity; return bool   |
| GET_CARD     | card_id        | Load card from vault                |

### Bundle Operations

| Opcode       | Args           | Effect                              |
|--------------|----------------|-------------------------------------|
| EXPORT       | R7, meta       | Create bundle from staged cards     |
| IMPORT       | bundle_path    | Verify + import bundle              |
| STAGE        | card_id        | R7 = [...R7, card_id]              |
| UNSTAGE      | card_id        | R7 = R7.filter(id != card_id)      |

### Context

| Opcode       | Args           | Effect                              |
|--------------|----------------|-------------------------------------|
| GET_CONTEXT  | —              | Return { R0, R1, R4 } as VaultContext |
| RESET        | —              | All registers = default             |

## Execution Model

The vault runtime is **synchronous per-call**: each MCP tool invocation or
TUI action maps to one or more opcodes executed sequentially. There is no
concurrent execution within a single call.

Register state persists across calls via disk (active pack, cards, index).
Ephemeral registers (R2, R3, R5, R6, R7) are scoped to the current operation.

## Behavior Packs as Register Contexts

A behavior pack is literally a serialized register snapshot:

```
LOAD_PACK(pack_id) ≡ {
  R0 = deserialize(pack);
  R1 = R0.pins;
  R4 = R0.policies;
}
```

This means "training" an agent's behavior = curating cards + defining policies
+ saving as a pack. No weights, no fine-tuning, no gradient descent.

## Future Extensions

- **TRACE**: Log opcode execution for audit / replay
- **COMPOSE**: Merge two packs (union pins, merge policies)
- **GUARD**: Assert policy constraints before execution
- **FORK**: Create isolated vault context for parallel experiments
