#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Shows the Agents panel in the right sidebar and refreshes its data every 15 seconds.
# Run it in a cmux tab (it needs the cmux socket). It starts the refresh loop in the background, apart from the tab,
# and returns: closing the tab does not stop the loop. A second run stops the running loop and starts a fresh one,
# so the same command also repairs a loop that lost cmux. "agents-watch.sh --stop" only stops it.
# The loop's process id is kept in ~/.cache/cmux-agents/watch.pid, its error lines in ~/.cache/cmux-agents/watch.log.
here="$(cd "$(dirname "$0")" && pwd)"
cache="$HOME/.cache/cmux-agents"
pidfile="$cache/watch.pid"
log="$cache/watch.log"

if [ "${1:-}" = "--loop" ]; then
  while :; do
    # The log keeps error lines only; past 1 MB it starts again.
    [ "$(stat -f %z "$log" 2>/dev/null || echo 0)" -gt 1048576 ] && : > "$log"
    python3 "$here/label-tabs.py" || echo "agents-watch: label-tabs.py failed at $(date '+%H:%M:%S')" >&2
    sleep 15
  done
fi

(umask 077; mkdir -p "$cache")
old="$(cat "$pidfile" 2>/dev/null)"
if [[ "$old" =~ ^[0-9]+$ ]] && ps -p "$old" -o command= 2>/dev/null | grep -q 'agents-watch.sh --loop'; then
  kill "$old" && echo "agents-watch: stopped the running loop ($old)"
fi
[ "${1:-}" = "--stop" ] && { rm -f "$pidfile"; exit 0; }

cmux right-sidebar set custom agents --no-focus >/dev/null || echo "agents-watch: the panel did not open; check 'cmux sidebar validate agents'" >&2
# A new session (setsid) and no terminal: the loop does not get the hang-up signal when the tab closes.
python3 -c 'import os, sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])' "$here/agents-watch.sh" --loop \
  </dev/null >/dev/null 2>>"$log" &
echo $! > "$pidfile"
echo "agents-watch: the loop runs in the background ($!); you can close this tab. Errors: $log"
