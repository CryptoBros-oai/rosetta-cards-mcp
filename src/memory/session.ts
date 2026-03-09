/**
 * Session lifecycle — tracks active conversation session state.
 *
 * Persists to .vault/session_state.json (Tier 1 — mutable, not hashed).
 * This is ephemeral session metadata, not a content-addressed artifact.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ── Types ───────────────────────────────────────────────────────────────────

export type SessionState = {
  session_id: string;
  started_at: string;
  turn_count: number;
  last_turn_at: string;
  active: boolean;
};

// ── Path helpers ────────────────────────────────────────────────────────────

function vaultRoot(): string {
  return process.env.ARTIFACT_VAULT_ROOT ?? path.join(process.cwd(), ".vault");
}

function sessionPath(): string {
  return path.join(vaultRoot(), "session_state.json");
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function readState(): Promise<SessionState | null> {
  try {
    const raw = await fsp.readFile(sessionPath(), "utf-8");
    return JSON.parse(raw) as SessionState;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeState(state: SessionState): Promise<void> {
  await fsp.mkdir(path.dirname(sessionPath()), { recursive: true });
  await fsp.writeFile(sessionPath(), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a new session. If a session is already active, it is ended first.
 * Returns the new session state.
 */
export async function startSession(): Promise<SessionState> {
  const existing = await readState();
  if (existing?.active) {
    await endSession();
  }

  const state: SessionState = {
    session_id: crypto.randomUUID(),
    started_at: new Date().toISOString(),
    turn_count: 0,
    last_turn_at: new Date().toISOString(),
    active: true,
  };
  await writeState(state);
  return state;
}

/**
 * End the current session. No-op if no active session.
 * Returns the final session state, or null if no session was active.
 */
export async function endSession(): Promise<SessionState | null> {
  const state = await readState();
  if (!state || !state.active) return null;

  state.active = false;
  state.last_turn_at = new Date().toISOString();
  await writeState(state);
  return state;
}

/**
 * Get the current session state. Returns null if no session file exists.
 */
export async function getSession(): Promise<SessionState | null> {
  return readState();
}

/**
 * Increment the turn count and update last_turn_at.
 * Returns updated session state.
 * Throws if no active session.
 */
export async function recordTurn(): Promise<SessionState> {
  const state = await readState();
  if (!state || !state.active) {
    throw new Error("No active session. Call startSession() first.");
  }

  state.turn_count++;
  state.last_turn_at = new Date().toISOString();
  await writeState(state);
  return state;
}
