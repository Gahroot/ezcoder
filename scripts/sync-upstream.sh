#!/usr/bin/env bash
#
# sync-upstream.sh — Pull updates from Gahroot/ezcoder and rebrand
#
# Usage:
#   ./scripts/sync-upstream.sh           # merge upstream/main, rename dirs, fix branding
#   ./scripts/sync-upstream.sh --dry-run # show what would change without doing it
#
# What it does (across 15 packages):
#   1. Fetches upstream (Gahroot/ezcoder)
#   2. Merges upstream/main into current branch
#   3. Renames directories (gg-ai→ai, gg-agent→agent, ezcoder→cli, gg-boss→boss,
#      gg-editor→editor, ez-editor-premiere-panel→editor-premiere-panel,
#      ez-pixel→pixel, ez-pixel-server→pixel-server, ezcoder-eyes→eyes,
#      gg-voice→voice, ez-pixel-{go,py,rb,rs,swift}→pixel-{go,py,rb,rs,swift})
#   4. Fixes npm scope: @kenkaiiii→@prestyj for internal packages only
#   5. Fixes branding: GG→EZ, ezboss/ezeditor/ezcoder→ez*, ~/.ezcoder/→~/.ezcoder/
#   6. Renames CLI bin entries, bridge paths, screenshots, and bare CLI invocations
#   7. Rewrites env vars (GG_*→EZCODER_*/EZBOSS_*) and error classes (EZCoderAIError→EZCoderAIError)
#   8. Commits the rename + branding fixup
#
# Third-party deps that STAY external (NOT touched by sed):
#   - @kenkaiiii/agent-home-sdk
#   - @kenkaiiii/kencode-search
#
# If the merge has conflicts, it stops and asks you to resolve them first.
# After resolving, re-run the script to continue with renames + branding.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[sync]${NC} $*"; }
ok()    { echo -e "${GREEN}[sync]${NC} $*"; }
warn()  { echo -e "${YELLOW}[sync]${NC} $*"; }
err()   { echo -e "${RED}[sync]${NC} $*"; }

# ── Platform-specific sed flags ────────────────────────────
# macOS (BSD) sed needs `-i ''`; GNU sed uses `-i`.
# BSD sed also lacks `\b`; we use POSIX `[[:<:]]`/`[[:>:]]` everywhere
# (GNU sed accepts these too).
if [[ "$(uname)" == "Darwin" ]]; then
  SED_INPLACE=(-i '')
else
  SED_INPLACE=(-i)
fi

# ── Step 0: Check prerequisites ────────────────────────────

if ! git remote get-url upstream &>/dev/null; then
  info "Adding upstream remote..."
  git remote add upstream https://github.com/Gahroot/ezcoder.git
fi

# ── Step 1: Fetch upstream ─────────────────────────────────

info "Fetching upstream..."
git fetch upstream

LOCAL=$(git rev-parse HEAD)
UPSTREAM=$(git rev-parse upstream/main)
BASE=$(git merge-base HEAD upstream/main)

if [[ "$UPSTREAM" == "$BASE" ]]; then
  ok "Already up to date with upstream."
  # Even if no merge needed, still run rename + sed pass in case prior sync
  # left things half-rebranded.
fi

COMMIT_COUNT=$(git rev-list --count "$BASE".."$UPSTREAM" || echo 0)
info "Upstream has $COMMIT_COUNT new commit(s)"

