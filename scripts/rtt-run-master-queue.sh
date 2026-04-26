#!/bin/bash
# Smart RTT runner — reads /tmp/ttg-rtt/master-queue.txt, skips already-
# fetched CRSes (additive merge against origin-routes.json), pre-checks
# the weekly rate-limit before each station, and exits cleanly when the
# cap is near. Writes /tmp/ttg-rtt/run-status.json on exit so the next
# session can decide when to resume.
#
# Usage:
#   RTT_TOKEN=… caffeinate -i /tmp/ttg-rtt/run-master-queue.sh
#
# Re-running is safe and resumable — the master queue is just a prio-
# ordered list, and origin-routes.json's additive merge means already-
# done stations get skipped automatically.

set -u

# Resolve repo root from the script's own location so this runs in any
# clone / worktree without hardcoded paths.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
FETCH_SCRIPT="$REPO/scripts/fetch-direct-reachable.mjs"
BUILD_SCRIPT="$REPO/scripts/rtt-build-master-queue.mjs"
QUEUE="$REPO/.rtt-queue/master-queue.txt"
LOG="$REPO/.rtt-queue/master-queue.log"
STATUS="$REPO/.rtt-queue/run-status.json"
DATES=2026-05-09,2026-07-25
THROTTLE=4800

# Cap-check threshold: stop when remaining-week is BELOW this. ~300 calls
# per station, so ~400 of headroom guarantees the next station finishes
# without crossing the cap mid-fetch.
CAP_THRESHOLD=400

if [ -z "${RTT_TOKEN:-}" ]; then
  echo "Error: RTT_TOKEN not set." >&2
  exit 1
fi

# Always (re)build the master queue first — uses origin-routes.json as
# the source of truth for "already done", so the rebuilt list reflects
# anything fetched since the last run (including by other scripts).
mkdir -p "$REPO/.rtt-queue"
echo "Rebuilding master queue from current origin-routes.json..."
node "$BUILD_SCRIPT" || { echo "Build failed"; exit 1; }

if [ ! -f "$QUEUE" ]; then
  echo "Error: $QUEUE missing after build. Aborting." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Reads x-ratelimit-remaining-week from a single API call. Costs 1 cap
# credit per check. We probe the search endpoint for an arbitrary CRS
# (CLJ); response is small, headers are what we care about.
get_remaining_week() {
  local token
  token=$(curl -s -H "Authorization: Bearer $RTT_TOKEN" \
    "https://data.rtt.io/api/get_access_token" | jq -r .token 2>/dev/null)
  if [ -z "$token" ] || [ "$token" = "null" ]; then
    echo "-1"
    return
  fi
  curl -s -D - -o /dev/null -H "Authorization: Bearer $token" \
    "https://data.rtt.io/api/v1/json/search/CLJ" 2>/dev/null \
    | grep -i "x-ratelimit-remaining-week" \
    | awk -F': ' '{print $2}' | tr -d '\r' | tr -d '\n'
}

# Build the set of already-done CRSes from origin-routes.json. Cheap node
# call — runs once at start (and refreshes after each station).
already_done() {
  node -e "
    const data = require('$REPO/data/origin-routes.json');
    console.log(Array.from(new Set(Object.values(data).map(o => o.crs))).join('\n'));
  "
}

# Recommended next-run timestamp when we exit because of the cap.
# Rolling 7-day cap (per saved memory: ~54h recovery), so safest
# recommendation is +7 days from now. ROUNDED UP to the next whole
# hour so the user gets a clean "earliest at HH:00" rather than a
# fiddly minute-level time. macOS BSD date order: +7d, then +1H, then
# zero out minutes & seconds → effectively ceil-to-hour after the
# 7-day shift.
recommend_next_run() {
  date -v +7d -v +1H -v 0M -v 0S -u +"%Y-%m-%dT%H:%M:%SZ"
}

