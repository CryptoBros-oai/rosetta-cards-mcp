/**
 * Shared utilities for demo and test scripts.
 * - Deterministic timestamp helper
 * - Safe hash wrapper with prohibited key checks
 * - Safe JSON loading with Zod schema validation
 * - Optional/typed search module loader
 */

import fs from "node:fs/promises";
import type { ZodSchema } from "zod";
import { canonicalHash, assertNoProhibitedKeys } from "../src/kb/canonical.js";

/**
 * Returns the current time as an ISO 8601 string.
 * Centralizing this allows for easy mocking/freezing for reproducible test runs.
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * A hardened wrapper around canonicalHash that first asserts no prohibited
 * (i.e., non-deterministic) keys are present in the object being hashed.
 *
 * @param obj The object to hash.
 * @returns The SHA-256 hash as a hex string.
 */
export function safeCanonicalHash(
  obj: Record<string, unknown>
): string {
  assertNoProhibitedKeys(obj);
  return canonicalHash(obj);
}

/**
 * Reads a JSON file from disk, parses it, and validates it against a Zod schema.
 * Throws if the file is unreadable, is not valid JSON, or fails schema validation.
 *
 * @param filePath The path to the JSON file.
 * @param schema The Zod schema to validate against.
 * @returns The parsed and validated data.
 */
export async function loadJsonStrict<T>(
  filePath: string,
  schema: ZodSchema<T>
): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return schema.parse(parsed);
}

export interface SearchResult {
  card_id: string;
  score: number;
}

/** A typed function signature for the search implementation. */
export type SearchFn = (
  query: string,
  options: { top_k: number }
) => Promise<SearchResult[]>;

/** Type guard to check if an unknown import has the right signature. */
function isSearchFn(x: unknown): x is SearchFn {
  return typeof x === "function";
}

export async function loadSearch(): Promise<SearchFn> {
  try {
    // The module is dynamically imported, so its exports are `any`
    const mod = await import("../src/kb/search.js");
    if (isSearchFn((mod as any).search)) {
      return (mod as any).search;
    }
  } catch {
    console.warn(
      "Warning: search module not available. Returning empty result set."
    );
  }

  return async () => [];
}