// SPDX-License-Identifier: GPL-3.0-or-later
// Agents panel for the cmux right sidebar. Started from a panel template that ships with cmux (GPL-3.0-or-later).
// panel-subagents: right-sidebar demo. Every coding-agent session cmux is
// tracking (Claude Code, Codex, ...), grouped by workspace: status dot,
// first-prompt title, live elapsed time, kind + directory metadata, and a
// working/needs-input/idle summary. Click a row to jump to the workspace and
// focus the terminal the agent runs in.
//   cmux right-sidebar set custom panel-subagents

const [query, setQuery] = signal("");
const [showLimitsS, setShowLimitsS] = signal(null);
// The view (chip, sort, scope, ended rows, folded groups) survives a panel reload. A panel has no storage of its
// own, so each change goes into a workspace description as one part: "@view: t=<epoch>,c=<chip|all>,a=0,s=1,e=0,l=0,f=0"
// ("l" = the Limits view; a part without it reads as 0).
// label-tabs.py rebuilds the description and keeps that part. A signal here holds null until a click; before
// the first click the value comes from the newest "@view" part (t). "f" is the fold of the workspace that carries it.
const [scopeAllS, setScopeAllS] = signal(null);
const [showEndedS, setShowEndedS] = signal(null);
const [filterS, setFilterS] = signal(null);
const [attentionS, setAttentionS] = signal(null);
// Groups folded or opened since the reload (workspace id -> Bool) and sessions whose subagent rows are open (row id -> true).
const [collapsedS, setCollapsedS] = signal({});
const VIEW_RE = /^@view: ([a-z]=[a-z0-9]{1,12}(?:,[a-z]=[a-z0-9]{1,12}){0,7})$/;
const saved = computed(() => {
  let best = {};
  let bestT = -1;
  const folds = {};
  for (const w of data.workspaces() ?? []) {
    for (const part of String(w.description ?? "").split(" | ")) {
      const m = VIEW_RE.exec(part);
      if (!m) continue;
      const v = Object.fromEntries(m[1].split(",").map((kv) => kv.split("=")));
      if (v.f === "1") folds[w.id] = true;
      if ((Number(v.t) || 0) > bestT) { bestT = Number(v.t) || 0; best = v; }
    }
  }
  return { c: best.c ?? "", a: best.a === "1", s: best.s !== "0", e: best.e === "1", l: best.l === "1", folds };
});
const scopeAll = () => scopeAllS() ?? saved().s;
const showEnded = () => showEndedS() ?? saved().e;
const showLimits = () => showLimitsS() ?? saved().l;
const collapsed = () => ({ ...saved().folds, ...collapsedS() });
const [openKids, setOpenKids] = signal({});
const [openInfo, setOpenInfo] = signal({});
const flip = (get, set, id) => set({ ...get(), [id]: !get()[id] });
// One filter chip at a time ("" = all rows), and the row order: tab order, or the sessions that need attention first.
const filter = () => { const c = filterS() ?? saved().c; return FILTERS.some((f) => f[0] === c) ? c : ""; };
const attention = () => attentionS() ?? saved().a;
// Each chip is a short mark, so the row fits a narrow panel; the full name shows under the chips while a filter is on.
const FILTERS = [["needs", "!", "needs you"], ["working", "▶", "working"], ["ctx", "80%", "context 80% or more"], ["pr", "PR", "has a PR"], ["idle", "1h+", "idle for 1 hour or more"]];
const chipHit = (id, a, sess, epoch) =>
  id === "needs" ? a.status === "needs_input"
    : id === "working" ? a.status === "working"
    : id === "ctx" ? sess.ctx >= 80
    : id === "pr" ? Boolean(sess.pr)
    : id === "idle" ? a.status === "idle" && epoch - (a.lastActivityAt ?? epoch) > 3600
    : false;

// Writes the view into the description of one workspace. Nothing is written while no description carries
// "@home" (label-tabs.py does not run then, and the part would stay as loose text in the workspace list).
function persist(next, wsId, fold) {
  const all = data.workspaces() ?? [];
  const w = all.find((x) => x.id === wsId);
  if (!w || !all.some((x) => /(?:^| \| )@home: /.test(String(x.description ?? "")))) return;
  const on = (b) => (b ? 1 : 0);
  const part = "@view: t=" + (data.clock()?.epoch ?? 0) + ",c=" + (next.c || "all") + ",a=" + on(next.a)
    + ",s=" + on(next.s) + ",e=" + on(next.e) + ",l=" + on(next.l) + ",f=" + on(fold ?? collapsed()[wsId]);
  const parts = String(w.description ?? "").split(" | ").filter((p) => !p.startsWith("@view: "));
  cmux("workspace.action", { workspace_id: wsId, action: "set_description", description: [...parts, part].join(" | ") });
}
// One change of the view: c = chip, a = attention sort, s = all workspaces, e = ended rows, l = the Limits view.
function setView(patch) {
  const next = { c: filter(), a: attention(), s: scopeAll(), e: showEnded(), l: showLimits(), ...patch };
  setFilterS(next.c); setAttentionS(next.a); setScopeAllS(next.s); setShowEndedS(next.e); setShowLimitsS(next.l);
  persist(next, data.selectedId());
}
function toggleFold(wsId) {
  const fold = !collapsed()[wsId];
  setCollapsedS({ ...collapsedS(), [wsId]: fold });
  persist({ c: filter(), a: attention(), s: scopeAll(), e: showEnded(), l: showLimits() }, wsId, fold);
}

