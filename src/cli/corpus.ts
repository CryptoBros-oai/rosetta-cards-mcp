import {
  runArxivCorpusImport,
  runGithubCorpusImport,
  runLocalCorpusImport,
  runSyntheticCorpusImport,
} from "../kb/corpus_hooks.js";

type CorpusMode = "local" | "github" | "arxiv" | "synthetic";

type Io = {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const withoutPrefix = arg.slice(2);
    const eq = withoutPrefix.indexOf("=");
    if (eq >= 0) {
      const key = withoutPrefix.slice(0, eq);
      const value = withoutPrefix.slice(eq + 1);
      flags[key] = value;
      continue;
    }
    const key = withoutPrefix;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
      continue;
    }
    flags[key] = "true";
  }
  return flags;
}

function printSummary(
  io: Io,
  result: {
    import: { imported_count: number; errors?: string[] };
    build: { built_count: number };
    graph: { exported: boolean; graph_path?: string };
    promotion: {
      fact_ids: string[];
      skill_ids: string[];
      summary_id?: string;
    };
  },
) {
  io.log(`Imported ${result.import.imported_count} docs`);
  io.log(`Built ${result.build.built_count} cards`);
  if (result.graph.exported && result.graph.graph_path) {
    io.log(`Exported graph to ${result.graph.graph_path}`);
  }
  io.log(`Promoted facts ${result.promotion.fact_ids.length}`);
  io.log(`Promoted skills ${result.promotion.skill_ids.length}`);
  if (result.promotion.summary_id) {
    io.log(`Promoted summary ${result.promotion.summary_id}`);
  }
  if ((result.import.errors?.length ?? 0) > 0) {
    io.log(`Errors ${result.import.errors!.length}`);
    for (const err of result.import.errors!) {
      io.log(`- ${err}`);
    }
  }
}

export async function runCorpusCli(argv: string[], io: Io = console): Promise<number> {
  const [rawMode, ...rest] = argv;
  const mode = (rawMode ?? "").toLowerCase() as CorpusMode;
  if (!["local", "github", "arxiv", "synthetic"].includes(mode)) {
    io.error("Usage: corpus <local|github|arxiv|synthetic> [--flags]");
    return 1;
  }

  const flags = parseFlags(rest);
  const buildCards = parseBool(flags["build-cards"] ?? flags.build_cards, false);
  const exportGraph = parseBool(flags["export-graph"] ?? flags.export_graph, false);
  const promoteFacts = parseBool(flags["promote-facts"] ?? flags.promote_facts, false);
  const promoteSkills = parseBool(flags["promote-skills"] ?? flags.promote_skills, false);
  const promoteSummary = parseBool(flags["promote-summary"] ?? flags.promote_summary, false);

  try {
    if (mode === "local") {
      const rootPath = flags.root ?? flags.root_path;
      if (!rootPath) {
        io.error("Missing required flag: --root");
        return 1;
      }
      const includeExt = parseCsv(flags.ext ?? flags.include_extensions);
      const result = await runLocalCorpusImport({
        root_path: rootPath,
        include_extensions: includeExt.length > 0 ? includeExt : undefined,
        recursive: parseBool(flags.recursive, true),
        tags: parseCsv(flags.tags),
        source_label: flags["source-label"] ?? flags.source_label,
        build_cards: buildCards,
        export_graph: exportGraph,
        promote_facts: promoteFacts,
        promote_skills: promoteSkills,
        promote_summary: promoteSummary,
      });
      printSummary(io, result);
      return 0;
    }

    if (mode === "github") {
      const repoUrl = flags.repo ?? flags.repo_url;
      if (!repoUrl) {
        io.error("Missing required flag: --repo");
        return 1;
      }
      const includeExt = parseCsv(flags.ext ?? flags.include_extensions);
      const pathFilter = parseCsv(flags.path ?? flags.path_filter);
      const result = await runGithubCorpusImport({
        repo_url: repoUrl,
        branch: flags.branch,
        path_filter: pathFilter.length > 0 ? pathFilter : undefined,
        include_extensions: includeExt.length > 0 ? includeExt : undefined,
        max_files: parseIntOr(flags["max-files"] ?? flags.max_files, 100),
        tags: parseCsv(flags.tags),
        source_label: flags["source-label"] ?? flags.source_label,
        build_cards: buildCards,
        export_graph: exportGraph,
        promote_facts: promoteFacts,
        promote_skills: promoteSkills,
        promote_summary: promoteSummary,
      });
      printSummary(io, result);
      return 0;
    }

    if (mode === "arxiv") {
      const query = flags.query;
      if (!query) {
        io.error("Missing required flag: --query");
        return 1;
      }
      const result = await runArxivCorpusImport({
        query,
        max_results: parseIntOr(flags["max-results"] ?? flags.max_results, 25),
        include_abstract_only: parseBool(
          flags["include-abstract-only"] ?? flags.include_abstract_only,
          true,
        ),
        tags: parseCsv(flags.tags),
        source_label: flags["source-label"] ?? flags.source_label,
        build_cards: buildCards,
        export_graph: exportGraph,
        promote_facts: promoteFacts,
        promote_skills: promoteSkills,
        promote_summary: promoteSummary,
      });
      printSummary(io, result);
      return 0;
    }

    const result = await runSyntheticCorpusImport({
      theme: flags.theme,
      doc_count: parseIntOr(flags["doc-count"] ?? flags.doc_count, 12),
      pipeline_count: parseIntOr(flags["pipeline-count"] ?? flags.pipeline_count, 3),
      tags: parseCsv(flags.tags),
      build_cards: buildCards,
      export_graph: exportGraph,
      promote_facts: promoteFacts,
      promote_skills: promoteSkills,
      promote_summary: promoteSummary,
    });
    printSummary(io, result);
    return 0;
  } catch (error: any) {
    io.error(`Corpus import failed: ${error.message}`);
    return 1;
  }
}

const isMain =
  process.argv[1]?.endsWith("/src/cli/corpus.ts") ||
  process.argv[1]?.endsWith("/dist/cli/corpus.js");

if (isMain) {
  runCorpusCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
