import fs from "node:fs/promises";
import path from "node:path";

import {
  type EventCard,
  type ExecutionCard,
  type FileArtifact,
  type MetaPatch,
  ArxivCorpusImportSchema,
  GithubCorpusImportSchema,
  LocalCorpusImportSchema,
  SyntheticCorpusImportSchema,
  buildEventHashPayload,
  buildExecutionHashPayload,
} from "./schema.js";
import { canonicalHash, canonicalizeText, hashText } from "./canonical.js";
import {
  mergeMeta,
  putBlob,
  putText,
  saveEventCard,
  saveExecutionCard,
  saveFileArtifactCard,
} from "./vault.js";

type LocalCorpusImportInput = {
  root_path: string;
  include_extensions?: string[];
  recursive?: boolean;
  tags?: string[];
  source_label?: string;
};

type GithubCorpusImportInput = {
  repo_url: string;
  branch?: string;
  path_filter?: string[];
  include_extensions?: string[];
  max_files?: number;
  tags?: string[];
  source_label?: string;
};

type ArxivCorpusImportInput = {
  query: string;
  max_results?: number;
  include_abstract_only?: boolean;
  tags?: string[];
  source_label?: string;
};

type SyntheticCorpusImportInput = {
  theme?: string;
  doc_count?: number;
  pipeline_count?: number;
  tags?: string[];
};

type ImportedDoc = {
  doc_id: string;
  card_id: string;
};

export type LocalCorpusImportResult = {
  imported_count: number;
  skipped_count: number;
  doc_ids: string[];
  errors: string[];
};

export type GithubCorpusImportResult = {
  imported_count: number;
  skipped_count: number;
  doc_ids: string[];
  source_summary: {
    repo_url: string;
    branch: string;
    scanned_paths: number;
  };
  errors: string[];
};

export type ArxivCorpusImportResult = {
  imported_count: number;
  doc_ids: string[];
  source_summary: {
    query: string;
    result_count: number;
  };
  errors: string[];
};

export type SyntheticCorpusImportResult = {
  imported_count: number;
  doc_ids: string[];
  generated_execution_count?: number;
  generated_event_count?: number;
  generated_execution_ids?: string[];
  generated_event_ids?: string[];
};

type IngestTextArtifactArgs = {
  relative_path: string;
  title: string;
  text: string;
  tags: string[];
  provenance_sources: SourceRef[];
  ingest_stats?: Record<string, number>;
};

type SyntheticDocSeed = {
  title: string;
  relative_path: string;
  text: string;
  pipeline: number;
};

type ArxivEntry = {
  id: string;
  title: string;
  summary: string;
  url: string;
};

type SourceRef = { kind: "url" | "note" | "file" | "system"; value: string };

const RAW_TEXT_EXTRACTOR = { name: "raw-utf8", version: "1.0.0" } as const;
const CORPUS_PIPELINE = "corpus_import.v0.1";

function normalizePosixPath(input: string): string {
  return input
    .split(path.sep)
    .join("/")
    .split("/")
    .filter((segment) => segment !== "." && segment !== ".." && segment !== "")
    .join("/");
}

function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "corpus";
}

function normalizeExtensions(exts: string[]): string[] {
  return [...new Set(exts.map((ext) => ext.trim().toLowerCase()).filter(Boolean))]
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
    .sort();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort();
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
  };
  return map[ext] ?? "text/plain";
}

function deriveTitleFromText(text: string, fallback: string): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading && heading.length > 0) return heading.slice(0, 140);

  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) return firstLine.slice(0, 140);
  return fallback;
}

function isProbablyText(data: Buffer): boolean {
  if (data.length === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0) return false;
    if ((byte < 7 || (byte > 13 && byte < 32)) && byte !== 9) suspicious++;
  }
  return suspicious / data.length < 0.05;
}

async function walkFiles(root: string, recursive: boolean): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) {
      files.push(full);
      continue;
    }
    if (recursive && entry.isDirectory()) {
      files.push(...(await walkFiles(full, recursive)));
    }
  }

  return files.sort((a, b) => normalizePosixPath(a).localeCompare(normalizePosixPath(b)));
}

function normalizeMetaSources(
  sources: SourceRef[],
): SourceRef[] {
  const dedup = new Map<string, SourceRef>();
  for (const source of sources) {
    const key = `${source.kind}\0${source.value}`;
    dedup.set(key, source);
  }
  return [...dedup.values()].sort((a, b) =>
    `${a.kind}\0${a.value}`.localeCompare(`${b.kind}\0${b.value}`),
  );
}

