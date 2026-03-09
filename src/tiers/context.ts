/**
 * Tier context — resolves the current NFT tier from environment.
 *
 * When running locally (no THREADFORGE_TIER set), defaults to "gold"
 * so there are no restrictions during development.
 *
 * When running as a ThreadForge node, the THREADFORGE_TIER env var
 * is set by the NFT verification layer.
 */

import { type Tier, isTier } from "./policy.js";

/**
 * Get the current tier from the THREADFORGE_TIER env var.
 * Defaults to "gold" (unrestricted local dev).
 */
export function getCurrentTier(): Tier {
  const raw = process.env.THREADFORGE_TIER?.toLowerCase();
  if (raw && isTier(raw)) return raw;
  return "gold";
}
