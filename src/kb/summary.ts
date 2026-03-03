/**
 * Weekly Summary artifact — a deterministic synthesis derived from a set of
 * referenced event and card hashes for a given ISO calendar week.
 *
 * Identity rule: hash = canonicalHash(all fields except hash).
 * References are sorted before hashing; week_start is normalized to Monday.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { canonicalHash } from "./canonical.js";
import { WeeklySummarySchema, type WeeklySummary } from "./schema.js";

function summaryDir(): string {
  return path.join(process.env.VAULT_ROOT ?? process.cwd(), "data", "summaries");
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an input date string to the Monday of its ISO calendar week.
 * Input can be any ISO 8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ).
 * Output is always YYYY-MM-DD (UTC).
 */
export function toWeekStart(dateStr: string): string {
  // Parse as UTC midnight
  const raw = dateStr.slice(0, 10); // take YYYY-MM-DD portion
  const d = new Date(`${raw}T00:00:00Z`);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${dateStr}`);
  }
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, … 6 = Sat
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offsetToMonday);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute week_end (Sunday) from a normalized week_start (Monday).
 */
export function toWeekEnd(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Create + persist
// ---------------------------------------------------------------------------

export interface CreateWeeklySummaryArgs {
  week_start: string;           // any date — will be normalized to Monday
  references: {
    events?: string[];          // artifact hashes — will be sorted
    cards?: string[];           // artifact hashes — will be sorted
  };
  highlights: string[];
  decisions: string[];
  open_loops: string[];
  risks: string[];
  rosetta_balance?: { A: number; C: number; L: number; P: number; T: number };
}

export async function createWeeklySummary(
  args: CreateWeeklySummaryArgs,
): Promise<WeeklySummary> {
  const week_start = toWeekStart(args.week_start);
  const week_end = toWeekEnd(week_start);

  // Sort references for determinism regardless of input order
  const events = [...(args.references.events ?? [])].sort();
  const cards = [...(args.references.cards ?? [])].sort();

  // Build hash payload (all fields except hash itself)
  const payload: Omit<WeeklySummary, "hash"> = {
    schema_version: "summary.week.v1",
    week_start,
    week_end,
    references: { events, cards },
    highlights: args.highlights,
    decisions: args.decisions,
    open_loops: args.open_loops,
    risks: args.risks,
    ...(args.rosetta_balance ? { rosetta_balance: args.rosetta_balance } : {}),
  };

  const hash = canonicalHash(payload as unknown as Record<string, unknown>);
  const summary: WeeklySummary = WeeklySummarySchema.parse({ ...payload, hash });

  const dir = summaryDir();
  await fs.mkdir(dir, { recursive: true });
  const filename = `summary_week_${hash.slice(0, 12)}.json`;
  await fs.writeFile(
    path.join(dir, filename),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );

  return summary;
}

export async function loadWeeklySummary(hash: string): Promise<WeeklySummary | null> {
  try {
    const raw = await fs.readFile(
      path.join(summaryDir(), `summary_week_${hash.slice(0, 12)}.json`),
      "utf-8",
    );
    return WeeklySummarySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
