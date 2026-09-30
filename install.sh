#!/usr/bin/env bash
# thinker onboarding: sets up this repository to use a knowledge cache
# with Claude Code. Run it from inside the repository.
#
# The thinker repository is private, so you need access to it and a GitHub
# token with read access, exported as GITHUB_TOKEN:
#
#   Open https://zerotime.dev, enter your access code, and copy the install command.
#
# --build does everything for a repository that has no cache yet: installs the
# tool, builds the cache from the code and merged pull requests, and wires it
# into the coding agents found on this machine. If a cache was already built
# for the repository, pass --cache instead and nothing has to be built.
#
# Options
#   --build             build the cache here (on by default for repositories without a cache)
#   --no-build          do not build a cache; only wire up hooks and MCP server (thinker init)
#   --no-seed           with --build: skip architectural subsystem exploration
#   --areas <n>         with --build: source areas to explore, one agent session each (default 12)
#   --prs <n>           with --build: merged pull requests to mine (default 60; skipped without the gh CLI)
#   --pr <number>       specific PR number to target for the paired benchmark
#   --benchmark         run paired PR benchmark during onboarding
#   --no-benchmark      skip the paired PR benchmark step
#   -y, --yes           accept defaults and skip interactive confirmation prompts
#   --clients <list>    coding agents to wire up: claude, codex, cursor, gemini, all or auto
#                       (default: auto with --build, otherwise claude)
#   --cache <source>    cache built for this repo. One of: gh:<path in the thinker repo>, an https URL, a local file.
#                       Omit if .thinker/notes is already in the repo.
#   --no-learn          do not distill your own sessions into new notes (learning is on by default, for any of the
#                       agents, and uses that agent's login; switch it off for evals)
#   --late              also serve notes about files as the agent opens them
#   --shared            write hooks to .claude/settings.json (committed) instead of settings.local.json
#   --mcp               register the MCP server in .mcp.json (Cursor, Codex, other MCP clients)
#   --git-hook          re-check notes against the code after every commit
#   --branch <name>     branch or tag to install (default main; --ref also accepted)
#   --update            update thinker CLI to the latest version and exit
#   --no-auto-update    do not schedule daily background auto-updates
#   --uninstall         remove hooks and registration from this repo (add --purge to delete notes too)
#
# Environment
#   THINKER_HOME        where the tool is installed (default ~/.thinker)
#   THINKER_GH_REPO     GitHub repository to install from (default yoavshmariahu/thinker)
#   THINKER_REF         branch or tag (default main)
#   THINKER_DIST_URL    install from this tarball URL instead of GitHub
#   GITHUB_TOKEN        token with read access to the thinker repository (GH_TOKEN works too;
#                       if neither is set and the GitHub CLI is logged in, its token is used)
#
# The script writes only to THINKER_HOME and to .thinker/ and .claude/ in this repository. No sudo.
set -euo pipefail
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

