#!/usr/bin/env bash
#
# sync-upstream.sh — Pull updates from KenKaiii/gg-framework and rebrand
#
# Usage:
#   ./scripts/sync-upstream.sh                  # merge, rename, and rebrand
#   ./scripts/sync-upstream.sh --dry-run        # show incoming upstream commits
#   ./scripts/sync-upstream.sh --normalize-only # normalize legacy product tokens only
#
# What it does:
#   1. Fetches upstream (KenKaiii/gg-framework)
#   2. Merges upstream/main into current branch
#   3. Renames upstream package directories to our package directories
#   4. Fixes npm scope and package imports for internal packages only
#   5. Fixes branding: GG→EZ, ggcoder/ggboss/ggeditor→ez*, ~/.gg/→~/.ezcoder/
#   6. Renames CLI bin entries, bridge paths, screenshots, and Pixel SDK symbols
#   7. Rewrites env vars, error classes, repo URLs, and ingest URLs
#   8. Commits the rename + branding fixup
#
# Third-party deps that STAY external (NOT touched by scope replacement):
#   - @kenkaiiii/agent-home-sdk
#   - @kenkaiiii/kencode-search
#
# Identifiers that STAY verbatim (NOT branding — load-bearing contracts):
#   - GG_APP_* env vars (GG_APP_PORT/CWD/SESSION_ID, GG_APP_LISTENING/FATAL):
#     the stdout/stdin IPC handshake between the ezcoder-app Tauri shell and the
#     cli app-sidecar. Both sides must agree on the literal string, so renaming
#     one without the other silently hangs the desktop app. Left as-is on both.
#
# If the merge has conflicts, it stops and asks you to resolve them first.
# After resolving, re-run the script to continue with renames + branding.

set -euo pipefail
IFS=$'\n\t'

readonly REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=false
NORMALIZE_ONLY=false
case "${1:-}" in
  --dry-run) DRY_RUN=true ;;
  --normalize-only) NORMALIZE_ONLY=true ;;
esac

readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

info() { echo -e "${BLUE}[sync]${NC} $*"; }
ok() { echo -e "${GREEN}[sync]${NC} $*"; }
warn() { echo -e "${YELLOW}[sync]${NC} $*"; }
err() { echo -e "${RED}[sync]${NC} $*"; }

if [[ "$(uname)" == "Darwin" ]]; then
  SED_INPLACE=(-i '')
else
  SED_INPLACE=(-i)
fi

ensure_upstream() {
  if ! git remote get-url upstream &>/dev/null; then
    info "Adding upstream remote..."
    git remote add upstream https://github.com/KenKaiii/gg-framework.git
  fi
}

rename_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ ! -d "$src" ]]; then
    return
  fi

  if [[ -d "$dst" ]]; then
    warn "Both $src and $dst exist. Merging contents..."
    cp -R "$src"/. "$dst"/ 2>/dev/null || true
    git rm -rf "$src" --quiet
  else
    mkdir -p "$(dirname "$dst")"
    git mv "$src" "$dst"
  fi
  ok "  $src → $dst"
}

rename_file_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "$src" ]]; then
    return
  fi

  mkdir -p "$(dirname "$dst")"
  if [[ -f "$dst" ]]; then
    warn "Both $src and $dst exist. Keeping $dst and removing $src."
    git rm -f "$src" --quiet
  else
    git mv "$src" "$dst"
  fi
  ok "  $src → $dst"
}

