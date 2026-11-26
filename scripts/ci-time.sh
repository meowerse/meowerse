#!/usr/bin/env bash
# Times a CI step and records it; `ci-time.sh --summary` prints the table for $GITHUB_STEP_SUMMARY.
# Usage: ci-time.sh <label> <cmd...>  (exit code of <cmd> is preserved)
marks="${RUNNER_TEMP:-/tmp}/ci-step-marks.tsv"
if [ "${1:-}" = "--summary" ]; then
  { echo "### Step timings (${GITHUB_JOB:-job})"; echo; echo "| step | seconds |"; echo "|---|---|"
    [ -f "$marks" ] && awk -F'\t' '{printf "| %s | %s |\n",$1,$2; t+=$2} END{printf "| **total (timed steps)** | **%s** |\n",t}' "$marks"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
  exit 0
fi
label="$1"; shift
start=$(date +%s); rc=0
"$@" || rc=$?
printf '%s\t%s\n' "$label" "$(( $(date +%s) - start ))" >> "$marks"
exit "$rc"
