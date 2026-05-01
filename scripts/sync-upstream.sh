#!/usr/bin/env bash
#
# sync-upstream.sh — Pull updates from KenKaiii/ezcoder and rebrand
#
# Usage:
#   ./scripts/sync-upstream.sh           # merge upstream/main, rename dirs, fix branding
#   ./scripts/sync-upstream.sh --dry-run # show what would change without doing it
#
# What it does:
#   1. Fetches upstream (KenKaiii/ezcoder)
#   2. Merges upstream/main into current branch
#   3. Renames directories: gg-ai→ai, gg-agent→agent, ezcoder→cli, ez-pixel→pixel, ez-pixel-server→pixel-server
#   4. Fixes npm scope: @kenkaiiii→@prestyj
#   5. Fixes branding: GG→EZ, ezcoder→ezcoder, ez-pixel→ez-pixel, ~/.ezcoder/→~/.ezcoder/
#   6. Commits the rename + branding fixup
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

# ── Step 0: Check prerequisites ────────────────────────────

if ! git remote get-url upstream &>/dev/null; then
  info "Adding upstream remote..."
  git remote add upstream https://github.com/KenKaiii/ezcoder.git
fi

# ── Step 1: Fetch upstream ─────────────────────────────────

info "Fetching upstream..."
git fetch upstream

LOCAL=$(git rev-parse HEAD)
UPSTREAM=$(git rev-parse upstream/main)
BASE=$(git merge-base HEAD upstream/main)

if [[ "$UPSTREAM" == "$BASE" ]]; then
  ok "Already up to date with upstream."
  exit 0
fi

COMMIT_COUNT=$(git rev-list --count "$BASE".."$UPSTREAM")
info "Upstream has $COMMIT_COUNT new commit(s)"

if $DRY_RUN; then
  info "[dry-run] Would merge $COMMIT_COUNT commits from upstream/main"
  info "[dry-run] Would rename: gg-ai→ai, gg-agent→agent, ezcoder→cli"
  info "[dry-run] Would fix scope: @kenkaiiii→@prestyj"
  info "[dry-run] Would fix branding: GG→EZ, ezcoder→ezcoder, ~/.ezcoder/→~/.ezcoder/"
  git log --oneline "$BASE".."$UPSTREAM"
  exit 0
fi

# ── Step 2: Merge upstream ─────────────────────────────────

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

# ── Step 3: Rename directories ─────────────────────────────

info "Renaming directories..."

