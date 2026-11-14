// SPDX-License-Identifier: GPL-3.0-or-later
// Smoke test for sidebars/agents.js. Run from the repo root: node tests/smoke.mjs
//
// It loads the REAL cmux sidebar runtime (SidebarRuntime.js from the app bundle) inside a Node vm context and
// provides the four host bridge functions the runtime expects (__host_applyOps, __host_action, __host_log,
// __host_clipboardWrite). The runtime is plain JavaScript, so no JavaScriptCore host and no stub are needed.
// Fake data goes in through the runtime's own __setData entry point, the panel file is loaded, and the scene ops
// the runtime emits are applied to a small tree. Every function-valued text/colour prop is evaluated by the
// runtime itself, so the panel's parsing code runs for real. The text of the tree is then checked.
//
// Without the runtime (a machine without cmux) the test prints "SKIP: cmux runtime not found" and exits 0.
// Env: CMUX_SIDEBAR_RUNTIME = path of SidebarRuntime.js, CMUX_SIDEBAR_PANEL = panel file to test instead of
// sidebars/agents.js (used to check that a broken panel fails the test).
// Not covered: pixel layout, fonts and colours as drawn, the Swift host, real cmux data.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelPath = process.env.CMUX_SIDEBAR_PANEL || path.join(root, "sidebars", "agents.js");

