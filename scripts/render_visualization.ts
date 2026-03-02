#!/usr/bin/env node
/**
 * Render the chunk visualization HTML to a PNG using Playwright.
 * Usage:
 *   node --loader ts-node/esm scripts/render_visualization.ts [path/to/chunk_view.html]
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

async function main() {
  const htmlPath = process.argv[2] ?? path.join(process.cwd(), 'examples', 'visualizations', 'chunk_view.html');
  const out = process.argv[3] ?? path.join(process.cwd(), 'examples', 'visualizations', 'chunk_view.png');

  const abs = path.resolve(htmlPath);
  await fs.access(abs);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto('file://' + abs);
  // Wait for content
  await page.waitForSelector('#chunks');
  // Give time for fonts/styles
  await page.waitForTimeout(300);
  // Screenshot the whole page
  await page.screenshot({ path: out, fullPage: true });
  console.log('Wrote PNG to', out);
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
