/**
 * Deterministic canonical serialization for Rosetta Cards.
 *
 * Rules (see docs/FORMAT.md):
 *  1. Unicode NFC normalization on all string values
 *  2. Keys sorted recursively (depth-first, lexicographic)
 *  3. undefined values omitted; explicit null preserved
 *  4. No trailing whitespace; \n line endings only
 *  5. No pretty-printing (compact JSON) for hash input
 *  6. UTF-8 encoding, no BOM
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Prohibited-key tripwires
// ---------------------------------------------------------------------------

// Keys that universally indicate prototype-pollution vectors and should be
// blocked for all hashed payloads.
const PROTO_PROHIBITED = new Set(["__proto__", "prototype", "constructor"]);

// Keys that are forbidden in *event* hashed payloads (temporal/provenance).
const EVENT_PROHIBITED = new Set([
  "occurred_at",
  "created_at",
  "updated_at",
  "timestamp",
  "time",
  "source",
  "provenance",
]);

// Keys that are forbidden in *execution* hashed payloads.
// Superset of EVENT_PROHIBITED plus runtime/cost fields.
const EXECUTION_PROHIBITED = new Set([
  "occurred_at",
  "created_at",
  "updated_at",
  "timestamp",
  "time",
  "source",
  "provenance",
  "runtime",
  "duration_ms",
  "cost_estimate",
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

function _assertKeys(set: Set<string>, x: unknown, path = "$"): void {
  if (x && typeof x === "object") {
    if (Array.isArray(x)) {
      x.forEach((v, i) => _assertKeys(set, v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (set.has(k)) {
        throw new Error(`Determinism violation: prohibited key "${k}" at ${path}.${k}`);
      }
      _assertKeys(set, v, `${path}.${k}`);
    }
  }
}

/**
 * Assert no prototype-pollution keys are present anywhere in the object.
 * This is a universal guard and is invoked by `canonicalHash` so that every
 * artifact hashing pass rejects prototype-pollution vectors.
 */
export function assertNoProtoPollution(x: unknown, path = "$"): void {
  _assertKeys(PROTO_PROHIBITED, x, path);
}

/**
 * Full prohibited-key guard for event payloads. This checks both prototype
 * pollution vectors and temporal/provenance keys that must never enter
 * an event's hashed identity.
 */
export function assertNoProhibitedKeys(x: unknown, path = "$"): void {
  _assertKeys(PROTO_PROHIBITED, x, path);
  _assertKeys(EVENT_PROHIBITED, x, path);
}

/**
 * Full prohibited-key guard for execution payloads. This checks prototype
 * pollution vectors plus temporal/provenance/runtime keys that must never
 * enter an execution's hashed identity.
 */
export function assertNoExecutionProhibitedKeys(x: unknown, path = "$"): void {
  _assertKeys(PROTO_PROHIBITED, x, path);
  _assertKeys(EXECUTION_PROHIBITED, x, path);
}

/**
 * Recursively sort all object keys and normalize strings to NFC.
 */
function deepSortAndNormalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.normalize("NFC");
  }

  if (Array.isArray(value)) {
    return value.map(deepSortAndNormalize);
  }

  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        sorted[k] = deepSortAndNormalize(v);
      }
    }
    return sorted;
  }

  return value;
}

/**
 * Produce canonical JSON bytes for hashing.
 * Compact (no whitespace), sorted keys, NFC strings, undefined stripped.
 */
export function canonicalize(obj: Record<string, unknown>): string {
  const normalized = deepSortAndNormalize(obj) as Record<string, unknown>;
  return JSON.stringify(normalized);
}

/**
 * Produce canonical JSON bytes as a Buffer (UTF-8, no BOM).
 */
export function canonicalizeToBytes(obj: Record<string, unknown>): Buffer {
  return Buffer.from(canonicalize(obj), "utf-8");
}

/**
 * SHA-256 hash of the canonical JSON bytes.
 */
export function canonicalHash(obj: Record<string, unknown>): string {
  // Universal proto-pollution guard before hashing.
  assertNoProtoPollution(obj);

  const bytes = canonicalizeToBytes(obj);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Strip a named field from an object before canonicalization.
 * Used to compute hash of a payload excluding its own hash field.
 */
export function hashWithout(
  obj: Record<string, unknown>,
  excludeKey: string
): string {
  const { [excludeKey]: _, ...rest } = obj;
  return canonicalHash(rest);
}

/**
 * Verify that an object's stored hash matches its canonical hash.
 */
export function verifyHash(
  obj: Record<string, unknown>,
  hashField = "hash"
): { valid: boolean; expected: string; computed: string } {
  const expected = obj[hashField] as string;
  const computed = hashWithout(obj, hashField);
  return { valid: expected === computed, expected, computed };
}

/**
 * Canonicalize extracted text for deterministic hashing.
 * Rules (see docs/FORMAT.md § Canonical Text Rules):
 *  1. Normalize \r\n and \r to \n
 *  2. Unicode NFC normalization
 *  3. Ensure exactly one trailing \n
 */
export function canonicalizeText(text: string): string {
  let result = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  result = result.normalize("NFC");
  if (!result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

/**
 * SHA-256 hash of raw bytes (Buffer).
 */
export function hashBytes(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-256 hash of canonical text (applies canonicalizeText first).
 */
export function hashText(text: string): string {
  const canonical = canonicalizeText(text);
  return crypto.createHash("sha256").update(Buffer.from(canonical, "utf-8")).digest("hex");
}
