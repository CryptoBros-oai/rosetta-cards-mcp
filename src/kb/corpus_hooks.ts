import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  type ExecutionCard,
  RunArxivCorpusImportInputSchema,
  RunGithubCorpusImportInputSchema,
  RunLocalCorpusImportInputSchema,
  RunSyntheticCorpusImportInputSchema,
  buildExecutionHashPayload,
} from "./schema.js";
import { canonicalHash } from "./canonical.js";
import {
  type ArxivCorpusImportResult,
  type GithubCorpusImportResult,
  type LocalCorpusImportResult,
  type SyntheticCorpusImportResult,
  importArxivCorpus,
  importGithubCorpus,
  importLocalCorpus,
  generateSyntheticCorpus,
} from "./corpus_import.js";
import { saveExecutionCard } from "./vault.js";
import { promoteFactsHook, promoteSkillsHook, promoteSummaryHook } from "./promotion_hooks.js";
import { bridgeDocsToVault, bridgeCardsToVault } from "./vault_bridge.js";

const RunLocalCorpusImportSchema = RunLocalCorpusImportInputSchema;
const RunGithubCorpusImportSchema = RunGithubCorpusImportInputSchema;
const RunArxivCorpusImportSchema = RunArxivCorpusImportInputSchema;
const RunSyntheticCorpusImportSchema = RunSyntheticCorpusImportInputSchema;

const BuildImportedCorpusCardsSchema = z.object({
  corpus_type: z.enum(["local", "github", "arxiv", "synthetic"]),
  doc_ids: z.array(z.string()),
  tags: z.array(z.string()).default([]),
  source_label: z.string().optional(),
}).strict();

const ExportImportedCorpusGraphSchema = z.object({
  corpus_type: z.enum(["local", "github", "arxiv", "synthetic"]),
  doc_ids: z.array(z.string()),
  built_card_ids: z.array(z.string()).default([]),
}).strict();

export type CorpusHookResult<TImport> = {
  import: TImport;
  build: {
    built_count: number;
    built_card_ids: string[];
    execution_ids: string[];
  };
  graph: {
    exported: boolean;
    graph_path?: string;
    node_count?: number;
    edge_count?: number;
  };
  promotion: {
    fact_ids: string[];
    fact_hashes: string[];
    skill_ids: string[];
    skill_hashes: string[];
    summary_id?: string;
    summary_hash?: string;
  };
  vault_bridge: {
    docs_bridged: number;
    docs_skipped: number;
    cards_bridged: number;
    cards_skipped: number;
  };
};

export type BuildImportedCorpusCardsResult = {
  built_count: number;
  built_card_ids: string[];
  execution_ids: string[];
};

export type ExportImportedCorpusGraphResult = {
  graph_path: string;
  node_count: number;
  edge_count: number;
};

type GraphNode = {
  id: string;
  type: "document" | "execution";
};

type GraphEdge = {
  from: string;
  to: string;
  type: "sequence" | "produces" | "depends_on";
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort();
}

function graphRoot(): string {
  return path.join(process.env.VAULT_ROOT ?? process.cwd(), "data", "graphs");
}

function executionCardId(hash: string): string {
  return `card_execution_${hash.slice(0, 12)}`;
}

export async function buildImportedCorpusCards(args: unknown): Promise<BuildImportedCorpusCardsResult> {
  const parsed = BuildImportedCorpusCardsSchema.parse(args);
  const docIds = uniqueSorted(parsed.doc_ids);
  if (docIds.length === 0) {
    return { built_count: 0, built_card_ids: [], execution_ids: [] };
  }

  const pipelineSeed = canonicalHash({
    corpus_type: parsed.corpus_type,
    doc_ids: docIds,
    source_label: parsed.source_label ?? "",
  } as Record<string, unknown>).slice(0, 16);
  const pipelineId = `corpus:${parsed.corpus_type}:${pipelineSeed}`;
  const tags = uniqueSorted(["corpus", "import", parsed.corpus_type, ...parsed.tags]);

  const rosetta = {
    verb: "Transform" as const,
    polarity: "+" as const,
    weights: { A: 0.2, C: 0.2, L: 0.2, P: 0.2, T: 0.2 },
  };

  const builtCardIds: string[] = [];
  const executionIds: string[] = [];
  let previousExecutionHash: string | undefined;

  for (let i = 0; i < docIds.length; i++) {
    const docId = docIds[i];
    const base = buildExecutionHashPayload({
      title: `Corpus import step ${i + 1}/${docIds.length}`,
      summary: parsed.source_label
        ? `Imported ${docId.slice(0, 12)} from ${parsed.source_label}.`
        : `Imported ${docId.slice(0, 12)} from ${parsed.corpus_type}.`,
      execution: {
        kind: "import",
        status: "succeeded",
        actor: { type: "agent", name: "corpus_hooks" },
        target: { type: "artifact", name: docId },
        inputs: [{ ref_type: "external_id", value: pipelineId }],
        outputs: [{ ref_type: "artifact_id", value: docId }],
        validation: { state: "self_reported", method: "hash_check" },
        chain: {
          pipeline_id: pipelineId,
          step_index: i,
          parent_execution_id: previousExecutionHash,
        },
      },
      tags,
      rosetta,
    });

    const hash = canonicalHash(base as unknown as Record<string, unknown>);
    const execution: ExecutionCard = { ...base, hash };
    await saveExecutionCard(execution);
    builtCardIds.push(executionCardId(hash));
    executionIds.push(hash);
    previousExecutionHash = hash;
  }

  return {
    built_count: builtCardIds.length,
    built_card_ids: builtCardIds,
    execution_ids: executionIds,
  };
}

