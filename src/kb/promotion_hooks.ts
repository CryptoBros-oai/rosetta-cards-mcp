import fs from "node:fs/promises";
import path from "node:path";

import {
  PromotionBuildBundleInputSchema,
  PromotionPromoteFactsInputSchema,
  PromotionPromoteSkillsInputSchema,
  PromotionPromoteSummaryInputSchema,
} from "./schema.js";
import { loadAllExecutionCards } from "./vault.js";
import {
  type PromotionBundle,
  type PromotionFactCandidate,
  type PromotionSkillCandidate,
  type PromotionSummaryCandidate,
  buildPromotionBundle,
  promoteFactCandidates,
  promoteSkillCandidates,
  promoteSummaryCandidate,
} from "./promotion.js";

type AnyCardRecord = Record<string, unknown> & { hash?: string };

function vaultRoot(): string {
  return process.env.VAULT_ROOT ?? process.cwd();
}

function cardsDir(): string {
  return path.join(vaultRoot(), "data", "cards");
}

function textPath(hash: string): string {
  return path.join(vaultRoot(), "data", "text", hash.slice(0, 2), hash.slice(2, 4), `${hash}.txt`);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 200) return normalized;
  return `${normalized.slice(0, 197)}...`;
}

async function loadAllCardRecords(): Promise<Array<{ card_id: string; payload: AnyCardRecord }>> {
  await fs.mkdir(cardsDir(), { recursive: true });
  const files = await fs.readdir(cardsDir());
  const records: Array<{ card_id: string; payload: AnyCardRecord }> = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(cardsDir(), file), "utf-8");
      const payload = JSON.parse(raw) as AnyCardRecord;
      records.push({ card_id: file.replace(/\.json$/, ""), payload });
    } catch {
      // Skip invalid JSON artifacts
    }
  }
  return records;
}

async function readTextByHash(hash: string | undefined): Promise<string> {
  if (!hash) return "";
  try {
    return await fs.readFile(textPath(hash), "utf-8");
  } catch {
    return "";
  }
}

function saveCardId(prefix: string, hash: string): string {
  return `${prefix}_${hash.slice(0, 12)}`;
}

async function savePromotionArtifact(
  prefix: "card_pfact" | "card_pskill" | "card_psummary" | "card_pbundle",
  payload: { hash: string },
): Promise<string> {
  await fs.mkdir(cardsDir(), { recursive: true });
  const cardId = saveCardId(prefix, payload.hash);
  await fs.writeFile(
    path.join(cardsDir(), `${cardId}.json`),
    JSON.stringify(payload, null, 2),
    "utf-8",
  );
  return cardId;
}

function resolveExecutionHashes(
  executions: Array<{ hash: string }>,
  refs: string[] | undefined,
): string[] {
  if (refs === undefined) return executions.map((execution) => execution.hash).sort();
  if (refs.length === 0) return [];
  const sorted = executions.slice().sort((a, b) => a.hash.localeCompare(b.hash));
  const resolved = new Set<string>();
  for (const ref of refs) {
    const token = ref.startsWith("card_execution_") ? ref.slice("card_execution_".length) : ref;
    for (const execution of sorted) {
      if (execution.hash === token || execution.hash.startsWith(token)) {
        resolved.add(execution.hash);
      }
    }
  }
  return [...resolved].sort();
}

