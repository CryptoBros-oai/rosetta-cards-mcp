import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeText,
  hashText,
  hashBytes,
} from "../src/kb/canonical.js";

describe("canonicalizeText", () => {
  it("normalizes CRLF to LF", () => {
    const input = "line1\r\nline2\r\nline3";
    const result = canonicalizeText(input);
    assert.ok(!result.includes("\r"), "Must not contain \\r");
    assert.equal(result, "line1\nline2\nline3\n");
  });

  it("normalizes bare CR to LF", () => {
    const input = "line1\rline2\rline3";
    const result = canonicalizeText(input);
    assert.ok(!result.includes("\r"), "Must not contain \\r");
    assert.equal(result, "line1\nline2\nline3\n");
  });

  it("normalizes to Unicode NFC", () => {
    const nfd = "e\u0301"; // e + combining acute (NFD)
    const nfc = "\u00e9"; // precomposed é (NFC)
    assert.equal(
      canonicalizeText(nfd),
      canonicalizeText(nfc),
      "NFD and NFC must produce identical canonical text"
    );
  });

  it("ensures trailing newline", () => {
    assert.ok(
      canonicalizeText("no trailing").endsWith("\n"),
      "Must end with \\n"
    );
    assert.equal(
      canonicalizeText("already has\n"),
      "already has\n",
      "Must not double \\n"
    );
  });

  it("same input always produces same output", () => {
    const input = "Hello World\nLine two\n";
    assert.equal(
      canonicalizeText(input),
      canonicalizeText(input),
      "Must be deterministic"
    );
  });

  it("mixed line endings produce same result", () => {
    const crlf = "a\r\nb\r\nc";
    const lf = "a\nb\nc";
    const cr = "a\rb\rc";
    const result = canonicalizeText(lf);
    assert.equal(canonicalizeText(crlf), result);
    assert.equal(canonicalizeText(cr), result);
  });
});

describe("hashText", () => {
  it("produces consistent SHA-256 for text", () => {
    const text = "Hello World\n";
    const h1 = hashText(text);
    const h2 = hashText(text);
    assert.equal(h1, h2, "Same text must hash identically");
    assert.equal(h1.length, 64, "SHA-256 hex is 64 chars");
  });

  it("CRLF vs LF produce same hash", () => {
    assert.equal(
      hashText("line\r\nend"),
      hashText("line\nend"),
      "Line ending normalization must produce same hash"
    );
  });
});

describe("hashBytes", () => {
  it("produces consistent SHA-256 for buffer", () => {
    const buf = Buffer.from("test data", "utf-8");
    const h1 = hashBytes(buf);
    const h2 = hashBytes(buf);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it("different data produces different hash", () => {
    const h1 = hashBytes(Buffer.from("aaa"));
    const h2 = hashBytes(Buffer.from("bbb"));
    assert.notEqual(h1, h2);
  });
});