export async function exportImportedCorpusGraph(args: unknown): Promise<ExportImportedCorpusGraphResult> {
  const parsed = ExportImportedCorpusGraphSchema.parse(args);
  const docIds = uniqueSorted(parsed.doc_ids);
  const builtCardIds = uniqueSorted(parsed.built_card_ids);
  const nodes: GraphNode[] = [
    ...docIds.map((id) => ({ id, type: "document" as const })),
    ...builtCardIds.map((id) => ({ id, type: "execution" as const })),
  ];
  const edges: GraphEdge[] = [];

  for (let i = 0; i + 1 < docIds.length; i++) {
    edges.push({ from: docIds[i], to: docIds[i + 1], type: "sequence" });
  }

  for (let i = 0; i < builtCardIds.length; i++) {
    const from = builtCardIds[i];
    const to = docIds[i] ?? docIds[docIds.length - 1];
    if (to) edges.push({ from, to, type: "produces" });
  }

  for (let i = 0; i + 1 < builtCardIds.length; i++) {
    edges.push({ from: builtCardIds[i + 1], to: builtCardIds[i], type: "depends_on" });
  }

  const sortedNodes = nodes.sort((a, b) => {
    const typeCmp = a.type.localeCompare(b.type);
    if (typeCmp !== 0) return typeCmp;
    return a.id.localeCompare(b.id);
  });
  const sortedEdges = edges.sort((a, b) => {
    const fromCmp = a.from.localeCompare(b.from);
    if (fromCmp !== 0) return fromCmp;
    const toCmp = a.to.localeCompare(b.to);
    if (toCmp !== 0) return toCmp;
    return a.type.localeCompare(b.type);
  });

  const payload = {
    schema_version: "corpus_graph.v1",
    corpus_type: parsed.corpus_type,
    doc_ids: docIds,
    built_card_ids: builtCardIds,
    nodes: sortedNodes,
    edges: sortedEdges,
  };

  const graphHash = canonicalHash(payload as unknown as Record<string, unknown>);
  const graphDir = graphRoot();
  await fs.mkdir(graphDir, { recursive: true });
  const graphPath = path.join(graphDir, `corpus_graph_${parsed.corpus_type}_${graphHash.slice(0, 12)}.json`);
  await fs.writeFile(graphPath, JSON.stringify(payload, null, 2), "utf-8");

  return {
    graph_path: graphPath,
    node_count: sortedNodes.length,
    edge_count: sortedEdges.length,
  };
}