// One agent record per tab: cmux can keep an older live record for the same tab. The record that waits or works
// wins, then the newest, then the first in the list. An ended record is never picked. The rows and the hive use this.
const tabOf = (w, a) => (w.tabs ?? []).find((t) => t.id === a.panelId || (a.surfaceId && t.surfaceId === a.surfaceId));
function onePerTab(w) {
  const best = new Map();
  for (const a of w.agents ?? []) {
    if (a.status === "ended") continue;
    const tab = tabOf(w, a);
    const key = tab?.id ?? a.panelId ?? a;
    const old = best.get(key)?.a;
    const better = !old || statusOf(a).rank < statusOf(old).rank
      || (statusOf(a).rank === statusOf(old).rank && (a.lastActivityAt ?? 0) > (old.lastActivityAt ?? 0));
    if (better) best.set(key, { a, tab });
  }
  return [...best.values()];
}
const costOf = (w) => Object.values(sessionsOf(w)).reduce((sum, x) => sum + (parseFloat(String(x.cost ?? "").slice(1)) || 0), 0);

// Fast commands, per tool. Each name was read in that tool's own documentation on 2026-11-14; a tool that is not
// listed here gets no command item. Antigravity (agy) compacts by itself and has no compact command.
// The match is on the tool name that cmux reports, in lower case.
const COMMANDS = [
  { match: "claude", compact: "/compact", usage: "/context", send: true },
  { match: "codex", compact: "/compact", usage: "/status" },
  { match: "opencode", compact: "/compact" },
  { match: "grok", compact: "/compact", usage: "/context" },
  { match: "agy", usage: "/context" },
  { match: "antigravity", usage: "/context" },
];
const commandsOf = (a) => {
  const tool = (String(a?.kind ?? "") + " " + String(a?.name ?? "")).toLowerCase();
  return COMMANDS.find((c) => tool.includes(c.match)) ?? {};
};
// Types a command into the tab of an idle session and submits it (a line end submits; measured 2026-11-14).
// A session that works or waits is left alone: there the text could answer a prompt.
// Only tools with "send: true" get this: for them cmux was seen to report a waiting session as "needs_input".
// For the other tools the menu copies the command, and the owner pastes it.
function sendCommand(row, text) {
  if (!text || !row.surfaceId || row.agent.status !== "idle") return;
  cmux("surface.send_text", { surface_id: row.surfaceId, workspace_id: row.wsId, text: text + "\n" });
}

// label-tabs.py leaves "<folder> | api-3f: Fable 5.2 high · ctx 42% · $12.34 · lane lane/x · pr #644 needs grant ·
// cold 198K · waits permission prompt | ..." in the description. Returns session name -> its fields.
// "@" parts belong to the strip.
function sessionsOf(w) {
  const models = {};
  for (const part of String(w.description ?? "").split(" | ").slice(1)) {
    const at = part.indexOf(": ");
    if (at <= 0 || part.startsWith("@")) continue;
    const s = {};
    for (const f of part.slice(at + 2).split(" · ")) {
      if (f.startsWith("ctx ")) s.ctx = parseInt(f.slice(4), 10);
      else if (f.startsWith("$")) s.cost = f;
      else if (f.startsWith("waits ")) s.wait = f.slice(6);
      else if (f.startsWith("lane ")) s.lane = f.slice(5);
      else if (f.startsWith("pr ")) s.pr = f.slice(3);
      else if (f.startsWith("cold ")) s.cold = f;
      else if (f.startsWith("acct ")) {
        // "acct work": the account of the session, a short name from your account list. Another form is left out.
        const m = /^acct ([a-z0-9-]{1,16})$/.exec(f);
        if (m) s.acct = m[1];
      }
      else if (f.startsWith("sub ")) {
        // "sub 2/7: Explore repo; Review diff": subagents from the Claude Code records, running ones by name.
        // A field that does not have this form is left out.
        const m = /^sub (\d{1,4})\/(\d{1,4})(?:: (.*))?$/.exec(f);
        if (m) s.subs = { run: Number(m[1]), total: Number(m[2]), names: m[3] ? m[3].split("; ") : [] };
      }
      else s.model = f;
    }
    models[part.slice(0, at)] = s;
  }
  return models;
}
const sessionName = (tabTitle) => (/^\[(.+?)(?: [!?])?\]/.exec(tabTitle ?? "") ?? [])[1];

// Status vocabulary (workspaces[i].agents[j].status). In-flight states get a
// strong dot; settled states are muted, matching how a roster reads at a
// glance: color answers "does anything need me?", text answers "what is it?".
const STATUS = {
  needs_input: { color: "#FF9F0A", label: "Needs input", rank: 0 },
  working: { color: "#0A84FF", label: "Working", rank: 1 },
  idle: { color: "#34C759", label: "Idle", rank: 2 },
  ended: { color: "#7f7f7f66", label: "Ended", rank: 3 },
};
const statusOf = (a) => STATUS[a.status] ?? { color: "#7f7f7f66", label: a.status, rank: 9 };

// Ended sessions stay visible briefly (a just-finished agent is still news),
// then hide behind the Ended toggle.
const ENDED_VISIBLE_SECS = 15 * 60;

const matches = (text) => {
  const q = query().trim().toLowerCase();
  if (!q) return true;
  return String(text ?? "").toLowerCase().includes(q);
};

function fmtElapsed(secs) {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}

