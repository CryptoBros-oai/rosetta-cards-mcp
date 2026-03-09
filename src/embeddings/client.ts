/**
 * HTTP client for local OpenAI-compatible embedding endpoints.
 *
 * Default: http://localhost:1234/v1/embeddings (LM Studio format)
 * Override via EMBEDDING_ENDPOINT env var.
 *
 * Model-agnostic — works with nomic-embed-text, bge-small, etc.
 * Graceful fallback: returns null if the endpoint is unreachable.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

function endpointUrl(): string {
  return process.env.EMBEDDING_ENDPOINT ?? "http://localhost:1234/v1/embeddings";
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

/**
 * Call the embedding endpoint. Returns null if unreachable or errored.
 */
async function callEndpoint(texts: string[]): Promise<EmbeddingResponse | null> {
  const url = new URL(endpointUrl());
  const body = JSON.stringify({
    input: texts,
    model: process.env.EMBEDDING_MODEL ?? "default",
  });

  const transport = url.protocol === "https:" ? https : http;

  return new Promise<EmbeddingResponse | null>((resolve) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf-8");
            const parsed = JSON.parse(raw) as EmbeddingResponse;
            if (!parsed.data || !Array.isArray(parsed.data)) {
              resolve(null);
              return;
            }
            resolve(parsed);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Batch embed multiple texts. Returns null if the endpoint is unreachable.
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const resp = await callEndpoint(texts);
  if (!resp) return null;
  // Sort by index to maintain input order
  const sorted = [...resp.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

/**
 * Embed a single text. Returns null if the endpoint is unreachable.
 */
export async function embedSingle(text: string): Promise<number[] | null> {
  const result = await embed([text]);
  if (!result || result.length === 0) return null;
  return result[0];
}

/**
 * Check if the embedding endpoint is reachable.
 */
export async function isEndpointAvailable(): Promise<boolean> {
  const result = await embed(["test"]);
  return result !== null;
}

/**
 * Return the model name from the last successful response, if available.
 */
export async function getModelInfo(): Promise<{ model: string; dim: number } | null> {
  const resp = await callEndpoint(["probe"]);
  if (!resp || resp.data.length === 0) return null;
  return {
    model: resp.model ?? "unknown",
    dim: resp.data[0].embedding.length,
  };
}
