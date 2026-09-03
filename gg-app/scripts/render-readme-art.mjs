/**
 * README artwork renderer.
 *
 * Draws the README's illustrative panels as HTML in headless Chromium and
 * screenshots them, so the art is regenerable, diffable, and always uses the
 * REAL app palette (`gg-app/src/theme.ts`) rather than hand-picked hex codes
 * that drift the moment the app is restyled.
 *
 * Nothing here reads `~/.gg`: every project name, model and number on these
 * panels is either fictional demo data or a fact taken from the repo itself.
 * Product screenshots live in `capture-screenshots.mjs`, next to this file.
 *
 * Usage: node gg-app/scripts/render-readme-art.mjs [panel...]   (default: all)
 * Output: docs/art/*.png
 */
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../docs/art");

// ── Palette ──────────────────────────────────────────────────────────────────
// Read from the app's token file so the README can never show a color the app
// stopped using. Missing key = loud failure, not a silent wrong-color render.
const themeSrc = await readFile(resolve(here, "../src/theme.ts"), "utf-8");
const token = (key) => {
  const found = new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(themeSrc)?.[1];
  if (!found) throw new Error(`theme.ts has no \`${key}\` — update render-readme-art.mjs`);
  return found;
};
const C = {
  bg: token("background"),
  surface: token("surface1"),
  surface2: token("surface2"),
  border: token("border"),
  text: token("text"),
  muted: token("textMuted"),
  dim: token("textDim"),
  accent: token("primary"),
  ken: token("ken"),
};

const FONT = `-apple-system, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`;

const shell = (body, extraCss = "") => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 1280px; background: ${C.bg}; color: ${C.text}; font-family: ${FONT};
         -webkit-font-smoothing: antialiased; }
  .pad { padding: 44px 50px; }
  .eyebrow { font-family: ${MONO}; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: ${C.accent}; }
  .muted { color: ${C.muted}; }
  .dim { color: ${C.dim}; }
  .mono { font-family: ${MONO}; }
  .card { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 14px; }
  .rule { height: 1px; background: ${C.border}; }
  ${extraCss}
</style></head><body>${body}</body></html>`;

// ── Panels ───────────────────────────────────────────────────────────────────
const panels = {
  /** Title card. */
  hero: {
    height: 440,
    html: shell(`
      <div class="pad" style="height:440px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px">
        <div class="eyebrow">⌘ One window per project</div>
        <div style="font-size:104px;font-weight:800;letter-spacing:-.035em;line-height:1">GG CODER</div>
        <div style="font-size:26px;color:${C.muted}">Every window is its own agent.</div>
        <div class="rule" style="width:620px;margin-top:10px"></div>
        <div class="mono" style="font-size:15px;color:${C.muted};display:flex;gap:26px">
          <span><b style="color:${C.accent}">$0</b> forever</span><span class="dim">|</span>
          <span><b style="color:${C.accent}">∞</b> projects at once</span><span class="dim">|</span>
          <span><b style="color:${C.accent}">0</b> setup</span>
        </div>
      </div>`),
  },

  /** The core idea: N projects, N agents, N models, side by side. */
  windows: {
    height: 440,
    html: shell(
      `<div class="pad">
        <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:6px">
          <div style="font-size:30px;font-weight:700;letter-spacing:-.02em">Six projects. Six agents. Six models.</div>
        </div>
        <div class="muted" style="font-size:17px;margin-bottom:26px">Separate windows, separate folders, separate histories. Nothing bleeds between them.</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
          ${[
            ["aurora-store", "Claude Fable 5.1", "running tests", C.accent],
            ["pixel-pipeline", "GPT-5.3 Codex", "editing 3 files", C.accent],
            ["rusty-parser", "qwen3-coder · local", "idle", C.dim],
            ["landing-page", "Gemini 3.1 Pro", "planning", C.accent],
            ["api-gateway", "Kimi K3", "running tests", C.accent],
            ["docs-site", "GLM-5.3", "idle", C.dim],
          ]
            .map(
              ([project, model, status, dot]) => `
            <div class="card" style="padding:14px 16px">
              <div style="display:flex;gap:6px;margin-bottom:14px">
                ${["#ff6b60", "#f0cf63", "#7fe89a"].map((c) => `<span style="width:9px;height:9px;border-radius:50%;background:${c};display:inline-block;opacity:.75"></span>`).join("")}
              </div>
              <div style="font-size:17px;font-weight:600;margin-bottom:4px">${project}</div>
              <div class="mono" style="font-size:12px;color:${C.muted}">${model}</div>
              <div class="rule" style="margin:13px 0"></div>
              <div class="mono" style="font-size:12px;color:${dot === C.dim ? C.dim : C.muted};display:flex;align-items:center;gap:7px">
                <span style="width:7px;height:7px;border-radius:50%;background:${dot};display:inline-block"></span>${status}
              </div>
            </div>`,
            )
            .join("")}
        </div>
      </div>`,
    ),
  },

  /** Autopilot: what the Ken review loop actually does. */
  autopilot: {
    height: 360,
    html: shell(
      `<div class="pad">
        <div style="font-size:30px;font-weight:700;letter-spacing:-.02em;margin-bottom:6px">Autopilot reviews the work for you</div>
        <div class="muted" style="font-size:17px;margin-bottom:28px">Ken, a mentor agent, checks every finished run and sends it back until it is right.</div>
        <div style="display:flex;align-items:stretch;gap:14px">
          ${[
            ["1", "GG Coder ships", "builds the rate limiter", C.accent, false],
            ["2", "Ken reviews", "“the bucket is per-process”", C.ken, true],
            ["3", "GG Coder fixes", "moves it to Redis, adds a test", C.accent, false],
            ["4", "Ken signs off", "you were making coffee", C.ken, true],
          ]
            .map(
              ([n, title, sub, color, isKen], i, all) => `
            <div class="card" style="flex:1;padding:18px 18px 20px;border-color:${isKen ? "rgba(98,232,216,.28)" : C.border}">
              <div class="mono" style="font-size:12px;color:${color};letter-spacing:.14em">STEP ${n}</div>
              <div style="font-size:19px;font-weight:650;margin:10px 0 6px;color:${isKen ? color : C.text}">${title}</div>
              <div class="muted" style="font-size:14px;line-height:1.45">${sub}</div>
            </div>
            ${i < all.length - 1 ? `<div style="display:flex;align-items:center;color:${C.dim};font-size:20px">→</div>` : ""}`,
            )
            .join("")}
        </div>
        <div class="mono dim" style="font-size:13px;margin-top:24px;text-align:center">nobody typed anything in between</div>
      </div>`,
    ),
  },
};

// ── Render ───────────────────────────────────────────────────────────────────
const wanted = process.argv.slice(2);
const unknown = wanted.filter((n) => !panels[n]);
if (unknown.length) throw new Error(`unknown panel(s): ${unknown.join(", ")}`);
const names = wanted.length ? wanted : Object.keys(panels);

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const name of names) {
    const { html, height } = panels[name];
    const page = await browser.newPage({
      viewport: { width: 1280, height },
      deviceScaleFactor: 2,
    });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready);
    const path = resolve(outDir, `${name}.png`);
    await page.screenshot({ path });
    await page.close();
    console.log(`✓ ${path}`);
  }
} finally {
  await browser.close();
}
