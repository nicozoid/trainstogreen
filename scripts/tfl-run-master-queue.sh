#!/usr/bin/env bash
# Smart runner for the TfL master queue. Generates the priority-ordered
# queue (skipping anything already in tfl-hop-matrix.json), then iterates
# through it calling fetch-tfl-hops.mjs for each CRS.
#
# Per-station cost: 15 TfL Journey Planner calls (~2 sec). The whole
# remaining queue at any point should fit comfortably in a single
# session — TfL has no per-day or per-week quota, only a soft per-minute
# rate limit that the inner script paces itself well under.
#
# The script is resumable: each completed CRS gets persisted to
# tfl-hop-matrix.json before moving to the next, so an interrupt loses
# at most the in-flight station. Running again picks up where it left
# off (the build-queue step regenerates the list from current state).
#
# Usage:
#   ./scripts/tfl-run-master-queue.sh           # run all remaining
#   ./scripts/tfl-run-master-queue.sh 50        # run up to 50 stations
#   ./scripts/tfl-run-master-queue.sh --recompute   # re-fetch everything
#
# Status JSON written to .tfl-queue/run-status.json on completion.

set -e
cd "$(dirname "$0")/.."

QUEUE_DIR=".tfl-queue"
QUEUE_PATH="$QUEUE_DIR/master-queue.txt"
STATUS_PATH="$QUEUE_DIR/run-status.json"

# Parse arguments. Accept either a positive integer (max count) or
# --recompute (forwarded to fetch-tfl-hops.mjs).
MAX_COUNT=""
RECOMPUTE_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --recompute) RECOMPUTE_FLAG="--recompute" ;;
    [0-9]*)      MAX_COUNT="$arg" ;;
    *)           echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# Step 1: regenerate the queue. Picks up any stations that have been
# fetched (manually or by a previous run) since last build.
echo "Regenerating queue..."
node scripts/tfl-build-master-queue.mjs
echo

if [[ ! -s "$QUEUE_PATH" ]]; then
  echo "Queue is empty — every eligible London NR station has TfL hops fetched."
  cat > "$STATUS_PATH" <<EOF
{
  "exit_reason": "queue_empty",
  "exit_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "fetched": 0,
  "remaining": 0
}
EOF
  exit 0
fi

# Step 2: loop. The queue file has lines like:
#   ECR  4 hubs  131 dests  East Croydon
# We only need the CRS (first whitespace-delimited token).
fetched=0
last_crs=""
exit_reason="completed"

while IFS= read -r line; do
  crs="${line%% *}"
  [[ -z "$crs" ]] && continue
  if [[ -n "$MAX_COUNT" ]] && [[ "$fetched" -ge "$MAX_COUNT" ]]; then
    exit_reason="hit_max_count"
    break
  fi
  echo "[$((fetched + 1))] Fetching $crs..."
  if node scripts/fetch-tfl-hops.mjs --primary "$crs" $RECOMPUTE_FLAG; then
    fetched=$((fetched + 1))
    last_crs="$crs"
  else
    echo "  FAILED — moving on. Re-run to retry."
  fi
  echo
done < "$QUEUE_PATH"

# Step 3: post-run status. Recount remaining via the build script (cheap).
remaining=$(wc -l < "$QUEUE_PATH" | tr -d ' ')
remaining=$((remaining - fetched))
[[ "$remaining" -lt 0 ]] && remaining=0

cat > "$STATUS_PATH" <<EOF
{
  "exit_reason": "$exit_reason",
  "exit_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "fetched_this_run": $fetched,
  "last_crs": "$last_crs",
  "queue_remaining_estimate": $remaining
}
EOF

echo
echo "Run summary: fetched=$fetched, remaining≈$remaining ($exit_reason)"
echo "Status: $STATUS_PATH"
