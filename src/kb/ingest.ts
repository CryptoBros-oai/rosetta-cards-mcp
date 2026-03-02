/**
 * File and folder ingestion into the Vault.
 *
 * Produces:
 *   1) blob record (raw bytes, content-addressed)
 *   2) text extract record (canonical text) when supported
 *   3) a file artifact card per file
 *   4) a folder index card summarizing the import
 */

import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import {
  type FileArtifact,
  type FolderIndex,
  type FolderFileEntry,
  type FolderCounts,
  type BlobRef,
  type TextRef,
} from "./schema.js";
import {
  canonicalHash,
  hashBytes,
  hashText,
  canonicalizeText,
} from "./canonical.js";
import {
  putBlob,
  putText,
  saveFileArtifactCard,
  saveFolderIndexCard,
  saveIngestReportCard,
} from "./vault.js";
import { getVaultContext, enforceBlockedTags, PolicyViolationError } from "./vault.js";
import type {
  IngestReport,
  IngestReportFileEntry,
} from "./schema.js";

// Mammoth version for extractor provenance
const MAMMOTH_VERSION = "1.11.0";
// pdf-parse version
const PDF_PARSE_VERSION = "2.4.5";

export type FileIngestResult = {
  relative_path: string;
  card_id: string;
  blob_hash: string;
  text_hash?: string;
  card_hash: string;
  bytes: number;
  mime: string;
  error?: string;
};

export type FolderIngestResult = {
  folder_card_id: string;
  folder_card_hash: string;
  files: FileIngestResult[];
  counts: FolderCounts;
  report_card_id?: string;
  report_card_hash?: string;
};

/**
 * Normalize a relative path to POSIX format per INGESTION.md §5.2:
 *  - use `/` separators
 *  - no leading `./`
 *  - no `..` segments
 */
