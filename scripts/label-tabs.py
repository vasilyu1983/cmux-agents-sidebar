#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""One pass: puts the Claude Code session name in front of its cmux tab title, as "[api-3f] title".
A session that waits for the owner gets a mark: "[api-3f !] title".
A busy session whose transcript got no line for 20 minutes gets "[api-3f ?] title": it may have stalled.

The name is the one other sessions message; it comes from ~/.claude/sessions/<pid>.json.
A label whose session has gone is removed. Other tabs are left alone (cmux already shows an icon per tool).
It also keeps a sidebar row "needs-you" on each workspace: the sessions there that wait for the owner, and why.

It writes hive-data.js next to itself: the hive page reads that file to stay current.
It deletes hand-over files of ended sessions in ~/.cache/cmux-agents that are older than 14 days.

A process is matched to its tab by the CMUX_SURFACE_ID in its environment (the tty in the cmux tree can be stale).
A tab of a tool that publishes no session state (Codex, OpenCode) gets "screen working", "screen asks" or
"screen idle" from the last lines on its screen; only that word is kept.
Run it inside cmux (it needs the cmux socket).

With ~/.config/cmux/agents-accounts it also reads the sessions of the account folders listed there
("account claude work ~/.claude-work") and tags them: the field "acct work" after the model, and a 6th part
with the account name on that account's limit items. Without that file nothing changes.

With --next-waiting it changes nothing: it prints "<workspace id> <tab id>" of the session that has waited
for the owner the longest, or nothing when no session waits.
"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time

DERIVED_NAME = r"[a-z0-9]+-[0-9a-f]{2}"
QUIET_SECONDS = 20 * 60
KEEP_SECONDS = 14 * 86400
SESSION_ID = r"[0-9a-f-]{8,64}"
HIVE_STATUS = {"waiting": "needs_input", "busy": "working", "idle": "idle"}
SURFACE_ENV = re.compile(r" CMUX_SURFACE_ID=([0-9A-Fa-f-]{36})(?: |$)")
ACCOUNT_NAME = r"[a-z0-9-]{1,16}"
ACCOUNT_TOOLS = ("claude", "codex", "opencode")
ACCOUNTS = []  # (tool, name, folder) per valid "account" line of the accounts file, in file order
DEFAULT_ACCOUNT = []  # the name of the "default" line, when it has one
RULES = []  # (folder prefix, account name) per "rule" line
TAB_ACCOUNTS = {}  # surface id -> account name, for a Codex process that runs with a listed account folder
CODEX_ENV = re.compile(r" CODEX_HOME=([^ ]{1,300})(?: |$)")
SHARED_BRANCHES = {"main", "master", "dev", "develop", "trunk"}  # two sessions on one of these are not a duplicate
NEXT_LINE = re.compile(r"^[\s*_`>-]{0,6}Next:[\s*_`]{0,4}(.+)$", re.M)
GIT_MARKS = {}  # folder -> (branch, commits that no remote holds), for one pass
# Tools that publish no session state: their tab gets "screen working|asks|idle" from the last lines on screen.
# The name is matched against the file name of the process's program ("codex", "codex-..."); the names are not
# checked against a live process list.
SCREEN_TOOLS = ("codex", "opencode", "grok", "agy")
SCREEN_LINES = 30
# Fixed interface lines only; no screen text is kept or shown. Codex prints "• Working (12s • esc to interrupt)".
SCREEN_WORKING = re.compile(r"\besc to interrupt\b", re.I)
# A permission or option menu: a first option line ("› 1. Yes, proceed") and a line that offers to allow.
SCREEN_MENU = re.compile(r"^\s*(❯|›|>)?\s*1\.\s")
SCREEN_ALLOW = re.compile(r"\b(yes|allow|approve)\b", re.I)


def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=10)


def surfaces(node, found, workspace=None):
    if isinstance(node, dict):
        ref = str(node.get("ref", ""))
        if ref.startswith("workspace:"):
            workspace = ref
        if node.get("id") and ref.startswith("surface:"):
            found[node["id"].upper()] = (ref, node.get("title") or "", workspace)
        for value in node.values():
            surfaces(value, found, workspace)
    elif isinstance(node, list):
        for value in node:
            surfaces(value, found, workspace)


def read_accounts():
    """Fills ACCOUNTS and DEFAULT_ACCOUNT from ~/.config/cmux/agents-accounts. The lines:
    "account <claude|codex|opencode> <name> <folder>", "rule <folder prefix> <name>" (for the launcher; not used
    here) and "default <name>". A folder must resolve to a place inside the home folder (a symlink or ".." that
    leaves it is refused). A bad line is skipped and named by its number only. No file: nothing is listed."""
    try:
        with open(os.path.expanduser("~/.config/cmux/agents-accounts")) as fh:
            lines = fh.read(20000).splitlines()
    except FileNotFoundError:
        return
    except (OSError, ValueError) as err:
        print(f"label-tabs: accounts file not read: {err}", file=sys.stderr)
        return
    home = os.path.realpath(os.path.expanduser("~"))
    for number, line in enumerate(lines, 1):
        words = line.split()
        if not words or words[0].startswith("#"):
            continue
        good = False
        if words[0] == "account" and len(words) == 4 and words[1] in ACCOUNT_TOOLS:
            folder = os.path.realpath(os.path.expanduser(words[3]))
            good = (bool(re.fullmatch(ACCOUNT_NAME, words[2])) and words[3].startswith(("~/", "/"))
                    and folder.startswith(home + "/")
                    and not any(tool == words[1] and (name == words[2] or place == folder)
                                for tool, name, place in ACCOUNTS))
            if good:
                ACCOUNTS.append((words[1], words[2], folder))
        elif words[0] == "rule":
            # The name is the last word, so the folder prefix may hold spaces (the launcher reads it the same way).
            good = len(words) >= 3 and bool(re.fullmatch(ACCOUNT_NAME, words[-1]))
            if good:
                RULES.append((os.path.expanduser(" ".join(words[1:-1])).rstrip("/"), words[-1]))
        elif words[0] == "default":
            good = len(words) == 2 and bool(re.fullmatch(ACCOUNT_NAME, words[1])) and not DEFAULT_ACCOUNT
            if good:
                DEFAULT_ACCOUNT.append(words[1])
        if not good:
            print(f"label-tabs: accounts file: line {number} skipped", file=sys.stderr)


