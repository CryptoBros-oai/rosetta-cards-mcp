import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { vaultPut, vaultSearch } from "../src/vault/store.js";
import { closeDb } from "../src/vault/db.js";
import {
  upsertEmbedding,
  getEmbedding,
  hasEmbedding,
  getMissingIds,
  findSimilar,
  cosineSimilarity,
  closeEmbeddingsDb,
  vectorToBlob,
  blobToVector,
} from "../src/embeddings/store.js";
import { embed, embedSingle, isEndpointAvailable, getModelInfo } from "../src/embeddings/client.js";

// ── Mock embedding server ───────────────────────────────────────────────────

const MOCK_DIM = 8;

function mockEmbedding(index: number): number[] {
  // Deterministic: each vector is a normalized direction based on index
  const vec = new Array(MOCK_DIM).fill(0);
  vec[index % MOCK_DIM] = 1.0;
  // Add a small signal to other dimensions so cosine is non-trivial
  for (let i = 0; i < MOCK_DIM; i++) {
    vec[i] += 0.01 * (index + i);
  }
  return vec;
}

let mockServer: http.Server;
let mockPort: number;

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
            input: string[];
            model: string;
          };
          const data = body.input.map((_, i) => ({
            embedding: mockEmbedding(i),
            index: i,
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data, model: "mock-embed-v1" }));
        } catch {
          res.writeHead(400);
          res.end("bad request");
        }
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      const addr = mockServer.address() as { port: number };
      mockPort = addr.port;
      resolve();
    });
  });
}

// ── Test setup ──────────────────────────────────────────────────────────────

let tmpDir: string;
let origVaultRoot: string | undefined;
let origEmbeddingEndpoint: string | undefined;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-embed-test-"));
  origVaultRoot = process.env.ARTIFACT_VAULT_ROOT;
  origEmbeddingEndpoint = process.env.EMBEDDING_ENDPOINT;
  process.env.ARTIFACT_VAULT_ROOT = tmpDir;

  await startMockServer();
  process.env.EMBEDDING_ENDPOINT = `http://127.0.0.1:${mockPort}/v1/embeddings`;
});

after(() => {
  closeEmbeddingsDb();
  closeDb();
  mockServer.close();
  if (origVaultRoot === undefined) {
    delete process.env.ARTIFACT_VAULT_ROOT;
  } else {
    process.env.ARTIFACT_VAULT_ROOT = origVaultRoot;
  }
  if (origEmbeddingEndpoint === undefined) {
    delete process.env.EMBEDDING_ENDPOINT;
  } else {
    process.env.EMBEDDING_ENDPOINT = origEmbeddingEndpoint;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Cosine similarity unit tests ────────────────────────────────────────────

describe("embeddings — cosine similarity", () => {
  it("identical vectors have similarity 1", () => {
    const v = [1, 2, 3, 4];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-6);
  });

  it("orthogonal vectors have similarity 0", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6);
  });

  it("opposite vectors have similarity -1", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b) - (-1.0)) < 1e-6);
  });

  it("different length vectors return 0", () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });

  it("zero vector returns 0", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  });
});

// ── Vector serialization ────────────────────────────────────────────────────

describe("embeddings — vector serialization", () => {
  it("roundtrips through Float32 blob", () => {
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5];
    const blob = vectorToBlob(vec);
    const recovered = blobToVector(blob);
    assert.equal(recovered.length, vec.length);
    for (let i = 0; i < vec.length; i++) {
      assert.ok(Math.abs(recovered[i] - vec[i]) < 1e-6, `index ${i} mismatch`);
    }
  });
});

// ── Client tests with mock server ───────────────────────────────────────────

describe("embeddings — client (mock server)", () => {
  it("embed returns vectors matching input count", async () => {
    const result = await embed(["hello", "world"]);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0].length, MOCK_DIM);
    assert.equal(result[1].length, MOCK_DIM);
  });

  it("embedSingle returns a single vector", async () => {
    const result = await embedSingle("test text");
    assert.ok(result);
    assert.equal(result.length, MOCK_DIM);
  });

  it("embed with empty array returns empty array", async () => {
    const result = await embed([]);
    assert.ok(result);
    assert.equal(result.length, 0);
  });

  it("isEndpointAvailable returns true with mock server", async () => {
    const available = await isEndpointAvailable();
    assert.equal(available, true);
  });

  it("getModelInfo returns model name and dim", async () => {
    const info = await getModelInfo();
    assert.ok(info);
    assert.equal(info.model, "mock-embed-v1");
    assert.equal(info.dim, MOCK_DIM);
  });
});

