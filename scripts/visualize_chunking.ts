#!/usr/bin/env node
/**
 * Visualize chunking + hashing for a text file.
 *
 * Usage:
 *   node --loader ts-node/esm scripts/visualize_chunking.ts [path/to/file.txt]
 *
 * Produces: examples/visualizations/chunk_view.html
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkAtParagraphs } from '../src/context_drain.js';
import { canonicalizeText, hashText } from '../src/kb/canonical.js';

async function main() {
  const input = process.argv[2] ?? path.join(process.cwd(), 'examples', 'sample_docs', 'sample.txt');
  const outDir = path.join(process.cwd(), 'examples', 'visualizations');
  await fs.mkdir(outDir, { recursive: true });

  const raw = await fs.readFile(input, 'utf-8');
  const canonical = canonicalizeText(raw);
  const fullHash = hashText(raw);
  const chunkChars = 1200;
  const chunks = chunkAtParagraphs(canonical, chunkChars);

  const chunkData = chunks.map((c, i) => ({
    index: i + 1,
    text: c,
    chars: canonicalizeText(c).length,
    hash: hashText(c),
  }));

  const html = buildHtml({ inputPath: input, fullHash, chunkData });
  const outPath = path.join(outDir, 'chunk_view.html');
  await fs.writeFile(outPath, html, 'utf-8');
  console.log('Wrote visualization to', outPath);
}

function escapeHtml(s: string) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function buildHtml({ inputPath, fullHash, chunkData }: { inputPath: string; fullHash: string; chunkData: { index: number; text: string; chars: number; hash: string }[] }) {
  const rows = chunkData.map(c => `
      <div class="chunk" id="chunk-${c.index}">
        <div class="header">Chunk ${c.index} — ${c.chars} chars — <span class="hash">${c.hash}</span></div>
        <pre class="body">${escapeHtml(c.text)}</pre>
      </div>`).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Chunking visualization</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; padding: 20px; }
    .meta { margin-bottom: 12px; }
    .controls { margin-bottom: 12px; }
    .chunk { border: 1px solid #ddd; padding: 8px; margin-bottom: 8px; border-radius: 6px; }
    .header { font-weight: 600; margin-bottom: 6px; }
    .hash { font-family: monospace; color: #006; }
    .body { white-space: pre-wrap; margin: 0; }
    .highlight { background: linear-gradient(90deg, rgba(255,235,59,0.2), rgba(255,193,7,0.1)); }
  </style>
</head>
<body>
  <h2>Chunking visualization</h2>
  <div class="meta">Input: <strong>${escapeHtml(inputPath)}</strong> — full text hash: <code>${fullHash}</code></div>
  <div class="controls">
    <button id="play">Animate</button>
    <button id="reset">Reset</button>
  </div>
  <div id="chunks">
    ${rows}
  </div>

  <script>
    const total = ${chunkData.length};
    let i = 0;
    const intervalMs = 800;
    const playBtn = document.getElementById('play');
    const resetBtn = document.getElementById('reset');
    let timer = null;

    function highlight(idx) {
      for (let j = 1; j <= total; j++) {
        const el = document.getElementById('chunk-' + j);
        if (!el) continue;
        el.classList.toggle('highlight', j === idx);
      }
    }

    function step() {
      i = (i % total) + 1;
      highlight(i);
    }

    playBtn.addEventListener('click', () => {
      if (timer) { clearInterval(timer); timer = null; playBtn.textContent = 'Animate'; return; }
      timer = setInterval(step, intervalMs);
      playBtn.textContent = 'Pause';
    });

    resetBtn.addEventListener('click', () => { if (timer) { clearInterval(timer); timer = null; playBtn.textContent = 'Animate'; } i = 0; highlight(-1); });
  </script>
</body>
</html>`;
}

main().catch(err => { console.error(err); process.exit(1); });
