#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Adds one account folder for a coding-agent tool and its line in ~/.config/cmux/agents-accounts.
#   agents-account-add.sh <claude|codex|opencode> <name> [--dry-run]
# For Claude Code and Codex it links the shared setup (settings, instructions, hooks, skills ...) from the
# tool's normal folder, so every account follows the same rules. It links no session data, no project memory and no login data,
# and it reads none of them. You log in yourself with the command that it prints.
set -u
die() { echo "agents-account-add: $*" >&2; exit 2; }

dry=0; args=()
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then dry=1; else args[${#args[@]}]="$arg"; fi
done
[ "${#args[@]}" -eq 2 ] || die "usage: agents-account-add.sh <claude|codex|opencode> <name> [--dry-run]"
tool="${args[0]}"; name="${args[1]}"
case "$tool" in claude | codex | opencode) ;; *) die "the tool must be claude, codex or opencode" ;; esac
[[ "$name" =~ ^[a-z0-9-]{1,16}$ ]] || die "an account name has 1 to 16 characters from a-z, 0-9 and -"
[ "$name" != default ] || die "'default' means the tool's normal folder; choose another name"

here="$(cd "$(dirname "$0")" && pwd)"
conf="$HOME/.config/cmux/agents-accounts"
dir="$HOME/.$tool-$name"
shown="~/.$tool-$name"
line="account $tool $name $shown"
run() { if [ "$dry" = 1 ]; then echo "  would run: $*"; else "$@" || die "failed: $*"; fi; }

have_line=0
if [ -f "$conf" ]; then
  while read -r kw a b rest || [ -n "$kw" ]; do
    # The primary account lives in the tool's normal folder. A second folder for it would split its history.
    [ "$kw" = default ] && [ "$a" = "$name" ] \
      && die "'$name' is the default account; it uses the tool's normal folder and needs no extra folder"
    [ "$kw" = account ] && [ "$a" = "$tool" ] && [ "$b" = "$name" ] || continue
    case "$rest" in "~/"*) rest="$HOME/${rest#"~/"}" ;; esac
    [ "$rest" = "$dir" ] || die "$conf already gives $tool/$name another folder; edit that line by hand"
    have_line=1
  done <"$conf"
fi
if [ "$have_line" = 0 ] && [ -e "$dir" ]; then
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ -z "$(ls -A "$dir")" ] \
    || die "$shown exists and is not an empty folder; this script does not adopt a folder that it did not make"
fi

[ "$dry" = 1 ] && echo "Dry run: nothing changes."
(
  umask 077
  [ -d "$dir" ] || run mkdir -p "$dir"
  if [ "$have_line" = 0 ]; then
    run mkdir -p "$HOME/.config/cmux"
    if [ "$dry" = 1 ]; then echo "  would add to $conf: $line"; else
      # A last line without a line end would join with the new line.
      if [ -s "$conf" ] && [ -n "$(tail -c1 "$conf")" ]; then echo >>"$conf" || die "cannot write $conf"; fi
      echo "$line" >>"$conf" || die "cannot write $conf"
    fi
  fi
) || exit 2
echo "Account $tool/$name: folder $shown"

# Fixed lists of setup files. Login data, sessions, memory, history and databases are never on them.
link_shared() {
  local base="$1" item src dst state; shift
  echo "Shared setup from ~/$base:"
  for item in "$@"; do
    src="$HOME/$base/$item"; dst="$dir/$item"
    if [ ! -e "$src" ]; then state="not in ~/$base, skipped"
    elif [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then state="linked"
    elif [ -L "$dst" ]; then state="a link to another place, left as it is"
    elif [ -e "$dst" ]; then state="a real file of this account, left as it is"
    else
      run ln -s "$src" "$dst"
      state="linked now"; [ "$dry" = 1 ] && state="would be linked"
    fi
    printf '  %-24s %s\n' "$item" "$state"
  done
}
if [ "$tool" = claude ]; then
  link_shared .claude settings.json CLAUDE.md hooks rules skills agents commands output-styles plugins \
    statusline-command.sh workflows keybindings.json teams
  echo "Separate for this account: the login, sessions and /resume, project memory, history."
  login="claude auth login"
elif [ "$tool" = codex ]; then
  link_shared .codex config.toml AGENTS.md instructions.md hooks.json rules skills agents plugins keybindings.json
  echo "Separate for this account: the login, sessions, memories, history."
  login="codex login"
else
  echo "Nothing is linked for OpenCode. Its settings stay shared in ~/.config/opencode; the login and the sessions are separate."
  login="opencode auth login"
fi

echo "Log in once, by hand:"
echo "  AGENT_ACCOUNT=$name ${here/#$HOME/~}/agent-run.sh $login"
