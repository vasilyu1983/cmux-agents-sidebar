#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Claude Code status line — styled after powerlevel9k (dir | git | model | context | limits | cost | cache)

input=$(cat)

# The folder where the session started, not where the last command ended: a `cd` must not rename the session's project.
path=$(echo "$input" | jq -r '.workspace.project_dir // .workspace.current_dir // .cwd // ""')
[ -n "$path" ] || path=$(pwd)
# Shorten home directory to ~
dir="${path/#$HOME/~}"

# Model with the reasoning effort of the session (absent for a model without that setting) and a mark for fast mode
model=$(echo "$input" | jq -r '[.model.display_name // "", .effort.level // empty, (select(.fast_mode == true) | "fast")] | join(" ")')

used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Git branch of the directory shown (non-blocking, skip locks); a detached HEAD shows its short SHA
git_seg=""
branch=$(GIT_OPTIONAL_LOCKS=0 git -C "$path" symbolic-ref --short HEAD 2>/dev/null \
  || GIT_OPTIONAL_LOCKS=0 git -C "$path" rev-parse --short HEAD 2>/dev/null)
if [ -n "$branch" ]; then
  git_seg=" $branch"
fi

# Lane: the branch of the folder where the last command ended, shown only when it differs from the start folder's branch
lane_seg=""
cur=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
if [ -n "$cur" ] && [ "$cur" != "$path" ]; then
  lane=$(GIT_OPTIONAL_LOCKS=0 git -C "$cur" symbolic-ref --short HEAD 2>/dev/null \
    || GIT_OPTIONAL_LOCKS=0 git -C "$cur" rev-parse --short HEAD 2>/dev/null)
  if [ -n "$lane" ] && [ "$lane" != "$branch" ]; then
    lane_seg=" ❯ $lane"
  fi
fi

# Colors (dim-friendly ANSI)
RESET="\033[0m"
YELLOW="\033[33m"
GREEN="\033[32m"
MAGENTA="\033[35m"
BLUE="\033[34m"
RED="\033[31m"

# Context segment — color shifts to red when >80%
ctx_seg=""
ctx_color="$MAGENTA"
if [ -n "$used" ]; then
  used_int=$(printf '%.0f' "$used")
  # Claude Code sends a whole number; the token counts of the last call give one decimal. Same formula: input only.
  exact=$(echo "$input" | jq -r '.context_window | select(.current_usage != null and (.context_window_size // 0) > 0)
    | (.current_usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)) * 1000 / .context_window_size | round / 10')
  ctx_seg=" ${exact:-$used}% ctx"
  if [ "$used_int" -ge 80 ]; then
    ctx_color="$RED"
  fi
fi

# Cost segment — the session estimate at list price, from Claude Code
cost_seg=""
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
if [ -n "$cost" ]; then
  cost_seg=$(printf ' $%.2f' "$cost")
fi