replace_in_tracked_text_files() {
  local files
  files=$(git ls-files -- \
    '*.ts' '*.tsx' '*.json' '*.md' '*.js' '*.jsx' '*.mjs' '*.yaml' '*.yml' '*.toml' '*.sh' \
    '*.html' '*.css' '*.xml' '*.lock' '.debug' '.gitattributes' '.prettierignore' \
    '*.py' '*.rb' '*.rs' '*.swift' '*.go' '*.gemspec' 'go.mod' 'Cargo.toml' 'Cargo.lock' 'Package.swift' \
    ':!pnpm-lock.yaml' ':!node_modules' ':!dist' ':!scripts/sync-upstream.sh')

  while IFS= read -r file; do
    [[ -f "$file" ]] || continue
    sed "${SED_INPLACE[@]}" \
      -e 's|@kenkaiiii/gg-core|@prestyj/core|g' \
      -e 's|@kenkaiiii/gg-ai|@prestyj/ai|g' \
      -e 's|@kenkaiiii/gg-agent|@prestyj/agent|g' \
      -e 's|@kenkaiiii/ggcoder-eyes|@prestyj/eyes|g' \
      -e 's|@kenkaiiii/ggcoder|@prestyj/cli|g' \
      -e 's|@kenkaiiii/gg-boss|@prestyj/boss|g' \
      -e 's|@kenkaiiii/gg-editor-premiere-panel|@prestyj/editor-premiere-panel|g' \
      -e 's|@kenkaiiii/gg-editor|@prestyj/editor|g' \
      -e 's|@kenkaiiii/gg-pixel-server|@prestyj/pixel-server|g' \
      -e 's|@kenkaiiii/gg-pixel|@prestyj/pixel|g' \
      -e 's|@kenkaiiii/gg-voice|@prestyj/voice|g' \
      -e 's|packages/gg-core|packages/core|g' \
      -e 's|packages/gg-ai|packages/ai|g' \
      -e 's|packages/gg-agent|packages/agent|g' \
      -e 's|packages/ggcoder-eyes|packages/eyes|g' \
      -e 's|packages/ggcoder|packages/cli|g' \
      -e 's|"packages", "ggcoder"|"packages", "cli"|g' \
      -e 's|^\( *\)"ggcoder",$|\1"cli",|g' \
      -e 's|packages/gg-boss|packages/boss|g' \
      -e 's|packages/gg-editor-premiere-panel|packages/editor-premiere-panel|g' \
      -e 's|packages/gg-editor|packages/editor|g' \
      -e 's|packages/gg-pixel-server|packages/pixel-server|g' \
      -e 's|packages/gg-pixel-swift|packages/pixel-swift|g' \
      -e 's|packages/gg-pixel-go|packages/pixel-go|g' \
      -e 's|packages/gg-pixel-py|packages/pixel-py|g' \
      -e 's|packages/gg-pixel-rb|packages/pixel-rb|g' \
      -e 's|packages/gg-pixel-rs|packages/pixel-rs|g' \
      -e 's|packages/gg-pixel|packages/pixel|g' \
      -e 's|packages/gg-voice|packages/voice|g' \
      -e 's|"name": "gg-framework"|"name": "ezcoder"|g' \
      -e 's|"gg-framework"|"ezcoder"|g' \
      -e 's|KenKaiii/gg-framework|Gahroot/ezcoder|g' \
      -e 's|kenkaiiii/gg-framework|Gahroot/ezcoder|g' \
      -e 's|github.com/KenKaiii/ezcoder|github.com/Gahroot/ezcoder|g' \
      -e 's|github.com/kenkaiiii/ezcoder|github.com/Gahroot/ezcoder|g' \
      -e 's|github.com/kenkaiiii/ez-pixel-swift|github.com/Gahroot/ezcoder|g' \
      -e 's|github.com/KenKaiii|github.com/Gahroot|g' \
      -e 's|github.com/Gahroot/agent-steroids|github.com/KenKaiii/agent-steroids|g' \
      -e 's|github.com/kenkaiiii/gg-pixel-go|github.com/Gahroot/ezcoder/packages/pixel-go|g' \
      -e 's|gg-framework|ezcoder|g' \
      -e 's|~/\.gg/|~/.ezcoder/|g' \
      -e 's|~/.gg/|~/.ezcoder/|g' \
      -e 's|~/\.gg|~/.ezcoder|g' \
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
      -e 's|\.gg/|.ezcoder/|g' \
      -e 's|/\.gg"|/.ezcoder"|g' \
      -e 's|\.gg-tasks|.ezcoder-tasks|g' \
      -e 's|GGAIError|EZCoderAIError|g' \
      -e 's|Ken just pushed a new update|Nolan just pushed a new update|g' \
      -e 's|GG Coder by Ken Kai|EZ Coder by Nolan Grout|g' \
      -e 's|GG Framework|EZCoder Framework|g' \
      -e 's|GG Coder|EZ Coder|g' \
      -e 's|GG Boss|EZ Boss|g' \
      -e 's|GG Editor|EZ Editor|g' \
      -e 's|GG Pixel|EZ Pixel|g' \
      -e 's|GGPixel|EZPixel|g' \
      -e 's|gg_pixel|ez_pixel|g' \
      -e 's|gg-pixel|ez-pixel|g' \
      -e 's|ggpixel|ezpixel|g' \
      -e 's|GG Voice|EZ Voice|g' \
      -e 's|Provider-agnostic realtime voice orchestration for GG tools and agents|Provider-agnostic realtime voice orchestration for EZ tools and agents|g' \
      -e 's|"Ken Kai"|"Nolan Grout"|g' \
      -e 's|Ken Kai|Nolan Grout|g' \
      -e 's|GG_PIXEL_KEY|EZCODER_PIXEL_KEY|g' \
      -e 's|GG_BOSS_TELEGRAM_BOT_TOKEN|EZBOSS_TELEGRAM_BOT_TOKEN|g' \
      -e 's|GG_BOSS_TELEGRAM_USER_ID|EZBOSS_TELEGRAM_USER_ID|g' \
      -e 's|GG_TELEGRAM_BOT_TOKEN|EZCODER_TELEGRAM_BOT_TOKEN|g' \
      -e 's|GG_TELEGRAM_USER_ID|EZCODER_TELEGRAM_USER_ID|g' \
      -e 's|GG_CODER|EZ_CODER|g' \
      -e 's|gg-pixel-server\.buzzbeamaustralia\.workers\.dev|pixel-server.ngrout70.workers.dev|g' \
      -e 's|ggcoder-eyes|ezcoder-eyes|g' \
      -e 's|ggcoder-rpc|ezcoder-rpc|g' \
      -e 's|ggcoder|ezcoder|g' \
      -e 's|ggboss|ezboss|g' \
      -e 's|ggeditor|ezeditor|g' \
      -e 's|gg-editor-premiere-panel|ez-editor-premiere-panel|g' \
      -e 's|gg-editor|ez-editor|g' \
      -e 's|GG CODER|EZ CODER|g' \
      -e 's|gg_app_lib|ezcoder_app_lib|g' \
      -e 's|gg-app|ezcoder-app|g' \
      -e 's|gg-coder|ezcoder|g' \
      -e 's|ggnode|eznode|g' \
      -e 's|ggblink|ezblink|g' \
      -e 's|com\.ggcoder\.app|com.prestyj.ezcoder|g' \
      -e 's|com\.ezcoder\.app|com.prestyj.ezcoder|g' \
      -e 's|com\.kenkaiiii\.gg-editor-premiere-panel|com.prestyj.ez-editor-premiere-panel|g' \
      -e 's|com\.kenkaiiii\.ez-editor-premiere-panel|com.prestyj.ez-editor-premiere-panel|g' \
      -e 's|description = "A Tauri App"|description = "EZ Coder \xe2\x80\x94 the coding agent, on your desktop"|g' \
      -e 's|authors = \["you"\]|authors = ["Nolan Grout <nolan@prestyj.com>"]|g' \
      -e 's|https://skool.com/kenkai|https://prestyj.com|g' \
      -e 's|https://youtube.com/@kenkaidoesai|https://prestyj.com|g' \
      "$file"
  done <<< "$files"
}

