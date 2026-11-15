# SPDX-License-Identifier: GPL-3.0-or-later
"""Checks of history_step in scripts/label-tabs.py: the log behind the Timeline, Limits and Rhythm views.
At the end, checks of the functions that read session files: quiet, codex_context, codex_marks and model_of.
Run: python3 tests/history.py"""
import importlib.util
import os
import sys

sys.dont_write_bytecode = True
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("label_tabs", os.path.join(here, "..", "scripts", "label-tabs.py"))
watcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher)
step = watcher.history_step

SID = "11111111-2222-3333-4444-555555555555"
T = 1_800_000_000


def row(state, sid=SID, cost="$1.00", ctx=42, compactions=0, cold=False):
    return (sid, "api-3f", "shop-api", state, "Fable 5.2 high", ctx, cost, "work", compactions, cold)


failed = 0


def check(name, ok):
    global failed
    print(("PASS " if ok else "FAIL ") + name)
    failed += 0 if ok else 1


h = step({}, [row("working")], [], T)
h = step(h, [row("working", cost="$2.00")], [], T + 15)
check("a session that keeps its state has one block, which grows", h["b"] == [[SID, "working", T, T + 15]])
check("the newest cost of the session is kept", h["s"][SID]["c"] == "$2.00" and h["s"][SID]["w"] == "shop-api")

h = step(h, [row("needs_input")], [], T + 30)
check("a new state starts a block where the last one ended", h["b"][-1] == [SID, "needs_input", T + 15, T + 30] and len(h["b"]) == 2)

# The Mac slept for an hour: the hour must not show as waiting.
h = step(h, [row("needs_input")], [], T + 3630)
check("a silence of the watcher splits the block", h["b"][-1] == [SID, "needs_input", T + 3630, T + 3630] and h["b"][-2][3] == T + 30)

# The Rhythm view shows a month of days, so the history keeps 30 days (it kept 7 before).
old = step({}, [row("idle")], [], T - 31 * 86400, [[SID, "Explore", T - 31 * 86400, T - 31 * 86400 + 60]])
h = step(old, [], [], T)
check("a block older than 30 days goes, and its session, samples and subagent runs with it",
      h["b"] == [] and h["s"] == {} and h["p"] == [] and h["g"] == [])
h = step(step({}, [row("idle")], [], T - 2 * 86400), [], [], T)
check("a sample older than a day goes, its block stays", h["p"] == [] and len(h["b"]) == 1)
check("a block of 8 days ago stays", len(step(step({}, [row("idle")], [], T - 8 * 86400), [], [], T)["b"]) == 1)

check("an unknown state and a bad session id are left out",
      step({}, [row("ended"), row("idle", sid="../x")], [], T)["b"] == [])

r = ["claude", "week", "", 40, T + 86400, T - 100]
h = step({}, [], [r, list(r)], T)
h = step(h, [], [r, ["claude", "week", "", 41, T + 86400, T]], T + 15)
check("one limit reading per figure, however often the watcher saw it", [x[3] for x in h["l"]] == [40, 41])

check("a broken history file counts as empty", step("junk", [row("idle")], [], T)["b"] == [[SID, "idle", T, T]])
check("no request or reply text has a place in the history", set(h) == {"t", "s", "b", "l", "p", "e", "g"}
      and set(step({}, [row("idle")], [], T)["s"][SID]) == {"n", "w", "m", "x", "c", "u", "q", "k"})

