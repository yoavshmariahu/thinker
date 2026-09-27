#!/usr/bin/env bash
# thinker onboarding: sets up this repository to use a cache of understanding
# with Claude Code. Run it from inside the repository.
#
# The thinker repository is private, so you need access to it and either the
# GitHub CLI (gh auth login) or a token in GITHUB_TOKEN:
#
#   gh api repos/yoavshmariahu/thinker/contents/install.sh -H "Accept: application/vnd.github.raw" | bash -s -- --cache gh:caches/<repo>.tgz
#
# Options
#   --cache <source>    cache built for this repo. One of: gh:<path in the thinker repo>, an https URL, a local file.
#                       Omit if .thinker/notes is already in the repo.
#   --learn             also distill your own sessions into new notes when they end (uses your Claude usage)
#   --late              also serve notes about files as the agent opens them
#   --shared            write hooks to .claude/settings.json (committed) instead of settings.local.json
#   --mcp               register the MCP server in .mcp.json (Cursor, Codex, other MCP clients)
#   --git-hook          re-check notes against the code after every commit
#   --uninstall         remove hooks and registration from this repo (add --purge to delete notes too)
#
# Environment
#   THINKER_HOME        where the tool is installed (default ~/.thinker)
#   THINKER_GH_REPO     GitHub repository to install from (default yoavshmariahu/thinker)
#   THINKER_REF         branch or tag (default main)
#   THINKER_DIST_URL    install from this tarball URL instead of GitHub
#   GITHUB_TOKEN        used when the GitHub CLI is not available
#
# The script writes only to THINKER_HOME and to .thinker/ and .claude/ in this repository. No sudo.
set -euo pipefail

main() {
  local cache="" learn=0 late=0 shared=0 mcp=0 githook=0 uninstall=0 purge=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --cache) cache="${2:-}"; shift 2 ;;
      --learn) learn=1; shift ;;
      --late) late=1; shift ;;
      --shared) shared=1; shift ;;
      --mcp) mcp=1; shift ;;
      --git-hook) githook=1; shift ;;
      --uninstall) uninstall=1; shift ;;
      --purge) purge=1; shift ;;
      -h|--help) say "see the header of install.sh or ONBOARDING.md for options"; exit 0 ;;
      *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
  done

  local home="${THINKER_HOME:-$HOME/.thinker}"
  local ghrepo="${THINKER_GH_REPO:-yoavshmariahu/thinker}"
  local ref="${THINKER_REF:-main}"
  local dist="${THINKER_DIST_URL:-}"
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  say() { printf '%s\n' "$*"; }
  die() { printf 'thinker: %s\n' "$*" >&2; exit 1; }
  have_gh() { command -v gh >/dev/null && gh auth status >/dev/null 2>&1; }
  # fetch <path or api endpoint in the thinker repo> <output file>
  gh_fetch() {
    if have_gh; then gh api "$1" -H "Accept: application/vnd.github.raw" > "$2"
    elif [ -n "$token" ]; then curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.github.raw" -o "$2" "https://api.github.com/$1"
    else die "the thinker repository is private: run 'gh auth login' or set GITHUB_TOKEN, then retry"; fi
  }

  # --- prerequisites -----------------------------------------------------
  command -v git >/dev/null || die "git is required"
  command -v node >/dev/null || die "Node.js 20 or newer is required (https://nodejs.org)"
  command -v curl >/dev/null || die "curl is required"
  command -v tar >/dev/null || die "tar is required"
  local nodemajor; nodemajor="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$nodemajor" -ge 20 ] || die "Node.js 20 or newer is required (found $(node -v))"
  local repo; repo="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this from inside a git repository"
  cd "$repo"

  local thinker="$home/bin/thinker"

  if [ "$uninstall" = 1 ]; then
    [ -x "$thinker" ] || die "thinker is not installed in $home"
    if [ "$purge" = 1 ]; then "$thinker" uninstall --purge --repo "$repo"; else "$thinker" uninstall --repo "$repo"; fi
    say "To remove the tool itself: rm -rf \"$home\""
    exit 0
  fi

  # --- install the tool ----------------------------------------------------
  local tmp; tmp="$(mktemp -d)"
  # expand now: the variable is local and gone by the time the trap runs
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  say "Installing thinker into $home"
  if [ -n "$dist" ]; then
    curl -fsSL -o "$tmp/thinker.tgz" "$dist" || die "could not download $dist"
  else
    [ -n "$ghrepo" ] || die "no source configured: set THINKER_GH_REPO (owner/name) or THINKER_DIST_URL"
    if have_gh; then gh api "repos/$ghrepo/tarball/$ref" > "$tmp/thinker.tgz" || die "could not download $ghrepo@$ref (do you have access?)"
    elif [ -n "$token" ]; then curl -fsSL -H "Authorization: Bearer $token" -o "$tmp/thinker.tgz" "https://api.github.com/repos/$ghrepo/tarball/$ref" || die "could not download $ghrepo@$ref with the token provided"
    else die "the thinker repository is private: run 'gh auth login' or set GITHUB_TOKEN, then retry"; fi
  fi
  mkdir -p "$tmp/app" && tar -xzf "$tmp/thinker.tgz" -C "$tmp/app"
  # GitHub archives wrap everything in one top-level directory
  if [ ! -f "$tmp/app/src/cli.js" ]; then
    local inner; inner="$(find "$tmp/app" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [ -n "$inner" ] && [ -f "$inner/src/cli.js" ] || die "downloaded archive does not look like thinker"
    mv "$inner" "$tmp/app.inner" && rm -rf "$tmp/app" && mv "$tmp/app.inner" "$tmp/app"
  fi
  # the tool needs only its source and manifest at runtime
  rm -rf "$tmp/app/bench" "$tmp/app/test" "$tmp/app/caches"
  mkdir -p "$home/bin"
  rm -rf "$home/app.new" && mv "$tmp/app" "$home/app.new"
  rm -rf "$home/app.old"; [ -d "$home/app" ] && mv "$home/app" "$home/app.old"
  mv "$home/app.new" "$home/app" && rm -rf "$home/app.old"
  cat > "$thinker" <<SHIM
