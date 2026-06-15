// EZ Coder landing page — gallery, lightbox, OS detection, and live wiring of
// the download buttons to the latest GitHub release. No dependencies.

const REPO = "Gahroot/ezcoder";
const RELEASES_URL = `https://github.com/${REPO}/releases`;

// Every captured screen, in showcase order. One source of truth for the gallery
// grid and the lightbox.
const SHOTS = [
  {
    file: "chat.png",
    title: "The chat",
    caption: "Markdown, syntax-highlighted code, and the agent's reasoning inline.",
    wide: true,
  },
  {
    file: "chat-live.png",
    title: "Live tools",
    caption: "Watch every read, search and edit stream in as it works.",
  },
  {
    file: "plan.png",
    title: "Plan mode",
    caption: "Approve, tweak or reject the plan before a line changes.",
  },
  {
    file: "home.png",
    title: "Home",
    caption: "Your projects, providers and remote control — one tap away.",
  },
  {
    file: "login.png",
    title: "AI providers",
    caption: "Sign in with Claude or ChatGPT, or bring an API key.",
  },
  {
    file: "provider.png",
    title: "Connect a provider",
    caption: "OAuth or API key — the modal adapts to each provider.",
  },
  {
    file: "projects.png",
    title: "Project picker",
    caption: "EZ Coder, Claude Code and Codex projects, all discovered.",
  },
  {
    file: "sessions.png",
    title: "Sessions",
    caption: "Pick up any past conversation right where you left it.",
  },
  {
    file: "model.png",
    title: "Pick your model",
    caption: "Every provider in one place — Claude Opus 4.8, GPT-5.5, Gemini, GLM, Kimi and more.",
  },
  {
    file: "tasks.png",
    title: "Tasks",
    caption: "Queue work and run it end-to-end, one fresh session each.",
  },
  {
    file: "new-project.png",
    title: "New project",
    caption: "Spin up a fresh project folder without leaving the app.",
  },
  {
    file: "settings.png",
    title: "Settings",
    caption: "Point it at your projects folder and you're set.",
  },
];

// ── Gallery ────────────────────────────────────────────────
function buildGallery() {
  const grid = document.querySelector("[data-gallery]");
  if (!grid) return;
  SHOTS.forEach((shot, i) => {
    const fig = document.createElement("figure");
    fig.className = "shot" + (shot.wide ? " wide" : "");
    fig.dataset.index = String(i);
    fig.innerHTML = `
      <img src="assets/screens/${shot.file}" alt="${shot.title} — ${shot.caption}" loading="lazy" width="1024" height="720" />
      <figcaption><strong>${shot.title}</strong>${shot.caption}</figcaption>`;
    fig.addEventListener("click", () => openLightbox(i));
    grid.appendChild(fig);
  });
}

// ── Lightbox ───────────────────────────────────────────────
let lbIndex = 0;
const lb = document.querySelector("[data-lightbox]");
const lbImg = document.querySelector("[data-lightbox-img]");
const lbCap = document.querySelector("[data-lightbox-cap]");

