#!/usr/bin/env python3
"""
Backfill existing LemWorld sweep findings into the Rosetta Cards vault.

Sources: LEM-58 Track B/C results, LEM-54 quant sweep, March 2026 sweep findings.
Each entry becomes a vault artifact (kind: "profile") with the model_fingerprint.v1 schema.

Usage:
    python scripts/backfill_sweep_findings.py

    # Dry run (prints cards without storing):
    python scripts/backfill_sweep_findings.py --dry-run

Requires the rosetta-cards-mcp server to be available.
Set ROSETTA_MCP_DIR if the repo is not at the default location.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add clients/python to path
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
sys.path.insert(0, str(_REPO_ROOT / "clients" / "python"))

from rosetta_client import RosettaVault, build_fingerprint_tags

# ---------------------------------------------------------------------------
# Known fingerprints from LEM-58 Tracks B+C and March 2026 sweeps
# ---------------------------------------------------------------------------

KNOWN_FINGERPRINTS: list[dict] = [
    # ── Gemma Family ──────────────────────────────────────────────────
    {
        "model_family": "gemma",
        "model_name": "gemma-2-27b-it",
        "model_size_b": 27,
        "architecture": "transformer",
        "quant_method": "none",
        "quant_level": "fp16",
        "behavioral_vector": {"contain": 0.22, "attract": 0.34, "release": 0.18, "repel": 0.12, "transform": 0.14},
        "behavioral_profile": "healer",
        "quant_verdict": "untested",
        "quant_delta": 0.0,
        "ap_metrics": {"vocabulary_richness": 0.700, "creative_output": 0.65, "snapback_score": 0.82},
        "throughput": {"tok_per_sec": 30.7, "gpu_tested": "V100-32GB-SXM2", "vram_consumed_gb": 54.0, "max_context_tested": 4096, "tensor_parallel": 2},
        "routing_fitness": ["general-purpose", "customer-engagement"],
        "routing_exclusions": ["security-moderation"],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },
    {
        "model_family": "gemma",
        "model_name": "gemma-2-27b-it",
        "model_size_b": 27,
        "architecture": "transformer",
        "quant_method": "awq",
        "quant_level": "int4",
        "behavioral_vector": {"contain": 0.22, "attract": 0.34, "release": 0.18, "repel": 0.12, "transform": 0.14},
        "behavioral_profile": "healer",
        "quant_verdict": "degraded",
        "quant_delta": 0.115,
        "ap_metrics": {"vocabulary_richness": 0.700, "creative_output": 0.65, "snapback_score": 0.82},
        "throughput": {"tok_per_sec": 69.0, "gpu_tested": "A40-48GB", "vram_consumed_gb": 16.2, "max_context_tested": 4096},
        "routing_fitness": ["general-purpose", "customer-engagement"],
        "routing_exclusions": ["security-moderation"],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },
    {
        "model_family": "gemma",
        "model_name": "gemma-2-9b-it",
        "model_size_b": 9,
        "architecture": "transformer",
        "quant_method": "awq",
        "quant_level": "int4",
        "behavioral_vector": {"contain": 0.20, "attract": 0.30, "release": 0.20, "repel": 0.15, "transform": 0.15},
        "behavioral_profile": "healer",
        "quant_verdict": "broken",
        "quant_delta": 0.221,
        "ap_metrics": {"vocabulary_richness": 0.680, "creative_output": 0.60, "snapback_score": 0.75},
        "throughput": {"tok_per_sec": 95.0, "gpu_tested": "A40-48GB", "vram_consumed_gb": 6.0, "max_context_tested": 4096},
        "routing_fitness": [],
        "routing_exclusions": ["all"],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },

    # ── Llama Family ──────────────────────────────────────────────────
    {
        "model_family": "llama",
        "model_name": "meta-llama-3.1-70b-instruct",
        "model_size_b": 70,
        "architecture": "transformer",
        "quant_method": "none",
        "quant_level": "fp16",
        "behavioral_vector": {"contain": 0.30, "attract": 0.25, "release": 0.20, "repel": 0.15, "transform": 0.10},
        "behavioral_profile": "guardian",
        "quant_verdict": "untested",
        "quant_delta": 0.0,
        "ap_metrics": {"vocabulary_richness": 0.720, "creative_output": 0.70, "snapback_score": 0.85},
        "throughput": {"tok_per_sec": 22.0, "gpu_tested": "V100-32GB-SXM2", "vram_consumed_gb": 140.0, "max_context_tested": 4096, "tensor_parallel": 4},
        "routing_fitness": ["reasoning", "security-moderation", "professional-communication"],
        "routing_exclusions": [],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },
    {
        "model_family": "llama",
        "model_name": "meta-llama-3.1-70b-instruct-gptq-int8",
        "model_size_b": 70,
        "architecture": "transformer",
        "quant_method": "gptq",
        "quant_level": "int8",
        "behavioral_vector": {"contain": 0.12, "attract": 0.38, "release": 0.22, "repel": 0.18, "transform": 0.10},
        "behavioral_profile": "altruist",
        "quant_verdict": "broken",
        "quant_delta": 0.427,
        "ap_metrics": {"vocabulary_richness": 0.710, "creative_output": 0.68, "snapback_score": 0.80},
        "throughput": {"tok_per_sec": 28.0, "gpu_tested": "V100-32GB-SXM2", "vram_consumed_gb": 72.0, "max_context_tested": 4096, "tensor_parallel": 4},
        "routing_fitness": [],
        "routing_exclusions": ["all"],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },
    {
        "model_family": "llama",
        "model_name": "meta-llama-3.1-8b-instruct",
        "model_size_b": 8,
        "architecture": "transformer",
        "quant_method": "awq",
        "quant_level": "int4",
        "behavioral_vector": {"contain": 0.28, "attract": 0.26, "release": 0.19, "repel": 0.14, "transform": 0.13},
        "behavioral_profile": "guardian",
        "quant_verdict": "degraded",
        "quant_delta": 0.112,
        "ap_metrics": {"vocabulary_richness": 0.660, "creative_output": 0.58, "snapback_score": 0.78},
        "throughput": {"tok_per_sec": 120.0, "gpu_tested": "A40-48GB", "vram_consumed_gb": 5.0, "max_context_tested": 4096},
        "routing_fitness": ["general-purpose", "security-moderation"],
        "routing_exclusions": ["creative-writing"],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },

    # ── Falcon Family ─────────────────────────────────────────────────
    {
        "model_family": "falcon3",
        "model_name": "falcon3-mamba-7b",
        "model_size_b": 7,
        "architecture": "ssm",
        "quant_method": "none",
        "quant_level": "fp16",
        "behavioral_vector": {"contain": 0.35, "attract": 0.32, "release": 0.02, "repel": 0.18, "transform": 0.13},
        "behavioral_profile": "diplomat",
        "quant_verdict": "untested",
        "quant_delta": 0.0,
        "ap_metrics": {"vocabulary_richness": 0.640, "creative_output": 0.55, "snapback_score": 0.70},
        "throughput": {"tok_per_sec": 95.0, "gpu_tested": "A40-48GB", "vram_consumed_gb": 14.0, "max_context_tested": 8192},
        "routing_fitness": ["market-npc", "trade-simulation"],
        "routing_exclusions": ["creative-writing"],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },
    {
        "model_family": "falcon3",
        "model_name": "falcon3-10b-instruct",
        "model_size_b": 10,
        "architecture": "transformer",
        "quant_method": "none",
        "quant_level": "fp16",
        "behavioral_vector": {"contain": 0.12, "attract": 0.44, "release": 0.32, "repel": 0.06, "transform": 0.06},
        "behavioral_profile": "altruist",
        "quant_verdict": "untested",
        "quant_delta": 0.0,
        "ap_metrics": {"vocabulary_richness": 0.670, "creative_output": 0.62, "snapback_score": 0.74},
        "throughput": {"tok_per_sec": 72.0, "gpu_tested": "A40-48GB", "vram_consumed_gb": 20.0, "max_context_tested": 8192},
        "routing_fitness": ["market-npc", "diplomacy-simulation", "customer-engagement"],
        "routing_exclusions": ["security-moderation"],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },

    # ── DS-R1 (DeepSeek) ──────────────────────────────────────────────
    {
        "model_family": "deepseek",
        "model_name": "deepseek-r1-distill-qwen-32b",
        "model_size_b": 32,
        "architecture": "transformer",
        "quant_method": "gptq",
        "quant_level": "int8",
        "behavioral_vector": {"contain": 0.18, "attract": 0.35, "release": 0.22, "repel": 0.13, "transform": 0.12},
        "behavioral_profile": "diplomat",
        "quant_verdict": "degraded",
        "quant_delta": 0.123,
        "ap_metrics": {"vocabulary_richness": 0.710, "creative_output": 0.68, "snapback_score": 0.82},
        "throughput": {"tok_per_sec": 38.0, "gpu_tested": "RTX-PRO-6000-96GB", "vram_consumed_gb": 34.0, "max_context_tested": 4096},
        "routing_fitness": ["reasoning", "professional-communication"],
        "routing_exclusions": [],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },

    # ── LFM2 (Liquid) ─────────────────────────────────────────────────
    {
        "model_family": "lfm2",
        "model_name": "lfm2-8b-a1b",
        "model_size_b": 8,
        "architecture": "hybrid",
        "quant_method": "none",
        "quant_level": "fp16",
        "behavioral_vector": {"contain": 0.55, "attract": 0.15, "release": 0.12, "repel": 0.10, "transform": 0.08},
        "behavioral_profile": "guardian",
        "quant_verdict": "untested",
        "quant_delta": 0.0,
        "ap_metrics": {"vocabulary_richness": 0.620, "creative_output": 0.58, "snapback_score": 0.65},
        "throughput": {"tok_per_sec": 159.0, "gpu_tested": "A40-48GB", "vram_consumed_gb": 16.0, "max_context_tested": 4096},
        "routing_fitness": ["creative-writing", "storytelling", "ambient-content"],
        "routing_exclusions": ["reasoning", "structured-extraction"],
        "sweep_source": {"lem_issue": "LEM-58", "sweep_date": "2026-03-15", "scenarios_tested": 10},
    },

    # ── Ministral ──────────────────────────────────────────────────────
    {
        "model_family": "mistral",
        "model_name": "ministral-3-3b",
        "model_size_b": 3,
        "architecture": "transformer",
        "quant_method": "none",
        "quant_level": "fp16",
        "behavioral_vector": {"contain": 0.42, "attract": 0.18, "release": 0.15, "repel": 0.13, "transform": 0.12},
        "behavioral_profile": "guardian",
        "quant_verdict": "untested",
        "quant_delta": 0.0,
        "ap_metrics": {"vocabulary_richness": 0.698, "creative_output": 0.72, "snapback_score": 0.80},
        "throughput": {"tok_per_sec": 129.0, "gpu_tested": "V100-32GB-SXM2", "vram_consumed_gb": 6.0, "max_context_tested": 8192},
        "routing_fitness": ["creative-writing", "content-generation", "ambient-poetic"],
        "routing_exclusions": [],
        "sweep_source": {"lem_issue": "LEM-33", "sweep_date": "2026-03-09", "scenarios_tested": 10},
    },
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill sweep findings into Rosetta Cards vault")
    parser.add_argument("--dry-run", action="store_true", help="Print cards without storing")
    args = parser.parse_args()

    if args.dry_run:
        print(f"DRY RUN: {len(KNOWN_FINGERPRINTS)} fingerprints to backfill\n")
        for fp in KNOWN_FINGERPRINTS:
            tags = build_fingerprint_tags({**fp, "schema": "model_fingerprint.v1"})
            print(f"  {fp['model_name']} ({fp['quant_level']}) → {fp['behavioral_profile']}")
            print(f"    verdict: {fp['quant_verdict']}, delta: {fp['quant_delta']}")
            print(f"    tags: {', '.join(tags[:6])}...")
            print()
        return

    print("Connecting to vault...")
    vault = RosettaVault()

    created = 0
    deduped = 0

    try:
        for fp in KNOWN_FINGERPRINTS:
            card_id = vault.put_fingerprint(
                fp,
                source={
                    "agent": "backfill-script",
                    "tool": "sweep_to_vault.py",
                    "repo": "rosetta-cards-mcp",
                },
            )

            # Check if it was a new card or dedup
            card = vault.get(card_id)
            name = f"{fp['model_name']} ({fp['quant_level']})"

            # We can't easily distinguish created vs dedup from put_fingerprint alone,
            # but the vault's put returns created=true/false. For logging purposes:
            print(f"  ✓ {name} → {card_id[:12]}...")
            created += 1

        print(f"\nBackfill complete: {created} cards processed")

        # Verify by searching
        result = vault.search(
            tags=["schema:model_fingerprint.v1"],
            limit=50,
            search_mode="lexical",
        )
        print(f"Vault now contains {result['total']} fingerprint cards")

    finally:
        vault.close()


if __name__ == "__main__":
    main()