# Samples of context and cost: the Context and Cost views draw them over time.
h = step({}, [row("working", cost="$160.00")], [], T)
check("the first sample of a session is its figures at that time", h["p"] == [[SID, T, 42, 160.0]])
h = step(h, [row("working", cost="$160.50")], [], T + 15)
check("a change inside one minute waits", len(h["p"]) == 1)
h = step(h, [row("working", cost="$160.50")], [], T + 75)
check("a changed figure gives a sample after a minute", h["p"][-1] == [SID, T + 75, 42, 160.5] and len(h["p"]) == 2)
h = step(h, [row("working", cost="$160.50")], [], T + 300)
check("an unchanged figure gives no sample", len(h["p"]) == 2)
h = step({}, [row("idle", cost="", ctx=None)], [], T)
check("a session with no figure gives no sample, and an unknown context is never 0", h["p"] == [])
check("an unknown context with a cost is stored as unknown", step({}, [row("idle", ctx=None)], [], T)["p"] == [[SID, T, None, 1.0]])

# Marks: a compaction and a cold prompt cache.
h = step({}, [row("working", compactions=7, cold=True)], [], T)
check("the first pass that sees a session gives no mark", h["e"] == [])
old8 = step({}, [row("working")[:8]], [], T)
old8["s"][SID].pop("q"); old8["s"][SID].pop("k")
check("a history from before the marks gives no mark on its first new pass",
      step(old8, [row("working", compactions=7, cold=True)], [], T + 15)["e"] == [])
h = step(h, [row("working", compactions=8, cold=True)], [], T + 15)
check("a higher compaction count gives one mark", h["e"] == [[SID, "compact", T + 15]])
h = step(h, [row("working", compactions=0, cold=True)], [], T + 20)
h = step(h, [row("working", compactions=8, cold=True)], [], T + 25)
check("a pass that read no count gives no second mark", len(h["e"]) == 1)
h = step(h, [row("working", compactions=8, cold=False)], [], T + 30)
h = step(h, [row("working", compactions=8, cold=True)], [], T + 45)
check("a cache that goes cold gives one mark", h["e"][-1] == [SID, "cold", T + 45] and len(h["e"]) == 2)

# Subagent runs: known by session and start; a later pass brings the later end.
h = step({}, [row("working")], [], T, [[SID, "Explore", T - 50, T - 10]])
h = step(h, [row("working")], [], T + 15, [[SID, "Explore", T - 50, T + 15], [SID, "Plan", T, T + 15]])
check("a subagent run is kept once, with its newest end", h["g"] == [[SID, "Explore", T - 50, T + 15], [SID, "Plan", T, T + 15]])
h = step(h, [row("working")], [], T + 30, [[SID, "Explore", T, T + 30], [SID, "Plan", T, T + 20]])
check("two subagents that started in one second are both kept", len(h["g"]) == 2 and {r[1] for r in h["g"]} == {"Explore", "Plan"})
OTHER = "99999999-2222-3333-4444-555555555555"
h = step(h, [row("working", sid=OTHER)], [], T + 45, [[OTHER, "Explore", T + 40, T + 45]])
check("the runs of a session that this pass did not read stay", len(h["g"]) == 3)

many = {"b": [[SID, "idle", T - 10, T - 10]] * (watcher.HISTORY_BLOCKS + 50)}
check("the number of blocks has a cap", len(step(many, [], [], T)["b"]) == watcher.HISTORY_BLOCKS)

# The functions that read session files, on made-up files in a temporary folder (never the real folders).
import json
import tempfile
import time

box = tempfile.mkdtemp()
os.environ["HOME"] = box  # model_of reads the hand-over file under ~/.cache/cmux-agents


def write(path, text, age=0):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    os.utime(path, (time.time() - age, time.time() - age))


# A quiet mark: the main transcript is quiet while a subagent writes to its own transcript.
claude = os.path.join(box, "claude")
main_file = os.path.join(claude, "projects", "p", SID + ".jsonl")
write(main_file, "{}\n", age=30 * 60)
check("a busy session with a quiet transcript and no subagent is quiet", watcher.quiet({"sessionId": SID}, claude))
write(os.path.join(claude, "projects", "p", SID, "subagents", "agent-a1.jsonl"), "{}\n", age=60)
check("a session whose subagent wrote a line a minute ago is not quiet", not watcher.quiet({"sessionId": SID}, claude))
check("a session with no transcript is not quiet", not watcher.quiet({"sessionId": OTHER}, claude))