function fmtAgo(secs) {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

// Right-aligned time column: live elapsed for in-flight states (ticks with
// the 1s clock), "ago" for settled ones.
function timeText(a, epoch) {
  if ((a.status === "working" || a.status === "needs_input") && a.sinceEpoch) {
    return fmtElapsed(epoch - a.sinceEpoch);
  }
  if (a.lastActivityAt) return fmtAgo(epoch - a.lastActivityAt) + " ago";
  return "";
}

const dirTail = (d) => {
  const parts = String(d ?? "").split("/").filter((p) => p.length > 0);
  return parts.length ? parts[parts.length - 1] : "";
};

// One flat entry list: workspace headers + agent rows, so a single keyed
// ForEach owns the whole roster (kind is encoded in the key, so templates
// stay stable across live updates).
const view = computed(() => {
  const epoch = data.clock()?.epoch ?? 0;
  const all = data.workspaces() ?? [];
  const scoped = scopeAll() ? all : all.filter((w) => w.selected);
  const out = [];
  const waiting = [];
  // Rows per chip, counted before the chip filter: the number on each chip.
  const chips = Object.fromEntries(FILTERS.map((f) => [f[0], 0]));
  for (const w of scoped) {
    const rows = [];
    const models = sessionsOf(w);
    const winners = new Set(onePerTab(w).map((x) => x.a));
    for (const a of w.agents ?? []) {
      // The title of the tab that hosts the agent. label-tabs.py puts the session name there ("[api-3f] title"),
      // so the row shows which session it is, not only "Claude".
      const tab = tabOf(w, a);
      const tabTitle = tab?.title ?? "";
      // One row per tab (onePerTab). Ended shows them all.
      if (a.status !== "ended" && !showEnded() && !winners.has(a)) continue;
      // An ended session in a tab that still hosts a live one is a helper run or an earlier session of that tab
      //. It shows only with the Ended toggle.
      const liveInTab = (w.agents ?? []).some((b) => b !== a && b.status !== "ended" && b.panelId === a.panelId);
      if (a.status === "ended" && !showEnded()
          && (liveInTab || epoch - (a.lastActivityAt ?? 0) > ENDED_VISIBLE_SECS)) continue;
      if (!matches(tabTitle) && !matches(a.title) && !matches(a.name) && !matches(a.kind)
          && !matches(w.title) && !matches(a.directory) && !matches(models[sessionName(tabTitle)]?.acct)) continue;
      // A settled session takes one line; a working or waiting one keeps two, so it stands out by size.
      // The key carries the form, because a row's template is fixed per key.
      const compact = a.status === "idle" || a.status === "ended";
      const sess = models[sessionName(tabTitle)] ?? {};
      const stalled = /^\[[^\]]* \?\]/.test(tabTitle);
      for (const id of Object.keys(chips)) if (chipHit(id, a, sess, epoch)) chips[id] += 1;
      if (filter() && !chipHit(filter(), a, sess, epoch)) continue;
      // Subagents: what cmux reports; when it reports none, what label-tabs.py found in the Claude Code records.
      const subs = (a.children ?? []).length > 0 ? null : sess.subs;
      rows.push({
        // Order for the attention sort: waiting, stalled, context nearly full, working, idle, ended.
        rank: a.status === "needs_input" ? 0 : stalled ? 1 : sess.ctx >= 80 ? 2 : a.status === "working" ? 3 : a.status === "idle" ? 4 : 5,
        sessName: sessionName(tabTitle) ?? "",
        // The PR of the lane branch where the session works, with the state from your merge tool: "#644 needs grant".
        prText: sess.pr ?? "",
        acct: sess.acct ?? "",
        cold: a.status === "idle" ? sess.cold ?? "" : "",
        folder: String(a.directory ?? ""),
        // Why the session waits, and its context share when that is 80% or more (the row shows it in red).
        wait: a.status === "needs_input" ? sess.wait ?? "" : "",
        ctxHigh: sess.ctx >= 80 ? "ctx " + sess.ctx + "%" : "",
        key: "a:" + w.id + ":" + a.id + (compact ? ":c" : ""),
        kind: "agent",
        compact,
        focused: Boolean(w.selected && tab?.focused),
        unread: Boolean(tab?.hasUnread),
        rowId: w.id + ":" + a.id,
        // Detail lines, shown when the owner opens the row with the "›" mark. Empty values are left out.
        info: [
          ["state", statusOf(a).label + (a.sinceEpoch && a.status !== "idle" ? " for " + fmtElapsed(epoch - a.sinceEpoch) : "")],
          ["lane", sess.lane ?? (/\/lane-([^/]+)/.exec(String(a.directory ?? "")) ?? [])[1] ?? ""],
          ["pr", sess.pr ?? ""],
          ["cache", sess.cold ? sess.cold + " tokens to rewrite on the next message" : ""],
          ["waits", a.status === "needs_input" ? sess.wait ?? "" : ""],
          ["tool", a.name],
          ["account", sess.acct ?? ""],
          ["model", sess.model ?? ""],
          ["context", sess.ctx >= 0 ? sess.ctx + "%" : ""],
          ["cost", sess.cost ?? ""],
          ["folder", String(a.directory ?? "").replace(/^\/Users\/[^/]+/, "~")],
          ["branch", tab?.branch ? tab.branch + (tab.dirty ? " (changed files)" : "") : ""],
          ["ports", (tab?.ports ?? []).join(", ")],
          ["first ask", a.title ?? ""],
          ["last ask", tab?.latestPrompt ?? ""],
        ].filter((l) => l[1]),
        kids: subs ? subs.total : (a.children ?? []).length,
        kidsRunning: subs ? subs.run : (a.children ?? []).filter((c) => c.running).length,
        subs,
        // Dim a session with no activity for over an hour.
        old: compact && epoch - (a.lastActivityAt ?? epoch) > 3600,
        wsId: w.id,
        wsSelected: w.selected,
        tabTitle,
        wsColor: w.color || "#8E8E93",
        tabIndex: tab ? w.tabs.indexOf(tab) : 9999,
        // label-tabs.py marks a busy session with no transcript write for 20 minutes as "[name ?]".
        stalled,
        pr: (w.prs ?? []).find((p) => p.branch && p.branch === tab?.branch),
        // The agent's own surfaceId is not the ID of its tab here. The tab found through panelId carries the ID that focus accepts.
        surfaceId: tab?.surfaceId || a.panelId || a.surfaceId,
        agent: a,
      });
    }
    // A workspace with no agent still gets its band, so the panel can stand in for the left list. Not during a search.
    if (rows.length === 0 && (query().trim() || filter())) continue;
    // Same order as the tabs of the workspace; waiting sessions also show in the top block.
    // The "attention" toggle puts the sessions that need the owner first, and keeps tab order inside each rank.
    rows.sort((x, y) => (attention() ? x.rank - y.rank : 0) || x.tabIndex - y.tabIndex);
    out.push({
      key: "h:" + w.id,
      kind: "header",
      wsId: w.id,
      // The project folder names the group. w.title is the title of the focused tab, which reads like one more session.
      // The description starts with the project folder; w.directory follows the focused tab (it read "app" for one project).
      wsTitle: dirTail(String(w.description ?? "").split(" | ")[0]) || dirTail(w.directory) || w.title,
      wsColor: w.color || "#8E8E93",
      count: rows.length,
      cost: costOf(w),
      unread: w.unread ?? 0,
      folded: Boolean(collapsed()[w.id]),
      wsSelected: w.selected,
      dots: rows.map((r) => statusOf(r.agent).color),
    });
    // A folded group still reports its waiting sessions to the top block.
    for (const r of rows) if (r.agent.status === "needs_input") waiting.push({ ...r, key: "n:" + r.key });
    if (collapsed()[w.id]) continue;
    // Each agent expands into its row plus one indented row per child
    // (Claude Task spawns / Codex subagent runs), running children first.
    for (const r of rows) {
      out.push(r);
      if (openInfo()[r.rowId]) {
        r.info.forEach((l, i) => out.push({
          key: "d:" + r.key + ":" + l[0], kind: "detail", wsId: w.id, wsColor: r.wsColor, surfaceId: r.surfaceId,
          label: l[0], value: l[1], last: i === r.info.length - 1,
        }));
      }
      if (!openKids()[r.rowId]) continue;
      // Records from disk carry a name and a state, no times and no id: the position is the key.
      const children = r.subs
        ? hiveSubs(r.subs).map((c, k) => ({ id: "s" + k, label: c.n, running: c.r, noTime: true }))
        : [...(r.agent.children ?? [])];
      children.sort((x, y) => (x.running === y.running ? (x.startedEpoch ?? 0) - (y.startedEpoch ?? 0) : x.running ? -1 : 1));
      for (const c of children) {
        out.push({
          key: "c:" + r.key + ":" + c.id,
          kind: "child",
          wsId: w.id,
          surfaceId: r.surfaceId,
          wsColor: r.wsColor,
          agent: r.agent,
          child: c,
        });
      }
    }
  }
  // "Needs you": every waiting session of every workspace, longest wait first, above the groups.
  waiting.sort((x, y) => (x.agent.sinceEpoch ?? 0) - (y.agent.sinceEpoch ?? 0));
  if (waiting.length === 0) return { rows: out, chips };
  return { chips, rows: [{ key: "h:needs-you", kind: "header", needsYou: true, wsTitle: "NEEDS YOU", wsColor: "#FF9F0A", count: waiting.length, wsSelected: true, dots: [] }, ...waiting, ...out] };
});
const entries = computed(() => (showLimits() ? [] : view().rows));

