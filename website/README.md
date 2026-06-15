# EZ Coder landing page

The public marketing site for the EZ Coder desktop app. Plain HTML/CSS/JS — no
build step, no dependencies.

```
website/
├── index.html          # the page
├── styles.css          # theme tokens mirror ezcoder-app/src/theme.ts
├── main.js             # gallery + lightbox, OS detection, live release wiring
└── assets/
    ├── icon.png        # app icon (favicon / nav / OG)
    ├── favicon.ico
    └── screens/        # one PNG per app screen (see below)
```

## How the downloads stay current

`main.js` fetches `https://api.github.com/repos/Gahroot/ezcoder/releases/latest`
at runtime and points each platform button at the right asset (`.dmg` for macOS,
`-setup.exe`/`.msi` for Windows). If no release is published yet — or the visitor
is offline — the buttons fall back to the
[releases page](https://github.com/Gahroot/ezcoder/releases). **No rebuild is
needed when you ship a new version.**

> Releases come from a `v*` tag (e.g. `git push origin v0.1.10`), which triggers
> `.github/workflows/release.yml`. Once that release exists with installer
> assets, the buttons light up automatically — no site rebuild needed.

## Refreshing the screenshots

The shots in `assets/screens/` are captured from the **real** app components via a
mock-Tauri harness in `ezcoder-app/showcase/` — no Rust, no sidecar, no auth.

```bash
cd ezcoder-app
pnpm showcase                         # serves the harness on http://localhost:1430
# then open /showcase.html?screen=<name> and capture 1024×720
```

Screens: `home`, `login`, `provider`, `projects`, `sessions`, `new-project`,
`settings`, `tasks`, `plan`, `chat`, `chat-live`, `model`. The `chat*` screens
render the real `App` and are reached by clicking a project → "+ New session".

## Deploy

Hosted on **Vercel** as a static site (the project is linked via `website/.vercel`,
which is gitignored). Deploy from this folder:

```bash
cd website
vercel deploy --prod        # ship to production
vercel deploy               # preview URL
```

`vercel.json` sets clean URLs and long-lived caching for `/assets/*`. There's no
build step. Production: <https://website-three-eosin-0v0xmdepg0.vercel.app>
(rename the project or add a custom domain from the Vercel dashboard; update the
`og:*`/`twitter:image` URLs in `index.html` if the domain changes).