async function ingestTextArtifact(args: IngestTextArtifactArgs): Promise<ImportedDoc> {
  const ext = (path.posix.extname(args.relative_path) || ".txt").toLowerCase();
  const canonicalText = canonicalizeText(args.text);
  const contentBytes = Buffer.from(canonicalText, "utf-8");
  const canonicalTextHash = hashText(canonicalText);
  const normalizedPath = `corpus/${canonicalTextHash.slice(0, 24)}${ext}`;
  const contentTitle = deriveTitleFromText(canonicalText, "Imported document");

  const blob = await putBlob(contentBytes);
  const text = await putText(canonicalText);
  const tags = uniqueSorted(["file", ext.replace(/^\./, ""), ...args.tags]);

  const base: Omit<FileArtifact, "hash"> = {
    type: "file_artifact",
    spec_version: "1.0",
    title: contentTitle,
    tags,
    source: {
      relative_path: normalizedPath,
      original_name: path.posix.basename(normalizedPath),
    },
    blob: {
      hash: blob.hash,
      bytes: contentBytes.length,
      mime: mimeFromExt(ext),
    },
    text: {
      hash: text.hash,
      chars: text.canonical.length,
      extractor: RAW_TEXT_EXTRACTOR,
    },
  };

  const cardHash = canonicalHash(base as unknown as Record<string, unknown>);
  const card: FileArtifact = { ...base, hash: cardHash };
  const cardId = await saveFileArtifactCard(card);

  const metaSources = normalizeMetaSources(args.provenance_sources);
  if (metaSources.length > 0) {
    await mergeMeta(cardHash, "card", {
      sources: metaSources,
      ingest: {
        pipeline: CORPUS_PIPELINE,
        extractor: RAW_TEXT_EXTRACTOR.name,
        chunker: "none",
        stats: {
          chars: text.canonical.length,
          bytes: contentBytes.length,
          ...(args.ingest_stats ?? {}),
        },
      },
    });
  }

  return {
    doc_id: cardHash,
    card_id: cardId,
  };
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "rosetta-corpus-import/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "rosetta-corpus-import/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function parseGithubRepo(repoUrl: string): { owner: string; repo: string } {
  const parsed = new URL(repoUrl);
  if (parsed.hostname !== "github.com") {
    throw new Error(`Only github.com URLs are supported: ${repoUrl}`);
  }
  const [owner, rawRepo] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !rawRepo) {
    throw new Error(`Invalid GitHub repo URL: ${repoUrl}`);
  }
  return {
    owner,
    repo: rawRepo.replace(/\.git$/i, ""),
  };
}

function matchesPathFilters(filePath: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    const normalized = normalizePosixPath(filter);
    if (!normalized) return false;
    if (filePath === normalized) return true;
    if (normalized.endsWith("/")) return filePath.startsWith(normalized);
    return filePath.startsWith(normalized);
  });
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function xmlField(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return "";
  return decodeXmlEntities(match[1]).replace(/\s+/g, " ").trim();
}

function parseArxivFeed(xml: string): ArxivEntry[] {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries
    .map((entry): ArxivEntry | null => {
      const rawId = xmlField(entry, "id");
      const title = xmlField(entry, "title");
      const summary = xmlField(entry, "summary");
      if (!rawId || !title) return null;
      const id = rawId.split("/").pop() ?? rawId;
      return {
        id,
        title,
        summary,
        url: rawId,
      };
    })
    .filter((entry): entry is ArxivEntry => entry !== null);
}

