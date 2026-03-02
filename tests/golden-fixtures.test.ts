/**
 * Golden fixture tests — frozen artifact hashes that must remain stable
 * across platforms and Node versions.
 *
 * Each fixture contains an `expected_hash` field that was computed once
 * and committed to the repo. If any canonicalization or hashing change
 * breaks these, the test fails loud.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../src/kb/canonical.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

function loadFixture(name: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(FIXTURES, name), "utf-8");
  return JSON.parse(raw);
}

describe("golden fixtures — card payload", () => {
  it("card hash matches frozen expected_hash", () => {
    const fixture = loadFixture("golden-card.json");
    const { expected_hash, ...payload } = fixture;
    const computed = canonicalHash(payload);
    assert.equal(
      computed,
      expected_hash,
      `Card hash drift detected!\n  expected: ${expected_hash}\n  computed: ${computed}`
    );
  });
});

describe("golden fixtures — file artifact", () => {
  it("file artifact hash matches frozen expected_hash", () => {
    const fixture = loadFixture("golden-file-artifact.json");
    const { expected_hash, ...payload } = fixture;
    const computed = canonicalHash(payload);
    assert.equal(
      computed,
      expected_hash,
      `File artifact hash drift detected!\n  expected: ${expected_hash}\n  computed: ${computed}`
    );
  });
});

describe("golden fixtures — chat chunk", () => {
  it("chat chunk hash matches frozen expected_hash", () => {
    const fixture = loadFixture("golden-chat-chunk.json");
    const { expected_hash, ...payload } = fixture;
    const computed = canonicalHash(payload);
    assert.equal(
      computed,
      expected_hash,
      `Chat chunk hash drift detected!\n  expected: ${expected_hash}\n  computed: ${computed}`
    );
  });
});

describe("golden fixtures — chat log index", () => {
  it("chat log index hash matches frozen expected_hash", () => {
    const fixture = loadFixture("golden-chat-log-index.json");
    const { expected_hash, ...payload } = fixture;
    const computed = canonicalHash(payload);
    assert.equal(
      computed,
      expected_hash,
      `Chat log index hash drift detected!\n  expected: ${expected_hash}\n  computed: ${computed}`
    );
  });
});

describe("golden fixtures — folder index", () => {
  it("folder index hash matches frozen expected_hash", () => {
    const fixture = loadFixture("golden-folder-index.json");
    const { expected_hash, ...payload } = fixture;
    const computed = canonicalHash(payload);
    assert.equal(
      computed,
      expected_hash,
      `Folder index hash drift detected!\n  expected: ${expected_hash}\n  computed: ${computed}`
    );
  });
});
