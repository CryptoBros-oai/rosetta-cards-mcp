# Cross-Repo Integration Architecture

## How LemWorld, LensForge, and ThreadForge Use the Vault

### The Core Pattern

The rosetta-cards-mcp server runs as a **persistent MCP process** on the
local inference node. All other systems interact with it through one of
three interfaces, depending on their runtime context:

```
┌──────────────────────────────────────────────────────────────────────┐
│                    LOCAL INFERENCE NODE                               │
│                                                                      │
│  ┌────────────────────────────┐                                      │
│  │  rosetta-cards-mcp server  │  ← single process, owns all state    │
│  │  (Node.js, stdio MCP)      │                                      │
│  │                            │                                      │
│  │  .vault/                   │  ← SQLite FTS5 index                 │
│  │    blobs/<hash>.json       │  ← content-addressed artifacts       │
│  │    index.sqlite            │  ← searchable index                  │
│  └──────┬─────────┬──────────┘                                      │
│         │         │                                                  │
│    MCP stdio   HTTP API                                              │
│    (local)     (Phase 3)                                             │
│         │         │                                                  │
│  ┌──────▼──┐ ┌────▼─────┐ ┌──────────────┐                         │
│  │ Claude  │ │ Python   │ │ LM Studio /  │                          │
│  │ Code    │ │ harness  │ │ Ollama       │                          │
│  │ agents  │ │ runners  │ │ (embeddings) │                          │
│  └─────────┘ └──────────┘ └──────────────┘                         │
│                                                                      │
│  K620 #1: coordinator model    K620 #2: Nomic embeddings            │
│  RTX 3060: primary inference   CPU: vault server + harnesses         │
└──────────────────────────────────────────────────────────────────────┘
         │
    WireGuard VPN
         │
┌────────▼─────────────────────────────────────────────────────────────┐
│                    C4140 CLUSTER (Phase 3)                            │
│                                                                      │
│  NODE-01: LiteLLM gateway queries vault via HTTP                     │
│  NODE-02-04: vLLM serving, behavior verified against vault cards     │
└──────────────────────────────────────────────────────────────────────┘
```

### Interface 1: MCP stdio (Claude Code agents)

Claude Code agents already speak MCP natively. When a Claude Code agent
opens a project directory containing `.mcp.json`, it auto-discovers the
server and can call tools directly.

**Used by:** Claude Code agents running sweeps in LemWorld or LensForge repos.

**Setup:** Each repo includes a `.mcp.json` that points to the shared vault:

```json
// In LemWorld/.mcp.json or LensForge/.mcp.json
{
  "mcpServers": {
    "rosetta-cards": {
      "command": "node",
      "args": ["--loader", "ts-node/esm",
               "/home/cryptobro/rosetta-cards-mcp/src/server.ts"],
      "env": {
        "ARTIFACT_VAULT_ROOT": "/home/cryptobro/rosetta-cards-mcp/.vault",
        "EMBEDDING_ENDPOINT": "http://localhost:1234/v1/embeddings"
      }
    }
  }
}
```

All three repos point `ARTIFACT_VAULT_ROOT` to the **same directory**.
One vault, multiple consumers.

**Example flow — Claude Code agent stores a fingerprint:**

```
Agent: vault.put {
  kind: "profile",
  payload: { schema: "model_fingerprint.v1", model_family: "gemma", ... },
  tags: ["model:gemma-27b", "quant:int4", "verdict:degraded"],
  source: { agent: "lemworld-sweep", tool: "rv_battery", run_id: "..." }
}

Server: { id: "a1b2c3...", created: true }
```

### Interface 2: Python subprocess client (harness runners)

LemWorld and LensForge harness runners are Python scripts that run
independently of Claude Code. They need to store fingerprints and
query cards without going through an agent.

**Used by:** `sweep_coordinator.py`, `rv_battery.py`, LensForge test
harnesses, any Python script that produces or consumes behavioral data.

**Pattern:** Python subprocess spawns the MCP server, sends JSON-RPC
messages over stdin/stdout.

The client module (`rosetta_client.py`) lives in this repo under
`clients/python/` and is symlinked or copied into each consuming repo.