# Normalize legacy product/package tokens that may survive when upstream prose
# or identifiers split the basic branding replacements (for example GGCoder or gg-ai).
# Changelogs remain historical records; generated dist/sidecar files are rebuilt.
replace_legacy_product_tokens() {
  local files
  files=$(git ls-files -- \
    '*.ts' '*.tsx' '*.json' '*.md' '*.js' '*.jsx' '*.mjs' '*.yaml' '*.yml' '*.toml' \
    '*.html' '*.css' '*.xml' '*.rs' \
    ':!**/CHANGELOG.md' ':!dist' ':!**/dist/**' ':!ezcoder-app/src-tauri/sidecar/**' \
    ':!scripts/sync-upstream.sh')

  while IFS= read -r file; do
    [[ -f "$file" ]] || continue
    sed "${SED_INPLACE[@]}" \
      -e 's|GGCODER_|EZCODER_|g' \
      -e 's|GGCoder|EZCoder|g' \
      -e 's|Ggcoder|Ezcoder|g' \
      -e 's|gg-core-auth-storage-test|ezcoder-core-auth-storage-test|g' \
      -e 's|gg-agent-plugin|ezcoder-agent-plugin|g' \
      -e 's|gg-agents-|ezcoder-agents-|g' \
      -e 's|crash-gg-agent-shim|crash-ezcoder-agent-shim|g' \
      -e 's|gg-ai|@prestyj/ai|g' \
      -e 's|gg-agent|@prestyj/agent|g' \
      -e 's|gg-core|@prestyj/core|g' \
      -e 's|gg-boss|ezboss|g' \
      -e 's|gg-voice|@prestyj/voice|g' \
      -e 's|__SYNC_PRESERVE_EZ_APP__|GG_APP_|g' \
      -e 's|GG_APP_|__SYNC_APP_CONTRACT__|g' \
      -e 's|GG_|EZ_|g' \
      -e 's|__SYNC_APP_CONTRACT__|GG_APP_|g' \
      -e 's|gg-|ez-|g' \
      -e 's|oez-opus-decoder|ogg-opus-decoder|g' \
      -e 's|OEZ Opus|OGG Opus|g' \
      -e 's|gg_|ez_|g' \
      -e 's|GG tools|EZ tools|g' \
      -e 's|GG remotes|EZ remotes|g' \
      -e 's|GG bridge|EZ bridge|g' \
      "$file"
  done <<< "$files"
}