function syntheticDocSeeds(theme: string, docCount: number, pipelineCount: number): SyntheticDocSeed[] {
  const themeSlug = slugify(theme);
  const docNames = Array.from({ length: docCount }, (_, i) => `doc-${String(i + 1).padStart(3, "0")}`);
  const seeds: SyntheticDocSeed[] = [];

  for (let i = 0; i < docCount; i++) {
    const docName = docNames[i];
    const refA = docNames[(i + 1) % docCount];
    const refB = docNames[(i + pipelineCount) % docCount];
    const pipeline = (i % pipelineCount) + 1;
    const title = `${theme} — ${docName}`;
    const text = [
      `# ${title}`,
      "",
      `This synthetic note belongs to pipeline-${pipeline} in the ${theme} test corpus.`,
      "",
      `Cross references: [[${refA}]], [[${refB}]].`,
      "",
      "Key claims:",
      `- Lane focus: pipeline-${pipeline}`,
      `- Hub key: ${themeSlug}-hub-${((i % pipelineCount) + 1).toString().padStart(2, "0")}`,
      `- Leaf key: ${themeSlug}-leaf-${String(i + 1).padStart(3, "0")}`,
      "",
      "Execution hints:",
      `- stage/import/${pipeline}`,
      `- stage/transform/${((pipeline % pipelineCount) + 1)}`,
      `- stage/validate/${((pipeline + 1) % pipelineCount) + 1}`,
      "",
    ].join("\n");

    seeds.push({
      title,
      relative_path: `synthetic/${themeSlug}/${docName}.md`,
      text,
      pipeline,
    });
  }

  return seeds;
}

async function generateSyntheticExecutionAndEvents(args: {
  theme: string;
  tags: string[];
  doc_ids: string[];
  pipeline_count: number;
}): Promise<{
  generated_execution_count: number;
  generated_event_count: number;
  generated_execution_ids: string[];
  generated_event_ids: string[];
}> {
  const themeSlug = slugify(args.theme);
  const rosetta = {
    verb: "Transform" as const,
    polarity: "+" as const,
    weights: { A: 0.2, C: 0.2, L: 0.2, P: 0.2, T: 0.2 },
  };
  const eventRosetta = {
    verb: "Contain" as const,
    polarity: "0" as const,
    weights: { A: 0.1, C: 0.5, L: 0.1, P: 0.2, T: 0.1 },
  };

  let generatedExecutionCount = 0;
  let generatedEventCount = 0;
  const generatedExecutionIds: string[] = [];
  const generatedEventIds: string[] = [];

  for (let pipeline = 1; pipeline <= args.pipeline_count; pipeline++) {
    const pipelineId = `synthetic:${themeSlug}:pipeline:${pipeline}`;
    const pipelineDocs = args.doc_ids.filter((_, index) => (index % args.pipeline_count) + 1 === pipeline);
    let previousExecutionHash: string | undefined;
    const refs: Array<{ ref_type: "artifact_id" | "url" | "external_id"; value: string }> = [];

    for (let stepIndex = 0; stepIndex < pipelineDocs.length; stepIndex++) {
      const docId = pipelineDocs[stepIndex];
      const base = buildExecutionHashPayload({
        title: `${args.theme} import stage ${pipeline}.${stepIndex + 1}`,
        summary: `Synthetic execution link for ${docId.slice(0, 12)} in ${pipelineId}.`,
        execution: {
          kind: "import",
          status: "succeeded",
          actor: { type: "agent", name: "corpus.synthetic" },
          target: { type: "artifact", name: docId },
          inputs: [{ ref_type: "external_id", value: pipelineId }],
          outputs: [{ ref_type: "artifact_id", value: docId }],
          validation: { state: "self_reported", method: "hash_check" },
          chain: {
            pipeline_id: pipelineId,
            step_index: stepIndex,
            parent_execution_id: previousExecutionHash,
          },
        },
        tags: uniqueSorted(["synthetic", "execution", ...args.tags, `pipeline:${pipeline}`]),
        rosetta,
      });
      const hash = canonicalHash(base as unknown as Record<string, unknown>);
      const execution: ExecutionCard = { ...base, hash };
      await saveExecutionCard(execution);
      generatedExecutionIds.push(hash);
      refs.push({ ref_type: "artifact_id", value: hash });
      previousExecutionHash = hash;
      generatedExecutionCount++;
    }

    const eventBase = buildEventHashPayload({
      title: `${args.theme} pipeline ${pipeline} synthesized`,
      summary: `Synthetic event anchor for ${pipelineId}.`,
      event: {
        kind: "research",
        status: "confirmed",
        severity: "info",
        confidence: 0.9,
        participants: [{ role: "agent", name: "corpus.synthetic" }],
        refs: [
          { ref_type: "external_id", value: pipelineId },
          ...refs.slice(0, 5),
        ],
      },
      tags: uniqueSorted(["synthetic", "event", ...args.tags, `pipeline:${pipeline}`]),
      rosetta: eventRosetta,
    });
    const eventHash = canonicalHash(eventBase as unknown as Record<string, unknown>);
    const eventCard: EventCard = { ...eventBase, hash: eventHash };
    await saveEventCard(eventCard);
    generatedEventIds.push(eventHash);
    generatedEventCount++;
  }

  return {
    generated_execution_count: generatedExecutionCount,
    generated_event_count: generatedEventCount,
    generated_execution_ids: generatedExecutionIds,
    generated_event_ids: generatedEventIds,
  };
}

