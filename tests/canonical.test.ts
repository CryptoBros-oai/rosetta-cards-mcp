import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, canonicalHash, hashWithout, verifyHash } from "../src/kb/canonical.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("canonicalize", () => {
  it("sorts keys recursively", () => {
    const obj = { z: 1, a: { c: 3, b: 2 } };
    const result = canonicalize(obj);
    assert.equal(result, '{"a":{"b":2,"c":3},"z":1}');
  });

  it("strips undefined values", () => {
    const obj: Record<string, unknown> = { a: 1, b: undefined, c: null };
    const result = canonicalize(obj);
    assert.equal(result, '{"a":1,"c":null}');
  });

  it("normalizes strings to NFC", () => {
    const nfd = "e\u0301"; // e + combining acute
    const nfc = "\u00e9";  // precomposed é
    const obj1 = { text: nfd };
    const obj2 = { text: nfc };
    assert.equal(canonicalize(obj1), canonicalize(obj2));
  });

  it("handles arrays (preserves order)", () => {
    const obj = { items: [3, 1, 2], name: "test" };
    const result = canonicalize(obj);
    assert.equal(result, '{"items":[3,1,2],"name":"test"}');
  });

  it("produces compact JSON", () => {
    const obj = { a: 1, b: "hello", c: [1, 2] };
    const result = canonicalize(obj);
    assert.ok(!result.includes("\n"));
    assert.ok(!result.includes("  "));
  });
});

describe("canonicalHash", () => {
  it("produces consistent SHA-256", () => {
    const obj = { a: 1, b: "hello" };
    const h1 = canonicalHash(obj);
    const h2 = canonicalHash(obj);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it("key order doesn't affect hash", () => {
    const obj1 = { a: 1, b: 2 };
    const obj2 = { b: 2, a: 1 };
    assert.equal(canonicalHash(obj1), canonicalHash(obj2));
  });
});

describe("golden card fixture", () => {
  it("produces a stable canonical hash", () => {
    const fixturePath = path.join(__dirname, "fixtures", "golden-card.json");
    const raw = fs.readFileSync(fixturePath, "utf-8");
    const card = JSON.parse(raw);
    const hash = canonicalHash(card);
    // Verify stability across calls
    assert.equal(canonicalHash(card), hash);
    assert.equal(hash.length, 64);
  });
});

describe("hashWithout", () => {
  it("excludes the specified field before hashing", () => {
    const obj = { a: 1, b: 2, hash: "old_hash" };
    const h = hashWithout(obj, "hash");
    const expected = canonicalHash({ a: 1, b: 2 });
    assert.equal(h, expected);
  });
});

describe("verifyHash", () => {
  it("returns valid=true for correct hash", () => {
    const obj = { a: 1, b: 2 };
    const hash = canonicalHash(obj);
    const withHash = { ...obj, hash };
    const result = verifyHash(withHash, "hash");
    assert.equal(result.valid, true);
    assert.equal(result.expected, result.computed);
  });

  it("returns valid=false for tampered data", () => {
    const obj = { a: 1, b: 2 };
    const hash = canonicalHash(obj);
    const tampered = { a: 999, b: 2, hash };
    const result = verifyHash(tampered, "hash");
    assert.equal(result.valid, false);
  });
});