// The project strip: the "@train", "@queue" and "@unpushed" parts that label-tabs.py puts in a workspace description.
// Read from every workspace, also when the list shows one workspace only.
const STRIP = { train: ["train", "secondary"], week: ["week", "secondary"], queue: ["run", "#FF9F0A"], unpushed: ["unpushed", "#FF9F0A"] };
// The Limits view: "@limits: claude,5h,42,14:10,1794650000;codex,week,4,Sat 09:39,1794600000;grok,,,,0".
// label-tabs.py reads the limit windows that each tool leaves in local files. An item with no window is a tool
// that is installed and leaves no limit data.
const TOOLS = { claude: "Claude", codex: "Codex", opencode: "OpenCode", grok: "Grok", agy: "Antigravity" };
const limits = computed(() => {
  const epoch = data.clock()?.epoch ?? 0;
  let newest = null;
  for (const w of data.workspaces() ?? []) {
    const part = String(w.description ?? "").split(" | ").find((p) => p.startsWith("@limits: "));
    if (part && (!newest || part.length > newest.text.length)) newest = { text: part.slice(9), wsId: w.id };
  }
  const out = [];
  for (const item of newest ? newest.text.split(";") : []) {
    // The sixth part, the account, is optional: "claude,5h,42,14:10,1794650000,work".
    const m = /^([a-z]{1,12}),([\w]{0,8}),(\d{0,3}),([\w: ]{0,12}),(\d{1,12})(?:,([a-z0-9-]{1,16}))?$/.exec(item);
    if (!m || !TOOLS[m[1]]) continue;
    const seen = Number(m[5]);
    const age = seen && epoch >= seen ? " · seen " + fmtAgo(epoch - seen) + " ago" : "";
    let value = "no limit data on this Mac";
    let color = "tertiary";
    if (m[3] !== "") {
      const used = Number(m[3]);
      if (m[4] === "ended") value = (m[2] || "limit") + " window ended · last value " + used + "%" + age;
      else {
        value = (m[2] || "limit") + " " + used + "%" + (m[4] ? " · resets " + m[4] : "") + age;
        color = used >= 80 ? "#FF453A" : "secondary";
      }
    }
    const label = TOOLS[m[1]] + (m[6] ? " " + m[6] : "");
    out.push({ key: "limit" + out.length + m[1] + m[2], label, value, color, copy: label + " " + value, wsId: newest.wsId, tool: Object.keys(TOOLS).indexOf(m[1]), acct: m[6] ?? "" });
  }
  // Lines of one tool stay together, and inside a tool the lines of one account.
  out.sort((a, b) => a.tool - b.tool || (a.acct < b.acct ? -1 : a.acct > b.acct ? 1 : 0));
  if (out.length === 0) out.push({ key: "limit-none", label: "limits", value: "no data yet: the watcher writes it within 15 seconds", color: "tertiary", copy: "", wsId: data.selectedId() });
  return out;
});