if $DRY_RUN; then
  info "[dry-run] Would merge $COMMIT_COUNT commits from upstream/main"
  info "[dry-run] Would rename 15 packages:"
  info "[dry-run]   gg-ai→ai, gg-agent→agent, ezcoder→cli, gg-boss→boss"
  info "[dry-run]   gg-editor→editor, ez-editor-premiere-panel→editor-premiere-panel"
  info "[dry-run]   ez-pixel→pixel, ez-pixel-server→pixel-server, ezcoder-eyes→eyes"
  info "[dry-run]   gg-voice→voice"
  info "[dry-run]   ez-pixel-go→pixel-go, ez-pixel-py→pixel-py, ez-pixel-rb→pixel-rb"
  info "[dry-run]   ez-pixel-rs→pixel-rs, ez-pixel-swift→pixel-swift"
  info "[dry-run] Would fix scope: @kenkaiiii→@prestyj (except agent-home-sdk, kencode-search)"
  info "[dry-run] Would fix branding: GG→EZ, ezcoder/ezboss/ezeditor→ez*, ~/.ezcoder/→~/.ezcoder/"
  info "[dry-run] Would rewrite env vars: GG_*→EZCODER_*/EZBOSS_*"
  if [[ "$COMMIT_COUNT" != "0" ]]; then
    git log --oneline "$BASE".."$UPSTREAM"
  fi
  exit 0
fi

# ── Step 2: Merge upstream ─────────────────────────────────

if [[ "$UPSTREAM" != "$BASE" ]]; then
  # Check for uncommitted changes
  if ! git diff --quiet || ! git diff --cached --quiet; then
    err "You have uncommitted changes. Please commit or stash them first."
    exit 1
  fi

  info "Merging upstream/main..."
  if ! git merge upstream/main --no-edit -m "Merge upstream/main (ezcoder)"; then
    warn ""
    warn "Merge conflicts detected!"
    warn "Resolve them, then run: git merge --continue"
    warn "After that, re-run this script to apply directory renames + branding."
    exit 1
  fi
fi

# ── Step 3: Rename directories ─────────────────────────────
# Order matters: longer prefixes first so we don't half-match
# (e.g. `ezcoder-eyes` before `ezcoder`, `ez-pixel-server` before `ez-pixel`).

info "Renaming directories..."

