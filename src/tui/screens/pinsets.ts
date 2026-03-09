import blessed, { type Widgets } from 'neo-blessed';
import {
  listPinsets,
  listCards,
  setActivePinset,
  getActivePinset,
  createBehaviorPackFromPinset,
  listBehaviorPacks,
  setActivePack,
  getActivePack,
  deleteBehaviorPack,
  exportActivePackHook,
  exportPackClosure,
} from '../../kb/hooks.js';
import { planExport } from '../../kb/bundle_plan.js';
import { createPinset, deletePinset, loadPinset, type Pinset } from '../../kb/vault.js';
import type { BehaviorPack } from '../../kb/schema.js';
import { listPane, detailPane, statusBar } from '../ui/layout.js';
import { formatKeyLegend, type KeyBinding } from '../ui/keys.js';

type ListItem = { kind: 'pinset'; data: Pinset } | { kind: 'pack'; data: BehaviorPack };

export function createPinsetsScreen(screen: Widgets.Screen): {
  show: () => void;
  hide: () => void;
  destroy: () => void;
} {
  const container = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: '100%',
    height: '100%-6',
    hidden: true,
  });

  const itemList = blessed.list({
    parent: container,
    ...({
      ...listPane({
        label: ' Pinsets & Behavior Packs ',
        top: 0,
        left: 0,
        width: '50%',
        height: '100%',
      }),
    } as any),
  } as any);

  const detailBox = blessed.box({
    parent: container,
    ...({
      ...detailPane({
        label: ' Details ',
        top: 0,
        left: '50%',
        width: '50%',
        height: '100%',
      }),
    } as any),
  } as any);

  const status = blessed.box({
    parent: screen,
    ...({
      ...statusBar(),
    } as any),
  } as any);

  let items: ListItem[] = [];
  let activePinsetId: string | null = null;
  let activePackId: string | null = null;
  let selectedIndex = 0;

  const keyBindings: KeyBinding[] = [
    { key: 'a', description: 'Activate', handler: () => activateCurrent() },
    { key: 'c', description: 'Create Pinset', handler: () => createNew() },
    { key: 'b', description: 'Promote→Pack', handler: () => promoteToPack() },
    { key: 'e', description: 'Export Pack', handler: () => exportActivePack() },
    { key: 'd', description: 'Delete', handler: () => deleteCurrent() },
  ];

  function updateStatus(msg?: string) {
    const legend = formatKeyLegend(keyBindings);
    const extra = msg ? `  | ${msg}` : '';
    status.setContent(` ${legend}${extra}`);
    screen.render();
  }

  async function loadAll() {
    try {
      const pinsets = await listPinsets();
      const packs = await listBehaviorPacks();
      activePinsetId = await getActivePinset();
      activePackId = await getActivePack();

      items = [
        ...packs.map((p): ListItem => ({ kind: 'pack', data: p })),
        ...pinsets.map((p): ListItem => ({ kind: 'pinset', data: p })),
      ];

      const displayItems = items.map(item => {
        if (item.kind === 'pack') {
          const p = item.data;
          const active = p.pack_id === activePackId ? ' {green-fg}● ACTIVE{/green-fg}' : '';
          return `{cyan-fg}[PACK]{/cyan-fg} ${p.name} (${p.pins.length} pins)${active}`;
        } else {
          const p = item.data;
          const active = p.pinset_id === activePinsetId ? ' {green-fg}● ACTIVE{/green-fg}' : '';
          return `{gray-fg}[PIN]{/gray-fg}  ${p.name} (${p.card_ids.length} cards)${active}`;
        }
      });

      if (displayItems.length === 0) {
        displayItems.push('{gray-fg}No pinsets or packs. Press [c] to create.{/gray-fg}');
      }

      (itemList as any).setItems(displayItems);
      if (items.length > 0) {
        showDetail(0);
      } else {
        detailBox.setContent(
          '{center}{gray-fg}Create pinsets, then promote to behavior packs.{/gray-fg}{/center}'
        );
      }
      screen.render();
    } catch (err: any) {
      updateStatus(`Error: ${err.message}`);
    }
  }

  function showDetail(index: number) {
    if (index < 0 || index >= items.length) return;
    const item = items[index];

    if (item.kind === 'pack') {
      const p = item.data;
      const isActive = p.pack_id === activePackId;
      const content = [
        `{bold}{cyan-fg}Behavior Pack: ${p.name}{/cyan-fg}{/bold}${isActive ? ' {green-fg}● ACTIVE{/green-fg}' : ''}`,
        '',
        `{gray-fg}pack_id:{/gray-fg}      ${p.pack_id}`,
        `{gray-fg}Version:{/gray-fg}      ${p.version}`,
        `{gray-fg}Created:{/gray-fg}      ${p.created_at}`,
        `{gray-fg}Hash:{/gray-fg}         ${p.hash.slice(0, 16)}…`,
        p.description ? `{gray-fg}Description:{/gray-fg}  ${p.description}` : '',
        '',
        '{bold}Policies:{/bold}',
        `  search_boost: ${p.policies.search_boost}`,
        p.policies.max_results != null ? `  max_results:  ${p.policies.max_results}` : '',
        p.policies.allowed_tags?.length
          ? `  allowed_tags: ${p.policies.allowed_tags.join(', ')}`
          : '',
        p.policies.blocked_tags?.length
          ? `  blocked_tags: ${p.policies.blocked_tags.join(', ')}`
          : '',
        p.policies.style ? `  style:        ${p.policies.style}` : '',
        '',
        `{bold}Pins (${p.pins.length} card hashes):{/bold}`,
        ...p.pins.map(h => `  ${h.slice(0, 20)}…`),
      ]
        .filter(Boolean)
        .join('\n');
      detailBox.setContent(content);
    } else {
      const p = item.data;
      const isActive = p.pinset_id === activePinsetId;
      const content = [
        `{bold}{cyan-fg}Pinset: ${p.name}{/cyan-fg}{/bold}${isActive ? ' {green-fg}● ACTIVE{/green-fg}' : ''}`,
        '',
        `{gray-fg}pinset_id:{/gray-fg}   ${p.pinset_id}`,
        `{gray-fg}Created:{/gray-fg}     ${p.created_at}`,
        p.description ? `{gray-fg}Description:{/gray-fg} ${p.description}` : '',
        '',
        `{bold}Cards (${p.card_ids.length}):{/bold}`,
        ...p.card_ids.map(id => `  • ${id}`),
        '',
        '{yellow-fg}Press [b] to promote to Behavior Pack{/yellow-fg}',
      ]
        .filter(Boolean)
        .join('\n');
      detailBox.setContent(content);
    }
    screen.render();
  }

  async function activateCurrent() {
    if (selectedIndex < 0 || selectedIndex >= items.length) return;
    const item = items[selectedIndex];

    try {
      if (item.kind === 'pack') {
        const p = item.data;
        if (p.pack_id === activePackId) {
          await setActivePack(null);
          updateStatus(`Deactivated pack "${p.name}"`);
        } else {
          await setActivePack(p.pack_id);
          updateStatus(`Activated pack "${p.name}" — hooks now use its policies`);
        }
      } else {
        const p = item.data;
        if (p.pinset_id === activePinsetId) {
          await setActivePinset(null);
          updateStatus(`Deactivated pinset "${p.name}"`);
        } else {
          await setActivePinset(p.pinset_id);
          updateStatus(`Activated pinset "${p.name}"`);
        }
      }
      await loadAll();
    } catch (err: any) {
      updateStatus(`Error: ${err.message}`);
    }
  }

  async function promoteToPack() {
    if (selectedIndex < 0 || selectedIndex >= items.length) return;
    const item = items[selectedIndex];
    if (item.kind !== 'pinset') {
      updateStatus('Only pinsets can be promoted to behavior packs');
      return;
    }

    try {
      const pack = await createBehaviorPackFromPinset(item.data.pinset_id);
      updateStatus(`Promoted "${item.data.name}" → pack ${pack.pack_id.slice(0, 20)}…`);
      await loadAll();
    } catch (err: any) {
      updateStatus(`Promote failed: ${err.message}`);
    }
  }

  function createNew() {
    const namePrompt = blessed.textbox({
      parent: screen,
      ...({
        label: ' Pinset name ',
        top: 'center',
        left: 'center',
        width: '60%',
        height: 3,
        tags: true,
        keys: true,
        mouse: true,
        style: {
          fg: 'white',
          bg: 'black',
          border: { fg: 'yellow' },
          focus: { border: { fg: 'green' } },
        },
        border: { type: 'line' as const },
      } as any),
    } as any);

    namePrompt.focus();
    namePrompt.readInput(async (_err: any, name: string) => {
      namePrompt.destroy();
      if (!name?.trim()) {
        updateStatus('Create cancelled');
        return;
      }

      try {
        const allCards = await listCards();
        if (allCards.length === 0) {
          updateStatus('No cards exist to add to pinset');
          return;
        }

        const cardSelector = blessed.list({
          parent: screen,
          ...({
            label: ' Select cards (space=toggle, enter=done) ',
            top: 'center',
            left: 'center',
            width: '70%',
            height: '60%',
            tags: true,
            keys: true,
            vi: true,
            mouse: true,
            style: {
              fg: 'white',
              bg: 'black',
              border: { fg: 'cyan' },
              selected: { bg: 'cyan', fg: 'black' },
            },
            border: { type: 'line' as const },
          } as any),
        } as any);

        const selected = new Set<number>();

        function renderCardList() {
          const cardItems = allCards.map((c, i) => {
            const check = selected.has(i) ? '{green-fg}[✓]{/green-fg}' : '[ ]';
            return `${check} ${c.title} {gray-fg}(${c.tags.slice(0, 2).join(', ')}){/gray-fg}`;
          });
          (cardSelector as any).setItems(cardItems);
          screen.render();
        }

        renderCardList();
        cardSelector.focus();

        cardSelector.key(['space'], () => {
          const idx = (cardSelector as any).selected;
          if (selected.has(idx)) selected.delete(idx);
          else selected.add(idx);
          renderCardList();
          (cardSelector as any).select(idx);
        });

        cardSelector.key(['enter'], async () => {
          const card_ids = [...selected].map(i => allCards[i].card_id);
          cardSelector.destroy();

          if (card_ids.length === 0) {
            updateStatus('No cards selected');
            return;
          }

          try {
            await createPinset({ name: name.trim(), card_ids });
            updateStatus(`Created pinset "${name.trim()}" with ${card_ids.length} cards`);
            await loadAll();
          } catch (err: any) {
            updateStatus(`Create failed: ${err.message}`);
          }
        });

        cardSelector.key(['escape'], () => {
          cardSelector.destroy();
          updateStatus('Create cancelled');
          screen.render();
        });

        screen.render();
      } catch (err: any) {
        updateStatus(`Error: ${err.message}`);
      }
    });
    screen.render();
  }

  async function deleteCurrent() {
    if (selectedIndex < 0 || selectedIndex >= items.length) return;
    const item = items[selectedIndex];

    const label =
      item.kind === 'pack' ? (item.data as BehaviorPack).name : (item.data as Pinset).name;

    const confirm = blessed.question({
      parent: screen,
      ...({
        top: 'center',
        left: 'center',
        width: '50%',
        height: 5,
        tags: true,
        keys: true,
        style: {
          fg: 'white',
          bg: 'black',
          border: { fg: 'red' },
        },
        border: { type: 'line' as const },
      } as any),
    } as any);

    confirm.ask(`Delete "${label}"?`, async (_err: any, ok: boolean) => {
      confirm.destroy();
      if (ok) {
        try {
          if (item.kind === 'pack') {
            await deleteBehaviorPack((item.data as BehaviorPack).pack_id);
          } else {
            await deletePinset((item.data as Pinset).pinset_id);
          }
          updateStatus(`Deleted "${label}"`);
          await loadAll();
        } catch (err: any) {
          updateStatus(`Delete failed: ${(err as Error).message}`);
        }
      }
      screen.render();
    });
    screen.render();
  }

  async function exportActivePack() {
    if (!activePackId) {
      updateStatus('No active pack to export');
      return;
    }

    try {
      updateStatus('Computing export plan...');
      const plan = await planExport({ pack_id: activePackId });

      const sizeKB = (plan.estimated_bytes / 1024).toFixed(1);
      const lines = [
        `{bold}{cyan-fg}Export Preview{/cyan-fg}{/bold}`,
        '',
        `{gray-fg}Scope:{/gray-fg}      ${plan.scope}`,
        `{gray-fg}Pack:{/gray-fg}       ${plan.pack?.name ?? 'unknown'}`,
        `{gray-fg}Cards:{/gray-fg}      ${plan.artifact_count}`,
        `{gray-fg}Blobs:{/gray-fg}      ${plan.blob_count}`,
        `{gray-fg}Text:{/gray-fg}       ${plan.text_count}`,
        `{gray-fg}Est. size:{/gray-fg}  ${sizeKB} KB`,
      ];
      if (plan.notes.length > 0) {
        lines.push('', ...plan.notes.map(n => `{yellow-fg}${n}{/yellow-fg}`));
      }
      lines.push('', '{green-fg}[Enter]{/green-fg} Export   {red-fg}[Esc]{/red-fg} Cancel');

      const preview = blessed.box({
        parent: screen,
        ...({
          label: ' Export Preview ',
          top: 'center',
          left: 'center',
          width: '60%',
          height: lines.length + 4,
          tags: true,
          keys: true,
          content: lines.join('\n'),
          padding: { left: 1, right: 1, top: 1, bottom: 1 },
          style: {
            fg: 'white',
            bg: 'black',
            border: { fg: 'cyan' },
          },
          border: { type: 'line' as const },
        } as any),
      } as any);

      preview.focus();
      screen.render();

      preview.key(['enter'], async () => {
        preview.destroy();
        screen.render();
        try {
          updateStatus('Exporting active pack closure...');
          const result = await exportActivePackHook();
          updateStatus(
            `Exported ${result.card_count} cards, ${result.blob_count} blobs → ${result.bundle_path}`
          );
        } catch (err: any) {
          updateStatus(`Export failed: ${err.message}`);
        }
      });

      preview.key(['escape'], () => {
        preview.destroy();
        updateStatus('Export cancelled');
        screen.render();
      });
    } catch (err: any) {
      updateStatus(`Preview failed: ${err.message}`);
    }
  }

  itemList.on('select item', (_item: any, index: number) => {
    selectedIndex = index;
    showDetail(index);
  });

  itemList.key(['a'], () => activateCurrent());
  itemList.key(['c'], () => createNew());
  itemList.key(['b'], () => promoteToPack());
  itemList.key(['e'], () => exportActivePack());
  itemList.key(['d'], () => deleteCurrent());
  itemList.key(['r'], () => loadAll());

  return {
    show() {
      container.show();
      status.show();
      updateStatus();
      loadAll();
      itemList.focus();
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
