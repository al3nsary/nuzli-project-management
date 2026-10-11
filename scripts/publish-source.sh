#!/usr/bin/env sh
# Pushes main to GitHub without the .github/workflows/ history (the publish token has no
# `workflow` scope). filter-branch keeps author/committer dates, so the rewritten history is
# deterministic and every run fast-forwards the remote.
# Usage: GH_TOKEN=... scripts/publish-source.sh <work-dir>
set -eu
: "${GH_TOKEN:?GH_TOKEN is required}"
REPO_URL="https://x-access-token:${GH_TOKEN}@github.com/al3nsary/nuzli-project-management.git"
ROOT=$(git rev-parse --show-toplevel)
WORK=${1:?work dir required}
SRC="$WORK/source-mirror"; rm -rf "$SRC"
git clone -q --no-local --branch main "$ROOT" "$SRC"
cd "$SRC"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter 'git rm -r -q --cached --ignore-unmatch .github/workflows' -- main >/dev/null
git push -q "$REPO_URL" main 2>&1 | sed "s/${GH_TOKEN}/***/g"
echo "source: pushed $(git rev-parse --short main)"
