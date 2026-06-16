// Renders the EZ Coder ASCII wordmark to a transparent PNG so the hero can use
// a crisp image instead of a <pre> that depends on a monospace font + clip-path.
// Run: node website/scripts/gen-ascii-logo.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, "../assets/ascii-logo.png");

const ascii = [
  "███████╗███████╗     ██████╗ ██████╗ ██████╗ ███████╗██████╗",
  "██╔════╝╚══███╔╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗",
  "█████╗    ███╔╝     ██║     ██║   ██║██║  ██║█████╗  ██████╔╝",
  "██╔══╝   ███╔╝      ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗",
  "███████╗███████╗    ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║",
  "╚══════╝╚══════╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
].join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  pre{
    display:inline-block;
    margin:0;
    padding:14px 4px;
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    font-size:32px;
    line-height:1.05;
    font-weight:700;
    white-space:pre;
    background:linear-gradient(100deg,#4d9dff 0%,#6f8ff7 25%,#9b8cf7 50%,#6f8ff7 75%,#4d9dff 100%);
    -webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;
  }
</style></head><body><pre id="logo">${ascii}</pre></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "networkidle" });
const el = await page.$("#logo");
await el.screenshot({ path: out, omitBackground: true });
await browser.close();
console.log("wrote", out);
