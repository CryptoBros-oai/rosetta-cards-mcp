import blessed, { type Widgets } from "neo-blessed";
import {
  exportBundleHook,
  importBundleHook,
  listBundles,
  listCards,
} from "../../kb/hooks.js";
import { listPane, detailPane, statusBar } from "../ui/layout.js";
import { formatKeyLegend, type KeyBinding } from "../ui/keys.js";
import type { BundleMeta } from "../../kb/bundle.js";

export function createBundlesScreen(screen: Widgets.Screen): {
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

  // Bundles list
  const bundleList = blessed.list({
    parent: container,
    ...({
      ...listPane({
        label: " Bundles ",
        top: 0,
        left: 0,
        width: "50%",
        height: "100%",
      }),
    } as any),
  } as any);

  // Detail pane
  const detailBox = blessed.box({
    parent: container,
    ...({
      ...detailPane({
        label: " Bundle Details ",
        top: 0,
        left: "50%",
        width: "50%",
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

  let bundles: BundleMeta[] = [];

  const keyBindings: KeyBinding[] = [
    { key: "e", description: "Export All", handler: () => exportAll() },
    { key: "i", description: "Import", handler: () => promptImport() },
    { key: "r", description: "Refresh", handler: () => loadBundles() },
    { key: "q", description: "Back", handler: () => {} },
  ];

  function updateStatus(msg?: string) {
    const legend = formatKeyLegend(keyBindings);
    const extra = msg ? `  | ${msg}` : "";
    status.setContent(` ${legend}${extra}`);
    screen.render();
  }

  async function loadBundles() {
    try {
      bundles = await listBundles();
      const items = bundles.map(
        (b) =>
          `${b.bundle_id.slice(0, 20)}… | ${b.card_count} cards | ${b.created_at.slice(0, 10)}`
      );
      if (items.length === 0) {
        items.push("{gray-fg}No bundles yet{/gray-fg}");
      }
      (bundleList as any).setItems(items);
      if (bundles.length > 0) {
        showBundleDetail(0);
      } else {
        detailBox.setContent(
          "{center}{gray-fg}No bundles. Press [e] to export all cards.{/gray-fg}{/center}"
        );
      }
      screen.render();
    } catch (err: any) {
      updateStatus(`Error: ${err.message}`);
    }
  }

  function showBundleDetail(index: number) {
    if (index < 0 || index >= bundles.length) return;
    const b = bundles[index];
    const integrityShort = b.integrity_hash.slice(0, 16) + "…";
    const content = [
      `{bold}{cyan-fg}Bundle: ${b.bundle_id}{/cyan-fg}{/bold}`,
      "",
      `{gray-fg}Version:{/gray-fg}    ${b.version}`,
      `{gray-fg}Cards:{/gray-fg}      ${b.card_count}`,
      `{gray-fg}Created:{/gray-fg}    ${b.created_at}`,
      `{gray-fg}Integrity:{/gray-fg}  ${integrityShort}`,
      b.description ? `{gray-fg}Description:{/gray-fg} ${b.description}` : "",
      b.license_spdx
        ? `{gray-fg}License:{/gray-fg}    ${b.license_spdx}`
        : "",
      b.created_by?.name
        ? `{gray-fg}Author:{/gray-fg}     ${b.created_by.name}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    detailBox.setContent(content);
    screen.render();
  }

  async function exportAll() {
    updateStatus("Exporting all cards...");
    try {
      const cards = await listCards();
      if (cards.length === 0) {
        updateStatus("No cards to export");
        return;
      }
      const result = await exportBundleHook({
        select: { card_ids: cards.map((c) => c.card_id) },
        include_png: true,
        meta: { description: "Full export" },
      });
      updateStatus(
        `Exported ${result.manifest.card_count} cards → ${result.bundle_path}`
      );
      await loadBundles();
    } catch (err: any) {
      updateStatus(`Export failed: ${err.message}`);
    }
  }

  function promptImport() {
    const prompt = blessed.textbox({
      parent: screen,
      ...({
        label: " Bundle path to import ",
        top: "center",
        left: "center",
        width: "60%",
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

    prompt.focus();
    prompt.readInput(async (_err: any, value: string) => {
      prompt.destroy();
      if (!value?.trim()) {
        updateStatus("Import cancelled");
        return;
      }
      updateStatus("Importing...");
      try {
        const result = await importBundleHook({ bundle_path: value.trim() });
        const intMsg = result.integrity_ok
          ? "{green-fg}✓ integrity OK{/green-fg}"
          : "{red-fg}✗ integrity FAILED{/red-fg}";
        updateStatus(
          `Imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed.length} | ${intMsg}`
        );
        await loadBundles();
      } catch (err: any) {
        updateStatus(`Import failed: ${err.message}`);
      }
    });
    screen.render();
  }

  bundleList.on("select item", (_item: any, index: number) => {
    showBundleDetail(index);
  });

  bundleList.key(["e"], () => exportAll());
  bundleList.key(["i"], () => promptImport());
  bundleList.key(["r"], () => loadBundles());

  return {
    show() {
      container.show();
      status.show();
      updateStatus();
      loadBundles();
      bundleList.focus();
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