# Rename the upstream "@Ken" mentor agent persona to our "@Nolan" persona.
#
# This is SEPARATE from the GG→EZ branding sed block because it needs real
# word-boundary anchoring (perl \b), not substring replacement. The string
# "ken" is a substring of load-bearing identifiers we MUST NOT touch:
#   - token / tokens / tokenUsage / tokensRef ... (LLM token accounting)
#   - kencode-search / mcp__kencode-search / @kenkaiiii (the search provider)
#   - Ken-Burns / ken_burns / createKenBurnsTool (the editor photography effect)
#   - KenKai / KenKaiii (upstream author attribution in LICENSE/READMEs)
#   - kennedy (a word-boundary example in a code comment)
# Each rule below is anchored and/or excludes those roots explicitly.
rebrand_ken_mentor() {
  local files
  files=$(git ls-files -- \
    '*.ts' '*.tsx' '*.json' '*.md' '*.js' '*.mjs' '*.css' '*.rs' '*.toml' \
    ':!pnpm-lock.yaml' ':!node_modules' ':!dist' ':!scripts/sync-upstream.sh')

  while IFS= read -r file; do
    [[ -f "$file" ]] || continue
    perl -0777 -pi -e '
      # ALL-CAPS mentor consts (anchored; TOKEN_ has no boundary before KEN)
      s/\bKEN_(PROMPT_FENCE|ALLOWED_MCP_SERVERS|ALLOWED_TOOLS|RECENT_MESSAGE_LIMIT|TURN_CUSTOM_KIND)\b/NOLAN_$1/g;
      # snake_case SSE events, Tauri commands, and route names (explicit list excludes ken_burns)
      s/\bken_(run_start|run_end|text_delta|thinking_delta|tool_call_start|tool_call_update|tool_call_end|server_tool_call|turn_end|turn|error|cancel|prompt|model|model_change)\b/nolan_$1/g;
      s/_ken_(cancel|prompt|model)\b/_nolan_$1/g;
      s{/ken/(prompt|cancel|model)}{/nolan/$1}g;
      # kebab-case CSS classes + file stems (explicit list excludes ken-burns)
      s/\bken-(autopilot-on|autopilot-off|context|input|model|msg|power|prompt|sent|spinner|statusrow)\b/nolan-$1/g;
      # camelCase mentor vars: word-start ken + UpperCase (tokenUsage fails \b)
      s/\bken([A-Z]\w*)/nolan$1/g;
      # Exact lowercase mentor symbols in known type/property/string contexts.
      s/\bken\?: boolean\b/nolan?: boolean/g;
      s/\bken: true\b/nolan: true/g;
      s/\.ken\b/.nolan/g;
      s/\bken: token\("ken"\)/nolan: token("nolan")/g;
      s/\bkind: "ken"\b/kind: "nolan"/g;
      s/\bcase "ken":/case "nolan":/g;
      s/\bconst ken =/const nolanAgent =/g;
      s/\bken\./nolanAgent./g;
      s/= ken;/= nolanAgent;/g;
      s/\breturn ken;/return nolanAgent;/g;
      s/--ken\b/--nolan/g;
      # lowercase @ken mention trigger in regex literals (\b after "ken" keeps
      # @kenkaiiii and @kennedy safe — both have a letter, not a boundary, next)
      s/\@ken\b/\@nolan/g;
      # stale comment refs to the renamed SSE event family + delegate prose
      s/ken_\*/nolan_*/g;
      s/ken_-prefixed/nolan_-prefixed/g;
      s/\bken events\b/nolan events/g;
      # any remaining capital Ken (PascalCase types, compound fns, @Ken, prose),
      # excluding the protected roots above
      s/Ken(?!Burns|Kai|code|nedy|-Burns| Burns)/Nolan/g;
    ' "$file"
  done <<< "$files"
}

