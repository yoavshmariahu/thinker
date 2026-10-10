#!/usr/bin/env bash
# thinker setup: installs the thinker tool, wires it into the coding agents on
# this machine (their own settings: hooks and the MCP server, once, for every
# repository that is set up) and, when run from inside a repository, sets that
# repository up to use a knowledge cache. Run anywhere else, it installs and
# wires the tool; then run `thinker setup` inside a repository to set it up.
# A repository that is not set up is served nothing and learns nothing.
#
# Thinker is open source; no access code or GitHub token is required.
#
#   curl -fsSL https://zerotime.dev/dist/install.sh | bash
#
# --build does everything for a repository that has no cache yet: installs the
# tool, builds the cache from the merged pull requests, and wires it
# into the coding agents found on this machine. If a cache was already built
# for the repository, pass --cache instead and nothing has to be built.
#
# Options
#   --build             build the cache here without asking (otherwise `thinker setup` offers it, with an estimate)
#   --no-build          do not build a cache; only wire up the hooks and the MCP server
#   --no-behaviors      do not print the prompt for defining the desired behaviors with your agent
#   --no-seed, --areas <n>   accepted from old scripts and ignored: a build no longer explores the code
#   --depth <d>         with --build: full (default) or shallow, 30% of the full build
#   --prs <n>           with --build: merged pull requests to mine (default 60; skipped without the gh CLI)
#   --pr <number>       specific PR number to target for the paired benchmark
#   --benchmark         run paired PR benchmark during setup
#   --no-benchmark      skip the paired PR benchmark step
#   -y, --yes           accept defaults and skip interactive confirmation prompts
#   --clients <list>    coding agents to wire up: claude, codex, cursor, gemini, pi, windsurf, copilot, opencode, all or auto
#                       (default auto)
#   --cache <source>    cache built for this repo. One of: gh:<path in the thinker repo>, an https URL, a local file.
#                       Omit if .thinker/notes is already in the repo.
#   --no-learn          do not distill your own sessions into new notes (learning is on by default, for any of the
#                       agents, and uses that agent's login; switch it off for evals)
#   --late              also serve notes about files as the agent opens them
#   --mcp               accepted for compatibility: the MCP server is always registered (needs npm)
#   --no-git-hook       do not install the git post-commit hook (it re-checks and maintains notes after each commit)
#   --branch <name>     branch or tag to install (default main; --ref also accepted)
#   --update            update thinker CLI to the latest version and exit
#   --no-auto-update    do not schedule daily background auto-updates
#   --no-modify-path    do not add THINKER_HOME/bin to PATH in your shell's startup file
#   --uninstall         remove hooks and registration from this repo (add --purge to delete notes too); run outside
#                       a repository, it removes the wiring from your agents' own settings
#
# Environment
#   THINKER_HOME        where the tool is installed (default ~/.thinker)
#   THINKER_GH_REPO     GitHub repository to install from (default yoavshmariahu/thinker)
#   THINKER_REF         branch or tag (default main)
#   THINKER_DIST_URL    install from this tarball URL instead of GitHub
#   GITHUB_TOKEN        token with read access to the thinker repository (GH_TOKEN works too;
#                       if neither is set and the GitHub CLI is logged in, its token is used)
#
# The script writes to THINKER_HOME, to .thinker/ and the agents' config in this repository, and adds one
# line putting THINKER_HOME/bin on PATH to your shell's startup file (--no-modify-path leaves it alone). No sudo.
set -euo pipefail
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

# add_to_path <dir>: put <dir> on PATH in the startup file of the user's shell, once.
# Prints the file it wrote to, or nothing when it could not tell which one.
add_to_path() {
  local dir="$1" rc line
  case "$(basename "${SHELL:-}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc"; line="export PATH=\"$dir:\$PATH\"" ;;
    bash) # macOS terminals start login shells, which read .bash_profile and not .bashrc
      if [ "$(uname)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      line="export PATH=\"$dir:\$PATH\"" ;;
    fish) rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/thinker.fish"; line="fish_add_path \"$dir\"" ;;
    *) return 0 ;;
  esac
  if ! grep -qsF "$line" "$rc"; then
    mkdir -p "$(dirname "$rc")" && printf '\n# thinker\n%s\n' "$line" >> "$rc" || return 0
  fi
  printf '%s' "$rc"
}

# path_hint: how to reach `thinker` from this shell; reads main's $home and $rcfile
path_hint() {
  case ":$PATH:" in
    *":$home/bin:"*) ;;
    *) if [ -n "$rcfile" ]; then say "  'thinker' is on your PATH in new terminals (added to $rcfile); in this one run: export PATH=\"$home/bin:\$PATH\""
       else say "  Optional: add $home/bin to your PATH to run 'thinker' directly."; fi ;;
  esac
}