rename_if_exists() {
  local src="$1" dst="$2"
  if [[ -d "$src" ]]; then
    if [[ -d "$dst" ]]; then
      # Both exist after merge — move contents from src into dst
      warn "Both $src and $dst exist. Merging contents..."
      cp -R "$src"/* "$dst"/ 2>/dev/null || true
      git rm -rf "$src" --quiet
    else
      git mv "$src" "$dst"
    fi
    ok "  $src → $dst"
  fi
}

rename_if_exists "packages/ai" "packages/ai"
rename_if_exists "packages/agent" "packages/agent"
rename_if_exists "packages/eyes" "packages/eyes"            # before ezcoder
rename_if_exists "packages/cli" "packages/cli"
rename_if_exists "packages/boss" "packages/boss"
rename_if_exists "packages/editor-premiere-panel" "packages/editor-premiere-panel"  # before gg-editor
rename_if_exists "packages/editor" "packages/editor"
rename_if_exists "packages/pixel-server" "packages/pixel-server" # before ez-pixel
rename_if_exists "packages/pixel-swift" "packages/pixel-swift"
rename_if_exists "packages/pixel-go" "packages/pixel-go"
rename_if_exists "packages/pixel-py" "packages/pixel-py"
rename_if_exists "packages/pixel-rb" "packages/pixel-rb"
rename_if_exists "packages/pixel-rs" "packages/pixel-rs"
rename_if_exists "packages/pixel" "packages/pixel"
rename_if_exists "packages/voice" "packages/voice"

# ── Step 4: Fix npm scope and branding ─────────────────────

info "Fixing npm scope and branding (sed pass)..."

# Files to process (text only; exclude lockfile / node_modules / dist / .git)
# NOTE: scripts/sync-upstream.sh is excluded — otherwise the script rebrands
# itself mid-run and leaves behind a broken script for the next sync.
FILES=$(git ls-files -- '*.ts' '*.tsx' '*.json' '*.md' '*.js' '*.mjs' '*.yaml' '*.yml' '*.toml' '*.sh' ':!pnpm-lock.yaml' ':!node_modules' ':!dist' ':!scripts/sync-upstream.sh')

# Order rules:
#   - Longer prefixes BEFORE shorter ones (ezcoder-eyes before ezcoder; ez-pixel-server before ez-pixel; ez-editor-premiere-panel before gg-editor)
#   - "@kenkaiiii/<exact-pkg>" is a closed list — external deps like
#     @kenkaiiii/agent-home-sdk and @kenkaiiii/kencode-search are NOT touched.
while IFS= read -r file; do
  [[ -f "$file" ]] || continue

  sed "${SED_INPLACE[@]}" \
    -e 's|@prestyj/ai|@prestyj/ai|g' \
    -e 's|@prestyj/agent|@prestyj/agent|g' \
    -e 's|@prestyj/eyes|@prestyj/eyes|g' \
    -e 's|@prestyj/cli|@prestyj/cli|g' \
    -e 's|@prestyj/boss|@prestyj/boss|g' \
    -e 's|@prestyj/editor-premiere-panel|@prestyj/editor-premiere-panel|g' \
    -e 's|@prestyj/editor|@prestyj/editor|g' \
    -e 's|@prestyj/pixel-server|@prestyj/pixel-server|g' \
    -e 's|@prestyj/pixel|@prestyj/pixel|g' \
    -e 's|@prestyj/voice|@prestyj/voice|g' \
    -e 's|packages/ai|packages/ai|g' \
    -e 's|packages/agent|packages/agent|g' \
    -e 's|packages/eyes|packages/eyes|g' \
    -e 's|packages/cli|packages/cli|g' \
    -e 's|packages/boss|packages/boss|g' \
    -e 's|packages/editor-premiere-panel|packages/editor-premiere-panel|g' \
    -e 's|packages/editor|packages/editor|g' \
    -e 's|packages/pixel-server|packages/pixel-server|g' \
    -e 's|packages/pixel-swift|packages/pixel-swift|g' \
    -e 's|packages/pixel-go|packages/pixel-go|g' \
    -e 's|packages/pixel-py|packages/pixel-py|g' \
    -e 's|packages/pixel-rb|packages/pixel-rb|g' \
    -e 's|packages/pixel-rs|packages/pixel-rs|g' \
    -e 's|packages/pixel|packages/pixel|g' \
    -e 's|packages/voice|packages/voice|g' \
    -e 's|"name": "ezcoder"|"name": "ezcoder"|g' \
    -e 's|"ezcoder"|"ezcoder"|g' \
    -e 's|ezcoder|ezcoder|g' \
    -e 's|~/.ezcoder/|~/.ezcoder/|g' \
    -e 's|"\.gg"|".ezcoder"|g' \
    -e "s|'\.gg'|'.ezcoder'|g" \
    -e 's|\.ezcoder/eyes|.ezcoder/eyes|g' \
    -e 's|\.ezcoder/plans|.ezcoder/plans|g' \
    -e 's|\.ezcoder/skills|.ezcoder/skills|g' \
    -e 's|\.ezcoder/commands|.ezcoder/commands|g' \
    -e 's|\.ezcoder/agents|.ezcoder/agents|g' \
    -e 's|\.ezcoder/sessions|.ezcoder/sessions|g' \
    -e 's|\.ezcoder/boss|.ezcoder/boss|g' \
    -e 's|\.ezcoder/auth|.ezcoder/auth|g' \
    -e 's|\.ezcoder/debug|.ezcoder/debug|g' \
    -e 's|\.ezcoder/settings|.ezcoder/settings|g' \
    -e 's|\.ezcoder/update-state|.ezcoder/update-state|g' \
    -e 's|\.ezcoder-tasks|.ezcoder-tasks|g' \
    -e 's|EZCoderAIError|EZCoderAIError|g' \
    -e 's|EZ Coder by Nolan Grout|EZ Coder by Nolan Grout|g' \
    -e 's|EZCoder Framework|EZCoder Framework|g' \
    -e 's|EZ Coder|EZ Coder|g' \
    -e 's|EZ Boss|EZ Boss|g' \
    -e 's|EZ Editor|EZ Editor|g' \
    -e 's|EZ Pixel|EZ Pixel|g' \
    -e 's|EZPixel|EZPixel|g' \
    -e 's|ez_pixel|ez_pixel|g' \
    -e 's|ez-pixel|ez-pixel|g' \
    -e 's|ezpixel|ezpixel|g' \
    -e 's|EZ Voice|EZ Voice|g' \
    -e 's|Provider-agnostic realtime voice orchestration for EZ tools and agents|Provider-agnostic realtime voice orchestration for EZ tools and agents|g' \
    -e 's|"Nolan Grout"|"Nolan Grout"|g' \
    -e 's|EZCODER_PIXEL_KEY|EZCODER_PIXEL_KEY|g' \
    -e 's|EZBOSS_TELEGRAM_BOT_TOKEN|EZBOSS_TELEGRAM_BOT_TOKEN|g' \
    -e 's|EZBOSS_TELEGRAM_USER_ID|EZBOSS_TELEGRAM_USER_ID|g' \
    -e 's|EZCODER_TELEGRAM_BOT_TOKEN|EZCODER_TELEGRAM_BOT_TOKEN|g' \
    -e 's|EZCODER_TELEGRAM_USER_ID|EZCODER_TELEGRAM_USER_ID|g' \
    -e 's|EZ_CODER|EZ_CODER|g' \
    -e 's|Gahroot/ezcoder|Gahroot/ezcoder|g' \
    -e 's|Gahroot/ezcoder|Gahroot/ezcoder|g' \
    -e 's|ez-pixel-server\.buzzbeamaustralia\.workers\.dev|pixel-server.ngrout70.workers.dev|g' \
    "$file"
done <<< "$FILES"

# ── Step 5: Fix CLI bin entries in package.json files ──────

info "Fixing CLI bin entries..."

fix_bin() {
  local pkg_path="$1" old_bin="$2" new_bin="$3"
  if [[ -f "$pkg_path/package.json" ]]; then
    sed "${SED_INPLACE[@]}" "s|\"$old_bin\":|\"$new_bin\":|g" "$pkg_path/package.json"
  fi
}

fix_bin "packages/cli" "ezcoder" "ezcoder"
fix_bin "packages/boss" "ezboss" "ezboss"
fix_bin "packages/editor" "ezeditor" "ezeditor"
fix_bin "packages/editor-premiere-panel" "ez-editor-premiere-panel" "ez-editor-premiere-panel"
fix_bin "packages/pixel" "ez-pixel" "ez-pixel"
fix_bin "packages/eyes" "ezcoder-eyes" "ezcoder-eyes"

# Package export subpaths and filenames that include upstream command names.
if [[ -f "packages/voice/package.json" ]]; then
  sed "${SED_INPLACE[@]}" \
    -e 's|"\./bridges/ezcoder-rpc"|"./bridges/ezcoder-rpc"|g' \
    -e 's|"\./bridges/ezboss"|"./bridges/ezboss"|g' \
    "packages/voice/package.json"
fi

rename_file_if_exists() {
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    if [[ -f "$dst" ]]; then
      warn "Both $src and $dst exist. Keeping $dst and removing $src."
      git rm -f "$src" --quiet
    else
      git mv "$src" "$dst"
    fi
    ok "  $src → $dst"
  fi
}

rename_file_if_exists "packages/cli/screenshots/ezcoder.png" "packages/cli/screenshots/ezcoder.png"
rename_file_if_exists "packages/boss/screenshots/ezboss.png" "packages/boss/screenshots/ezboss.png"
rename_file_if_exists "packages/voice/src/bridges/ezcoder-rpc.ts" "packages/voice/src/bridges/ezcoder-rpc.ts"
rename_file_if_exists "packages/voice/src/bridges/ezboss.ts" "packages/voice/src/bridges/ezboss.ts"

# Bare CLI command names in docs / help strings (must come AFTER package.json bin renames).
# Use POSIX word boundaries [[:<:]] / [[:>:]] which work on both BSD and GNU sed.
# Order: longer first.
info "Rebranding bare CLI invocations in docs..."
while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  sed "${SED_INPLACE[@]}" \
    -e 's|[[:<:]]ezcoder-eyes[[:>:]]|ezcoder-eyes|g' \
    -e 's|[[:<:]]ezcoder-rpc[[:>:]]|ezcoder-rpc|g' \
    -e 's|[[:<:]]ezcoder[[:>:]]|ezcoder|g' \
    -e 's|[[:<:]]ezboss[[:>:]]|ezboss|g' \
    -e 's|[[:<:]]ezeditor[[:>:]]|ezeditor|g' \
    "$file"
done <<< "$FILES"

ok "Branding fixes applied."

# ── Step 6: Stage and commit ───────────────────────────────

info "Staging changes..."
git add -A

if git diff --cached --quiet; then
  ok "No branding changes needed — already up to date."
else
  git commit -m "$(cat <<'EOF'
Rebrand upstream merge: rename packages and fix scope

- Rename: gg-ai→ai, gg-agent→agent, ezcoder→cli, gg-boss→boss,
  gg-editor→editor, ez-editor-premiere-panel→editor-premiere-panel,
  ez-pixel→pixel, ez-pixel-server→pixel-server, ezcoder-eyes→eyes,
  gg-voice→voice, ez-pixel-{go,py,rb,rs,swift}→pixel-{go,py,rb,rs,swift}
- Scope: @kenkaiiii→@prestyj (kept agent-home-sdk + kencode-search external)
- CLI bins/paths: ezcoder→ezcoder, ezboss→ezboss, ezeditor→ezeditor,
  ez-editor-premiere-panel→ez-editor-premiere-panel, ez-pixel→ez-pixel,
  ezcoder-eyes→ezcoder-eyes, ezcoder-rpc→ezcoder-rpc
- Branding: GG→EZ, "Nolan Grout"→"Nolan Grout", ~/.ezcoder/→~/.ezcoder/
- Env vars: GG_*→EZCODER_*/EZBOSS_*
- Repo: Gahroot/ezcoder→Gahroot/ezcoder

Pixel ingest URL is rewritten to pixel-server.ngrout70.workers.dev
(our own Cloudflare Worker) by the rebrand sed pass. The agent-home
relay URL still points at KenKai's worker — that's an external
service we don't host, so it's intentionally left alone.
EOF
)"
  ok "Rebrand commit created."
