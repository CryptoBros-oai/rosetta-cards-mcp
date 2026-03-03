import { chromium } from "playwright";
import QRCode from "qrcode";
import { CardPayload, type WeeklySummary } from "./schema.js";

export async function renderCardPng(args: {
  payload: CardPayload;
  png_path: string;
  style: "default" | "dark" | "light";
  include_qr: boolean;
}) {
  const { payload, png_path, style, include_qr } = args;

  const qrData = JSON.stringify({
    version: payload.version,
    card_id: payload.card_id,
    hash: payload.hash,
    sources: payload.sources
  });

  const qrDataUrl = include_qr ? await QRCode.toDataURL(qrData, { margin: 1, scale: 6 }) : "";

  const theme =
    style === "dark"
      ? { bg: "#0b0f14", fg: "#e6edf3", muted: "#9aa4b2", border: "#223043" }
      : style === "light"
      ? { bg: "#ffffff", fg: "#111827", muted: "#6b7280", border: "#e5e7eb" }
      : { bg: "#0f172a", fg: "#e2e8f0", muted: "#94a3b8", border: "#334155" };

  const bulletsHtml = payload.bullets
    .slice(0, 7)
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join("");

  const tagsHtml = payload.tags
    .slice(0, 8)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join("");

  const html = `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { margin: 0; background: ${theme.bg}; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto; }
        .card { width: 1200px; height: 675px; padding: 42px; box-sizing: border-box; border: 2px solid ${theme.border}; border-radius: 28px; }
        .title { color: ${theme.fg}; font-size: 44px; font-weight: 800; letter-spacing: -0.02em; }
        .meta { margin-top: 10px; color: ${theme.muted}; font-size: 16px; display:flex; gap: 16px; flex-wrap: wrap; }
        .grid { margin-top: 28px; display: grid; grid-template-columns: 2fr 1fr; gap: 28px; height: 520px; }
        .panel { border: 1px solid ${theme.border}; border-radius: 18px; padding: 22px; box-sizing: border-box; }
        ul { margin: 0; padding-left: 22px; color: ${theme.fg}; font-size: 22px; line-height: 1.35; }
        .tags { display:flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
        .tag { border: 1px solid ${theme.border}; color: ${theme.muted}; padding: 6px 10px; border-radius: 999px; font-size: 14px; }
        .qrwrap { display:flex; justify-content: flex-end; align-items: flex-end; height: 100%; }
        .qr { width: 220px; height: 220px; border-radius: 16px; border: 1px solid ${theme.border}; background: white; padding: 10px; box-sizing: border-box; }
        .small { color: ${theme.muted}; font-size: 14px; margin-top: 10px; line-height: 1.35; }
        code { color: ${theme.fg}; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="title">${escapeHtml(payload.title)}</div>
        <div class="meta">
          <div><b>card_id</b>: <code>${payload.card_id}</code></div>
          <div><b>hash</b>: <code>${payload.hash.slice(0, 12)}…</code></div>
          <div><b>created</b>: ${escapeHtml(payload.created_at)}</div>
        </div>

        <div class="grid">
          <div class="panel">
            <ul>${bulletsHtml}</ul>
            <div class="tags">${tagsHtml}</div>
          </div>

          <div class="panel">
            <div class="qrwrap">
              ${include_qr ? `<img class="qr" src="${qrDataUrl}" />` : ""}
            </div>
            <div class="small">
              QR payload: version + card_id + hash + source pointers<br/>
              Full JSON lives in <code>data/cards/${payload.card_id}.json</code>
            </div>
          </div>
        </div>
      </div>
    </body>
  </html>
  `;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: png_path });
  await browser.close();
}

export async function renderSummaryPng(args: {
  payload: WeeklySummary;
  png_path: string;
}) {
  const { payload, png_path } = args;

  const theme = {
    bg: "#0f172a",
    fg: "#e2e8f0",
    muted: "#94a3b8",
    accent: "#38bdf8",
    border: "#334155",
    green: "#4ade80",
    yellow: "#fbbf24",
    red: "#f87171",
  };

  function listItems(items: string[], color: string): string {
    if (items.length === 0) return `<li style="color:${theme.muted}">—</li>`;
    return items
      .map((s) => `<li style="color:${color}">${escapeHtml(s)}</li>`)
      .join("");
  }

  function hashPills(hashes: string[], label: string): string {
    if (hashes.length === 0) return "";
    const pills = hashes
      .map(
        (h) =>
          `<span style="font-family:monospace;font-size:11px;background:#1e293b;border:1px solid ${theme.border};border-radius:4px;padding:2px 6px;color:${theme.muted}">${h.slice(0, 12)}…</span>`,
      )
      .join(" ");
    return `<div style="margin-bottom:6px"><span style="color:${theme.muted};font-size:12px">${label}: </span>${pills}</div>`;
  }

  const balance = payload.rosetta_balance;
  const balanceHtml = balance
    ? `<div style="margin-top:8px;font-size:13px;color:${theme.muted}">
        Rosetta balance:
        <span style="color:${theme.fg}">A=${balance.A} C=${balance.C} L=${balance.L} P=${balance.P} T=${balance.T}</span>
      </div>`
    : "";

  const html = `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; background: ${theme.bg}; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto; }
        .card { width: 1200px; height: 675px; padding: 36px; border: 2px solid ${theme.border}; border-radius: 28px; display: grid; grid-template-rows: auto 1fr; gap: 16px; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; }
        .week { font-size: 30px; font-weight: 800; color: ${theme.fg}; letter-spacing: -0.02em; }
        .meta { font-size: 13px; color: ${theme.muted}; margin-top: 4px; }
        .body { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px; overflow: hidden; }
        .col { border: 1px solid ${theme.border}; border-radius: 14px; padding: 16px; overflow: hidden; }
        .col-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
        ul { margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.4; }
        .refs { font-size: 12px; }
        .badge { display:inline-block; background:#1e293b; border:1px solid ${theme.border}; border-radius:999px; padding:3px 10px; font-size:12px; color:${theme.accent}; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <div>
            <div class="week">Weekly Summary — ${escapeHtml(payload.week_start)} → ${escapeHtml(payload.week_end)}</div>
            <div class="meta">
              <span class="badge">summary.week.v1</span>
              &nbsp; hash: <code style="color:${theme.muted}">${payload.hash.slice(0, 16)}…</code>
            </div>
            ${balanceHtml}
          </div>
          <div style="text-align:right;font-size:12px;color:${theme.muted}">
            ${hashPills(payload.references.events, "events")}
            ${hashPills(payload.references.cards, "cards")}
          </div>
        </div>

        <div class="body">
          <div class="col">
            <div class="col-title" style="color:${theme.green}">Highlights</div>
            <ul>${listItems(payload.highlights, theme.fg)}</ul>
            <div class="col-title" style="color:${theme.accent};margin-top:14px">Decisions</div>
            <ul>${listItems(payload.decisions, theme.fg)}</ul>
          </div>

          <div class="col">
            <div class="col-title" style="color:${theme.yellow}">Open Loops</div>
            <ul>${listItems(payload.open_loops, theme.fg)}</ul>
          </div>

          <div class="col">
            <div class="col-title" style="color:${theme.red}">Risks</div>
            <ul>${listItems(payload.risks, theme.fg)}</ul>
          </div>
        </div>
      </div>
    </body>
  </html>
  `;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: png_path });
  await browser.close();
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
