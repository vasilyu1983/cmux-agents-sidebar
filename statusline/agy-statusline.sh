#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Antigravity CLI status line: saves the quota windows for the Agents panel and prints nothing, so with
# "stack_with_default": true the usual Antigravity status line stays as it is.
# It keeps one line per window: name, share used in %, reset time (epoch, 0 = unknown). No email, no other field.
# Window names: 5h and week (Gemini models), cg5h and cgwk (Claude and GPT models), argon (Gemini Argon week).
out="$HOME/.cache/cmux-agents/agy-quota"
lines=$(jq -r --argjson now "$(date +%s)" '
  {"gemini-5h": "5h", "gemini-weekly": "week", "3p-5h": "cg5h", "3p-weekly": "cgwk", "gemini-argon-wtu-weekly": "argon"} as $names
  | (.quota // {}) | to_entries[]
  | select($names[.key] and (.value.remaining_fraction | type) == "number")
  | [$names[.key], ((1 - .value.remaining_fraction) * 100 | round),
     (if (.value.reset_in_seconds | type) == "number" and .value.reset_in_seconds > 0 then $now + .value.reset_in_seconds else 0 end)]
  | @tsv' 2>/dev/null)
if [ -n "$lines" ]; then
  (umask 077; mkdir -p "${out%/*}" && printf '%s\n' "$lines" > "$out.tmp" && mv "$out.tmp" "$out")
fi
exit 0