export async function importLocalCorpus(options: LocalCorpusImportInput): Promise<LocalCorpusImportResult> {
  const parsed = LocalCorpusImportSchema.parse(options);
  const includeExtensions = normalizeExtensions(parsed.include_extensions);
  const tags = uniqueSorted(parsed.tags);
  const errors: string[] = [];
  const docIds: string[] = [];
  let skipped = 0;

  let files: string[];
  try {
    files = await walkFiles(parsed.root_path, parsed.recursive);
  } catch (error: any) {
    return {
      imported_count: 0,
      skipped_count: 0,
      doc_ids: [],
      errors: [`Failed to read root path "${parsed.root_path}": ${error.message}`],
    };
  }

  for (const absolutePath of files) {
    const ext = path.extname(absolutePath).toLowerCase();
    if (!includeExtensions.includes(ext)) {
      skipped++;
      continue;
    }

    try {
      const bytes = await fs.readFile(absolutePath);
      if (!isProbablyText(bytes)) {
        skipped++;
        continue;
      }
      const text = bytes.toString("utf-8");
      const relPath = normalizePosixPath(path.relative(parsed.root_path, absolutePath));
      const imported = await ingestTextArtifact({
        relative_path: `local/${relPath}`,
        title: path.basename(absolutePath),
        text,
        tags,
        provenance_sources: normalizeMetaSources([
          { kind: "file", value: `root:${normalizePosixPath(parsed.root_path)}` },
          { kind: "file", value: `path:${relPath}` },
          ...(parsed.source_label ? [{ kind: "note" as const, value: `source_label:${parsed.source_label}` }] : []),
        ]),
      });
      docIds.push(imported.doc_id);
    } catch (error: any) {
      errors.push(`${absolutePath}: ${error.message}`);
    }
  }

  return {
    imported_count: docIds.length,
    skipped_count: skipped,
    doc_ids: docIds,
    errors,
  };
}

export async function importGithubCorpus(options: GithubCorpusImportInput): Promise<GithubCorpusImportResult> {
  const parsed = GithubCorpusImportSchema.parse(options);
  const { owner, repo } = parseGithubRepo(parsed.repo_url);
  const includeExtensions = normalizeExtensions(parsed.include_extensions);
  const filters = parsed.path_filter.map((filter) => normalizePosixPath(filter));
  const tags = uniqueSorted(parsed.tags);
  const errors: string[] = [];
  const docIds: string[] = [];
  let skipped = 0;
  let branch = parsed.branch;
  let scannedPaths = 0;

  try {
    if (!branch) {
      const repoInfo = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`);
      branch = repoInfo.default_branch as string;
    }
    if (!branch) {
      throw new Error(`Unable to resolve default branch for ${parsed.repo_url}`);
    }

    const tree = await fetchJson(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const treeEntries: Array<{ path: string; type: string }> = Array.isArray(tree.tree)
      ? tree.tree
      : [];
    const selectedPaths = treeEntries
      .filter((entry) => entry && entry.type === "blob" && typeof entry.path === "string")
      .map((entry) => normalizePosixPath(entry.path))
      .filter((entryPath: string) =>
        includeExtensions.includes(path.posix.extname(entryPath).toLowerCase()),
      )
      .filter((entryPath: string) => matchesPathFilters(entryPath, filters))
      .sort()
      .slice(0, parsed.max_files);

    scannedPaths = selectedPaths.length;

    for (const entryPath of selectedPaths) {
      try {
        const encodedPath = entryPath
          .split("/")
          .map((segment: string) => encodeURIComponent(segment))
          .join("/");
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodedPath}`;
        const bytes = await fetchBytes(rawUrl);
        if (!isProbablyText(bytes)) {
          skipped++;
          continue;
        }
        const text = bytes.toString("utf-8");
        const imported = await ingestTextArtifact({
          relative_path: `github/${owner}/${repo}/${entryPath}`,
          title: path.posix.basename(entryPath),
          text,
          tags,
          provenance_sources: normalizeMetaSources([
            { kind: "url", value: parsed.repo_url },
            { kind: "url", value: `https://github.com/${owner}/${repo}/blob/${branch}/${entryPath}` },
            { kind: "note", value: `github_path:${entryPath}` },
            ...(parsed.source_label ? [{ kind: "note" as const, value: `source_label:${parsed.source_label}` }] : []),
          ]),
          ingest_stats: { source_scanned_paths: selectedPaths.length },
        });
        docIds.push(imported.doc_id);
      } catch (error: any) {
        errors.push(`${entryPath}: ${error.message}`);
      }
    }
  } catch (error: any) {
    errors.push(error.message);
  }

  return {
    imported_count: docIds.length,
    skipped_count: skipped,
    doc_ids: docIds,
    source_summary: {
      repo_url: parsed.repo_url,
      branch: branch ?? parsed.branch ?? "",
      scanned_paths: scannedPaths,
    },
    errors,
  };
}

