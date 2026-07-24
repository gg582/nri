#!/usr/bin/env bash
# deploy.sh — interactive deployment of @gg582/nri to npm.
#
# What the script does:
#   1. pre-flight checks (node/npm, clean build, test suite)
#   2. npm auth check -> interactive `npm login` if needed
#   3. optional version bump (patch/minor/major/skip)
#   4. npm publish --access public
#   5. post-publish verification (npm view)
#   6. optional git tag + push (only inside a git repo with a remote)
#
# Usage: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

PKG="@gg582/nri"
REPO="https://github.com/gg582/nri"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { local var="$1" prompt="$2" default="${3:-}"; local reply
         read -r -p "$prompt ${default:+[$default]} " reply
         printf -v "$var" '%s' "${reply:-$default}"; }

# ---------------------------------------------------------------- pre-flight
say "pre-flight checks"
command -v node >/dev/null || die "node not found (need >= 20)"
command -v npm  >/dev/null || die "npm not found"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $(node -v))"

CURRENT=$(node -p 'require("./package.json").version')
NAME=$(node -p 'require("./package.json").name')
[ "$NAME" = "$PKG" ] || die "package.json name is $NAME, expected $PKG"
say "local version: $CURRENT"

# ---------------------------------------------------------------- tests
say "build + test suite"
npm run build
npx tsx examples/smoke.ts       >/dev/null && echo "  smoke       OK"
npx tsx examples/apply-test.ts  >/dev/null && echo "  apply-test  OK"
npx tsx examples/refine-test.ts >/dev/null && echo "  refine-test OK"
npx tsx examples/store-test.ts  >/dev/null 2>&1 && echo "  store-test  OK"

# ---------------------------------------------------------------- npm auth
say "npm authentication"
if NPM_USER=$(npm whoami 2>/dev/null); then
  say "logged in as: $NPM_USER"
else
  warn "not logged in — starting interactive npm login"
  npm login || die "npm login failed"
  NPM_USER=$(npm whoami) || die "still not authenticated after npm login"
  say "logged in as: $NPM_USER"
fi

PUBLISHED=$(npm view "$PKG" version 2>/dev/null || echo "(not published)")
say "registry version: $PUBLISHED"
if [ "$PUBLISHED" = "$CURRENT" ]; then
  warn "$CURRENT is already on the registry — a version bump is required"
fi

# ---------------------------------------------------------------- version
ask BUMP "version bump? [patch/minor/major/skip]" "$([ "$PUBLISHED" = "$CURRENT" ] && echo patch || echo skip)"
case "$BUMP" in
  patch|minor|major)
    NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
    say "version -> $NEW_VERSION"
    ;;
  skip|"")
    NEW_VERSION="v$CURRENT"
    ;;
  *) die "unknown bump '$BUMP'" ;;
esac

# ---------------------------------------------------------------- publish
ask CONFIRM "publish $PKG@$CURRENT as user '$NPM_USER'? [y/N]" "N"
[ "$CONFIRM" = "y" ] || die "aborted by user"

npm publish --access public
say "published: $PKG@$CURRENT"

# ---------------------------------------------------------------- verify
sleep 3
REG_VERSION=$(npm view "$PKG" version 2>/dev/null || echo "?")
say "registry now at: $REG_VERSION"
[ "$REG_VERSION" = "$CURRENT" ] || warn "registry shows $REG_VERSION (propagation may take a minute)"

# ---------------------------------------------------------------- git (optional)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git remote get-url origin >/dev/null 2>&1; then
  ask DO_GIT "create git tag $NEW_VERSION and push to origin? [y/N]" "N"
  if [ "$DO_GIT" = "y" ]; then
    git tag -f "$NEW_VERSION"
    git push origin "$NEW_VERSION"
    git push || warn "branch push failed — tag was pushed; check your branch state"
    say "pushed tag $NEW_VERSION"
  fi
else
  warn "not a git repo (or no origin remote) — skipping git step"
  echo "    to set up: git init && git remote add origin $REPO.git"
fi

say "done: $PKG@$CURRENT is live -> https://www.npmjs.com/package/$PKG"