function pickPromotionHashes(
  cards: Array<{ card_id: string; payload: AnyCardRecord }>,
  refs: string[] | undefined,
  artifactType: "promotion_fact" | "promotion_skill" | "promotion_summary",
): string[] {
  const candidates = cards
    .filter((card) => card.payload.artifact_type === artifactType && typeof card.payload.hash === "string")
    .map((card) => ({ card_id: card.card_id, hash: String(card.payload.hash) }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
  if (!refs || refs.length === 0) return candidates.map((candidate) => candidate.hash);

  const resolved = new Set<string>();
  for (const ref of refs) {
    const token = ref
      .replace(/^card_pfact_/, "")
      .replace(/^card_pskill_/, "")
      .replace(/^card_psummary_/, "");
    for (const candidate of candidates) {
      if (
        candidate.hash === token ||
        candidate.hash.startsWith(token) ||
        candidate.card_id === ref
      ) {
        resolved.add(candidate.hash);
      }
    }
  }
  return [...resolved].sort();
}

export type PromoteFactsResult = {
  created_ids: string[];
  fact_hashes: string[];
  facts: PromotionFactCandidate[];
};

export type PromoteSkillsResult = {
  created_ids: string[];
  skill_hashes: string[];
  skills: PromotionSkillCandidate[];
};

export type PromoteSummaryResult = {
  created_id: string;
  summary_hash: string;
  summary: PromotionSummaryCandidate;
};

export type PromotionBundleResult = {
  created_id: string;
  bundle_hash: string;
  bundle: PromotionBundle;
  fact_hashes: string[];
  skill_hashes: string[];
  summary_hash?: string;
};

export async function promoteFactsHook(args: unknown): Promise<PromoteFactsResult> {
  const parsed = PromotionPromoteFactsInputSchema.parse(args);
  const records = await loadAllCardRecords();
  const byHash = new Map<string, AnyCardRecord>(
    records
      .filter((record) => typeof record.payload.hash === "string")
      .map((record) => [String(record.payload.hash), record.payload]),
  );

  const docs = await Promise.all(
    uniqueSorted(parsed.doc_ids).map(async (docId) => {
      const card = byHash.get(docId);
      const title = typeof card?.title === "string" ? card.title : `Imported ${docId.slice(0, 12)}`;
      const textHash =
        card && typeof card.text === "object" && card.text && typeof (card.text as any).hash === "string"
          ? String((card.text as any).hash)
          : undefined;
      const snippet = normalizeSnippet(await readTextByHash(textHash));
      return {
        doc_id: docId,
        title,
        snippet: snippet || `Imported corpus artifact ${docId.slice(0, 12)}.`,
      };
    }),
  );

  const facts = promoteFactCandidates({
    docs,
    tags: parsed.tags ?? [],
  });

  const createdIds: string[] = [];
  for (const fact of facts) {
    createdIds.push(await savePromotionArtifact("card_pfact", fact));
  }

  return {
    created_ids: createdIds,
    fact_hashes: facts.map((fact) => fact.hash),
    facts,
  };
}

export async function promoteSkillsHook(args: unknown): Promise<PromoteSkillsResult> {
  const parsed = PromotionPromoteSkillsInputSchema.parse(args);
  const allExecutions = await loadAllExecutionCards();
  const hasExplicitExecutionRefs = parsed.execution_ids !== undefined;
  const allowedHashes = resolveExecutionHashes(allExecutions, parsed.execution_ids);
  const selectedExecutions = allExecutions
    .filter((execution) =>
      hasExplicitExecutionRefs ? allowedHashes.includes(execution.hash) : true,
    )
    .filter((execution) =>
      parsed.pipeline_id ? execution.execution.chain?.pipeline_id === parsed.pipeline_id : true,
    );

  const skills = promoteSkillCandidates({
    executions: selectedExecutions.map((execution) => ({
      execution_id: execution.hash,
      title: execution.title,
      status: execution.execution.status,
      pipeline_id: execution.execution.chain?.pipeline_id,
      step_index: execution.execution.chain?.step_index,
      refs: uniqueSorted([
        ...execution.execution.inputs.map((ref) => ref.value),
        ...execution.execution.outputs.map((ref) => ref.value),
      ]),
      tags: execution.tags,
    })),
    tags: parsed.tags ?? [],
  });

  const createdIds: string[] = [];
  for (const skill of skills) {
    createdIds.push(await savePromotionArtifact("card_pskill", skill));
  }

  return {
    created_ids: createdIds,
    skill_hashes: skills.map((skill) => skill.hash),
    skills,
  };
}

export async function promoteSummaryHook(args: unknown): Promise<PromoteSummaryResult> {
  const parsed = PromotionPromoteSummaryInputSchema.parse(args);
  const summary = promoteSummaryCandidate({
    label: parsed.label,
    doc_ids: parsed.doc_ids ?? [],
    execution_ids: parsed.execution_ids ?? [],
    fact_ids: parsed.fact_ids ?? [],
    skill_ids: parsed.skill_ids ?? [],
    tags: parsed.tags ?? [],
  });
  const createdId = await savePromotionArtifact("card_psummary", summary);
  return {
    created_id: createdId,
    summary_hash: summary.hash,
    summary,
  };
}

export async function buildPromotionBundleHook(args: unknown): Promise<PromotionBundleResult> {
  const parsed = PromotionBuildBundleInputSchema.parse(args);
  const factResult = parsed.include_facts
    ? await promoteFactsHook({ doc_ids: parsed.doc_ids ?? [], tags: parsed.tags })
    : { created_ids: [], fact_hashes: [], facts: [] as PromotionFactCandidate[] };

  const skillResult = parsed.include_skills
    ? await promoteSkillsHook({ execution_ids: parsed.execution_ids ?? [], tags: parsed.tags })
    : { created_ids: [], skill_hashes: [], skills: [] as PromotionSkillCandidate[] };

  const summaryResult = parsed.include_summary
    ? await promoteSummaryHook({
        doc_ids: parsed.doc_ids ?? [],
        execution_ids: parsed.execution_ids ?? [],
        fact_ids: factResult.fact_hashes,
        skill_ids: skillResult.skill_hashes,
        label: parsed.label,
        tags: parsed.tags,
      })
    : undefined;

  const bundle = buildPromotionBundle({
    label: parsed.label,
    facts: factResult.facts,
    skills: skillResult.skills,
    summary: summaryResult?.summary,
    tags: parsed.tags ?? [],
  });
  const createdId = await savePromotionArtifact("card_pbundle", bundle);

  return {
    created_id: createdId,
    bundle_hash: bundle.hash,
    bundle,
    fact_hashes: factResult.fact_hashes,
    skill_hashes: skillResult.skill_hashes,
    summary_hash: summaryResult?.summary_hash,
  };
}

export async function resolvePromotionReferences(args: {
  fact_ids?: string[];
  skill_ids?: string[];
  summary_ids?: string[];
}): Promise<{ fact_hashes: string[]; skill_hashes: string[]; summary_hashes: string[] }> {
  const cards = await loadAllCardRecords();
  return {
    fact_hashes: pickPromotionHashes(cards, args.fact_ids, "promotion_fact"),
    skill_hashes: pickPromotionHashes(cards, args.skill_ids, "promotion_skill"),
    summary_hashes: pickPromotionHashes(cards, args.summary_ids, "promotion_summary"),
  };
}