# Context share of a Codex session, from the last token count record of its newest session file.
def token_line(used, window, kind="token_count"):
    info = None if used is None else {"total_token_usage": {"total_tokens": 9_000_000},
                                      "last_token_usage": {"input_tokens": 1, "total_tokens": used},
                                      "model_context_window": window}
    return json.dumps({"timestamp": "2026-01-01T00:00:00Z", "type": "event_msg",
                       "payload": {"type": kind, "info": info, "rate_limits": None}}, separators=(",", ":")) + "\n"


codex = os.path.join(box, "codex")
rollout = os.path.join(codex, "sessions", "2026", "01", "01", "rollout-b.jsonl")
write(os.path.join(codex, "sessions", "2026", "01", "01", "rollout-a.jsonl"), token_line(50_000, 100_000), age=600)
write(rollout, token_line(20_000, 200_000) + token_line(108_000, 272_000) + token_line(None, None))
watcher.TAILS.clear()
check("a Codex context share comes from the last token count with numbers: whole percent and tokens",
      watcher.codex_context(codex) == (40, 108_000))
for name, text in (("no window", token_line(108_000, None)), ("a window that is not a number", token_line(108_000, "272000")),
                   ("a count that is a bool", token_line(True, 272_000)), ("no token count", "{}\n"),
                   ("more tokens than the window", token_line(300_000, 272_000))):
    write(rollout, text)
    watcher.TAILS.clear()
    check(f"a Codex file with {name} gives no figure, not an older file's figure", watcher.codex_context(codex) is None)
write(rollout, token_line(108_000, 272_000))
watcher.TAILS.clear()
check("one live Codex tab on a folder gets its figure", watcher.codex_marks({codex: {"TAB1"}}, set()) == {"TAB1": ["ctx 40%", "tok 108000"]})
check("two live Codex tabs on one folder get no figure", watcher.codex_marks({codex: {"TAB1", "TAB2"}}, set()) == {})
check("a Codex tab that Claude Code labels gets no figure", watcher.codex_marks({codex: {"TAB1"}}, {"TAB1"}) == {})
check("a Codex figure reaches the hive agent as x and z, not as the model",
      watcher.hive_agent(["ctx 40%", "tok 108000"]) == {"k": "claude", "x": 40, "z": 108_000})

# Tokens beside the share for Claude Code: the 11th field of the hand-over file.
fields = ["Fable 5.2 high", "42", "12.34", "", "", "", "", "", "", ""]
hand_over = os.path.join(box, ".cache", "cmux-agents", SID)
write(hand_over, "\t".join(fields + ["420000"]))
got = watcher.model_of({"sessionId": SID}, {}, claude, "")
check("an 11-field hand-over file gives the context tokens", got == ["Fable 5.2 high", "ctx 42%", "$12.34", "tok 420000"])
check("the tokens reach the hive agent as z", watcher.hive_agent(got).get("z") == 420_000 and watcher.hive_agent(got)["m"] == "Fable 5.2 high")
write(hand_over, "\t".join(fields))
check("a 10-field hand-over file still works and gives no tokens",
      watcher.model_of({"sessionId": SID}, {}, claude, "") == ["Fable 5.2 high", "ctx 42%", "$12.34"])
for bad in ("0", "10000000", "12x", "-5", " 420000"):
    write(hand_over, "\t".join(fields + [bad]))
    check(f"a token field {bad!r} gives no tokens",
          not any(f.startswith("tok ") for f in watcher.model_of({"sessionId": SID}, {}, claude, "")))
check("a bad token field is never taken as the model", "m" not in watcher.hive_agent(["tok 12x"]))

print("OK: all history checks passed" if not failed else f"FAILED: {failed} check(s)")
sys.exit(1 if failed else 0)
