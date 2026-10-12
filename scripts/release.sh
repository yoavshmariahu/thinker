#!/usr/bin/env bash
# Cut a release: tag vX.Y.Z and publish the GitHub release that installs and updates pull from.
#
#   scripts/release.sh            releases origin/main at the version in its package.json
#   scripts/release.sh <commit>   releases that commit (it must be on origin/main)
#
# The version is bumped first, through a pull request (npm version X.Y.Z --no-git-tag-version,
# commit package.json and package-lock.json), and merged; this script runs after the merge, so
# the commit the release records is on main. It then:
#   1. checks that the commit is on origin/main and that tag vX.Y.Z does not exist yet
#   2. builds thinker.tgz, version.json and install.sh from that commit alone, in a detached
#      worktree (scripts/pack.sh), so nothing uncommitted reaches the archive
#   3. tags the commit vX.Y.Z and pushes the tag
#   4. creates the GitHub release for the tag with the three files attached and notes generated
#      from the merged pull requests since the previous tag
#   5. waits until https://github.com/<repo>/releases/latest/download/version.json reports the
#      version, which is what the installer and `thinker update` read
#   6. publishes the npm package @zerotimedev/thinker (the installer, for npx) at the same version;
#      THINKER_NPM_PUBLISH=0 skips it, and without an npm login it prints the command instead
# Needs git, node, tar and the GitHub CLI logged in with write access to the repository; npm
# logged in as a member of the zerotimedev org for step 6.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$(pwd)"
ghrepo="${THINKER_GH_REPO:-yoavshmariahu/thinker}"
say() { printf '%s\n' "$*"; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }
command -v gh >/dev/null || die "the GitHub CLI (gh) is required"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"

git fetch -q origin main --tags
commit="$(git rev-parse --verify "${1:-origin/main}^{commit}")" || die "unknown commit ${1:-origin/main}"
git merge-base --is-ancestor "$commit" origin/main || die "$commit is not on origin/main; releases are cut from main"
version="$(git show "$commit:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "package.json at $commit has no semantic version ($version)"
tag="v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null || [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  die "$tag already exists; bump the version in package.json through a pull request first"
fi
gh release view "$tag" --repo "$ghrepo" >/dev/null 2>&1 && die "a GitHub release $tag already exists"

# build from the commit alone
build="$(mktemp -d)"
trap 'git -C "$repo" worktree remove --force "$build/src" >/dev/null 2>&1 || true; rm -rf "$build"' EXIT
git worktree add -q --detach "$build/src" "$commit"
say "Building $tag from ${commit:0:7} ..."
(cd "$build/src" && THINKER_DIST_DIR="$build/dist" THINKER_TELEMETRY=off bash scripts/pack.sh >/dev/null)
dist="$build/dist"
built="$(node -p "JSON.parse(require('fs').readFileSync('$dist/version.json', 'utf8')).version")"
[ "$built" = "$version" ] || die "version.json says $built, package.json says $version"
recorded="$(node -p "JSON.parse(require('fs').readFileSync('$dist/version.json', 'utf8')).commit")"
[ "$recorded" = "$commit" ] || die "version.json records $recorded, not $commit"
listing="$(tar -tzf "$dist/thinker.tgz")"
grep -q '\.test\.js$' <<<"$listing" && die "the archive carries tests"
grep -q '^src/server' <<<"$listing" && die "the archive carries the server"
grep -qx 'src/cli.js' <<<"$listing" || die "the archive has no src/cli.js"
say "  thinker.tgz $(du -h "$dist/thinker.tgz" | cut -f1), sha256 $(node -p "JSON.parse(require('fs').readFileSync('$dist/version.json', 'utf8')).sha256")"

# tag, push, release; the notes list the pull requests merged since the previous tag
notes=(--generate-notes)
prev="$(git describe --tags --abbrev=0 --match 'v*' "$commit^" 2>/dev/null || true)"
if [ -n "$prev" ]; then notes+=(--notes-start-tag "$prev"); else notes=(--notes "thinker $version, the first release tagged on GitHub."); fi
git tag -a "$tag" "$commit" -m "thinker $version"
git push -q origin "refs/tags/$tag"
say "Tagged $tag at ${commit:0:7} and pushed the tag"
gh release create "$tag" --repo "$ghrepo" --verify-tag --title "thinker $version" "${notes[@]}" \
  "$dist/thinker.tgz#thinker.tgz" "$dist/version.json#version.json" "$dist/install.sh#install.sh" >/dev/null
say "Created the GitHub release https://github.com/$ghrepo/releases/tag/$tag"

# what installs and updates will see
latest="https://github.com/$ghrepo/releases/latest/download/version.json"
for _ in $(seq 1 30); do
  live="$(curl -fsSL "$latest" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version' 2>/dev/null || true)"
  [ "$live" = "$version" ] && break
  sleep 2
done
[ "$live" = "$version" ] || die "$latest still reports ${live:-nothing}; the release is published, check it on GitHub"
say "The latest release reports $version; installs and 'thinker update' now pull it"

# the npm package carries the installer only, so it goes out last: by now the release it installs is live
npmpkg="$(node -p "JSON.parse(require('fs').readFileSync('$dist/npm/package.json', 'utf8')).name")"
if [ "${THINKER_NPM_PUBLISH:-1}" = 0 ]; then
  say "Skipped the npm package (THINKER_NPM_PUBLISH=0)"
elif ! command -v npm >/dev/null || ! npm whoami >/dev/null 2>&1; then
  say "npm is not logged in: $npmpkg@$version was not published. Log in (npm login), check out $tag and run:"
  say "  d=\$(mktemp -d) && THINKER_DIST_DIR=\$d bash scripts/pack.sh && npm publish \$d/npm --access public"
else
  npm publish "$dist/npm" --access public >/dev/null || die "npm publish failed; the GitHub release is out, publish $npmpkg@$version by hand"
  say "Published $npmpkg@$version: npx $npmpkg"
fi
