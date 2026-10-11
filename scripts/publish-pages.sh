#!/usr/bin/env sh
# Builds the demo (VITE_DEMO=1) from a clean worktree of HEAD and pushes it to the gh-pages branch.
# Usage: GH_TOKEN=... scripts/publish-pages.sh <work-dir>
# The token is passed on the push URL only and never written to any git config.
set -eu
: "${GH_TOKEN:?GH_TOKEN is required}"
REPO_URL="https://x-access-token:${GH_TOKEN}@github.com/al3nsary/nuzli-project-management.git"
ROOT=$(git rev-parse --show-toplevel)
WORK=${1:?work dir required}
WT="$ROOT/.publish"   # inside the repo so node resolves the root node_modules
rm -rf "$WT"; git -C "$ROOT" worktree prune
git -C "$ROOT" worktree add -q --detach "$WT" HEAD
trap 'git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
( cd "$WT/packages/shared" && npx tsup src/index.ts --format esm,cjs --dts --clean >/dev/null )
( cd "$WT/packages/ui-print" && npx tsup src/index.ts --format esm,cjs --dts --clean --external react >/dev/null )
( cd "$WT/packages/scheduling" && npx tsup src/index.ts --format esm,cjs --dts --clean >/dev/null )
( cd "$WT/apps/web" && npx vite build --mode demo --logLevel warn )
OUT="$WORK/gh-pages"; rm -rf "$OUT"; mkdir -p "$OUT"
cp -r "$WT/apps/web/dist/." "$OUT/"
cp "$OUT/index.html" "$OUT/404.html"; touch "$OUT/.nojekyll"
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
cd "$OUT" && git init -q -b gh-pages && git add -A
git -c user.name=al3nsary -c user.email=9y5w8h5wqh@privaterelay.appleid.com commit -q -m "deploy: demo build of ${SHA}"
git push -q -f "$REPO_URL" gh-pages 2>&1 | sed "s/${GH_TOKEN}/***/g"
echo "pages: pushed demo build of ${SHA}"
