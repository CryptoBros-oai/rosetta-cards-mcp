import blessed, { type Widgets } from "neo-blessed";
import { buildArtifactCard, openPng, ingestFolderHook } from "../../kb/hooks.js";
import { cardPngPath } from "../../kb/vault.js";
import { statusBar } from "../ui/layout.js";
import { formatKeyLegend, type KeyBinding } from "../ui/keys.js";

export function createBuildScreen(screen: Widgets.Screen): {
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

  // Step indicator
  const stepBox = blessed.box({
    parent: container,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    style: { fg: "white", bg: "black", border: { fg: "cyan" } },
    border: { type: "line" as const },
  } as any);

  // Title input
  const titleInput = blessed.textbox({
    parent: container,
    ...({
      label: " Title ",
      top: 3,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      keys: true,
      mouse: true,
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "yellow" },
        focus: { border: { fg: "green" } },
      },
      border: { type: "line" as const },
    } as any),
  } as any);

  // Tags input
  const tagsInput = blessed.textbox({
    parent: container,
    ...({
      label: " Tags (comma-separated) ",
      top: 6,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      keys: true,
      mouse: true,
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "yellow" },
        focus: { border: { fg: "green" } },
      },
      border: { type: "line" as const },
    } as any),
  } as any);

  // Text area
  const textArea = blessed.textarea({
    parent: container,
    ...({
      label: " Text Content (Ctrl+S to submit) ",
      top: 9,
      left: 0,
      width: "100%",
      height: "100%-12",
      tags: true,
      keys: true,
      mouse: true,
      scrollable: true,
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "yellow" },
        focus: { border: { fg: "green" } },
      },
      border: { type: "line" as const },
    } as any),
  } as any);

  // Result box
  const resultBox = blessed.box({
    parent: container,
    ...({
      label: " Result ",
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black", border: { fg: "green" } },
      border: { type: "line" as const },
    } as any),
    hidden: true,
  } as any);

  const status = blessed.box({
    parent: screen,
    ...({
      ...statusBar(),
    } as any),
  } as any);

  let currentStep = 1;
  let builtCardId: string | null = null;

  function updateStep() {
    const steps = [
      currentStep === 1 ? "{green-fg}1. Title & Tags{/green-fg}" : "{gray-fg}1. Title & Tags{/gray-fg}",
      currentStep === 2 ? "{green-fg}2. Enter Text{/green-fg}" : "{gray-fg}2. Enter Text{/gray-fg}",
      currentStep === 3 ? "{green-fg}3. Build Card{/green-fg}" : "{gray-fg}3. Build Card{/gray-fg}",
    ];
    stepBox.setContent(` Build Card Wizard:  ${steps.join("  →  ")}`);
    screen.render();
  }

  const keyBindings: KeyBinding[] = [
    { key: "tab", description: "Next field", handler: () => nextField() },
    { key: "C-s", description: "Build", handler: () => buildCurrentCard() },
    { key: "f", description: "Import Folder", handler: () => startFolderImport() },
    { key: "escape", description: "Back", handler: () => {} },
  ];

  function updateStatus(msg?: string) {
    const legend = formatKeyLegend(keyBindings);
    const extra = msg ? `  | ${msg}` : "";
    status.setContent(` ${legend}${extra}`);
    screen.render();
  }

  function nextField() {
    if (currentStep === 1) {
      currentStep = 2;
      updateStep();
      tagsInput.focus();
      tagsInput.readInput(() => {});
    } else if (currentStep === 2) {
      currentStep = 3;
      updateStep();
      textArea.focus();
      textArea.readInput(() => {});
    }
  }

  async function buildCurrentCard() {
    const title = (titleInput as any).getValue() || "Untitled";
    const tagsRaw = (tagsInput as any).getValue() || "";
    const text = (textArea as any).getValue() || "";

    if (!text.trim()) {
      updateStatus("Error: Text content is required");
      return;
    }

    const tags = tagsRaw
      .split(",")
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0);

    updateStatus("Building card...");

    try {
      const result = await buildArtifactCard({
        title,
        text,
        tags,
        render_png: true,
      });

      builtCardId = result.card_id;
      (resultBox as any).show();
      resultBox.setContent(
        ` {green-fg}✓ Card built!{/green-fg}  card_id: ${result.card_id}  |  [p] Open PNG  [n] New card`
      );
      updateStatus("Card built successfully");
      screen.render();
    } catch (err: any) {
      updateStatus(`Build failed: ${err.message}`);
    }
  }

  // Key handlers on container
  container.key(["C-s"], () => buildCurrentCard());

  container.key(["p"], () => {
    if (builtCardId) {
      openPng(cardPngPath(builtCardId));
    }
  });

  container.key(["f"], () => startFolderImport());

  container.key(["n"], () => {
    // Reset form
    titleInput.clearValue();
    tagsInput.clearValue();
    textArea.clearValue();
    (resultBox as any).hide();
    builtCardId = null;
    currentStep = 1;
    updateStep();
    titleInput.focus();
    screen.render();
  });

  async function startFolderImport() {
    const pathInput = blessed.textbox({
      parent: screen,
      ...({
        label: " Folder path to import ",
        top: "center",
        left: "center",
        width: "60%",
        height: 3,
        tags: true,
        keys: true,
        mouse: true,
        border: { type: "line" as const },
        style: {
          fg: "white",
          bg: "black",
          border: { fg: "cyan" },
          focus: { border: { fg: "green" } },
        },
      } as any),
    } as any);

    pathInput.focus();
    pathInput.readInput(() => {});
    screen.render();

    pathInput.on("submit", (folderPath: string) => {
      pathInput.destroy();
      screen.render();
      if (!folderPath || !folderPath.trim()) {
        updateStatus("Folder import cancelled");
        return;
      }

      const cleanPath = folderPath.trim();
      updateStatus(`Importing folder: ${cleanPath}...`);
      screen.render();

      ingestFolderHook({
        path: cleanPath,
        includeDocxText: true,
        includePdfText: true,
        storeBlobs: true,
      })
        .then((result) => {
          const { counts, folder_card_id, files } = result;
          const failed = files.filter((f) => f.error).length;
          (resultBox as any).show();
          resultBox.setContent(
            ` {green-fg}✓ Folder imported!{/green-fg}  ` +
              `${counts.files_total} files (${counts.docx} docx, ${counts.pdf} pdf, ${counts.other} other)  ` +
              `${counts.extracted_text_count} text extracted` +
              (failed > 0 ? `  {red-fg}${failed} failed{/red-fg}` : "") +
              `  |  card: ${folder_card_id}`
          );
          updateStatus("Folder import complete");
          screen.render();
        })
        .catch((importErr: any) => {
          updateStatus(`Import failed: ${importErr.message}`);
          screen.render();
        });
    });

    pathInput.on("cancel", () => {
      pathInput.destroy();
      updateStatus("Folder import cancelled");
      screen.render();
    });
  }

  titleInput.on("submit", () => {
    currentStep = 2;
    updateStep();
    tagsInput.focus();
    tagsInput.readInput(() => {});
  });

  tagsInput.on("submit", () => {
    currentStep = 3;
    updateStep();
    textArea.focus();
    textArea.readInput(() => {});
  });

  return {
    show() {
      container.show();
      status.show();
      currentStep = 1;
      updateStep();
      updateStatus();
      titleInput.focus();
      titleInput.readInput(() => {});
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
