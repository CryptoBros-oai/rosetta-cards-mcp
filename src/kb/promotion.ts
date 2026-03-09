import { z } from "zod";
import { canonicalHash, canonicalizeText } from "./canonical.js";

export type PromotionFactSource = {
  doc_id: string;
  title?: string;
  snippet: string;
  refs?: string[];
  tags?: string[];
};

export type PromotionExecutionSource = {
  execution_id: string;
  title: string;
  status: string;
  pipeline_id?: string;
  step_index?: number;
  refs?: string[];
  tags?: string[];
};

export type PromotionFactCandidate = {
  schema_version: "promotion.fact.v1";
  artifact_type: "promotion_fact";
  title: string;
  claim: string;
  refs: string[];
  tags: string[];
  hash: string;
};

export type PromotionSkillCandidate = {
  schema_version: "promotion.skill.v1";
  artifact_type: "promotion_skill";
  title: string;
  recipe_steps: string[];
  evidence_execution_ids: string[];
  refs: string[];
  tags: string[];
  hash: string;
};

export type PromotionSummaryCandidate = {
  schema_version: "promotion.summary.v1";
  artifact_type: "promotion_summary";
  title: string;
  summary_lines: string[];
  refs: string[];
  tags: string[];
  hash: string;
};

export type PromotionBundle = {
  schema_version: "promotion.bundle.v1";
  artifact_type: "promotion_bundle";
  title: string;
  member_hashes: {
    facts: string[];
    skills: string[];
    summary?: string;
  };
  refs: string[];
  tags: string[];
  hash: string;
};

export const PromoteFactCandidatesInputSchema = z.object({
  docs: z.array(
    z.object({
      doc_id: z.string(),
      title: z.string().optional(),
      snippet: z.string(),
      refs: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    }).strict(),
  ),
  tags: z.array(z.string()).default([]),
}).strict();

export const PromoteSkillCandidatesInputSchema = z.object({
  executions: z.array(
    z.object({
      execution_id: z.string(),
      title: z.string(),
      status: z.string(),
      pipeline_id: z.string().optional(),
      step_index: z.number().int().nonnegative().optional(),
      refs: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    }).strict(),
  ),
  tags: z.array(z.string()).default([]),
}).strict();

export const PromoteSummaryCandidateInputSchema = z.object({
  label: z.string().optional(),
  doc_ids: z.array(z.string()).default([]),
  execution_ids: z.array(z.string()).default([]),
  fact_ids: z.array(z.string()).default([]),
  skill_ids: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
}).strict();

