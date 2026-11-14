# SPDX-License-Identifier: GPL-3.0-or-later
"""Checks of history_step in scripts/label-tabs.py: the log behind the Timeline, Limits and Rhythm views.
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
h = step(h, [row("working", compactions=8, cold=False)], [], T + 30)
h = step(h, [row("working", compactions=8, cold=True)], [], T + 45)
check("a cache that goes cold gives one mark", h["e"][-1] == [SID, "cold", T + 45] and len(h["e"]) == 2)

# Subagent runs: known by session and start; a later pass brings the later end.
h = step({}, [row("working")], [], T, [[SID, "Explore", T - 50, T - 10]])
h = step(h, [row("working")], [], T + 15, [[SID, "Explore", T - 50, T + 15], [SID, "Plan", T, T + 15]])
check("a subagent run is kept once, with its newest end", h["g"] == [[SID, "Explore", T - 50, T + 15], [SID, "Plan", T, T + 15]])

many = {"b": [[SID, "idle", T - 10, T - 10]] * (watcher.HISTORY_BLOCKS + 50)}
check("the number of blocks has a cap", len(step(many, [], [], T)["b"]) == watcher.HISTORY_BLOCKS)

print("OK: all history checks passed" if not failed else f"FAILED: {failed} check(s)")
sys.exit(1 if failed else 0)