fix_bin() {
  local pkg_path="$1"
  local old_bin="$2"
  local new_bin="$3"
  if [[ -f "$pkg_path/package.json" ]]; then
    sed "${SED_INPLACE[@]}" "s|\"$old_bin\":|\"$new_bin\":|g" "$pkg_path/package.json"
  fi
}

main() {
  if $NORMALIZE_ONLY; then
    replace_legacy_product_tokens
    ok "Legacy product tokens normalized"
    return
  fi

  ensure_upstream

  info "Fetching upstream..."
  git fetch upstream

  local upstream_commit base commit_count
  upstream_commit=$(git rev-parse upstream/main)
  base=$(git merge-base HEAD upstream/main)
  commit_count=$(git rev-list --count "$base".."$upstream_commit" || echo 0)
  info "Upstream has $commit_count new commit(s)"

  if $DRY_RUN; then
    info "[dry-run] Would merge $commit_count commits from upstream/main"
    info "[dry-run] Would rename upstream packages and rebrand GG→EZ"
    if [[ "$commit_count" != "0" ]]; then
      git log --oneline "$base".."$upstream_commit"
    fi
    exit 0
  fi

  if [[ "$upstream_commit" != "$base" ]]; then
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
  else
    ok "Already up to date with upstream. Running rebrand pass anyway."
  fi

  info "Renaming directories..."
  rename_if_exists "packages/gg-core" "packages/core"
  rename_if_exists "packages/gg-ai" "packages/ai"
  rename_if_exists "packages/gg-agent" "packages/agent"
  rename_if_exists "packages/ggcoder-eyes" "packages/eyes"
  rename_if_exists "packages/ggcoder" "packages/cli"
  rename_if_exists "packages/gg-boss" "packages/boss"
  rename_if_exists "packages/gg-editor-premiere-panel" "packages/editor-premiere-panel"
  rename_if_exists "packages/gg-editor" "packages/editor"
  rename_if_exists "packages/gg-pixel-server" "packages/pixel-server"
  rename_if_exists "packages/gg-pixel-swift" "packages/pixel-swift"
  rename_if_exists "packages/gg-pixel-go" "packages/pixel-go"
  rename_if_exists "packages/gg-pixel-py" "packages/pixel-py"
  rename_if_exists "packages/gg-pixel-rb" "packages/pixel-rb"
  rename_if_exists "packages/gg-pixel-rs" "packages/pixel-rs"
  rename_if_exists "packages/gg-pixel" "packages/pixel"
  rename_if_exists "packages/gg-voice" "packages/voice"
  rename_if_exists "gg-app" "ezcoder-app"

  # Files copied into an existing renamed directory are untracked until staged.
  # Stage now so the git-ls-files based branding passes include every new file.
  git add -A

  info "Fixing npm scope and branding..."
  replace_in_tracked_text_files
  replace_legacy_product_tokens

  info "Renaming @Ken mentor agent → @Nolan..."
  rebrand_ken_mentor

  info "Fixing CLI bin entries..."
  fix_bin "packages/cli" "ggcoder" "ezcoder"
  fix_bin "packages/boss" "ggboss" "ezboss"
  fix_bin "packages/editor" "ggeditor" "ezeditor"
  fix_bin "packages/editor-premiere-panel" "gg-editor-premiere-panel" "ez-editor-premiere-panel"
  fix_bin "packages/pixel" "gg-pixel" "ez-pixel"
  fix_bin "packages/eyes" "ggcoder-eyes" "ezcoder-eyes"

  rename_file_if_exists "packages/cli/screenshots/ggcoder.png" "packages/cli/screenshots/ezcoder.png"
  rename_file_if_exists "packages/boss/screenshots/ggboss.png" "packages/boss/screenshots/ezboss.png"
  rename_file_if_exists "packages/voice/src/bridges/ggcoder-rpc.ts" "packages/voice/src/bridges/ezcoder-rpc.ts"
  rename_file_if_exists "packages/voice/src/bridges/ggboss.ts" "packages/voice/src/bridges/ezboss.ts"
  rename_file_if_exists "packages/pixel-py/src/gg_pixel" "packages/pixel-py/src/ez_pixel"
  rename_file_if_exists "packages/pixel-rb/gg_pixel.gemspec" "packages/pixel-rb/ez_pixel.gemspec"
  rename_file_if_exists "packages/pixel-rb/lib/gg_pixel.rb" "packages/pixel-rb/lib/ez_pixel.rb"
  rename_file_if_exists "packages/pixel-rb/lib/gg_pixel" "packages/pixel-rb/lib/ez_pixel"
  rename_file_if_exists "packages/pixel-swift/Sources/GGPixel" "packages/pixel-swift/Sources/EZPixel"
  rename_file_if_exists "packages/pixel-swift/Sources/EZPixel/GGPixel.swift" "packages/pixel-swift/Sources/EZPixel/EZPixel.swift"
  rename_file_if_exists "packages/pixel-swift/Sources/GGPixelSmoke" "packages/pixel-swift/Sources/EZPixelSmoke"
  rename_file_if_exists "packages/pixel-swift/Tests/GGPixelTests" "packages/pixel-swift/Tests/EZPixelTests"
  rename_file_if_exists "packages/pixel-swift/Tests/EZPixelTests/GGPixelTests.swift" "packages/pixel-swift/Tests/EZPixelTests/EZPixelTests.swift"

  info "Renaming @Ken mentor files → nolan-*..."
  rename_file_if_exists "packages/cli/src/core/ken-prompt.ts" "packages/cli/src/core/nolan-prompt.ts"
  rename_file_if_exists "packages/cli/src/core/ken-prompt.test.ts" "packages/cli/src/core/nolan-prompt.test.ts"
  rename_file_if_exists "packages/cli/src/core/ken-context.ts" "packages/cli/src/core/nolan-context.ts"
  rename_file_if_exists "packages/cli/src/core/ken-context.test.ts" "packages/cli/src/core/nolan-context.test.ts"
  rename_file_if_exists "packages/cli/src/core/ken-model.ts" "packages/cli/src/core/nolan-model.ts"
  rename_file_if_exists "packages/cli/src/core/ken-model.test.ts" "packages/cli/src/core/nolan-model.test.ts"
  rename_file_if_exists "ezcoder-app/src/KenPowerBanner.tsx" "ezcoder-app/src/NolanPowerBanner.tsx"
  rename_file_if_exists "ezcoder-app/src/KenActivityBar.tsx" "ezcoder-app/src/NolanActivityBar.tsx"
  rename_file_if_exists "ezcoder-app/src/useKenMentor.ts" "ezcoder-app/src/useNolanMentor.ts"
  rename_file_if_exists "ezcoder-app/src/useKenMentor.test.ts" "ezcoder-app/src/useNolanMentor.test.ts"
  rename_file_if_exists "ezcoder-app/src/assets/ken-autopilot-on.mp3" "ezcoder-app/src/assets/nolan-autopilot-on.mp3"
  rename_file_if_exists "ezcoder-app/src/assets/ken-autopilot-off.mp3" "ezcoder-app/src/assets/nolan-autopilot-off.mp3"

  git add -A
  if git diff --cached --quiet; then
    ok "No branding changes needed — already up to date."
  else
    git commit -m "Rebrand upstream merge: rename packages and fix scope"
    ok "Rebrand commit created."
  fi

  ok "Upstream sync complete!"
  info "Verify: pnpm install && pnpm build && pnpm check && pnpm lint && pnpm format:check && pnpm test"
}

main "$@"