def wrong_account(session, account):
    """["wrong <name>"] when the folder rules name another account for the start folder of a Claude Code session
    than the one it runs on; [] without rules. `account` is "" for the normal folder. A rule name with no
    Claude Code account line means the normal folder, as in the launcher."""
    cwd = str(session.get("cwd") or "")
    if not RULES or not cwd.startswith("/"):
        return []
    best = max((rule for rule in RULES if cwd == rule[0] or cwd.startswith(rule[0] + "/")),
               key=lambda rule: len(rule[0]), default=None)
    wanted = best[1] if best else (DEFAULT_ACCOUNT[0] if DEFAULT_ACCOUNT else "")
    listed = {name for tool, name, _folder in ACCOUNTS if tool == "claude"}
    if (wanted if wanted in listed else "") == account:
        return []
    return [f"wrong {wanted}"] if re.fullmatch(ACCOUNT_NAME, wanted) else []


def transcript_marks(sid, home):
    """["comp 3", "next you push both repos", "prompt fix the login test"] from the transcript of a Claude Code
    session: how often its context was compacted, the last "Next: ..." line of its last reply, and the start of the
    last request that the user typed. Only the part of the file that is new since the last pass is read; the
    position, the count, the line and the request are kept in ~/.cache/cmux-agents/<sid>.seen (mode 600; an older
    file without the request is read as one with an empty request). A new request from the user, or a reply
    without such a line, clears the line. A text block that starts with "<" (a system reminder, a command wrapper)
    is not a request; a tool result has no text block. Also "title Fix the login test": the title that Claude Code
    gave the session (its "ai-title" record), or the one the user set with /rename ("custom-title"). A state file
    from before the title was kept is read again from the start of the transcript, once."""
    found = glob.glob(os.path.join(home, "projects", "*", f"{sid}.jsonl"))
    if not found:
        return []
    seen = os.path.expanduser(f"~/.cache/cmux-agents/{sid}.seen")
    offset, count, step, prompt, title, named = 0, 0, "", "", "", False
    try:
        with open(seen) as fh:
            parts = fh.read(500).rstrip("\n").split("\t")
        if len(parts) > 5:
            offset, count, step, prompt = int(parts[0]), int(parts[1]), parts[2], parts[3]
            title, named = parts[4], parts[5] == "1"
    except (OSError, ValueError, IndexError):
        pass  # no state yet, or a damaged one: the file is read from its start
    try:
        size = os.path.getsize(found[0])
        if size < offset:
            offset, count, step, prompt, title, named = 0, 0, "", "", "", False
        if size > offset:
            with open(found[0], "rb") as fh:
                fh.seek(offset)
                data = fh.read()
            data = data[:data.rfind(b"\n") + 1]
            start = offset
            for line in data.splitlines(keepends=True):
                start += len(line)
                if b'"isCompactSummary":true' in line:
                    count += 1
                # A title that the user set stays; a title from the tool follows the tool.
                if b'"type":"custom-title"' in line or (b'"type":"ai-title"' in line and not named):
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    custom = record.get("type") == "custom-title"
                    text = clean(" ".join(str(record.get("customTitle" if custom else "aiTitle") or "").split()), 48)
                    if text:
                        title, named = text, custom
                    continue
                # The reply text matters only near the end of the file; older lines are not parsed.
                if size - start > 2_000_000 or b'"isSidechain":true' in line:
                    continue
                if not (b'"type":"assistant"' in line or b'"type":"user"' in line):
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                content = (record.get("message") or {}).get("content")
                blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
                text = "\n".join(str(b.get("text") or "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
                if not text.strip() or record.get("isCompactSummary") or record.get("isMeta"):
                    continue
                if record.get("type") == "assistant":
                    lines = NEXT_LINE.findall(text)
                    step = clean(re.sub(r"[`*_]", "", lines[-1]), 70) if lines else ""
                elif record.get("type") == "user":
                    asked = " ".join(str(b.get("text") or "") for b in blocks if isinstance(b, dict)
                                     and b.get("type") == "text" and not str(b.get("text") or "").lstrip().startswith("<"))
                    # Runs of spaces, tabs and line breaks become one space, so no tab or line break reaches the file.
                    if asked.strip():
                        step = ""  # only a typed request clears the line, not a reminder that the system adds
                        prompt = clean(" ".join(asked.split()), 61)
                        if len(prompt) > 60:
                            prompt = prompt[:59].rstrip() + "…"  # a cut request shows that it is cut
            offset += len(data)
            fd = os.open(seen, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(f"{offset}\t{count}\t{step}\t{prompt}\t{title}\t{1 if named else 0}\n")
    except OSError as err:
        print(f"label-tabs: transcript of {sid}: {err}", file=sys.stderr)
    return (([f"comp {count}"] if count else []) + ([f"next {step}"] if step else [])
            + ([f"prompt {prompt}"] if prompt else []) + ([f"title {title}"] if title else []))


def screen_state(text):
    """"working", "asks" or "idle" for the text of a tab, from the fixed lines of the tool's interface in its last
    SCREEN_LINES lines. A line that says how to interrupt wins over a menu. The text itself is not kept."""
    lines = text.splitlines()[-SCREEN_LINES:]
    if any(SCREEN_WORKING.search(line) for line in lines):
        return "working"
    if any(SCREEN_MENU.match(line) for line in lines) and any(SCREEN_ALLOW.search(line) for line in lines):
        return "asks"
    return "idle"


def screen_marks(keys, by_id, models):
    """Adds "<tab id>: screen working" (or asks, idle) to `models` for each tab id in `keys`: one read-screen call
    per tab. A failed call skips its tab and names only the tab ref; after a call that cannot run or times out,
    no other tab is read in this pass."""
    for key in sorted(keys):
        ref, _title, workspace = by_id[key]
        try:
            shown = run(["cmux", "read-screen", "--surface", ref, "--lines", str(SCREEN_LINES)])
        except (OSError, subprocess.TimeoutExpired) as err:
            print(f"label-tabs: screen not read for {ref}: {err}", file=sys.stderr)
            return
        if shown.returncode != 0:
            print(f"label-tabs: screen not read for {ref}: exit {shown.returncode}", file=sys.stderr)
            continue
        models.setdefault(workspace, []).append(f"{key}: screen {screen_state(shown.stdout)}")


def git_marks(folder):
    """(branch, commits of HEAD that no remote holds) for a folder; ("", 0) outside a repository, on a detached
    HEAD, or in a repository without remote branches. Asked once per folder and pass."""
    if folder not in GIT_MARKS:
        mark = ("", 0)
        try:
            ask = lambda *args: subprocess.run(["git", "-C", folder, *args], capture_output=True, text=True, timeout=3,
                                               env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
            branch = ask("symbolic-ref", "--short", "-q", "HEAD")
            if branch.returncode == 0 and branch.stdout.strip():
                ahead = 0
                if ask("for-each-ref", "--count=1", "refs/remotes").stdout.strip():
                    counted = ask("rev-list", "--count", "HEAD", "--not", "--remotes").stdout.strip()
                    ahead = int(counted) if counted.isdigit() else 0
                mark = (branch.stdout.strip(), ahead)
        except (OSError, subprocess.TimeoutExpired) as err:
            print(f"label-tabs: git in {folder}: {err}", file=sys.stderr)
        GIT_MARKS[folder] = mark
    return GIT_MARKS[folder]


def homes(tool, usual):
    """[(folder, account name)] for one tool: its usual folder first ("" when no line lists that folder),
    then the other listed folders in file order."""
    usual = os.path.expanduser(usual)
    listed = [(folder, name) for kind, name, folder in ACCOUNTS if kind == tool]
    own = next((name for folder, name in listed if folder == os.path.realpath(usual)), "")
    return [(usual, own)] + [(folder, name) for folder, name in listed if name != own]


def claude_names():
    names, newest, places = {}, {}, {}
    prs = open_prs()
    for home, account in homes("claude", "~/.claude"):
        for path in glob.glob(os.path.join(home, "sessions", "*.json")):
            try:
                with open(path) as fh:
                    session = json.load(fh)
                at = os.path.getmtime(path)
            except (OSError, ValueError) as err:
                print(f"label-tabs: skipped {path}: {err}", file=sys.stderr)
                continue
            if not (session.get("name") and isinstance(session.get("pid"), int)):
                continue
            # A pid can be on record in two account folders (one record is stale): the newer record wins.
            if newest.get(session["pid"], -1) > at:
                continue
            newest[session["pid"]] = at
            waits = session.get("waitingFor") or "input" if session.get("status") == "waiting" else None
            since = session.get("statusUpdatedAt")
            names[session["pid"]] = (session["name"], waits, session.get("status") == "busy" and quiet(session, home),
                                     model_of(session, prs, home, account), HIVE_STATUS.get(session.get("status"), ""),
                                     since if isinstance(since, (int, float)) else 0, str(session.get("sessionId") or ""))
            sid, cwd = str(session.get("sessionId") or ""), str(session.get("cwd") or "")
            fields = names[session["pid"]][3]
            if re.fullmatch(SESSION_ID, sid):
                fields += transcript_marks(sid, home)
            if cwd.startswith("/") and os.path.isdir(cwd):
                branch, ahead = git_marks(cwd)
                if ahead:
                    fields.append(f"ahead {min(ahead, 999)}")
                if branch and branch not in SHARED_BRANCHES:
                    places.setdefault((cwd, branch), {})[session["pid"]] = fields
    # Two live sessions in one folder on one work branch: both get "dup".
    for group in places.values():
        if len(group) > 1:
            for fields in group.values():
                fields.append("dup")
    return names


def clean_cache(live_ids):
    """Deletes hand-over files older than KEEP_SECONDS. Only regular files whose name is a session id, or a
    session id with ".seen";
    a symlink is never followed; the file of a session that still runs stays."""
    folder = os.path.expanduser("~/.cache/cmux-agents")
    try:
        entries = list(os.scandir(folder))
    except FileNotFoundError:
        return
    except OSError as err:
        print(f"label-tabs: cannot list {folder}: {err}", file=sys.stderr)
        return
    for entry in entries:
        try:
            sid = entry.name[:-5] if entry.name.endswith(".seen") else entry.name
            if (not re.fullmatch(SESSION_ID, sid) or sid in live_ids
                    or not entry.is_file(follow_symlinks=False)
                    or time.time() - entry.stat(follow_symlinks=False).st_mtime < KEEP_SECONDS):
                continue
            os.unlink(entry.path)
        except OSError as err:
            print(f"label-tabs: cannot delete {entry.path}: {err}", file=sys.stderr)


def hive_places(tree):
    """tab id -> (workspace id, tab focused in the selected workspace), and workspace id -> (name, selected)."""
    tabs, spaces = {}, {}

    def walk(node, space=None, selected=False):
        if isinstance(node, dict):
            ref = str(node.get("ref", ""))
            if ref.startswith("workspace:") and node.get("id"):
                space, selected = str(node["id"]).upper(), bool(node.get("selected"))
                folder = str(node.get("description") or "").split(" | ")[0].rstrip("/")
                spaces[space] = (folder.rsplit("/", 1)[-1] or str(node.get("title") or "workspace"), selected)
            if ref.startswith("surface:") and node.get("id") and space:
                tabs[str(node["id"]).upper()] = (space, bool(selected and node.get("focused")))
            for value in node.values():
                walk(value, space, selected)
        elif isinstance(node, list):
            for value in node:
                walk(value, space, selected)

    walk(tree)
    return tabs, spaces


def hive_agent(fields):
    """The description fields of one session, as the hive page's keys: m model, x context %, c cost, p PR,
    l lane, u account, q compactions, ch subagents (the running ones by name, the finished ones as a count)."""
    agent = {"k": "claude"}
    for field in fields:
        sub = re.fullmatch(r"sub (\d{1,4})/(\d{1,4})(?:: (.*))?", field)
        if sub:
            running, total = int(sub.group(1)), int(sub.group(2))
            named = [name for name in (sub.group(3) or "").split("; ") if name]
            agent["ch"] = [{"n": name, "r": True} for name in named]
            if running > len(named):
                agent["ch"].append({"n": f"+{running - len(named)} more running", "r": True})
            if total > running:
                agent["ch"].append({"n": f"{total - running} finished", "r": False})
        elif re.fullmatch(r"ctx \d{1,3}%", field):
            agent["x"] = int(field[4:-1])
        elif field.startswith("$"):
            agent["c"] = field
        elif field.startswith("pr "):
            agent["p"] = field[3:]
        elif field.startswith("lane "):
            agent["l"] = field[5:]
        elif field.startswith("acct "):
            agent["u"] = field[5:]
        elif re.fullmatch(r"comp \d{1,4}", field):
            agent["q"] = int(field[5:])
        elif not field.startswith(("cold ", "waits ", "comp ", "next ", "ahead ", "wrong ", "prompt ", "title ", "screen ")) and field != "dup" and "m" not in agent:
            agent["m"] = field
    return agent


def write_hive(tree, live, titles):
    """Writes hive-data.js next to this script: the Claude Code sessions, their tabs and the open tab.
    The hive page loads it every 15 seconds. It holds session titles, so it is readable by the owner only."""
    tabs, spaces = hive_places(tree)
    agents = []
    for key, name, _waits, _stalled, model, status, _since in live:
        if key not in tabs:
            continue
        agent = hive_agent(model)
        agent.update(i=key, w=tabs[key][0], s=status, n=titles.get(key) or f"[{name}]", f=tabs[key][1])
        agents.append(agent)
    data = {"t": int(time.time()), "cur": next((tab for tab, (_space, focused) in tabs.items() if focused), ""),
            "ws": [{"w": space, "n": name, "f": selected} for space, (name, selected) in spaces.items()], "a": agents,
            "tabs": sorted(tabs)}
    folder = os.path.dirname(os.path.abspath(__file__))
    # The change time of the page file: an open page reloads itself when this value changes (after an install).
    page = os.path.join(folder, "hive.html")
    data["h"] = int(os.path.getmtime(page)) if os.path.exists(page) else 0
    try:
        handle, path = tempfile.mkstemp(dir=folder, prefix=".hive-data.")  # mkstemp makes the file with mode 600
        with os.fdopen(handle, "w") as fh:
            fh.write("window.hiveLive && window.hiveLive(" + json.dumps(data).replace("<", "\\u003c") + ");\n")
        os.replace(path, os.path.join(folder, "hive-data.js"))
    except OSError as err:
        print(f"label-tabs: hive data not written: {err}", file=sys.stderr)


HISTORY_SECONDS = 30 * 86400  # the Rhythm view shows a month of days; the other views show one week at most
HISTORY_SAMPLE = 60  # seconds between two context and cost samples of one session
HISTORY_GAP = 60  # a longer silence of the watcher (sleep, a stopped watcher) ends a block of the timeline
HISTORY_BLOCKS = 20000
HISTORY_STATES = ("working", "needs_input", "idle")


def subagent_runs(sids):
    """[[session id, agent type, start, end]] per subagent record of the sessions, from the times of its transcript
    file: made at the start, changed at the last line. It reads no content of a transcript."""
    runs = []
    for home, _account in homes("claude", "~/.claude"):
        for sid in sids:
            for meta in glob.glob(os.path.join(home, "projects", "*", sid, "subagents", "*.meta.json")):
                try:
                    with open(meta) as fh:
                        record = json.load(fh)
                    times = os.stat(meta[:-len(".meta.json")] + ".jsonl")
                except (OSError, ValueError):
                    continue
                kind = re.sub(r"[^\w .-]", "", str(record.get("agentType") or "subagent") if isinstance(record, dict) else "subagent")
                start = int(getattr(times, "st_birthtime", times.st_mtime))
                runs.append([sid, kind[:28] or "subagent", start, max(start, int(times.st_mtime))])
    return runs


def history_step(old, rows, readings, now, runs=()):
    """The history for the views page after one pass of the watcher.
    old: the history before (any value; a broken one counts as empty).
    rows: (session id, name, workspace name, state, model, context %, cost, account[, compactions, cold cache])
    per live Claude Code session. readings: LIMIT_READINGS of this pass. runs: subagent_runs of this pass.
    Result: {"t": now, "s": {session id: {n, w, m, x, c, u, q, k}}, "b": [[session id, state, start, end], ...],
    "l": [[tool, window, account, used, reset, seen], ...], "p": [[session id, time, context % or None, cost], ...],
    "e": [[session id, "compact" or "cold", time], ...], "g": [[session id, agent type, start, end], ...]}.
    A block grows while its session keeps its state and the watcher keeps running. p has one sample per session
    and minute at most, and only when a figure changed. e has a mark when the compaction count rose or the prompt
    cache went cold; the first pass that sees a session only notes its figures.
    It holds names, states, times, costs and limit figures: no request and no reply text."""
    old = old if isinstance(old, dict) else {}
    blocks = [b for b in old.get("b", []) if isinstance(b, list) and len(b) == 4 and isinstance(b[2], (int, float))
              and isinstance(b[3], (int, float)) and b[3] >= now - HISTORY_SECONDS]
    last = {}  # session id -> its newest block
    for block in blocks:
        if block[0] not in last or block[3] >= last[block[0]][3]:
            last[block[0]] = block
    sessions = {sid: info for sid, info in (old.get("s") or {}).items() if sid in last and isinstance(info, dict)}
    keep = now - HISTORY_SECONDS
    samples = [p for p in old.get("p", []) if isinstance(p, list) and len(p) == 4 and isinstance(p[1], (int, float)) and p[1] >= keep]
    events = [e for e in old.get("e", []) if isinstance(e, list) and len(e) == 3 and isinstance(e[2], (int, float)) and e[2] >= keep]
    newest = {p[0]: p for p in samples}  # session id -> its newest sample
    for sid, name, space, state, model, ctx, cost, account, *marks in rows:
        if state not in HISTORY_STATES or not re.fullmatch(SESSION_ID, str(sid)):
            continue
        before = sessions.get(sid, {})
        count = marks[0] if marks and isinstance(marks[0], int) else before.get("q")
        cold = bool(marks[1]) if len(marks) > 1 else False
        if isinstance(count, int) and isinstance(before.get("q"), int) and count > before["q"]:
            events.append([sid, "compact", now])
        if cold and before.get("k") is False:
            events.append([sid, "cold", now])
        paid = re.fullmatch(r"\$?(\d{1,6}(?:\.\d{1,2})?)", str(cost))
        share = ctx if isinstance(ctx, int) and not isinstance(ctx, bool) else None
        if paid or share is not None:
            sample, prior = [sid, now, share, float(paid.group(1)) if paid else None], newest.get(sid)
            if not prior or (prior[2:] != sample[2:] and now - prior[1] >= HISTORY_SAMPLE):
                samples.append(sample)
                newest[sid] = sample
        block = last.get(sid)
        if block and block[1] == state and now - block[3] <= HISTORY_GAP:
            block[3] = now
        else:
            # The new block starts where the previous one ended, when the watcher ran through the change.
            start = block[3] if block and now - block[3] <= HISTORY_GAP else now
            block = [sid, state, start, now]
            blocks.append(block)
            last[sid] = block
        sessions[sid] = {"n": str(name)[:60], "w": str(space)[:60], "m": str(model)[:40], "x": ctx, "c": str(cost)[:16],
                         "u": str(account)[:16], "q": count, "k": cold}
    # A subagent run is known by its session and start; a newer pass brings its newer end.
    known = {}
    for run_ in list(old.get("g", [])) + [list(r) for r in runs]:
        if isinstance(run_, list) and len(run_) == 4 and isinstance(run_[2], (int, float)) and isinstance(run_[3], (int, float)) and run_[3] >= keep:
            known[(run_[0], run_[2])] = run_
    seen = set()
    limits = []
    for item in list(old.get("l", [])) + [list(r) for r in readings]:
        if not (isinstance(item, list) and len(item) == 6 and isinstance(item[5], (int, float))):
            continue
        key = (item[0], item[1], item[2], item[5])  # one reading per figure, however often the watcher saw it
        if key in seen or item[5] < now - HISTORY_SECONDS - 86400:
            continue
        seen.add(key)
        limits.append(item)
    return {"t": int(now), "s": sessions, "b": blocks[-HISTORY_BLOCKS:], "l": limits[-5000:], "p": samples[-HISTORY_BLOCKS:],
            "e": events[-2000:], "g": sorted(known.values(), key=lambda r: r[2])[-5000:]}


def write_history(rows):
    """Keeps history-data.js next to this script: the file that the Timeline, Limits and Rhythm views draw.
    Readable by the owner only. A failure here must never stop the tab labels."""
    folder = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(folder, "history-data.js")
    head, tail = "window.hiveHistory && window.hiveHistory(", ");\n"
    old = {}
    try:
        with open(target) as fh:
            text = fh.read()
        if text.startswith(head) and text.endswith(tail):
            old = json.loads(text[len(head):-len(tail)])
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as err:
        print(f"label-tabs: history not read, a new one starts: {err}", file=sys.stderr)
    try:
        data = history_step(old, rows, LIMIT_READINGS, int(time.time()), subagent_runs([row[0] for row in rows]))
        handle, path = tempfile.mkstemp(dir=folder, prefix=".history-data.")  # mkstemp makes the file with mode 600
        with os.fdopen(handle, "w") as fh:
            fh.write(head + json.dumps(data, separators=(",", ":")).replace("<", "\\u003c") + tail)
        os.replace(path, target)
    except (OSError, ValueError, TypeError) as err:
        print(f"label-tabs: history not written: {err}", file=sys.stderr)


WEEKS = {}  # account name ("" = not listed) -> its newest hand-over file with the week limit: {"at": mtime, "used": "36"}


def short(tokens):
    return f"{tokens / 1e6:.1f}M" if tokens >= 1e6 else f"{tokens / 1e3:.0f}K" if tokens >= 1000 else str(tokens)


def board_file(name):
    try:
        with open(os.path.join(os.environ.get("TMPDIR", "/tmp"), "agents-board", name)) as fh:
            return fh.read(400000)
    except OSError:
        return ""


def open_prs():
    """lane branch -> "#644 needs grant", from the owner board's last answer of GitHub and of your merge tool."""
    board = os.path.join(os.environ.get("TMPDIR", "/tmp"), "agents-board", "prs.json")
    if not os.path.exists(board) or time.time() - os.path.getmtime(board) > 1800:
        return {}  # the board refreshes every 5 minutes; an answer older than 30 is not shown as a state
    try:
        heads = {pr["headRefName"]: pr["number"] for pr in json.loads(board_file("prs.json") or "[]")}
    except (ValueError, KeyError, TypeError):
        return {}
    verdicts = {}
    for line in board_file("status.txt").splitlines():
        found = re.match(r"  #(\d+) .*grant: (?:none|n/a|live \d+ min left)  (.+)$", line)
        if found:
            verdicts[int(found.group(1))] = clean(found.group(2), 24)
    return {branch: f"#{number} {verdicts.get(number, 'open')}".strip() for branch, number in heads.items()}


def subagents_of(sid, home):
    """The subagents that Claude Code recorded for the session, as one field: "sub 2/7: Explore repo; Review diff".
    2 run now, 7 in all; the names are those of the running ones. A subagent counts as running while its record
    is not finished and its transcript got a line in the last 15 minutes (a killed session leaves it unfinished)."""
    running, total = [], 0
    for meta in glob.glob(os.path.join(home, "projects", "*", sid, "subagents", "*.meta.json")):
        try:
            with open(meta) as fh:
                record = json.load(fh)
            fresh = time.time() - os.path.getmtime(meta[:-len(".meta.json")] + ".jsonl") < 900
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        total += 1
        if not record.get("finished") and fresh:
            name = re.sub(r"[^\w .,-]", "", str(record.get("description") or record.get("agentType") or "subagent"))
            running.append(name.strip()[:28] or "subagent")
    if not total:
        return []
    names = "; ".join(sorted(running)[:5])
    return [f"sub {len(running)}/{total}" + (f": {names}" if names else "")]


def model_of(session, prs, home, account):
    """What the status line script left for the session, as description fields:
    ["Fable 5.2 high", "ctx 42%", "$12.34", "lane lane/x", "pr #644 needs grant", "cold 198K"].
    The file holds "model<TAB>context %<TAB>cost<TAB>lane branch<TAB>cold tokens<TAB>week %<TAB>5h %<TAB>5h reset
    <TAB>week reset<TAB>config folder name"; older files hold fewer parts. `home` is the Claude Code folder that
    holds the session's record and `account` its name in the accounts file ("" when not listed): a listed
    account adds "acct <name>" after the model."""
    sid = str(session.get("sessionId") or "")
    if not re.fullmatch(SESSION_ID, sid):
        return []
    path = os.path.expanduser(f"~/.cache/cmux-agents/{sid}")
    try:
        with open(path) as fh:
            parts = fh.read(300).split("\t")
        at = os.path.getmtime(path)
    except OSError:
        return ([f"acct {account}"] if account else []) + wrong_account(session, account) + subagents_of(sid, home)
    parts += [""] * (10 - len(parts))
    if not account and parts[9]:
        # The record sits in the usual folder: the status line's config folder name decides, when one line has it.
        named = [name for kind, name, folder in ACCOUNTS if kind == "claude" and os.path.basename(folder) == parts[9]]
        account = named[0] if len(named) == 1 else ""
    model = re.sub(r"[^\w .-]", "", parts[0]).strip()
    fields = ([model] if model else []) + ([f"acct {account}"] if account else []) + wrong_account(session, account)
    if re.fullmatch(r"\d{1,3}", parts[1]):
        fields.append(f"ctx {parts[1]}%")
    if re.fullmatch(r"\d{1,6}\.\d\d", parts[2]):
        fields.append(f"${parts[2]}")
    if re.fullmatch(r"[A-Za-z0-9._/-]{1,60}", parts[3]):
        fields.append(f"lane {parts[3][:40]}")
        if parts[3] in prs:
            fields.append(f"pr {prs[parts[3]]}")
    if re.fullmatch(r"\d{1,9}", parts[4]):
        fields.append(f"cold {short(int(parts[4]))}")
    if re.fullmatch(r"\d{1,3}(\.\d+)?", parts[5]) and at > WEEKS.get(account, {}).get("at", 0):
        WEEKS[account] = dict(at=at, used=str(round(float(parts[5]))), five=parts[6], five_reset=parts[7],
                              week_reset=parts[8])
    return fields + subagents_of(sid, home)


def clean(text, limit):
    """Outside text for the description: no control characters and no "|" or "·" (the separators there)."""
    return re.sub(r"[|·\x00-\x1f\x7f]", "", text).strip()[:limit]


def general_marks():
    """The strip parts that need no project: the home folder (the panel builds the link to the hive page from it)
    and the 7-day limit of the account."""
    found = []
    if re.fullmatch(r"/Users/[A-Za-z0-9._-]{1,64}", os.path.expanduser("~")):
        found.append("@home: " + os.path.expanduser("~"))
    week = WEEKS.get("".join(DEFAULT_ACCOUNT)) or max(WEEKS.values(), key=lambda one: one["at"], default=None)
    if week:
        found.append(f"@week: {week['used']}%")
    limits = all_limits()
    warn_limits(limits)
    if limits:
        found.append("@limits: " + ";".join(limits))
    if ACCOUNTS and DEFAULT_ACCOUNT:
        found.append("@primary: " + DEFAULT_ACCOUNT[0])
    if TAB_ACCOUNTS:
        found.append("@accts: " + ",".join(f"{key}={name}" for key, name in sorted(TAB_ACCOUNTS.items())[:200]))
    return found


LIMIT_READINGS = []  # [tool, window, account, share used in %, reset time (epoch, 0 = unknown), time seen] of one pass


def limit_item(tool, window, used, reset, seen, account=""):
    """One limit window for the Limits view of the panel: "claude,5h,42,14:10,1794650000" =
    tool, window, share used in %, local reset time ("ended" when it passed, "" when unknown), time seen (epoch).
    The window of a listed account gets a 6th part, its name: "claude,5h,42,14:10,1794650000,work".
    None when the share is not a number."""
    try:
        used = round(float(used))
    except (TypeError, ValueError):
        return None
    if not 0 <= used <= 999:
        return None
    text = ""
    try:
        reset = float(reset)
        if reset <= time.time():
            text = "ended"
        else:
            text = time.strftime("%H:%M" if reset - time.time() < 86400 else "%a %H:%M", time.localtime(reset))
    except (TypeError, ValueError, OverflowError, OSError):
        text = ""
    try:
        ends = int(float(reset))
    except (TypeError, ValueError, OverflowError):
        ends = 0
    LIMIT_READINGS.append([tool, window, account, used, ends, int(seen)])
    return f"{tool},{window},{used},{text},{int(seen)}" + (f",{account}" if account else "")


def codex_limits(home, account):
    """The limit windows in the newest Codex session file of one Codex folder that holds any: Codex writes
    "rate_limits" into its session records. Reads the file tail only, and keeps the windows, not the plan or the credits."""
    files = glob.glob(os.path.join(home, "sessions", "*", "*", "*", "rollout-*.jsonl"))
    try:
        files.sort(key=os.path.getmtime, reverse=True)
    except OSError:
        return []
    for path in files[:5]:
        try:
            seen = os.path.getmtime(path)
            with open(path, "rb") as fh:
                fh.seek(max(0, os.path.getsize(path) - 400000))
                lines = fh.read().decode("utf-8", "replace").splitlines()
        except OSError as error:
            print(f"label-tabs: codex limits: cannot read a session file: {error}", file=sys.stderr)
            continue
        for line in reversed(lines):
            at = line.rfind('"rate_limits":{')
            if at < 0:
                continue
            try:
                record, _ = json.JSONDecoder().raw_decode(line[at + len('"rate_limits":'):])
            except ValueError:
                continue
            found = []
            for key in ("primary", "secondary"):
                window = record.get(key)
                if not isinstance(window, dict):
                    continue
                minutes = window.get("window_minutes")
                name = {300: "5h", 10080: "week"}.get(minutes, f"{minutes}m" if isinstance(minutes, int) else "")
                item = limit_item("codex", name[:8], window.get("used_percent"), window.get("resets_at"), seen, account)
                if item:
                    found.append(item)
            if found:
                return found
    return []


def warn_limits(items):
    """One cmux notification when a limit window passes 80%. The windows that are at 80% or more are kept in
    ~/.cache/cmux-agents/limit-warned, so each one warns once; a window that drops below 80% can warn again."""
    hot = {}
    for item in items:
        parts = item.split(",")
        if len(parts) >= 5 and parts[2].isdigit() and int(parts[2]) >= 80 and parts[3] != "ended":
            hot[",".join([parts[0], parts[1]] + parts[5:6])] = parts
    path = os.path.expanduser("~/.cache/cmux-agents/limit-warned")
    try:
        with open(path) as fh:
            known = set(fh.read(4000).split("\n"))
    except FileNotFoundError:
        known = set()
    except OSError as err:
        print(f"label-tabs: limit warnings not read: {err}", file=sys.stderr)
        return
    kept = set(hot) & known
    for key in sorted(set(hot) - known):
        parts = hot[key]
        who = " ".join([parts[0].capitalize()] + parts[5:6])
        sent = run(["cmux", "notify", "--title", f"{who}: {parts[1] or 'limit'} window at {parts[2]}%",
                    "--body", f"resets {parts[3]}" if parts[3] else "reset time unknown"])
        if sent.returncode == 0:
            kept.add(key)
        else:
            print(f"label-tabs: limit warning not sent: {sent.stderr.strip()}", file=sys.stderr)
    if kept != known - {""}:
        try:
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600), "w") as fh:
                fh.write("\n".join(sorted(kept)))
        except OSError as err:
            print(f"label-tabs: limit warnings not saved: {err}", file=sys.stderr)


def all_limits():
    """Limit windows of the agent tools on this Mac, from local files only. A tool whose data folder exists
    but that leaves no limit data gets an empty item, and the panel says so."""
    found = []
    for _home, account in homes("claude", "~/.claude"):
        week = WEEKS.get(account)
        if week:
            found.append(limit_item("claude", "5h", week.get("five"), week.get("five_reset"), week["at"], account))
            found.append(limit_item("claude", "week", week["used"], week.get("week_reset"), week["at"], account))
        elif account:
            found.append(f"claude,,,,0,{account}")
    for home, account in homes("codex", "~/.codex"):
        codex = codex_limits(home, account)
        if codex:
            found += codex
        elif os.path.isdir(home):
            found.append("codex,,,,0" + (f",{account}" if account else ""))
    for home, account in homes("opencode", "~/.local/share/opencode"):
        if os.path.isdir(home):
            found.append("opencode,,,,0" + (f",{account}" if account else ""))
    for tool, folder in (("grok", "~/.grok"), ("agy", "~/.antigravity")):
        if os.path.isdir(os.path.expanduser(folder)):
            found.append(f"{tool},,,,0")
    return [item for item in found if item]


def strip_segments(board_runs):
    """workspace ref -> ["@train: ...", "@week: 36%", "@queue: ...", "@unpushed: ..."] for the project strip of the Agents panel.
    A watcher of your own names the workspace and the train text; the owner board keeps its row texts
    in files. Without the watcher's variables the result is empty, and set_models keeps the segments it finds."""
    workspace = os.environ.get("AGENTS_STRIP_WORKSPACE")
    if not workspace:
        return {}
    found = []
    train = clean(os.environ.get("AGENTS_STRIP_TEXT", ""), 90)
    if train:
        found.append("@train: " + re.sub(r"^Train: ", "", train))
    found += general_marks()
    # The board's files outlive a stopped board, so they count only while the board runs.
    for row, name in (("owner-queue", "queue"), ("unpushed", "unpushed")) if board_runs else ():
        try:
            with open(os.path.join(os.environ.get("TMPDIR", "/tmp"), "agents-board", f"row-{row}")) as fh:
                text = clean(fh.read(200), 90)
        except OSError:
            continue
        if text:
            found.append(f"@{name}: " + re.sub(r"^run: ", "", text))
    return {workspace: found}


def workspaces(node, found):
    """ref -> description, for every workspace in the cmux tree."""
    if isinstance(node, dict):
        if str(node.get("ref", "")).startswith("workspace:"):
            found[node["ref"]] = node.get("description") or ""
        for value in node.values():
            workspaces(value, found)
    elif isinstance(node, list):
        for value in node:
            workspaces(value, found)


def set_models(tree, models, strip):
    """Keeps "<text> | @train: ... | api-3f: Fable 5.2 high · ctx 42% · $12.34 · waits permission prompt | ..."
    in each workspace description. The Agents panel reads it: a panel gets the description from cmux, but no file,
    no model and no sidebar row. The text before the first " | " is kept. The "@" segments of a workspace are
    replaced only when `strip` names that workspace."""
    found = {}
    workspaces(tree, found)
    if not strip and found:
        # No watcher names a strip workspace: the workspace that already carries "@home" (else the first one)
        # gets fresh general parts, and keeps its other "@" parts.
        target = next((ref for ref, old in found.items() if " | @home: " in old), next(iter(found)))
        kept = [part for part in found[target].split(" | ")[1:]
                if part.startswith("@") and not part.startswith(("@home: ", "@week: ", "@limits: ", "@primary: ", "@accts: "))]
        strip = {target: kept + general_marks()}
    for workspace, old in found.items():
        parts = old.split(" | ")
        kept = [part for part in parts[1:] if part.startswith("@")]
        # "@view" belongs to the panel (the saved chips, sort and folds): it stays when the strip parts are replaced.
        marks = strip[workspace] + [part for part in kept if part.startswith("@view: ")] if workspace in strip else kept
        wanted = " | ".join(parts[:1] + marks + sorted(models.get(workspace, [])))
        if wanted == old:
            continue
        done = run(["cmux", "workspace-action", "--action", "set-description", "--workspace", workspace,
                    "--description", wanted])
        if done.returncode != 0:
            print(f"label-tabs: description failed for {workspace}: {done.stderr.strip()}", file=sys.stderr)


def quiet(session, home):
    """True when the session's transcript exists and got no line for QUIET_SECONDS."""
    found = glob.glob(os.path.join(home, "projects", "*", f"{session.get('sessionId')}.jsonl"))
    return bool(found) and time.time() - os.path.getmtime(found[0]) > QUIET_SECONDS


def set_needs_you(rows):
    """rows: workspace ref -> text. Calls cmux only for a workspace whose row changed since the last pass."""
    cache = os.path.join(os.environ.get("TMPDIR", "/tmp"), "cmux-needs-you.json")
    try:
        with open(cache) as fh:
            before = json.load(fh)
    except (OSError, ValueError):
        before = {}
    for workspace in set(before) | set(rows):
        text = rows.get(workspace)
        if text == before.get(workspace):
            continue
        if text:
            done = run(["cmux", "set-status", "needs-you", text, "--workspace", workspace,
                        "--icon", "hand.raised.fill", "--color", "#ff9500", "--priority", "90"])
        else:
            done = run(["cmux", "clear-status", "needs-you", "--workspace", workspace])
        if done.returncode != 0 and text:
            print(f"label-tabs: needs-you row failed for {workspace}: {done.stderr.strip()}", file=sys.stderr)
            rows.pop(workspace)  # try again on the next pass
    with open(cache, "w") as fh:
        json.dump(rows, fh)


def main():
    tree = run(["cmux", "tree", "--all", "--json", "--id-format", "both"])
    if tree.returncode != 0:
        sys.exit(f"label-tabs: cmux tree failed: {tree.stderr.strip()}")
    by_id = {}
    tree = json.loads(tree.stdout)
    surfaces(tree, by_id)

    read_accounts()
    names = claude_names()
    live = []  # (surface id, name, waits, stalled, fields, hive status, status time) per Claude Code session in a tab
    labels = {}  # surface id -> label
    waiting = {}  # workspace ref -> ["api-3f permission prompt", ...]
    models = {}  # workspace ref -> ["api-3f: Fable 5.2 high", ...]
    past = []  # (surface id, session id, name, state, fields) per live Claude Code session, for the history
    board_runs = False
    screen_keys = set()  # surface ids of tabs that run a tool of SCREEN_TOOLS
    for line in run(["ps", "eww", "-ax", "-o", "pid=,tty=,command="]).stdout.splitlines():
        board_runs = board_runs or "cmux/scripts/dock-open-prs.sh" in line
        surface = SURFACE_ENV.search(line)
        parts = line.split(None, 2)
        if not surface or len(parts) < 3 or not parts[0].isdigit():
            continue
        key, pid, command = surface.group(1).upper(), int(parts[0]), parts[2]
        # The tool is the program, or the script that an interpreter runs ("node /opt/bin/opencode").
        programs = [os.path.basename(word) for word in command.split(" ", 2)[:2]]
        if any(program == tool or program.startswith(tool + "-") for program in programs for tool in SCREEN_TOOLS):
            screen_keys.add(key)
        codex_home = CODEX_ENV.search(line) if ACCOUNTS else None
        if codex_home and "codex" in command.split(" ", 1)[0]:
            # Only this one variable is read from the environment of the process.
            place = os.path.realpath(codex_home.group(1))
            for tool, account, folder in ACCOUNTS:
                if tool == "codex" and folder == place:
                    TAB_ACCOUNTS[key] = account
        if pid in names and "claude" in command.split(" ", 1)[0]:
            name, waits, stalled, model, status, since, sid = names[pid]
            live.append((key, name, waits, stalled, model, status, since))
            past.append((key, sid, name, status, model))
            fields = model + ([f"waits {clean(waits, 40)}"] if waits else [])
            if fields and key in by_id:
                models.setdefault(by_id[key][2], []).append(f"{name}: " + " · ".join(fields))
            labels[key] = f"[{name} !]" if waits else f"[{name} ?]" if stalled else f"[{name}]"
            if waits and key in by_id:
                waiting.setdefault(by_id[key][2], []).append(f"{name} {waits}")
    if "--next-waiting" in sys.argv[1:]:
        tabs, _spaces = hive_places(tree)
        asked = sorted((since, key) for key, _n, waits, _s, _m, _st, since in live if waits and key in tabs)
        if asked:
            print(tabs[asked[0][1]][0], asked[0][1])
        return
    # A tab with a Claude Code session has the session's state; a tab outside a workspace has no description.
    screen_marks({key for key in screen_keys - set(labels) if key in by_id and by_id[key][2]}, by_id, models)
    set_models(tree, models, strip_segments(board_runs))
    set_needs_you({workspace: ", ".join(sorted(items))[:120] for workspace, items in waiting.items()})

    # A label to strip: a derived name ("api-3f") or the name of a live session (the owner can rename a session
    # to any text). One or more in a row, so a title that got the same label twice is repaired.
    known = "|".join([DERIVED_NAME] + [re.escape(name) for name, *_rest in names.values()])
    old_label = re.compile(rf"^(\[(?:{known})(?: [!?])?\] )+")
    titles = {}  # surface id -> the title that the tab has after this pass
    for key, (ref, title, _workspace) in by_id.items():
        bare = old_label.sub("", title)
        wanted = f"{labels[key]} {bare}" if key in labels else bare
        titles[key] = wanted
        if wanted == title:
            continue
        done = run(["cmux", "rename-tab", "--surface", ref, "--", wanted])
        if done.returncode == 0:
            print(f"{ref}: {wanted}")
        else:
            print(f"label-tabs: rename failed for {ref}: {done.stderr.strip()}", file=sys.stderr)
    write_hive(tree, live, titles)
    tabs, spaces = hive_places(tree)
    rows = []
    for key, sid, name, status, model in past:
        agent = hive_agent(model)
        space = spaces.get(tabs[key][0], ("", False))[0] if key in tabs else ""
        rows.append((sid, name, space, status, agent.get("m", ""), agent.get("x"), agent.get("c", ""), agent.get("u", ""),
                     agent.get("q", 0), any(field.startswith("cold ") for field in model)))
    write_history(rows)
    clean_cache({sid for *_rest, sid in names.values()})


if __name__ == "__main__":
    main()
