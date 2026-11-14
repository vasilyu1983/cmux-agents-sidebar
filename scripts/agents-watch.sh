#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Shows the Agents panel in the right sidebar and refreshes its data every 15 seconds.
# Run it in a cmux tab (it needs the cmux socket) and leave the tab open. Ctrl+C stops it.
here="$(cd "$(dirname "$0")" && pwd)"
cmux right-sidebar set custom agents --no-focus >/dev/null || echo "agents-watch: the panel did not open; check 'cmux sidebar validate agents'" >&2
while :; do
  python3 "$here/label-tabs.py" || echo "agents-watch: label-tabs.py failed at $(date '+%H:%M:%S')" >&2
  sleep 15
done
