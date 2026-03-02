/**
 * Naive summarizer stub (offline / deterministic).
 * Replace this with your preferred LLM call (local or API) later.
 */
export async function summarizeToCardDraft(args: {
  title: string;
  text: string;
  tags: string[];
}) {
  const lines = args.text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const bullets = lines.slice(0, 6).map((s) => s.replace(/^[-*]\s*/, ""));

  return {
    title: args.title,
    bullets: bullets.length ? bullets : ["(empty)"],
    diagram_mermaid: undefined as string | undefined,
    tags: args.tags ?? []
  };
}