#!/bin/sh
exec node "$home/app/src/cli.js" "\$@"
SHIM
  chmod +x "$thinker"

  if [ "$mcp" = 1 ]; then
    command -v npm >/dev/null || die "--mcp needs npm to install the MCP server's dependencies"
    say "Installing MCP server dependencies"
    (cd "$home/app" && npm install --omit=dev --no-audit --no-fund --silent)
  fi

  # --- the cache -------------------------------------------------------------
  if [ -n "$cache" ]; then
    case "$cache" in
      gh:*) gh_fetch "repos/$ghrepo/contents/${cache#gh:}?ref=$ref" "$tmp/cache.tgz"; "$thinker" import "$tmp/cache.tgz" --repo "$repo" ;;
      *) "$thinker" import "$cache" --repo "$repo" ;;
    esac
  elif [ -d "$repo/.thinker/notes" ] && ls "$repo/.thinker/notes"/*.json >/dev/null 2>&1; then
    say "Using the cache already in this repository (.thinker/notes)"
  else
    say "No cache found for this repository. Re-run with --cache <url> once yours is ready,"
    say "or with --learn to build one from your own sessions."
  fi

  # --- wire it into this repository -------------------------------------------
  local args=""
  if [ "$learn" = 1 ]; then args="--hooks"; else args="--serve-only"; fi
  [ "$late" = 1 ] && args="$args --late"
  [ "$shared" = 1 ] || args="$args --local"
  [ "$mcp" = 1 ] || args="$args --no-mcp"
  [ "$githook" = 1 ] && args="$args --git-hook"
  # shellcheck disable=SC2086
  "$thinker" init $args --repo "$repo"

  if ! command -v claude >/dev/null; then
    say "Note: the claude CLI was not found. Notes will still be served; learning and re-verification need it."
  fi

  # --- confirm -----------------------------------------------------------------
  local count; count="$(ls "$repo/.thinker/notes"/*.json 2>/dev/null | wc -l | tr -d ' ')"
  say ""
  say "thinker is set up for $(basename "$repo"): $count notes."
  say "  Start Claude Code in this repository as usual; relevant notes are added to each request."
  say "  See what it knows:      $thinker list --repo \"$repo\""
  say "  Try a request:          $thinker orient \"<what you want to change>\" --repo \"$repo\""
  say "  Remove from this repo:  $thinker uninstall --repo \"$repo\""
  case ":$PATH:" in *":$home/bin:"*) ;; *) say "  Optional: add $home/bin to your PATH to run 'thinker' directly." ;; esac
}

main "$@"
