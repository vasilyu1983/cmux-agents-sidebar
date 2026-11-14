#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Removes what install.sh put in place. Run it in Terminal: bash uninstall.sh        (shows the plan)
#                                                           bash uninstall.sh --yes  (deletes)
# It never touches: your accounts file, your account folders, any login, the Claude Code settings, backup files.
set -eu
files=("$HOME/.config/cmux/sidebars/agents.js")
for f in label-tabs.py hive.html hive-data.js history-data.js agents-watch.sh next-waiting.sh agent-run.sh agents-account-add.sh agents-shell.sh; do
  files+=("$HOME/.config/cmux/scripts/$f")
done
cache="$HOME/.cache/cmux-agents"

for f in "${files[@]}" "$cache"; do
  [ -e "$f" ] || continue
  if [ "${1:-}" = "--yes" ]; then
    if [ "$f" = "$cache" ]; then rm -rf -- "$cache"; else rm -f -- "$f"; fi
    echo "removed: $f"
  else
    echo "would remove: $f"
  fi
done
[ "${1:-}" = "--yes" ] || echo "Nothing was removed. Run again with --yes to delete."

cat <<'MSG'

Left for you, by hand:
- Stop the tab that runs agents-watch.sh.
- Remove the line "source ~/.config/cmux/scripts/agents-shell.sh" from ~/.zshrc or ~/.bashrc, if you added it.
- The status line: ~/.claude/statusline-command.sh and the "statusLine" entry in ~/.claude/settings.json.
- Accounts: ~/.config/cmux/agents-accounts and the account folders (they hold logins; log out first).
- Backup files that end in ".bak" beside the installed files.
MSG