function normalizePosixPath(relPath: string): string {
  let p = relPath.split(path.sep).join("/");
  if (p.startsWith("./")) p = p.slice(2);
  return p
    .split("/")
    .filter((seg) => seg !== "." && seg !== ".." && seg !== "")
    .join("/");
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".html": "text/html",
    ".htm": "text/html",
    ".xml": "application/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".ts": "text/typescript",
    ".js": "text/javascript",
    ".py": "text/x-python",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Extract text from a DOCX file using mammoth.
 */
async function extractDocxText(
  filePath: string
): Promise<{ text: string; extractor: { name: string; version: string } }> {
  const result = await mammoth.extractRawText({ path: filePath });
  return {
    text: result.value,
    extractor: { name: "mammoth", version: MAMMOTH_VERSION },
  };
}

/**
 * Extract text from a PDF file using pdf-parse v2.
 */
async function extractPdfText(
  data: Buffer
): Promise<{ text: string; extractor: { name: string; version: string } }> {
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  await parser.destroy();
  return {
    text: result.text,
    extractor: { name: "pdf-parse", version: PDF_PARSE_VERSION },
  };
}

/**
 * Extract text from a plain-text file.
 */
async function extractPlainText(
  data: Buffer
): Promise<{ text: string; extractor: { name: string; version: string } }> {
  return {
    text: data.toString("utf-8"),
    extractor: { name: "raw-utf8", version: "1.0.0" },
  };
}

/**
 * Ingest a single file into the vault.
 */
export async function ingestFile(
  absPath: string,
  relPath: string,
  options?: {
    includeDocxText?: boolean;
    includePdfText?: boolean;
    storeBlobs?: boolean;
    extraTags?: string[];
  }
): Promise<FileIngestResult> {
  const opts = {
    includeDocxText: options?.includeDocxText ?? true,
    includePdfText: options?.includePdfText ?? true,
    storeBlobs: options?.storeBlobs ?? true,
    extraTags: options?.extraTags ?? [],
  };

  const ext = path.extname(absPath).toLowerCase();
  const mime = mimeFromExt(ext);
  const rawData = await fs.readFile(absPath);
  const bytes = rawData.length;

  // Store blob
  const blobResult = opts.storeBlobs
    ? await putBlob(rawData)
    : { hash: hashBytes(rawData), path: "" };
  const blobRef: BlobRef = {
    hash: blobResult.hash,
    bytes,
    mime,
  };

  // Extract text if supported
  let textRef: TextRef | undefined;
  try {
    let extracted: { text: string; extractor: { name: string; version: string } } | null = null;

    if (ext === ".docx" && opts.includeDocxText) {
      extracted = await extractDocxText(absPath);
    } else if (ext === ".pdf" && opts.includePdfText) {
      extracted = await extractPdfText(rawData);
    } else if (
      [".txt", ".md", ".csv", ".html", ".htm", ".xml", ".yaml", ".yml", ".ts", ".js", ".py", ".json"].includes(ext)
    ) {
      extracted = await extractPlainText(rawData);
    }

    if (extracted && extracted.text.trim().length > 0) {
      const textResult = await putText(extracted.text);
      textRef = {
        hash: textResult.hash,
        chars: canonicalizeText(extracted.text).length,
        extractor: extracted.extractor,
      };
    }
  } catch {
    // text extraction failed — continue without text
  }

  // Build file artifact card (created_at excluded from hash per FORMAT.md)
  const originalName = path.basename(absPath);
  const tags = Array.from(new Set(["file", ext.replace(".", ""), ...opts.extraTags]));

  // Enforce pack blocked_tags on final tag set (prevents automatic tags like file/pdf)
  try {
    const ctx = await getVaultContext();
    enforceBlockedTags(tags, ctx.policies.blocked_tags);
  } catch (err) {
    if (err instanceof PolicyViolationError) throw err;
    throw err;
  }
  const base: Omit<FileArtifact, "hash"> = {
    type: "file_artifact",
    spec_version: "1.0",
    title: originalName,
    tags,
    source: { relative_path: normalizePosixPath(relPath), original_name: originalName },
    blob: blobRef,
    ...(textRef ? { text: textRef } : {}),
  };

  const cardHash = canonicalHash(base as unknown as Record<string, unknown>);
  const artifact: FileArtifact = { ...base, hash: cardHash };
  const cardId = await saveFileArtifactCard(artifact);

  return {
    relative_path: normalizePosixPath(relPath),
    card_id: cardId,
    blob_hash: blobRef.hash,
    text_hash: textRef?.hash,
    card_hash: cardHash,
    bytes,
    mime,
  };
}

/**
 * Recursively list all files in a directory.
 */
async function walkDir(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDir(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * Ingest an entire folder into the vault.
 */
export async function ingestFolder(
  absFolderPath: string,
  options?: {
    includeDocxText?: boolean;
    includePdfText?: boolean;
    storeBlobs?: boolean;
    extraTags?: string[];
  }
): Promise<FolderIngestResult> {
  const allFiles = await walkDir(absFolderPath);
  const folderName = path.basename(absFolderPath);

  const fileResults: FileIngestResult[] = [];
  let docxCount = 0;
  let pdfCount = 0;
  let otherCount = 0;
  let textCount = 0;

  for (const absFile of allFiles) {
    const relPath = normalizePosixPath(path.relative(absFolderPath, absFile));
    const ext = path.extname(absFile).toLowerCase();

    if (ext === ".docx") docxCount++;
    else if (ext === ".pdf") pdfCount++;
    else otherCount++;

    try {
      const result = await ingestFile(absFile, relPath, options);
      if (result.text_hash) textCount++;
      fileResults.push(result);
    } catch (err: any) {
      // Bubble up policy violations so hooks can reject the whole folder import.
      if (err instanceof PolicyViolationError) throw err;

      fileResults.push({
        relative_path: relPath,
        card_id: "",
        blob_hash: "",
        card_hash: "",
        bytes: 0,
        mime: mimeFromExt(ext),
        error: err.message,
      });
    }
  }

  const counts: FolderCounts = {
    files_total: allFiles.length,
    docx: docxCount,
    pdf: pdfCount,
    other: otherCount,
    extracted_text_count: textCount,
  };

  const folderFiles: FolderFileEntry[] = fileResults
    .filter((r) => !r.error)
    .map((r) => ({
      relative_path: r.relative_path,
      blob_hash: r.blob_hash,
      text_hash: r.text_hash,
      card_hash: r.card_hash,
      bytes: r.bytes,
      mime: r.mime,
    }));

  const base: Omit<FolderIndex, "hash"> = {
    type: "folder_index",
    spec_version: "1.0",
    title: folderName,
    source: { root_path: folderName },
    files: folderFiles,
    counts,
  };

  const folderHash = canonicalHash(base as unknown as Record<string, unknown>);
  const folderIndex: FolderIndex = { ...base, hash: folderHash };
  const folderCardId = await saveFolderIndexCard(folderIndex);

  // Build ingest report card
  const reportFiles: IngestReportFileEntry[] = fileResults.map((r) => ({
    relative_path: r.relative_path,
    card_hash: r.card_hash,
    blob_hash: r.blob_hash,
    text_hash: r.text_hash,
    bytes: r.bytes,
    mime: r.mime,
    ...(r.error ? { error: r.error } : {}),
  }));

  const extraTags = options?.extraTags ?? [];
  const reportBase: Omit<IngestReport, "hash"> = {
    type: "ingest_report",
    spec_version: "1.0",
    title: `Ingest: ${folderName}`,
    tags: Array.from(new Set(["ingest", "report", ...extraTags])),
    source: { root_path: folderName },
    folder_card_hash: folderHash,
    files: reportFiles,
    counts,
  };

  const reportHash = canonicalHash(reportBase as unknown as Record<string, unknown>);
  const report: IngestReport = { ...reportBase, hash: reportHash };
  const reportCardId = await saveIngestReportCard(report);

  return {
    folder_card_id: folderCardId,
    folder_card_hash: folderHash,
    files: fileResults,
    counts,
    report_card_id: reportCardId,
    report_card_hash: reportHash,
  };
}
