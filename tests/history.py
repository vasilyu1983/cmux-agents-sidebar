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


def row(state, sid=SID, cost="$1.00"):
    return (sid, "api-3f", "shop-api", state, "Fable 5.2 high", 42, cost, "work")


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

old = step({}, [row("idle")], [], T - 8 * 86400)
h = step(old, [], [], T)
check("a block older than a week goes, and its session with it", h["b"] == [] and h["s"] == {})

check("an unknown state and a bad session id are left out",
      step({}, [row("ended"), row("idle", sid="../x")], [], T)["b"] == [])

r = ["claude", "week", "", 40, T + 86400, T - 100]
h = step({}, [], [r, list(r)], T)
h = step(h, [], [r, ["claude", "week", "", 41, T + 86400, T]], T + 15)
check("one limit reading per figure, however often the watcher saw it", [x[3] for x in h["l"]] == [40, 41])

check("a broken history file counts as empty", step("junk", [row("idle")], [], T)["b"] == [[SID, "idle", T, T]])
check("no request or reply text has a place in the history", set(h) == {"t", "s", "b", "l"}
      and set(step({}, [row("idle")], [], T)["s"][SID]) == {"n", "w", "m", "x", "c", "u"})

many = {"b": [[SID, "idle", T - 10, T - 10]] * (watcher.HISTORY_BLOCKS + 50)}
check("the number of blocks has a cap", len(step(many, [], [], T)["b"]) == watcher.HISTORY_BLOCKS)

print("OK: all history checks passed" if not failed else f"FAILED: {failed} check(s)")
sys.exit(1 if failed else 0)