main() {
  local cache="" build="" areas="" depth="" prs="" clients="" learn=1 late=0 mcp=0 githook=0 uninstall=0 purge=0 update=0 autoupdate=1 modpath=1 ref="${THINKER_REF:-main}" benchmark="" pr_target="" yes=0 no_seed=0 behaviors=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --cache) cache="${2:-}"; build=0; shift 2 ;;
      --build) build=1; shift ;;
      --no-build) build=0; shift ;;
      --no-seed) shift ;;
      --no-behaviors) behaviors=0; shift ;;
      -y|--yes) yes=1; shift ;;
      --areas) shift 2 ;;
      --depth) depth="${2:-}"; shift 2 ;;
      --prs) prs="${2:-}"; shift 2 ;;
      --pr) pr_target="${2:-}"; shift 2 ;;
      --benchmark) benchmark=1; shift ;;
      --no-benchmark) benchmark=0; shift ;;
      --clients) clients="${2:-}"; shift 2 ;;
      --branch|--ref) ref="${2:-}"; shift 2 ;;
      --learn) learn=1; shift ;;
      --no-learn) learn=0; shift ;;
      --late) late=1; shift ;;
      --shared) echo "Team sharing is no longer supported." >&2; return 1 ;;
      --mcp) mcp=1; shift ;;
      --git-hook) githook=1; shift ;;
      --no-git-hook) githook=0; shift ;;
      --update) update=1; shift ;;
      --auto-update) autoupdate=1; shift ;;
      --no-auto-update) autoupdate=0; shift ;;
      --no-modify-path) modpath=0; shift ;;
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
  # --- look: colors, boxes and spinners on a terminal, plain lines anywhere else --------------
  local fancy=0 bold="" dim="" cyan="" green="" yellow="" red="" magenta="" reset=""
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ] && [ -z "${CI:-}" ]; then
    fancy=1 bold=$'\033[1m' dim=$'\033[2m' cyan=$'\033[36m' green=$'\033[32m' yellow=$'\033[33m' red=$'\033[31m' magenta=$'\033[35m' reset=$'\033[0m'
  fi
  # box <color> <line>...: a rounded box 74 columns wide, as setup draws it; a line may carry color codes, padded on its plain text
  box() {
    local color="$1"; shift
    local width=68 line plain
    printf '%s╭%s╮%s\n' "$color" "$(printf '─%.0s' $(seq 1 $((width + 4))))" "$reset"
    for line in "$@"; do
      plain="$(printf '%s' "$line" | sed $'s/\033\\[[0-9;]*m//g')"
      printf '%s│%s  %s%*s  %s│%s\n' "$color" "$reset" "$line" $((width - ${#plain})) "" "$color" "$reset"
    done
    printf '%s╰%s╯%s\n' "$color" "$(printf '─%.0s' $(seq 1 $((width + 4))))" "$reset"
  }
  # spin <label> <command...>: runs the command with a turning frame and the time so far, then a ✓ or ✗
  # line; its output is kept and shown only if it fails. Off a terminal: the label, then the command.
  spin() {
    local label="$1"; shift
    if [ "$fancy" != 1 ]; then say "  $label…"; "$@"; return; fi
    local log; log="$(mktemp)"
    "$@" >"$log" 2>&1 &
    local pid=$! i=0 start=$SECONDS code=0
    local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r\033[2K  %s%s%s %s %s· %ss%s' "$cyan" "${frames[$((i % 10))]}" "$reset" "$label" "$dim" "$((SECONDS - start))" "$reset"
      i=$((i + 1)); sleep 0.1
    done
    wait "$pid" || code=$?
    if [ "$code" -eq 0 ]; then
      printf '\r\033[2K  %s✓%s %s %s· %ss%s\n' "$green" "$reset" "$label" "$dim" "$((SECONDS - start))" "$reset"
    else
      printf '\r\033[2K  %s✗%s %s\n' "$red" "$reset" "$label"
      cat "$log" >&2
    fi
    rm -f "$log"
    return "$code"
  }
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
    die "could not download $url: check connectivity and the repository/ref, or set GITHUB_TOKEN if GitHub rate-limits the request"
  }

  # --- prerequisites -----------------------------------------------------
  command -v git >/dev/null || die "git is required"
  command -v node >/dev/null || die "Node.js 20 or newer is required (https://nodejs.org)"
  command -v curl >/dev/null || die "curl is required"
  command -v tar >/dev/null || die "tar is required"
  local nodemajor; nodemajor="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$nodemajor" -ge 20 ] || die "Node.js 20 or newer is required (found $(node -v))"
  # outside a git repository only the tool is installed; `thinker setup` sets a repository up later
  local repo; repo="$(git rev-parse --show-toplevel 2>/dev/null)" || repo=""
  [ -n "$repo" ] && cd "$repo"
  [ -n "$cache" ] && [ -z "$repo" ] && die "--cache needs a repository to put the cache in: run this from inside it"

  local thinker="$home/bin/thinker"

  if [ "$uninstall" = 1 ]; then
    [ -x "$thinker" ] || die "thinker is not installed in $home"
    if [ -z "$repo" ]; then "$thinker" uninstall --user
    elif [ "$purge" = 1 ]; then "$thinker" uninstall --purge --repo "$repo"; else "$thinker" uninstall --repo "$repo"; fi
    say "To remove the tool itself: rm -rf \"$home\", and delete the '# thinker' PATH line from your shell's startup file"
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
  say ""
  if [ "$fancy" = 1 ]; then
    local sparkle="${yellow}*${reset} ${magenta}~${reset} ${yellow}*${reset}"
    box "$cyan" "$sparkle  ${bold}${cyan}Thinker${reset}  $sparkle" "${bold}A knowledge cache for coding & review agents${reset}" \
      "${magenta}~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~${reset}" "" \
      "${dim}Learns from your merged fixes, flags the change that would undo one,${reset}" \
      "${dim}and hands your coding agents what the repository already knows.${reset}"
  else
    say "Thinker"
    say "A knowledge cache for coding & review agents"
  fi
  say ""
  if [ -n "$dist" ]; then
    case "$dist" in https://*) ;; *) die "verified distributions must be downloaded over HTTPS" ;; esac
    download_release() {
      curl -fsSL --proto-redir '=https' -o "$tmp/thinker.tgz" "$dist" &&
        curl -fsSL --proto-redir '=https' -o "$tmp/version.json" "${dist%/*}/version.json"
    }
    spin "Downloading the release" download_release || die "could not download $dist or its release manifest"
    say "  Verifying download…"
    node --input-type=module - "$tmp/thinker.tgz" "$tmp/version.json" <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
const [archive, manifest] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(manifest, 'utf8'));
if (release.schemaVersion !== 1 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(release.version || '') ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(release.commit || '') || !/^[a-f0-9]{64}$/.test(release.sha256 || '')) {
  throw new Error('invalid or unsupported release manifest');
}
const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (actual !== release.sha256) throw new Error('release checksum mismatch; refusing to extract');
JS
  else
    die "archive installs require THINKER_DIST_URL with a version.json release manifest and SHA-256 digest"
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

  say "  Installing CLI…"
  mkdir -p "$tmp/app" && tar_extract "$tmp/thinker.tgz" "$tmp/app"
  # GitHub archives wrap everything in one top-level directory
  if [ ! -f "$tmp/app/src/cli.js" ]; then
    local inner; inner="$(find "$tmp/app" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [ -n "$inner" ] && [ -f "$inner/src/cli.js" ] || die "downloaded archive does not look like thinker"
    mv "$inner" "$tmp/app.inner" && rm -rf "$tmp/app" && mv "$tmp/app.inner" "$tmp/app"
  fi
  if [ -n "$dist" ]; then
    node - "$tmp/app/package.json" "$tmp/version.json" <<'JS'
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const release = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (pkg.version !== release.version) throw new Error(`release version ${release.version} does not match archive version ${pkg.version}`);
JS
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
  local rcfile=""
  if [ "$modpath" = 1 ]; then rcfile="$(add_to_path "$home/bin")"; fi

  # whatever agents are on this machine are wired up, in their own settings
  [ -z "$clients" ] && clients="auto"
  # The dependencies are always installed: the hooks rank notes with a local cross-encoder whose runtime is one
  # of them, and the MCP server, registered for every agent, needs its SDK. Without npm the hooks still work,
  # ranking by words alone, and the MCP server is left out (thinker connect registers it once npm ci has run).
  if command -v npm >/dev/null; then
    mcp=1
    install_deps() { cd "$home/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent; }
    spin "Installing dependencies (the ranking runtime is most of it)" install_deps || die "npm ci failed in $home/app"
    spin "Fetching the ranking model" "$thinker" ranker fetch --quiet || say "  The ranking model could not be fetched (offline?); notes are ranked by words until 'thinker ranker fetch' succeeds."
  else
    say "npm was not found: the dependencies were not installed (cd \"$home/app\" && npm ci --omit=dev --ignore-scripts, then thinker ranker fetch and thinker connect). Notes are ranked by words alone until then."
    mcp=0
  fi

  if [ -z "$repo" ]; then
    # outside a repository: the agents are wired up; `thinker setup` inside a repository turns the cache on there
    local cargs="--clients $clients"
    [ "$yes" = 1 ] && cargs="$cargs --yes"
    [ "$learn" = 1 ] || cargs="$cargs --no-learn"
    [ "$late" = 1 ] && cargs="$cargs --late"
    [ "$mcp" = 1 ] || cargs="$cargs --no-mcp"
    # shellcheck disable=SC2086
    if [ ! -t 0 ] && [ -r /dev/tty ] && (exec < /dev/tty) 2>/dev/null; then "$thinker" connect $cargs < /dev/tty; else "$thinker" connect $cargs; fi
    local version; version="$(node -p "require('$home/app/package.json').version" 2>/dev/null || echo '?')"
    path_hint
    # the prompt that starts defining a repository's behaviors with the agent, ready to paste after setup there
    [ "$behaviors" = 1 ] && { "$thinker" system define || true; }
    say ""
    if [ "$fancy" = 1 ]; then
      box "$green" "${green}✓${reset} ${bold}Install complete${reset} ${dim}· Thinker v$version${reset}" "" \
        "Installed into $home and wired into your agents." \
        "This is not a git repository, so no cache was set up here." \
        "Inside a repository, run: ${cyan}thinker setup${reset}" \
        "Then paste the behaviors prompt above into your agent there." \
        "${dim}Notes and behaviors stay in the repository; Thinker uploads none.${reset}" "" \
        "${yellow}*${reset} ${magenta}~${reset} ${yellow}*${reset}  ${bold}all done · happy shipping${reset}  ${yellow}*${reset} ${magenta}~${reset} ${yellow}*${reset}"
    else
      say "Install complete: Thinker v$version, installed into $home and wired into your agents."
      say "This is not a git repository, so no cache was set up here. Inside a repository, run:"
      say ""
      say "  thinker setup"
      say ""
      say "Then paste the behaviors prompt above into your agent there."
      say "Notes and behaviors stay in the repository; Thinker uploads none."
    fi
    exit 0
  fi

  # --- the cache -------------------------------------------------------------
  if [ -n "$cache" ]; then
    case "$cache" in
      gh:*) gh_fetch "repos/$ghrepo/contents/${cache#gh:}?ref=$ref" "$tmp/cache.tgz"; "$thinker" import "$tmp/cache.tgz" --repo "$repo" ;;
      *) "$thinker" import "$cache" --repo "$repo" ;;
    esac
  elif [ "$build" != 0 ]; then
    :
  elif [ -d "$repo/.thinker/notes" ] && ls "$repo/.thinker/notes"/*.json >/dev/null 2>&1; then
    say "Using the cache already in this repository (.thinker/notes)"
  else
    say "No cache was built for this repository: it will grow from your own sessions."
    say "To build one from the code and the merged pull requests, run: thinker setup --build"
  fi

  # --- wire it into this repository -------------------------------------------
  # one command sets a repository up: `thinker setup`. Without --build or --no-build it asks
  # before building the cache, since that is the only step that spends anything.
  local args=""
  [ -n "$clients" ] && args="$args --clients $clients"
  [ "$yes" = 1 ] && args="$args --yes"
  [ "$learn" = 1 ] || args="$args --no-learn"
  [ "$late" = 1 ] && args="$args --late"
  [ "$githook" = 0 ] && args="$args --no-git-hook"
  [ "$mcp" = 1 ] || args="$args --no-mcp"
  [ "$behaviors" = 1 ] || args="$args --no-behaviors"
  if [ "$build" = 0 ]; then
    args="$args --no-build"
  else
    [ "$build" = 1 ] && args="$args --build"
    [ -n "$depth" ] && args="$args --depth $depth"
    [ -n "$prs" ] && args="$args --prs $prs"
    [ -n "$pr_target" ] && args="$args --pr $pr_target"
    [ "$benchmark" = 1 ] && args="$args --benchmark"
    [ "$benchmark" = 0 ] && args="$args --no-benchmark"
  fi
  # setup draws the closing box, so the PATH hint goes first; THINKER_INSTALLER keeps setup from
  # drawing the opening box a second time
  path_hint
  # shellcheck disable=SC2086
  if [ ! -t 0 ] && [ -r /dev/tty ] && (exec < /dev/tty) 2>/dev/null; then
    THINKER_INSTALLER=1 "$thinker" setup $args --repo "$repo" < /dev/tty
  else
    THINKER_INSTALLER=1 "$thinker" setup $args --repo "$repo"
  fi
}

main "$@"
