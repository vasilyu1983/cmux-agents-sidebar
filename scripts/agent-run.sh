#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Starts a coding-agent tool with the account that belongs to the current folder.
#   agent-run.sh <tool> [arguments for the tool...]
#   agent-run.sh --which <tool>    prints the account name, or "default" for the tool's normal folder
# Accounts and rules come from ~/.config/cmux/agents-accounts (see examples/agents-accounts.example).
# Without that file the tool starts exactly as before. AGENT_ACCOUNT=<name> overrides the rules for one start.
# AGENT_PROFILE=<name> adds the arguments of that profile line of ~/.config/cmux/agents-profiles (see
# examples/agents-profiles.example) before your own. They pass to the tool as separate words; no shell reads them.
# The script sets one folder variable for the tool. It reads no login data.
set -u
conf="$HOME/.config/cmux/agents-accounts"
die() { echo "agent-run: $*" >&2; exit 2; }
name_ok() { [[ "$1" =~ ^[a-z0-9-]{1,16}$ ]]; }

which_only=0
if [ "${1:-}" = "--which" ]; then which_only=1; shift; fi
[ $# -ge 1 ] || die "usage: agent-run.sh [--which] <claude|codex|opencode|grok> [arguments...]"
tool="$1"; shift
case "$tool" in
  claude) var=CLAUDE_CONFIG_DIR ;;
  codex) var=CODEX_HOME ;;
  opencode) var=XDG_DATA_HOME ;;
  grok) var=GROK_HOME ;;
  *) die "no account support for this tool (supported: claude, codex, opencode, grok)" ;;
esac

# The profile: "profile <tool> <name> <arguments...>". A word that starts with "~/" means your home folder.
extra=()
if [ -n "${AGENT_PROFILE:-}" ] && [ "$which_only" = 0 ]; then
  name_ok "$AGENT_PROFILE" || die "AGENT_PROFILE is not a valid profile name"
  pconf="$HOME/.config/cmux/agents-profiles"
  [ -f "$pconf" ] || die "profile '$AGENT_PROFILE': $pconf is missing"
  found=0; n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    # Split into words with globbing off, so "*" stays a word. No here-string: bash 3.2 writes it to a temp file.
    set -f; w=(${line%$'\r'}); set +f
    [ "${w[0]:-}" = profile ] && [ "${w[1]:-}" = "$tool" ] && [ "${w[2]:-}" = "$AGENT_PROFILE" ] || continue
    [ "${#w[@]}" -ge 4 ] || die "profile line $n: write 'profile <tool> <name> <arguments...>'"
    for a in "${w[@]:3}"; do
      case "$a" in "~/"*) a="$HOME/${a#"~/"}" ;; esac
      extra+=("$a")
    done
    found=1; break
  done <"$pconf"
  [ "$found" = 1 ] || die "no line 'profile $tool $AGENT_PROFILE ...' in $pconf"
fi

choice=""
start() {
  if [ "$which_only" = 1 ]; then echo "${choice:-default}"; exit 0; fi
  local real
  real="$(command -v "$tool")" || die "$tool is not on PATH"
  # A copy or link of this script named like the tool would call itself without end.
  [ "$real" -ef "$0" ] && die "$tool on PATH is this script; call the real tool from a shell function"
  # In a cmux tab the tool's name is a shell function that runs cmux's own wrapper, and the wrapper adds
  # the hooks that report the session to cmux. A script does not see that function, so it calls the wrapper.
  local wrap=""
  if [ -n "${CMUX_SURFACE_ID:-}" ] && [ -n "${CMUX_BUNDLED_CLI_PATH:-}" ]; then
    case "$tool" in
      claude) wrap="${CMUX_BUNDLED_CLI_PATH%/*}/cmux-claude-wrapper" ;;
      grok) wrap="${CMUX_BUNDLED_CLI_PATH%/*}/grok" ;;
    esac
  fi
  # Bash 3.2 (macOS) calls an empty array unset under "set -u", hence the ${extra[@]+...} form.
  if [ -n "$wrap" ] && [ -x "$wrap" ] && ! [ "$wrap" -ef "$0" ]; then exec "$wrap" ${extra[@]+"${extra[@]}"} "$@"; fi
  exec "$tool" ${extra[@]+"${extra[@]}"} "$@"
}

