// Common layout helpers and theme for the TUI
// Uses neo-blessed widget options

export const THEME = {
  bg: "black",
  fg: "white",
  border: { fg: "cyan" },
  selected: { bg: "cyan", fg: "black" },
  muted: { fg: "gray" },
  success: { fg: "green" },
  warning: { fg: "yellow" },
  error: { fg: "red" },
  title: { fg: "cyan", bold: true },
};

export function headerBox() {
  return {
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: " {bold}{cyan-fg}Rosetta Cards{/cyan-fg}{/bold}  |  Knowledge Card Manager",
    tags: true,
    style: { fg: "white", bg: "black", border: { fg: "cyan" } },
    border: { type: "line" as const },
  };
}

export function statusBar() {
  return {
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    style: { fg: "white", bg: "black", border: { fg: "cyan" } },
    border: { type: "line" as const },
  };
}

export function listPane(opts: {
  label: string;
  top: number;
  left: number | string;
  width: number | string;
  height: number | string;
}) {
  return {
    ...opts,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    style: {
      fg: "white",
      bg: "black",
      border: { fg: "cyan" },
      selected: { bg: "cyan", fg: "black" },
      item: { fg: "white" },
    },
    border: { type: "line" as const },
    scrollbar: {
      ch: " ",
      track: { bg: "gray" },
      style: { inverse: true },
    },
  };
}

export function detailPane(opts: {
  label: string;
  top: number;
  left: number | string;
  width: number | string;
  height: number | string;
}) {
  return {
    ...opts,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    style: {
      fg: "white",
      bg: "black",
      border: { fg: "cyan" },
    },
    border: { type: "line" as const },
    scrollbar: {
      ch: " ",
      track: { bg: "gray" },
      style: { inverse: true },
    },
  };
}

export function inputBox(opts: {
  label: string;
  top: number | string;
  left: number | string;
  width: number | string;
  height: number;
}) {
  return {
    ...opts,
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
  };
}
