#!/usr/bin/env bash
# thinker install: installs the thinker tool and wires it into the coding agents on
# this machine (their own settings: hooks and the MCP server, once). Thinker then
# runs in every git repository on this machine: a cache starts with the first
# session in a repository and grows from the sessions there. Nothing is asked in
# the terminal.
#
# Thinker is open source; no access code or GitHub token is required. It installs the latest
# GitHub release (https://github.com/yoavshmariahu/thinker/releases: a tag vX.Y.Z carrying
# thinker.tgz, version.json and install.sh), verified against the sha256 in version.json.
#
#   npx @zerotimedev/thinker
#
# The npm package of that name carries this file and runs it with the arguments passed through.
#
# Options
#   --build, --no-build, --depth <d>, --prs <n>, --pr <n>, --benchmark, --no-benchmark
#                       accepted from old scripts and ignored: there is no cache build (2026-10-21)
#   --no-seed, --areas <n>, --no-behaviors   accepted from old scripts and ignored
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
#   --no-ui             do not offer the browser for the Context report; it is shown in the terminal, with its suggestions to pick from
#   --ref <tag>         release to install, a tag such as v0.1.34 (default latest; --branch also accepted)
#   --update            update an installed thinker to the latest release and exit
#   --auto-update       explicitly schedule background auto-updates (every 4 hours)
#   --no-modify-path    do not add THINKER_HOME/bin to PATH in your shell's and bash's startup files
#   --uninstall         remove hooks and registration from this repo (add --purge to delete notes too); run outside
#                       a repository, it removes the wiring from your agents' own settings
#
# Environment
#   THINKER_HOME        where the tool is installed (default ~/.thinker)
#   THINKER_GH_REPO     GitHub repository whose releases to install from (default yoavshmariahu/thinker)
#   THINKER_REF         release tag (default latest)
#   THINKER_DIST_URL    install from this tarball URL (with version.json beside it) instead of a GitHub release
#   GITHUB_TOKEN        only for --cache gh:<path>: a token for the GitHub API (GH_TOKEN works too;
#                       if neither is set and the GitHub CLI is logged in, its token is used)
#
# The script writes to THINKER_HOME, to .thinker/ and the agents' config in this repository, and adds one
# line putting THINKER_HOME/bin on PATH to your shell's startup file and bash's (--no-modify-path leaves them alone). No sudo.
set -euo pipefail
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

