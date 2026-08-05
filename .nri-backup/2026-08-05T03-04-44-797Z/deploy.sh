#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing NRI system to local environment..."

# Ensure build dependencies and compile
if [ -f "package-lock.json" ]; then
  npm ci
else
  npm install
fi

echo "==> Building NRI system..."
npm run build

echo "==> Linking NRI binary locally..."
npm link --force || npm install -g .

echo "==> NRI system successfully installed on local environment!"
echo "==> Test with: nri --help"
