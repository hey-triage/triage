#!/usr/bin/env bash
#
# clear-port.sh — free up TCP ports by killing whatever is listening on them.
#
# Usage:
#   ./clear-port.sh            # clears the default ports (5188 5189)
#   ./clear-port.sh 3000 8080  # clears the ports you pass instead
#
set -euo pipefail

# Default ports to clear when none are given as arguments.
DEFAULT_PORTS=(5188 5189)

# Use passed-in ports if any, otherwise fall back to the defaults.
if [ "$#" -gt 0 ]; then
  PORTS=("$@")
else
  PORTS=("${DEFAULT_PORTS[@]}")
fi

for port in "${PORTS[@]}"; do
  # -t: terse (PIDs only), -i: match the port. May match >1 PID.
  pids=$(lsof -ti "tcp:${port}" 2>/dev/null || true)

  if [ -z "$pids" ]; then
    echo "Port ${port}: already free."
    continue
  fi

  echo "Port ${port}: in use by PID(s): ${pids//$'\n'/ } — sending SIGTERM..."
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true

  # Give processes a moment to exit cleanly before force-killing stragglers.
  sleep 1
  remaining=$(lsof -ti "tcp:${port}" 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    echo "Port ${port}: still held by ${remaining//$'\n'/ } — sending SIGKILL..."
    # shellcheck disable=SC2086
    kill -9 $remaining 2>/dev/null || true
  fi

  echo "Port ${port}: cleared."
done
