#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs the Agents panel for cmux from this folder. Run it in Terminal: bash install.sh
# An existing file that differs is copied to <name>.<date>.bak before it is replaced.
# Pass --no-statusline to skip the Claude Code status line and its settings entry.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
stamp=$(date +%Y%m%d-%H%M%S)
statusline=yes
[ "${1:-}" = "--no-statusline" ] && statusline=no

for tool in cmux jq python3; do
  command -v "$tool" >/dev/null || { echo "install: '$tool' is not installed; see README.md, \"Before you install\"" >&2; exit 1; }
done

put() {  # put <source> <target>
  mkdir -p "$(dirname "$2")"
  if [ -e "$2" ] && ! cmp -s "$1" "$2"; then
    cp "$2" "$2.$stamp.bak"
    echo "backup: $2.$stamp.bak"
  fi
  cp "$1" "$2"
  echo "installed: $2"
}

put "$here/sidebars/agents.js" "$HOME/.config/cmux/sidebars/agents.js"
for f in label-tabs.py hive.html agents-watch.sh; do
  put "$here/scripts/$f" "$HOME/.config/cmux/scripts/$f"
done
chmod +x "$HOME/.config/cmux/scripts/label-tabs.py" "$HOME/.config/cmux/scripts/agents-watch.sh"

if [ "$statusline" = yes ]; then
  put "$here/statusline/statusline-command.sh" "$HOME/.claude/statusline-command.sh"
  # The status line entry in the Claude Code settings. Only this one key is added; a different entry is kept.
  settings="$HOME/.claude/settings.json"
  line='{"type":"command","command":"bash ~/.claude/statusline-command.sh"}'
  if [ ! -e "$settings" ]; then
    jq -n --argjson l "$line" '{statusLine: $l}' > "$settings"
    echo "created: $settings with the status line entry"
  elif ! jq -e . "$settings" >/dev/null 2>&1; then
    echo "install: $settings is not plain JSON; add the statusLine entry by hand, see README.md" >&2
  elif jq -e '.statusLine.command // "" | test("statusline-command[.]sh")' "$settings" >/dev/null; then
    echo "kept: $settings already has the status line entry"
  elif jq -e 'has("statusLine")' "$settings" >/dev/null; then
    echo "kept: $settings has another statusLine; see README.md if you want this one"
  else
    cp "$settings" "$settings.$stamp.bak"
    jq --argjson l "$line" '. + {statusLine: $l}' "$settings.$stamp.bak" > "$settings"
    echo "backup: $settings.$stamp.bak"
    echo "added: the status line entry in $settings"
  fi
fi

cmux sidebar validate agents

cat <<'MSG'

Files are in place. One step is left for you:
open a tab in cmux and run   ~/.config/cmux/scripts/agents-watch.sh
Leave that tab open. The panel shows in the right sidebar.
MSG