# add_to_path <dir>: put <dir> on PATH in the startup file of the user's shell, and in bash's, where agents
# may run their commands whatever the login shell is (src/shell-path.js keeps the same list), once each.
# Prints the login shell's file, or nothing when it could not tell which one.
add_to_path() {
  local dir="$1" line="export PATH=\"$1:\$PATH\"" rc="" f login
  case "$(basename "${SHELL:-}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    fish) rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/thinker.fish"
      if ! grep -qsF "fish_add_path \"$dir\"" "$rc"; then mkdir -p "$(dirname "$rc")" && printf '\n# thinker\n%s\n' "fish_add_path \"$dir\"" >> "$rc" || rc=""; fi ;;
  esac
  # bash: .bashrc, and the login file a login bash reads, the first that exists (creating .bash_profile would
  # hide a .profile; made only on macOS). A Linux .bashrc returns early when not interactive, so the end of it
  # is not enough for `bash -l`.
  local files="$HOME/.bashrc"
  login=""
  for f in .bash_profile .bash_login .profile; do if [ -e "$HOME/$f" ]; then login="$HOME/$f"; break; fi; done
  [ -z "$login" ] && [ "$(uname)" = Darwin ] && login="$HOME/.bash_profile"
  [ -n "$login" ] && files="$login $files"
  [ "$(basename "${SHELL:-}")" = bash ] && rc="${files%% *}"
  [ "$(basename "${SHELL:-}")" = zsh ] && files="$rc $files"
  for f in $files; do
    if ! grep -qsF "$line" "$f"; then
      mkdir -p "$(dirname "$f")" && printf '\n# thinker\n%s\n' "$line" >> "$f" || true
    fi
  done
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
  local cache="" areas="" clients="" learn=1 late=0 mcp=0 githook=0 uninstall=0 purge=0 update=0 autoupdate=0 modpath=1 ref="${THINKER_REF:-latest}" yes=0 no_seed=0 ui=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --cache) cache="${2:-}"; shift 2 ;;
      --build|--no-build) shift ;;
      --no-seed) shift ;;
      --no-behaviors) shift ;;
      -y|--yes) yes=1; shift ;;
      --areas) shift 2 ;;
      --depth|--prs|--pr) shift 2 ;;
      --benchmark|--no-benchmark) shift ;;
      --clients) clients="${2:-}"; shift 2 ;;
      --branch|--ref) ref="${2:-}"; shift 2 ;;
      --learn) learn=1; shift ;;
      --no-learn) learn=0; shift ;;
      --late) late=1; shift ;;
      --shared) echo "Team sharing is no longer supported." >&2; return 1 ;;
      --mcp) mcp=1; shift ;;
      --git-hook) githook=1; shift ;;
      --no-git-hook) githook=0; shift ;;
      --no-ui) ui=0; shift ;;
      --update) update=1; shift ;;
      --auto-update) autoupdate=1; shift ;;
      --no-auto-update) autoupdate=0; shift ;;
      --no-modify-path) modpath=0; shift ;;
      --uninstall) uninstall=1; shift ;;
      --purge) purge=1; shift ;;
      -h|--help) echo "see the header of install.sh or ONBOARDING.md for options"; exit 0 ;;
      *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
  done

  local home="${THINKER_HOME:-$HOME/.thinker}"
  local ghrepo="${THINKER_GH_REPO:-yoavshmariahu/thinker}"
  local ref="${ref:-${THINKER_REF:-latest}}"
  local dist="${THINKER_DIST_URL:-}"
  # the GitHub release for the ref: the latest one, or the tag named
  if [ -z "$dist" ]; then
    case "$ref" in
      latest|main) dist="https://github.com/$ghrepo/releases/latest/download/thinker.tgz" ;;
      *) dist="https://github.com/$ghrepo/releases/download/$ref/thinker.tgz" ;;
    esac
  fi
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  say() { printf '%s\n' "$*"; }
  die() { printf 'thinker: %s\n' "$*" >&2; exit 1; }
  # --- look: colors, boxes and spinners on a terminal, plain lines anywhere else --------------
  local fancy=0 bold="" dim="" cyan="" green="" yellow="" red="" magenta="" reset=""
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ] && [ -z "${CI:-}" ]; then
    fancy=1 bold=$'\033[1m' dim=$'\033[2m' cyan=$'\033[36m' green=$'\033[32m' yellow=$'\033[33m' red=$'\033[31m' magenta=$'\033[35m' reset=$'\033[0m'
  fi
  # box <color> <line>...: a rounded box 74 columns wide, as setup draws it; a line may carry color codes, padded on its plain text
  # box <color> <line>...: the lines in a rounded frame, at least 68 columns wide and as wide as the
  # longest line (a path can run past 68, and a frame narrower than its text comes out ragged)
  box() {
    local color="$1"; shift
    local width=68 line plain
    for line in "$@"; do
      plain="$(printf '%s' "$line" | sed $'s/\033\\[[0-9;]*m//g')"
      [ "${#plain}" -gt "$width" ] && width=${#plain}
    done
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
    if [ "$fancy" != 1 ]; then say "  ${label}…"; "$@"; return; fi
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
    local uargs=(uninstall)
    if [ -z "$repo" ]; then uargs+=(--user)
    else [ "$purge" = 1 ] && uargs+=(--purge); uargs+=(--repo "$repo"); fi
    [ "$yes" = 1 ] && uargs+=(--yes)
    # the terminal, not the piped script, answers the optional question why
    if [ "$yes" != 1 ] && [ -r /dev/tty ] && (exec < /dev/tty) 2>/dev/null; then "$thinker" "${uargs[@]}" < /dev/tty
    else "$thinker" "${uargs[@]}"; fi
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
    # the same headline and lines as `thinker setup` (src/setup/ui.js:HEADLINE, TAGLINE)
    box "$cyan" "$sparkle  ${bold}${cyan}Thinker${reset}  $sparkle" "${bold}Think ahead. Save tokens.${reset}" \
      "${magenta}~~~~~~~~~~~~~~~~~~~~~~~~~~~${reset}" "" \
      "${dim}Thinker helps you save tokens with context compression, knowledge caching,${reset}" \
      "${dim}and leaner agent instructions, skills and MCP servers.${reset}"
  else
    say "Thinker"
    say "Think ahead. Save tokens."
    say "Thinker helps you save tokens with context compression, knowledge caching, and leaner agent instructions, skills and MCP servers."
  fi
  say ""
  case "$dist" in https://*) ;; *) die "releases must be downloaded over HTTPS" ;; esac
  # GitHub answers with a redirect to its asset host; curl follows it over HTTPS only
  download_release() {
    curl -fsSL --proto-redir '=https' -o "$tmp/thinker.tgz" "$dist" &&
      curl -fsSL --proto-redir '=https' -o "$tmp/version.json" "${dist%/*}/version.json"
  }
  spin "Downloading the release" download_release || die "could not download $dist or its version.json (is there a release for $ref at https://github.com/$ghrepo/releases?)"
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
  node --input-type=module - "$tmp/app/package.json" "$tmp/version.json" <<'JS'
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const release = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (pkg.version !== release.version) throw new Error(`release version ${release.version} does not match archive version ${pkg.version}`);
JS
  # --update: the downloaded copy's updater installs itself, so an older install (one that still
  # downloads from the old host, say) moves to the releases. The home and its settings are kept.
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
    # the cd lives in a subshell: `spin` runs its command in this shell when there is no terminal (the piped
    # install), so a bare cd left the installer sitting in $home/app -- a directory this script replaces and an
    # update deletes, and every command after it then died on a working directory that was gone (2026-10-28)
    install_deps() { ( cd "$home/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent ); }
    spin "Installing dependencies (the ranking runtime is most of it)" install_deps || die "npm ci failed in $home/app"
    spin "Fetching the ranking model" "$thinker" ranker fetch --quiet || say "  The ranking model could not be fetched (offline?); notes are ranked by words until 'thinker ranker fetch' succeeds."
  else
    say "npm was not found: the dependencies were not installed (cd \"$home/app\" && npm ci --omit=dev --ignore-scripts, then thinker ranker fetch and thinker connect). Notes are ranked by words alone until then."
    mcp=0
  fi

  # --- wire the agents, once, in their own settings ---------------------------
  # Nothing is asked here: Codex's hook-review marks are written outright. Thinker then runs in every
  # git repository on this machine.
  local cargs="--clients $clients --yes"
  [ "$learn" = 1 ] || cargs="$cargs --no-learn"
  [ "$late" = 1 ] && cargs="$cargs --late"
  [ "$mcp" = 1 ] || cargs="$cargs --no-mcp"
  # shellcheck disable=SC2086
  "$thinker" connect $cargs

  # --- where the agents' context goes, from the sessions already on this machine ----------------------------
  # Nothing to build and no cache needed: the Context report reads the agents' own transcripts of the last 30
  # days, so it is there now, from the sessions that ran before thinker was installed. The most active
  # repositories are read (each report kept for the page) and the person is asked where to see what to cut
  # first: in the browser (the page over every repository) or here, where the suggestions are a list to pick
  # from and apply at once, with the page's address for the detail (setup/context-ask.js). The terminal, not
  # the piped script, answers; with --yes or no terminal the report is printed. `thinker context --machine
  # [--ask]` does the same any time.
  say ""
  local xargs=(context --machine --ask)
  [ "$ui" = 1 ] || xargs+=(--no-browser)
  if [ "$yes" != 1 ] && [ -r /dev/tty ] && (exec < /dev/tty) 2>/dev/null; then
    "$thinker" "${xargs[@]}" < /dev/tty || say "  The Context report could not be made now; thinker context --machine prints it, thinker ui shows it."
  else
    "$thinker" context --machine || say "  The Context report could not be made now; thinker context --machine prints it, thinker ui shows it."
  fi

  # --- a cache handed over -------------------------------------------------------
  if [ -n "$cache" ]; then
    case "$cache" in
      gh:*) gh_fetch "repos/$ghrepo/contents/${cache#gh:}?ref=$ref" "$tmp/cache.tgz"; "$thinker" import "$tmp/cache.tgz" --repo "$repo" ;;
      *) "$thinker" import "$cache" --repo "$repo" ;;
    esac
  fi

  # --- done -------------------------------------------------------------------------
  # Every git repository has a cache from here on, and it grows from the sessions there.
  local version; version="$(node -p "require('$home/app/package.json').version" 2>/dev/null || echo '?')"
  path_hint
  say ""
  if [ "$fancy" = 1 ]; then
    box "$green" "${green}✓${reset} ${bold}Install complete${reset} ${dim}· Thinker v$version${reset}" "" \
      "Installed into ${home/#$HOME/~} and wired into your agents." \
      "Thinker now runs in every git repository on this machine." \
      "Where your agents' context goes, any time: ${cyan}thinker ui${reset}." \
      "${dim}Notes stay on this machine; Thinker uploads none.${reset}" "" \
      "${yellow}*${reset} ${magenta}~${reset} ${yellow}*${reset}  ${bold}all done · happy shipping${reset}  ${yellow}*${reset} ${magenta}~${reset} ${yellow}*${reset}"
  else
    say "Install complete: Thinker v$version, installed into $home and wired into your agents."
    say "Thinker now runs in every git repository on this machine."
    say "Where your agents' context goes, any time: thinker ui."
    say "Notes stay on this machine; Thinker uploads none."
  fi
}

main "$@"