const strip = computed(() => {
  const out = [];
  for (const w of data.workspaces() ?? []) {
    for (const part of String(w.description ?? "").split(" | ").slice(1)) {
      const at = part.indexOf(": ");
      const kind = STRIP[part.slice(1, at)];
      if (part.startsWith("@") && kind) {
        const value = part.slice(at + 2);
        const name = part.slice(1, at);
        out.push({
          key: w.id + part.slice(0, at), label: kind[0], value: name === "week" ? value + " of the 7-day limit used" : value, wsId: w.id,
          color: name === "week" && parseInt(value, 10) >= 80 ? "#FF453A" : kind[1],
          // The menu copies the text as it is. Nothing here builds or runs a command.
          copy: value,
        });
      }
    }
  }
  return out;
});

const counts = computed(() => {
  const all = data.workspaces() ?? [];
  const c = { working: 0, needs_input: 0, idle: 0, ended: 0 };
  for (const w of all) {
    for (const a of w.agents ?? []) {
      if (c[a.status] !== undefined) c[a.status] += 1;
    }
  }
  return c;
});

// The summed cost of the sessions that report one (Claude Code only; the estimate at list price).
const totalCost = computed(() => {
  let sum = 0;
  for (const w of data.workspaces() ?? []) sum += costOf(w);
  return sum;
});

// The hive graph is a page (scripts/hive.html) that draws what this panel knows: workspaces, their
// sessions and the subagents of each session. The data travels in the link, after "#". The page reads no file.
function hiveSubs(subs) {
  if (!subs) return [];
  const out = subs.names.map((n) => ({ n, r: true }));
  if (subs.run > subs.names.length) out.push({ n: "+" + (subs.run - subs.names.length) + " more running", r: true });
  if (subs.total > subs.run) out.push({ n: (subs.total - subs.run) + " finished", r: false });
  return out;
}

// mark: the tab of a jump ({ ws, tab }), shown as the open tab; without it, the tab that has the focus now.
function hiveUrl(mark) {
  const all = data.workspaces() ?? [];
  // The home folder comes from label-tabs.py ("@home: ..." in a description), not from a folder that an agent reports.
  let home = "";
  for (const w of all) {
    const found = /(?:^| \| )@home: (\/Users\/[A-Za-z0-9._-]{1,64})(?: \| |$)/.exec(String(w.description ?? ""));
    if (found) { home = found[1]; break; }
  }
  const ws = [];
  for (const w of all) {
    const models = sessionsOf(w);
    const agents = [];
    for (const { a, tab } of onePerTab(w)) {
      const sess = models[sessionName(tab?.title)] ?? {};
      agents.push({
        n: rowTitle(tab?.title ?? "") || a.title || a.name || "session", k: a.kind ?? "", s: a.status,
        i: tab?.id ?? "", w: w.id, f: mark ? mark.ws === w.id && mark.tab === tab?.id : Boolean(w.selected && tab?.focused), m: sess.model ?? "", u: sess.acct ?? "", x: sess.ctx ?? null, c: sess.cost ?? "", p: sess.pr ?? "", l: sess.lane ?? "",
        // Subagents: what cmux reports for the agent; when it reports none, what label-tabs.py found on disk.
        ch: (a.children ?? []).length > 0
          ? a.children.map((c) => ({ n: c.label || "subagent", r: Boolean(c.running) }))
          : hiveSubs(sess.subs),
      });
    }
    ws.push({ n: dirTail(String(w.description ?? "").split(" | ")[0]) || w.title, c: w.color || "#8E8E93", f: mark ? mark.ws === w.id : Boolean(w.selected), a: agents });
  }
  if (!home) return "";
  return "file://" + home + "/.config/cmux/scripts/hive.html#" + encodeURIComponent(JSON.stringify({ t: data.clock()?.epoch ?? 0, ws }));
}

// A click on a session in the hive page asks for a jump. A web page cannot call cmux, so the page puts the
// request in its tab title: "go:<workspace id>:<tab id>:<epoch seconds>". The panel gets tab titles from cmux,
// and it focuses the tab when the two ids name a tab that it knows and the request is fresh. A page can ask
// for nothing but a focus change (and, across workspaces, for its own page to move along). Each request runs once.
let lastGo = "";
function hiveGo() {
  const now = data.clock()?.epoch ?? 0;
  for (const w of data.workspaces() ?? []) {
    for (const t of w.tabs ?? []) {
      const m = /^go:([0-9A-Fa-f-]{1,40}):([0-9A-Fa-f-]{1,40}):(\d{1,12})$/.exec(String(t.title ?? ""));
      if (!m || m[0] === lastGo) continue;
      lastGo = m[0];
      if (Math.abs(now - Number(m[3])) > 20) continue;
      const target = (data.workspaces() ?? []).find((x) => x.id === m[1]);
      if (target && (target.tabs ?? []).some((x) => x.id === m[2])) {
        // The hive page is a split of one workspace. A jump to another workspace opens a new page there
        // and closes this one, so the graph stays in view.
        // A workspace that already shows a hive page keeps it, and this page stays where it is.
        const there = (target.tabs ?? []).some((x) => x.title === "Agent hive");
        const url = w.id === m[1] || there ? "" : hiveUrl({ ws: m[1], tab: m[2] });
        if (url) cmux("browser.open_split", { url, workspace_id: m[1], focus: false });
        cmux("surface.focus", { surface_id: m[2], workspace_id: m[1] });
        if (url) cmux("surface.close", { surface_id: t.id, workspace_id: w.id });
      }
    }
  }
  return "";
}

