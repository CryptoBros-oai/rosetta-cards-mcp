import blessed, { type Widgets } from "neo-blessed";

import {
  buildImportedCorpusCards,
  exportImportedCorpusGraph,
  runArxivCorpusImport,
  runGithubCorpusImport,
  runLocalCorpusImport,
  runSyntheticCorpusImport,
} from "../../kb/corpus_hooks.js";
import { detailPane, listPane, statusBar } from "../ui/layout.js";
import { formatKeyLegend, type KeyBinding } from "../ui/keys.js";

type CorpusMode = "local" | "github" | "arxiv" | "synthetic";

type LastImportContext = {
  corpus_type: CorpusMode;
  doc_ids: string[];
  tags: string[];
  source_label?: string;
  built_card_ids: string[];
};

export const CORPUS_IMPORT_RUNNERS = {
  local: runLocalCorpusImport,
  github: runGithubCorpusImport,
  arxiv: runArxivCorpusImport,
  synthetic: runSyntheticCorpusImport,
} as const;

const MODES: Array<{ mode: CorpusMode; label: string }> = [
  { mode: "local", label: "Local Folder" },
  { mode: "github", label: "GitHub Repo" },
  { mode: "arxiv", label: "arXiv Query" },
  { mode: "synthetic", label: "Synthetic Corpus" },
];

function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value: string | null, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

