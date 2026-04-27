#!/usr/bin/env bash
# Guards the cloud-admin-doorway secret marker.
#
# Two modes:
#   commit-msg <file>  - scan a commit message file (used by the commit-msg hook)
#   scan               - scan the working tree (excluding allowlisted files)
#
# The doorway place name must NEVER appear in commit messages, PR titles/bodies,
# or source comments. The only allowed mention is in data/stations.fat.json
# (legitimate upstream station data).

set -euo pipefail

# Patterns that reveal the doorway. Case-insensitive. Specific enough to avoid
# false positives like setInterval / interTerminal.
PATTERN='boulogne|tintel|tinterell|tinterrell'

# Files allowed to mention the patterns (legitimate data, not secret leaks).
ALLOWLIST_REGEX='^(data/stations\.fat\.json|public/stations\.json|scripts/check-secret-marker\.sh)$'

mode="${1:-scan}"

case "$mode" in
  commit-msg)
    msg_file="${2:?commit-msg mode requires a message file}"
    if grep -Eiq "$PATTERN" "$msg_file"; then
      echo "ERROR: commit message references the cloud-admin-doorway secret marker." >&2
      echo "       Use the phrase 'cloud admin doorway' or 'admin entry point' instead." >&2
      exit 1
    fi
    ;;
  scan)
    # Scan tracked files for leaks outside the allowlist.
    leaked=0
    while IFS= read -r file; do
      if [[ "$file" =~ $ALLOWLIST_REGEX ]]; then continue; fi
      if grep -Eil "$PATTERN" "$file" >/dev/null 2>&1; then
        echo "LEAK: $file"
        grep -Ein "$PATTERN" "$file" || true
        leaked=1
      fi
    done < <(git ls-files)
    if [[ $leaked -ne 0 ]]; then
      echo ""
      echo "Found references outside the allowlist. Replace with 'cloud admin doorway'." >&2
      exit 1
    fi
    echo "OK: no doorway-marker leaks in tracked files."
    ;;
  *)
    echo "Usage: $0 {commit-msg <file>|scan}" >&2
    exit 2
    ;;
esac