main() {
  local cache="" build=1 areas="" prs="" clients="" learn=1 late=0 shared=0 mcp=0 githook=0 uninstall=0 purge=0 update=0 autoupdate=1 ref="${THINKER_REF:-main}" benchmark="" pr_target="" yes=0 no_seed=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --cache) cache="${2:-}"; shift 2 ;;
      --build) build=1; shift ;;
      --no-build) build=0; shift ;;
      --no-seed) no_seed=1; shift ;;
      -y|--yes) yes=1; shift ;;
      --areas) areas="${2:-}"; shift 2 ;;
      --prs) prs="${2:-}"; shift 2 ;;
      --pr) pr_target="${2:-}"; shift 2 ;;
      --benchmark) benchmark=1; shift ;;
      --no-benchmark) benchmark=0; shift ;;
      --clients) clients="${2:-}"; shift 2 ;;
      --branch|--ref) ref="${2:-}"; shift 2 ;;
      --learn) learn=1; shift ;;
      --no-learn) learn=0; shift ;;
      --late) late=1; shift ;;
      --shared) shared=1; shift ;;
      --mcp) mcp=1; shift ;;
      --git-hook) githook=1; shift ;;
      --update) update=1; shift ;;
      --auto-update) autoupdate=1; shift ;;
      --no-auto-update) autoupdate=0; shift ;;
      --uninstall) uninstall=1; shift ;;
      --purge) purge=1; shift ;;
      -h|--help) say "see the header of install.sh or ONBOARDING.md for options"; exit 0 ;;
      *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
  done

  local home="${THINKER_HOME:-$HOME/.thinker}"
  local ghrepo="${THINKER_GH_REPO:-yoavshmariahu/thinker}"
  local ref="${ref:-${THINKER_REF:-main}}"
  local dist="${THINKER_DIST_URL:-https://zerotime.dev/dist/thinker.tgz}"
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  say() { printf '%s\n' "$*"; }
  die() { printf 'thinker: %s\n' "$*" >&2; exit 1; }
  # the GitHub CLI is optional: it is only asked for a token when none is set
  if [ -z "$token" ] && command -v gh >/dev/null; then token="$(gh auth token 2>/dev/null || true)"; fi
  # gh_fetch <api endpoint in the thinker repo> <output file>
  gh_fetch() {
    local url="https://api.github.com/$1" out="$2"
    if [ -n "$token" ]; then
      curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.github.raw" -o "$out" "$url" && return 0
      die "could not download $url with the token provided (does it have read access to $ghrepo?)"
    fi
    curl -fsSL -H "Accept: application/vnd.github.raw" -o "$out" "$url" 2>/dev/null && return 0
    die "could not download $url: the thinker repository is private, so export GITHUB_TOKEN (a token with read access) and retry"
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

  if [ "$update" = 1 ]; then
    [ -x "$thinker" ] || die "thinker is not installed in $home"
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
    gh_fetch "repos/$ghrepo/tarball/$ref" "$tmp/thinker.tgz"
  fi
  tar_extract() {
    local archive="$1" dest="$2"
    local warn_opt=""
    if tar --warning=no-unknown-keyword --version >/dev/null 2>&1; then
      warn_opt="--warning=no-unknown-keyword"
    fi
    local code=0
    local err
    # shellcheck disable=SC2086
    err="$(COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar ${warn_opt} -xzf "$archive" -C "$dest" 2>&1)" || code=$?
    if [ -n "$err" ]; then
      local filtered
      filtered="$(printf '%s\n' "$err" | grep -v "Ignoring unknown extended header keyword" || true)"
      if [ -n "$filtered" ]; then
        printf '%s\n' "$filtered" >&2
      fi
    fi
    [ "$code" -eq 0 ] || return "$code"
  }

  mkdir -p "$tmp/app" && tar_extract "$tmp/thinker.tgz" "$tmp/app"
  # GitHub archives wrap everything in one top-level directory
  if [ ! -f "$tmp/app/src/cli.js" ]; then
    local inner; inner="$(find "$tmp/app" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [ -n "$inner" ] && [ -f "$inner/src/cli.js" ] || die "downloaded archive does not look like thinker"
    mv "$inner" "$tmp/app.inner" && rm -rf "$tmp/app" && mv "$tmp/app.inner" "$tmp/app"
  fi
  # Use the downloaded updater to repair older clients whose update check still
  # depends on private GitHub access. Preserve the existing home and settings.
  if [ "$update" = 1 ]; then
    node --input-type=module - "$tmp/app/src/update.js" "$home" "$dist" "$ref" <<'JS'
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [modulePath, home, dist, ref] = process.argv.slice(2);
const { applyUpdate } = await import(pathToFileURL(modulePath));
const result = await applyUpdate({ home, rootDir: path.join(home, 'app'), dist, ref });
console.log(`Updated thinker to v${result.version}`);
JS
    exit 0
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
  cat > "$home/install.json" <<EOF
{
  "source": "archive",
  "ghrepo": "$ghrepo",
  "ref": "$ref",
  "dist": "$dist",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  if [ "$autoupdate" = 1 ]; then
    "$thinker" update --schedule --quiet 2>/dev/null || true
  fi

  [ "$build" = 1 ] && [ -z "$clients" ] && clients="auto"
  # Cursor is served through the MCP server, which needs its dependencies
  case "$clients" in *cursor*|all|auto) mcp=1 ;; esac
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
  elif [ "$build" = 1 ]; then
    :
  elif [ -d "$repo/.thinker/notes" ] && ls "$repo/.thinker/notes"/*.json >/dev/null 2>&1; then
    say "Using the cache already in this repository (.thinker/notes)"
  else
    say "No cache found for this repository. Re-run with --build to build one here,"
    say "or with --cache <url> if one was built for you. Without either, the cache grows from your own sessions."
  fi

  # --- wire it into this repository -------------------------------------------
  local args=""
  if [ "$build" = 1 ]; then
    args="--clients $clients"
    [ "$yes" = 1 ] && args="$args --yes"
    [ "$no_seed" = 1 ] && args="$args --no-seed"
    [ -n "$areas" ] && args="$args --areas $areas"
    [ -n "$prs" ] && args="$args --prs $prs"
    [ -n "$pr_target" ] && args="$args --pr $pr_target"
    [ "$benchmark" = 1 ] && args="$args --benchmark"
    [ "$benchmark" = 0 ] && args="$args --no-benchmark"
    [ "$learn" = 1 ] || args="$args --no-learn"
    [ "$late" = 1 ] && args="$args --late"
    [ "$shared" = 1 ] && args="$args --shared"
    [ "$githook" = 1 ] && args="$args --git-hook"
    # shellcheck disable=SC2086
    if [ ! -t 0 ] && [ -r /dev/tty ]; then
      "$thinker" onboard $args --repo "$repo" < /dev/tty
    else
      "$thinker" onboard $args --repo "$repo"
    fi
  else
    if [ "$learn" = 1 ]; then args=""; else args="--no-learn"; fi
    [ "$yes" = 1 ] && args="$args --yes"
    [ "$late" = 1 ] && args="$args --late"
    [ "$shared" = 1 ] || args="$args --local"
    [ "$mcp" = 1 ] || args="$args --no-mcp"
    [ "$githook" = 1 ] && args="$args --git-hook"
    [ -n "$clients" ] && args="$args --clients $clients"
    # shellcheck disable=SC2086
    if [ ! -t 0 ] && [ -r /dev/tty ]; then
      "$thinker" init $args --repo "$repo" < /dev/tty
    else
      "$thinker" init $args --repo "$repo"
    fi
  fi

  case ":$PATH:" in *":$home/bin:"*) ;; *) say "  Optional: add $home/bin to your PATH to run 'thinker' directly." ;; esac
}

main "$@"
