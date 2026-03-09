/**
 * Progressive summarization layer — bridges ephemeral conversation
 * context and persistent vault artifacts.
 *
 * Age bands:
 *   Band 0 (last 5 turns)  — verbatim event artifacts
 *   Band 1 (turns 6-20)    — light summaries
 *   Band 2 (turns 20+)     — extracted facts/skills only
 *
 * All artifacts flow through vault.put — content-addressed, deduped,
 * searchable via memory:* tags.
 */

import {
  vaultPut,
  vaultSearch,
  vaultGet,
  type PutResult,
} from "../vault/store.js";
import type { ArtifactRef } from "../vault/schema.js";

// ── Band configuration ──────────────────────────────────────────────────────

export const BAND_THRESHOLDS = {
  /** Band 0: verbatim turns [0, BAND0_MAX) from the latest */
  BAND0_MAX: 5,
  /** Band 1: light summaries [BAND0_MAX, BAND1_MAX) from the latest */
  BAND1_MAX: 20,
  /** Band 2: everything older than BAND1_MAX */
} as const;

const CHARS_PER_TOKEN = 4;

export type Turn = {
  role: string;
  content: string;
  turn_number: number;
};

// ── Band classification ─────────────────────────────────────────────────────

export function classifyBand(
  turnNumber: number,
  latestTurn: number,
): 0 | 1 | 2 {
  const age = latestTurn - turnNumber;
  if (age < BAND_THRESHOLDS.BAND0_MAX) return 0;
  if (age < BAND_THRESHOLDS.BAND1_MAX) return 1;
  return 2;
}

function bandTags(band: 0 | 1 | 2): string[] {
  const base = ["memory:managed"];
  if (band === 0) return [...base, "memory:verbatim", "memory:band0"];
  if (band === 1) return [...base, "memory:summary", "memory:band1"];
  return [...base, "memory:extracted", "memory:band2"];
}

// ── Ingest a single conversation turn ───────────────────────────────────────

/**
 * Store a conversation turn as a vault artifact.
 * Returns the content-addressed artifact ID.
 */
export async function ingestTurn(
  turn: Turn,
  sessionId: string,
): Promise<string> {
  const result = await vaultPut({
    kind: "event",
    payload: {
      role: turn.role,
      content: turn.content,
      turn_number: turn.turn_number,
      session_id: sessionId,
    },
    tags: [
      ...bandTags(0),
      `memory:session:${sessionId}`,
      `memory:turn:${turn.turn_number}`,
    ],
    refs: [],
    source: { agent: "forge-memory", tool: "memory.ingest_turn" },
  });
  return result.id;
}

// ── Compact bands ───────────────────────────────────────────────────────────

/**
 * Summarize a set of verbatim turn contents into a compact text.
 * Naive implementation: concatenate and truncate.
 * Replace with LLM summarization when available.
 */
function naiveSummarize(turns: Array<{ role: string; content: string }>): string {
  const lines = turns.map(
    (t) => `[${t.role}]: ${t.content.replace(/\n/g, " ").trim()}`,
  );
  const joined = lines.join("\n");
  if (joined.length <= 500) return joined;
  return joined.slice(0, 497) + "...";
}

/**
 * Extract fact-like claims from summarized content.
 * Naive implementation: split into sentences and take substantive ones.
 * Replace with LLM extraction when available.
 */
function naiveExtractFacts(summaryText: string): string[] {
  const sentences = summaryText
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  return sentences.slice(0, 10);
}

export type CompactResult = {
  promoted: number;
  archived: number;
};

/**
 * Promote artifacts aging out of a band.
 *
 * Band 0 → Band 1: verbatim turns become summaries
 * Band 1 → Band 2: summaries become extracted facts
 * Band 2: no-op (terminal band)
 */