function jump(row) {
  // One call only. surface.focus with workspace_id selects the workspace and the tab (checked with `cmux rpc`).
  // The template sent workspace.select first; the two calls ran side by side, and inside one workspace the
  // select could land last and put the focus back on the tab the workspace remembered.
  if (row.surfaceId) cmux("surface.focus", { surface_id: row.surfaceId, workspace_id: row.wsId });
  else cmux("workspace.select", { workspace_id: row.wsId });
}

function toggleButton(labelFn, activeFn, onTapFn) {
  return Text(labelFn)
    .font(11).weight("semibold").lineLimit(1).fixedSize()
    .paddingHorizontal(8).paddingVertical(3)
    .cornerRadius(6)
    .color(() => (activeFn() ? "primary" : "tertiary"))
    .background(() => (activeFn() ? "#7f7f7f3d" : null))
    .hoverBackground("#7f7f7f3d")
    .onTap(onTapFn);
}

// Workspace header: title + one mini status dot per agent (the roster's shape
// at a glance, like a phase rail).
function headerRow(entry) {
  return VStack({ spacing: 0 }, [
    Rectangle().fill("clear").frame({ height: 8 }),
    HStack({ spacing: 4 }, [
      Text(() => (entry().needsYou || !entry().count ? "" : entry().folded ? "▸" : "▾"))
        .font(11).color("secondary").paddingHorizontal(3).paddingVertical(2)
        .onTap(() => { if (entry().wsId) toggleFold(entry().wsId); }),
      HStack({ spacing: 7 }, [
      RoundedRectangle({ cornerRadius: 2 }).fill(() => entry().wsColor).frame({ width: 4, height: 16 }),
      Text(() => entry().wsTitle || "untitled")
        .font(13).weight("bold").lineLimit(1).truncation("tail")
        .color(() => (entry().needsYou ? "#FF9F0A" : "primary")),
      Text(() => (entry().count ? String(entry().count) : "")).font(10).monospaced().color("tertiary"),
      // The summed cost estimate of the workspace's sessions (Claude Code only).
      Text(() => (entry().cost >= 1 ? "$" + Math.round(entry().cost) : "")).font(10).monospaced().color("tertiary"),
      Spacer(),
      // Unread notifications of the workspace, as the left list shows them.
      Text(() => (entry().unread ? entry().unread + " new" : "")).font(9).weight("semibold").color("#0A84FF"),
      ForEach(
        { items: () => entry().dots.map((c, i) => ({ id: String(i) + c, color: c })), key: (d) => d.id },
        (d) => Circle({ size: 5 }).fill(() => d().color)
      ),
      ]).frame({ maxWidth: "infinity" })
        .onTap(() => { if (entry().wsId) cmux("workspace.select", { workspace_id: entry().wsId }); }),
    ])
      .paddingHorizontal(8).paddingVertical(6)
      .background(() => (entry().wsSelected ? "#7f7f7f33" : "#7f7f7f1a"))
      .cornerRadius(7)
      .frame({ maxWidth: "infinity" }),
  ]).frame({ maxWidth: "infinity" });
}

// A thin line in the workspace colour on the left of each row: the rows read as the inside of their group.
const guide = (entry, height) =>
  Rectangle().fill(() => entry().wsColor).opacity(0.45).frame({ width: 2, height });

// "[name] title" where the title only repeats the name (a session with a custom name): show it once.
const rowTitle = (t) => {
  const m = /^\[([^\]]+)\] (.*)$/.exec(t ?? "");
  return m && m[1].replace(/ [!?]$/, "") === m[2] ? "[" + m[1] + "]" : t;
};

// The tool of the session as a small tag after the name: "claude", "codex", or what cmux reports for another tool.
// With an account in the data, the tag also names it: "claude · work".
const toolTag = (entry) =>
  Text(() => (entry().agent.kind ?? "") + (entry().acct ? " · " + entry().acct : "")).font(9).monospaced().color("tertiary").lineLimit(1);
const ctxBadge = (entry) =>
  Text(() => entry().ctxHigh).font(9).weight("semibold").monospaced().color("#FF453A").lineLimit(1);
// One line of the project strip: a dim label and its text. A click opens the workspace that carries it.
function stripRow(entry, width = 58) {
  return HStack({ spacing: 8 }, [
    Text(() => entry().label).font(10).monospaced().color("tertiary").lineLimit(1).truncation("tail").frame({ width, alignment: "leading" }),
    Text(() => entry().value).font(10).color(() => entry().color).lineLimit(2).truncation("tail"),
    Spacer(),
  ])
    .paddingHorizontal(10)
    .frame({ maxWidth: "infinity" })
    .onTap(() => cmux("workspace.select", { workspace_id: entry().wsId }))
    .contextMenu([Button("Copy the text", () => clipboard.write(entry().copy))]);
}

// "#644 needs grant" in orange when the PR waits for the owner; "cold 198K" on an idle session whose prompt cache
// went cold (the next message rewrites that many tokens at the higher price).
const prBadge = (entry) =>
  Text(() => entry().prText).font(9).monospaced().lineLimit(1)
    .color(() => (/needs grant|refused|blocked/.test(entry().prText) ? "#FF9F0A" : "tertiary"));
const coldBadge = (entry) =>
  Text(() => entry().cold).font(9).monospaced().color("#64D2FF").lineLimit(1);

// Right-click menu of a session row. The command items type into the session's tab, and only while it is idle.
function rowMenu(entry) {
  const cmd = commandsOf(entry().agent);
  const items = [
    Button("Go to session", () => jump(entry())),
    Button(() => "Copy name" + (entry().sessName ? ": " + entry().sessName : ""), () => clipboard.write(entry().sessName || entry().tabTitle)),
    Button("Copy folder", () => clipboard.write(entry().folder)),
    Button(() => (entry().prText ? "Copy PR " + entry().prText.split(" ")[0] : "No PR for this session"),
      () => { if (entry().prText) clipboard.write(entry().prText.split(" ")[0]); }),
  ];
  if (cmd.compact || cmd.usage) items.push(Divider());
  for (const text of [cmd.compact, cmd.usage]) {
    if (!text) continue;
    if (cmd.send) {
      items.push(Button(() => (entry().agent.status === "idle" ? "Send " + text : text + " (only when idle)"), () => sendCommand(entry(), text)));
    } else {
      items.push(Button("Copy " + text, () => clipboard.write(text)));
    }
  }
  return items;
}