function findRuntime() {
  if (process.env.CMUX_SIDEBAR_RUNTIME) return process.env.CMUX_SIDEBAR_RUNTIME;
  const res = "/Applications/cmux.app/Contents/Resources";
  if (!fs.existsSync(res)) return null;
  for (const name of fs.readdirSync(res)) {
    const p = path.join(res, name, "Contents", "Resources", "SidebarRuntime.js");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const runtimePath = findRuntime();
if (!runtimePath || !fs.existsSync(runtimePath)) {
  console.log("SKIP: cmux runtime not found");
  process.exit(0);
}

// ---------------------------------------------------------------- fake data (invented names only)
const EPOCH = 1800000000;
const HOME = ["", "Users", "demo"].join("/"); // built from parts: the panel only accepts a home folder of this form
const T = (n) => "AAAAAAAA-0000-0000-0000-00000000000" + n; // tab ids: 36 characters, as cmux reports them
const apiDescription = [
  "api",
  "lead-1: opus · acct work · ctx 83% · $1.20 · waits permission · next you push the branch · comp 3 · ahead 2 · dup"
    + " · prompt fix the login test · screen asks",
  "worker-2: sonnet · cold 5m · sub 2/7: Review diff; Lint",
  "@home: " + HOME,
  "@primary: personal",
  "@view: t=1799999990,c=all,a=0,s=1,e=1,l=0,f=0",
  "@limits: claude,5h,42,14:10,1794650000;codex,week,4,Sat 09:39,1794600000;grok,,,,0",
  "@queue: 2 ready",
  "@unpushed: api 2",
  "@train: merged #12; refused none; skipped none; deferred none",
].join(" | ");
const webDescription = ["web", "scout-4: sonnet · acct personal · ctx 45% · $0.30", "@accts: " + T(4) + "=work",
  "@train: refused none; skipped none", "@week: 47%"].join(" | ");

const agent = (id, panelId, status, kind, extra = {}) => ({
  id, panelId, surfaceId: "S-" + id, status, kind, name: kind, title: "first prompt of " + id,
  directory: "/work/" + id, sinceEpoch: EPOCH - 300, lastActivityAt: EPOCH - 10, children: [], ...extra,
});
const tab = (n, title, extra = {}) => ({ id: T(n), surfaceId: "SF-" + n, title, focused: false, hasUnread: false, branch: "", dirty: false, ports: [], ...extra });
const workspaces = [
  {
    id: "ws-api", title: "ignored", directory: "/work/api", description: apiDescription, color: "#123456", selected: true, unread: 1,
    tabs: [
      tab(1, "[lead-1] fix the login test", { focused: true, branch: "lane/fix", dirty: true, latestPrompt: "fix the login test" }),
      tab(2, "[worker-2] tidy", { hasUnread: true }),
      tab(5, "[old-5] Claude Code", { latestPrompt: "close the release notes" }),  // no title of its own
    ],
    agents: [
      agent("a1", T(1), "needs_input", "claude"),
      agent("a2", T(2), "idle", "claude", { lastActivityAt: EPOCH - 7200 }),
      agent("a5", T(5), "ended", "claude", { lastActivityAt: EPOCH - 60 }),
    ],
    prs: [{ branch: "lane/fix", number: 12, status: "open" }],
  },
  {
    id: "ws-web", title: "ignored", directory: "/work/web", description: webDescription, color: "#654321", selected: false, unread: 0,
    tabs: [tab(3, "[scout-4] search", { hasUnread: true }), tab(4, "[helper-6] notes"),
      tab(7, "[solo-7] bare", { latestPrompt: "<task-notification> <task-id>x1</task-id>" })],
    agents: [
      agent("a3", T(3), "working", "claude", { children: [{ id: "c1", label: "Explore repo", running: true, startedEpoch: EPOCH - 30 }] }),
      agent("a4", T(4), "idle", "codex"),
      agent("a7", T(7), "working", "opencode"),  // no session data: its only pill would be the tool name
    ],
    prs: [],
  },
  // A workspace with no session: the panel shows it as a thin line, not a band.
  { id: "ws-docs", title: "ignored", directory: "/work/docs", description: "docs", color: "#336699", selected: false, unread: 0, tabs: [], agents: [], prs: [] },
];

// ---------------------------------------------------------------- host bridge and scene tree
const nodes = new Map();
let rootId = null;
const actions = [];
const logs = [];
const clipboard = [];
const node = (id) => nodes.get(id);

function applyOps(json) {
  for (const op of JSON.parse(json)) {
    if (op.op === "create") nodes.set(op.id, { id: op.id, type: op.type, props: {}, children: [] });
    else if (op.op === "update") node(op.id).props[op.key] = op.value;
    else if (op.op === "children") node(op.id).children = op.children;
    else if (op.op === "append") node(op.id).children.push(op.child);
    else if (op.op === "remove") nodes.delete(op.id);
    else if (op.op === "root") rootId = op.id;
  }
}

const sandbox = {
  __host_applyOps: applyOps,
  __host_action: (json) => {
    const a = JSON.parse(json);
    if (a.kind === "log") logs.push(a.message);
    else actions.push(a);
  },
  __host_log: () => {},
  __host_clipboardWrite: (text) => { clipboard.push(text); return true; },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

function reachable() {
  const out = [];
  const seen = new Set();
  const walk = (id) => {
    const n = node(id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    out.push(n);
    n.children.forEach(walk);
  };
  if (rootId) walk(rootId);
  return out;
}
const textOf = () => reachable().map((n) => (typeof n.props.text === "string" ? n.props.text : "")).filter(Boolean).join("\n");
const parentOf = (id) => reachable().find((n) => n.children.includes(id));
const tapTarget = (n) => { for (let c = n; c; c = parentOf(c.id)) if (c.props.tappable) return c; return null; };
const tap = (n) => ctx.__dispatch(n.id, "tap", null);
const withText = (pred) => reachable().filter((n) => typeof n.props.text === "string" && pred(n.props.text));
const cmuxCalls = () => actions.filter((a) => a.kind === "cmux");
// The hover texts: a "+N" pill names the pills that its row has no room for.
const helpText = () => reachable().map((n) => (typeof n.props.help === "string" ? n.props.help : "")).filter(Boolean).join("\n");
const META = "#B4B4BA";
const ORANGE = "#FF9F0A";

// ---------------------------------------------------------------- tiny harness
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failed += 1;
    console.log("FAIL " + name + "\n     " + String(e && e.message ? e.message : e).split("\n").join("\n     "));
  }
}
function must(cond, msg) { if (!cond) throw new Error(msg); }
function mustContain(text, part) { must(text.includes(part), "text does not contain " + JSON.stringify(part)); }

// ---------------------------------------------------------------- load and render
let loaded = false;
check("runtime and panel load without throwing", () => {
  vm.runInContext(fs.readFileSync(runtimePath, "utf8"), ctx, { filename: "SidebarRuntime.js" });
  // Order as in the host: the program runs once on empty data, then the data keys arrive and the effects re-run.
  // (Data set BEFORE the load makes the panel read "accountMarks" before its const line runs; the host never does that.)
  vm.runInContext(fs.readFileSync(panelPath, "utf8"), ctx, { filename: path.basename(panelPath) });
  must(rootId !== null, "sidebar() did not set a root view");
  ctx.__setData("clock", JSON.stringify({ epoch: EPOCH }));
  ctx.__setData("selectedId", JSON.stringify("ws-api"));
  ctx.__setData("workspaces", JSON.stringify(workspaces));
  loaded = true;
});

if (!loaded) {
  console.log("\nFAILED: the panel did not load, later checks skipped");
  process.exit(1);
}

const rendered = textOf();
check("plain render makes no cmux call and opens no URL", () => {
  must(cmuxCalls().length === 0, "cmux calls during render: " + JSON.stringify(cmuxCalls()));
  must(!actions.some((a) => a.kind === "openURL"), "openURL called during render");
  must(clipboard.length === 0, "clipboard written during render");
});
check("render shows every session name", () => {
  for (const name of ["lead-1", "worker-2", "scout-4", "helper-6", "old-5"]) mustContain(rendered, name);
});
check("render shows workspace groups and the needs-you block", () => {
  mustContain(rendered, "NEEDS YOU");
  mustContain(rendered, "api");
  mustContain(rendered, "web");
});
check("render shows all four states", () => {
  // Settled rows are one line with a dot only, so idle and ended show in the summary line of the panel head.
  mustContain(rendered, "asked");  // a session that needs input reads "asked" on its second line
  mustContain(rendered, "finished · not seen");
  // A plain working row shows no state word: its blue dot says it.
  must(!rendered.includes("Working"), "a plain working row shows a state word");
  must(reachable().some((n) => n.props.fill === "#0A84FF"), "no blue dot for the working session");
  // The panel head counts each state in words: one needs you, one working, two idle; one ended while Ended is on.
  for (const t of ["1 need you", "2 working", "2 idle", "1 ended"]) {
    must(withText((x) => x === t).length === 1, "no head count " + JSON.stringify(t));
  }
  must(withText((x) => x === "1 need you")[0].props.color === ORANGE, "the need-you count is not orange");
  must(!rendered.includes("● "), "a head count still uses a dot glyph");
});
check("render shows the unread mark of the working session, and not on the finished-not-seen row", () => {
  const marks = withText((t) => t === "new");
  must(marks.length === 1, "expected one \"new\" mark (scout-4), got " + marks.length);
});
check("render shows the work marks: ahead count and duplicate", () => {
  mustContain(rendered, "↑2");
  mustContain(helpText(), "dup");  // lead-1 has more pills than its second line holds
});
check("a full row shows 3 pills by priority, then a +N pill that names the rest", () => {
  const more = withText((t) => t === "+4");
  must(more.length === 1, "expected one \"+4\" pill on lead-1, got " + more.length);
  must(more[0].props.help === "dup · ⟳3 · claude · work · a1", "help of +4 is " + JSON.stringify(more[0].props.help));
  for (const t of ["83%", "→ you", "↑2"]) must(withText((x) => x === t).length > 0, "pill " + t + " not shown");
});
check("a waiting session is full in the top block and one line in its workspace", () => {
  must(withText((t) => t === "[lead-1]").length === 2, "lead-1 is not shown twice");
  must(withText((t) => t.startsWith("asked")).length === 1, "the workspace copy of lead-1 has a state line");
  // At most 2 marks: "↑2" is the third candidate, so it shows on the full copy only.
  must(withText((t) => t === "↑2").length === 1, "the one-line copy shows more than 2 marks");
  // The one-line copy shows its first 2 marks bare: no pill background.
  must(withText((t) => t === "83%").some((n) => !n.props.background), "no bare 83% mark on the one-line copy");
  must(reachable().some((n) => n.props.borderColor === "#FF9F0A73"), "no orange border on the waiting card");
});
check("the title splits into the name and a dim rest; a waiting row shows its reason in place of the request", () => {
  const name = withText((t) => t === "[lead-1]")[0];
  must(name.props.font === 13 && name.props.weight === "semibold", "name is not 13 semibold");
  const rest = withText((t) => t === "fix the login test");
  must(rest.length > 0 && rest.every((n) => n.props.font === 13 && n.props.color === META), "rest is not a 13 pt META title part");
  must(withText((t) => t === "permission").some((n) => n.props.color === ORANGE), "the wait reason is not orange");
});
check("times are short: no \"ago\", minutes without seconds", () => {
  must(withText((t) => t === "5m").length > 0, "no \"5m\" elapsed time");
  must(!rendered.split("\n").some((l) => / ago$/.test(l)), "a time still ends in \"ago\"");
});
check("workspace bands take the workspace colour; the selected one is stronger", () => {
  // The data colours are dark, so the panel lightens them to show on a dark background: #123456 -> #667c92.
  must(reachable().some((n) => n.props.background === "#667c923D"), "no selected band tint for api");
  must(reachable().some((n) => n.props.background === "#8d735a29"), "no band tint for web");
  must(reachable().some((n) => n.props.hoverBackground === "#667c9247"), "no hover tint for api");
  // The band name takes the workspace colour, and a bright colour stays as it is.
  must(withText((t) => t === "api").some((n) => n.props.color === "#9fadba" && n.props.weight === "bold"), "the api band name is not in its colour");
  must(withText((t) => t === "3 · $1").length === 1, "no \"3 · $1\" count and cost on the api band");
  must(reachable().some((n) => n.props.size === 6 && n.props.fill === "#BF5AF2"), "no unread dot on the api band");
  must(!reachable().some((n) => n.props.size === 5), "session dots show on an open band");
  must(reachable().some((n) => n.props.fill === "#7f7f7f40" && n.props.height === 1), "no hairline on the NEEDS YOU section");
});
check("an empty workspace is a flat line in its own colour with a hover-only +", () => {
  const name = withText((t) => t === "docs");
  must(name.length === 1 && name[0].props.font === 12 && name[0].props.color === "#94afca", "docs line is not 12 pt in its colour");
  must(!reachable().some((n) => /^#5580aa/.test(String(n.props.background ?? ""))), "the empty workspace has a fill");
  // A settled row is flat: only a focused, asking or unseen row has a fill, so the list is not a stack of boxes.
  const fills = reachable().filter((n) => n.props.cornerRadius === 10).map((n) => n.props.background);
  must(fills.includes("clear") && !fills.includes("#FFFFFF0F"), "a settled row has a card fill: " + JSON.stringify(fills));
  // The focused row and a row under the pointer must not look alike: focus is a fill plus an outline, hover a faint fill.
  const rows = reachable().filter((n) => n.props.cornerRadius === 10);
  // The focused row of this data also asks, so its outline is the orange one; a focused row never has a clear outline.
  const focusedRows = rows.filter((n) => n.props.background === "#FFFFFF24");
  must(focusedRows.length >= 1 && focusedRows.every((n) => n.props.borderColor !== "clear"), "the focused row has no fill with an outline");
  must(rows.every((n) => n.props.hoverBackground === "#FFFFFF0D"), "the hover fill of a row is not the faint one");
  must(rows.some((n) => n.props.background === "clear" && n.props.borderColor === "clear"), "a settled row has an outline");
  must(withText((t) => t === "+").filter((n) => n.props.showOnHover === true).length === 1, "no hover-only + on the docs line");
});
check("the rows of a workspace sit inside its band; the top block and the view by state do not", () => {
  const margins = reachable().map((n) => n.props.marginLeading).filter((m) => m !== undefined && m !== null);
  must(margins.includes(12), "no row is indented under its band");
  must(margins.includes(0), "the top copy of the waiting row is indented");
});
check("a tool name alone makes no second line, and a system notice is not a request", () => {
  must(withText((t) => t === "[solo-7]").length === 1, "the solo-7 row is missing");
  must(withText((t) => t === "opencode").length === 0, "a lone tool pill shows");
  must(!rendered.includes("<task-notification"), "a system notice shows as a request");
});
check("a one-line row with no title of its own shows its last request; the 7-day line of the strip names its tool", () => {
  must(withText((t) => t === "close the release notes").some((n) => n.props.color === META && n.props.layoutPriority === 2), "old-5 does not show its last request beside the name");
  must(withText((t) => t === "claude").some((n) => n.props.fixedSize === true && n.props.font === 11), "the strip line of the 7-day limit is not labelled claude");
  must(withText((t) => t === "week").length === 0, "the strip still has a line labelled week");
});
check("the two parts of a title sit directly in the row and rank above the gap", () => {
  const name = withText((t) => t === "[lead-1]")[0];
  must(name && name.props.layoutPriority === 3, "the name has no priority over the gap");
});
check("render shows the waiting reason, context share and your-turn mark", () => {
  mustContain(rendered, "permission");
  mustContain(rendered, "83%");
  mustContain(rendered, "→ you");
});
check("render shows the cold-cache mark of the idle session", () => mustContain(rendered, "❄5m"));
check("render shows the account of a session and of a tab named in @accts", () => {
  mustContain(helpText(), "claude · work");  // lead-1, behind its "+N" pill
  mustContain(rendered, "· personal");
  // helper-6 is a one-line row with no tool pill: its @accts account shows in the account chip count.
  // A chip holds its label and its count as two texts.
  const work = withText((t) => t === "work").find((n) => parentOf(n.id)?.children.map(node).some((c) => c?.props.text === "2"));
  must(work, "no account chip \"work\" with the count 2");
});
check("render shows the project strip lines", () => {
  mustContain(rendered, "2 ready");
  mustContain(rendered, "api 2");
});
check("strip lines: one 12 pt line with the full text on hover; the train line drops its \"none\" clauses", () => {
  const train = withText((t) => t === "merged #12");
  must(train.length === 1, "the train line is not \"merged #12\"");
  must(train[0].props.font === 12 && train[0].props.lineLimit === 1 && train[0].props.truncation === "tail", "the strip value is not 12 pt on one line");
  must(train[0].props.help === "merged #12", "the strip value has no hover text");
  must(withText((t) => t === "refused none; skipped none").length === 1, "a train line with only \"none\" clauses did not keep its text");
  const label = withText((t) => t === "train")[0];
  must(label.props.font === 11 && !label.props.monospaced && label.props.color === META, "the strip label is not 11 pt META");
  // A label sits in a 56 pt cell at the leading side: the text takes its own width, a gap fills the rest.
  must(label.props.fixedSize === true && reachable().some((n) => n.props.width === 56), "the strip label has no 56 pt cell");
});
check("the strip has one limit line per tool with a live window: percent, a 44 x 4 bar, account, window and reset", () => {
  // The data: claude 5h 42%, codex week 4%, grok with no window. The strip names the tool, not "week".
  must(withText((t) => t === "42%").length === 1 && withText((t) => t === "4%").length === 1, "no 42% and 4% lines on the strip");
  must(withText((t) => t === "claude").length >= 1 && withText((t) => t === "codex").some((n) => n.props.fixedSize === true), "the limit lines do not name their tool");
  must(withText((t) => t === "grok").length === 0 && withText((t) => t === "week").length === 0, "a tool with no window, or a line named week, shows on the strip");
  must(reachable().some((n) => n.type === "capsule" && n.props.fill === "#34C759" && Math.abs(n.props.width - 18.48) < 0.01 && n.props.height === 4), "no green 42% fill on the strip bar");
  must(reachable().some((n) => n.type === "capsule" && n.props.fill === "#7f7f7f40" && n.props.width === 44 && n.props.height === 4), "no 44 pt track on the strip bar");
  const rest = withText((t) => /5h · resets 14:10$/.test(t))[0];
  must(rest && rest.props.text === "personal · 5h · resets 14:10", "the claude line does not name its account: " + rest?.props.text);
  must(rest && rest.props.font === 11 && rest.props.color === META, "the rest of the claude line is not \"5h · resets 14:10\" in 11 pt META");
});
check("the panel head, control row, chips and search field have their new form", () => {
  must(!rendered.includes("showing:"), "the showing line is still there");
  // Here | All | Limits is one segmented group; All is selected.
  const all = withText((t) => t === "All")[0];
  must(all.props.background === "#FFFFFF2E" && all.props.color === "primary", "the selected segment is not primary on #FFFFFF2E");
  const here = withText((t) => t === "Here")[0];
  // An unselected segment is dim text with no fill at all, also on hover: one fill means one selection.
  must(here.props.color === META && !here.props.hoverBackground, "an unselected segment has a fill or is not dim");
  const group = parentOf(all.id);
  // Only the selected segment has a fill: no box around the three, and no fill on the other two.
  must(!group.props.background && here.props.background === "clear" && all.props.background === "#FFFFFF2E", "a fill shows on more than the selected segment");
  const hive = withText((t) => t === "hive ↗")[0];
  must(hive.props.color === META && hive.props.minHeight === 24 && hive.props.hoverBackground === "#FFFFFF14", "hive ↗ is not a META toggle at least 24 tall");
  // The needs and working chips left the row: the head counts filter them.
  must(withText((t) => t === "!" || t === "▶").length === 0, "the needs or working chip is still in the chip row");
  const done = withText((t) => t === "✓")[0];
  const c = parentOf(done.id);
  must(c.props.paddingHorizontal === 10 && c.props.cornerRadius === 12 && c.props.background === "#FFFFFF0F" && c.props.hoverBackground === "#FFFFFF1A", "the ✓ chip is not a capsule chip");
  must(c.props.help === "finished, not seen", "the ✓ chip does not name its filter on hover");
  must(c.children.map(node).some((n) => n.props.text === "1" && n.props.monospaced === true && n.props.color === META), "the ✓ chip has no META count");
  // The saved view has ended rows on, so the Reset chip shows.
  must(withText((t) => t === "✕ Reset").some((n) => n.props.color === ORANGE), "no orange Reset chip while ended rows are on");
  const glass = reachable().find((n) => n.type === "image" && n.props.systemName === "magnifyingglass");
  must(glass, "no magnifying glass in front of the search field");
  const field = parentOf(glass.id);
  must(field.children.map(node).some((n) => n.type === "textfield") && field.props.background === "#FFFFFF0F" && field.props.cornerRadius === 8, "the search field has no rounded background");
});
check("fields the panel may not know yet (prompt, screen) do not throw", () => {
  // The description above carries "prompt ..." and "screen ..." fields. Loading already ran them; this is a
  // second pass with a data update, which re-runs every computed value.
  ctx.__setData("clock", JSON.stringify({ epoch: EPOCH + 5 }));
  textOf();
});

// ---------------------------------------------------------------- clicks (after the no-call check above)
check("a click on a session row focuses its tab", () => {
  const title = withText((t) => t === "[lead-1]")[0];
  must(title, "row title of lead-1 not found");
  const row = tapTarget(title);
  must(row, "no tappable ancestor for the lead-1 row");
  const before = cmuxCalls().length;
  tap(row);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "surface.focus", "expected one surface.focus, got " + JSON.stringify(calls));
  must(calls[0].params.workspace_id === "ws-api", "wrong workspace in " + JSON.stringify(calls[0]));
});
check("a click on an empty workspace line selects it", () => {
  const line = tapTarget(withText((t) => t === "docs")[0]);
  must(line, "no tappable ancestor for the docs line");
  const before = cmuxCalls().length;
  tap(line);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "workspace.select" && calls[0].params.workspace_id === "ws-docs", "got " + JSON.stringify(calls));
});
check("a folded band shows one dot per session; opening it hides them", () => {
  const caret = withText((t) => t === "▾")[0];
  must(caret, "fold mark not found");
  tap(caret);
  must(reachable().filter((n) => n.props.size === 5).length > 0, "no session dots on the folded band");
  tap(withText((t) => t === "▸")[0]);
  must(!reachable().some((n) => n.props.size === 5), "session dots stayed after the band opened");
});
check("the Show details menu item opens the detail lines of its row", () => {
  must(withText((t) => t === "›").every((n) => n.props.showOnHover === true), "a closed detail mark is not hover-only");
  const menu = parentOf(withText((t) => t === "Copy name: lead-1")[0].id);
  const item = () => menu.children.map(node).find((n) => n && /^(Show|Hide) details$/.test(n.props.text));
  must(item() && item().props.text === "Show details", "no Show details item in the lead-1 menu");
  must(!textOf().includes("duplicate"), "lead-1 details already open");
  tap(item());
  mustContain(textOf(), "duplicate");
  must(item().props.text === "Hide details", "the item did not change to Hide details");
  const open = withText((t) => t === "⌄");
  must(open.length > 0 && open.every((n) => n.props.showOnHover === false), "the open detail mark is not always in view");
  tap(item());
  must(!textOf().includes("duplicate"), "Hide details did not close the lines");
});
check("the info mark opens detail lines", () => {
  const before = textOf().split("\n").length;
  for (const m of withText((t) => t === "›")) tap(m);
  const after = textOf();
  must(after.split("\n").length > before, "no detail lines appeared");
});
check("the sub badge opens the subagent rows, from cmux data and from the description", () => {
  for (const m of withText((t) => /^▸\d/.test(t))) tap(m);
  const after = textOf();
  mustContain(after, "Explore repo");
  mustContain(after, "Review diff");
});
check("the state button groups the rows into sections by state, and a second click restores the workspaces", () => {
  const btn = () => withText((t) => t === "state")[0];
  must(btn(), "state button not found");
  tap(btn());
  const grouped = textOf();
  mustContain(grouped, "NEEDS YOU");
  mustContain(grouped, "RUNNING");
  // A one-line row keeps its workspace as a bare mark in this view (helper-6 in web).
  must(withText((t) => t === "web").some((n) => !n.props.background && n.props.color === "#654321"), "no workspace mark on a one-line row");
  tap(btn());
  must(!textOf().includes("RUNNING"), "the sections stayed after the second click");
});
check("a row carries its marks as pills: account, your-turn mark and compaction count", () => {
  const all = textOf();
  mustContain(helpText(), "claude · work");  // past the third pill: named by "+N"
  mustContain(all, "→ you");
  mustContain(helpText(), "⟳3");
});
check("the Copy name menu item writes the session name to the clipboard", () => {
  const item = withText((t) => t === "Copy name: lead-1")[0];
  must(item, "menu item not found");
  tap(item);
  must(clipboard.includes("lead-1"), "clipboard holds " + JSON.stringify(clipboard));
});
check("the hive button asks cmux for a browser split with the hive page", () => {
  const btn = withText((t) => t === "hive ↗")[0];
  must(btn, "hive button not found");
  const before = cmuxCalls().length;
  tap(btn);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "browser.open_split", "got " + JSON.stringify(calls));
  must(/^file:\/\/.*hive\.html#/.test(calls[0].params.url), "url is not a hive page link");
});
check("the Limits view lists the limit windows", () => {
  const btn = withText((t) => t === "Limits")[0];
  must(btn, "Limits toggle not found");
  tap(btn);
  // The percent is its own column; the window, reset time and age follow it.
  const pct = withText((t) => t === "42%")[0];
  must(pct && pct.props.fixedSize === true && reachable().some((n) => n.props.width === 34) && pct.props.monospaced === true && pct.props.color === META,
    "42% is not a 34 pt META percent column: " + JSON.stringify(pct?.props));
  const rest = withText((t) => t.startsWith("5h · resets 14:10"));
  must(rest.length === 1 && rest[0].props.lineLimit === 1 && String(rest[0].props.help).startsWith("5h 42% · resets 14:10"), "no one-line \"5h · resets 14:10\" text with the full text on hover");
});
check("Limits bars are 60 x 5 with a 3 pt minimum fill; a line with no data has no bar; cost lines stay", () => {
  must(reachable().some((n) => n.type === "capsule" && n.props.fill === "#34C759" && Math.abs(n.props.width - 25.2) < 0.01 && n.props.height === 5), "no 25.2 pt fill for 42%");
  must(reachable().some((n) => n.type === "capsule" && n.props.fill === "#34C759" && n.props.width === 3 && n.props.height === 5), "the 4% fill is not 3 pt");
  // The tools with no limit data share one line, named "no data".
  must(withText((t) => t === "no limit data on this Mac").length === 0, "a tool with no data has a line of its own");
  const none = withText((t) => /(^|, )Grok(,|$)/.test(t))[0];
  must(none && withText((t) => t === "no data").length === 1, "the tools with no data do not share one line");
  must(!parentOf(none.id).children.map(node).some((n) => n.type === "zstack" || n.type === "capsule"), "the grok line has a bar");
  must(withText((t) => /^\$0\.30 · 1 session$/.test(t)).length === 1, "no cost line for the personal account");
  tap(withText((t) => t === "Limits")[0]);
  must(!reachable().some((n) => n.props.width === 60 && n.props.height === 5), "a second click on Limits did not close the view");
});
check("a head count filters the list, a second tap clears it; the idle count has no tap", () => {
  must(!tapTarget(withText((t) => t === "2 idle")[0]), "the idle count is tappable");
  tap(withText((t) => t === "1 need you")[0]);
  must(withText((t) => t === "!").some((n) => n.props.color === "primary"), "the needs chip does not show as the active filter");
  must(withText((t) => t === "[worker-2]").length === 0, "an idle row shows under the needs filter");
  tap(withText((t) => t === "1 need you")[0]);
  must(withText((t) => t === "!").length === 0 && withText((t) => t === "[worker-2]").length === 1, "the second tap did not clear the filter");
});
check("the Reset chip restores the default view and turns the view by state off", () => {
  tap(withText((t) => t === "state")[0]);
  tap(withText((t) => t === "Here")[0]);
  // Here shows the api workspace only: its finished-not-seen session gets its own section in the view by state.
  mustContain(textOf(), "FINISHED · NOT SEEN");
  const reset = withText((t) => t === "✕ Reset")[0];
  must(reset, "no Reset chip");
  tap(reset);
  must(!textOf().includes("FINISHED · NOT SEEN"), "the view by state stayed on");
  must(withText((t) => t === "All")[0].props.background === "#FFFFFF2E", "the scope did not go back to All");
  must(withText((t) => t === "Ended")[0].props.color === META, "ended rows stayed on");
  must(withText((t) => t === "✕ Reset").length === 0, "the Reset chip stayed in the default view");
});
check("a folded band that holds the matching session is not \"Nothing matches\"", () => {
  tap(tapTarget(withText((t) => t === "✓")[0]));
  tap(withText((t) => t === "▾")[0]);
  must(withText((t) => t === "[worker-2]").length === 0, "the band did not fold");
  must(withText((t) => t === "Nothing matches").length === 0, "\"Nothing matches\" under a folded band with a match");
  tap(withText((t) => t === "▸")[0]);
  tap(tapTarget(withText((t) => t === "✓")[0]));
  must(withText((t) => t === "✕ Reset").length === 0, "the view did not go back to the default");
});
check("a search with no match says \"Nothing matches\"; Clear filters brings the rows back", () => {
  const field = reachable().find((n) => n.type === "textfield");
  ctx.__dispatch(field.id, "edit", JSON.stringify({ text: "zzz-no-such-session" }));
  must(withText((t) => t === "Nothing matches").length === 1, "no \"Nothing matches\" line");
  must(withText((t) => t === "No sessions yet").length === 0, "the no-session line shows while sessions exist");
  const clear = withText((t) => t === "Clear filters")[0];
  must(clear && clear.props.color === "#5AA9FF", "no blue Clear filters");
  tap(clear);
  must(withText((t) => t === "[lead-1]").length > 0 && withText((t) => t === "Nothing matches").length === 0, "Clear filters did not clear the search");
});
check("with no session at all the list says \"No sessions yet\"", () => {
  ctx.__setData("workspaces", JSON.stringify([]));
  must(withText((t) => t === "No sessions yet").length === 1, "no \"No sessions yet\" line");
  mustContain(textOf(), "Start an agent in a cmux tab and it shows up here.");
  must(withText((t) => t === "Nothing matches").length === 0, "\"Nothing matches\" shows with no session");
});

console.log(failed === 0 ? "\nOK: all checks passed (runtime: " + path.basename(path.dirname(runtimePath)) + ")" : "\nFAILED: " + failed + " check(s)");
process.exit(failed === 0 ? 0 : 1);