export async function importArxivCorpus(options: ArxivCorpusImportInput): Promise<ArxivCorpusImportResult> {
  const parsed = ArxivCorpusImportSchema.parse(options);
  const tags = uniqueSorted(parsed.tags);
  const docIds: string[] = [];
  const errors: string[] = [];

  try {
    const query = encodeURIComponent(parsed.query);
    const url = `https://export.arxiv.org/api/query?search_query=all:${query}&start=0&max_results=${parsed.max_results}`;
    const xml = (await fetchBytes(url)).toString("utf-8");
    const entries = parseArxivFeed(xml).slice(0, parsed.max_results);
    const querySlug = slugify(parsed.query);

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      try {
        const abstract = parsed.include_abstract_only ? entry.summary : `${entry.summary}\n`;
        const text = `# ${entry.title}\n\n${abstract}\n`;
        const imported = await ingestTextArtifact({
          relative_path: `arxiv/${querySlug}/entry-${String(index + 1).padStart(3, "0")}.md`,
          title: entry.title,
          text,
          tags,
          provenance_sources: normalizeMetaSources([
            { kind: "url", value: entry.url },
            { kind: "note", value: `arxiv_id:${entry.id}` },
            { kind: "note", value: `query:${parsed.query}` },
            ...(parsed.source_label ? [{ kind: "note" as const, value: `source_label:${parsed.source_label}` }] : []),
          ]),
        });
        docIds.push(imported.doc_id);
      } catch (error: any) {
        errors.push(`${entry.id}: ${error.message}`);
      }
    }
  } catch (error: any) {
    errors.push(error.message);
  }

  return {
    imported_count: docIds.length,
    doc_ids: docIds,
    source_summary: {
      query: parsed.query,
      result_count: docIds.length,
    },
    errors,
  };
}

export async function generateSyntheticCorpus(options: SyntheticCorpusImportInput): Promise<SyntheticCorpusImportResult> {
  const parsed = SyntheticCorpusImportSchema.parse(options);
  const themeSlug = slugify(parsed.theme);
  const tags = uniqueSorted(["synthetic", `theme:${themeSlug}`, ...parsed.tags]);
  const seeds = syntheticDocSeeds(parsed.theme, parsed.doc_count, parsed.pipeline_count);
  const imported: ImportedDoc[] = [];

  for (const seed of seeds) {
    const doc = await ingestTextArtifact({
      relative_path: seed.relative_path,
      title: seed.title,
      text: seed.text,
      tags: uniqueSorted([...tags, `pipeline:${seed.pipeline}`]),
      provenance_sources: normalizeMetaSources([
        { kind: "system", value: "synthetic:v0.1" },
        { kind: "note", value: `theme:${parsed.theme}` },
        { kind: "note", value: `pipeline:${seed.pipeline}` },
      ]),
    });
    imported.push(doc);
  }

  const syntheticGraph = await generateSyntheticExecutionAndEvents({
    theme: parsed.theme,
    tags,
    doc_ids: imported.map((doc) => doc.doc_id),
    pipeline_count: parsed.pipeline_count,
  });

  return {
    imported_count: imported.length,
    doc_ids: imported.map((doc) => doc.doc_id),
    generated_execution_count: syntheticGraph.generated_execution_count,
    generated_event_count: syntheticGraph.generated_event_count,
    generated_execution_ids: syntheticGraph.generated_execution_ids,
    generated_event_ids: syntheticGraph.generated_event_ids,
  };
}