async function withFollowups<TImport extends { doc_ids: string[] }>(
  baseImport: TImport,
  followups: {
    build_cards: boolean;
    export_graph: boolean;
    promote_facts: boolean;
    promote_skills: boolean;
    promote_summary: boolean;
    corpus_type: "local" | "github" | "arxiv" | "synthetic";
    tags: string[];
    source_label?: string;
  },
): Promise<CorpusHookResult<TImport>> {
  let build: BuildImportedCorpusCardsResult = { built_count: 0, built_card_ids: [], execution_ids: [] };
  if (followups.build_cards) {
    build = await buildImportedCorpusCards({
      corpus_type: followups.corpus_type,
      doc_ids: baseImport.doc_ids,
      tags: followups.tags,
      source_label: followups.source_label,
    });
  }

  const importedExecutionIds = (baseImport as any).generated_execution_ids as string[] | undefined;
  const executionIds = uniqueSorted([...(importedExecutionIds ?? []), ...build.execution_ids]);
  const promotion = {
    fact_ids: [] as string[],
    fact_hashes: [] as string[],
    skill_ids: [] as string[],
    skill_hashes: [] as string[],
    summary_id: undefined as string | undefined,
    summary_hash: undefined as string | undefined,
  };

  if (followups.promote_facts) {
    const facts = await promoteFactsHook({
      doc_ids: baseImport.doc_ids,
      tags: followups.tags,
      source_label: followups.source_label,
    });
    promotion.fact_ids = facts.created_ids;
    promotion.fact_hashes = facts.fact_hashes;
  }

  if (followups.promote_skills) {
    const skills = await promoteSkillsHook({
      execution_ids: executionIds,
      tags: followups.tags,
    });
    promotion.skill_ids = skills.created_ids;
    promotion.skill_hashes = skills.skill_hashes;
  }

  if (followups.promote_summary) {
    const summary = await promoteSummaryHook({
      doc_ids: baseImport.doc_ids,
      execution_ids: executionIds,
      fact_ids: promotion.fact_hashes,
      skill_ids: promotion.skill_hashes,
      label: followups.source_label
        ? `Corpus promotion summary (${followups.source_label})`
        : `Corpus promotion summary (${followups.corpus_type})`,
      tags: followups.tags,
    });
    promotion.summary_id = summary.created_id;
    promotion.summary_hash = summary.summary_hash;
  }

  // ── Bridge KB artifacts into the vault ──────────────────────────────────
  const docBridge = await bridgeDocsToVault(baseImport.doc_ids);
  const cardBridge = await bridgeCardsToVault(build.built_card_ids);
  const vault_bridge = {
    docs_bridged: docBridge.bridged,
    docs_skipped: docBridge.skipped,
    cards_bridged: cardBridge.bridged,
    cards_skipped: cardBridge.skipped,
  };

  if (!followups.export_graph) {
    return {
      import: baseImport,
      build,
      graph: { exported: false },
      promotion,
      vault_bridge,
    };
  }

  const graph = await exportImportedCorpusGraph({
    corpus_type: followups.corpus_type,
    doc_ids: baseImport.doc_ids,
    built_card_ids: build.built_card_ids,
  });

  return {
    import: baseImport,
    build,
    graph: {
      exported: true,
      graph_path: graph.graph_path,
      node_count: graph.node_count,
      edge_count: graph.edge_count,
    },
    promotion,
    vault_bridge,
  };
}

export async function runLocalCorpusImport(args: unknown): Promise<CorpusHookResult<LocalCorpusImportResult>> {
  const parsed = RunLocalCorpusImportSchema.parse(args);
  const imported = await importLocalCorpus({
    root_path: parsed.root_path,
    include_extensions: parsed.include_extensions,
    recursive: parsed.recursive,
    tags: parsed.tags,
    source_label: parsed.source_label,
  });
  return withFollowups(imported, {
    build_cards: parsed.build_cards,
    export_graph: parsed.export_graph,
    promote_facts: parsed.promote_facts,
    promote_skills: parsed.promote_skills,
    promote_summary: parsed.promote_summary,
    corpus_type: "local",
    tags: parsed.tags,
    source_label: parsed.source_label,
  });
}

export async function runGithubCorpusImport(args: unknown): Promise<CorpusHookResult<GithubCorpusImportResult>> {
  const parsed = RunGithubCorpusImportSchema.parse(args);
  const imported = await importGithubCorpus({
    repo_url: parsed.repo_url,
    branch: parsed.branch,
    path_filter: parsed.path_filter,
    include_extensions: parsed.include_extensions,
    max_files: parsed.max_files,
    tags: parsed.tags,
    source_label: parsed.source_label,
  });
  return withFollowups(imported, {
    build_cards: parsed.build_cards,
    export_graph: parsed.export_graph,
    promote_facts: parsed.promote_facts,
    promote_skills: parsed.promote_skills,
    promote_summary: parsed.promote_summary,
    corpus_type: "github",
    tags: parsed.tags,
    source_label: parsed.source_label,
  });
}

export async function runArxivCorpusImport(args: unknown): Promise<CorpusHookResult<ArxivCorpusImportResult>> {
  const parsed = RunArxivCorpusImportSchema.parse(args);
  const imported = await importArxivCorpus({
    query: parsed.query,
    max_results: parsed.max_results,
    include_abstract_only: parsed.include_abstract_only,
    tags: parsed.tags,
    source_label: parsed.source_label,
  });
  return withFollowups(imported, {
    build_cards: parsed.build_cards,
    export_graph: parsed.export_graph,
    promote_facts: parsed.promote_facts,
    promote_skills: parsed.promote_skills,
    promote_summary: parsed.promote_summary,
    corpus_type: "arxiv",
    tags: parsed.tags,
    source_label: parsed.source_label,
  });
}

export async function runSyntheticCorpusImport(args: unknown): Promise<CorpusHookResult<SyntheticCorpusImportResult>> {
  const parsed = RunSyntheticCorpusImportSchema.parse(args);
  const imported = await generateSyntheticCorpus({
    theme: parsed.theme,
    doc_count: parsed.doc_count,
    pipeline_count: parsed.pipeline_count,
    tags: parsed.tags,
  });
  return withFollowups(imported, {
    build_cards: parsed.build_cards,
    export_graph: parsed.export_graph,
    promote_facts: parsed.promote_facts,
    promote_skills: parsed.promote_skills,
    promote_summary: parsed.promote_summary,
    corpus_type: "synthetic",
    tags: parsed.tags,
  });
}