fi

# ── Done ───────────────────────────────────────────────────

echo ""
ok "Upstream sync complete!"
echo ""
warn "Manual block-art logo verification needed (sed cannot see ASCII art):"
warn "  - packages/boss/src/branding.ts        (LOGO_LINES — upstream is GG)"
warn "  - packages/cli/src/ui/components/Banner.tsx"
warn "  - packages/cli/src/cli.ts              (splash logo)"
warn "  - packages/cli/src/ui/components/PlanOverlay.tsx"
warn "  - packages/cli/src/ui/components/SkillsOverlay.tsx"
warn "  - packages/cli/src/modes/agent-home-mode.ts (if present)"
echo ""
info "Verification commands (all must come back empty):"
info "  grep -rn 'kenkaiiii\\|@kenkaiiii\\|gg-ai\\|gg-agent\\|gg-voice\\|ezcoder\\|ezboss\\|ezeditor\\|gg-boss\\|gg-editor\\|ez-pixel\\|ez_pixel\\|EZPixel\\|EZCoderAIError\\|\"Nolan Grout\"' \\"
info "    packages/ --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' \\"
info "    | grep -v 'agent-home-sdk' | grep -v 'kencode-search'"
info "  grep -rn '\\.gg/\\|\"\\.gg\"\\|~/\\.gg' packages/ --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md'"
info "  grep -rn 'GG_[A-Z_]*' packages/ --include='*.ts' --include='*.tsx'"
echo ""
info "Then:"
info "  pnpm install && pnpm build && pnpm check && pnpm lint && pnpm format:check && pnpm test"
