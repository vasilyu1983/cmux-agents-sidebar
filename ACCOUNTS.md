# Accounts: add and maintain

How to run several accounts of one coding-agent tool, and how to keep them in order. The short reference is
the part "Several accounts" in the [README](README.md). The names here (`personal`, `work`) are examples.

## The model

- **One primary account per tool.** It lives in the tool's normal folder (`~/.claude`, `~/.codex`) and needs
  no setup. Name it on the `default` line of the accounts file. It never gets a second folder.
- **Extra accounts.** Each one has its own folder, `~/.<tool>-<name>`. The launcher sets one variable
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`) so the tool uses that folder.
- **One name per organisation, in every tool.** A folder rule holds one account name. If Claude Code calls
  the account `work` and Codex calls it `job`, a rule to `work` starts Codex on the primary account.
- All of it is described by one text file, `~/.config/cmux/agents-accounts`.

## First setup

1. Install the kit: `bash install.sh`.
2. Add one line to the end of `~/.zshrc` (or `~/.bashrc`), then open a new terminal tab:
   ```
   source ~/.config/cmux/scripts/agents-shell.sh
   ```
3. Name the primary account. Put this line in `~/.config/cmux/agents-accounts`:
   ```
   default personal
   ```

## Add an account

1. See the plan. Nothing changes:
   ```
   ~/.config/cmux/scripts/agents-account-add.sh claude work --dry-run
   ```
2. Make the folder and the links:
   ```
   ~/.config/cmux/scripts/agents-account-add.sh claude work
   ```
   Read the table that it prints. For Claude Code, `settings.json` and `hooks` must say "linked now";
   without them that account runs without your permission rules and hooks.
3. Log in once, by hand, with the line that the script prints. In the browser, pick the right account
   first: it otherwise signs in the account that it already has.
   ```
   cla work auth login
   cdx work login
   ```
4. Check: start a session (`cla work`), send one message, type `/status`. The status line starts with the
   account name, and the panel row reads `claude · work`.

For Codex or OpenCode, use `codex` or `opencode` in place of `claude` in steps 1 and 2.

## Folder rules

Add `rule` lines to the accounts file. A session started in that folder, or below it, uses that account.
The longest matching folder wins. Everything else uses the `default` account.

```
rule ~/Projects/work work
rule ~/Projects/work/side-project personal
```

Check a folder without starting a tool: `cd` into it and type `accounts`. It prints the account that each
tool gets there. For one start against the rule, name the account: `cla personal`.

## Daily use

| Command | What it does |
|---|---|
| `claude`, `codex`, `opencode` | Start with the account that the folder rules choose |
| `cla <account> [arguments]` | Claude Code with that account, for this start only |
| `cdx <account> [arguments]` | Codex with that account, for this start only |
| `accounts` | The account list, and the account that the current folder gets |
| `accounts doctor` | Checks the folder and the links of every extra account, and adds missing links |

## Maintain

**After an update of the kit.** Pull, run `bash install.sh`, then run the add script once more for each extra
account. It changes nothing that is in order, adds links that a newer list holds, and reports each link.

```
~/.config/cmux/scripts/agents-account-add.sh claude work
```

`accounts doctor` runs that command for every extra account in one go.

**Check the links.** The same command is the health check. The states:

| State | Meaning | What to do |
|---|---|---|
| `linked` | In order | Nothing |
| `linked now` | A missing link was added | Nothing |
| `not in ~/.claude, skipped` | The primary folder has no such file | Nothing |
| `a real file of this account, left as it is` | The tool replaced the link with its own copy, or you made one | To share again: compare it with the primary file, delete the copy, run the script again |
| `a link to another place, left as it is` | Someone linked it elsewhere | Decide by hand |

**A login expired or was revoked.** Run the login line again for that account (`cla work auth login`,
`cdx work login`). The other accounts are not touched.

**Rename an account.**

1. Close every session of that account.
2. Rename the folder, for example `~/.claude-work` to `~/.claude-job`.
3. Change the name and the folder on its `account` line, and the name on its `rule` lines.
4. Log in again when the tool asks. Claude Code keeps the login per folder path, so a renamed folder is a
   new place for it.

**Remove an account.**

1. In a session of that account, type `/logout`, then close it. This removes its saved login.
2. Delete its folder.
3. Delete its `account` line and its `rule` lines.

**Change the primary account.** The primary is whatever login the normal folder holds. Log in there with the
other account in the tool's normal way, and change the name on the `default` line. If the old primary
should stay available, add it as an extra account first.

**Move to a new computer.** Copy only `~/.config/cmux/agents-accounts`. Then run the add script and the login
for each extra account. Do not copy account folders between computers: they hold the login and session
data.

**Keep the file tidy.** One `default` line. One `account` line per tool and name. A folder under your home
folder, with no spaces. A bad line is skipped and reported by its number: run
`python3 ~/.config/cmux/scripts/label-tabs.py --next-waiting` in a terminal to see such messages.

## What is shared, what is separate

| | Shared through links | Separate for each account |
|---|---|---|
| Claude Code | Settings, instructions, hooks, rules, skills, agents, commands, output styles, plugins, status line, workflows, key bindings, teams | The login, sessions and `/resume`, project memory, history, MCP servers added at user level, folder trust answers |
| Codex | `config.toml`, `AGENTS.md`, `instructions.md`, `hooks.json`, rules, skills, agents, plugins, key bindings | The login, sessions, memories, history |
| OpenCode | Nothing is linked; its settings stay in `~/.config/opencode` | The login and the sessions |

A change to a shared file reaches every account at once. Memory is separate on purpose: a work account does
not read personal notes.

## When something is wrong

| Sign | Likely cause | Check |
|---|---|---|
| A session runs on the wrong account | No rule matches the folder, or the names differ between tools | `accounts` in that folder |
| `≠ work` in orange on a panel row | The session was started on another account than the folder rule names | Close it and start it again with plain `claude`, or with `cla work` |
| `unknown account` | A typing error, or no line names it | The accounts file |
| `the folder ... is missing` | The folder was deleted or never made | Run the add script |
| The tool asks for a login on every start | The login for that folder did not save | Log in again with that account's line |
| No account name on a panel row | No reply yet in that session, or the watcher does not run | Send one message; check the watcher tab |
| `Limits` shows "no limit data" for an account | No reply yet on that account, or its plan sends no figure | Send one message on that account |
| Hooks do not run on one account | Its `settings.json` or `hooks` link is missing | Run the add script and read the table |
| `--resume` opens another account | A session id belongs to the account that made it | Start with that account: `cla <account> --resume` |

## Safety

- The scripts read, copy and move no login token. They make folders and links, write one line of text and
  set one variable. You log in yourself.
- A token in the environment (`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) ranks above the login of
  any folder, for every account.
- The plan terms of each tool are your responsibility. Separate accounts for separate work are one thing;
  several accounts to pass a usage limit can break the terms.
