#!/usr/bin/env node
/**
 * Simple ingestion demo: runs `ingestFolderHook` on `examples/sample_docs`
 * and prints the resulting folder ingest report.
 */
import path from "node:path";
import { ingestFolderHook } from "../src/kb/hooks.js";

async function main() {
  const dir = path.join(process.cwd(), "examples", "sample_docs");
  console.log("Ingesting folder:", dir);
  const res = await ingestFolderHook({ path: dir, includeDocxText: false, includePdfText: false, storeBlobs: false });
  console.log("Ingest result:", JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error("Ingest demo failed:", err);
  process.exit(1);
});