rename_if_exists() {
  local src="$1" dst="$2"
  if [[ -d "$src" ]]; then
    if [[ -d "$dst" ]]; then
      # Both exist after merge — move contents from src into dst
      warn "Both $src and $dst exist. Merging contents..."
      cp -r "$src"/* "$dst"/ 2>/dev/null || true
      git rm -rf "$src" --quiet
    else
      git mv "$src" "$dst"
    fi
    ok "  $src → $dst"
  fi
}

rename_if_exists "packages/ai" "packages/ai"
rename_if_exists "packages/agent" "packages/agent"
rename_if_exists "packages/cli" "packages/cli"
rename_if_exists "packages/pixel" "packages/pixel"
rename_if_exists "packages/pixel-server" "packages/pixel-server"
rename_if_exists "packages/editor" "packages/editor"
rename_if_exists "packages/editor-premiere-panel" "packages/editor-premiere-panel"
rename_if_exists "packages/cli-eyes" "packages/ezcoder-eyes"

# ── Step 4: Fix npm scope and branding ─────────────────────

info "Fixing npm scope and branding..."

# Files to process (exclude binary files, node_modules, dist, .git, lock files)
FILES=$(git ls-files -- '*.ts' '*.tsx' '*.json' '*.md' '*.js' '*.mjs' ':!pnpm-lock.yaml' ':!node_modules' ':!dist')

# Scope: @kenkaiiii → @prestyj
# Package names: gg-ai → ai, gg-agent → agent, ezcoder → cli (under @prestyj scope)
# Directory refs in docs: packages/ai → packages/ai, etc.
# Config dir: ~/.ezcoder/ → ~/.ezcoder/
# App name: ezcoder → ezcoder (binary name)
# Framework name: EZCoder Framework → EZCoder Framework
# Error class: EZCoderAIError → EZCoderAIError
# Repo URL: KenKaiii/ezcoder → Gahroot/ezcoder

while IFS= read -r file; do
  [[ -f "$file" ]] || continue

  sed -i \
    -e 's|@prestyj/ai|@prestyj/ai|g' \
    -e 's|@prestyj/agent|@prestyj/agent|g' \
    -e 's|@prestyj/cli|@prestyj/cli|g' \
    -e 's|@prestyj/pixel|@prestyj/pixel|g' \
    -e 's|@prestyj/pixel-server|@prestyj/pixel-server|g' \
    -e 's|@prestyj/cli-eyes|@prestyj/ezcoder-eyes|g' \
    -e 's|@prestyj/editor|@prestyj/editor|g' \
    -e 's|@prestyj/ez-pixel-go|@prestyj/ez-pixel-go|g' \
    -e 's|@prestyj/ez-pixel-swift|@prestyj/ez-pixel-swift|g' \
    -e 's|packages/ai|packages/ai|g' \
    -e 's|packages/agent|packages/agent|g' \
    -e 's|packages/cli|packages/cli|g' \
    -e 's|packages/pixel-server|packages/pixel-server|g' \
    -e 's|packages/pixel|packages/pixel|g' \
    -e 's|packages/cli-eyes|packages/ezcoder-eyes|g' \
    -e 's|packages/editor-premiere-panel|packages/editor-premiere-panel|g' \
    -e 's|packages/editor|packages/editor|g' \
    -e 's|"ezcoder"|"ezcoder"|g' \
    -e 's|ezcoder|ezcoder|g' \
    -e 's|~/.ezcoder/|~/.ezcoder/|g' \
    -e 's|"\.gg"|".ezcoder"|g' \
    -e 's|\.ezcoder/|.ezcoder/|g' \
    -e 's|ezcoder pixel|ezcoder pixel|g' \
    -e 's|ezcoder|ezcoder|g' \
    -e 's|ez-pixel|ez-pixel|g' \
    -e 's|EZ Coder|EZ Coder|g' \
    -e 's|EZCoder|EZCoder|g' \
    -e 's|EZCoderAIError|EZCoderAIError|g' \
    -e 's|EZCoder Framework|EZCoder Framework|g' \
    -e 's|KenKaiii/ezcoder|Gahroot/ezcoder|g' \
    -e 's|kenkaiiii/ezcoder|Gahroot/ezcoder|g' \
    -e 's|github\.com/kenkaiiii/|github.com/Gahroot/|g' \
    -e 's|Nolan G|Nolan G|g' \
    "$file"
done <<< "$FILES"

# Fix the CLI binary name in package.json bin field
if [[ -f "packages/cli/package.json" ]]; then
  sed -i 's|"ezcoder":|"ezcoder":|g' packages/cli/package.json
fi

# Fix the pixel binary name in package.json bin field
if [[ -f "packages/pixel/package.json" ]]; then
  sed -i 's|"ez-pixel":|"ez-pixel":|g' packages/pixel/package.json
fi

# Fix pixel-server wrangler.toml name
if [[ -f "packages/pixel-server/wrangler.toml" ]]; then
  sed -i 's|name = "ez-pixel-server"|name = "pixel-server"|g' packages/pixel-server/wrangler.toml
fi

# Fix the root package.json name
if [[ -f "package.json" ]]; then
  sed -i 's|"name": "ezcoder"|"name": "ezcoder"|g' package.json
fi

ok "Branding fixes applied."

# ── Step 5: Update pnpm workspace if needed ────────────────

# pnpm-workspace.yaml should reference packages/* which covers both naming schemes
# but verify it exists
if [[ -f "pnpm-workspace.yaml" ]]; then
  ok "pnpm-workspace.yaml exists (packages/* glob covers renamed dirs)"
fi

# ── Step 6: Stage and commit ───────────────────────────────

info "Staging changes..."
git add -A

if git diff --cached --quiet; then
  ok "No branding changes needed — already up to date."
else
  git commit -m "$(cat <<'EOF'
Rebrand upstream merge: rename dirs and fix scope

- Rename: gg-ai→ai, gg-agent→agent, ezcoder→cli, ez-pixel→pixel, ez-pixel-server→pixel-server
- Scope: @kenkaiiii→@prestyj
- Branding: GG→EZ, EZ Coder→EZ Coder, ezcoder→ezcoder, ez-pixel→ez-pixel, ~/.ezcoder/→~/.ezcoder/
- Repo: KenKaiii/ezcoder→Gahroot/ezcoder
EOF
)"
  ok "Rebrand commit created."
fi

# ── Done ───────────────────────────────────────────────────

echo ""
ok "Upstream sync complete!"
info "Next steps:"
info "  1. Run: pnpm install && pnpm build"
info "  2. Check for remaining GG references: grep -rn 'kenkaiiii\|gg-ai\|gg-agent\|ezcoder\|ez-pixel\|EZ Coder\|EZCoderAIError' packages/ --include='*.ts' --include='*.tsx' --include='*.json'"
info "  3. Test the CLI: pnpm --filter @prestyj/cli build && node packages/cli/dist/cli.js --version"
