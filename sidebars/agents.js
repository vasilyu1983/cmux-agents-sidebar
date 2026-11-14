// SPDX-License-Identifier: GPL-3.0-or-later
// Agents panel for the cmux right sidebar. Started from a panel template that ships with cmux (GPL-3.0-or-later).
// panel-subagents: right-sidebar demo. Every coding-agent session cmux is
// tracking (Claude Code, Codex, ...), grouped by workspace: status dot,
// first-prompt title, live elapsed time, kind + directory metadata, and a
// working/needs-input/idle summary. Click a row to jump to the workspace and
// focus the terminal the agent runs in.
//   cmux right-sidebar set custom panel-subagents

// Colours of the rows, bands, child and detail rows. META is the dim text: times, counts, marks.
const META = "#B4B4BA";
const TEXT2 = "#D1D1D6";
// Text hues. Orange means the owner is needed.
const ORANGE = "#FF9F0A";
const BLUE_TEXT = "#5AA9FF";
const PURPLE_TEXT = "#D68BFF";
const RED_TEXT = "#FF6B61";
// The dot and fill of a session that finished and was not seen.
const DONE_DOT = "#BF5AF2";
// The fill of a pill that only informs.
const NEUTRAL = "#FFFFFF14";

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
// Rows grouped by state (needs you, running, finished, recent, idle) in place of by workspace. Not saved.
const [byState, setByState] = signal(false);
const [openKids, setOpenKids] = signal({});
const [openInfo, setOpenInfo] = signal({});
// The account filter: "" = every account. Not saved; it lasts until the panel reloads.
const [acctFilter, setAcctFilter] = signal("");
// One fixed colour per account name. The status line script uses the same list and the same sum, so a session
// and its row carry one colour.
const ACCT_COLORS = ["#5fd7ff", "#af87ff", "#ff87d7", "#00d7af", "#d7d75f", "#5fafff"];
const acctColor = (name) => {
  let h = 0;
  for (const ch of String(name ?? "")) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
  return ACCT_COLORS[h % ACCT_COLORS.length];
};
const flip = (get, set, id) => set({ ...get(), [id]: !get()[id] });
// One filter chip at a time ("" = all rows), and the row order: tab order, or the sessions that need attention first.
const filter = () => { const c = filterS() ?? saved().c; return FILTERS.some((f) => f[0] === c) ? c : ""; };
const attention = () => attentionS() ?? saved().a;
// Each chip is a short mark, so the row fits a narrow panel; the full name shows on hover.
const FILTERS = [["needs", "!", "needs you"], ["done", "✓", "finished, not seen"], ["working", "▶", "working"], ["ctx", "80%", "context 80% or more"], ["pr", "PR", "has a PR"], ["idle", "1h+", "idle for 1 hour or more"], ["you", "you", "the next step is yours"], ["push", "push", "commits that no remote holds"]];
// "Next: you push both repos": the next step is the reader's when the line starts with "you" or "owner".
const yours = (next) => /^(you|owner)\b/i.test(next ?? "");
// sess.look is the state the row shows (lookOf); sess.done marks "finished, not seen". Without them, the cmux status counts.
const chipHit = (id, a, sess, epoch) =>
  id === "needs" ? (sess.look ?? a.status) === "needs_input"
    : id === "done" ? Boolean(sess.done)
    : id === "working" ? (sess.look ?? a.status) === "working"
    : id === "ctx" ? sess.ctx >= 80
    : id === "pr" ? Boolean(sess.pr)
    : id === "idle" ? (sess.look ?? a.status) === "idle" && epoch - (a.lastActivityAt ?? epoch) > 3600
    : id === "you" ? (sess.look ?? a.status) !== "working" && yours(sess.next)
    : id === "push" ? sess.ahead > 0
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
// A row that the terminal screen shows as working or asking (row.look) is left alone too.
function sendCommand(row, text) {
  if (!text || !row.surfaceId || row.agent.status !== "idle" || row.look !== "idle") return;
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
      // "next you push": the last "Next:" line of the last reply. "comp 3": compactions. "ahead 2": commits that
      // no remote holds. "dup": another live session works in the same folder on the same branch.
      else if (f.startsWith("next ")) s.next = f.slice(5);
      else if (/^comp \d{1,4}$/.test(f)) s.comp = Number(f.slice(5));
      else if (/^ahead \d{1,3}$/.test(f)) s.ahead = Number(f.slice(6));
      else if (f === "dup") s.dup = true;
      // "prompt fix the login test": the owner's last request to the session, cut to 60 characters here.
      else if (f.startsWith("prompt ")) s.prompt = f.slice(7, 67);
      // "title Fix the login test": the title of the session in its tool, for a tab with no title of its own.
      else if (f.startsWith("title ")) s.title = f.slice(6, 54);
      else if (f.startsWith("screen ")) {
        // "screen asks": the state read from the terminal screen, for a tool that publishes no state.
        // Only "working", "asks" and "idle" count; another form is left out.
        const m = /^screen (working|asks|idle)$/.exec(f);
        if (m) s.screen = m[1];
      }
      else if (f.startsWith("acct ")) {
        // "acct work": the account of the session, a short name from your account list. Another form is left out.
        const m = /^acct ([a-z0-9-]{1,16})$/.exec(f);
        if (m) s.acct = m[1];
      }
      else if (f.startsWith("wrong ")) {
        // "wrong work": the folder rules name this account for the session's folder, and the session runs on another.
        const m = /^wrong ([a-z0-9-]{1,16})$/.exec(f);
        if (m) s.wrong = m[1];
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
  idle: { color: "#34C75990", label: "Idle", rank: 2 },
  ended: { color: "#7f7f7f66", label: "Ended", rank: 3 },
};
const statusOf = (a) => STATUS[a.status] ?? { color: "#7f7f7f66", label: a.status, rank: 9 };
// The state a row shows. A cmux "working" or "needs_input" always wins, and an ended record stays ended (older
// records of a tab share its session fields). Otherwise "screen asks" / "screen working" from the watcher counts.
const lookOf = (a, sess) =>
  a.status === "working" || a.status === "needs_input" || a.status === "ended" ? a.status
    : sess.screen === "asks" ? "needs_input" : sess.screen === "working" ? "working" : a.status;
const dotColor = (row) => (row.done ? DONE_DOT : (STATUS[row.look] ?? statusOf(row.agent)).color);

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
  if (m < 60) return m + "m";
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
// the 1s clock), the time since the last activity for settled ones.
function timeText(a, epoch) {
  if ((a.status === "working" || a.status === "needs_input") && a.sinceEpoch) {
    return fmtElapsed(epoch - a.sinceEpoch);
  }
  if (a.lastActivityAt) return fmtAgo(epoch - a.lastActivityAt);
  return "";
}

const dirTail = (d) => {
  const parts = String(d ?? "").split("/").filter((p) => p.length > 0);
  return parts.length ? parts[parts.length - 1] : "";
};

const PR_ALERT = /needs grant|refused|blocked/;
// The pills of a row, in the order in which they matter. Orange: the owner is needed. Red: context 80% or more.
// An account keeps its colour, the view by state adds the workspace in its colour, every other pill is neutral.
function pillsOf(a, sess, w) {
  const out = [];
  const add = (id, text, color, bg) => { if (text) out.push({ id, text: String(text), color, bg }); };
  const plain = (id, text) => add(id, text, META, NEUTRAL);
  const wsName = dirTail(String(w.description ?? "").split(" | ")[0]) || dirTail(w.directory) || w.title;
  if (byState()) add("ws", wsName, w.color || "#8E8E93");
  add("wrong", sess.wrong ? "≠ " + sess.wrong : "", ORANGE);
  const alert = PR_ALERT.test(sess.pr ?? "");
  if (alert) add("pr", sess.pr, ORANGE);
  add("ctx", sess.ctx >= 80 ? sess.ctx + "%" : "", RED_TEXT);
  if (sess.look !== "working" && yours(sess.next)) add("you", "→ you", ORANGE);
  plain("ahead", sess.ahead > 0 ? "↑" + sess.ahead : "");
  plain("dup", sess.dup ? "dup" : "");
  // 10 compactions or more: yellow, a fresh session with a hand-over costs less.
  add("comp", sess.comp >= 3 ? "⟳" + sess.comp : "", sess.comp >= 10 ? "#FFD60A" : META, NEUTRAL);
  plain("cold", sess.look === "idle" ? String(sess.cold ?? "").replace(/^cold /, "❄") : "");
  if (!alert) plain("pr", sess.pr);
  // The account has a pill, in its colour. The tool has none: the end of the second line names the model or the tool.
  add("tool", sess.acct, acctColor(sess.acct));
  const tail = dirTail(a.directory).replace(/^lane-/, "");
  if (tail !== wsName) plain("dir", tail);
  return out;
}
// The second line shows 2 pills, each cut to 10 characters; "+N" stands for the rest and names them on hover.
// The pills have a fixed size, so their total must stay small: a row wider than the panel makes the whole panel
// wider than its place, and cmux then cuts it on both sides.
function cappedPills(all) {
  const short = (p) => (p.text.length > 10 ? { ...p, text: p.text.slice(0, 9) + "…", help: p.text } : p);
  if (all.length <= 2) return all.map(short);
  const rest = all.slice(2);
  return [...all.slice(0, 2).map(short), { id: "more", text: "+" + rest.length, color: META, bg: NEUTRAL, help: rest.map((p) => p.text).join(" · ") }];
}
// A one-line row shows 2 bare marks: no tool and no folder. The workspace counts, in the view by state.
const pill = (p) =>
  Text(() => p().text).font(11).weight("medium").monospaced().lineLimit(1).fixedSize()
    .color(() => p().color).paddingHorizontal(5).paddingVertical(1)
    .background(() => p().bg ?? p().color + "26").cornerRadius(4)
    .help(() => p().help ?? null);
const pillRow = (entry) => ForEach({ items: () => entry().pills, key: (p) => p.id }, pill);

// One flat entry list: workspace headers + agent rows, so a single keyed
// ForEach owns the whole roster (kind is encoded in the key, so templates
// stay stable across live updates).
const view = computed(() => {
  const epoch = data.clock()?.epoch ?? 0;
  const all = data.workspaces() ?? [];
  // A search text looks in every workspace, whatever the scope: a typed query must find the session.
  const scoped = scopeAll() || query().trim() ? all : all.filter((w) => w.selected);
  // Rows per account, counted before the filters: the number on each account chip.
  const accts = {};
  const out = [];
  const flat = [];  // every row of every workspace, for the view by state
  const waiting = [];
  // A row, then its detail lines and its subagent rows when the owner opened them.
  const expand = (r, into) => {
    into.push(r);
    if (openInfo()[r.rowId]) {
      r.info.forEach((l, i) => into.push({
        key: "d:" + r.key + ":" + l[0], kind: "detail", wsId: r.wsId, wsColor: r.wsColor, surfaceId: r.surfaceId,
        label: l[0], value: l[1], last: i === r.info.length - 1,
      }));
    }
    if (!openKids()[r.rowId]) return;
    // Records from disk carry a name and a state, no times and no id: the position is the key.
    const children = r.subs
      ? hiveSubs(r.subs).map((c, k) => ({ id: "s" + k, label: c.n, running: c.r, noTime: true }))
      : [...(r.agent.children ?? [])];
    children.sort((x, y) => (x.running === y.running ? (x.startedEpoch ?? 0) - (y.startedEpoch ?? 0) : x.running ? -1 : 1));
    for (const c of children) {
      into.push({ key: "c:" + r.key + ":" + c.id, kind: "child", wsId: r.wsId, surfaceId: r.surfaceId, wsColor: r.wsColor, agent: r.agent, child: c });
    }
  };
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
          && !matches(w.title) && !matches(a.directory) && !matches(models[sessionName(tabTitle)]?.acct) && !matches(accountMarks().tabs[String(tab?.id ?? "").toUpperCase()])
          && !matches(models[sessionName(tabTitle)]?.prompt)) continue;
      // Fields come by session name; the screen state of a tool without a session name comes by tab id.
      // An ended run in a tab that hosts a live session is an earlier run of that tab. The data of the tab (marks,
      // model, cost, request, focus) belongs to the live session, so the earlier run shows none of it.
      const earlier = a.status === "ended" && liveInTab;
      // All earlier runs of one tab share one row: the newest of them, with their count.
      const runs = earlier ? (w.agents ?? []).filter((b) => b.status === "ended" && b.panelId === a.panelId) : [];
      if (earlier && runs.some((b) => b !== a && ((b.lastActivityAt ?? 0) > (a.lastActivityAt ?? 0)
          || ((b.lastActivityAt ?? 0) === (a.lastActivityAt ?? 0) && runs.indexOf(b) < runs.indexOf(a))))) continue;
      const sess = earlier ? {} : { ...(models[sessionName(tabTitle)] ?? {}), ...(models[String(tab?.id ?? "").toUpperCase()] ?? {}) };
      if (!sess.acct) sess.acct = accountMarks().tabs[String(tab?.id ?? "").toUpperCase()] ?? "";
      sess.look = lookOf(a, sess);
      // "Finished, not seen": the turn ended and the tab has output that the owner has not looked at.
      sess.done = sess.look === "idle" && Boolean(tab?.hasUnread);
      // Every row has the same two lines, so a row keeps its height when its state changes and the list does not jump.
      const settled = (sess.look === "idle" && !sess.done) || sess.look === "ended";
      const stalled = /^\[[^\]]* \?\]/.test(tabTitle);
      // The account of the row: a listed one, or the primary for a tool that can have several.
      const who = sess.acct || (/claude|codex/.test(String(a.kind ?? "")) ? accountMarks().primary : "");
      if (who) accts[who] = (accts[who] ?? 0) + 1;
      if (acctFilter() && who !== acctFilter()) continue;
      for (const id of Object.keys(chips)) if (chipHit(id, a, sess, epoch)) chips[id] += 1;
      if (filter() && !chipHit(filter(), a, sess, epoch)) continue;
      // Subagents: what cmux reports; when it reports none, what label-tabs.py found in the Claude Code records.
      const subs = (a.children ?? []).length > 0 ? null : sess.subs;
      rows.push({
        // Order for the attention sort: asked, finished not seen, stalled, context nearly full, working, idle, ended.
        rank: sess.look === "needs_input" ? 0 : sess.done ? 1 : stalled ? 2 : sess.ctx >= 80 ? 3 : sess.look === "working" ? 4 : sess.look === "idle" ? 5 : 6,
        look: sess.look,
        done: sess.done,
        // The second line: "asked" when the agent asks a question or waits for a permission, "finished · not seen"
        // when its turn ended and the tab is unread, "quiet 20m+" when it stalled. "from screen": the state comes
        // from the terminal screen. A plain working row shows no state word: its dot says it.
        state: [a.status === "needs_input" ? "asked"
          : sess.look === "needs_input" ? "asked · from screen"
          : sess.done ? "finished · not seen" : "", stalled ? "quiet 20m+" : ""].filter(Boolean).join(" · "),
        sessName: sessionName(tabTitle) ?? "",
        sessTitle: sess.title ?? "",
        // The name on the workspace band: the second line leaves the folder out when it only repeats this name.
        wsName: dirTail(String(w.description ?? "").split(" | ")[0]) || dirTail(w.directory) || w.title,
        // The PR of the lane branch where the session works, with the state from your merge tool: "#644 needs grant".
        prText: sess.pr ?? "",
        acct: sess.acct ?? "",
        wrong: sess.wrong ?? "",
        // Work marks (pillsOf): a duplicate session, commits that no remote holds, 3 or more compactions.
        // The request the session works on: what label-tabs.py read from the transcript, else what cmux reports.
        // A text that starts with "<" or "[SYSTEM" is a notice that the tool added, not a request of the user.
        prompt: (earlier ? [] : [sess.prompt, tab?.latestPrompt]).map((t) => String(t ?? "").replace(/\s+/g, " ").trim())
          .find((t) => t && !/^(<|\[SYSTEM)/.test(t))?.slice(0, 120) ?? "",
        // After the pills, a bare "next" label when the text of the line is the next step and not the request.
        // A row with a "+N" pill has no room for the label.
        pills: ((shown) => [...shown,
          ...(shown.length <= 2 && a.status !== "needs_input" && sess.look !== "working" && sess.next ? [{ id: "nextl", text: "next", color: TEXT2, bg: "clear" }] : [])])(cappedPills(pillsOf(a, sess, w))),
        // The second line: why it waits; else what comes next for a session that does not work; else the request.
        line2: earlier ? (runs.length > 1 ? runs.length + " earlier runs in this tab" : "earlier run in this tab") : (a.status === "needs_input" && sess.wait) || (sess.look !== "working" && sess.next) || "",
        // The end of the second line, in three columns: the model (the tool when no model is known), the context
        // share (yellow from 50%; from 80% it is a red pill, not a column value) and the cost.
        model: String(sess.model ?? "").split(" ")[0] || String(a.kind ?? ""),
        ctxText: sess.ctx >= 0 && sess.ctx < 80 ? sess.ctx + "%" : "",
        ctxWarm: sess.ctx >= 50,
        costText: sess.cost ?? "",
        stalled,
        cold: sess.look === "idle" ? String(sess.cold ?? "").replace(/^cold /, "❄") : "",
        folder: String(a.directory ?? ""),
        // Why the session waits, and its context share when that is 80% or more (the row shows it in red).
        wait: a.status === "needs_input" ? sess.wait ?? "" : "",
        key: "a:" + w.id + ":" + a.id,
        kind: "agent",
        focused: !earlier && Boolean(w.selected && tab?.focused),
        unread: !earlier && Boolean(tab?.hasUnread),
        rowId: w.id + ":" + a.id,
        // Detail lines, shown when the owner opens the row with the "›" mark. Empty values are left out.
        info: [
          ["state", statusOf(a).label + (a.sinceEpoch && a.status !== "idle" ? " for " + fmtElapsed(epoch - a.sinceEpoch) : "")],
          ["lane", sess.lane ?? (/\/lane-([^/]+)/.exec(String(a.directory ?? "")) ?? [])[1] ?? ""],
          ["pr", sess.pr ?? ""],
          ["cache", sess.cold ? sess.cold + " tokens to rewrite on the next message" : ""],
          ["waits", a.status === "needs_input" ? sess.wait ?? "" : ""],
          ["next", a.status === "working" ? "" : sess.next ?? ""],
          ["duplicate", sess.dup ? "another live session works in this folder on this branch" : ""],
          ["not pushed", sess.ahead > 0 ? sess.ahead + " commit(s) that no remote holds" : ""],
          ["compacted", sess.comp > 0 ? sess.comp + " time(s)" + (sess.comp >= 3 ? "; a fresh session with a hand-over costs less context" : "") : ""],
          ["tool", a.name],
          ["account", sess.acct || (accountMarks().primary && /claude|codex/.test(String(a.kind ?? "")) ? accountMarks().primary + " (primary)" : "")],
          ["rule", sess.wrong ? "the folder rule names " + sess.wrong + "; start the session again on that account" : ""],
          ["model", sess.model ?? ""],
          ["context", sess.ctx >= 0 ? sess.ctx + "%" : ""],
          ["cost", sess.cost ?? ""],
          ["folder", String(a.directory ?? "").replace(/^\/Users\/[^/]+/, "~")],
          ["branch", tab?.branch ? tab.branch + (tab.dirty ? " (changed files)" : "") : ""],
          ["ports", (tab?.ports ?? []).join(", ")],
          ["first ask", a.title ?? ""],
          ["last ask", tab?.latestPrompt ?? ""],
          ["last prompt", sess.prompt ?? ""],
          ["title", sess.title ?? ""],
        ].filter((l) => l[1]),
        kids: subs ? subs.total : (a.children ?? []).length,
        kidsRunning: subs ? subs.run : (a.children ?? []).filter((c) => c.running).length,
        subs,
        // Dim a session with no activity for over an hour.
        old: settled && epoch - (a.lastActivityAt ?? epoch) > 3600,
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
    if (rows.length === 0 && (query().trim() || filter() || acctFilter())) continue;
    // Same order as the tabs of the workspace; waiting sessions also show in the top block.
    // The "attention" toggle puts the sessions that need the owner first, and keeps tab order inside each rank.
    rows.sort((x, y) => (attention() ? x.rank - y.rank : 0) || x.tabIndex - y.tabIndex);
    out.push({
      // An empty workspace is a thin line, not a band: the key carries the form, as for the rows.
      key: "h:" + w.id + (rows.length ? "" : ":e"),
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
      dots: rows.map(dotColor),
    });
    // A folded group still reports its waiting sessions to the top block.
    for (const r of rows) if (r.look === "needs_input") waiting.push({ ...r, key: "n:" + r.key });
    for (const r of rows) flat.push({ ...r, age: epoch - (r.agent.lastActivityAt ?? epoch) });
    if (collapsed()[w.id]) continue;
    // A waiting session also shows in the top block; its copy in the workspace has its own key.
    for (const r of rows) expand(r.look === "needs_input" ? { ...r, key: r.key + ":w" } : r, out);
  }
  // "Needs you": every waiting session of every workspace, longest wait first, above the groups.
  waiting.sort((x, y) => (x.agent.sinceEpoch ?? 0) - (y.agent.sinceEpoch ?? 0));
  if (byState()) {
    // Sections in the order in which they need the owner; inside a section, the most recent activity first.
    const SECTIONS = [
      ["NEEDS YOU", "#FF9F0A", (r) => r.look === "needs_input"],
      ["FINISHED · NOT SEEN", "#BF5AF2", (r) => r.done],
      ["RUNNING", "#0A84FF", (r) => r.look === "working"],
      ["RECENT", "#34C759", (r) => r.look === "idle" && !r.done && r.age <= 3600],
      ["IDLE", "#8E8E93", (r) => r.look === "idle" && !r.done && r.age > 3600],
      ["ENDED", "#8E8E93", (r) => r.look === "ended"],
    ];
    const list = [];
    for (const [title, color, test] of SECTIONS) {
      const rows = flat.filter(test).sort((x, y) => x.age - y.age);
      if (rows.length === 0) continue;
      list.push({ key: "h:state:" + title, kind: "header", needsYou: true, wsTitle: title, wsColor: color, count: rows.length });
      for (const r of rows) expand(r, list);
    }
    return { rows: list, chips, accts };
  }
  if (waiting.length === 0) return { rows: out, chips, accts };
  return { chips, accts, rows: [{ key: "h:needs-you", kind: "header", needsYou: true, wsTitle: "NEEDS YOU", wsColor: ORANGE, count: waiting.length }, ...waiting, ...out] };
});
// A search text brings the session list back, also while Limits is on: a search must always find sessions.
const limitsShown = () => showLimits() && !query().trim();
const entries = computed(() => (limitsShown() ? [] : view().rows));

// The project strip: the "@train", "@queue" and "@unpushed" parts that label-tabs.py puts in a workspace description.
// Read from every workspace, also when the list shows one workspace only.
const STRIP = { train: ["train", "secondary"], queue: ["run", "#FF9F0A"], unpushed: ["unpushed", "#FF9F0A"] };
// The Limits view: "@limits: claude,5h,42,14:10,1794650000;codex,week,4,Sat 09:39,1794600000;grok,,,,0".
// label-tabs.py reads the limit windows that each tool leaves in local files. An item with no window is a tool
// that is installed and leaves no limit data.
const TOOLS = { claude: "Claude", codex: "Codex", opencode: "OpenCode", grok: "Grok", agy: "Antigravity" };
// "@primary: personal" names the account of the tool's normal folder; "@accts: <tab id>=work,..." names the account
// of a tab whose tool keeps no session record (Codex). Both come from label-tabs.py.
const accountMarks = computed(() => {
  const out = { primary: "", tabs: {} };
  for (const w of data.workspaces() ?? []) {
    for (const part of String(w.description ?? "").split(" | ")) {
      const p = /^@primary: ([a-z0-9-]{1,16})$/.exec(part);
      if (p) out.primary = p[1];
      if (!part.startsWith("@accts: ")) continue;
      for (const item of part.slice(8).split(",").slice(0, 200)) {
        const m = /^([0-9A-F-]{36})=([a-z0-9-]{1,16})$/.exec(item);
        if (m) out.tabs[m[1]] = m[2];
      }
    }
  }
  return out;
});
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
    let color = META;
    let bar = -1;  // no bar for a line without a live window
    // A live window shows in columns: bar, percent, then the rest of the text (window, reset time, age).
    let pct = "";
    let rest = "";
    if (m[3] !== "") {
      const used = Number(m[3]);
      if (m[4] === "ended") value = (m[2] || "limit") + " window ended · last value " + used + "%" + age;
      else {
        value = (m[2] || "limit") + " " + used + "%" + (m[4] ? " · resets " + m[4] : "") + age;
        bar = Math.min(100, used);
        pct = used + "%";
        rest = (m[2] || "limit") + (m[4] ? " · resets " + m[4] : "");  // the age shows on hover
      }
    }
    const primary = (m[1] === "claude" || m[1] === "codex") ? accountMarks().primary : "";
    const label = TOOLS[m[1]] + (m[6] ? " " + m[6] : primary ? " " + primary : "");
    // The key carries the form (with or without a bar), because a row's template is fixed per key.
    out.push({ key: "limit" + out.length + m[1] + m[2] + (bar >= 0 ? ":b" : ""), label, value, color, copy: label + " " + value, bar, pct, rest, wsId: newest.wsId, tool: Object.keys(TOOLS).indexOf(m[1]), acct: m[6] ?? "" });
  }
  // Lines of one tool stay together, and inside a tool the lines of one account.
  out.sort((a, b) => a.tool - b.tool || (a.acct < b.acct ? -1 : a.acct > b.acct ? 1 : 0));
  // The tools and accounts with no limit data share one dim line, in place of one line each.
  const none = out.filter((x) => x.bar < 0 && x.value === "no limit data on this Mac");
  if (none.length) {
    for (const x of none) out.splice(out.indexOf(x), 1);
    const names = none.map((x) => x.label).join(", ");
    out.push({ key: "limit-nodata", label: "no data", value: names, color: META, copy: "no limit data on this Mac: " + names, bar: -1, wsId: newest.wsId, acct: "" });
  }
  // The cost estimate per account, summed over the sessions that report one (Claude Code only).
  const sums = {};
  for (const w of accountMarks().primary ? data.workspaces() ?? [] : []) {
    for (const s of Object.values(sessionsOf(w))) {
      const cost = parseFloat(String(s.cost ?? "").slice(1)) || 0;
      if (!cost) continue;
      const who = s.acct || accountMarks().primary;
      sums[who] = { sum: (sums[who]?.sum ?? 0) + cost, n: (sums[who]?.n ?? 0) + 1 };
    }
  }
  for (const who of Object.keys(sums).sort()) {
    const value = "$" + sums[who].sum.toFixed(2) + " · " + sums[who].n + (sums[who].n === 1 ? " session" : " sessions");
    out.push({ key: "cost-" + who, label: "cost " + who, value, color: "secondary", copy: "cost " + who + " " + value, wsId: data.selectedId(), acct: who });
  }
  if (out.length === 0) out.push({ key: "limit-none", label: "limits", value: "no data yet: the watcher writes it within 15 seconds", color: META, copy: "", wsId: data.selectedId() });
  return out;
});