export function createCorpusScreen(screen: Widgets.Screen): {
  show: () => void;
  hide: () => void;
  destroy: () => void;
} {
  const container = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: "100%",
    height: "100%-6",
    hidden: true,
  });

  const modeList = blessed.list({
    parent: container,
    ...({
      ...listPane({
        label: " Corpus Import ",
        top: 0,
        left: 0,
        width: "35%",
        height: "100%",
      }),
    } as any),
  } as any);

  const detailBox = blessed.box({
    parent: container,
    ...({
      ...detailPane({
        label: " Details ",
        top: 0,
        left: "35%",
        width: "65%",
        height: "100%",
      }),
    } as any),
  } as any);

  const status = blessed.box({
    parent: screen,
    ...({
      ...statusBar(),
    } as any),
  } as any);

  let selectedMode: CorpusMode = "local";
  let lastImport: LastImportContext | null = null;

  const keyBindings: KeyBinding[] = [
    { key: "enter", description: "Import", handler: () => startImportFlow() },
    { key: "b", description: "Build cards", handler: () => runBuildCards() },
    { key: "g", description: "Export graph", handler: () => runExportGraph() },
    { key: "o", description: "Browse imported", handler: () => showImportedDocs() },
    { key: "escape", description: "Cancel prompt", handler: () => {} },
    { key: "i", description: "Open import", handler: () => startImportFlow() },
  ];

  function updateStatus(msg?: string) {
    const legend = formatKeyLegend(keyBindings);
    const extra = msg ? `  | ${msg}` : "";
    status.setContent(` ${legend}${extra}`);
    screen.render();
  }

  function renderModes() {
    (modeList as any).setItems(
      MODES.map((entry) =>
        entry.mode === selectedMode
          ? `{green-fg}> ${entry.label}{/green-fg}`
          : `  ${entry.label}`,
      ),
    );
  }

  function setDefaultDetail() {
    detailBox.setContent(
      [
        "{bold}Corpus Import{/bold}",
        "",
        "Modes:",
        "  [1] Local Folder",
        "  [2] GitHub Repo",
        "  [3] arXiv Query",
        "  [4] Synthetic Corpus",
        "",
        "After import:",
        "  [b] Build cards now",
        "  [g] Export graph now",
        "  [o] Browse imported artifacts",
      ].join("\n"),
    );
  }

  function showImportSummary(mode: CorpusMode, result: any) {
    const lines = [
      `{bold}{cyan-fg}Import Complete (${mode}){/cyan-fg}{/bold}`,
      "",
      `Imported: ${result.import.imported_count}`,
      `Skipped:  ${result.import.skipped_count ?? 0}`,
      `Errors:   ${result.import.errors?.length ?? 0}`,
      `Built cards: ${result.build.built_count}`,
      result.graph.exported
        ? `Graph: ${result.graph.graph_path}`
        : "Graph: not exported",
      "",
      "Doc IDs:",
      ...(result.import.doc_ids.slice(0, 20).map((id: string) => `  - ${id}`) || []),
      result.import.doc_ids.length > 20
        ? `  ... +${result.import.doc_ids.length - 20} more`
        : "",
    ].filter(Boolean);
    detailBox.setContent(lines.join("\n"));
  }

  function showImportedDocs() {
    if (!lastImport || lastImport.doc_ids.length === 0) {
      updateStatus("No imported artifacts yet");
      return;
    }
    detailBox.setContent(
      [
        "{bold}{cyan-fg}Imported Artifacts{/cyan-fg}{/bold}",
        "",
        ...lastImport.doc_ids.map((id) => `- ${id}`),
      ].join("\n"),
    );
    screen.render();
    updateStatus(`Showing ${lastImport.doc_ids.length} imported artifacts`);
  }

  async function promptInput(label: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      const input = blessed.textbox({
        parent: screen,
        ...({
          label,
          top: "center",
          left: "center",
          width: "70%",
          height: 3,
          keys: true,
          mouse: true,
          inputOnFocus: true,
          value: initial,
          border: { type: "line" as const },
          style: {
            fg: "white",
            bg: "black",
            border: { fg: "cyan" },
            focus: { border: { fg: "green" } },
          },
        } as any),
      } as any);

      const finish = (value: string | null) => {
        input.destroy();
        screen.render();
        resolve(value);
      };

      input.on("submit", (value: string) => finish(value));
      input.on("cancel", () => finish(null));

      input.focus();
      input.readInput(() => {});
      screen.render();
    });
  }

  async function startImportFlow() {
    try {
      if (selectedMode === "local") {
        const root = await promptInput(" Local root path ");
        if (!root?.trim()) return updateStatus("Import cancelled");
        const ext = await promptInput(" Extensions (.md,.txt) ", ".md,.txt");
        if (ext === null) return updateStatus("Import cancelled");
        const recursive = await promptInput(" Recursive? (true/false) ", "true");
        if (recursive === null) return updateStatus("Import cancelled");
        const tags = await promptInput(" Tags (comma-separated, optional) ");
        if (tags === null) return updateStatus("Import cancelled");
        const sourceLabel = await promptInput(" Source label (optional) ");
        if (sourceLabel === null) return updateStatus("Import cancelled");

        updateStatus("Importing local corpus...");
        const result = await runLocalCorpusImport({
          root_path: root.trim(),
          include_extensions: parseCsv(ext),
          recursive: parseBool(recursive, true),
          tags: parseCsv(tags),
          source_label: sourceLabel.trim() || undefined,
          build_cards: false,
          export_graph: false,
        });
        lastImport = {
          corpus_type: "local",
          doc_ids: result.import.doc_ids,
          tags: parseCsv(tags),
          source_label: sourceLabel.trim() || undefined,
          built_card_ids: [],
        };
        showImportSummary("local", result);
        updateStatus(`Imported ${result.import.imported_count} docs`);
        screen.render();
        return;
      }

      if (selectedMode === "github") {
        const repo = await promptInput(" GitHub repo URL ");
        if (!repo?.trim()) return updateStatus("Import cancelled");
        const branch = await promptInput(" Branch (blank = default) ");
        if (branch === null) return updateStatus("Import cancelled");
        const pathFilter = await promptInput(" Path filter(s), comma-separated ");
        if (pathFilter === null) return updateStatus("Import cancelled");
        const maxFiles = await promptInput(" Max files ", "100");
        if (maxFiles === null) return updateStatus("Import cancelled");
        const tags = await promptInput(" Tags (comma-separated, optional) ");
        if (tags === null) return updateStatus("Import cancelled");
        const sourceLabel = await promptInput(" Source label (optional) ");
        if (sourceLabel === null) return updateStatus("Import cancelled");

        updateStatus("Importing GitHub corpus...");
        const result = await runGithubCorpusImport({
          repo_url: repo.trim(),
          branch: branch.trim() || undefined,
          path_filter: parseCsv(pathFilter),
          max_files: parsePositiveInt(maxFiles, 100),
          tags: parseCsv(tags),
          source_label: sourceLabel.trim() || undefined,
          build_cards: false,
          export_graph: false,
        });
        lastImport = {
          corpus_type: "github",
          doc_ids: result.import.doc_ids,
          tags: parseCsv(tags),
          source_label: sourceLabel.trim() || undefined,
          built_card_ids: [],
        };
        showImportSummary("github", result);
        updateStatus(`Imported ${result.import.imported_count} docs`);
        screen.render();
        return;
      }

      if (selectedMode === "arxiv") {
        const query = await promptInput(" arXiv query ");
        if (!query?.trim()) return updateStatus("Import cancelled");
        const maxResults = await promptInput(" Max results ", "25");
        if (maxResults === null) return updateStatus("Import cancelled");
        const abstractsOnly = await promptInput(" Abstract only? (true/false) ", "true");
        if (abstractsOnly === null) return updateStatus("Import cancelled");
        const tags = await promptInput(" Tags (comma-separated, optional) ");
        if (tags === null) return updateStatus("Import cancelled");
        const sourceLabel = await promptInput(" Source label (optional) ");
        if (sourceLabel === null) return updateStatus("Import cancelled");

        updateStatus("Importing arXiv corpus...");
        const result = await runArxivCorpusImport({
          query: query.trim(),
          max_results: parsePositiveInt(maxResults, 25),
          include_abstract_only: parseBool(abstractsOnly, true),
          tags: parseCsv(tags),
          source_label: sourceLabel.trim() || undefined,
          build_cards: false,
          export_graph: false,
        });
        lastImport = {
          corpus_type: "arxiv",
          doc_ids: result.import.doc_ids,
          tags: parseCsv(tags),
          source_label: sourceLabel.trim() || undefined,
          built_card_ids: [],
        };
        showImportSummary("arxiv", result);
        updateStatus(`Imported ${result.import.imported_count} docs`);
        screen.render();
        return;
      }

      const theme = await promptInput(" Synthetic theme ", "gpu inference");
      if (!theme?.trim()) return updateStatus("Import cancelled");
      const docCount = await promptInput(" Doc count ", "12");
      if (docCount === null) return updateStatus("Import cancelled");
      const pipelineCount = await promptInput(" Pipeline count ", "3");
      if (pipelineCount === null) return updateStatus("Import cancelled");
      const tags = await promptInput(" Tags (comma-separated, optional) ");
      if (tags === null) return updateStatus("Import cancelled");

      updateStatus("Generating synthetic corpus...");
      const result = await runSyntheticCorpusImport({
        theme: theme.trim(),
        doc_count: parsePositiveInt(docCount, 12),
        pipeline_count: parsePositiveInt(pipelineCount, 3),
        tags: parseCsv(tags),
        build_cards: false,
        export_graph: false,
      });
      lastImport = {
        corpus_type: "synthetic",
        doc_ids: result.import.doc_ids,
        tags: parseCsv(tags),
        built_card_ids: [],
      };
      showImportSummary("synthetic", result);
      updateStatus(`Imported ${result.import.imported_count} docs`);
      screen.render();
    } catch (error: any) {
      updateStatus(`Import failed: ${error.message}`);
      screen.render();
    }
  }

  async function runBuildCards() {
    if (!lastImport || lastImport.doc_ids.length === 0) {
      updateStatus("Import a corpus first");
      return;
    }
    try {
      updateStatus("Building cards...");
      const build = await buildImportedCorpusCards({
        corpus_type: lastImport.corpus_type,
        doc_ids: lastImport.doc_ids,
        tags: lastImport.tags,
        source_label: lastImport.source_label,
      });
      lastImport.built_card_ids = build.built_card_ids;
      updateStatus(`Built ${build.built_count} cards`);
      screen.render();
    } catch (error: any) {
      updateStatus(`Build failed: ${error.message}`);
      screen.render();
    }
  }

  async function runExportGraph() {
    if (!lastImport || lastImport.doc_ids.length === 0) {
      updateStatus("Import a corpus first");
      return;
    }
    try {
      updateStatus("Exporting graph...");
      const graph = await exportImportedCorpusGraph({
        corpus_type: lastImport.corpus_type,
        doc_ids: lastImport.doc_ids,
        built_card_ids: lastImport.built_card_ids,
      });
      updateStatus(`Graph exported: ${graph.graph_path}`);
      screen.render();
    } catch (error: any) {
      updateStatus(`Graph export failed: ${error.message}`);
      screen.render();
    }
  }

  modeList.on("select item", (_item: any, index: number) => {
    selectedMode = MODES[index]?.mode ?? "local";
    renderModes();
    screen.render();
  });

  modeList.key(["enter", "i"], () => startImportFlow());
  modeList.key(["b"], () => runBuildCards());
  modeList.key(["g"], () => runExportGraph());
  modeList.key(["o"], () => showImportedDocs());
  modeList.key(["1"], () => {
    selectedMode = "local";
    renderModes();
    screen.render();
  });
  modeList.key(["2"], () => {
    selectedMode = "github";
    renderModes();
    screen.render();
  });
  modeList.key(["3"], () => {
    selectedMode = "arxiv";
    renderModes();
    screen.render();
  });
  modeList.key(["4"], () => {
    selectedMode = "synthetic";
    renderModes();
    screen.render();
  });

  return {
    show() {
      container.show();
      status.show();
      renderModes();
      setDefaultDetail();
      modeList.focus();
      updateStatus();
      screen.render();
    },
    hide() {
      container.hide();
      status.hide();
      screen.render();
    },
    destroy() {
      container.destroy();
      status.destroy();
    },
  };
}