const unreadBadge = (entry) =>
  Text(() => (entry().unread ? "new" : "")).font(9).weight("semibold").color("#0A84FF");
// "▸ 2 sub running": the subagents of a session as a count. A click opens or closes their rows.
const kidsBadge = (entry) =>
  Text(() => {
    const e = entry();
    if (!e.kids) return "";
    return (openKids()[e.rowId] ? "▾ " : "▸ ") + (e.kidsRunning ? e.kidsRunning + " sub running" : e.kids + " sub");
  }).font(10).monospaced().lineLimit(1)
    .color(() => (entry().kidsRunning ? "#0A84FF" : "tertiary"))
    .onTap(() => flip(openKids, setOpenKids, entry().rowId));
// "›" at the end of a row opens its detail lines; "⌄" closes them.
const infoMark = (entry) =>
  Text(() => (openInfo()[entry().rowId] ? "⌄" : "›"))
    .font(12).color("secondary").paddingHorizontal(4)
    .onTap(() => flip(openInfo, setOpenInfo, entry().rowId));

// One detail line under an agent row: a dim label and its value.
function detailRow(entry) {
  return HStack({ spacing: 8 }, [
    guide(entry, 16),
    Text("").frame({ width: 12 }),
    Text(() => entry().label).font(10).monospaced().color("tertiary").frame({ width: 58, alignment: "leading" }),
    Text(() => entry().value).font(10).color("secondary").lineLimit(2).truncation("tail"),
    Spacer(),
  ])
    .paddingLeading(9).paddingTrailing(10)
    .frame({ maxWidth: "infinity" })
    .onTap(() => jump(entry()));
}

const rowBackground = (entry) => () => (entry().focused ? "#7f7f7f38" : null);

// One-line row for an idle or ended session: dot, name, time.
function compactRow(entry) {
  const a = () => entry().agent;
  return HStack({ spacing: 8 }, [
    guide(entry, 18),
    HStack({ spacing: 6 }, [
      Circle({ size: 6 }).fill(() => statusOf(a()).color),
      Text(() => rowTitle(entry().tabTitle) || a().title || a().name)
        .font(12).lineLimit(1).truncation("tail")
        .color(() => (a().status === "ended" ? "tertiary" : "primary")),
      toolTag(entry),
      unreadBadge(entry),
      Spacer(),
      prBadge(entry),
      coldBadge(entry),
      ctxBadge(entry),
      kidsBadge(entry),
      Text(() => timeText(a(), data.clock()?.epoch ?? 0))
        .font(10).monospaced().color("tertiary").lineLimit(1),
      infoMark(entry),
    ]),
  ])
    .paddingLeading(9).paddingTrailing(10).paddingVertical(2)
    .background(rowBackground(entry))
    .cornerRadius(8)
    .hoverBackground("#7f7f7f24")
    .opacity(() => (entry().old ? 0.5 : 1))
    .frame({ maxWidth: "infinity" })
    .onTap(() => jump(entry()))
    .contextMenu(rowMenu(entry));
}

// Agent row, t3code-style: dot + identity + time column on the first line,
// status/activity on the second, kind + directory metadata on the third.
function agentRow(entry) {
  const a = () => entry().agent;
  return HStack({ spacing: 8 }, [guide(entry, 30), VStack({ spacing: 2 }, [
    HStack({ spacing: 6 }, [
      Circle({ size: 6 }).fill(() => statusOf(a()).color),
      Text(() => rowTitle(entry().tabTitle) || a().title || a().name)
        .font(12).weight("medium").lineLimit(1).truncation("tail")
        .color(() => (a().status === "ended" ? "tertiary" : "primary")),
      toolTag(entry),
      unreadBadge(entry),
      Spacer(),
      ctxBadge(entry),
      kidsBadge(entry),
      Text(() => timeText(a(), data.clock()?.epoch ?? 0))
        .font(10).monospaced().color("tertiary").lineLimit(1),
      infoMark(entry),
    ]),
    HStack({ spacing: 6 }, [
      Text(() => statusOf(a()).label + (entry().wait ? " · " + entry().wait : "") + (entry().stalled ? " · quiet 20m+" : ""))
        .font(10)
        .color(() => (a().status === "needs_input" || entry().stalled ? "#FF9F0A" : "tertiary")),
      Text(() => {
        // The tool is the tag on the first line. A lane folder loses its common prefix.
        const meta = [];
        const tail = dirTail(a().directory).replace(/^lane-/, "");
        if (tail) meta.push(tail);
        const pr = entry().pr;
        if (entry().prText) meta.push(entry().prText);
        else if (pr) meta.push("#" + pr.number + " " + pr.status);
        return meta.join(" · ");
      })
        .font(10).monospaced().color("tertiary").lineLimit(1).truncation("middle"),
      Spacer(),
    ]).paddingLeading(12),
  ])])
    .paddingLeading(9).paddingTrailing(10).paddingVertical(2)
    .background(rowBackground(entry))
    .cornerRadius(8)
    .hoverBackground("#7f7f7f24")
    .frame({ maxWidth: "infinity" })
    .onTap(() => jump(entry()))
    .contextMenu(rowMenu(entry));
}