write_status() {
  local last_crs="$1"
  local remaining="$2"
  local reason="$3"
  local stations_done_count="$4"
  local next_run_iso next_run_human
  next_run_iso=$(recommend_next_run)
  # Human-readable BST/GMT (auto-DST). Two-step conversion via epoch is
  # required: BSD `date -f` parses the Z-suffixed string as LOCAL time
  # otherwise, which would mis-format a UTC stamp by 1 hour during BST.
  local epoch
  epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$next_run_iso" "+%s" 2>/dev/null)
  if [ -n "$epoch" ]; then
    next_run_human=$(TZ=Europe/London date -r "$epoch" "+%a %d %b %Y, %H:00 %Z")
  else
    next_run_human="+7 days from $(date)"
  fi
  cat > "$STATUS" <<JSON
{
  "ended_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "last_crs_attempted": "$last_crs",
  "remaining_week_at_exit": $remaining,
  "exit_reason": "$reason",
  "stations_completed_this_run": $stations_done_count,
  "recommended_earliest_next_run": "$next_run_iso",
  "recommended_next_run_human": "$next_run_human",
  "queue_file": "$QUEUE",
  "log_file": "$LOG"
}
JSON
  # Big bold readable banner so it stands out at the bottom of a long
  # log file when the user comes back later. Hour-precision earliest-
  # restart time on its own line for easy copy/paste.
  echo "" | tee -a "$LOG"
  echo "=================================================================" | tee -a "$LOG"
  echo "  Run ended: $reason" | tee -a "$LOG"
  echo "  Stations completed this run: $stations_done_count" | tee -a "$LOG"
  echo "  Last CRS attempted: ${last_crs:-(none)}" | tee -a "$LOG"
  echo "  Weekly cap remaining at exit: $remaining" | tee -a "$LOG"
  echo "" | tee -a "$LOG"
  echo "  EARLIEST RESTART: $next_run_human" | tee -a "$LOG"
  echo "" | tee -a "$LOG"
  echo "  (Open a fresh Claude session at that time and ask:" | tee -a "$LOG"
  echo "   \"run next RTT batch\" — Claude will pick up from here.)" | tee -a "$LOG"
  echo "=================================================================" | tee -a "$LOG"
  echo "" | tee -a "$LOG"
  echo "Status file: $STATUS" | tee -a "$LOG"
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

echo "=== Smart runner start at $(date '+%Y-%m-%d %H:%M:%S') ===" | tee -a "$LOG"

# One-time done set (refreshed after each station).
DONE_LIST=$(already_done)

# Pre-flight cap check.
INITIAL_REMAINING=$(get_remaining_week)
echo "Initial weekly remaining: $INITIAL_REMAINING" | tee -a "$LOG"
if [ "$INITIAL_REMAINING" = "-1" ]; then
  echo "Couldn't read rate-limit headers — token may be invalid. Aborting." | tee -a "$LOG"
  write_status "" "-1" "auth_error" "0"
  exit 1
fi
if [ "$INITIAL_REMAINING" -lt "$CAP_THRESHOLD" ]; then
  echo "Already below cap threshold ($INITIAL_REMAINING < $CAP_THRESHOLD). Nothing to do this session." | tee -a "$LOG"
  write_status "" "$INITIAL_REMAINING" "below_threshold_at_start" "0"
  exit 0
fi

STATIONS_DONE_THIS_RUN=0
LAST_CRS=""

while IFS= read -r line; do
  # Skip comments + blanks
  case "$line" in
    "" | "#"*) continue ;;
  esac

  # Strip trailing comment (CRS  # Station Name → CRS)
  CRS=$(echo "$line" | awk '{print $1}')
  if [ -z "$CRS" ]; then continue; fi

  # Skip if already done.
  if echo "$DONE_LIST" | grep -qx "$CRS"; then
    continue
  fi

  # Cap check before fetching.
  REMAINING=$(get_remaining_week)
  if [ "$REMAINING" = "-1" ]; then
    echo "Auth/network error mid-run. Stopping." | tee -a "$LOG"
    write_status "$CRS" "-1" "auth_error_mid_run" "$STATIONS_DONE_THIS_RUN"
    exit 1
  fi
  if [ "$REMAINING" -lt "$CAP_THRESHOLD" ]; then
    echo "" | tee -a "$LOG"
    echo "=== Cap threshold hit ($REMAINING < $CAP_THRESHOLD). Stopping after $STATIONS_DONE_THIS_RUN stations. ===" | tee -a "$LOG"
    write_status "$CRS" "$REMAINING" "cap_threshold" "$STATIONS_DONE_THIS_RUN"
    exit 0
  fi

  # Fetch this station with retries.
  echo "=== $CRS at $(date '+%Y-%m-%d %H:%M:%S') (remaining-week: $REMAINING) ===" | tee -a "$LOG"
  LAST_CRS="$CRS"
  ok=0
  for attempt in 1 2 3; do
    if RTT_TOKEN="$RTT_TOKEN" node "$FETCH_SCRIPT" "$CRS" --dates="$DATES" --throttle="$THROTTLE" 2>&1 | tee -a "$LOG"; then
      ok=1
      break
    fi
    echo "  attempt $attempt failed for $CRS — sleeping 60s" | tee -a "$LOG"
    sleep 60
  done
  if [ "$ok" -eq 0 ]; then
    echo "  GIVING UP on $CRS after 3 attempts — moving on" | tee -a "$LOG"
  else
    STATIONS_DONE_THIS_RUN=$((STATIONS_DONE_THIS_RUN + 1))
  fi

  # Refresh the done set so the next loop catches the just-fetched CRS.
  DONE_LIST=$(already_done)
done < "$QUEUE"

echo "" | tee -a "$LOG"
echo "=== Master queue complete (or no remaining stations) at $(date '+%Y-%m-%d %H:%M:%S') ===" | tee -a "$LOG"
FINAL_REMAINING=$(get_remaining_week)
write_status "$LAST_CRS" "$FINAL_REMAINING" "queue_complete" "$STATIONS_DONE_THIS_RUN"
