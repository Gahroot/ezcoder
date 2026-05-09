#!/usr/bin/env bash
#
# sync-upstream.sh — Pull updates from KenKaiii/gg-framework and rebrand
#
# Usage:
#   ./scripts/sync-upstream.sh           # merge upstream/main, rename dirs, fix branding
#   ./scripts/sync-upstream.sh --dry-run # show what would change without doing it
#
# What it does (across 9 packages):
#   1. Fetches upstream (KenKaiii/gg-framework)
#   2. Merges upstream/main into current branch
#   3. Renames directories (gg-ai→ai, gg-agent→agent, ggcoder→cli, gg-boss→boss,
#      gg-editor→editor, gg-editor-premiere-panel→editor-premiere-panel,
#      gg-pixel→pixel, gg-pixel-server→pixel-server, ggcoder-eyes→eyes)
#   4. Fixes npm scope: @kenkaiiii→@prestyj
#   5. Fixes branding: GG→EZ, ggboss/ggeditor/ggcoder→ez*, ~/.gg/→~/.ezcoder/
#   6. Renames CLI bin entries and bare CLI invocations in docs
#   7. Rewrites env vars (GG_*→EZCODER_*/EZBOSS_*) and error classes (GGAIError→EZCoderAIError)
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
  git remote add upstream https://github.com/KenKaiii/gg-framework.git
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
  info "[dry-run] Would rename 9 packages:"
  info "[dry-run]   gg-ai→ai, gg-agent→agent, ggcoder→cli, gg-boss→boss"
  info "[dry-run]   gg-editor→editor, gg-editor-premiere-panel→editor-premiere-panel"
  info "[dry-run]   gg-pixel→pixel, gg-pixel-server→pixel-server, ggcoder-eyes→eyes"
  info "[dry-run] Would fix scope: @kenkaiiii→@prestyj (except agent-home-sdk, kencode-search)"
  info "[dry-run] Would fix branding: GG→EZ, ggcoder/ggboss/ggeditor→ez*, ~/.gg/→~/.ezcoder/"
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
  if ! git merge upstream/main --no-edit -m "Merge upstream/main (gg-framework)"; then
    warn ""
    warn "Merge conflicts detected!"
    warn "Resolve them, then run: git merge --continue"
    warn "After that, re-run this script to apply directory renames + branding."
    exit 1
  fi
fi

# ── Step 3: Rename directories ─────────────────────────────
# Order matters: longer prefixes first so we don't half-match
# (e.g. `ggcoder-eyes` before `ggcoder`, `gg-pixel-server` before `gg-pixel`).

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

rename_if_exists "packages/gg-ai" "packages/ai"
rename_if_exists "packages/gg-agent" "packages/agent"
rename_if_exists "packages/ggcoder-eyes" "packages/eyes"            # before ggcoder
rename_if_exists "packages/ggcoder" "packages/cli"
rename_if_exists "packages/gg-boss" "packages/boss"
rename_if_exists "packages/gg-editor-premiere-panel" "packages/editor-premiere-panel"  # before gg-editor
rename_if_exists "packages/gg-editor" "packages/editor"
rename_if_exists "packages/gg-pixel-server" "packages/pixel-server" # before gg-pixel
rename_if_exists "packages/gg-pixel" "packages/pixel"

# ── Step 4: Fix npm scope and branding ─────────────────────

info "Fixing npm scope and branding (sed pass)..."

# Files to process (text only; exclude lockfile / node_modules / dist / .git)
FILES=$(git ls-files -- '*.ts' '*.tsx' '*.json' '*.md' '*.js' '*.mjs' '*.yaml' '*.yml' '*.toml' '*.sh' ':!pnpm-lock.yaml' ':!node_modules' ':!dist')

