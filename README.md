# cmux Agents sidebar

A right-sidebar panel for [cmux](https://github.com/manaflow-ai/cmux) that shows every coding-agent session in every workspace, in one list.
You see who waits for you, who works, and who is idle. You click a row to go to that session.

It is made for people who run many agent sessions at the same time: Claude Code, Codex, OpenCode, Grok Build, Antigravity, or any tool that cmux detects.

## What you get

| Part | What it shows |
|------|---------------|
| One band per workspace | Project folder, colour bar, agent count, unread count. A click opens the workspace |
| One row per session | Status dot, tab title, tool tag, time since the last activity. A click goes to the tab |
| `NEEDS YOU` block | All sessions that wait for your input, at the top, with the reason when it is known |
| Filter chips | `!` needs you, `▶` working, `80%` context nearly full, `PR` has a pull request, `1h+` idle for an hour |
| `↑` sort | Sessions that need attention first; the default order is the tab order |
| Subagents | `▸ 2 sub` on a row opens the subagent rows, for tools that report them |
| Details | `›` on a row opens state, tool, folder, branch, ports, first and last request |
| Right-click menu | Go to session, copy name, copy folder, copy PR number, fast commands |
| `hive ↗` | A graph page: workspace → session → subagent, in a cmux browser tab |
| Search | Filters rows by title, tool, workspace or folder |

With the optional Claude Code status line, each Claude Code row also shows the model and effort, the context share (red from 80%), the session cost estimate, a `cold` mark when the prompt cache went cold, and the count line shows the summed cost.

Status colours: orange = waits for you, blue = working, green = idle, grey = ended.

## Before you install

You need:

- macOS with cmux. The panel was written against cmux 0.65.2. Custom sidebars must be available in your build: `cmux sidebar --help` must work.
- `jq` and `python3` on your `PATH`.
- Claude Code, only if you want session names on tabs and the status line parts.

## Install

1. Clone the repository.

   ```sh
   git clone https://github.com/vasilyu1983/cmux-agents-sidebar.git
   cd cmux-agents-sidebar
   ```

2. Run the installer in Terminal.

   ```sh
   bash install.sh
   ```

   If you have your own Claude Code status line and want to keep it, run this instead:

   ```sh
   bash install.sh --no-statusline
   ```

3. Open a tab in cmux and start the watcher. Leave the tab open.

   ```sh
   ~/.config/cmux/scripts/agents-watch.sh
   ```

The panel shows in the right sidebar. Claude Code sessions that start after the install show the status line.

### What the installer changes

| File | Action |
|------|--------|
| `~/.config/cmux/sidebars/agents.js` | The panel |
| `~/.config/cmux/scripts/label-tabs.py` | Puts session names on tabs and passes session data to the panel |
| `~/.config/cmux/scripts/agents-watch.sh` | Opens the panel and runs `label-tabs.py` every 15 seconds |
| `~/.config/cmux/scripts/hive.html` | The graph page |
| `~/.claude/statusline-command.sh` | The status line script (skipped with `--no-statusline`) |
| `~/.claude/settings.json` | Gets one key, `statusLine`, only when the file has none (skipped with `--no-statusline`) |

If a target file exists and differs, the installer first copies it to `<name>.<date>.bak`.
The installer does not change `cmux.json`.

The `statusLine` key that it adds:

```json
{ "statusLine": { "type": "command", "command": "bash ~/.claude/statusline-command.sh" } }
```

| State of `~/.claude/settings.json` | What the installer does |
|------------------------------------|-------------------------|
| No file | Creates the file with this key only |
| File without `statusLine` | Keeps a `.bak` copy, adds the key, changes no other key |
| File with this status line | Changes nothing |
| File with another `statusLine` | Changes nothing and says so |
| File that `jq` cannot read | Changes nothing and says so |

### Install by hand

Copy `sidebars/agents.js` to `~/.config/cmux/sidebars/`, then run:

```sh
cmux sidebar validate agents
cmux right-sidebar set custom agents
```

The panel works without the other files. You then get the rows, the status, the search and the jump. You do not get session names on tabs, model, context, cost, or the hive page.

### Optional: a palette entry and a shortcut

Add this to the `actions` object in `~/.config/cmux/cmux.json`, then run `cmux config validate` and `cmux reload-config`.

```json
"agents-panel": {
  "type": "command",
  "title": "Agents",
  "command": "~/.config/cmux/scripts/agents-watch.sh",
  "target": "newTabInCurrentPane",
  "shortcut": "cmd+ctrl+a",
  "palette": true
}
```

## Fast commands

A right-click on a session row offers the tool's own commands.

| Tool | Compact | Usage or context | Menu action |
|------|---------|------------------|-------------|
| Claude Code | `/compact` | `/context` | Sends the command to the tab, only while the session is idle |
| Codex | `/compact` | `/status` | Copies the command |
| OpenCode | `/compact` | none | Copies the command |
| Grok Build | `/compact` | `/context` | Copies the command |
| Antigravity (`agy`) | none, it compacts by itself | `/context` | Copies the command |

Two cautions about the send action:

- It types into the tab and submits. If you left a draft in the input box of that session, the draft is submitted with the command.
- It runs only on an idle session. On a session that works or waits, the text could answer a prompt, so the item does nothing.

The other tools only copy, because their waiting state in cmux is not confirmed yet. To change a tool to sending, add `send: true` to its line in `COMMANDS` at the top of `agents.js`. To add a tool, add a line there.

## How it works

A cmux panel gets workspaces, tabs and agents from cmux. It cannot read a file, and cmux does not know the model or the cost of a session. So the data takes this path:

1. The status line script runs inside each Claude Code session. It writes one small file per session to `~/.cache/cmux-agents/<session id>`: model, context share, cost, lane branch, cold-cache tokens and the 7-day limit, separated by tabs.
2. `label-tabs.py` reads the Claude Code session registry (`~/.claude/sessions/`) and those files. It renames each tab to `[session name] title`, with `!` for a waiting session and `?` for a busy session whose transcript was quiet for 20 minutes.
3. `label-tabs.py` writes the session data into the workspace description: `<folder> | @week: 36% | api-3f: Fable 5.2 high · ctx 42% · $12.34`.
4. The panel reads the description and joins it with the rows.

Facts that follow from this design:

- The workspace description belongs to this tool. The text before the first ` | ` is kept; the rest is rewritten every 15 seconds.
- Only Claude Code sessions get a name, model, context and cost. Other tools show their status, title and tool tag.
- The cost is the Claude Code estimate at list price for one session. It is not your bill.
- The `?` mark is a hint. A long silent command also leaves the transcript quiet.
- The hive page gets its data in the link, after `#`. It loads nothing from the network and stores nothing.

### Optional project strip

The top of the panel can show a few lines of project state, for example a merge queue. A watcher of your own supplies them:

- Set `AGENTS_STRIP_WORKSPACE` to a workspace ref (for example `workspace:3`) and `AGENTS_STRIP_TEXT` to one line of text when you run `label-tabs.py`. The text shows as the `train` line.
- A PR badge on a row needs two files in `$TMPDIR/agents-board/`: `prs.json` (output of `gh pr list --json number,headRefName`) and `status.txt` (your merge tool's state lines). Without them the badge stays off.

Without a watcher the strip shows only the `week` line.

## Privacy and safety

- Everything stays on your Mac. No script calls the network.
- `label-tabs.py` reads the environment of your own agent processes to find one value, `CMUX_SURFACE_ID`. It keeps nothing else from it.
- `~/.cache/cmux-agents` is created with mode 700.
- The panel writes to the clipboard only from a menu item that you click.
- The copied queue commands are built only from names with plain characters.

## Remove

```sh
rm ~/.config/cmux/sidebars/agents.js
rm ~/.config/cmux/scripts/label-tabs.py ~/.config/cmux/scripts/agents-watch.sh ~/.config/cmux/scripts/hive.html
rm -r ~/.cache/cmux-agents
```

If you installed the status line: delete `~/.claude/statusline-command.sh` and the `statusLine` key in `~/.claude/settings.json`, or restore your `.bak` copies.
Tab labels stay until you rename the tabs or close them.

## Known limits

- Tested on one Mac with cmux 0.65.2. A newer cmux can change the panel API.
- The tool names that cmux reports for Codex, OpenCode, Grok Build and Antigravity were not observed; only `claude` was. The fast-command match is on a part of the name.
- Fold states reset when the panel reloads.
- Old files in `~/.cache/cmux-agents` are not cleaned.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
The panel started from a panel template that ships with cmux, and cmux is licensed under GPL-3.0-or-later.

This project is not affiliated with cmux or its authors.
