import blessed from "neo-blessed";
import { createBrowserScreen } from "./screens/browser.js";
import { createBuildScreen } from "./screens/build.js";
import { createBundlesScreen } from "./screens/bundles.js";
import { createPinsetsScreen } from "./screens/pinsets.js";
import { headerBox } from "./ui/layout.js";

type ScreenName = "browser" | "build" | "bundles" | "pinsets";

export function startTUI() {
  const screen = blessed.screen({
    smartCSR: true,
    title: "Rosetta Cards",
    fullUnicode: true,
  });

  // Header
  const header = blessed.box({
    parent: screen,
    ...(headerBox() as any),
  } as any);

  // Tab bar
  const tabBar = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    style: { fg: "white", bg: "black", border: { fg: "cyan" } },
    border: { type: "line" as const },
  } as any);

  // Create all screens
  const browserScreen = createBrowserScreen(screen);
  const buildScreen = createBuildScreen(screen);
  const bundlesScreen = createBundlesScreen(screen);
  const pinsetsScreen = createPinsetsScreen(screen);

  const screens: Record<
    ScreenName,
    { show: () => void; hide: () => void; destroy: () => void }
  > = {
    browser: browserScreen,
    build: buildScreen,
    bundles: bundlesScreen,
    pinsets: pinsetsScreen,
  };

  let activeScreen: ScreenName = "browser";

  function updateTabs() {
    const tabs: [ScreenName, string, string][] = [
      ["browser", "1", "Browse"],
      ["build", "2", "Build Card"],
      ["bundles", "3", "Bundles"],
      ["pinsets", "4", "Pinsets"],
    ];

    const rendered = tabs
      .map(([name, key, label]) => {
        if (name === activeScreen) {
          return `{bold}{cyan-fg}[${key}] ${label}{/cyan-fg}{/bold}`;
        }
        return `{gray-fg}[${key}] ${label}{/gray-fg}`;
      })
      .join("    ");

    tabBar.setContent(` ${rendered}`);
    screen.render();
  }

  function switchScreen(name: ScreenName) {
    if (name === activeScreen) return;
    screens[activeScreen].hide();
    activeScreen = name;
    screens[activeScreen].show();
    updateTabs();
  }

  // Global keybindings
  screen.key(["1"], () => switchScreen("browser"));
  screen.key(["2"], () => switchScreen("build"));
  screen.key(["3"], () => switchScreen("bundles"));
  screen.key(["4"], () => switchScreen("pinsets"));
  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  // Start with browser
  updateTabs();
  browserScreen.show();
  screen.render();
}

// Run if executed directly
startTUI();