function showLightbox(i) {
  lbIndex = (i + SHOTS.length) % SHOTS.length;
  const shot = SHOTS[lbIndex];
  lbImg.src = `assets/screens/${shot.file}`;
  lbImg.alt = `${shot.title} — ${shot.caption}`;
  lbCap.textContent = `${shot.title} — ${shot.caption}`;
}
function openLightbox(i) {
  if (!lb) return;
  showLightbox(i);
  lb.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeLightbox() {
  if (!lb) return;
  lb.hidden = true;
  document.body.style.overflow = "";
}

function wireLightbox() {
  if (!lb) return;
  document.querySelector("[data-lightbox-close]").addEventListener("click", closeLightbox);
  document
    .querySelector("[data-lightbox-prev]")
    .addEventListener("click", () => showLightbox(lbIndex - 1));
  document
    .querySelector("[data-lightbox-next]")
    .addEventListener("click", () => showLightbox(lbIndex + 1));
  lb.addEventListener("click", (e) => {
    if (e.target === lb) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") showLightbox(lbIndex - 1);
    else if (e.key === "ArrowRight") showLightbox(lbIndex + 1);
  });
}

// ── OS detection ───────────────────────────────────────────
function detectOS() {
  const ua = (
    navigator.userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ""
  ).toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac") || ua.includes("iphone") || ua.includes("ipad")) return "mac";
  if (ua.includes("linux") || ua.includes("android")) return "linux";
  return "unknown";
}

const OS_LABEL = { mac: "macOS", windows: "Windows", linux: "Linux" };

function applyOS() {
  const os = detectOS();
  const primary = document.querySelector("[data-primary-download]");
  if (primary && OS_LABEL[os]) primary.textContent = `Download for ${OS_LABEL[os]}`;

  // Highlight the visitor's platform card and float it first.
  const card = document.querySelector(`.dl-card[data-os="${os}"]`);
  if (card) {
    card.classList.add("is-primary");
    card.parentElement?.prepend(card);
  }
  const note = document.querySelector("[data-os-note]");
  if (note && os === "linux") {
    note.textContent = "Linux isn't pre-built yet — build from source (it's quick).";
  }
}

// ── Live release wiring ────────────────────────────────────
function pickAsset(assets, exts) {
  for (const ext of exts) {
    const hit = assets.find((a) => a.name.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return null;
}

async function wireDownloads() {
  const status = document.querySelector("[data-download-status]");
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const rel = await res.json();
    const assets = Array.isArray(rel.assets) ? rel.assets : [];

    const mac = pickAsset(assets, [".dmg"]);
    const win = pickAsset(assets, ["-setup.exe", ".exe", ".msi"]);

    const tag = rel.tag_name || rel.name || "";
    setVersionPill(tag);

    wireCard("mac", mac, tag, "Download .dmg");
    wireCard(
      "windows",
      win,
      tag,
      win && win.name.endsWith(".msi") ? "Download .msi" : "Download .exe",
    );

    if (status) {
      status.textContent = tag
        ? `Latest release: ${tag}. The app keeps itself up to date after install.`
        : "Pick your platform — the app keeps itself up to date after that.";
    }
  } catch {
    // No published release yet (or offline): point both buttons at the releases
    // page so the page stays useful until the first `v*` tag is pushed.
    for (const os of ["mac", "windows"]) {
      const btn = document.querySelector(`[data-dl="${os}"]`);
      const sub = document.querySelector(`[data-dl-sub="${os}"]`);
      if (btn) {
        btn.href = RELEASES_URL;
        btn.textContent = "Get it on GitHub";
      }
      if (sub) sub.textContent = "coming to the releases page";
    }
    if (status) {
      status.innerHTML = `First builds land on the <a href="${RELEASES_URL}" target="_blank" rel="noopener">releases page</a> — push a <code>v*</code> tag to publish them.`;
    }
  }
}

function wireCard(os, asset, tag, fallbackLabel) {
  const btn = document.querySelector(`[data-dl="${os}"]`);
  const sub = document.querySelector(`[data-dl-sub="${os}"]`);
  if (!btn) return;
  if (asset) {
    btn.href = asset.browser_download_url;
    btn.textContent = fallbackLabel;
    if (sub) sub.textContent = tag ? `${tag} · ${formatSize(asset.size)}` : formatSize(asset.size);
  } else {
    // This platform has no asset on the latest release — send to releases page.
    btn.href = RELEASES_URL;
    btn.textContent = "View releases";
    if (sub) sub.textContent = "no build on latest yet";
  }
}

function setVersionPill(tag) {
  const pill = document.querySelector("[data-version-pill]");
  if (pill && tag) pill.textContent = `${tag} · macOS & Windows`;
}

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

// ── Boot ───────────────────────────────────────────────────
buildGallery();
wireLightbox();
applyOS();
wireDownloads();