```python
# Usage in a LemWorld sweep runner:
from rosetta_client import RosettaVault

vault = RosettaVault()  # spawns MCP server as subprocess

# Store a fingerprint after a sweep
card_id = vault.put_fingerprint({
    "model_family": "gemma",
    "model_name": "gemma-2-27b-it",
    "model_size_b": 27,
    "quant_method": "awq",
    "quant_level": "int4",
    "behavioral_vector": {
        "contain": 0.22, "attract": 0.34,
        "release": 0.18, "repel": 0.12, "transform": 0.14
    },
    "behavioral_profile": "healer",
    "quant_verdict": "degraded",
    "quant_delta": 0.115,
    "ap_metrics": {
        "vocabulary_richness": 0.700,
        "creative_output": 0.65,
        "snapback_score": 0.82
    },
    "throughput": {
        "tok_per_sec": 69.0,
        "gpu_tested": "A40-48GB",
        "vram_consumed_gb": 16.2,
        "max_context_tested": 4096
    },
    "routing_fitness": ["general-purpose"],
    "routing_exclusions": ["security-moderation"],
    "sweep_source": {
        "lem_issue": "LEM-58",
        "sweep_date": "2026-03-15",
        "scenarios_tested": 10
    }
})

# Query cards for routing decisions
broken = vault.search(tags=["verdict:broken", "family:llama"])
gold_eligible = vault.search(tags=["tier:gold-eligible"])

# Verify a card exists (Carapace pattern)
card = vault.get(card_id)

vault.close()  # terminates subprocess
```

### Interface 3: HTTP API (Phase 3 — ThreadForge cluster)

When the C4140 cluster is online, the vault needs network access.
A thin HTTP wrapper (Express or Fastify) exposes vault operations
over REST. This runs on the local node alongside the MCP server,
sharing the same vault directory.

**Used by:** LiteLLM gateway on NODE-01, 3B router model, Carapace
verification endpoints.

**Not built yet.** Scope for LEM-61 Phase 3.

```
GET  /v1/cards/:hash           → vault.get
POST /v1/cards/search          → vault.search
POST /v1/cards                 → vault.put (authenticated)
GET  /v1/cards/:hash/verify    → exists check (Carapace)
```

---

## File Layout After Integration

```
/home/cryptobro/
├── rosetta-cards-mcp/           ← THIS REPO (vault + MCP server)
│   ├── .vault/                  ← shared vault directory (all repos point here)
│   │   ├── blobs/               ← content-addressed artifacts
│   │   └── index.sqlite         ← FTS5 searchable index
│   ├── src/
│   │   ├── vault/
│   │   │   ├── fingerprint_schema.ts   ← NEW: model fingerprint Zod schema
│   │   │   ├── store.ts                ← vault CRUD operations
│   │   │   ├── schema.ts               ← envelope/artifact schemas
│   │   │   └── canon.ts                ← hash/determinism enforcement
│   │   └── server.ts                   ← MCP server entry point
│   ├── clients/
│   │   └── python/
│   │       └── rosetta_client.py       ← NEW: Python subprocess client
│   ├── docs/specs/
│   │   └── MODEL_FINGERPRINT_V1.md     ← NEW: fingerprint spec
│   └── tests/
│       └── fingerprint.test.ts         ← NEW: 38 tests
│
├── LemWorld/
│   ├── .mcp.json                ← points to rosetta-cards-mcp server
│   ├── lib/
│   │   └── rosetta_client.py    ← symlink to clients/python/rosetta_client.py
│   └── scripts/
│       └── sweep_to_vault.py    ← converts sweep JSON → vault.put calls
│
├── ThreadForge/
│   ├── lensforge/
│   │   ├── .mcp.json            ← points to rosetta-cards-mcp server
│   │   └── manifold/
│   │       └── lib/
│   │           └── rosetta_client.py  ← symlink
│   └── services/
│       └── litellm/
│           └── vault_middleware.py    ← Phase 3: queries vault for routing
│
└── local-node/
    └── services/
        └── vault-http/               ← Phase 3: HTTP wrapper
```

---

## Why NOT Embed the Vault in Each Repo

Alternatives considered and rejected:

**Rejected: Python reimplementation of vault.**
The canonicalization (NFC normalization, recursive key sort, compact JSON,
UTF-8 no BOM) must be byte-identical to produce matching hashes. Two
implementations in two languages is a determinism risk. One canonical
implementation (TypeScript) with language-agnostic access (MCP/HTTP) is
safer.

**Rejected: npm package published from this repo, consumed by others.**
LemWorld and LensForge are Python. The consuming repos can't npm install
a TypeScript package. Even if they could, the vault state (SQLite + blobs)
must be shared, not per-install.

**Rejected: gRPC or other RPC framework.**
Overkill for local subprocess communication. MCP is already the protocol
Claude Code speaks. HTTP comes later for network access.

---

## Embedding Search Configuration

The vault supports hybrid search (FTS5 + vector embeddings). On the local
node, the embedding endpoint is provided by a small model on one of the
K620 GPUs:

```
K620 #2 → Ollama → nomic-embed-text (137M params, ~274MB FP16)
         → serves on http://localhost:11434/v1/embeddings
         → EMBEDDING_ENDPOINT in .mcp.json
```

This enables queries like "find models similar to gemma-27b behavioral
profile" to work via cosine similarity, not just exact tag matching.

If the embedding endpoint is down, search falls back to lexical (FTS5)
automatically — vault operations never fail due to embedding unavailability.