[ -f "$conf" ] || start "$@"

known=" default "; best=""; best_len=-1; fallback=""; count=0; n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line="${line%$'\r'}"
  read -r kw a b rest <<<"$line"
  case "$kw" in
    '' | '#'*) continue ;;
    account)
      case "$a" in claude | codex | opencode | grok) ;; *) die "line $n: the tool must be claude, codex, opencode or grok" ;; esac
      name_ok "$b" || die "line $n: an account name has 1 to 16 characters from a-z, 0-9 and -"
      [ -n "$rest" ] || die "line $n: an account line needs a folder"
      known="$known$b "
      acc_key[$count]="$a/$b"; acc_dir[$count]="$rest"; count=$((count + 1))
      ;;
    rule)
      # The name is the last word, so the folder prefix may hold spaces.
      read -r kw rest <<<"$line"
      name="${rest##*[[:space:]]}"
      prefix="${rest%"$name"}"
      prefix="${prefix%"${prefix##*[![:space:]]}"}"
      [ -n "$prefix" ] && name_ok "$name" || die "line $n: write 'rule <folder prefix> <account name>'"
      known="$known$name "
      case "$prefix" in "~") prefix="$HOME" ;; "~/"*) prefix="$HOME/${prefix#"~/"}" ;; esac
      prefix="${prefix%/}"
      # A prefix matches the folder itself and the folders below it, never a folder that only starts with the same letters.
      if [ "$PWD" = "$prefix" ] || [ "${PWD#"$prefix"/}" != "$PWD" ]; then
        if [ "${#prefix}" -gt "$best_len" ]; then best="$name"; best_len="${#prefix}"; fi
      fi
      ;;
    default)
      name_ok "$a" && [ -z "$b" ] || die "line $n: write 'default <account name>'"
      known="$known$a "; fallback="$a"
      ;;
    *) die "line $n: the first word must be account, rule or default" ;;
  esac
done <"$conf"

if [ -n "${AGENT_ACCOUNT:-}" ]; then
  name_ok "$AGENT_ACCOUNT" || die "AGENT_ACCOUNT is not a valid account name"
  case "$known" in *" $AGENT_ACCOUNT "*) ;; *) die "unknown account '$AGENT_ACCOUNT': no line in $conf names it" ;; esac
  choice="$AGENT_ACCOUNT"
elif [ -n "$best" ]; then
  choice="$best"
else
  choice="$fallback"
fi
[ "$choice" = default ] && choice=""

dir=""; i=0
while [ "$i" -lt "$count" ]; do
  [ "${acc_key[$i]}" = "$tool/$choice" ] && dir="${acc_dir[$i]}"
  i=$((i + 1))
done

if [ -z "$dir" ]; then
  # This account uses the tool's normal folder. An inherited variable would start another account under this name.
  # XDG_DATA_HOME is a general variable that the user may set on purpose, so it stays.
  [ "$var" = XDG_DATA_HOME ] || unset "$var"
  start "$@"
fi

case "$dir" in "~/"*) dir="$HOME/${dir#"~/"}" ;; esac
dir="${dir%/}"
case "$dir" in "$HOME"/?*) ;; *) die "account '$choice': the folder must be under your home folder" ;; esac
case "/$dir/" in */../* | */./*) die "account '$choice': the folder must not hold . or .. parts" ;; esac
[ -d "$dir" ] || die "account '$choice': the folder $dir is missing; run agents-account-add.sh $tool $choice"
export "$var=$dir"
start "$@"
