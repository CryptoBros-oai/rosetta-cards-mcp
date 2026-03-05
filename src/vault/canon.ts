/**
 * Vault-specific canonicalization: prohibited-key enforcement and artifact ID
 * computation. Reuses the core canonicalize/hash functions from kb/canonical.ts.
 */

import {
  canonicalHash,
  assertNoProtoPollution,
} from "../kb/canonical.js";
import type { ArtifactHashPayload } from "./schema.js";

// ── Prohibited keys ──────────────────────────────────────────────────────────

/** Keys that leak temporal or environment state into the hashed payload. */
const VAULT_PAYLOAD_PROHIBITED = new Set([
  "created_at",
  "updated_at",
  "timestamp",
  "now",
  "hostname",
  "cwd",
  "pid",
  "ppid",
  "uid",
  "home",
  "user",
  "username",
  "env",
]);

/**
 * Recursive key walker — mirrors the private `_assertKeys` in canonical.ts
 * without modifying that load-bearing file.
 */
function _assertKeys(set: Set<string>, x: unknown, path: string): void {
  if (x && typeof x === "object") {
    if (Array.isArray(x)) {
      x.forEach((v, i) => _assertKeys(set, v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (set.has(k)) {
        throw new Error(
          `Determinism violation: prohibited key "${k}" at ${path}.${k}`,
        );
      }
      _assertKeys(set, v, `${path}.${k}`);
    }
  }
}

/**
 * Assert the payload contains no keys that would compromise determinism.
 * Checks both prototype-pollution vectors and vault-specific temporal/env keys.
 */
export function assertVaultPayloadClean(payload: unknown): void {
  assertNoProtoPollution(payload, "$.payload");
  _assertKeys(VAULT_PAYLOAD_PROHIBITED, payload, "$.payload");
}

// ── ID computation ───────────────────────────────────────────────────────────

/**
 * Compute the content-addressed artifact ID from structural fields.
 * Validates the payload before hashing.
 */
export function computeArtifactId(hp: ArtifactHashPayload): string {
  assertVaultPayloadClean(hp.payload);
  return canonicalHash(hp as unknown as Record<string, unknown>);
}
