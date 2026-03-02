export type KeyBinding = {
  key: string | string[];
  description: string;
  handler: () => void;
};

export type KeyMap = Map<string, KeyBinding>;

export function createKeyMap(bindings: KeyBinding[]): KeyMap {
  const map = new Map<string, KeyBinding>();
  for (const b of bindings) {
    const keys = Array.isArray(b.key) ? b.key : [b.key];
    for (const k of keys) {
      map.set(k, b);
    }
  }
  return map;
}

export function formatKeyLegend(bindings: KeyBinding[]): string {
  return bindings
    .map((b) => {
      const key = Array.isArray(b.key) ? b.key[0] : b.key;
      return `[${key}] ${b.description}`;
    })
    .join("  ");
}

// Common keybinds used across screens
export const GLOBAL_KEYS = {
  QUIT: "q",
  SEARCH: "/",
  ENTER: "enter",
  ESCAPE: "escape",
  SPACE: "space",
  TAB: "tab",
  UP: "up",
  DOWN: "down",
  BACK: "b",
  PNG: "p",
  EXPORT: "e",
  IMPORT: "i",
  DELETE: "d",
  HELP: "?",
};