// Child (subagent) row: indented under its parent with a tree tick. Running
// children tick a live elapsed; settled ones show their total, muted.
function childRow(entry) {
  const c = () => entry().child;
  return HStack({ spacing: 6 }, [
    guide(entry, 18),
    Text("   └").font(10).monospaced().color("tertiary"),
    Circle({ size: 5 })
      .fill(() => (c().running ? "#0A84FF" : "#7f7f7f55")),
    Text(() => c().label || "subagent")
      .font(11).lineLimit(1).truncation("tail")
      .color(() => (c().running ? "secondary" : "tertiary")),
    Spacer(),
    Text(() => {
      if (c().noTime) return c().running ? "running" : "";
      const epoch = data.clock()?.epoch ?? 0;
      const end = c().running ? epoch : (c().endedEpoch ?? epoch);
      const s = Math.max(0, Math.floor(end - (c().startedEpoch ?? end)));
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60);
      return m < 60 ? m + "m " + String(s % 60).padStart(2, "0") + "s" : Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
    })
      .font(10).monospaced().color("tertiary"),
  ])
    .paddingLeading(9).paddingTrailing(10).paddingVertical(1)
    .cornerRadius(7)
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity" })
    .onTap(() => jump(entry()));
}

sidebar(() =>
  VStack({ spacing: 8 }, [
    HStack({ spacing: 6 }, [
      Text("Agents").font(14).weight("semibold"),
      Spacer(),
      Text(() => {
        const c = counts();
        const bits = [];
        if (c.needs_input > 0) bits.push(c.needs_input + " need you");
        if (c.working > 0) bits.push("● " + c.working + " working");
        if (c.idle > 0) bits.push(c.idle + " idle");
        if (c.ended > 0 && showEnded()) bits.push(c.ended + " ended");
        if (totalCost() >= 1) bits.push("$" + Math.round(totalCost()));
        return bits.join(" · ");
      }).font(10).monospaced().color("tertiary").lineLimit(1),
    ]).paddingHorizontal(10),

    HStack({ spacing: 4 }, [
      toggleButton("Here", () => !scopeAll() && !showLimits(), () => setView({ s: false, l: false })),
      toggleButton("All", () => scopeAll() && !showLimits(), () => setView({ s: true, l: false })),
      toggleButton("Limits", () => showLimits(), () => setView({ l: !showLimits() })),
      Spacer(),
      // No text: this view reads the tab titles, so it runs again when one changes, and serves the hive page's jumps.
      Text(() => hiveGo()).font(1),
      // Opens the hive graph in the browser: workspaces, sessions and subagents as a tree.
      Text("hive ↗").font(11).weight("semibold").color("#0A84FF").paddingHorizontal(6).paddingVertical(3)
        .hoverBackground("#7f7f7f3d").cornerRadius(6)
        .onTap(() => {
          // A browser tab inside cmux: it opens a local page and keeps the data after "#".
          // openURL did not open this link.
          const url = hiveUrl();
          if (url) cmux("browser.open_split", { url, workspace_id: data.selectedId(), focus: true });
          else log("hive: the description carries no home folder yet; the watcher writes it within 15 seconds");
        }),
      toggleButton("Ended", () => showEnded(), () => setView({ e: !showEnded() })),
    ]).paddingHorizontal(10),

    // Filter chips (a second click on the active chip shows all rows again) and the attention sort.
    HStack({ spacing: 3 }, [
      ForEach({ items: () => FILTERS.map((f) => ({ id: f[0], label: f[1] })), key: (f) => f.id },
        // The number of rows that the chip would show. A chip with none is dim.
        (f) => toggleButton(() => f().label + " " + (view().chips[f().id] ?? 0), () => filter() === f().id, () => setView({ c: filter() === f().id ? "" : f().id }))
          .opacity(() => ((view().chips[f().id] ?? 0) === 0 && filter() !== f().id ? 0.45 : 1))),
      Spacer(),
      // Back to the default view: no chip, tab order, all workspaces, no ended rows. The search text stays.
      toggleButton("✕", () => false, () => setView({ c: "", a: false, s: true, e: false, l: false })),
      toggleButton("↑", () => attention(), () => setView({ a: !attention() })),
    ]).paddingHorizontal(10),
    Text(() => {
      const on = FILTERS.find((f) => f[0] === filter());
      return [on ? "showing: " + on[2] : "", attention() ? "sorted: needs attention first" : "",
        scopeAll() ? "" : "this workspace only", showEnded() ? "with ended" : "",
        on || attention() || !scopeAll() || showEnded() ? "✕ resets" : ""].filter(Boolean).join(" · ");
    }).font(10).color("tertiary").lineLimit(1).paddingHorizontal(12),

    VStack({ spacing: 3 }, [ForEach({ items: strip, key: (s) => s.key }, (s) => stripRow(s))]),
    // The Limits view takes the place of the session list.
    VStack({ spacing: 5 }, [ForEach({ items: () => (showLimits() ? limits() : []), key: (s) => s.key }, (s) => stripRow(s, limits().some((x) => x.acct) ? 108 : 58))]),

    TextField("", {
      placeholder: "Search agents",
      autofocus: false,
      onEdit: (t) => setQuery(t ?? ""),
      onSubmit: (t) => setQuery(t ?? ""),
    }).paddingHorizontal(10),

    VStack({ spacing: 3 }, [ForEach(
      { items: entries, key: (e) => e.key },
      (e) => {
        const entry = e(); // kind is stable per key
        if (entry.kind === "header") return headerRow(e);
        if (entry.kind === "child") return childRow(e);
        if (entry.kind === "detail") return detailRow(e);
        return entry.compact ? compactRow(e) : agentRow(e);
      }
    )]),

    Text(() => (entries().length === 0
      ? (query().trim()
        ? "No matches."
        : "No agents yet. Sessions started in cmux terminals show up here with live status.")
      : ""))
      .font(11).color("tertiary").paddingHorizontal(10),
    Spacer(),
  ]).paddingHorizontal(6),
  { surface: "glass" }
)
