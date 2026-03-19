# AGENT BRIEFING: Rosetta Cards Vault Integration

## Your Role

You are a Claude Code agent running behavioral sweeps and capability tests
on the local Dell inference node. You have access to the **rosetta-cards-mcp**
vault server as an MCP tool source. After each probe run, you store results
as Rosetta Cards in the vault. Before starting new work, you query the vault
to see what's already been tested and what gaps remain.

## Setup Checklist

Before running any sweeps, verify:

1. The rosetta-cards-mcp repo is cloned at the expected path:
   ```bash
   ls ~/rosetta-cards-mcp/src/server.ts
   ```

2. Dependencies are installed:
   ```bash
   cd ~/rosetta-cards-mcp && npm ci
   ```

3. The `.mcp.json` in your current repo points to the vault server.
   If not, create one:
   ```json
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

4. Test the connection:
   ```
   vault.search { "limit": 1 }
   ```
   Should return a result object (even if empty).

## Storing a Model Fingerprint

After completing a behavioral sweep (RVG scenarios + AP battery), store
the results as a Rosetta Card:

```
vault.put {
  "kind": "profile",
  "payload": {
    "schema": "model_fingerprint.v1",
    "model_family": "gemma",
    "model_name": "gemma-2-27b-it",
    "model_size_b": 27,
    "architecture": "transformer",
    "quant_method": "awq",
    "quant_level": "int4",
    "behavioral_vector": {
      "contain": 0.22,
      "attract": 0.34,
      "release": 0.18,
      "repel": 0.12,
      "transform": 0.14
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
    "routing_fitness": ["general-purpose", "customer-engagement"],
    "routing_exclusions": ["security-moderation"],
    "sweep_source": {
      "lem_issue": "LEM-58",
      "sweep_date": "2026-03-15",
      "scenarios_tested": 10
    }
  },
  "tags": [
    "arch:transformer",
    "family:gemma",
    "fit:customer-engagement",
    "fit:general-purpose",
    "method:awq",
    "model:gemma-27b",
    "profile:healer",
    "quant:int4",
    "schema:model_fingerprint.v1",
    "tier:gold-eligible",
    "tier:silver-eligible",
    "verdict:degraded"
  ],
  "refs": [],
  "source": {
    "agent": "claude-code-sweep",
    "tool": "rv_battery",
    "run_id": "session_2026_03_19"
  }
}
```

**Tag rules** (must match for hash consistency):
- Tags MUST be sorted alphabetically
- Format: `category:value` (lowercase, hyphens for spaces)
- Include `schema:model_fingerprint.v1` always
- Include `tier:X-eligible` based on throughput and verdict:
  - bronze-eligible: ≥100 tok/s AND not broken
  - silver-eligible: ≥40 tok/s AND not broken
  - gold-eligible: not broken

**Behavioral profiles** (pick based on dominant verb):
- guardian: Contain-dominant (≥35%)
- diplomat: Attract-dominant, coalition-building
- negotiator: Attract-dominant with balanced secondary
- liberator: Release-dominant
- healer: Attract + Contain balanced
- sentinel: Repel-dominant
- catalyst: Transform-dominant
- altruist: Release + Attract co-dominant
- balanced: No dominant verb (even spread)

**Quant verdicts:**
- safe: BV delta < 0.05
- degraded: BV delta 0.05 – 0.20
- broken: BV delta > 0.20 or profile flip
- untested: FP16 baseline only

## Querying the Vault Before Starting Work

Before running a new sweep, check what's already been fingerprinted:

```
vault.search {
  "tags": ["schema:model_fingerprint.v1"],
  "limit": 50,
  "search_mode": "lexical"
}
```

Check if a specific model×quant has been tested:
```
vault.search {
  "tags": ["family:qwen", "quant:int4"],
  "search_mode": "lexical"
}
```

Find models that are broken (skip further quant testing):
```
vault.search {
  "tags": ["verdict:broken"],
  "search_mode": "lexical"
}
```

Find all SSM architecture models:
```
vault.search {
  "tags": ["arch:ssm"],
  "search_mode": "lexical"
}
```

## Adaptive Sweep Decisions

Use vault data to make intelligent decisions:

1. **Skip redundant tests:** If `vault.search` returns a card for
   `family:qwen quant:int4 verdict:broken`, skip INT4 testing for
   other Qwen3 sizes (family-level broken pattern).

2. **Prioritize gaps:** Query all fingerprints, identify model families
   or quant levels with no cards yet.

3. **Baseline-first:** Always fingerprint FP16 baseline before any
   quant variants. The baseline card hash becomes the `baseline_card_hash`
   ref in quant variant cards.

4. **Record decisions:** When you skip a test based on vault data,
   store a decision artifact:
   ```
   vault.put {
     "kind": "decision",
     "payload": {
       "decision": "skip_qwen3_4b_int4",
       "reason": "family-level INT4 broken pattern confirmed on qwen3-8b",
       "evidence_card": "<hash of the broken card>",
       "skipped_model": "qwen3-4b",
       "skipped_quant": "int4"
     },
     "tags": ["decision:skip", "family:qwen"],
     "refs": [{"kind": "profile", "id": "<broken card hash>"}]
   }
   ```

## Deduplication

The vault is content-addressed. If you store the exact same fingerprint
data twice, you get the same hash back and `created: false`. This is
safe — you can always re-store without worry about duplicates.

## What NOT to Put in the Vault

- Raw probe output (too large, not structured enough)
- Intermediate results (partial sweeps, debug logs)
- Credentials or environment-specific paths
- Anything with `created_at`, `updated_at`, `timestamp` in the payload
  (the vault will reject these — they violate the identity policy)

## Reporting

After storing fingerprints, post a summary comment on the relevant
Linear issue (LEM-58, LEM-60, LEM-61, etc.) with:
- How many cards were stored
- Any new findings (broken models, profile flips, interesting patterns)
- Card hashes for the most important results
- What gaps remain