# Order rules:
#   - Longer prefixes BEFORE shorter ones (ggcoder-eyes before ggcoder; gg-pixel-server before gg-pixel; gg-editor-premiere-panel before gg-editor)
#   - "@kenkaiiii/<exact-pkg>" is a closed list — external deps like
#     @kenkaiiii/agent-home-sdk and @kenkaiiii/kencode-search are NOT touched.
while IFS= read -r file; do
  [[ -f "$file" ]] || continue

  sed "${SED_INPLACE[@]}" \
    -e 's|@kenkaiiii/gg-ai|@prestyj/ai|g' \
    -e 's|@kenkaiiii/gg-agent|@prestyj/agent|g' \
    -e 's|@kenkaiiii/ggcoder-eyes|@prestyj/eyes|g' \
    -e 's|@kenkaiiii/ggcoder|@prestyj/cli|g' \
    -e 's|@kenkaiiii/gg-boss|@prestyj/boss|g' \
    -e 's|@kenkaiiii/gg-editor-premiere-panel|@prestyj/editor-premiere-panel|g' \
    -e 's|@kenkaiiii/gg-editor|@prestyj/editor|g' \
    -e 's|@kenkaiiii/gg-pixel-server|@prestyj/pixel-server|g' \
    -e 's|@kenkaiiii/gg-pixel|@prestyj/pixel|g' \
    -e 's|packages/gg-ai|packages/ai|g' \
    -e 's|packages/gg-agent|packages/agent|g' \
    -e 's|packages/ggcoder-eyes|packages/eyes|g' \
    -e 's|packages/ggcoder|packages/cli|g' \
    -e 's|packages/gg-boss|packages/boss|g' \
    -e 's|packages/gg-editor-premiere-panel|packages/editor-premiere-panel|g' \
    -e 's|packages/gg-editor|packages/editor|g' \
    -e 's|packages/gg-pixel-server|packages/pixel-server|g' \
    -e 's|packages/gg-pixel|packages/pixel|g' \
    -e 's|"name": "gg-framework"|"name": "ezcoder"|g' \
    -e 's|"gg-framework"|"ezcoder"|g' \
    -e 's|gg-framework|ezcoder|g' \
    -e 's|~/\.gg/|~/.ezcoder/|g' \
    -e 's|"\.gg"|".ezcoder"|g' \
    -e "s|'\.gg'|'.ezcoder'|g" \
    -e 's|\.gg/eyes|.ezcoder/eyes|g' \
    -e 's|\.gg/plans|.ezcoder/plans|g' \
    -e 's|\.gg/skills|.ezcoder/skills|g' \
    -e 's|\.gg/commands|.ezcoder/commands|g' \
    -e 's|\.gg/agents|.ezcoder/agents|g' \
    -e 's|\.gg/sessions|.ezcoder/sessions|g' \
    -e 's|\.gg/boss|.ezcoder/boss|g' \
    -e 's|\.gg/auth|.ezcoder/auth|g' \
    -e 's|\.gg/debug|.ezcoder/debug|g' \
    -e 's|\.gg/settings|.ezcoder/settings|g' \
    -e 's|\.gg/update-state|.ezcoder/update-state|g' \
    -e 's|GGAIError|EZCoderAIError|g' \
    -e 's|GG Coder by Ken Kai|EZ Coder by Nolan Grout|g' \
    -e 's|GG Framework|EZCoder Framework|g' \
    -e 's|GG Coder|EZ Coder|g' \
    -e 's|GG Boss|EZ Boss|g' \
    -e 's|GG Editor|EZ Editor|g' \
    -e 's|GG Pixel|EZ Pixel|g' \
    -e 's|"Ken Kai"|"Nolan Grout"|g' \
    -e 's|GG_PIXEL_KEY|EZCODER_PIXEL_KEY|g' \
    -e 's|GG_BOSS_TELEGRAM_BOT_TOKEN|EZBOSS_TELEGRAM_BOT_TOKEN|g' \
    -e 's|GG_BOSS_TELEGRAM_USER_ID|EZBOSS_TELEGRAM_USER_ID|g' \
    -e 's|GG_TELEGRAM_BOT_TOKEN|EZCODER_TELEGRAM_BOT_TOKEN|g' \
    -e 's|GG_TELEGRAM_USER_ID|EZCODER_TELEGRAM_USER_ID|g' \
    -e 's|GG_CODER|EZ_CODER|g' \
    -e 's|KenKaiii/gg-framework|Gahroot/ezcoder|g' \
    -e 's|kenkaiiii/gg-framework|Gahroot/ezcoder|g' \
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

fix_bin "packages/cli" "ggcoder" "ezcoder"
fix_bin "packages/boss" "ggboss" "ezboss"
fix_bin "packages/editor" "ggeditor" "ezeditor"
fix_bin "packages/editor-premiere-panel" "gg-editor-premiere-panel" "ez-editor-premiere-panel"
fix_bin "packages/pixel" "gg-pixel" "ez-pixel"
fix_bin "packages/eyes" "ggcoder-eyes" "ezcoder-eyes"

# Bare CLI command names in docs / help strings (must come AFTER package.json bin renames).
# Use POSIX word boundaries [[:<:]] / [[:>:]] which work on both BSD and GNU sed.
# Order: longer first.
info "Rebranding bare CLI invocations in docs..."
while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  sed "${SED_INPLACE[@]}" \
    -e 's|[[:<:]]ggcoder-eyes[[:>:]]|ezcoder-eyes|g' \
    -e 's|[[:<:]]ggcoder[[:>:]]|ezcoder|g' \
    -e 's|[[:<:]]ggboss[[:>:]]|ezboss|g' \
    -e 's|[[:<:]]ggeditor[[:>:]]|ezeditor|g' \
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
Rebrand upstream merge: rename 9 packages and fix scope

- Rename: gg-ai→ai, gg-agent→agent, ggcoder→cli, gg-boss→boss,
  gg-editor→editor, gg-editor-premiere-panel→editor-premiere-panel,
  gg-pixel→pixel, gg-pixel-server→pixel-server, ggcoder-eyes→eyes
- Scope: @kenkaiiii→@prestyj (kept agent-home-sdk + kencode-search external)
- CLI bins: ggcoder→ezcoder, ggboss→ezboss, ggeditor→ezeditor,
  gg-editor-premiere-panel→ez-editor-premiere-panel, gg-pixel→ez-pixel,
  ggcoder-eyes→ezcoder-eyes
- Branding: GG→EZ, "Ken Kai"→"Nolan Grout", ~/.gg/→~/.ezcoder/
- Env vars: GG_*→EZCODER_*/EZBOSS_*
- Repo: KenKaiii/gg-framework→Gahroot/ezcoder

TODO: deploy our own pixel-server worker and replace the hardcoded
ingest URL in packages/pixel (currently still points at KenKai's
Cloudflare Worker).
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
info "  grep -rn 'kenkaiiii\\|@kenkaiiii\\|gg-ai\\|gg-agent\\|ggcoder\\|ggboss\\|ggeditor\\|gg-boss\\|gg-editor\\|gg-pixel\\|GGAIError\\|\"Ken Kai\"' \\"
info "    packages/ --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' \\"
info "    | grep -v 'agent-home-sdk' | grep -v 'kencode-search'"
info "  grep -rn '\\.gg/\\|\"\\.gg\"\\|~/\\.gg' packages/ --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md'"
info "  grep -rn 'GG_[A-Z_]*' packages/ --include='*.ts' --include='*.tsx'"
echo ""
info "Then:"
info "  pnpm install && pnpm build && pnpm check && pnpm lint && pnpm format:check && pnpm test"