export async function compactBand(
  band: 0 | 1 | 2,
  sessionId: string,
  latestTurn: number,
): Promise<CompactResult> {
  if (band === 2) return { promoted: 0, archived: 0 };

  const sourceTag = band === 0 ? "memory:band0" : "memory:band1";
  const sessionTag = `memory:session:${sessionId}`;

  // Find artifacts in this band for this session
  const searchResult = await vaultSearch({
    tags: [sourceTag, sessionTag],
    limit: 100,
    search_mode: "lexical",
  });

  if (searchResult.results.length === 0) {
    return { promoted: 0, archived: 0 };
  }

  // Load full envelopes to get payloads
  const envelopes = await Promise.all(
    searchResult.results.map((r) => vaultGet(r.id)),
  );
  const validEnvelopes = envelopes.filter((e) => e !== null);

  // Filter to artifacts that have aged out of their current band
  const agedOut = validEnvelopes.filter((e) => {
    const turnNum = e.payload.turn_number as number | undefined;
    if (turnNum === undefined) return true; // summaries without turn numbers always compact
    return classifyBand(turnNum, latestTurn) > band;
  });

  if (agedOut.length === 0) {
    return { promoted: 0, archived: 0 };
  }

  let promoted = 0;

  if (band === 0) {
    // Band 0 → Band 1: create summary from aged-out verbatim turns
    const turnContents = agedOut
      .map((e) => ({
        role: String(e.payload.role ?? "unknown"),
        content: String(e.payload.content ?? ""),
        turn_number: (e.payload.turn_number as number) ?? 0,
      }))
      .sort((a, b) => a.turn_number - b.turn_number);

    const summaryText = naiveSummarize(turnContents);
    const turnRange = `${turnContents[0].turn_number}-${turnContents[turnContents.length - 1].turn_number}`;
    const sourceRefs: ArtifactRef[] = agedOut.map((e) => ({
      kind: "event",
      id: e.id,
    }));

    await vaultPut({
      kind: "summary",
      payload: {
        summary: summaryText,
        turn_range: turnRange,
        turn_count: turnContents.length,
        session_id: sessionId,
      },
      tags: [
        ...bandTags(1),
        `memory:session:${sessionId}`,
        `memory:range:${turnRange}`,
      ],
      refs: sourceRefs,
      source: { agent: "forge-memory", tool: "memory.compact" },
    });
    promoted = 1;
  } else {
    // Band 1 → Band 2: extract facts from summaries
    for (const envelope of agedOut) {
      const summaryText = String(envelope.payload.summary ?? "");
      const facts = naiveExtractFacts(summaryText);

      for (const claim of facts) {
        await vaultPut({
          kind: "fact",
          payload: {
            claim,
            source_summary_id: envelope.id,
            session_id: sessionId,
          },
          tags: [
            ...bandTags(2),
            `memory:session:${sessionId}`,
          ],
          refs: [{ kind: "summary", id: envelope.id }],
          source: { agent: "forge-memory", tool: "memory.compact" },
        });
        promoted++;
      }
    }
  }

  return { promoted, archived: agedOut.length };
}

// ── Reconstruct context window ──────────────────────────────────────────────

/**
 * Reconstruct a context string from memory artifacts, fitting within
 * a token budget. Pulls Band 0 verbatim, Band 1 summaries, Band 2 facts.
 *
 * Approximate: 4 chars ≈ 1 token.
 */
export async function getContextWindow(
  sessionId: string,
  tokenBudget: number,
): Promise<string> {
  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const parts: string[] = [];
  let charsUsed = 0;

  // Band 0: verbatim turns (most recent, highest priority)
  const band0 = await vaultSearch({
    tags: ["memory:band0", `memory:session:${sessionId}`],
    limit: BAND_THRESHOLDS.BAND0_MAX,
    search_mode: "lexical",
  });

  const band0Envelopes = await Promise.all(
    band0.results.map((r) => vaultGet(r.id)),
  );
  const band0Turns = band0Envelopes
    .filter((e) => e !== null)
    .map((e) => ({
      turn_number: (e.payload.turn_number as number) ?? 0,
      role: String(e.payload.role ?? "unknown"),
      content: String(e.payload.content ?? ""),
    }))
    .sort((a, b) => a.turn_number - b.turn_number);

  for (const turn of band0Turns) {
    const line = `[Turn ${turn.turn_number}] ${turn.role}: ${turn.content}`;
    if (charsUsed + line.length > charBudget) break;
    parts.push(line);
    charsUsed += line.length + 1; // +1 for newline
  }

  // Band 1: summaries
  if (charsUsed < charBudget) {
    const band1 = await vaultSearch({
      tags: ["memory:band1", `memory:session:${sessionId}`],
      limit: 20,
      search_mode: "lexical",
    });

    const band1Envelopes = await Promise.all(
      band1.results.map((r) => vaultGet(r.id)),
    );

    for (const e of band1Envelopes) {
      if (!e) continue;
      const summary = String(e.payload.summary ?? "");
      const range = String(e.payload.turn_range ?? "?");
      const line = `[Summary turns ${range}]: ${summary}`;
      if (charsUsed + line.length > charBudget) break;
      parts.push(line);
      charsUsed += line.length + 1;
    }
  }

  // Band 2: extracted facts
  if (charsUsed < charBudget) {
    const band2 = await vaultSearch({
      tags: ["memory:band2", `memory:session:${sessionId}`],
      limit: 50,
      search_mode: "lexical",
    });

    const band2Envelopes = await Promise.all(
      band2.results.map((r) => vaultGet(r.id)),
    );

    const factLines: string[] = [];
    for (const e of band2Envelopes) {
      if (!e) continue;
      factLines.push(`- ${String(e.payload.claim ?? "")}`);
    }

    if (factLines.length > 0) {
      const factsBlock = "[Extracted facts]:\n" + factLines.join("\n");
      if (charsUsed + factsBlock.length <= charBudget) {
        parts.push(factsBlock);
        charsUsed += factsBlock.length + 1;
      } else {
        // Fit as many facts as we can
        parts.push("[Extracted facts]:");
        charsUsed += "[Extracted facts]:".length + 1;
        for (const line of factLines) {
          if (charsUsed + line.length > charBudget) break;
          parts.push(line);
          charsUsed += line.length + 1;
        }
      }
    }
  }

  return parts.join("\n");
}
