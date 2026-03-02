import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createBehaviorPack,
  setActivePack,
  deleteBehaviorPack,
  getActivePack,
  PolicyViolationError,
} from "../src/kb/vault.js";

import { ingestFolderHook, drainContextHook } from "../src/kb/hooks.js";

const TMP_DIR = path.join(process.cwd(), "data", "tmp_block_test");

describe("Behavior Pack blocked_tags enforcement", () => {
  before(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
  });

  after(async () => {
    // cleanup temp dir
    await fs.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});

    // clear active pack if any
    const active = await getActivePack();
    if (active) {
      await setActivePack(null);
      await deleteBehaviorPack(active).catch(() => {});
    }
  });

  it("blocks ingestion of files whose automatic tags match blocked_tags (pdf)", async () => {
    // create pack that blocks 'pdf'
    const pack = await createBehaviorPack({
      name: "Block PDFs",
      card_ids: [],
      policies: { search_boost: 0.1, blocked_tags: ["pdf"] },
    });
    await setActivePack(pack.pack_id);

    // create a dummy .pdf file (content doesn't have to be valid pdf)
    const filePath = path.join(TMP_DIR, "sample.pdf");
    await fs.writeFile(filePath, "%PDF-1.4\n%Dummy", "utf-8");

    // ingest folder should reject with PolicyViolationError
    await assert.rejects(async () => {
      await ingestFolderHook({ path: TMP_DIR });
    }, (err: any) => {
      return err && err.name === "PolicyViolationError";
    });

    // cleanup pack
    await setActivePack(null);
    await deleteBehaviorPack(pack.pack_id).catch(() => {});
  });

  it("blocks drainContextHook when tags include blocked tag", async () => {
    const pack = await createBehaviorPack({
      name: "Block Secret",
      card_ids: [],
      policies: { search_boost: 0.1, blocked_tags: ["secret"] },
    });
    await setActivePack(pack.pack_id);

    await assert.rejects(async () => {
      await drainContextHook({
        title: "Secret chat",
        tags: ["secret"],
        chatText: "This is a secret message repeated many times.\n\nA second para.",
        targetMaxChars: 1, // force immediate drain
      });
    }, (err: any) => {
      return err && err.name === "PolicyViolationError";
    });

    await setActivePack(null);
    await deleteBehaviorPack(pack.pack_id).catch(() => {});
  });
});
