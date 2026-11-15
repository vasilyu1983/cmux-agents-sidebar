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

# Inside the session: counts from made-up transcript lines. Labels, counts, lengths and paths are kept, never text.
import contextlib
import io
import stat

SECRET = "sk-made-up-secret-0000"
check("an MCP tool is counted by its server", watcher.tool_label("mcp__shop-db__run_query") == "mcp:shop-db")
check("the Skill tool is counted by its skill", watcher.tool_label("Skill", "review-pr") == "skill:review-pr")
check("a label keeps only A-Z a-z 0-9 _.:- and 40 characters",
      watcher.tool_label("Bad name!$/" + "x" * 60) == ("Badname" + "x" * 60)[:40])
check("a skill that is not text puts no input into the label", watcher.tool_label("Skill", {"skill": SECRET}) == "skill:")

os.environ["TMPDIR"] = box  # claude_names looks for an owner board there; the made-up folder has none
dot_claude = os.path.join(box, ".claude")
cache = os.path.join(box, ".cache", "cmux-agents")
now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
old_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 7 * 3600))


def line(**record):
    return json.dumps(record, separators=(",", ":")) + "\n"


def use(name, at=now_iso, **given):
    return line(type="assistant", timestamp=at, message={"content": [{"type": "tool_use", "name": name, "input": given}]})


def result(failed):
    return line(type="user", message={"content": [{"type": "tool_result", "is_error": failed, "content": SECRET}]})


