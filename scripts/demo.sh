#!/usr/bin/env bash
set -euo pipefail

echo "This script just prints suggested MCP tool calls; run the MCP server via your client."
cat <<'EOF'

Example usage via MCP client tools:

1) Add a document:
kb.add_document
{
  "title": "RKS-VM: Opcode Tagging Plan",
  "text": "- Define opcode_tags.json\n- Add TRACE instrumentation\n- Build verb balance reducer\n- Run deterministic baseline\n- Sweep noise and plot",
  "tags": ["rosetta", "rks-vm", "opcodes"],
  "source_url": "file:///srv/apps/rosetta-kernel-spec/docs/RKS-VM-v0.1.md"
}

2) Build a card for chunk 0:
kb.build_card
{
  "doc_id": "doc_...from previous step...",
  "chunk_id": 0,
  "style": "default",
  "include_qr": true
}

3) Search:
kb.search
{
  "query": "trace instrumentation verb balance reducer",
  "top_k": 5
}

4) Get card:
kb.get_card
{
  "card_id": "card_...from build_card..."
}

EOF
