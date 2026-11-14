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
].join(" | ");
const webDescription = ["web", "scout-4: sonnet · acct personal · ctx 45% · $0.30", "@accts: " + T(4) + "=work"].join(" | ");

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
      tab(5, "[old-5] done"),
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
    tabs: [tab(3, "[scout-4] search", { hasUnread: true }), tab(4, "[helper-6] notes")],
    agents: [
      agent("a3", T(3), "working", "claude", { children: [{ id: "c1", label: "Explore repo", running: true, startedEpoch: EPOCH - 30 }] }),
      agent("a4", T(4), "idle", "codex"),
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
  // The panel head counts each state as a coloured dot with a number: one needs you, two idle, one ended.
  mustContain(rendered, "● 1");
  mustContain(rendered, "● 2");
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
  must(reachable().some((n) => n.props.background === "#12345624"), "no selected band tint for api");
  must(reachable().some((n) => n.props.background === "#65432114"), "no band tint for web");
  must(reachable().some((n) => n.props.hoverBackground === "#1234562E"), "no hover tint for api");
  must(withText((t) => t === "3 · $1").length === 1, "no \"3 · $1\" count and cost on the api band");
  must(reachable().some((n) => n.props.size === 6 && n.props.fill === "#BF5AF2"), "no unread dot on the api band");
  must(!reachable().some((n) => n.props.size === 5), "session dots show on an open band");
  must(reachable().some((n) => n.props.fill === "#7f7f7f40" && n.props.height === 1), "no hairline on the NEEDS YOU section");
});
check("an empty workspace is a thin line with a hover-only +", () => {
  const name = withText((t) => t === "docs");
  must(name.length === 1 && name[0].props.font === 12 && name[0].props.color === META, "docs line is not 12 pt META");
  must(!reachable().some((n) => /^#336699/.test(String(n.props.background ?? ""))), "the empty workspace has a band tint");
  must(withText((t) => t === "+").filter((n) => n.props.showOnHover === true).length === 1, "no hover-only + on the docs line");
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
  mustContain(rendered, "work 2");
});
check("render shows the project strip lines", () => {
  mustContain(rendered, "2 ready");
  mustContain(rendered, "api 2");
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
  mustContain(textOf(), "5h 42%");
});

console.log(failed === 0 ? "\nOK: all checks passed (runtime: " + path.basename(path.dirname(runtimePath)) + ")" : "\nFAILED: " + failed + " check(s)");
process.exit(failed === 0 ? 0 : 1);
