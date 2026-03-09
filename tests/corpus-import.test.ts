import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const TEST_ROOT = path.join(process.cwd(), "data-corpus-import-test-root");
const FIXTURE_ROOT = path.join(TEST_ROOT, "fixtures");
const LOCAL_FIXTURE = path.join(FIXTURE_ROOT, "local");

const origCwd = process.cwd;
const origFetch = globalThis.fetch;

async function ensureVaultDirs() {
  const dirs = [
    "docs",
    "cards",
    "index",
    "bundles",
    "pinsets",
    "packs",
    "blobs",
    "text",
    "graphs",
  ];
  for (const dir of dirs) {
    await fs.mkdir(path.join(TEST_ROOT, "data", dir), { recursive: true });
  }
}

async function makeLocalFixture() {
  await fs.mkdir(path.join(LOCAL_FIXTURE, "nested"), { recursive: true });
  await fs.writeFile(path.join(LOCAL_FIXTURE, "zeta.md"), "# Zeta\n\nlocal markdown fixture\n", "utf-8");
  await fs.writeFile(path.join(LOCAL_FIXTURE, "alpha.txt"), "alpha fixture line\n", "utf-8");
  await fs.writeFile(path.join(LOCAL_FIXTURE, "nested", "beta.md"), "# Beta\n\nnested fixture\n", "utf-8");
  await fs.writeFile(path.join(LOCAL_FIXTURE, "skip.bin"), Buffer.from([0x00, 0x01, 0x02]));
  await fs.writeFile(path.join(LOCAL_FIXTURE, "script.ts"), "console.log('skip');\n", "utf-8");
}

async function findCardByHash(hash: string): Promise<any> {
  const cardDir = path.join(TEST_ROOT, "data", "cards");
  const files = await fs.readdir(cardDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(cardDir, file), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.hash === hash) return parsed;
  }
  throw new Error(`Card hash not found: ${hash}`);
}

async function readTextByHash(hash: string): Promise<string> {
  const textPath = path.join(
    TEST_ROOT,
    "data",
    "text",
    hash.slice(0, 2),
    hash.slice(2, 4),
    `${hash}.txt`,
  );
  return fs.readFile(textPath, "utf-8");
}

before(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await ensureVaultDirs();
  await makeLocalFixture();
  process.cwd = () => TEST_ROOT;
});

beforeEach(async () => {
  await fs.rm(path.join(TEST_ROOT, "data"), { recursive: true, force: true }).catch(() => {});
  await ensureVaultDirs();
});