// "merged #12; refused none; skipped none" reads "merged #12": a clause that only says "none" is left out.
// A text with nothing but such clauses stays as it is.
const dropNone = (text) => {
  const kept = text.split("; ").filter((c) => !/^\w+ none$/.test(c.trim()));
  return kept.length ? kept.join("; ") : text;
};
const strip = computed(() => {
  const out = [];
  for (const w of data.workspaces() ?? []) {
    for (const part of String(w.description ?? "").split(" | ").slice(1)) {
      const at = part.indexOf(": ");
      const kind = STRIP[part.slice(1, at)];
      if (part.startsWith("@") && kind) {
        const raw = part.slice(at + 2);
        const name = part.slice(1, at);
        const value = name === "train" ? dropNone(raw) : raw;
        out.push({
          key: w.id + part.slice(0, at), label: kind[0], value, wsId: w.id, color: kind[1], bar: -1,
          // The menu copies the text as it is. Nothing here builds or runs a command.
          copy: raw,
        });
      }
    }
  }
  // One limit line per tool that reports a live window: its highest window over all accounts, with the account,
  // the window and the reset time. The Limits view lists them all, so these lines leave it.
  const top = {};
  for (const x of limitsShown() ? [] : limits()) {
    if (x.bar >= 0 && (!top[x.tool] || x.bar > top[x.tool].bar)) top[x.tool] = x;
  }
  for (const x of Object.values(top)) {
    const tool = Object.keys(TOOLS)[x.tool];
    out.push({
      key: "lim:" + tool + ":p", label: tool, value: x.label + " " + x.value, wsId: x.wsId,
      color: x.bar >= 80 ? "#FF453A" : "secondary", bar: x.bar, pct: x.pct,
      rest: [x.label.split(" ").slice(1).join(" "), x.rest].filter(Boolean).join(" · "), copy: x.copy,
    });
  }
  return out;
});

