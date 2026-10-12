#!/bin/sh
# Remove everything after a benchmark base from a clone, so an agent in a worktree of it cannot
# reach the merged fixes (the Grafana leak: hidden refs, reflog and remote-tracking branches all
# led there). Later objects are saved to a bundle first so the clone can be rebuilt.
#
#   sh bench/scrub-repo.sh <clone dir> <base sha> <bundle path>
set -eu
REPO=$1; BASE=$2; BUNDLE=$3
cd "$REPO"
git worktree prune
if [ -n "$(git worktree list | tail -n +2)" ]; then echo "remove the clone's worktrees first:"; git worktree list; exit 1; fi
git rev-parse --verify "$BASE^{commit}" >/dev/null
# save what will be dropped: every ref, as a bundle
git bundle create "$BUNDLE" --all >/dev/null 2>&1 || true
git checkout -q --detach "$BASE"
for r in $(git for-each-ref --format='%(refname)' refs/heads refs/tags refs/remotes refs/notes 2>/dev/null); do git update-ref -d "$r"; done
git remote remove origin 2>/dev/null || true
git branch -q base "$BASE"
git checkout -q base
git reflog expire --expire=now --all
git gc -q --prune=now --aggressive
rm -f .git/FETCH_HEAD .git/ORIG_HEAD
echo "scrubbed to $(git rev-parse --short HEAD); remaining refs:"; git for-each-ref
if git rev-list --all | wc -l | grep -qv '^ *0$'; then :; fi
