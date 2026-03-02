import { chromium } from "playwright";
import QRCode from "qrcode";
import { CardPayload } from "./schema.js";

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

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
