#!/usr/bin/env bash
# Trigger astro deploy from Render Deploy Hook (Settings → Deploy Hook on astro-platform-starter).
set -euo pipefail
URL="${RENDER_DEPLOY_HOOK:-${RENDER_DEPLOY_HOOK_ASTRO:-}}"
if [[ -z "$URL" ]]; then
  echo "Set RENDER_DEPLOY_HOOK to the Deploy Hook URL from Render → astro deploy → Settings"
  exit 1
fi
curl -fsS -X POST "$URL"
echo ""
echo "Deploy triggered."
