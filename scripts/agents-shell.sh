# SPDX-License-Identifier: GPL-3.0-or-later
# Short commands for several accounts. Load it from ~/.zshrc or ~/.bashrc:
#   source ~/.config/cmux/scripts/agents-shell.sh
# claude, codex, opencode   start with the account that the folder rules choose
# cla <account> [args]      Claude Code with that account, for this start only
# cdx <account> [args]      Codex with that account, for this start only
# accounts                  the account list, and the account that this folder gets
_agent_run="$HOME/.config/cmux/scripts/agent-run.sh"
claude() { "$_agent_run" claude "$@"; }
codex() { "$_agent_run" codex "$@"; }
opencode() { "$_agent_run" opencode "$@"; }
cla() {
  [ $# -ge 1 ] || { echo "usage: cla <account> [arguments for claude]" >&2; return 2; }
  local account="$1"; shift
  AGENT_ACCOUNT="$account" "$_agent_run" claude "$@"
}
cdx() {
  [ $# -ge 1 ] || { echo "usage: cdx <account> [arguments for codex]" >&2; return 2; }
  local account="$1"; shift
  AGENT_ACCOUNT="$account" "$_agent_run" codex "$@"
}
accounts() {
  local conf="$HOME/.config/cmux/agents-accounts" tool
  if [ -f "$conf" ]; then grep -v '^[[:space:]]*\(#\|$\)' "$conf"; else echo "no accounts file: $conf"; fi
  for tool in claude codex opencode; do
    command -v "$tool" >/dev/null 2>&1 && echo "this folder, $tool: $("$_agent_run" --which "$tool")"
  done
}