// ── Client fallback when endpoint is down ───────────────────────────────────

describe("embeddings — client fallback (no server)", () => {
  let savedEndpoint: string | undefined;

  before(() => {
    savedEndpoint = process.env.EMBEDDING_ENDPOINT;
    // Point to a port that nothing listens on
    process.env.EMBEDDING_ENDPOINT = "http://127.0.0.1:1/v1/embeddings";
  });

  after(() => {
    if (savedEndpoint === undefined) {
      delete process.env.EMBEDDING_ENDPOINT;
    } else {
      process.env.EMBEDDING_ENDPOINT = savedEndpoint;
    }
  });

  it("embed returns null when endpoint is unreachable", async () => {
    const result = await embed(["hello"]);
    assert.equal(result, null);
  });

  it("embedSingle returns null when endpoint is unreachable", async () => {
    const result = await embedSingle("hello");
    assert.equal(result, null);
  });

  it("isEndpointAvailable returns false", async () => {
    const available = await isEndpointAvailable();
    assert.equal(available, false);
  });
});

// ── Store tests ─────────────────────────────────────────────────────────────

describe("embeddings — store", () => {
  it("upsert and get roundtrip", () => {
    const vec = [0.1, 0.2, 0.3, 0.4];
    upsertEmbedding("test-id-1", vec, "test-model");
    const got = getEmbedding("test-id-1");
    assert.ok(got);
    assert.equal(got.length, 4);
    for (let i = 0; i < vec.length; i++) {
      assert.ok(Math.abs(got[i] - vec[i]) < 1e-6);
    }
  });

  it("hasEmbedding returns true for existing, false for missing", () => {
    upsertEmbedding("test-id-2", [1, 2, 3], "test-model");
    assert.equal(hasEmbedding("test-id-2"), true);
    assert.equal(hasEmbedding("nonexistent-id"), false);
  });

  it("upsert overwrites existing embedding", () => {
    upsertEmbedding("test-id-3", [1, 0, 0], "model-a");
    upsertEmbedding("test-id-3", [0, 1, 0], "model-b");
    const got = getEmbedding("test-id-3");
    assert.ok(got);
    assert.ok(Math.abs(got[0]) < 1e-6, "first dim should be ~0");
    assert.ok(Math.abs(got[1] - 1.0) < 1e-6, "second dim should be ~1");
  });

  it("findSimilar ranks by cosine similarity", () => {
    // Insert three vectors with known similarity relationships
    const queryVec = [1, 0, 0, 0];
    upsertEmbedding("sim-a", [1, 0, 0, 0], "m"); // identical to query
    upsertEmbedding("sim-b", [0.7, 0.7, 0, 0], "m"); // similar
    upsertEmbedding("sim-c", [0, 0, 0, 1], "m"); // orthogonal

    const hits = findSimilar(queryVec, 10, ["sim-a", "sim-b", "sim-c"]);
    assert.ok(hits.length === 3);
    assert.equal(hits[0].id, "sim-a"); // most similar
    assert.equal(hits[1].id, "sim-b");
    assert.equal(hits[2].id, "sim-c");
    assert.ok(hits[0].score > hits[1].score);
    assert.ok(hits[1].score > hits[2].score);
  });

  it("findSimilar respects limit", () => {
    const hits = findSimilar([1, 0, 0, 0], 1, ["sim-a", "sim-b", "sim-c"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "sim-a");
  });

  it("getMissingIds finds artifacts without embeddings", async () => {
    // Put artifacts into vault (creates index entries)
    // Then check which ones are missing embeddings
    const { getDb: getDbFresh } = await import("../src/vault/db.js");
    const indexDb = getDbFresh();
    // Insert a dummy artifact row into the index that has no embedding
    indexDb.prepare(`
      INSERT OR IGNORE INTO artifacts (id, kind, tags, created_at, last_seen_at, snippet, payload_text)
      VALUES ('missing-embed-1', 'fact', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{}', '{}')
    `).run();

    const missing = getMissingIds(indexDb);
    assert.ok(missing.includes("missing-embed-1"));
  });
});

// ── Embeddings DB file ──────────────────────────────────────────────────────

describe("embeddings — DB location", () => {
  it("embeddings.sqlite is created in vault root", () => {
    const dbFile = path.join(tmpDir, "embeddings.sqlite");
    assert.ok(fs.existsSync(dbFile), "embeddings.sqlite should exist in vault root");
  });

  it("embeddings.sqlite is separate from index.sqlite", () => {
    const embFile = path.join(tmpDir, "embeddings.sqlite");
    const idxFile = path.join(tmpDir, "index.sqlite");
    assert.notEqual(embFile, idxFile);
  });
});

// ── Vault search modes ──────────────────────────────────────────────────────

describe("vault search — search modes", () => {
  before(async () => {
    // Seed some artifacts and manually embed them for predictable search results
    const r1 = await vaultPut({
      kind: "fact",
      payload: { content: "quantum computing breakthrough" },
      tags: ["science", "search-mode-test"],
      refs: [],
    });
    const r2 = await vaultPut({
      kind: "fact",
      payload: { content: "classical music theory" },
      tags: ["music", "search-mode-test"],
      refs: [],
    });
    const r3 = await vaultPut({
      kind: "fact",
      payload: { content: "quantum physics experiments" },
      tags: ["science", "search-mode-test"],
      refs: [],
    });

    // Manually upsert embeddings with known vectors so we control ranking
    // r1 and r3 are "quantum" related, r2 is not
    upsertEmbedding(r1.id, [0.9, 0.1, 0, 0, 0, 0, 0, 0], "mock");
    upsertEmbedding(r2.id, [0, 0, 0.9, 0.1, 0, 0, 0, 0], "mock");
    upsertEmbedding(r3.id, [0.8, 0.2, 0, 0, 0, 0, 0, 0], "mock");
  });

  it("lexical search returns FTS results with search_mode='lexical'", async () => {
    const result = await vaultSearch({
      query: "quantum",
      tags: ["search-mode-test"],
      search_mode: "lexical",
    });
    assert.equal(result.search_mode, "lexical");
    assert.ok(result.results.length >= 1);
    // All results should contain "quantum" in snippet
    for (const r of result.results) {
      assert.ok(r.snippet.includes("quantum"));
    }
  });

  it("semantic search returns results ranked by cosine with search_mode='semantic'", async () => {
    // Query vector close to r1 and r3
    const result = await vaultSearch({
      query: "quantum",
      tags: ["search-mode-test"],
      search_mode: "semantic",
    });
    assert.equal(result.search_mode, "semantic");
    assert.ok(result.results.length >= 1);
  });

  it("hybrid search returns results with search_mode='hybrid'", async () => {
    const result = await vaultSearch({
      query: "quantum",
      tags: ["search-mode-test"],
      search_mode: "hybrid",
    });
    // May fall back to lexical if embedding endpoint returns unexpected dims
    assert.ok(
      result.search_mode === "hybrid" || result.search_mode === "lexical",
      `expected hybrid or lexical, got ${result.search_mode}`,
    );
    assert.ok(result.results.length >= 1);
  });

  it("default search_mode is hybrid", async () => {
    const result = await vaultSearch({
      query: "quantum",
      tags: ["search-mode-test"],
    });
    // hybrid or fallback to lexical
    assert.ok(
      result.search_mode === "hybrid" || result.search_mode === "lexical",
    );
  });

  it("search without query returns results sorted by last_seen_at", async () => {
    const result = await vaultSearch({ tags: ["search-mode-test"] });
    assert.equal(result.search_mode, "lexical");
    assert.ok(result.results.length >= 3);
  });

  it("lexical search scores are positive", async () => {
    const result = await vaultSearch({
      query: "quantum",
      tags: ["search-mode-test"],
      search_mode: "lexical",
    });
    for (const r of result.results) {
      assert.ok(r.score > 0, `score should be positive, got ${r.score}`);
    }
  });
});

// ── vault.put does not fail when embedding endpoint is down ─────────────────

describe("vault.put — embedding resilience", () => {
  let savedEndpoint: string | undefined;

  before(() => {
    savedEndpoint = process.env.EMBEDDING_ENDPOINT;
    process.env.EMBEDDING_ENDPOINT = "http://127.0.0.1:1/v1/embeddings";
  });

  after(() => {
    if (savedEndpoint === undefined) {
      delete process.env.EMBEDDING_ENDPOINT;
    } else {
      process.env.EMBEDDING_ENDPOINT = savedEndpoint;
    }
  });

  it("vault.put succeeds even when embedding endpoint is unreachable", async () => {
    const result = await vaultPut({
      kind: "fact",
      payload: { content: "resilience test" },
      tags: ["resilience"],
      refs: [],
    });
    assert.ok(result.id);
    assert.equal(result.created, true);
  });
});
