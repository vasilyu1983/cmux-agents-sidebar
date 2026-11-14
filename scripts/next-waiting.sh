#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Goes to the Claude Code session that has waited for you the longest.
# With no waiting session it prints one line and changes nothing. Run it inside cmux (it needs the cmux socket).
here="$(cd "$(dirname "$0")" && pwd)"
command -v cmux >/dev/null || PATH="/Applications/cmux.app/Contents/Resources/bin:$PATH"
found="$(python3 "$here/label-tabs.py" --next-waiting)" || { echo "next-waiting: label-tabs.py failed" >&2; exit 1; }
if [ -z "$found" ]; then
  echo "No session waits for you."
  exit 0
fi
id='[0-9A-Fa-f-]{36}'
if ! [[ "$found" =~ ^($id)\ ($id)$ ]]; then
  echo "next-waiting: unexpected answer from label-tabs.py" >&2
  exit 1
fi
cmux rpc surface.focus "{\"surface_id\":\"${BASH_REMATCH[2]}\",\"workspace_id\":\"${BASH_REMATCH[1]}\"}" >/dev/null \
  || { echo "next-waiting: cmux did not focus the tab" >&2; exit 1; }
