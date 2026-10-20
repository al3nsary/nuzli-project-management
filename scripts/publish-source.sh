#!/usr/bin/env sh
# Pushes local main to GitHub main as a fast-forward.
# The history on GitHub has no .github/workflows/ (the publish token has no `workflow` scope),
# and since 2026-10-19 the local main tracks that same history, so no rewriting is needed.
# (The old filter-branch approach broke once GitHub-signed merge commits entered the history:
# rewriting drops their signatures, changes their SHAs and makes the push non-fast-forward.)
# Refuses to push when: the remote has commits we don't have, the push is not a fast-forward,
# or any commit to be pushed touches .github/workflows/.
# Usage: GH_TOKEN=... scripts/publish-source.sh [work-dir-ignored]
set -eu
: "${GH_TOKEN:?GH_TOKEN is required}"
REPO_URL="https://x-access-token:${GH_TOKEN}@github.com/al3nsary/nuzli-project-management.git"
cd "$(git rev-parse --show-toplevel)"
git fetch -q "$REPO_URL" main:refs/remotes/origin/main 2>&1 | sed "s/${GH_TOKEN}/***/g"
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "source: REFUSED — GitHub main has commits that are not in HEAD. Pull/merge them first." >&2
  exit 1
fi
if git diff --name-only origin/main HEAD | grep -q '^\.github/workflows/'; then
  echo "source: REFUSED — commits touch .github/workflows/ (token lacks the workflow scope)." >&2
  exit 1
fi
if ! git push -q "$REPO_URL" HEAD:main 2>&1 | sed "s/${GH_TOKEN}/***/g"; then
  echo "source: push FAILED" >&2
  exit 1
fi
git fetch -q "$REPO_URL" main:refs/remotes/origin/main 2>&1 | sed "s/${GH_TOKEN}/***/g"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "source: push FAILED — GitHub main is not HEAD after pushing" >&2
  exit 1
fi
echo "source: pushed $(git rev-parse --short HEAD)"
