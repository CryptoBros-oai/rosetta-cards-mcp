import blessed, { type Widgets } from "neo-blessed";
import {
  searchArtifacts,
  getCardDetails,
  openPng,
  listCards,
  getVaultContext,
  type SearchResult,
} from "../../kb/hooks.js";
import { verifyHash } from "../../kb/canonical.js";
import { loadCard } from "../../kb/vault.js";
import { listPane, detailPane, statusBar } from "../ui/layout.js";
import { formatKeyLegend, type KeyBinding } from "../ui/keys.js";
import { GLOBAL_KEYS } from "../ui/keys.js";

export function createBrowserScreen(screen: Widgets.Screen): {
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

  const searchInput = blessed.textbox({
    parent: container,
    ...({
      label: " Search ",
      top: 0,
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

  const resultsList = blessed.list({
    parent: container,
    ...({
      ...listPane({
        label: " Results ",
        top: 3,
        left: 0,
        width: "50%",
        height: "100%-3",
      }),
    } as any),
  } as any);

  const detailBox = blessed.box({
    parent: container,
    ...({
      ...detailPane({
        label: " Card Preview ",
        top: 3,
        left: "50%",
        width: "50%",
        height: "100%-3",
      }),
    } as any),
  } as any);

  const status = blessed.box({
    parent: screen,
    ...({
      ...statusBar(),
    } as any),
  } as any);

  let currentResults: SearchResult[] = [];
  let selectedIndex = 0;

  const keyBindings: KeyBinding[] = [
    { key: "/", description: "Search", handler: () => focusSearch() },
    { key: "enter", description: "Details", handler: () => showDetails() },
    { key: "p", description: "Open PNG", handler: () => openCurrentPng() },
    { key: "h", description: "Hash Diff", handler: () => showHashDiff() },
    { key: "r", description: "Refresh", handler: () => loadAll() },
  ];

  function updateStatus(msg?: string) {
    const legend = formatKeyLegend(keyBindings);
    const extra = msg ? `  | ${msg}` : "";
    status.setContent(` ${legend}${extra}`);
    screen.render();
  }

  function focusSearch() {
    searchInput.focus();
    searchInput.readInput(() => {});
  }

  async function doSearch(query: string) {
    updateStatus("Searching...");
    try {
      if (query.trim()) {
        currentResults = await searchArtifacts({ query, top_k: 20 });
      } else {
        const allCards = await listCards();
        currentResults = allCards.map((c) => ({
          card_id: c.card_id,
          title: c.title,
          score: 1,
          tags: c.tags,
        }));
      }
      renderResults();

      const ctx = await getVaultContext();
      const packInfo = ctx.activePack
        ? `Pack: ${ctx.activePack.name}`
        : "No pack";
      updateStatus(`${currentResults.length} results | ${packInfo}`);
    } catch (err: any) {
      updateStatus(`Error: ${err.message}`);
    }
  }

  function renderResults() {
    const items = currentResults.map((r) => {
      const score = r.score < 1 ? ` (${(r.score * 100).toFixed(0)}%)` : "";
      const tags = r.tags.length
        ? ` {gray-fg}[${r.tags.slice(0, 3).join(", ")}]{/gray-fg}`
        : "";
      const pin = r.pinned ? "{green-fg}●{/green-fg} " : "";
      return `${pin}${r.title}${score}${tags}`;
    });
    (resultsList as any).setItems(items);
    if (currentResults.length > 0) {
      (resultsList as any).select(0);
      selectedIndex = 0;
      showPreview(0);
    } else {
      detailBox.setContent("{center}{gray-fg}No results{/gray-fg}{/center}");
    }
    screen.render();
  }

  async function showPreview(index: number) {
    if (index < 0 || index >= currentResults.length) return;
    const result = currentResults[index];
    try {
      const details = await getCardDetails(result.card_id);
      const card = details.card;

      const hashBadge = details.hash_valid
        ? "{green-fg}✓ verified{/green-fg}"
        : "{red-fg}✗ MISMATCH{/red-fg}";

      const pinBadge = result.pinned
        ? " {green-fg}● pinned{/green-fg}"
        : "";

      const content = [
        `{bold}{cyan-fg}${card.title}{/cyan-fg}{/bold}${pinBadge}`,
        "",
        `{gray-fg}card_id:{/gray-fg} ${card.card_id}`,
        `{gray-fg}hash:{/gray-fg}   ${card.hash.slice(0, 16)}… ${hashBadge}`,
        `{gray-fg}created:{/gray-fg} ${card.created_at}`,
        "",
        "{bold}Bullets:{/bold}",
        ...card.bullets.map((b) => `  • ${b}`),
        "",
        "{bold}Tags:{/bold}",
        `  ${card.tags.join(", ") || "(none)"}`,
        "",
        "{bold}Sources:{/bold}",
        ...card.sources.map(
          (s) => `  ${s.doc_id}${s.chunk_id != null ? `:${s.chunk_id}` : ""}`
        ),
      ].join("\n");

      detailBox.setContent(content);
      screen.render();
    } catch {
      detailBox.setContent("{red-fg}Failed to load card details{/red-fg}");
      screen.render();
    }
  }

  async function showDetails() {
    if (selectedIndex < 0 || selectedIndex >= currentResults.length) return;
    await showPreview(selectedIndex);
  }

  async function showHashDiff() {
    if (selectedIndex < 0 || selectedIndex >= currentResults.length) return;
    const result = currentResults[selectedIndex];
    try {
      const card = await loadCard(result.card_id);
      const verification = verifyHash(
        card as unknown as Record<string, unknown>,
        "hash"
      );

      const lines = [
        `{bold}{cyan-fg}Hash Verification: ${card.title}{/cyan-fg}{/bold}`,
        "",
        verification.valid
          ? "{green-fg}✓ HASH VERIFIED{/green-fg}"
          : "{red-fg}✗ HASH MISMATCH — DATA MAY BE CORRUPTED{/red-fg}",
        "",
        `{gray-fg}Expected:{/gray-fg}  ${verification.expected}`,
        `{gray-fg}Computed:{/gray-fg}  ${verification.computed}`,
        "",
        `{gray-fg}Card ID:{/gray-fg}   ${card.card_id}`,
        `{gray-fg}Version:{/gray-fg}   ${card.version}`,
        `{gray-fg}Created:{/gray-fg}   ${card.created_at}`,
        `{gray-fg}Title:{/gray-fg}     ${card.title}`,
        `{gray-fg}Bullets:{/gray-fg}   ${card.bullets.length}`,
        `{gray-fg}Tags:{/gray-fg}      ${card.tags.join(", ")}`,
        `{gray-fg}Sources:{/gray-fg}   ${card.sources.length}`,
      ];

      if (!verification.valid) {
        lines.push(
          "",
          "{yellow-fg}Possible causes:{/yellow-fg}",
          "  • Card was edited after creation",
          "  • Serialization changed (encoding/format)",
          "  • File was corrupted on disk",
          "  • Card was imported from incompatible system"
        );
      }

      detailBox.setContent(lines.join("\n"));
      screen.render();
    } catch {
      updateStatus("Failed to verify hash");
    }
  }

  async function openCurrentPng() {
    if (selectedIndex < 0 || selectedIndex >= currentResults.length) return;
    const result = currentResults[selectedIndex];
    try {
      const details = await getCardDetails(result.card_id);
      openPng(details.png_path);
      updateStatus("Opened PNG");
    } catch {
      updateStatus("No PNG available");
    }
  }

  async function loadAll() {
    await doSearch("");
  }

  searchInput.on("submit", (value: string) => {
    doSearch(value);
    resultsList.focus();
  });

  searchInput.on("cancel", () => {
    resultsList.focus();
  });

  resultsList.on("select item", (_item: any, index: number) => {
    selectedIndex = index;
    showPreview(index);
  });

  resultsList.key(["p"], () => openCurrentPng());
  resultsList.key(["h"], () => showHashDiff());
  resultsList.key(["r"], () => loadAll());
  resultsList.key(["/"], () => focusSearch());

  return {
    show() {
      container.show();
      status.show();
      updateStatus();
      loadAll();
      resultsList.focus();
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
