#!/usr/bin/env bash
# Cut a desktop-app release: bump the three version files that MUST stay in
# lockstep, verify they agree, commit, tag `vX.Y.Z`, and push the tag so
# `.github/workflows/release.yml` builds + publishes the installers.
#
#   scripts/release-app.sh 0.1.11           # bump to an explicit version
#   scripts/release-app.sh --retag          # re-cut the CURRENT version (move
#                                             the tag to HEAD + re-push), e.g.
#                                             after a CI fix with no version bump
#
# The three files (they are the release's source of truth — Tauri reads the
# conf, npm reads the package, cargo reads the crate):
#   ezcoder-app/package.json
#   ezcoder-app/src-tauri/tauri.conf.json
#   ezcoder-app/src-tauri/Cargo.toml
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly PKG="$REPO_ROOT/ezcoder-app/package.json"
readonly CONF="$REPO_ROOT/ezcoder-app/src-tauri/tauri.conf.json"
readonly CARGO="$REPO_ROOT/ezcoder-app/src-tauri/Cargo.toml"

die() {
  echo "release: $*" >&2
  exit 1
}

current_version() {
  # The conf is the canonical read; the others are kept in sync to it.
  grep -m1 '"version"' "$CONF" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

set_version() {
  local v="$1"
  # package.json + tauri.conf.json: first `"version": "..."` line.
  # Replace ONLY the first `"version": "..."` in each JSON file (the top-level
  # app version). The `!$done && s/.../ && ($done=1)` guard increments only when
  # the substitution actually matched, so an early non-matching line can't
  # consume the guard and a later stray version field is never rewritten.
  perl -pi -e '!$done and s/("version"\s*:\s*")[^"]+(")/${1}'"$v"'${2}/ and $done=1;' "$PKG"
  perl -pi -e '!$done and s/("version"\s*:\s*")[^"]+(")/${1}'"$v"'${2}/ and $done=1;' "$CONF"
  # Cargo.toml: the first `version = "..."` (the [package] version near the top).
  perl -pi -e '!$done and s/^(version\s*=\s*")[^"]+(")/${1}'"$v"'${2}/ and $done=1;' "$CARGO"
}

assert_in_sync() {
  local v="$1"
  local pv cv gv
  pv="$(grep -m1 '"version"' "$PKG" | sed -E 's/.*"([0-9][^"]*)".*/\1/')"
  cv="$(grep -m1 '"version"' "$CONF" | sed -E 's/.*"([0-9][^"]*)".*/\1/')"
  gv="$(grep -m1 '^version' "$CARGO" | sed -E 's/.*"([0-9][^"]*)".*/\1/')"
  [[ "$pv" == "$v" && "$cv" == "$v" && "$gv" == "$v" ]] ||
    die "version files disagree (package=$pv conf=$cv cargo=$gv, want $v)"
}

main() {
  [[ $# -eq 1 ]] || die "usage: release-app.sh <X.Y.Z|--retag>"
  cd "$REPO_ROOT"

  # A dirty tree would get swept into the release commit — refuse up front.
  [[ -z "$(git status --porcelain)" ]] ||
    die "working tree is dirty; commit or stash first"

  local mode="$1" version tag
  if [[ "$mode" == "--retag" ]]; then
    version="$(current_version)"
    tag="v$version"
    echo "release: re-cutting $tag on $(git rev-parse --short HEAD)"
    git tag -f "$tag"
    git push -f origin "$tag"
    echo "release: $tag re-pushed — watch the build with: gh run watch"
    return 0
  fi

  version="$mode"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "version must look like X.Y.Z (got '$version')"
  tag="v$version"

  git rev-parse "$tag" >/dev/null 2>&1 &&
    die "tag $tag already exists (use a new version, or --retag to move it)"

  echo "release: bumping $(current_version) -> $version"
  set_version "$version"
  assert_in_sync "$version"

  git add "$PKG" "$CONF" "$CARGO"
  git commit -m "Release ezcoder-app v$version"
  git tag "$tag"
  git push origin HEAD
  git push origin "$tag"

  echo "release: $tag pushed — watch the build with: gh run watch"
}

main "$@"
