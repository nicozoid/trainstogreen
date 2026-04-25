#!/bin/bash
# Keep the Mac awake while the RTT fetch queue runs.
#
# macOS will idle-sleep the machine after a few minutes of inactivity by
# default — which kills any in-flight RTT fetch, mid-junction. This
# helper finds the orchestrator process at /tmp/ttg-rtt/queue.sh and
# tracks it under `caffeinate`, so the machine stays awake (and the
# display stays lit) until the queue exits naturally.
#
# Usage (run from anywhere; the script doesn't depend on cwd):
#   ./scripts/caffeinate-queue.sh
#
# Run it in a separate terminal tab and forget about it. When the queue
# finishes (or you kill it), `caffeinate` exits automatically and
# normal sleep behaviour resumes.
#
# Flags passed to caffeinate:
#   -d  prevent display sleep (so you can glance at the queue panel)
#   -i  prevent idle sleep
#   -s  prevent system sleep on AC power
#   -w  wait for the given PID to exit before releasing

set -eu

PID=$(pgrep -f "/tmp/ttg-rtt/queue.sh" | head -1 || true)
if [ -z "$PID" ]; then
  echo "No /tmp/ttg-rtt/queue.sh process running — nothing to caffeinate." >&2
  exit 1
fi

echo "Caffeinating PID $PID until queue.sh exits. Ctrl-C to release early."
caffeinate -dis -w "$PID"
echo "Queue exited; caffeinate released."
