#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""One pass: puts the Claude Code session name in front of its cmux tab title, as "[api-3f] title".
A session that waits for the owner gets a mark: "[api-3f !] title".
A busy session whose transcript got no line for 20 minutes gets "[api-3f ?] title": it may have stalled.

The name is the one other sessions message; it comes from ~/.claude/sessions/<pid>.json.
A label whose session has gone is removed. Other tabs are left alone (cmux already shows an icon per tool).
It also keeps a sidebar row "needs-you" on each workspace: the sessions there that wait for the owner, and why.

A process is matched to its tab by the CMUX_SURFACE_ID in its environment (the tty in the cmux tree can be stale).
Run it inside cmux (it needs the cmux socket).
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

DERIVED_NAME = r"[a-z0-9]+-[0-9a-f]{2}"
QUIET_SECONDS = 20 * 60
SURFACE_ENV = re.compile(r" CMUX_SURFACE_ID=([0-9A-Fa-f-]{36})(?: |$)")


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


def claude_names():
    names = {}
    prs = open_prs()
    for path in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
        try:
            with open(path) as fh:
                session = json.load(fh)
        except (OSError, ValueError) as err:
            print(f"label-tabs: skipped {path}: {err}", file=sys.stderr)
            continue
        if session.get("name") and isinstance(session.get("pid"), int):
            waits = session.get("waitingFor") or "input" if session.get("status") == "waiting" else None
            names[session["pid"]] = (session["name"], waits, session.get("status") == "busy" and quiet(session),
                                     model_of(session, prs))
    return names


WEEK = {}  # the newest hand-over file that carries the week limit: {"at": mtime, "used": "36"}


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


def subagents_of(sid):
    """The subagents that Claude Code recorded for the session, as one field: "sub 2/7: Explore repo; Review diff".
    2 run now, 7 in all; the names are those of the running ones. A subagent counts as running while its record
    is not finished and its transcript got a line in the last 15 minutes (a killed session leaves it unfinished)."""
    running, total = [], 0
    for meta in glob.glob(os.path.expanduser(f"~/.claude/projects/*/{sid}/subagents/*.meta.json")):
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


def model_of(session, prs):
    """What the status line script left for the session, as description fields:
    ["Fable 5.2 high", "ctx 42%", "$12.34", "lane lane/x", "pr #644 needs grant", "cold 198K"].
    The file holds "model<TAB>context %<TAB>cost<TAB>lane branch<TAB>cold tokens<TAB>week %"; older files hold fewer parts."""
    sid = str(session.get("sessionId") or "")
    if not re.fullmatch(r"[0-9a-f-]{8,64}", sid):
        return []
    path = os.path.expanduser(f"~/.cache/cmux-agents/{sid}")
    try:
        with open(path) as fh:
            parts = fh.read(240).split("\t")
        at = os.path.getmtime(path)
    except OSError:
        return subagents_of(sid)
    parts += [""] * (6 - len(parts))
    model = re.sub(r"[^\w .-]", "", parts[0]).strip()
    fields = [model] if model else []
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
    if re.fullmatch(r"\d{1,3}(\.\d+)?", parts[5]) and at > WEEK.get("at", 0):
        WEEK.update(at=at, used=str(round(float(parts[5]))))
    return fields + subagents_of(sid)


def clean(text, limit):
    """Outside text for the description: no control characters and no "|" or "·" (the separators there)."""
    return re.sub(r"[|·\x00-\x1f\x7f]", "", text).strip()[:limit]


def general_marks():
    """The strip parts that need no project: the home folder (the panel builds the link to the hive page from it)
    and the 7-day limit of the account."""
    found = []
    if re.fullmatch(r"/Users/[A-Za-z0-9._-]{1,64}", os.path.expanduser("~")):
        found.append("@home: " + os.path.expanduser("~"))
    if WEEK.get("used"):
        found.append(f"@week: {WEEK['used']}%")
    return found


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
                if part.startswith("@") and not part.startswith(("@home: ", "@week: "))]
        strip = {target: kept + general_marks()}
    for workspace, old in found.items():
        parts = old.split(" | ")
        marks = strip.get(workspace, [part for part in parts[1:] if part.startswith("@")])
        wanted = " | ".join(parts[:1] + marks + sorted(models.get(workspace, [])))
        if wanted == old:
            continue
        done = run(["cmux", "workspace-action", "--action", "set-description", "--workspace", workspace,
                    "--description", wanted])
        if done.returncode != 0:
            print(f"label-tabs: description failed for {workspace}: {done.stderr.strip()}", file=sys.stderr)


def quiet(session):
    """True when the session's transcript exists and got no line for QUIET_SECONDS."""
    found = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session.get('sessionId')}.jsonl"))
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

    names = claude_names()
    labels = {}  # surface id -> label
    waiting = {}  # workspace ref -> ["api-3f permission prompt", ...]
    models = {}  # workspace ref -> ["api-3f: Fable 5.2 high", ...]
    board_runs = False
    for line in run(["ps", "eww", "-ax", "-o", "pid=,tty=,command="]).stdout.splitlines():
        board_runs = board_runs or "cmux/scripts/dock-open-prs.sh" in line
        surface = SURFACE_ENV.search(line)
        parts = line.split(None, 2)
        if not surface or len(parts) < 3 or not parts[0].isdigit():
            continue
        key, pid, command = surface.group(1).upper(), int(parts[0]), parts[2]
        if pid in names and "claude" in command.split(" ", 1)[0]:
            name, waits, stalled, model = names[pid]
            fields = model + ([f"waits {clean(waits, 40)}"] if waits else [])
            if fields and key in by_id:
                models.setdefault(by_id[key][2], []).append(f"{name}: " + " · ".join(fields))
            labels[key] = f"[{name} !]" if waits else f"[{name} ?]" if stalled else f"[{name}]"
            if waits and key in by_id:
                waiting.setdefault(by_id[key][2], []).append(f"{name} {waits}")
    set_models(tree, models, strip_segments(board_runs))
    set_needs_you({workspace: ", ".join(sorted(items))[:120] for workspace, items in waiting.items()})

    # A label to strip: a derived name ("api-3f") or the name of a live session (the owner can rename a session
    # to any text). One or more in a row, so a title that got the same label twice is repaired.
    known = "|".join([DERIVED_NAME] + [re.escape(name) for name, _waits, _stalled, _model in names.values()])
    old_label = re.compile(rf"^(\[(?:{known})(?: [!?])?\] )+")
    for key, (ref, title, _workspace) in by_id.items():
        bare = old_label.sub("", title)
        wanted = f"{labels[key]} {bare}" if key in labels else bare
        if wanted == title:
            continue
        done = run(["cmux", "rename-tab", "--surface", ref, "--", wanted])
        if done.returncode == 0:
            print(f"{ref}: {wanted}")
        else:
            print(f"label-tabs: rename failed for {ref}: {done.stderr.strip()}", file=sys.stderr)


if __name__ == "__main__":
    main()
