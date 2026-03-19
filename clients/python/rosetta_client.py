"""
Rosetta Cards Vault — Python client.

Spawns the rosetta-cards-mcp TypeScript server as a subprocess and
communicates via JSON-RPC over stdin/stdout (MCP stdio transport).

Usage:
    from rosetta_client import RosettaVault

    vault = RosettaVault()
    card_id = vault.put_fingerprint({...})
    results = vault.search(tags=["family:gemma"])
    card = vault.get(card_id)
    vault.close()

Environment:
    ROSETTA_MCP_DIR   — path to rosetta-cards-mcp repo (default: auto-detect)
    VAULT_ROOT        — override .vault directory location
    EMBEDDING_ENDPOINT — embedding server URL (default: http://localhost:1234/v1/embeddings)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_EMBEDDING_ENDPOINT = "http://localhost:1234/v1/embeddings"
_FINGERPRINT_SCHEMA_VERSION = "model_fingerprint.v1"

# Auto-detect: this file lives in clients/python/ inside the repo
_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parent.parent  # clients/python -> clients -> repo root


def _find_repo_root() -> Path:
    """Find rosetta-cards-mcp repo root, preferring env var."""
    env = os.environ.get("ROSETTA_MCP_DIR")
    if env:
        p = Path(env)
        if (p / "src" / "server.ts").exists():
            return p
        raise FileNotFoundError(f"ROSETTA_MCP_DIR={env} does not contain src/server.ts")
    if (_REPO_ROOT / "src" / "server.ts").exists():
        return _REPO_ROOT
    raise FileNotFoundError(
        "Cannot find rosetta-cards-mcp repo. Set ROSETTA_MCP_DIR or "
        "ensure this file is at <repo>/clients/python/rosetta_client.py"
    )


# ---------------------------------------------------------------------------
# JSON-RPC helpers
# ---------------------------------------------------------------------------

def _make_request(method: str, params: dict[str, Any], req_id: int) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": method,
        "params": params,
    }


def _make_notification(method: str, params: dict[str, Any] | None = None) -> dict:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if params:
        msg["params"] = params
    return msg


# ---------------------------------------------------------------------------
# Tag builder (mirrors TypeScript buildFingerprintTags)
# ---------------------------------------------------------------------------

def build_fingerprint_tags(fp: dict[str, Any]) -> list[str]:
    """Build standardized tags for a fingerprint payload.

    Must produce the same sorted list as the TypeScript buildFingerprintTags()
    for hash consistency when tags enter the artifact identity.
    """
    tags = [
        f"schema:{_FINGERPRINT_SCHEMA_VERSION}",
        f"model:{fp['model_family']}-{fp['model_size_b']}b",
        f"family:{fp['model_family']}",
        f"quant:{fp['quant_level']}",
        f"method:{fp['quant_method']}",
        f"verdict:{fp['quant_verdict']}",
        f"profile:{fp['behavioral_profile']}",
    ]

    if fp.get("architecture"):
        tags.append(f"arch:{fp['architecture']}")

    for fit in fp.get("routing_fitness", []):
        tags.append(f"fit:{fit}")

    tok_s = fp.get("throughput", {}).get("tok_per_sec", 0)
    broken = fp.get("quant_verdict") == "broken"

    if tok_s >= 100 and not broken:
        tags.append("tier:bronze-eligible")
    if tok_s >= 40 and not broken:
        tags.append("tier:silver-eligible")
    if not broken:
        tags.append("tier:gold-eligible")

    return sorted(tags)


# ---------------------------------------------------------------------------
# Vault client
# ---------------------------------------------------------------------------

class RosettaVault:
    """Python client for the rosetta-cards-mcp vault.

    Spawns the MCP server as a child process and communicates via JSON-RPC
    over stdin/stdout. The server process is terminated when close() is
    called or the context manager exits.

    Args:
        repo_dir: Path to rosetta-cards-mcp repo. Auto-detected if None.
        vault_root: Override for ARTIFACT_VAULT_ROOT. Uses repo default if None.
        embedding_endpoint: URL for embedding server. None = use default.
    """

    def __init__(
        self,
        repo_dir: str | Path | None = None,
        vault_root: str | Path | None = None,
        embedding_endpoint: str | None = None,
    ):
        self._repo = Path(repo_dir) if repo_dir else _find_repo_root()
        self._req_id = 0
        self._lock = threading.Lock()

        env = {**os.environ}
        if vault_root:
            env["ARTIFACT_VAULT_ROOT"] = str(vault_root)
        elif not env.get("ARTIFACT_VAULT_ROOT"):
            env["ARTIFACT_VAULT_ROOT"] = str(self._repo / ".vault")

        env["EMBEDDING_ENDPOINT"] = (
            embedding_endpoint
            or env.get("EMBEDDING_ENDPOINT")
            or _DEFAULT_EMBEDDING_ENDPOINT
        )

        self._proc = subprocess.Popen(
            ["node", "--loader", "ts-node/esm", "src/server.ts"],
            cwd=str(self._repo),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=False,
        )

        # Send MCP initialize handshake
        self._initialize()

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _send(self, msg: dict) -> None:
        """Send a JSON-RPC message with Content-Length header (MCP stdio protocol)."""
        body = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        assert self._proc.stdin is not None
        self._proc.stdin.write(header + body)
        self._proc.stdin.flush()

    def _recv(self) -> dict:
        """Read a JSON-RPC response with Content-Length header."""
        assert self._proc.stdout is not None

        # Read headers until empty line
        content_length = 0
        while True:
            line = b""
            while not line.endswith(b"\r\n"):
                ch = self._proc.stdout.read(1)
                if not ch:
                    raise ConnectionError("MCP server closed stdout")
                line += ch

            line_str = line.decode("ascii").strip()
            if not line_str:
                break
            if line_str.lower().startswith("content-length:"):
                content_length = int(line_str.split(":", 1)[1].strip())

        if content_length == 0:
            raise ConnectionError("No Content-Length in MCP response")

        body = self._proc.stdout.read(content_length)
        return json.loads(body.decode("utf-8"))

    def _call(self, method: str, params: dict[str, Any]) -> Any:
        """Send a request and wait for the response."""
        with self._lock:
            req_id = self._next_id()
            self._send(_make_request(method, params, req_id))

            # Read responses until we get one matching our ID
            # (skip notifications)
            while True:
                resp = self._recv()
                if resp.get("id") == req_id:
                    if "error" in resp:
                        raise RuntimeError(
                            f"Vault error: {resp['error'].get('message', resp['error'])}"
                        )
                    return resp.get("result")

    def _initialize(self) -> None:
        """MCP initialize handshake."""
        result = self._call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "rosetta-python-client", "version": "0.1.0"},
        })
        # Send initialized notification
        self._send(_make_notification("notifications/initialized"))

    def _call_tool(self, tool_name: str, args: dict[str, Any]) -> Any:
        """Call an MCP tool and return the result content."""
        result = self._call("tools/call", {"name": tool_name, "arguments": args})
        if not result or not result.get("content"):
            return None
        # MCP tool results come as content blocks
        texts = [c["text"] for c in result["content"] if c.get("type") == "text"]
        if not texts:
            return None
        combined = "\n".join(texts)
        try:
            return json.loads(combined)
        except json.JSONDecodeError:
            return combined

    # ── Public API ─────────────────────────────────────────────────────────

    def put(
        self,
        kind: str,
        payload: dict[str, Any],
        tags: list[str] | None = None,
        refs: list[dict[str, str]] | None = None,
        source: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Store an artifact in the vault. Returns {id, created, created_at, last_seen_at}."""
        args: dict[str, Any] = {
            "kind": kind,
            "payload": payload,
            "tags": tags or [],
            "refs": refs or [],
        }
        if source:
            args["source"] = source
        return self._call_tool("vault.put", args)

    def get(self, artifact_id: str) -> dict[str, Any] | None:
        """Retrieve an artifact by hash. Returns the full envelope or None."""
        return self._call_tool("vault.get", {"id": artifact_id})

    def search(
        self,
        query: str | None = None,
        kind: str | None = None,
        tags: list[str] | None = None,
        limit: int = 10,
        search_mode: str = "hybrid",
    ) -> dict[str, Any]:
        """Search the vault. Returns {total, offset, limit, results}."""
        args: dict[str, Any] = {"limit": limit, "search_mode": search_mode}
        if query:
            args["query"] = query
        if kind:
            args["kind"] = kind
        if tags:
            args["tags"] = tags
        return self._call_tool("vault.search", args)

    def put_fingerprint(
        self,
        data: dict[str, Any],
        source: dict[str, str] | None = None,
    ) -> str:
        """Store a model fingerprint. Returns the content-addressed card ID.

        Args:
            data: Fingerprint fields (model_family, behavioral_vector, etc.).
                  The 'schema' field is auto-set to model_fingerprint.v1.
            source: Optional provenance {agent, tool, repo, run_id}.

        Returns:
            The artifact hash (card ID).
        """
        payload = {**data, "schema": _FINGERPRINT_SCHEMA_VERSION}
        tags = build_fingerprint_tags(payload)

        refs: list[dict[str, str]] = []
        if payload.get("baseline_card_hash"):
            refs.append({"kind": "profile", "id": payload["baseline_card_hash"]})

        result = self.put(
            kind="profile",
            payload=payload,
            tags=tags,
            refs=refs,
            source=source,
        )
        return result["id"]

    def search_fingerprints(
        self,
        family: str | None = None,
        quant: str | None = None,
        verdict: str | None = None,
        profile: str | None = None,
        tier: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Search for fingerprint cards by common filters.

        Returns a list of search hits (id, kind, tags, snippet).
        """
        tags = [f"schema:{_FINGERPRINT_SCHEMA_VERSION}"]
        if family:
            tags.append(f"family:{family}")
        if quant:
            tags.append(f"quant:{quant}")
        if verdict:
            tags.append(f"verdict:{verdict}")
        if profile:
            tags.append(f"profile:{profile}")
        if tier:
            tags.append(f"tier:{tier}-eligible")

        result = self.search(kind="profile", tags=tags, limit=limit, search_mode="lexical")
        return result.get("results", [])

    def verify(self, card_hash: str) -> bool:
        """Verify a card exists in the vault (Carapace pattern).

        Returns True if the hash resolves to a valid artifact.
        """
        card = self.get(card_hash)
        return card is not None

    def close(self) -> None:
        """Terminate the MCP server subprocess."""
        if self._proc and self._proc.poll() is None:
            try:
                assert self._proc.stdin is not None
                self._proc.stdin.close()
            except Exception:
                pass
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def __enter__(self) -> "RosettaVault":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def __del__(self) -> None:
        self.close()