export const BuildPromotionBundleInputSchema = z.object({
  label: z.string().optional(),
  facts: z.array(z.custom<PromotionFactCandidate>()).default([]),
  skills: z.array(z.custom<PromotionSkillCandidate>()).default([]),
  summary: z.custom<PromotionSummaryCandidate>().optional(),
  tags: z.array(z.string()).default([]),
}).strict();

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeSnippet(value: string): string {
  const normalized = canonicalizeText(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function firstSentence(value: string): string {
  const match = normalizeSnippet(value).match(/^(.+?[.!?])(\s|$)/);
  if (match?.[1]) return match[1].trim();
  return normalizeSnippet(value);
}

export function promoteFactCandidates(input: unknown): PromotionFactCandidate[] {
  const parsed = PromoteFactCandidatesInputSchema.parse(input);
  const globalTags = uniqueSorted(parsed.tags);
  const docs = [...parsed.docs].sort((a, b) => a.doc_id.localeCompare(b.doc_id));

  return docs.map((doc) => {
    const claim = firstSentence(doc.snippet);
    const title = doc.title?.trim() ? doc.title.trim() : `Fact candidate ${doc.doc_id.slice(0, 12)}`;
    const refs = uniqueSorted([doc.doc_id, ...(doc.refs ?? [])]);
    const tags = uniqueSorted(["promotion", "fact", ...globalTags, ...(doc.tags ?? [])]);
    const base: Omit<PromotionFactCandidate, "hash"> = {
      schema_version: "promotion.fact.v1",
      artifact_type: "promotion_fact",
      title,
      claim,
      refs,
      tags,
    };
    return {
      ...base,
      hash: canonicalHash(base as unknown as Record<string, unknown>),
    };
  });
}

export function promoteSkillCandidates(input: unknown): PromotionSkillCandidate[] {
  const parsed = PromoteSkillCandidatesInputSchema.parse(input);
  const globalTags = uniqueSorted(parsed.tags);
  const sortedExecutions = [...parsed.executions].sort((a, b) => {
    const pa = a.pipeline_id ?? `single:${a.execution_id}`;
    const pb = b.pipeline_id ?? `single:${b.execution_id}`;
    const pipelineCmp = pa.localeCompare(pb);
    if (pipelineCmp !== 0) return pipelineCmp;
    const sa = a.step_index ?? Number.MAX_SAFE_INTEGER;
    const sb = b.step_index ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.execution_id.localeCompare(b.execution_id);
  });

  const grouped = new Map<string, PromotionExecutionSource[]>();
  for (const execution of sortedExecutions) {
    const key = execution.pipeline_id ?? `single:${execution.execution_id}`;
    const list = grouped.get(key) ?? [];
    list.push(execution);
    grouped.set(key, list);
  }

  const pipelineKeys = [...grouped.keys()].sort();
  return pipelineKeys.map((pipelineKey) => {
    const executions = grouped.get(pipelineKey) ?? [];
    const executionIds = uniqueSorted(executions.map((execution) => execution.execution_id));
    const refs = uniqueSorted([
      ...executionIds,
      ...executions.flatMap((execution) => execution.refs ?? []),
    ]);
    const tags = uniqueSorted([
      "promotion",
      "skill",
      ...globalTags,
      ...executions.flatMap((execution) => execution.tags ?? []),
    ]);
    const recipeSteps = executions.map((execution, index) => {
      const stepNumber = execution.step_index ?? index;
      return `${stepNumber}. ${execution.title} (${execution.status})`;
    });
    const title = pipelineKey.startsWith("single:")
      ? `Skill candidate from ${executionIds[0].slice(0, 12)}`
      : `Skill candidate for ${pipelineKey}`;

    const base: Omit<PromotionSkillCandidate, "hash"> = {
      schema_version: "promotion.skill.v1",
      artifact_type: "promotion_skill",
      title,
      recipe_steps: recipeSteps,
      evidence_execution_ids: executionIds,
      refs,
      tags,
    };
    return {
      ...base,
      hash: canonicalHash(base as unknown as Record<string, unknown>),
    };
  });
}

export function promoteSummaryCandidate(input: unknown): PromotionSummaryCandidate {
  const parsed = PromoteSummaryCandidateInputSchema.parse(input);
  const docIds = uniqueSorted(parsed.doc_ids);
  const executionIds = uniqueSorted(parsed.execution_ids);
  const factIds = uniqueSorted(parsed.fact_ids);
  const skillIds = uniqueSorted(parsed.skill_ids);
  const refs = uniqueSorted([...docIds, ...executionIds, ...factIds, ...skillIds]);
  const title = parsed.label?.trim() || "Promotion summary candidate";
  const summaryLines = [
    `docs=${docIds.length}`,
    `executions=${executionIds.length}`,
    `facts=${factIds.length}`,
    `skills=${skillIds.length}`,
    `refs=${refs.length}`,
  ];
  const tags = uniqueSorted(["promotion", "summary", ...parsed.tags]);

  const base: Omit<PromotionSummaryCandidate, "hash"> = {
    schema_version: "promotion.summary.v1",
    artifact_type: "promotion_summary",
    title,
    summary_lines: summaryLines,
    refs,
    tags,
  };
  return {
    ...base,
    hash: canonicalHash(base as unknown as Record<string, unknown>),
  };
}

export function buildPromotionBundle(input: unknown): PromotionBundle {
  const parsed = BuildPromotionBundleInputSchema.parse(input);
  const factHashes = uniqueSorted(parsed.facts.map((fact) => fact.hash));
  const skillHashes = uniqueSorted(parsed.skills.map((skill) => skill.hash));
  const summaryHash = parsed.summary?.hash;
  const refs = uniqueSorted([
    ...factHashes,
    ...skillHashes,
    ...(summaryHash ? [summaryHash] : []),
  ]);
  const tags = uniqueSorted(["promotion", "bundle", ...parsed.tags]);
  const title = parsed.label?.trim() || "Promotion bundle";

  const base: Omit<PromotionBundle, "hash"> = {
    schema_version: "promotion.bundle.v1",
    artifact_type: "promotion_bundle",
    title,
    member_hashes: {
      facts: factHashes,
      skills: skillHashes,
      ...(summaryHash ? { summary: summaryHash } : {}),
    },
    refs,
    tags,
  };
  return {
    ...base,
    hash: canonicalHash(base as unknown as Record<string, unknown>),
  };
}