# Hand-over for the cmux Agents panel: Claude Code gives model, effort, context and cost only to this script,
# so it leaves them in a small file per session: "model<TAB>context %<TAB>cost<TAB>lane branch<TAB>cold tokens<TAB>week %<TAB>5h %<TAB>5h reset<TAB>week reset<TAB>config folder name<TAB>context tokens".
# Context tokens: the input side of the last call (the sum behind the exact share); empty when Claude Code gives no current_usage.
# label-tabs.py copies them to the workspace description. Config folder name: the last part of CLAUDE_CONFIG_DIR,
# set when the session runs under another account folder; the accounts file maps it to an account name. Lane branch: set when the session works in another folder
# on another branch. Context %: empty when Claude Code gives no token counts (after a compaction or a resume,
# until the next reply). Cold tokens: set when the prompt cache went cold. Week %: the 7-day limit of the account.
sid=$(echo "$input" | jq -r '.session_id // "" | select(test("^[0-9a-f-]{8,64}$"))')
if [ -n "$sid" ] && [ -n "$model" ]; then
  tokens=$(echo "$input" | jq -r '.context_window.current_usage // empty
    | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)' | LC_ALL=C tr -cd '0-9')
  (umask 077; mkdir -p "$HOME/.cache/cmux-agents" \
    && printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' "$model" "${exact:+$used_int}" "${cost_seg# \$}" "$(printf '%s' "${lane:-}" | LC_ALL=C tr -cd 'A-Za-z0-9._/-' | cut -c1-60)" \
      "$(echo "$input" | jq -r '[((.prompt_cache // {}) | if .caching_observed == true and .warm == false then (.recache_tokens_if_cold // 1 | tostring) else "" end), (.rate_limits.seven_day.used_percentage // "" | tostring), (.rate_limits.five_hour.used_percentage // "" | tostring), (.rate_limits.five_hour.resets_at // "" | tostring), (.rate_limits.seven_day.resets_at // "" | tostring)] | join("\t")')" \
      "$(config=${CLAUDE_CONFIG_DIR:-}; config=${config%/}; printf '%s' "${config##*/}" | LC_ALL=C tr -cd 'A-Za-z0-9._-' | cut -c1-40)" \
      "$tokens" > "$HOME/.cache/cmux-agents/$sid") 2>/dev/null
fi

# Rate limit segment — account-wide use of the 5-hour and 7-day windows; red from 80%
# Each part shows the share used and when that window resets (local time). A window can be absent.
limit_seg=$(echo "$input" | jq -r '
  def part(name; fmt): select(.used_percentage != null)
    | " \(name) \(.used_percentage * 100 | round / 100)%" + (if .resets_at then " to " + (.resets_at | strflocaltime(fmt)) else "" end);
  [(.rate_limits.five_hour // empty | part("5h"; "%H:%M")), (.rate_limits.seven_day // empty | part("week"; "%a %H:%M"))] | join("")')
limit_color="$RESET"
if [ "$(echo "$input" | jq -r '[.rate_limits.five_hour.used_percentage // 0, .rate_limits.seven_day.used_percentage // 0] | max >= 80')" = "true" ]; then
  limit_color="$RED"
fi

# Cache segment — shown only when the prompt cache of this session went cold:
# the next message writes the conversation to the cache again, at the higher write price.
cold_seg=$(echo "$input" | jq -r '
  def short: if . >= 1000000 then "\(. / 100000 | round / 10)M" elif . >= 1000 then "\(. / 100 | round / 10)K" else "\(.)" end;
  .prompt_cache // empty | select(.caching_observed == true and .warm == false)
  | "  cold" + (if .recache_tokens_if_cold then " \(.recache_tokens_if_cold | short)" else "" end)')

# Account segment: shown only when the session runs with another config folder than the normal one.
# "~/.claude-work" shows as "work"; another folder name shows whole.
acct_seg=""
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  acct=${CLAUDE_CONFIG_DIR%/}; acct=${acct##*/}; acct=${acct#.claude-}
  acct=$(printf '%s' "$acct" | LC_ALL=C tr -cd 'A-Za-z0-9._-' | cut -c1-24)
  if [ -n "$acct" ] && [ "$acct" != ".claude" ]; then
    # One fixed colour per name, from the same list and the same sum as the Agents panel.
    acct_sum=0; acct_i=0
    while [ "$acct_i" -lt "${#acct}" ]; do
      acct_sum=$(( (acct_sum * 31 + $(LC_ALL=C printf '%d' "'${acct:$acct_i:1}")) % 1000003 )); acct_i=$((acct_i + 1))
    done
    acct_codes=(81 141 212 43 185 75)
    acct_seg="\033[1;38;5;${acct_codes[$((acct_sum % 6))]}m${acct}${RESET} "
  fi
fi

printf "${acct_seg}${YELLOW}%s${RESET}${BLUE}%s%s${RESET}  ${GREEN}%s${RESET}${ctx_color}%s${RESET} ${limit_color}%s${RESET} %s${RED}%s${RESET}" \
  "$dir" "$git_seg" "$lane_seg" "$model" "$ctx_seg" "$limit_seg" "$cost_seg" "$cold_seg"
