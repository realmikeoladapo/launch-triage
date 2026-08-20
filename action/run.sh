#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

LT_PATH="${LT_PATH:-.}"
LT_FAIL_ON="${LT_FAIL_ON:-critical}"
LT_AUDIT="${LT_AUDIT:-false}"
LT_ANNOTATE="${LT_ANNOTATE:-true}"
LT_PACKAGE_SPEC="${LT_PACKAGE_SPEC:-launch-triage@1.1.0}"

case "$LT_AUDIT" in
  true|false) ;;
  *) echo "audit must be true or false" >&2; exit 2 ;;
esac

case "$LT_ANNOTATE" in
  true|false) ;;
  *) echo "annotate must be true or false" >&2; exit 2 ;;
esac

args=(
  "$LT_PATH"
  --fail-on "$LT_FAIL_ON"
  --out "${RUNNER_TEMP}/launch-triage.md"
)

if [ "$LT_AUDIT" = "true" ]; then args+=(--audit); fi
if [ "$LT_ANNOTATE" = "true" ]; then
  args+=(--annotate)
else
  args+=(--no-annotate)
fi

npm exec --yes --package "$LT_PACKAGE_SPEC" -- launch-triage "${args[@]}"
