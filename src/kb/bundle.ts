import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { CardPayload } from "./schema.js";
import { verifyHash } from "./canonical.js";

const ROOT = process.cwd();
const CARD_DIR = path.join(ROOT, "data", "cards");
const BUNDLE_DIR = path.join(ROOT, "data", "bundles");

export type BundleMeta = {
  version: "bundle.v1";
  bundle_id: string;
  description?: string;
  license_spdx?: string;
  created_by?: { name?: string };
  created_at: string;
  card_count: number;
  integrity_hash: string;
};

export type BundleManifest = BundleMeta & {
  cards: { card_id: string; hash: string }[];
};

async function ensureBundleDir() {
  await fs.mkdir(BUNDLE_DIR, { recursive: true });
}

export async function exportBundle(args: {
  card_ids: string[];
  include_png?: boolean;
  meta?: {
    description?: string;
    license_spdx?: string;
    created_by?: { name?: string };
  };
}): Promise<{ bundle_path: string; manifest: BundleManifest }> {
  await ensureBundleDir();

  const bundle_id = "bundle_" + crypto.randomUUID();
  const bundlePath = path.join(BUNDLE_DIR, bundle_id);
  const cardsOut = path.join(bundlePath, "cards");
  await fs.mkdir(cardsOut, { recursive: true });

  const cards: { card_id: string; hash: string }[] = [];

  for (const card_id of args.card_ids) {
    const jsonSrc = path.join(CARD_DIR, `${card_id}.json`);
    const raw = await fs.readFile(jsonSrc, "utf-8");
    const payload: CardPayload = JSON.parse(raw);
    cards.push({ card_id: payload.card_id, hash: payload.hash });

    await fs.copyFile(jsonSrc, path.join(cardsOut, `${card_id}.json`));

    if (args.include_png) {
      const pngSrc = path.join(CARD_DIR, `${card_id}.png`);
      try {
        await fs.copyFile(pngSrc, path.join(cardsOut, `${card_id}.png`));
      } catch {
        // PNG might not exist, skip
      }
    }
  }

  const integrityPayload = cards
    .map((c) => `${c.card_id}:${c.hash}`)
    .sort()
    .join("\n");
  const integrity_hash = crypto
    .createHash("sha256")
    .update(integrityPayload)
    .digest("hex");

  const manifest: BundleManifest = {
    version: "bundle.v1",
    bundle_id,
    description: args.meta?.description,
    license_spdx: args.meta?.license_spdx,
    created_by: args.meta?.created_by,
    created_at: new Date().toISOString(),
    card_count: cards.length,
    integrity_hash,
    cards,
  };

  await fs.writeFile(
    path.join(bundlePath, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  return { bundle_path: bundlePath, manifest };
}

export type ImportResult = {
  imported: number;
  skipped: number;
  failed: string[];
  integrity_ok: boolean;
};

export async function importBundle(bundlePath: string): Promise<ImportResult> {
  await fs.mkdir(CARD_DIR, { recursive: true });

  const manifestRaw = await fs.readFile(
    path.join(bundlePath, "manifest.json"),
    "utf-8"
  );
  const manifest: BundleManifest = JSON.parse(manifestRaw);

  // Verify integrity
  const integrityPayload = manifest.cards
    .map((c) => `${c.card_id}:${c.hash}`)
    .sort()
    .join("\n");
  const computedHash = crypto
    .createHash("sha256")
    .update(integrityPayload)
    .digest("hex");
  const integrity_ok = computedHash === manifest.integrity_hash;

  let imported = 0;
  let skipped = 0;
  const failed: string[] = [];
  const cardsDir = path.join(bundlePath, "cards");

  for (const entry of manifest.cards) {
    const srcJson = path.join(cardsDir, `${entry.card_id}.json`);
    const destJson = path.join(CARD_DIR, `${entry.card_id}.json`);

    try {
      // Check if card already exists
      try {
        await fs.access(destJson);
        skipped++;
        continue;
      } catch {
        // Doesn't exist yet — import it
      }

      const raw = await fs.readFile(srcJson, "utf-8");
      const payload: CardPayload = JSON.parse(raw);

      // Verify individual card hash matches manifest
      if (payload.hash !== entry.hash) {
        failed.push(entry.card_id);
        continue;
      }

      // Verify card content actually produces the stored hash
      const verification = verifyHash(payload as unknown as Record<string, unknown>, "hash");
      if (!verification.valid) {
        failed.push(entry.card_id);
        continue;
      }

      await fs.writeFile(destJson, raw, "utf-8");

      // Copy PNG if present
      const srcPng = path.join(cardsDir, `${entry.card_id}.png`);
      try {
        await fs.copyFile(srcPng, path.join(CARD_DIR, `${entry.card_id}.png`));
      } catch {
        // No PNG in bundle
      }

      imported++;
    } catch {
      failed.push(entry.card_id);
    }
  }

  return { imported, skipped, failed, integrity_ok };
}

export async function listBundles(): Promise<BundleMeta[]> {
  await ensureBundleDir();
  const entries = await fs.readdir(BUNDLE_DIR, { withFileTypes: true });
  const bundles: BundleMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(
        path.join(BUNDLE_DIR, entry.name, "manifest.json"),
        "utf-8"
      );
      const manifest: BundleManifest = JSON.parse(raw);
      const { cards: _, ...meta } = manifest;
      bundles.push(meta);
    } catch {
      // Skip invalid bundles
    }
  }

  return bundles;
}
