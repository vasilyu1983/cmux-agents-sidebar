#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs the Agents panel for cmux from this folder. Run it in Terminal: bash install.sh
# An existing file that differs is copied to <name>.<date>.bak before it is replaced.
# Pass --no-statusline to skip the Claude Code and Antigravity CLI status lines and their settings entries.
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
for f in label-tabs.py hive.html agents-watch.sh next-waiting.sh agent-run.sh agents-account-add.sh agents-shell.sh; do
  put "$here/scripts/$f" "$HOME/.config/cmux/scripts/$f"
done
chmod +x "$HOME/.config/cmux/scripts/label-tabs.py" "$HOME/.config/cmux/scripts/agents-watch.sh" "$HOME/.config/cmux/scripts/next-waiting.sh" \
  "$HOME/.config/cmux/scripts/agent-run.sh" "$HOME/.config/cmux/scripts/agents-account-add.sh"

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
  # The Antigravity CLI status line, only when Antigravity CLI is set up. It saves the quota windows for the
  # Limits view; "stack_with_default" keeps the usual Antigravity status line.
  agy_settings="$HOME/.gemini/antigravity-cli/settings.json"
  if [ -d "${agy_settings%/*}" ]; then
    put "$here/statusline/agy-statusline.sh" "$HOME/.config/cmux/scripts/agy-statusline.sh"
    chmod +x "$HOME/.config/cmux/scripts/agy-statusline.sh"
    line='{"type":"command","command":"bash ~/.config/cmux/scripts/agy-statusline.sh","stack_with_default":true}'
    if [ ! -e "$agy_settings" ]; then
      jq -n --argjson l "$line" '{statusLine: $l}' > "$agy_settings"
      echo "created: $agy_settings with the status line entry"
    elif ! jq -e . "$agy_settings" >/dev/null 2>&1; then
      echo "install: $agy_settings is not plain JSON; add the statusLine entry by hand, see README.md" >&2
    elif jq -e '.statusLine.command // "" | test("agy-statusline[.]sh")' "$agy_settings" >/dev/null; then
      echo "kept: $agy_settings already has the status line entry"
    elif jq -e 'has("statusLine")' "$agy_settings" >/dev/null; then
      echo "kept: $agy_settings has another statusLine; see README.md if you want this one"
    else
      cp "$agy_settings" "$agy_settings.$stamp.bak"
      jq --argjson l "$line" '. + {statusLine: $l}' "$agy_settings.$stamp.bak" > "$agy_settings"
      echo "backup: $agy_settings.$stamp.bak"
      echo "added: the status line entry in $agy_settings"
    fi
  fi
fi

cmux sidebar validate agents

cat <<'MSG'

Files are in place. One step is left for you:
open a tab in cmux and run   ~/.config/cmux/scripts/agents-watch.sh
It keeps running after you close the tab. The panel shows in the right sidebar.
MSG