const counts = computed(() => {
  const all = data.workspaces() ?? [];
  const c = { working: 0, needs_input: 0, idle: 0, ended: 0 };
  for (const w of all) {
    // The earlier runs of a tab that hosts a live session count as one, as they share one row.
    const live = new Set((w.agents ?? []).filter((a) => a.status !== "ended").map((a) => a.panelId));
    const folded = new Set();
    for (const a of w.agents ?? []) {
      if (a.status === "ended" && live.has(a.panelId)) {
        if (folded.has(a.panelId)) continue;
        folded.add(a.panelId);
      }
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
// view: the view that the page opens on ("timeline", "limits", ...); without it, the view that the page had last.
// sel: a session name that the Timeline view marks.
function hiveUrl(mark, view, sel) {
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
  return "file://" + home + "/.config/cmux/scripts/hive.html#" + encodeURIComponent(JSON.stringify({ t: data.clock()?.epoch ?? 0, v: view ?? "", sel: sel ?? "", ws }));
}

// Opens the views page (hive.html) as a browser tab inside cmux: it opens a local page and keeps the data after "#".
// openURL did not open this link.
function openViews(view, sel) {
  const url = hiveUrl(undefined, view, sel);
  if (url) cmux("browser.open_split", { url, workspace_id: data.selectedId(), focus: true });
  else log("views: the description carries no home folder yet; the watcher writes it within 15 seconds");
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

// Opens a new terminal tab in a workspace and focuses it. "surface.create" with these parameters comes from another
// published panel and is not checked here yet. Nothing is typed into the tab: the panel does not reliably learn its id.
function newTab(wsId) {
  if (wsId) cmux("surface.create", { workspace_id: wsId, focus: true });
}

// A plain toggle of the control row: dim when off, primary on a light fill when on. At least 24 pt tall.
function toggleButton(labelFn, activeFn, onTapFn) {
  return Text(labelFn)
    .font(12).weight("medium").lineLimit(1).fixedSize()
    .paddingHorizontal(6).frame({ minHeight: 24 })
    .cornerRadius(6)
    .color(() => (activeFn() ? "primary" : META))
    .background(() => (activeFn() ? "#FFFFFF26" : null))
    .hoverBackground("#FFFFFF14")
    .onTap(onTapFn);
}
// One segment of the Here | All | Limits group. The selected one has the light fill and no hover.
const segment = (label, activeFn, onTapFn) =>
  Text(label).font(12).weight("medium").lineLimit(1).fixedSize()
    .paddingHorizontal(10).paddingVertical(4).cornerRadius(6)
    .color(() => (activeFn() ? "primary" : META))
    // No hover fill: a hover fill beside the selected one reads as two selections.
    .background(() => (activeFn() ? "#FFFFFF2E" : "clear"))
    .onTap(onTapFn);
// A capsule chip: a label and its count.
const chip = (labelFn, countFn, activeFn, onTapFn) =>
  HStack({ spacing: 4 }, [
    Text(labelFn).font(12).weight("medium").lineLimit(1).fixedSize().color(() => (activeFn() ? "primary" : TEXT2)),
    Text(countFn).font(11).monospaced().lineLimit(1).fixedSize().color(META),
  ])
    .paddingHorizontal(10).paddingVertical(4).cornerRadius(12)
    .background(() => (activeFn() ? "#FFFFFF26" : "#FFFFFF0F"))
    .hoverBackground("#FFFFFF1A")
    .onTap(onTapFn);
// A used share as a bar on a grey track: green below 50%, orange from 50%, red from 80%. The fill is at least 3 pt.
const usedBar = (pctFn, width, height) =>
  ZStack({}, [
    Capsule().fill("#7f7f7f40").frame({ width, height }),
    HStack({ spacing: 0 }, [
      Capsule().fill(() => (pctFn() >= 80 ? "#FF453A" : pctFn() >= 50 ? ORANGE : "#34C759"))
        .frame(() => ({ width: Math.max(3, width * pctFn() / 100), height })),
      Rectangle().fill("clear").frame({ maxWidth: "infinity", height }),
    ]).frame({ width, height }),
  ]).frame({ width, height });

// The workspace colour at a given alpha ("14" is about 8%). A colour that is not "#RRGGBB" gets a faint white.
// A cell with a fixed width and the text at one side. A frame alone centres its text.
const cell = (text, width, side) =>
  HStack({ spacing: 0 }, side === "trailing" ? [Spacer(), text.fixedSize()] : [text.fixedSize(), Spacer()]).frame({ width });
// A workspace colour that shows on a dark panel: a dark colour is mixed with white up to a fixed brightness.
const seen = (color, floor = 120) => {
  if (!/^#[0-9A-Fa-f]{6}$/.test(color ?? "")) return floor > 120 ? META : "#8E8E93";
  const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  if (lum >= floor) return color;
  const t = (floor - lum) / (255 - lum);
  return "#" + c.map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, "0")).join("");
};
// The same colour for text: brighter, so a name reads on its own tint (4.5:1 or more).
const ink = (color) => seen(color, 170);
const tint = (color, alpha) => (/^#[0-9A-Fa-f]{6}$/.test(color ?? "") ? seen(color) + alpha : "#FFFFFF0A");
// The rows of a workspace sit 12 pt inside its band. The top block and the view by state have no band above them.
const inset = (entry) => () => (byState() || /^(?:[dc]:)?n:/.test(String(entry().key ?? "")) ? 0 : 12);
// Right-click on a workspace band or line: "New tab here".
const bandMenu = (entry) => [Button("New tab here", () => newTab(entry().wsId))];
const selectWs = (entry) => () => cmux("workspace.select", { workspace_id: entry().wsId });
// "+" opens a new tab in the workspace, as the right-click menu does.
const plusMark = (entry) => Text("+").font(12).color(TEXT2).frame({ width: 22, height: 22 }).onTap(() => newTab(entry().wsId));

// A header: a section of the view by state (and the "NEEDS YOU" block), an empty workspace, or a workspace band.
// The form is fixed per key.
function headerRow(entry) {
  const first = entry();
  if (first.needsYou) return sectionRow(entry);
  return first.count ? bandRow(entry) : emptyRow(entry);
}

// A section: its name in the section colour, the count, then a hairline to the right edge. No tint, no menu.
function sectionRow(entry) {
  return VStack({ spacing: 0 }, [
    Rectangle().fill("clear").frame({ height: 8 }),
    HStack({ spacing: 6 }, [
      Text(() => entry().wsTitle).font(11).weight("bold").lineLimit(1).fixedSize().color(() => entry().wsColor),
      Text(() => String(entry().count)).font(11).monospaced().color(META),
      Rectangle().fill("#7f7f7f40").frame({ height: 1, maxWidth: "infinity" }),
    ]).paddingHorizontal(8).paddingVertical(5).frame({ maxWidth: "infinity" }),
  ]).frame({ maxWidth: "infinity" });
}

// A workspace with no session: one flat line in its own colour, at the left edge of the bands. No fill; a hairline above it
// ends the group before it. A click selects the workspace.
function emptyRow(entry) {
  return VStack({ spacing: 0 }, [
    Rectangle().fill("clear").frame({ height: 7 }),
    Rectangle().fill("#7f7f7f33").frame({ height: 1, maxWidth: "infinity" }),
    Rectangle().fill("clear").frame({ height: 5 }),
    HStack({ spacing: 4 }, [
      HStack({ spacing: 7 }, [
        Capsule().fill(() => seen(entry().wsColor)).frame({ width: 4, height: 12 }),
        Text(() => entry().wsTitle || "untitled").font(12).weight("medium").color(() => ink(entry().wsColor)).lineLimit(1).truncation("tail"),
        Spacer(),
      ]).frame({ maxWidth: "infinity" }).onTap(selectWs(entry)),
      plusMark(entry).showOnHover(),
    ])
      .paddingLeading(30).paddingTrailing(4).paddingVertical(2)
      .hoverBackground(() => tint(entry().wsColor, "2E"))
      .cornerRadius(8)
      .frame({ maxWidth: "infinity" })
      .contextMenu(bandMenu(entry)),
  ]).frame({ maxWidth: "infinity" });
}

// A workspace band, tinted in the workspace colour: fold mark, name, unread, then "sessions · cost" and "+".
// The dots, one per session, show while the band is folded (the roster's shape at a glance).
function bandRow(entry) {
  return VStack({ spacing: 0 }, [
    Rectangle().fill("clear").frame({ height: 12 }),
    HStack({ spacing: 4 }, [
      Text(() => (entry().folded ? "▸" : "▾"))
        .font(12).color(TEXT2).frame({ width: 22, height: 22 })
        .onTap(() => toggleFold(entry().wsId)),
      HStack({ spacing: 7 }, [
        Capsule().fill(() => seen(entry().wsColor)).frame({ width: 4, height: 16 }),
        Text(() => entry().wsTitle || "untitled")
          .font(13).weight("bold").lineLimit(1).truncation("tail").color(() => ink(entry().wsColor)),
        Spacer(),
        ForEach(
          { items: () => (entry().folded ? entry().dots.map((c, i) => ({ id: String(i) + c, color: c })) : []), key: (d) => d.id },
          (d) => Circle({ size: 5 }).fill(() => d().color)
        ),
        // Unread notifications of the workspace, as the left list shows them.
        ForEach({ items: () => (entry().unread ? [{ id: "unread" }] : []), key: (x) => x.id },
          () => HStack({ spacing: 3 }, [
            Circle({ size: 6 }).fill(DONE_DOT),
            Text(() => String(entry().unread)).font(11).monospaced().color(PURPLE_TEXT),
          ])),
        // The session count and the summed cost estimate of the workspace's sessions (Claude Code only).
        Text(() => String(entry().count) + (entry().cost >= 1 ? " · $" + Math.round(entry().cost) : ""))
          .font(11).monospaced().lineLimit(1).fixedSize().color(META),
      ]).frame({ maxWidth: "infinity" }).onTap(selectWs(entry)),
      plusMark(entry),
    ])
      .paddingHorizontal(4).paddingVertical(5)
      .background(() => tint(entry().wsColor, entry().wsSelected ? "3D" : "29"))
      .hoverBackground(() => tint(entry().wsColor, "47"))
      .cornerRadius(8)
      .frame({ maxWidth: "infinity" })
      .contextMenu(bandMenu(entry)),
  ]).frame({ maxWidth: "infinity" });
}

// A thin line in the workspace colour on the left of each row: the rows read as the inside of their group.
const guide = (entry, height) =>
  Rectangle().fill(() => seen(entry().wsColor)).opacity(0.7).frame({ width: 2, height });

// "[name] title" where the title only repeats the name (a session with a custom name): show it once.
const rowTitle = (t) => {
  const m = /^\[([^\]]+)\] (.*)$/.exec(t ?? "");
  return m && m[1].replace(/ [!?]$/, "") === m[2] ? "[" + m[1] + "]" : t;
};

// One line of the project strip: a dim label and its text on one line; the hover shows the whole text. A week
// line that starts with a percent shows the percent, a bar, then the rest. A click opens the workspace that carries it.
// The view of the views page that fits a strip or Limits line, with the text of its menu item.
const VIEW_OF = (key) => (String(key).startsWith("cost-") ? ["cost", "Show the cost map"]
  : String(key).startsWith("limit") ? ["limits", "Show the limit forecast"] : ["timeline", "Show the timeline"]);

function stripRow(entry) {
  const value = entry().bar >= 0
    ? [
      Text(() => entry().pct).font(12).lineLimit(1).fixedSize().color(() => entry().color),
      usedBar(() => entry().bar, 44, 4),
      Text(() => entry().rest).font(11).color(META).lineLimit(1).truncation("tail").layoutPriority(1).help(() => entry().value),
    ]
    : [Text(() => entry().value).font(12).color(() => entry().color).lineLimit(1).truncation("tail").layoutPriority(1).help(() => entry().value)];
  return HStack({ spacing: 8 }, [
    cell(Text(() => entry().label).font(11).color(META).lineLimit(1), 56, "leading"),
    ...value,  // plain parts of the row: a text inside an inner HStack is cut while the row has space
    Spacer(),
  ])
    .paddingHorizontal(10)
    .frame({ maxWidth: "infinity" })
    .onTap(() => cmux("workspace.select", { workspace_id: entry().wsId }))
    .contextMenu([
      Button("Copy the text", () => clipboard.write(entry().copy)),
      Button(() => VIEW_OF(entry().key)[1], () => openViews(VIEW_OF(entry().key)[0])),
    ]);
}

// A line of the Limits view, in fixed columns so the bars line up: label, bar, percent (primary from 80%), then
// the window, reset time and age. A line without a live window, and a cost line, shows its text after the label.
function limitRow(entry, width) {
  const cells = entry().bar >= 0
    ? [
      usedBar(() => entry().bar, 60, 5),
      cell(Text(() => entry().pct).font(11).monospaced().lineLimit(1)
        .color(() => (entry().bar >= 80 ? "primary" : META)), 34, "trailing"),
      Text(() => entry().rest).font(11).color(META).lineLimit(1).truncation("tail").help(() => entry().value),
    ]
    : [Text(() => entry().value).font(11).color(() => entry().color).lineLimit(3).truncation("tail").layoutPriority(1).help(() => entry().value)];
  return HStack({ spacing: 8, alignment: "top" }, [
    cell(Text(() => entry().label).font(11).color(TEXT2).lineLimit(1), width, "leading"),
    ...cells,
    Spacer(),
  ])
    .paddingHorizontal(10)
    .frame({ maxWidth: "infinity" })
    .onTap(() => cmux("workspace.select", { workspace_id: entry().wsId }))
    .contextMenu([
      Button("Copy the text", () => clipboard.write(entry().copy)),
      Button(() => VIEW_OF(entry().key)[1], () => openViews(VIEW_OF(entry().key)[0])),
    ]);
}


// Right-click menu of a session row. The command items type into the session's tab, and only while it is idle.
function rowMenu(entry) {
  const cmd = commandsOf(entry().agent);
  const items = [
    Button("Go to session", () => jump(entry())),
    Button(() => (openInfo()[entry().rowId] ? "Hide details" : "Show details"), () => flip(openInfo, setOpenInfo, entry().rowId)),
    Button(() => "Copy name" + (entry().sessName ? ": " + entry().sessName : ""), () => clipboard.write(entry().sessName || entry().tabTitle)),
    Button("Copy folder", () => clipboard.write(entry().folder)),
    Button("Show in timeline", () => openViews("timeline", entry().sessName)),
    Button(() => (entry().prText ? "Copy PR " + entry().prText.split(" ")[0] : "No PR for this session"),
      () => { if (entry().prText) clipboard.write(entry().prText.split(" ")[0]); }),
  ];
  if (cmd.compact || cmd.usage) items.push(Divider());
  for (const text of [cmd.compact, cmd.usage]) {
    if (!text) continue;
    if (cmd.send) {
      items.push(Button(() => (entry().agent.status === "idle" && entry().look === "idle" ? "Send " + text : text + " (only when idle)"), () => sendCommand(entry(), text)));
    } else {
      items.push(Button("Copy " + text, () => clipboard.write(text)));
    }
  }
  return items;
}

// "new": unread output. A finished-not-seen row leaves it out: its tint and its state say it already.
const unreadBadge = (entry) =>
  Text(() => (entry().unread && !entry().done ? "new" : "")).font(11).weight("semibold").color(PURPLE_TEXT);
// "▸ 2 sub running": the subagents of a session as a count. A click opens or closes their rows.
// The subagent count: blue while one runs, else a calm teal, so it reads apart from the grey time.
const KIDS = "#6AC4DC";
// One soft hue per kind of figure at the end of a row, so model, context and cost read apart at a glance.
// The saturated colours stay for states: blue works, orange waits for you, yellow and red warn.
const MODEL_INK = "#BDB2E8";  // lavender
const CTX_INK = "#A9C0D4";    // slate blue
const COST_INK = "#D8BE8C";   // sand
const kidsBadge = (entry) =>
  Text(() => {
    const e = entry();
    if (!e.kids) return "";
    return (openKids()[e.rowId] ? "▾" : "▸") + (e.kidsRunning ? e.kidsRunning + "/" + e.kids : e.kids);
  }).font(11).monospaced().lineLimit(1).fixedSize()
    .color(() => (entry().kidsRunning ? BLUE_TEXT : KIDS))
    .onTap(() => flip(openKids, setOpenKids, entry().rowId));
// "›" at the end of a row opens its detail lines and shows on hover only; "⌄" closes them and stays in view.
const infoMark = (entry) =>
  Text(() => (openInfo()[entry().rowId] ? "⌄" : "›"))
    .font(12).color(TEXT2).paddingHorizontal(4)
    .showOnHover(() => !openInfo()[entry().rowId])
    .onTap(() => flip(openInfo, setOpenInfo, entry().rowId));

// Child and detail lines start under the title of their row: past the 13 pt dot and its 6 pt gap.
const UNDER_TITLE = 19;

// One detail line under an agent row: a dim label and its value.
function detailRow(entry) {
  return HStack({ spacing: 8 }, [
    guide(entry, 16),
    HStack({ spacing: 8 }, [
      cell(Text(() => entry().label).font(11).monospaced().color(META), 58, "leading"),
      Text(() => entry().value).font(11).color(TEXT2).lineLimit(2).truncation("tail"),
      Spacer(),
    ]).paddingLeading(UNDER_TITLE),
  ])
    .paddingLeading(9).paddingTrailing(10)
    .frame({ maxWidth: "infinity" })
    .marginLeading(inset(entry))
    .onTap(() => jump(entry()));
}

// A card: tinted orange with an orange border when the session asks, purple when it finished and was not seen.
// Only a row that says something has a fill: the focused one, one that asks, one that finished unseen.
// Every other row is flat, so the list is not a stack of boxes; the band and the rail carry the group.
const rowBackground = (entry) => () =>
  (entry().focused ? "#FFFFFF24" : entry().look === "needs_input" ? "#FF9F0A26" : entry().done ? "#BF5AF226" : "clear");
// The status dot, with a halo for a row that works, asks or finished unseen. The 13 pt frame is always there,
// so the titles line up.
const haloDot = (entry) => {
  const halo = () => entry().look === "working" || entry().look === "needs_input" || entry().done;
  return ZStack({}, [
    Circle({ size: 13 }).fill(() => (halo() ? dotColor(entry()) + "33" : "clear")),
    Circle({ size: 7 }).fill(() => dotColor(entry())),
  ]).frame({ width: 13, height: 13 });
};
// "[name] rest": the name in bold, the rest dim, and the rest truncates first. The rest is left out when it only
// names the tool.
const titleParts = (entry) => {
  const a = entry().agent;
  const t = rowTitle(entry().tabTitle) || a.title || a.name || "";
  const m = /^(\[[^\]]+\]) (.+)$/.exec(t);
  // A tab with no title of its own shows the title of the session in its tool. The request is on the second line.
  const ask = entry().sessTitle;
  const bare = /^\[[^\]]+\]$/.exec(t);
  if (bare) return { name: t, rest: ask };
  if (!m) return { name: t, rest: "" };
  const tool = [a.name, a.kind, "Claude Code"].some((x) => x && String(x).toLowerCase() === m[2].toLowerCase());
  return { name: m[1], rest: tool ? ask : m[2] };
};
// The first line of a row: dot, name, unread mark, then subagents, time and the detail mark. An old settled row
// shows its name dim.
const titleLine = (entry) => {
  const a = () => entry().agent;
  return HStack({ spacing: 6 }, [
    haloDot(entry),
    // Both parts are plain texts of the row and rank above the gap, so a title is cut only when the row is full.
    // A text inside a wrapper (a ForEach, an inner HStack) is cut while the row still has space.
    Text(() => titleParts(entry).name)
      .font(13).weight("semibold").lineLimit(1).truncation("tail").layoutPriority(3)
      .color(() => (a().status === "ended" || entry().old ? META : "primary")),
    Text(() => titleParts(entry).rest).font(13).lineLimit(1).truncation("tail").layoutPriority(2).color(META),
    unreadBadge(entry),
    Spacer(),
    kidsBadge(entry),
    cell(Text(() => timeText(a(), data.clock()?.epoch ?? 0))
      .font(11).monospaced().lineLimit(1)
      // Grey reads 4.36:1 on the fill of the focused row, so the time is lighter there.
      .color(() => (entry().look === "needs_input" ? ORANGE : entry().focused ? TEXT2 : META)), 36, "trailing"),
    infoMark(entry),
  ]);
};
const card = (entry, row) => row
  .paddingLeading(9).paddingTrailing(8)
  .background(rowBackground(entry))
  .cornerRadius(10)
  .borderWidth(1)
  // The focused row has a fill and an outline; a row under the pointer has a faint fill only, so the two differ.
  .borderColor(() => (entry().look === "needs_input" ? "#FF9F0A73" : entry().focused ? "#FFFFFF47" : "clear"))
  .hoverBackground("#FFFFFF0D")
  .frame({ maxWidth: "infinity" })
  .marginLeading(inset(entry))
  .onTap(() => jump(entry()))
  .contextMenu(rowMenu(entry));

// Every session takes the same two lines. The first: name, title, subagents and time. The second: the state word,
// the pills, then why it waits, what comes next or the request, and at the end model, context share and cost.
function agentRow(entry) {
  const hot = () => entry().look === "needs_input" || entry().stalled;
  return card(entry, HStack({ spacing: 8 }, [guide(entry, 34), VStack({ spacing: 4 }, [
    titleLine(entry),
    // The texts are plain parts of the line: a text inside a wrapper is cut while the line still has space.
    HStack({ spacing: 5 }, [
      pillRow(entry),
      Text(() => [entry().state, entry().line2 || entry().prompt].filter(Boolean).join(" · "))
        .font(12).lineLimit(1).truncation("tail").layoutPriority(1)
        .color(() => (hot() ? ORANGE : entry().done ? PURPLE_TEXT : META)),
      Spacer(),
      // Three columns with fixed widths, so model, context and cost line up down the list.
      cell(Text(() => entry().model).font(11).weight("medium").lineLimit(1).color(MODEL_INK), 46, "trailing"),
      cell(Text(() => entry().ctxText).font(11).monospaced().lineLimit(1)
        .color(() => (entry().ctxWarm ? "#FFD60A" : CTX_INK)), 30, "trailing"),
      cell(Text(() => entry().costText).font(11).monospaced().lineLimit(1).color(COST_INK), 54, "trailing"),
    ]).paddingLeading(UNDER_TITLE).frame({ minHeight: 16 }),
  ])]).paddingVertical(4));
}

// Child (subagent) row: under the title of its parent with a tree tick. Running
// children tick a live elapsed; settled ones show their total, muted.
function childRow(entry) {
  const c = () => entry().child;
  return HStack({ spacing: 8 }, [
    guide(entry, 18),
    HStack({ spacing: 6 }, [
      Text("└").font(11).monospaced().color(META),
      Circle({ size: 5 })
        .fill(() => (c().running ? "#0A84FF" : "#7f7f7f55")),
      Text(() => c().label || "subagent")
        .font(12).lineLimit(1).truncation("tail")
        .color(() => (c().running ? TEXT2 : META)),
      Spacer(),
      Text(() => {
        if (c().noTime) return c().running ? "running" : "";
        const epoch = data.clock()?.epoch ?? 0;
        const end = c().running ? epoch : (c().endedEpoch ?? epoch);
        return fmtElapsed(end - (c().startedEpoch ?? end));
      })
        .font(11).monospaced().color(META),
    ]).paddingLeading(UNDER_TITLE),
  ])
    .paddingLeading(9).paddingTrailing(10).paddingVertical(1)
    .cornerRadius(7)
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity" })
    .marginLeading(() => inset(entry)() + 12)
    .onTap(() => jump(entry()));
}

// The view differs from the default: a chip, an account, the attention sort, one workspace, ended rows, or the
// view by state. The Reset chip shows then.
const viewChanged = () => Boolean(filter() || acctFilter() || attention() || !scopeAll() || showEnded() || byState());
// Back to the default view: no chip, no account, tab order, all workspaces, no ended rows, no view by state.
// The search text stays.
function resetView() {
  setAcctFilter("");
  setByState(false);
  setView({ c: "", a: false, s: true, e: false, l: false });
}

// The filter chips. Each shows the number of rows that it would show; a chip with none is left out.
// "needs" and "working" are the counts in the panel head; their chip shows only while it is the active filter.
const HEAD_CHIPS = ["needs", "working"];
const chipItems = () => FILTERS
  .filter((f) => filter() === f[0] || (!HEAD_CHIPS.includes(f[0]) && (view().chips[f[0]] ?? 0) > 0))
  .map((f) => ({ id: f[0], label: f[1], help: f[2] }));
const filterChip = (f) =>
  chip(() => f().label, () => String(view().chips[f().id] ?? 0), () => filter() === f().id, () => setView({ c: filter() === f().id ? "" : f().id }))
    .help(() => f().help)
    .opacity(() => ((view().chips[f().id] ?? 0) === 0 && filter() !== f().id ? 0.45 : 1));
const resetChip = () =>
  Text("✕ Reset").font(12).weight("medium").lineLimit(1).fixedSize().color(ORANGE)
    .paddingHorizontal(10).paddingVertical(4).cornerRadius(12)
    .background("#FFFFFF0F").hoverBackground("#FFFFFF1A")
    .onTap(resetView);
// One chip per account, shown when the sessions run on two accounts or more (or while one is the filter).
const acctItems = () => {
  const all = Object.entries(view().accts);
  return all.length > 1 || acctFilter() ? all.sort().map(([id, n]) => ({ id, n })) : [];
};
// A count in the panel head, hidden at zero. With a chip id, a tap shows only those rows and a second tap all rows.
const headCount = (n, word, color, chipId) =>
  ForEach({ items: () => (n() > 0 ? [{ id: word }] : []), key: (x) => x.id }, () => {
    const t = Text(() => n() + " " + word).font(11).lineLimit(1).fixedSize().color(color);
    return chipId ? t.onTap(() => setView({ c: filter() === chipId ? "" : chipId })) : t;
  });
// A zero-or-one list: the row takes no height while it has nothing to show.
const optional = (id, showFn, template) => ForEach({ items: () => (showFn() ? [{ id }] : []), key: (x) => x.id }, template);
// What the list says when it shows no session row: no live session at all, or nothing that matches the filters.
const emptyState = () => {
  // A folded band that holds sessions counts as a match.
  if (limitsShown() || entries().some((e) => e.kind === "agent" || (e.kind === "header" && e.count > 0))) return "";
  if (counts().working + counts().needs_input + counts().idle === 0) return "none";
  return filter() || acctFilter() || !scopeAll() || query().trim() ? "nomatch" : "";
};

sidebar(() =>
  // The top block: 8 pt between its rows, each inset 10 pt so the left edges line up. The 4 pt gap below it and the
  // 8 pt clear line on top of the first band make 12 pt between the search field and the band.
  VStack({ spacing: 4 }, [VStack({ spacing: 8 }, [
    HStack({ spacing: 8 }, [
      Text("Agents").font(15).weight("semibold"),
      Spacer(),
      // One count per state in words: orange needs you, blue working, green idle. Then the cost estimate.
      headCount(() => counts().needs_input, "need you", ORANGE, "needs"),
      headCount(() => counts().working, "working", BLUE_TEXT, "working"),
      // The idle chip means idle for 1 hour or more, and this count holds every idle session: no tap.
      headCount(() => counts().idle, "idle", "#34C759"),
      headCount(() => (showEnded() ? counts().ended : 0), "ended", META),
      optional("cost", () => totalCost() >= 1, () => Text(() => "$" + Math.round(totalCost())).font(11).monospaced().color(META)),
    ]).paddingHorizontal(10),

    ZStack({}, [
      // No text: this view reads the tab titles, so it runs again when one changes, and serves the hive page's jumps.
      // It sits under the control row, so it adds no gap to a row.
      Text(() => hiveGo()).font(1),
      HStack({ spacing: 4 }, [
        HStack({ spacing: 0 }, [
          segment("Here", () => !scopeAll() && !showLimits(), () => setView({ s: false, l: false })),
          segment("All", () => scopeAll() && !showLimits(), () => setView({ s: true, l: false })),
          segment("Limits", () => showLimits(), () => setView({ l: !showLimits() })),
        ]),
        Spacer(),
        // The attention sort, then the view by state in place of by workspace.
        toggleButton("↑", () => attention(), () => setView({ a: !attention() })),
        toggleButton("state", () => byState(), () => setByState(!byState())),
        toggleButton("Ended", () => showEnded(), () => setView({ e: !showEnded() })),
        // Opens the views page in the browser: the hive tree, the timeline, cost, flow, limits, queue, context and rhythm.
        toggleButton("views ↗", () => false, () => openViews()),
      ]).paddingHorizontal(10),
    ]),

    // Filter chips (a second click on the active chip shows all rows again), then the Reset chip.
    optional("chips", () => chipItems().length || viewChanged(), () => HStack({ spacing: 4 }, [
      ForEach({ items: chipItems, key: (f) => f.id }, filterChip),
      Spacer(),
      optional("reset", viewChanged, resetChip),
    ]).paddingHorizontal(10)),
    // One chip per account. A second click shows all again.
    optional("accts", () => acctItems().length, () => HStack({ spacing: 4 }, [
      ForEach({ items: acctItems, key: (a) => a.id },
        (a) => chip(() => a().id, () => String(a().n), () => acctFilter() === a().id, () => setAcctFilter(acctFilter() === a().id ? "" : a().id))),
      Spacer(),
    ]).paddingHorizontal(10)),

    optional("strip", () => strip().length, () => VStack({ spacing: 2 }, [ForEach({ items: strip, key: (s) => s.key }, (s) => stripRow(s))])),
    // The Limits view takes the place of the session list.
    optional("limits", limitsShown, () => VStack({ spacing: 5 }, [ForEach({ items: limits, key: (s) => s.key }, (s) => limitRow(s, limits().some((x) => x.acct) ? 120 : 58))])),

    HStack({ spacing: 0 }, [
      HStack({ spacing: 6 }, [
        Image("magnifyingglass").font(11).color(META),
        TextField("", {
          placeholder: "Search agents",
          autofocus: false,
          onEdit: (t) => setQuery(t ?? ""),
          onSubmit: (t) => setQuery(t ?? ""),
        }),
      ]).paddingHorizontal(8).paddingVertical(5).background("#FFFFFF0F").cornerRadius(8),
    ]).paddingHorizontal(10),
  ]),

    VStack({ spacing: 3 }, [ForEach(
      { items: entries, key: (e) => e.key },
      (e) => {
        const entry = e(); // kind is stable per key
        if (entry.kind === "header") return headerRow(e);
        if (entry.kind === "child") return childRow(e);
        if (entry.kind === "detail") return detailRow(e);
        return agentRow(e);
      }
    )]),

    // The empty list: no session yet, or nothing that matches; "Clear filters" resets the view and the search text.
    // The form is fixed per key.
    optional("none", () => emptyState() === "none", () => VStack({ spacing: 4 }, [
      Text("No sessions yet").font(13).weight("semibold"),
      Text("Start an agent in a cmux tab and it shows up here.").font(12).color(META),
    ]).paddingVertical(16).paddingHorizontal(10)),
    optional("nomatch", () => emptyState() === "nomatch", () => VStack({ spacing: 4 }, [
      Text("Nothing matches").font(13).weight("semibold"),
      Text("Clear filters").font(12).color(BLUE_TEXT).onTap(() => { resetView(); setQuery(""); }),
    ]).paddingVertical(16).paddingHorizontal(10)),
    Spacer(),
  ]).paddingHorizontal(6),
  { surface: "glass" }
)