after(async () => {
  process.cwd = origCwd;
  globalThis.fetch = origFetch;
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("Local corpus import", () => {
  it("applies stable ordering, filters extensions, and is deterministic across runs", async () => {
    const { importLocalCorpus } = await import("../src/kb/corpus_import.js");

    const first = await importLocalCorpus({
      root_path: LOCAL_FIXTURE,
      include_extensions: [".md", ".txt"],
      recursive: true,
      tags: ["seed", "local"],
    });
    const second = await importLocalCorpus({
      root_path: LOCAL_FIXTURE,
      include_extensions: [".md", ".txt"],
      recursive: true,
      tags: ["seed", "local"],
    });

    assert.equal(first.imported_count, 3);
    assert.equal(first.skipped_count, 2);
    assert.equal(first.errors.length, 0);
    assert.deepEqual(first.doc_ids, second.doc_ids);
  });

  it("rejects unknown keys at the hook boundary", async () => {
    const { runLocalCorpusImport } = await import("../src/kb/corpus_hooks.js");
    await assert.rejects(
      () =>
        runLocalCorpusImport({
          root_path: LOCAL_FIXTURE,
          unknown_field: true,
        } as any),
      /unrecognized key/i,
    );
  });
});

describe("GitHub corpus import", () => {
  it("applies path filtering, stable path ordering, provenance isolation, and text-only filtering", async () => {
    const { importGithubCorpus } = await import("../src/kb/corpus_import.js");

    const installFetchMock = (treePaths: string[]) => {
      globalThis.fetch = (async (input: any) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/test-org/test-repo") {
          return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
        }
        if (url.includes("/git/trees/")) {
          return new Response(
            JSON.stringify({
              tree: treePaths.map((entry) => ({ path: entry, type: "blob" })),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/docs/alpha.md")) {
          return new Response("# Alpha\n\ngithub alpha\n", { status: 200 });
        }
        if (url.endsWith("/docs/beta.txt")) {
          return new Response("github beta\n", { status: 200 });
        }
        if (url.endsWith("/README.md")) {
          return new Response("# Readme\n", { status: 200 });
        }
        if (url.endsWith("/src/main.ts")) {
          return new Response("export const x = 1;\n", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as any;
    };

    installFetchMock(["src/main.ts", "docs/beta.txt", "docs/alpha.md", "README.md"]);
    const first = await importGithubCorpus({
      repo_url: "https://github.com/test-org/test-repo",
      path_filter: ["docs/"],
      max_files: 10,
      source_label: "first",
    });

    installFetchMock(["docs/alpha.md", "README.md", "src/main.ts", "docs/beta.txt"]);
    const second = await importGithubCorpus({
      repo_url: "https://github.com/test-org/test-repo",
      path_filter: ["docs/"],
      max_files: 10,
      source_label: "second",
    });

    assert.equal(first.imported_count, 2);
    assert.equal(first.skipped_count, 0);
    assert.deepEqual(first.doc_ids, second.doc_ids, "ordering should be stable by path");

    // Source label and path metadata must not affect identity hashes.
    assert.deepEqual(first.doc_ids, second.doc_ids);
  });
});

describe("arXiv corpus import", () => {
  it("imports title+abstract docs with stable ordering under mocked feed data", async () => {
    const { importArxivCorpus } = await import("../src/kb/corpus_import.js");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2501.00002v1</id>
          <title>Second Paper</title>
          <summary>Second abstract text.</summary>
        </entry>
        <entry>
          <id>http://arxiv.org/abs/2501.00001v1</id>
          <title>First Paper</title>
          <summary>First abstract text.</summary>
        </entry>
      </feed>`;

    globalThis.fetch = (async () => new Response(xml, { status: 200 })) as any;

    const first = await importArxivCorpus({
      query: "transformer inference optimization",
      max_results: 2,
      include_abstract_only: true,
      source_label: "batch-1",
    });
    const second = await importArxivCorpus({
      query: "transformer inference optimization",
      max_results: 2,
      include_abstract_only: true,
      source_label: "batch-2",
    });

    assert.equal(first.imported_count, 2);
    assert.deepEqual(first.doc_ids, second.doc_ids);

    const firstCard = await findCardByHash(first.doc_ids[0]);
    assert.equal(firstCard.type, "file_artifact");
    const firstText = await readTextByHash(firstCard.text.hash);
    assert.match(firstText, /Second Paper/);
    assert.match(firstText, /Second abstract text\./);
    assert.ok(!firstText.includes("2501.00002v1"), "arXiv ID should stay in provenance sidecar only");
  });
});

describe("Synthetic corpus generation", () => {
  it("is deterministic and emits predictable execution/event scaffolding", async () => {
    const { generateSyntheticCorpus } = await import("../src/kb/corpus_import.js");

    const first = await generateSyntheticCorpus({
      theme: "gpu inference",
      doc_count: 8,
      pipeline_count: 2,
      tags: ["test"],
    });
    const second = await generateSyntheticCorpus({
      theme: "gpu inference",
      doc_count: 8,
      pipeline_count: 2,
      tags: ["test"],
    });

    assert.deepEqual(first.doc_ids, second.doc_ids);
    assert.equal(first.imported_count, 8);
    assert.equal(first.generated_execution_count, 8);
    assert.equal(first.generated_event_count, 2);

    const cardDir = path.join(TEST_ROOT, "data", "cards");
    const executionFiles = (await fs.readdir(cardDir)).filter((f) =>
      f.startsWith("card_execution_") && f.endsWith(".json"),
    );
    assert.ok(executionFiles.length >= 8, "synthetic import should create execution links");

    const pipelines = new Set<string>();
    let hasParentLink = false;
    for (const file of executionFiles) {
      const raw = await fs.readFile(path.join(cardDir, file), "utf-8");
      const parsed = JSON.parse(raw);
      const chain = parsed.execution?.chain;
      if (chain?.pipeline_id) pipelines.add(chain.pipeline_id);
      if (chain?.parent_execution_id) hasParentLink = true;
    }
    assert.equal(pipelines.size, 2, "pipeline relationship density should match requested pipeline_count");
    assert.equal(hasParentLink, true, "at least one execution should link to a parent");
  });
});

describe("CLI and TUI hook integration", () => {
  it("CLI route invokes shared hook path and emits scriptable summary lines", async () => {
    const { runCorpusCli } = await import("../src/cli/corpus.js");
    const logs: string[] = [];
    const errors: string[] = [];

    const code = await runCorpusCli(
      [
        "synthetic",
        "--theme",
        "gpu inference",
        "--doc-count",
        "4",
        "--pipeline-count",
        "2",
        "--build-cards",
        "true",
        "--export-graph",
        "true",
      ],
      {
        log: (...args: any[]) => logs.push(args.join(" ")),
        error: (...args: any[]) => errors.push(args.join(" ")),
      },
    );

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.ok(logs.some((line) => line.startsWith("Imported 4 docs")));
    assert.ok(logs.some((line) => line.startsWith("Built 4 cards")));
    assert.ok(logs.some((line) => line.startsWith("Exported graph to ")));
  });

  it("TUI screen references the same hook functions for all corpus modes", async () => {
    const { CORPUS_IMPORT_RUNNERS } = await import("../src/tui/screens/corpus.js");
    const hooks = await import("../src/kb/corpus_hooks.js");

    assert.equal(CORPUS_IMPORT_RUNNERS.local, hooks.runLocalCorpusImport);
    assert.equal(CORPUS_IMPORT_RUNNERS.github, hooks.runGithubCorpusImport);
    assert.equal(CORPUS_IMPORT_RUNNERS.arxiv, hooks.runArxivCorpusImport);
    assert.equal(CORPUS_IMPORT_RUNNERS.synthetic, hooks.runSyntheticCorpusImport);
  });
});
