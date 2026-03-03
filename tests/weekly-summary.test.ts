/**
 * Weekly Summary artifact tests — Prompt 4
 *
 * Covers:
 *   - Schema strictness (WeeklySummarySchema)
 *   - Hash determinism for identical inputs
 *   - Order independence: unsorted refs → sorted hash-stable output
 *   - week_start normalization to Monday, week_end to Sunday
 *   - File naming: summary_week_<hash12>.json
 *   - strict rejection of unknown keys
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { WeeklySummarySchema } from "../src/kb/schema.js";
import { canonicalHash } from "../src/kb/canonical.js";
import { toWeekStart, toWeekEnd, createWeeklySummary } from "../src/kb/summary.js";

// ---------------------------------------------------------------------------
// Isolated vault via env override (summary.ts uses process.env.VAULT_ROOT)
// ---------------------------------------------------------------------------

async function withVault<T>(fn: (vaultRoot: string) => Promise<T>): Promise<T> {
  const vaultRoot = path.join(os.tmpdir(), `rosetta-sum-${crypto.randomUUID()}`);
  await fs.mkdir(path.join(vaultRoot, "data", "summaries"), { recursive: true });
  const prev = process.env.VAULT_ROOT;
  process.env.VAULT_ROOT = vaultRoot;
  try {
    return await fn(vaultRoot);
  } finally {
    if (prev === undefined) delete process.env.VAULT_ROOT;
    else process.env.VAULT_ROOT = prev;
    await fs.rm(vaultRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Date normalization helpers
// ---------------------------------------------------------------------------

describe("toWeekStart — normalization to Monday", () => {
  it("Monday stays Monday", () => {
    assert.equal(toWeekStart("2024-06-10"), "2024-06-10"); // already Monday
  });

  it("Tuesday → previous Monday", () => {
    assert.equal(toWeekStart("2024-06-11"), "2024-06-10");
  });

  it("Sunday → previous Monday (6 days back)", () => {
    assert.equal(toWeekStart("2024-06-16"), "2024-06-10");
  });

  it("Saturday → previous Monday", () => {
    assert.equal(toWeekStart("2024-06-15"), "2024-06-10");
  });

  it("accepts ISO datetime and extracts date portion", () => {
    assert.equal(toWeekStart("2024-06-12T14:30:00Z"), "2024-06-10");
  });

  it("cross-year boundary: Dec 30 2024 (Monday)", () => {
    assert.equal(toWeekStart("2024-12-30"), "2024-12-30");
  });

  it("cross-year boundary: Dec 31 2024 (Tuesday)", () => {
    assert.equal(toWeekStart("2024-12-31"), "2024-12-30");
  });

  it("cross-year boundary: Jan 1 2025 (Wednesday) → Dec 30 2024", () => {
    assert.equal(toWeekStart("2025-01-01"), "2024-12-30");
  });
});

describe("toWeekEnd — Sunday from Monday", () => {
  it("Monday 2024-06-10 → Sunday 2024-06-16", () => {
    assert.equal(toWeekEnd("2024-06-10"), "2024-06-16");
  });

  it("cross-month: 2024-06-28 (Friday) → week start 2024-06-24, week end 2024-06-30", () => {
    const ws = toWeekStart("2024-06-28");
    assert.equal(ws, "2024-06-24");
    assert.equal(toWeekEnd(ws), "2024-06-30");
  });
});

// ---------------------------------------------------------------------------
// Schema strictness
// ---------------------------------------------------------------------------

describe("WeeklySummarySchema — strict validation", () => {
  function makeValid(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: "summary.week.v1",
      week_start: "2024-06-10",
      week_end: "2024-06-16",
      references: { events: [], cards: [] },
      highlights: ["A highlight"],
      decisions: [],
      open_loops: [],
      risks: [],
      hash: "deadbeef1234",
      ...overrides,
    };
  }

  it("accepts a valid minimal summary", () => {
    assert.doesNotThrow(() => WeeklySummarySchema.parse(makeValid()));
  });

  it("accepts with rosetta_balance", () => {
    assert.doesNotThrow(() =>
      WeeklySummarySchema.parse(
        makeValid({ rosetta_balance: { A: 1, C: 2, L: 0, P: 0, T: 3 } }),
      ),
    );
  });

  it("rejects unknown root key", () => {
    assert.throws(
      () => WeeklySummarySchema.parse(makeValid({ extra: "bad" })),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in references", () => {
    assert.throws(
      () =>
        WeeklySummarySchema.parse(
          makeValid({ references: { events: [], cards: [], extra: [] } }),
        ),
      /unrecognized_keys/,
    );
  });

  it("rejects unknown key in rosetta_balance", () => {
    assert.throws(
      () =>
        WeeklySummarySchema.parse(
          makeValid({ rosetta_balance: { A: 1, C: 0, L: 0, P: 0, T: 0, Z: 99 } }),
        ),
      /unrecognized_keys/,
    );
  });

  it("rejects invalid week_start format", () => {
    assert.throws(() => WeeklySummarySchema.parse(makeValid({ week_start: "not-a-date" })));
  });
});

// ---------------------------------------------------------------------------
// Hash determinism
// ---------------------------------------------------------------------------

describe("createWeeklySummary — hash determinism", () => {
  it("identical inputs produce identical hash", async () => {
    await withVault(async () => {
      const a = await createWeeklySummary({
        week_start: "2024-06-10",
        references: { events: ["evthash1"], cards: ["cardhash1"] },
        highlights: ["Launched v2"],
        decisions: ["Switch DB"],
        open_loops: ["Perf review"],
        risks: ["Load spike"],
      });
      const b = await createWeeklySummary({
        week_start: "2024-06-10",
        references: { events: ["evthash1"], cards: ["cardhash1"] },
        highlights: ["Launched v2"],
        decisions: ["Switch DB"],
        open_loops: ["Perf review"],
        risks: ["Load spike"],
      });
      assert.equal(a.hash, b.hash);
    });
  });

  it("different week_start produces different hash", async () => {
    await withVault(async () => {
      const a = await createWeeklySummary({
        week_start: "2024-06-10",
        references: {},
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      const b = await createWeeklySummary({
        week_start: "2024-06-17",
        references: {},
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      assert.notEqual(a.hash, b.hash);
    });
  });

  it("different highlights produce different hash", async () => {
    await withVault(async () => {
      const a = await createWeeklySummary({
        week_start: "2024-06-10",
        references: {},
        highlights: ["Alpha"], decisions: [], open_loops: [], risks: [],
      });
      const b = await createWeeklySummary({
        week_start: "2024-06-10",
        references: {},
        highlights: ["Beta"], decisions: [], open_loops: [], risks: [],
      });
      assert.notEqual(a.hash, b.hash);
    });
  });
});

// ---------------------------------------------------------------------------
// Order independence (references sorted before hashing)
// ---------------------------------------------------------------------------

describe("createWeeklySummary — order independence", () => {
  it("event refs in different order produce identical hash and sorted output", async () => {
    await withVault(async () => {
      const a = await createWeeklySummary({
        week_start: "2024-06-10",
        references: { events: ["zzz", "aaa", "mmm"] },
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      const b = await createWeeklySummary({
        week_start: "2024-06-10",
        references: { events: ["aaa", "mmm", "zzz"] },
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      assert.equal(a.hash, b.hash, "Hash must be identical regardless of input order");
      assert.deepEqual(a.references.events, ["aaa", "mmm", "zzz"]);
    });
  });

  it("card refs in different order produce identical hash", async () => {
    await withVault(async () => {
      const a = await createWeeklySummary({
        week_start: "2024-06-10",
        references: { cards: ["c3", "c1", "c2"] },
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      const b = await createWeeklySummary({
        week_start: "2024-06-10",
        references: { cards: ["c1", "c2", "c3"] },
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      assert.equal(a.hash, b.hash);
      assert.deepEqual(a.references.cards, ["c1", "c2", "c3"]);
    });
  });
});

// ---------------------------------------------------------------------------
// week_start normalization through create
// ---------------------------------------------------------------------------

describe("createWeeklySummary — week_start normalization", () => {
  it("Wednesday input → Monday week_start, Sunday week_end", async () => {
    await withVault(async () => {
      const s = await createWeeklySummary({
        week_start: "2024-06-12", // Wednesday
        references: {},
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      assert.equal(s.week_start, "2024-06-10"); // Monday
      assert.equal(s.week_end, "2024-06-16");   // Sunday
    });
  });

  it("Sunday input → previous Monday", async () => {
    await withVault(async () => {
      const s = await createWeeklySummary({
        week_start: "2024-06-16", // Sunday
        references: {},
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      assert.equal(s.week_start, "2024-06-10");
    });
  });

  it("same normalized week from different input dates produces same hash", async () => {
    await withVault(async () => {
      const a = await createWeeklySummary({
        week_start: "2024-06-10", // Monday
        references: {},
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      const b = await createWeeklySummary({
        week_start: "2024-06-14", // Friday (same week)
        references: {},
        highlights: [], decisions: [], open_loops: [], risks: [],
      });
      assert.equal(a.hash, b.hash, "Any day in same week produces same summary hash");
    });
  });
});

// ---------------------------------------------------------------------------
// File naming and storage
// ---------------------------------------------------------------------------

describe("createWeeklySummary — file storage", () => {
  it("file is named summary_week_<hash12>.json", async () => {
    await withVault(async (vaultRoot) => {
      const s = await createWeeklySummary({
        week_start: "2024-06-10",
        references: {},
        highlights: ["File naming test"],
        decisions: [], open_loops: [], risks: [],
      });
      const expected = path.join(
        vaultRoot, "data", "summaries",
        `summary_week_${s.hash.slice(0, 12)}.json`,
      );
      const raw = await fs.readFile(expected, "utf-8");
      const loaded = JSON.parse(raw);
      assert.equal(loaded.hash, s.hash);
    });
  });

  it("file is valid WeeklySummarySchema", async () => {
    await withVault(async (vaultRoot) => {
      const s = await createWeeklySummary({
        week_start: "2024-06-10",
        references: { events: ["ev1"], cards: ["c1"] },
        highlights: ["Schema validation"],
        decisions: ["Use Zod"],
        open_loops: [],
        risks: [],
        rosetta_balance: { A: 1, C: 1, L: 1, P: 1, T: 1 },
      });
      const raw = await fs.readFile(
        path.join(vaultRoot, "data", "summaries", `summary_week_${s.hash.slice(0, 12)}.json`),
        "utf-8",
      );
      assert.doesNotThrow(() => WeeklySummarySchema.parse(JSON.parse(raw)));
    });
  });

  it("hash matches re-computed canonicalHash", async () => {
    await withVault(async () => {
      const s = await createWeeklySummary({
        week_start: "2024-06-10",
        references: { events: ["evX"] },
        highlights: ["h1"],
        decisions: ["d1"],
        open_loops: ["o1"],
        risks: ["r1"],
      });
      // Recompute hash independently
      const { hash: _, ...payload } = s;
      const recomputed = canonicalHash(payload as unknown as Record<string, unknown>);
      assert.equal(s.hash, recomputed, "Stored hash must match re-computed canonical hash");
    });
  });
});