attachment = line(type="attachment", attachment={"content": SECRET})
mine = os.path.join(dot_claude, "projects", "p", SID + ".jsonl")
write(mine, line(type="user", message={"content": [{"type": "text", "text": "fix it"}]})
      + line(type="assistant", message={"content": [{"type": "thinking", "thinking": "plan"}, {"type": "text", "text": "ok "}]})
      + use("Bash", command=SECRET) + use("Edit", file_path="/work/shop/app.py", old_string=SECRET)
      + use("mcp__shop-db__run_query", sql=SECRET) + use("Skill", skill="review-pr")
      + use("Write", at=old_iso, file_path="/work/shop/old.py", content=SECRET)
      + result(False) + result(True) * 6 + attachment
      + line(type="assistant", isApiErrorMessage=True, message={"content": [{"type": "text", "text": SECRET}]})
      # An "api-request" line repeats content: its tool call must not count.
      + line(type="api-request", message={"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}, body={"type": "assistant"}))
errors = io.StringIO()
with contextlib.redirect_stderr(errors):
    marks = watcher.transcript_marks(SID, dot_claude)
got = watcher.INSIDE[SID]
check("tool calls are counted per label, largest first, without the repeated api-request line",
      got.get("tn") == 5 and got.get("tl") == [["Bash", 1], ["Edit", 1], ["Write", 1], ["mcp:shop-db", 1], ["skill:review-pr", 1]])
check("failed tool results, API errors and the run of failures at the end are counted",
      (got.get("er"), got.get("ea"), got.get("lp")) == (6, 1, 6))
check("the panel row gets err (results and API errors) and loop", "err 7" in marks and "loop 6" in marks)
result_chars = len(json.dumps(SECRET)) * 7
check("the context parts are lengths in the fixed order",
      got.get("cm") == [["tool results", result_chars], ["your messages", 6], ["replies", 3], ["thinking", 4],
                        ["attachments", len(attachment) - 1]])
check("edited files are kept by name, newest first", got.get("fe") == [["app.py", 1], ["old.py", 1]])
inside_file = os.path.join(cache, SID + ".inside")
check("the counts file is readable by the owner only", stat.S_IMODE(os.stat(inside_file).st_mode) == 0o600)

with open(mine, "a") as fh:
    fh.write(line(type="user", isCompactSummary=True, message={"content": "summary"})
             + line(type="assistant", message={"content": [{"type": "text", "text": "after"}]}) + result(False))
marks = watcher.transcript_marks(SID, dot_claude)
got = watcher.INSIDE[SID]
check("a compaction starts the context parts again; the summary counts after it",
      got.get("cm") == [["tool results", len(json.dumps(SECRET))], ["your messages", 7], ["replies", 5]] and "comp 1" in marks)
check("only new lines are read: the tool counts do not double", got.get("tn") == 5 and got.get("er") == 6)
check("a tool result without error ends the run", "lp" not in got and not any(m.startswith("loop ") for m in marks))
os.unlink(inside_file)  # a state from before the counts existed: the transcript is read again from its start, once
marks = watcher.transcript_marks(SID, dot_claude)
check("without a counts file the transcript is read again, and nothing counts twice",
      watcher.INSIDE[SID].get("tn") == 5 and "comp 1" in marks and os.path.exists(inside_file))

# A second session edits app.py now (an overlap) and old.py, which the first one edited 7 hours ago (none).
write(os.path.join(dot_claude, "projects", "p", OTHER + ".jsonl"),
      use("Edit", file_path="/work/shop/app.py") + use("Write", file_path="/work/shop/old.py"))
space, space2 = os.path.join(box, "ws"), os.path.join(box, "ws2")
os.makedirs(space2, exist_ok=True)
for pid, name, sid, folder in ((101, "api-3f", SID, space), (102, "web-9c", OTHER, space2)):
    write(os.path.join(dot_claude, "sessions", f"{pid}.json"),
          json.dumps({"name": name, "pid": pid, "sessionId": sid, "cwd": folder, "status": "busy"}))

# Subagents of the first session: one not finished and quiet for 20 minutes (silent), one finished, one at work.
agents = os.path.join(dot_claude, "projects", "p", SID, "subagents")
for agent, record, age in (("a1", {"agentType": "Explore"}, 1200), ("a2", {"agentType": "Plan", "finished": True}, 1200),
                           ("a3", {"agentType": "Review"}, 60)):
    write(os.path.join(agents, agent + ".meta.json"), json.dumps(record))
    write(os.path.join(agents, agent + ".jsonl"), "{}\n", age=age)
check("a subagent that is not finished and wrote nothing for 10 minutes is silent",
      watcher.subagents_of(SID, dot_claude) == ["sub 1/3: Review", "silent 1"])
check("the silent count reaches the hive agent as sa, not as the model", watcher.hive_agent(["silent 1"]) == {"k": "claude", "sa": 1})
check("the new panel fields are never taken as the model",
      "m" not in watcher.hive_agent(["err 3", "loop 5", "overlap 1", "silent x"]))

# The setup of a made-up start folder, with secret-looking values in its settings files.
write(os.path.join(space, "CLAUDE.md"), "abc")
write(os.path.join(space, ".claude", "CLAUDE.md"), "x")
for entry in ("skills/a/SKILL.md", "skills/b/SKILL.md", "skills/.DS_Store", "agents/r.md"):
    write(os.path.join(space, ".claude", entry), "")
write(os.path.join(space, ".claude", "settings.json"),
      json.dumps({"hooks": {"PreToolUse": [], "Stop": []}, "env": {"TOKEN": SECRET}}))
write(os.path.join(space, ".mcp.json"), json.dumps({"mcpServers": {"db": {"env": {"KEY": SECRET}}, "web": {}}}))
write(os.path.join(space2, ".claude", "settings.json"), "{" + SECRET)  # not JSON: left out, its text not shown
inventory = {"files": [["CLAUDE.md", 3], [".claude/CLAUDE.md", 1]], "skills": 2, "agents": 1, "hooks": 2, "mcp": 2}
with contextlib.redirect_stderr(errors):
    check("the setup inventory has sizes and counts only", watcher.setup_inventory(space) == inventory)
    check("an unreadable settings file is left out", watcher.setup_inventory(space2) == {})
# The user folder holds the files with no ".claude" part in the path, and it has no MCP count.
check("the user folder is read at its own level", watcher.setup_inventory(os.path.join(space, ".claude"), user=True)
      == {"files": [["CLAUDE.md", 1]], "skills": 2, "agents": 1, "hooks": 2})
# An instruction file imports others with "@path": their sizes are summed, once each, also when they import
# each other. A path in code, a path that is no file, and a word like a package name add nothing.
space3 = os.path.join(box, "ws3")
write(os.path.join(space3, "rules", "a.md"), "12345 @b.md @../CLAUDE.md")
write(os.path.join(space3, "rules", "b.md"), "1234567")
write(os.path.join(space3, "CLAUDE.md"), "See @rules/a.md and @rules/none.md and @scope/pkg, `@rules/b.md`\n```\n@rules/b.md\n```\n")
check("imports are summed through the levels, once each", watcher.setup_inventory(space3).get("imp") == [["CLAUDE.md", 25 + 7]])
# Project memory of Claude Code: the index is one more file with its size, the other notes are a count.
slug = watcher.re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(space3))
for note, body in (("MEMORY.md", "index"), ("one.md", "SECRET " + SECRET), ("two.md", ""), ("skip.txt", "")):
    write(os.path.join(box, "home", "projects", slug, "memory", note), body)
memory = watcher.setup_inventory(space3, claude_home=os.path.join(box, "home"))
check("project memory gives the index size and a count of notes", memory.get("mem") == 2
      and ["memory/MEMORY.md", 5] in memory["files"] and SECRET not in json.dumps(memory))
# A Codex folder: AGENTS.md, prompts counted as commands, and the number of MCP tables in config.toml.
write(os.path.join(box, "cx", "AGENTS.md"), "abcd")
write(os.path.join(box, "cx", "prompts", "p.md"), "")
write(os.path.join(box, "cx", "skills", "s", "SKILL.md"), "")
write(os.path.join(box, "cx", "config.toml"), '[mcp_servers.db]\ncommand = "x"\nenv = { KEY = "' + SECRET + '" }\n[mcp_servers.web]\nurl = "u"\n')
check("a Codex folder is counted with its own names", watcher.setup_inventory(os.path.join(box, "cx"), user="codex")
      == {"files": [["AGENTS.md", 4]], "skills": 1, "commands": 1, "mcp": 2})
# Hook runs: one record per run with its kind, exit code and time; the command and the output are not kept.
state = watcher.inside_new()
for kind, code, took in (("hook_success", 0, 40), ("hook_success", 0, 60), ("hook_success", 2, 100), ("hook_additional_context", 0, 0)):
    watcher.inside_line(state, json.dumps({"type": "attachment", "attachment": {
        "type": kind, "exitCode": code, "durationMs": took, "command": SECRET, "stdout": SECRET}}, separators=(",", ":")).encode(), 0)
watcher.inside_line(state, json.dumps({"type": "assistant", "message": {"content": [
    {"type": "tool_use", "name": "Skill", "input": {"skill": "api-design"}}]}}, separators=(",", ":")).encode(), 0)
watcher.inside_line(state, json.dumps({"type": "system", "subtype": "stop_hook_summary", "hookErrors": [SECRET, SECRET]},
                                     separators=(",", ":")).encode(), 0)
summary = watcher.inside_summary(state)
check("hook runs, errors and time are counted, and the skills called are named",
      (summary.get("hk"), summary.get("hb"), summary.get("hm"), summary.get("sk")) == (3, 3, 200, ["api-design"])
      and SECRET not in json.dumps(summary))
# Codex tool calls: the names from the session file, nothing of the arguments.
write(os.path.join(box, "cx", "sessions", "2026", "01", "01", "rollout-a.jsonl"), "".join(json.dumps(
    {"type": "response_item", "payload": {"type": kind, "name": name, "arguments": SECRET, "input": SECRET}}) + "\n"
    for kind, name in (("custom_tool_call", "exec"), ("custom_tool_call", "exec"), ("function_call", "spawn_agent"), ("message", "no"))))
tools = watcher.codex_tools(os.path.join(box, "cx"))
check("Codex tool calls are counted by name", tools == {"tl": [["exec", 2], ["spawn_agent", 1]], "tn": 3})
check("a folder with no setup gives nothing", watcher.setup_inventory(os.path.join(box, "codex")) == {})

with contextlib.redirect_stderr(errors):
    names = watcher.claude_names()
check("two sessions that edited one file in the last 6 hours overlap on it, an older edit does not",
      "overlap 1" in names[101][3] and "overlap 1" in names[102][3]
      and watcher.INSIDE[SID].get("fo") == [["app.py", "web-9c"]] and watcher.INSIDE[OTHER].get("fo") == [["app.py", "api-3f"]])

# The hive data: written into the made-up folder, not next to the real script.
watcher.__file__ = os.path.join(box, "scripts", "label-tabs.py")
os.makedirs(os.path.dirname(watcher.__file__), exist_ok=True)
tree = {"windows": [{"ref": "workspace:1", "id": "ws-1", "description": space, "selected": True,
                     "panes": [{"ref": "surface:1", "id": "tab-1", "focused": True}, {"ref": "surface:2", "id": "tab-2"}]}]}
live = [("TAB-1", "api-3f", None, False, names[101][3], "working", 0), ("TAB-2", "web-9c", None, False, names[102][3], "working", 0)]
with contextlib.redirect_stderr(errors):
    watcher.write_hive(tree, live, {"TAB-2": "[web-9c] zsh"}, None, {
        "TAB-1": (watcher.INSIDE.get(SID, {}), watcher.FOLDERS.get(SID, ""), "Fix the login test"),
        "TAB-2": (watcher.INSIDE.get(OTHER, {}), watcher.FOLDERS.get(OTHER, ""))})
with open(os.path.join(box, "scripts", "hive-data.js")) as fh:
    hive_text = fh.read()
hive = json.loads(hive_text[hive_text.index("(", hive_text.index("hiveLive(")) + 1:hive_text.rindex(")")])
first = hive["a"][0]
check("the hive agent gets the counts", first.get("tn") == 5 and first.get("fo") == [["app.py", "web-9c"]] and first.get("sa") == 1
      and first.get("m") == "Fable 5.2 high")
# The views name a session by its title, as the panel does; a session with no title keeps the title of its tab.
check("the hive agent is named by the session title, else by its tab", first.get("n") == "[api-3f] Fix the login test"
      and hive["a"][1].get("n") == "[web-9c] zsh")
check("a workspace gets the inventory of the start folder of its first session", hive["ws"][0].get("inv") == inventory)

with open(inside_file) as fh:
    stored = fh.read()
outputs = [stored, hive_text, json.dumps(watcher.INSIDE), json.dumps(names), errors.getvalue()]
check("no message text, tool input, tool output or settings value reaches any output", not any(SECRET in out for out in outputs))

DEAD = "77777777-2222-3333-4444-555555555555"
write(os.path.join(cache, DEAD + ".inside"), "{}", age=15 * 86400)
os.utime(inside_file, (time.time() - 15 * 86400, time.time() - 15 * 86400))
watcher.clean_cache({SID})
check("an old counts file of an ended session goes, a live session's stays",
      not os.path.exists(os.path.join(cache, DEAD + ".inside")) and os.path.exists(inside_file))

# A workspace whose description holds no folder must not get its label text as a name: the views group by that name.
tree = {"ref": "workspace:1", "id": "w1", "title": "some tab title", "description": "| api-3f: Fable 5.2 high",
        "panes": [{"ref": "surface:1", "id": "t1"}]}
check("a workspace with no folder in its description takes the start folder of its first session",
      watcher.hive_places(tree, {"T1": "/home/me/shop-api/"})[1]["W1"][0] == "shop-api")
check("with no session folder it takes the cmux title, never the label text",
      watcher.hive_places(tree)[1]["W1"][0] == "some tab title")
check("a folder in the description still names the workspace",
      watcher.hive_places(dict(tree, description="/home/me/web | api-3f: x"), {"T1": "/home/me/shop-api"})[1]["W1"][0] == "web")

check("a description that cmux trimmed to \"| ...\" gets its empty folder part back, so no session part is kept as the folder",
      watcher.description_of({"description": "| api-3f: x | web-1: y"}).split(" | ") == ["", "api-3f: x", "web-1: y"]
      and watcher.description_of({"description": "/home/me/web | api-3f: x"}) == "/home/me/web | api-3f: x")

# The extra tools of the start menu: the built-in list, and the user file ~/.config/cmux/agents-tools.
tools_home = os.path.join(box, "tools-home")
os.makedirs(os.path.join(tools_home, ".gemini"))
os.makedirs(os.path.join(tools_home, ".mytool"))
os.makedirs(os.path.join(tools_home, ".config", "cmux"))
saved_home = os.environ.get("HOME")
os.environ["HOME"] = tools_home
try:
    check("a built-in tool is listed when its folder exists, and one with no folder is not",
          watcher.read_tools() == [("gemini", "gemini", "Gemini CLI")])
    check("the description part names it as id=command=label", watcher.tools_part() == "@tools: gemini=gemini=Gemini CLI")
    bad_lines = ["tool a $(id) ~/.mytool Aaa", "tool b a;b ~/.mytool Bbb", "tool c ../x ~/.mytool Ccc", "tool d x y ~/.mytool Ddd",
                 "tool e ok ~/.mytool $(id)", "tool f ok /etc Fff", "tool g ok ~/../x Ggg", "tool claude ok ~/.mytool Claude",
                 "tool H ok ~/.mytool Hhh", "tool i ok ~/.mytool", "tool j ok .mytool Jjj", "tool k " + "x" * 25 + " ~/.mytool Kkk",
                 "tool l ok ~/.mytool Label`x`", "tool m ok ~/.mytool " + "L" * 21]
    with open(os.path.join(tools_home, ".config", "cmux", "agents-tools"), "w") as fh:
        fh.write("# a comment\n\n" + "\n".join(bad_lines) + "\ntool mytool my-tool ~/.mytool My Tool\ntool gemini gem ~/.gemini Gem Two\n")
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        found = watcher.read_tools()
    check("only the plain user lines are taken, and a user line replaces the built-in entry of the same id",
          found == [("gemini", "gem", "Gem Two"), ("mytool", "my-tool", "My Tool")])
    check("each bad user line is named by its number in one stderr line and its text is not echoed",
          err.getvalue().count("skipped") == len(bad_lines) and "$(id)" not in err.getvalue())
finally:
    if saved_home is None:
        del os.environ["HOME"]
    else:
        os.environ["HOME"] = saved_home

print("OK: all history checks passed" if not failed else f"FAILED: {failed} check(s)")
sys.exit(1 if failed else 0)
