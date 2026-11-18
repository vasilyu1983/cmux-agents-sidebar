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
  "worker-2: sonnet · cold 5m · next the lead merges · sub 2/7: Review diff; Lint",
  "old-5: sonnet · ctx 12% · tok 420000 · title Release notes",
  "@home: " + HOME,
  "@primary: personal",
  "@view: t=1799999990,c=all,a=0,s=1,e=1,l=0,f=0",
  "@limits: claude,5h,42,14:10,1799999400;codex,week,4,Sat 09:39,1799999300;grok,,,,0",
  "@queue: 2 ready",
  "@unpushed: api 2",
  "@train: merged #12; refused none; skipped none; deferred none",
].join(" | ");
const webDescription = ["web", "scout-4: sonnet · acct personal · ctx 45% · tok 1234567 · $0.30", "@accts: " + T(4) + "=work",
  // A Codex tab has no session fields: the watcher gives its screen state and context figure by tab id.
  T(4) + ": screen idle · ctx 37% · tok 95000",
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
      agent("a5help", T(5), "ended", "claude", { lastActivityAt: EPOCH - 120 }),  // a helper run that ended in the same tab
      agent("a1old", T(1), "ended", "claude", { lastActivityAt: EPOCH - 600 }),  // two earlier runs in the tab of lead-1
      agent("a1older", T(1), "ended", "claude", { lastActivityAt: EPOCH - 900 }),
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
  // A row that finished unseen is one line like the others: its purple fill and its unread mark say it.
  must(reachable().some((n) => n.props.cornerRadius === 10 && n.props.background === "#BF5AF217"), "no purple fill on the row that finished unseen");
  // A plain working row shows no state word: its blue dot says it.
  must(!rendered.includes("Working"), "a plain working row shows a state word");
  must(reachable().some((n) => n.props.fill === "#0A84FF"), "no blue dot for the working session");
  // The panel head counts each state in words: one needs you, one working, two idle; one ended while Ended is on.
  for (const t of ["1 need you", "2 working", "2 idle", "2 ended"]) {
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
  mustContain(helpText(), "↑2");  // lead-1 has more pills than its second line holds
  mustContain(helpText(), "dup");  // lead-1 has more pills than its second line holds
});
check("a row shows 2 pills by priority, then a +N pill that names the rest; a long pill is cut", () => {
  // The pills are cut to 10 characters, so a row needs little width for them.
  // The lane folder is not an exception, so it has no pill: it is in the detail lines.
  const more = withText((t) => t === "+4");
  // lead-1 waits, so it shows twice: in the top block and in its workspace. Both rows have the same form.
  must(more.length === 2, "expected a \"+4\" pill on both rows of lead-1, got " + more.length);
  must(more[0].props.help === "↑2 · dup · ⟳3 · work", "help of +4 is " + JSON.stringify(more[0].props.help));
  for (const t of ["83%", "→ you"]) must(withText((x) => x === t).length > 0, "pill " + t + " not shown");
  const pills = reachable().filter((n) => n.props.cornerRadius === 4 && typeof n.props.text === "string");
  must(pills.length > 0 && pills.every((n) => n.props.text.length <= 10), "a pill is longer than 10 characters: " + pills.map((n) => n.props.text).filter((t) => t.length > 10).join(", "));
});
check("a narrow sidebar: pills, toggles and head counts can shrink, so the panel is not cut at its edges", () => {
  // cmux cuts a panel that is wider than the sidebar at both edges. A text with a fixed size cannot shrink, so
  // the parts that are not in a fixed cell must not have one.
  const pills = reachable().filter((n) => n.props.cornerRadius === 4 && typeof n.props.text === "string");
  must(pills.some((n) => n.props.text) && pills.every((n) => n.props.fixedSize !== true), "a pill has a fixed size");
  const toggles = withText((t) => ["views ↗"].includes(t));
  must(toggles.length === 1 && toggles.every((n) => n.props.fixedSize !== true), "a toggle of the control row has a fixed size");
  const counts = withText((t) => /^\d+ (need you|working|idle)$/.test(t));
  must(counts.length > 0 && counts.every((n) => n.props.fixedSize !== true), "a count of the panel head has a fixed size");
});
check("an earlier ended run in a tab does not take the data or the focus of the live session of that tab", () => {
  // Tab 1 hosts lead-1 (live, focused, $1.20, 83%) and an ended run. Only the live one may show that data.
  // Two earlier runs ended in that tab: they share one row, which gives their count.
  must(withText((t) => t === "2 earlier runs in this tab").length === 1, "the earlier runs of a tab do not share one row with their count");
  must(withText((t) => t === "$1.20").length === 2, "the cost of lead-1 shows on its earlier run too");
  must(withText((t) => t === "83%").length === 2, "the context pill of lead-1 shows on its earlier run too");
  must(withText((t) => t === "→ you").length === 2, "the your-turn pill of lead-1 shows on its earlier run too");
});
check("a waiting session shows in the top block and in its workspace, in the same two-line form", () => {
  // A third row with this name is the earlier run in the same tab; the Ended toggle is on.
  must(withText((t) => t === "[lead-1]").length === 3, "lead-1 is not shown twice, plus its earlier run");
  // The second line: the state word, then why it waits, in orange.
  const why = withText((t) => t === "asked · permission");
  must(why.length === 2 && why.every((n) => n.props.color === ORANGE && n.props.font === 11), "no orange \"asked · permission\" on both rows");
  must(reachable().some((n) => n.props.borderColor === "#FF9F0A73"), "no orange border on the waiting card");
});
check("the title splits into the name and a dim rest", () => {
  const name = withText((t) => t === "[lead-1]")[0];
  must(name.props.font === 11.5 && name.props.weight === "semibold", "name is not 11.5 semibold");
  const rest = withText((t) => t === "fix the login test");
  must(rest.length > 0 && rest.every((n) => n.props.font === 11.5 && n.props.color === META), "rest is not an 11.5 pt META title part");
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
  // The count stands first and the cost last, so "4 team Opus" cannot read as a model "Opus 4".
  const costNode = withText((t) => t === "$1")[0];
  const bandTexts = costNode ? parentOf(costNode.id).children.map(node).filter((m) => m && m.props.text).map((m) => m.props.text) : [];
  must(bandTexts.indexOf("4") >= 0 && bandTexts.indexOf("4") < bandTexts.indexOf("$1"), "the api band does not show its count 4 before its cost $1: " + bandTexts.join(" | "));
  must(reachable().some((n) => n.props.size === 6 && n.props.fill === "#BF5AF2"), "no unread dot on the api band");
  must(!reachable().some((n) => n.props.size === 5), "session dots show on an open band");
  must(reachable().some((n) => n.props.fill === "#7f7f7f40" && n.props.height === 1), "no hairline on the NEEDS YOU section");
});
check("an empty workspace is a flat line in its own colour with a hover-only +", () => {
  const name = withText((t) => t === "docs");
  must(name.length === 1 && name[0].props.font === 11 && name[0].props.color === "#94afca", "docs line is not 11 pt in its colour");
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
check("a tool has no pill of its own: a session with no known model names its tool in the model column", () => {
  must(withText((t) => t === "[solo-7]").length === 1, "the solo-7 row is missing");
  const tool = withText((t) => t === "opencode");
  must(tool.length === 1 && !tool[0].props.background && tool[0].props.weight === "medium", "solo-7 does not name its tool in the model column");
  must(!reachable().some((n) => n.props.text === "claude" && n.props.background), "a plain tool pill shows");
  must(!rendered.includes("<task-notification"), "a system notice shows as a request");
});
check("a tab with no title of its own shows the title of its session; the request, model, context and cost are on the second line", () => {
  // old-5: the tab title is only the tool name. Its description carries "title Release notes".
  must(withText((t) => t === "Release notes").some((n) => n.props.font === 11.5 && n.props.color === META && n.props.layoutPriority === 2), "old-5 does not show its session title beside the name");
  must(withText((t) => t === "close the release notes").some((n) => n.props.font === 11 && n.props.color === META), "old-5 does not show its last request on the second line");
  // The end of the second line is three columns of fixed width, so the values line up down the list.
  must(withText((t) => t === "sonnet").some((n) => n.props.font === 10 && n.props.weight === "medium" && n.props.color === "#BDB2E8"), "old-5 has no lavender model column");
  must(withText((t) => t === "12%").some((n) => n.props.font === 10 && n.props.color === "#A9C0D4"), "old-5 has no slate context column");
  must(withText((t) => t === "$1.20").some((n) => n.props.font === 10 && n.props.color === "#D8BE8C"), "lead-1 has no sand cost column");
  // worker-2 does not work, is unread and has a next step: "next" stands after its state words, not before them.
  must(withText((t) => /not seen · next the lead merges$/.test(t)).length >= 1, "worker-2 does not read \"… not seen · next the lead merges\"");
  must(withText((t) => t.endsWith("the lead merges")).length >= 1, "worker-2 does not show its next step");
  const widths = (w) => reachable().filter((n) => n.props.width === w).length;
  must(widths(27) >= 6 && widths(27) === widths(49) && widths(29) === 0, "the two number columns are not on every row, or the token column is back");
  must(withText((t) => t === "week").length === 0, "the strip still has a line labelled week");
});
check("a row shows no token count: it is in the detail lines, so the next step has the width", () => {
  // The token column took 34 pt of the second line; context share and cost stay on the row.
  const figures = withText((t) => /^\d+(\.\d)?[KM]$/.test(t)).map((n) => n.props.text);
  must(figures.length === 0, "a token figure shows on a row: " + JSON.stringify(figures));
  must(withText((t) => t === "12%").length >= 1 && withText((t) => t === "37%").length >= 1, "a context share left the rows");
});
check("a row whose next step is the reader's has an orange dot, and no orange fill: it asks, it is not blocked", () => {
  const subtree = (n) => { const out = []; const walk = (id) => { const x = node(id); if (!x) return; out.push(x); x.children.forEach(walk); }; walk(n.id); return out; };
  // Pill, chip and dot say the same thing in one colour; the fill stays for a session that waits on a prompt.
  const card = reachable().filter((n) => n.props.cornerRadius === 10).find((n) => subtree(n).some((x) => x.props.text === "\u2192 you"));
  must(card, "no row with a your-turn pill in the list");
  must(card.props.background !== "#FF9F0A26", "a your-turn row has the fill of a blocked session");
  const marks = subtree(card).filter((n) => n.props.size === 7);
  must(marks.length === 1 && marks[0].props.fill === "#FF9F0A", "the dot of a your-turn row is not orange: " + JSON.stringify(marks.map((n) => n.props.fill)));
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
check("every session row has the same two lines, whatever its state", () => {
  // A row must not change its height when its state changes, or the list jumps under the pointer.
  const rows = reachable().filter((n) => n.props.cornerRadius === 10 && n.props.borderWidth === 1);
  must(rows.length >= 6 && rows.every((n) => {
    // The left column is 13 pt wide: the group line (42 pt at least) with the status dot on it. Then the text.
    const [gutter, text] = n.children.map(node);
    const line = node(gutter.children[0]);
    return gutter.props.width === 13 && line.props.minHeight === 42 && line.props.opacity === 0.35 && text.props.paddingVertical === 4;
  }), "a session row has another form");
  const seconds = rows.map((n) => node(node(n.children[1]).children[1])).filter((n) => n.props.minHeight === 16 && !n.props.paddingLeading);
  must(seconds.length === rows.length, "second lines: " + seconds.length + " for " + rows.length + " rows");
});
check("render shows the cold-cache mark of the idle session", () => mustContain(rendered, "❄5m"));
check("render shows the account of a session and of a tab named in @accts", () => {
  mustContain(helpText(), "⟳3 · work");  // lead-1: the account pill is behind its "+N" pill
  must(withText((t) => t === "personal").some((n) => n.props.cornerRadius === 4), "no account pill \"personal\" on a row");
  // helper-6 is a one-line row with no tool pill: its @accts account shows in the account chip count.
  // A chip holds its label and its count as two texts.
  const work = withText((t) => t === "work").find((n) => parentOf(n.id)?.children.map(node).some((c) => c?.props.text === "2"));
  must(work, "no account chip \"work\" with the count 2");
});
check("render shows the project strip lines", () => {
  mustContain(rendered, "2 ready");
  mustContain(rendered, "api 2");
});
check("strip lines: one 11 pt line with the full text on hover; a train line that only merged needs no action and is left out", () => {
  const queue = withText((t) => t === "2 ready");
  must(queue.length === 1, "the queue line is not \"2 ready\"");
  must(queue[0].props.font === 11 && queue[0].props.lineLimit === 1 && queue[0].props.truncation === "tail", "the strip value is not 11 pt on one line");
  must(queue[0].props.help === "2 ready", "the strip value has no hover text");
  must(withText((t) => t === "merged #12" || t === "refused none; skipped none" || t === "train").length === 0, "a train line with nothing to act on is still on the strip");
  const label = withText((t) => t === "run")[0];
  must(label.props.font === 10 && label.props.color === META, "the strip label is not 10 pt META");
  // The whole panel uses the monospaced font, as the terminal beside it.
  const plain = reachable().filter((n) => typeof n.props.text === "string" && n.props.font >= 10 && n.props.monospaced !== true);
  must(plain.length === 0, "a text is not monospaced: " + plain.slice(0, 3).map((n) => n.props.text).join(", "));
  // A label sits in a 56 pt cell at the leading side: the text takes its own width, a gap fills the rest.
  must(label.props.fixedSize === true && reachable().some((n) => n.props.width === 56), "the strip label has no 56 pt cell");
});
check("the strip has no limit lines: the Limits view lists them, and the head names a limit of 80% or more", () => {
  // The data: claude 5h 42%, codex week 4%. Both are below 80%, so neither shows outside the Limits view.
  must(withText((t) => t === "42%" || t === "4%" || /^claude \d/.test(t)).length === 0, "a limit below 80% shows on the strip or in the head");
  must(!reachable().some((n) => n.type === "capsule" && n.props.width === 44 && n.props.height === 4), "the 44 pt strip bar is still there");
});
check("the panel head, control row, chips and search field have their new form", () => {
  must(!rendered.includes("showing:"), "the showing line is still there");
  // Sessions | By state | Limits is one segmented group; Sessions is selected.
  const all = withText((t) => t === "Sessions")[0];
  must(all.props.background === "#FFFFFF2E" && all.props.color === "primary", "the selected segment is not primary on #FFFFFF2E");
  const here = withText((t) => t === "By state")[0];
  // The controls share one height, and "Here" is a chip of the filter row with no count: off means all workspaces.
  must(all.props.minHeight === 24 && parentOf(withText((t) => t === "Here")[0].id).props.minHeight === 24, "a segment or a chip is not 24 tall");
  must(parentOf(withText((t) => t === "Here")[0].id).children.length === 1, "the Here chip has a count");
  must(withText((t) => t === "attention first" || t === "account").length === 0, "a removed control is still there");
  // An unselected segment is dim text with no fill at all, also on hover: one fill means one selection.
  must(here.props.color === META && !here.props.hoverBackground, "an unselected segment has a fill or is not dim");
  const group = parentOf(all.id);
  // Only the selected segment has a fill: no box around the three, and no fill on the other two.
  must(!group.props.background && here.props.background === "clear" && all.props.background === "#FFFFFF2E", "a fill shows on more than the selected segment");
  const hive = withText((t) => t === "views ↗")[0];
  must(hive.props.color === "#5AA9FF" && hive.props.minHeight === 24 && hive.props.hoverBackground === "#FFFFFF14", "views ↗ is not a blue link at least 24 tall");
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
check("one mark beside the search folds every group, then opens every group", () => {
  // With many groups, folding them one by one is slow; the mark shows what a click does.
  const bands = () => withText((t) => t === "▾").length;
  const open = bands();
  must(open >= 2, "the fixture has fewer than two open groups");
  tap(withText((t) => t === "▾▾")[0]);
  must(bands() === 0 && withText((t) => t === "▸").length === open, "a group stayed open after fold all");
  // One group opened by hand is a mixed state: it counts as open, so the click folds again.
  tap(withText((t) => t === "▸")[0]);
  must(withText((t) => t === "▾▾").length === 1, "a mixed state does not offer to fold");
  tap(withText((t) => t === "▾▾")[0]);
  tap(withText((t) => t === "▸▸")[0]);
  must(bands() === open && withText((t) => t === "▸").length === 0, "a group stayed folded after open all");
});
check("the Show details menu item opens the detail lines of its row", () => {
  must(withText((t) => t === "›").every((n) => n.props.showOnHover === true), "a closed detail mark is not hover-only");
  const menu = parentOf(withText((t) => t === "Copy name: lead-1")[0].id);
  const item = () => menu.children.map(node).find((n) => n && /^(Show|Hide) Details$/.test(n.props.text));
  must(item() && item().props.text === "Show Details", "no Show details item in the lead-1 menu");
  must(!textOf().includes("duplicate"), "lead-1 details already open");
  tap(item());
  mustContain(textOf(), "duplicate");
  // lead-1 compacted 3 times: its ⟳3 pill has the count, so the problem line gives only the advice.
  mustContain(textOf(), "compacted often: start a fresh session");
  must(item().props.text === "Hide Details", "the item did not change to Hide details");
  const open = withText((t) => t === "⌄");
  must(open.length > 0 && open.every((n) => n.props.showOnHover === false), "the open detail mark is not always in view");
  tap(item());
  must(!textOf().includes("duplicate"), "Hide details did not close the lines");
});
// The detail lines add what the row does not show, in three groups: run, work, history.
check("detail lines leave out what the row shows, start each group with a gap, and drop a notice of the tool", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "d-1: opus · acct team · ctx 20% · $3.00 · title Ship it · prompt ship the fix"].join(" | "),
    tabs: [tab(1, "[d-1] t", { id: T(7), branch: "lane/x", latestPrompt: "<event kind=\"repl-eval\">" })],
    agents: [{ ...agent("d-1", T(7), "idle", "claude"), title: "closed" }], prs: [],
  }]));
  tap(withText((t) => t === "›")[0]);
  const labels = withText(() => true).map((n) => n.props.text);
  for (const gone of ["tool", "cost", "title", "context", "last prompt"]) must(!labels.includes(gone), "the details still have a " + gone + " line");
  must(labels.includes("prompt") && labels.includes("ship the fix"), "the details lost the prompt");
  must(!labels.includes("closed") && !labels.includes("first ask"), "a one-word ask still has a line");
  // A plain value reads in the 11.5 pt system font; a path or a name of a branch stays monospaced.
  must(withText((t) => t === "ship the fix").length >= 1 && withText((t) => t === "ship the fix").every((n) => n.props.font === 11.5 && !n.props.monospaced && n.props.color === "#E6E6EA"), "a plain value is not 11.5 pt system text");
  must(withText((t) => t === "lane/x").length >= 1 && withText((t) => t === "lane/x").every((n) => n.props.monospaced === true), "a branch name is not monospaced");
  must(withText((t) => t === "prompt").length >= 1 && withText((t) => t === "prompt").every((n) => n.props.font === 10 && !n.props.monospaced), "a label is not a 10 pt system label");
  must(!labels.some((t) => /^<event/.test(t ?? "")), "a notice of the tool shows as the last ask");
  const branch = withText((t) => t === "branch")[0];
  must(branch && parentOf(parentOf(branch.id).id).props.paddingTop === 8, "the work group does not start with an 8 pt gap");
  // All lines sit in one shaded area, and the group line beside it keeps the 13 pt column of the row gutter.
  // label → its 64 pt cell → its line → the list of lines → the shaded area.
  const up = (n, k) => (k ? up(parentOf(n.id), k - 1) : n);
  const area = up(branch, 4);
  must(area.props.background === "#FFFFFF0A" && up(withText((t) => t === "folder")[0], 4).id === area.id, "the detail lines are not in one shaded area");
  must(parentOf(area.id).children.map(node).some((m) => m && m.props.width === 13), "the group line beside the details is not in the 13 pt gutter column");
  ctx.__setData("workspaces", JSON.stringify(workspaces));
});
check("the info mark opens detail lines", () => {
  const before = textOf().split("\n").length;
  for (const m of withText((t) => t === "›")) tap(m);
  const after = textOf();
  must(after.split("\n").length > before, "no detail lines appeared");
});
check("the tokens detail line names the context tokens; the share is on the row, so the line leaves it out", () => {
  mustContain(textOf(), "420K in context");
  mustContain(textOf(), "95K in context");
  must(!textOf().includes("12% · 420K"), "the detail line still repeats the share of the row");
});
check("the sub badge opens the subagent rows, from cmux data and from the description", () => {
  for (const m of withText((t) => /^▸\d/.test(t))) tap(m);
  const after = textOf();
  mustContain(after, "Explore repo");
  mustContain(after, "Review diff");
});
check("no chip row is wider than a 300 pt sidebar, by the estimate of the panel; the Limits grouping has the fainter fill", () => {
  // cmux does not wrap a row: the panel packs the chips into rows of 280 pt at most, by 6.7 pt a character.
  const chips = reachable().filter((n) => n.props.cornerRadius === 12);
  must(chips.length >= 3, "fewer than 3 chips in the fixture");
  const rows = new Map();
  for (const c of chips) {
    const texts = (c.children ?? []).map(node).filter((n) => typeof n.props.text === "string").map((n) => n.props.text);
    const label = typeof c.props.text === "string" ? [c.props.text] : texts;
    const w = 24 + 6.7 * label[0].length + (label[1] ? 4 + 6.1 * label[1].length : 0);
    const row = parentOf(c.id).id;
    rows.set(row, (rows.get(row) ?? 0) + w);
  }
  must([...rows.values()].every((w) => w <= 280), "a chip row is wider than 280: " + [...rows.values()].map(Math.round).join(", "));
  tap(withText((t) => t === "Limits")[0]);
  const sub = withText((t) => t === "by account")[0];
  must(sub.props.background === "#FFFFFF14" && withText((t) => t === "Limits")[0].props.background === "#FFFFFF2E", "the Limits grouping is as strong as the view segment");
  tap(withText((t) => t === "Limits")[0]);
});
check("the state button groups the rows into sections by state, and a second click restores the workspaces", () => {
  const btn = () => withText((t) => t === "By state")[0];
  must(btn(), "state button not found");
  tap(btn());
  const grouped = textOf();
  mustContain(grouped, "NEEDS YOU");
  mustContain(grouped, "RUNNING");
  // A row carries its workspace as a pill in this view (helper-6 in web).
  must(withText((t) => t === "web").some((n) => n.props.color === "#654321"), "no workspace pill on a row");
  tap(withText((t) => t === "Sessions")[0]);
  must(!textOf().includes("RUNNING"), "the sections stayed after the click on Sessions");
});
check("a row carries its marks as pills: account, your-turn mark and compaction count", () => {
  const all = textOf();
  mustContain(helpText(), "⟳3 · work");  // past the second pill: named by "+N"
  mustContain(all, "→ you");
  mustContain(helpText(), "⟳3");
});
check("the menus hold no item that does nothing or repeats a click", () => {
  // A click on a row goes to the session; a session with no PR has no PR item; fold-all lives beside the search.
  for (const dead of ["Go to session", "No PR for this session", "Agent session", "Collapse all groups", "Expand all groups"]) {
    must(withText((t) => t === dead).length === 0, "the item is back: " + dead);
  }
  must(withText((t) => t === "Timeline").length >= 1 && withText((t) => t === "Setup").length >= 1, "the views submenu lost an item");
});
check("Pin to Top moves a session into a PINNED block, once, and saves the name; Unpin puts it back", () => {
  const cards = () => withText((x) => x === "[worker-2]").length;
  const item = () => withText((x) => x === "Pin to Top" || x === "Unpin")
    .find((n) => parentOf(n.id).children.map(node).some((m) => m && m.props.text === "Copy name: worker-2"));
  const before = cards();
  must(before >= 1 && item() && item().props.text === "Pin to Top", "no Pin to Top item in the worker-2 menu");
  must(withText((x) => x === "PINNED").length === 0, "a PINNED block shows with no pin");
  const calls = cmuxCalls().length;
  tap(item());
  must(withText((x) => x === "PINNED").length === 1, "no PINNED block after the pin");
  must(cards() === before, "the pinned session shows " + cards() + " times, was " + before);
  must(cmuxCalls().slice(calls).some((c) => /(^| \| )@pin: worker-2$/.test(String(c.params?.description ?? ""))), "the pin was not saved: " + JSON.stringify(cmuxCalls().slice(calls)).slice(0, 300));
  must(item().props.text === "Unpin", "the item did not change to Unpin");
  tap(item());
  must(withText((x) => x === "PINNED").length === 0 && cards() === before, "Unpin did not put the row back");
});
check("the Copy name menu item writes the session name to the clipboard", () => {
  const item = withText((t) => t === "Copy name: lead-1")[0];
  must(item, "menu item not found");
  tap(item);
  must(clipboard.includes("lead-1"), "clipboard holds " + JSON.stringify(clipboard));
});
check("a row menu opens the views page on the hive view with that session as the open tab, and lists each view once", () => {
  // The Hive item of the lead-1 row: its menu (the "Show in views" submenu) sits in the row menu with "Copy name: lead-1".
  // The lowest ancestor of an item that also holds "Copy name: lead-1" is the menu of that row.
  const sub = (n) => { const out = []; const walk = (id) => { const x = node(id); if (!x) return; out.push(x); x.children.forEach(walk); }; walk(n.id); return out; };
  const menuOf = (n) => { for (let c = parentOf(n.id); c; c = parentOf(c.id)) if (sub(c).some((x) => x.props.text === "Copy name: lead-1")) return c; return null; };
  const item = withText((t) => t === "Hive").find((n) => menuOf(n) && !sub(menuOf(n)).some((x) => x.props.text === "Copy name: worker-2"));
  must(item, "menu item Hive not found");
  const before = cmuxCalls().length;
  tap(item);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "browser.open_split", "got " + JSON.stringify(calls));
  const sent = JSON.parse(decodeURIComponent(calls[0].params.url.split("#")[1]));
  const open = sent.ws.flatMap((w) => w.a).filter((a) => a.f);
  must(sent.v === "hive" && open.length === 1 && open[0].i === T(1), "the link carries " + JSON.stringify([sent.v, open.map((a) => a.i)]));
  // Every view is listed (the owner asked for all), each once, by its tab name: never a long title.
  {
    const labels = parentOf(withText((t) => t === "Timeline")[0].id).children.map(node).filter(Boolean).map((m) => m.props.text);
    must(new Set(labels).size === labels.length && labels.length === 10 && labels.every((l) => /^[A-Z][a-z]+$/.test(l)), "views submenu: " + JSON.stringify(labels));
  }
});
check("the hive button asks cmux for a browser split with the hive page", () => {
  const btn = withText((t) => t === "views ↗")[0];
  must(btn, "hive button not found");
  const before = cmuxCalls().length;
  tap(btn);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "browser.open_split", "got " + JSON.stringify(calls));
  must(/^file:\/\/.*hive\.html#/.test(calls[0].params.url), "url is not a hive page link");
});
check("a row menu opens the views page on the timeline, with the session marked", () => {
  const item = withText((t) => t === "Timeline")[0];
  must(item, "menu item not found");
  const before = cmuxCalls().length;
  tap(item);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "browser.open_split", "got " + JSON.stringify(calls));
  const sent = JSON.parse(decodeURIComponent(calls[0].params.url.split("#")[1]));
  must(sent.v === "timeline" && /^[a-z0-9-]+$/.test(sent.sel), "the link carries " + JSON.stringify([sent.v, sent.sel]));
  // The hive link carries the context tokens as z, also for the Codex tab, and no z when unknown.
  const linked = sent.ws.flatMap((w) => w.a);
  must(linked.some((a) => a.i === T(3) && a.z === 1234567), "scout-4 has no z in the link");
  must(linked.some((a) => a.i === T(4) && a.x === 37 && a.z === 95000), "the Codex tab has no x and z in the link");
  must(linked.filter((a) => a.i === T(2)).every((a) => !("z" in a)), "worker-2 has a z with no token figure");
});
check("the Limits view lists the limit windows: window name, bar, percent, then the reset time", () => {
  const btn = withText((t) => t === "Limits")[0];
  must(btn, "Limits toggle not found");
  tap(btn);
  // The window name comes before the bar, the percent is its own column; with no reset epoch the clock time follows.
  const pct = withText((t) => t === "42%")[0];
  must(pct && pct.props.fixedSize === true && reachable().some((n) => n.props.width === 34) && pct.props.monospaced === true && pct.props.color === META,
    "42% is not a 34 pt META percent column: " + JSON.stringify(pct?.props));
  must(withText((t) => t === "5h").length === 1, "the window name is not its own column");
  const rest = withText((t) => t === "14:10");
  must(rest.length === 1 && rest[0].props.lineLimit === 1 && String(rest[0].props.help).startsWith("5h 42% · resets 14:10"), "no one-line \"14:10\" with the full text on hover");
});
// The bar fills the free width: 20 segments of 5%, each with no fixed width.
const segs = (fill) => reachable().filter((n) => n.type === "rectangle" && n.props.height === 5 && n.props.maxWidth === "infinity" && (!fill || n.props.fill === fill));
check("Limits bars stretch: 20 segments each, 42% lights 8, 4% lights one; no-data tools share one line; cost stays", () => {
  must(segs().length === 40, "not two bars of 20 segments: " + segs().length);
  must(segs("#34C759").length === 9, "42% and 4% do not light 8 + 1 green segments: " + segs("#34C759").length);
  must(withText((t) => t === "no limit data on this Mac").length === 0, "a tool with no data has a line of its own");
  const none = withText((t) => /(^|, )Grok(,|$)/.test(t))[0];
  must(none && withText((t) => t === "no data").length === 1, "the tools with no data do not share one line");
  must(!parentOf(none.id).children.map(node).some((n) => n.type === "rectangle" || n.type === "capsule"), "the grok line has a bar");
  must(withText((t) => /^\$0\.30 · 1 session$/.test(t)).length === 1, "no cost for the personal account");
  tap(withText((t) => t === "Limits")[0]);
  must(segs().length === 0, "a second click on Limits did not close the view");
});
// The Limits view groups the lines per account: the name once as a header, the tool name once, the cost inside the group.
const G = (n) => "EEEEEEEE-0000-0000-0000-00000000000" + n;
const limitsFixture = (limitsText, extra = []) => JSON.stringify([{
  id: "ws-acc", title: "ignored", directory: "/work/acc", color: "#336699", selected: true, unread: 0,
  description: ["/work/acc", "@home: " + HOME, ...extra, "@limits: " + limitsText, "s-one: opus · acct work · $15.91", "s-two: sonnet · $2.00"].join(" | "),
  tabs: [tab(1, "[s-one] t", { id: G(6), focused: true }), tab(2, "[s-two] t", { id: G(7) })],
  agents: [agent("s-one", G(6), "idle", "claude"), agent("s-two", G(7), "idle", "claude")], prs: [],
}]);
const limitsTexts = () => withText(() => true).map((n) => n.props.text);
check("a limit of 80% or more shows in the panel head in red with a 20 pt bar; a click opens the Limits view", () => {
  ctx.__setData("workspaces", limitsFixture("claude,5h,91,14:10,1799999400;codex,week,4,Sat 09:39,1799999300"));
  const head = withText((t) => t === "claude 91%");
  must(head.length === 1 && head[0].props.color === "#FF453A", "no red \"claude 91%\" in the head");
  must(withText((t) => /^codex /.test(t)).length === 0, "a limit below 80% shows in the head");
  must(reachable().some((n) => n.type === "capsule" && n.props.width === 20 && n.props.height === 4), "no 20 pt bar beside the head limit");
  tap(parentOf(head[0].id));
  must(withText((t) => t === "by account").length === 1, "a click on the head limit did not open the Limits view");
  tap(withText((t) => t === "Limits")[0]);
  ctx.__setData("workspaces", JSON.stringify(workspaces));
});
const MENU_TEXT = /^(Copy the text|Show .*|Put .* on hold|Resume .*|)$/;
check("the Limits view groups per account: cost in the header, window lines, one no-data block at the end", () => {
  ctx.__setData("workspaces", limitsFixture("claude,5h,7,21:20,1799999400,work;claude,week,1,Sun 10:00,1799999400,work;claude,week,75,Wed 23:00,1799999400;codex,week,4,Wed 10:19,1799999400;claude,,,,0,team-a;codex,,,,0,team-a;opencode,,,,0;grok,,,,0", ["@primary: personal"]));
  tap(withText((t) => t === "Limits")[0]);
  const first = limitsTexts();
  // The room line first: two Claude accounts report a week, both under 80%, one green dot each.
  must(first.includes("2 of 2 under 80% this week"), "no room line: " + JSON.stringify(first));
  must(reachable().filter((n) => n.type === "circle" && n.props.fill === "#34C759").length >= 2, "the room line has no green dot per account");
  const seq = first.slice(first.lastIndexOf("personal")).filter((t) => !MENU_TEXT.test(t));
  must(JSON.stringify(seq) === JSON.stringify([
    "personal", "$2.00 · 1 session", "Claude", "week", "75%", "Wed 23:00", "Codex", "week", "4%", "Wed 10:19",
    "work", "$15.91 · 1 session", "Claude", "5h", "7%", "21:20", "week", "1%", "Sun 10:00",
    "no data", "team-a: Claude, Codex · OpenCode, Grok",
  ]), "the grouped view reads " + JSON.stringify(seq));
  // An account with no data has no header of its own, and there is no "other" group.
  must(!first.includes("team-a") && !first.includes("other"), "an account with no data still has a group");
  must(withText((t) => t === "team-a: Claude, Codex · OpenCode, Grok")[0].props.color === META, "the no-data line is not muted");
  must(withText((t) => ["Here", "ended", "train"].includes(t)).length === 0 && !reachable().some((n) => n.type === "textfield"), "a control of the session list shows in the Limits view");
  tap(withText((t) => t === "by tool")[0]);
  const texts = limitsTexts();
  const turned = texts.slice(texts.indexOf("Claude", texts.indexOf("2 of 2 under 80% this week"))).filter((t) => !MENU_TEXT.test(t));
  must(JSON.stringify(turned) === JSON.stringify([
    "Claude", "personal", "week", "75%", "Wed 23:00", "work", "5h", "7%", "21:20", "week", "1%", "Sun 10:00",
    "Codex", "personal", "week", "4%", "Wed 10:19",
    "cost", "personal", "$2.00 · 1 session", "work", "$15.91 · 1 session",
    "no data", "Claude: team-a · Codex: team-a · OpenCode, Grok",
  ]), "the view per tool reads " + JSON.stringify(turned));
  tap(withText((t) => t === "by account")[0]);
  tap(withText((t) => t === "Limits")[0]);
  must(withText((t) => t === "Here").length === 1 && withText((t) => t === "by tool").length === 0, "the controls of the session list did not come back");
});
check("time left / reset time switches the end of a window line; the hover keeps both", () => {
  ctx.__setData("workspaces", limitsFixture("claude,week,40," + "Thu 10:00,1799999400,work," + (EPOCH + 2 * 86400 + 5 * 3600 + 30)));
  tap(withText((t) => t === "Limits")[0]);
  const line = withText((t) => t === "2d 5h")[0];
  must(line && String(line.props.help).includes("resets Thu 10:00 (in 2d 5h)"), "the time-left line has no full hover: " + JSON.stringify(line?.props.help));
  must(withText((t) => t === "time left").length === 1 && withText((t) => t === "reset time").length === 1, "no time left / reset time switch");
  tap(withText((t) => t === "reset time")[0]);
  must(withText((t) => t === "Thu 10:00").length === 1 && withText((t) => t === "2d 5h").length === 0, "reset time did not show the clock time");
  tap(withText((t) => t === "time left")[0]);
  must(withText((t) => t === "2d 5h").length === 1, "time left did not come back");
  tap(withText((t) => t === "Limits")[0]);
  must(withText((t) => t === "reset time").length === 0, "the switch shows outside Limits");
});
check("a limit line counts down to its reset, and Put on hold moves an account to the on-hold group and saves it", () => {
  // EPOCH + 2 days 5 hours 10 minutes: the countdown reads "2d 5h"; 42 minutes reads "42m".
  ctx.__setData("workspaces", limitsFixture("claude,week,40,Thu 10:00,1799999400,work," + (EPOCH + 2 * 86400 + 5 * 3600 + 600) + ";claude,5h,10,12:00,1799999400,," + (EPOCH + 42 * 60 + 30) + ";claude,week,20,Wed 23:00,1799999400", ["@primary: personal"]));
  tap(withText((t) => t === "Limits")[0]);
  must(withText((t) => t === "2d 5h").length === 1, "no 2d 5h countdown: " + JSON.stringify(limitsTexts()));
  must(withText((t) => t === "42m").length === 1, "no 42m countdown on a line with no account name");
  must(withText((t) => t === "Wed 23:00").length === 1, "a line with no reset epoch lost its clock time");
  const hold = withText((t) => t === "Put Claude work on hold")[0];
  must(hold, "no Put on hold item for the work account");
  const calls = cmuxCalls().length;
  tap(hold);
  must(cmuxCalls().slice(calls).some((c) => /(^| \| )@hold: claude\/work$/.test(String(c.params?.description ?? ""))), "the hold was not saved");
  must(withText((t) => t === "2d 5h").length === 0, "the held account still shows its line");
  must(withText((t) => t === "on hold").length === 1 && withText((t) => t === "Claude work").length === 1, "no on-hold group naming Claude work");
  // With one account left, Claude has no room-left line: the held account is not counted.
  must(!limitsTexts().some((t) => / under 80% this week$/.test(t)), "the held account is still counted");
  tap(withText((t) => t === "Resume Claude work")[0]);
  must(withText((t) => t === "on hold").length === 0 && withText((t) => t === "2d 5h").length === 1, "Resume did not bring the line back");
  must(withText((t) => t === "2 of 2 under 80% this week").length === 1, "the room-left line did not come back");
  tap(withText((t) => t === "Limits")[0]);
});
// A tool reports its limit only with a reply, so a reading can be old. Past 15 minutes the line says so.
check("a limit reading older than 15 minutes says how old it is instead of the time left", () => {
  ctx.__setData("workspaces", limitsFixture("claude,week,91,Thu 10:00," + (EPOCH - 2 * 3600) + ",," + (EPOCH + 86400 + 60) + ";claude,5h,7,12:00," + (EPOCH - 600) + ",," + (EPOCH + 3600 + 60)));
  tap(withText((t) => t === "Limits")[0]);
  must(withText((t) => t === "2h old").length === 1, "the 2-hour-old reading does not say its age: " + JSON.stringify(limitsTexts()));
  must(withText((t) => /^1h [01]m$/.test(t)).length === 1, "the fresh reading lost its time left: " + JSON.stringify(limitsTexts()));
  tap(withText((t) => t === "Limits")[0]);
  ctx.__setData("workspaces", JSON.stringify(workspaces));
});
check("the Limits view of one account with no accounts file has no header and still names a tool with no data", () => {
  ctx.__setData("workspaces", limitsFixture("claude,5h,30,21:20,1799999400;claude,week,10,Sun 10:00,1799999400;codex,,,,0;grok,,,,0"));
  tap(withText((t) => t === "Limits")[0]);
  const all = limitsTexts();
  must(!all.includes("other") && !all.includes("personal"), "a header shows with one nameless account: " + JSON.stringify(all));
  must(all.filter((t) => t === "Claude").length === 1, "Claude is named more than once: " + JSON.stringify(all));
  must(withText((t) => t === "Codex, Grok").length === 1, "the tools with no data are not named on one line");
  tap(withText((t) => t === "Limits")[0]);
  ctx.__setData("workspaces", JSON.stringify(workspaces));
});
check("a head count filters the list, a second tap clears it; the idle count has no tap", () => {
  must(!tapTarget(withText((t) => t === "2 idle")[0]), "the idle count is tappable");
  tap(withText((t) => t === "1 need you")[0]);
  must(withText((t) => t === "!").some((n) => n.props.color === "primary"), "the needs chip does not show as the active filter");
  // A chip carries the colour of its state on the rows; the active one is white on a tint of that colour.
  must(withText((t) => t === "PR").every((n) => n.props.color === "#D1D1D6"), "the PR chip is not neutral, as the PR pill on a row is");
  must(withText((t) => t === "[worker-2]").length === 0, "an idle row shows under the needs filter");
  tap(withText((t) => t === "1 need you")[0]);
  must(withText((t) => t === "!").length === 0 && withText((t) => t === "[worker-2]").length === 1, "the second tap did not clear the filter");
});
check("the Reset chip restores the default view and turns the view by state off", () => {
  tap(withText((t) => t === "By state")[0]);
  tap(tapTarget(withText((t) => t === "Here")[0]));
  // Here shows the api workspace only: its finished-not-seen session gets its own section in the view by state.
  mustContain(textOf(), "FINISHED · NOT SEEN");
  const reset = withText((t) => t === "✕ Reset")[0];
  must(reset, "no Reset chip");
  tap(reset);
  must(!textOf().includes("FINISHED · NOT SEEN"), "the view by state stayed on");
  must(withText((t) => t === "Here")[0].props.color !== "primary" && withText((t) => t === "Sessions")[0].props.background === "#FFFFFF2E", "the scope did not go back to all workspaces");
  must(withText((t) => t === "ended").every((n) => n.props.color !== "primary"), "ended rows stayed on");
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
check("a search finds a session inside a folded group, and the fold comes back after the search", () => {
  tap(withText((t) => t === "▾▾")[0]);
  must(withText((t) => t === "[worker-2]").length === 0, "the groups did not fold");
  const field = reachable().find((n) => n.type === "textfield");
  ctx.__dispatch(field.id, "edit", JSON.stringify({ text: "worker-2" }));
  must(withText((t) => t === "[worker-2]").length >= 1, "a match inside a folded group stays hidden");
  must(withText((t) => t === "▾▾" || t === "▸▸").length === 0, "the fold-all mark shows during a search");
  ctx.__dispatch(field.id, "edit", JSON.stringify({ text: "" }));
  must(withText((t) => t === "[worker-2]").length === 0, "the fold was lost after the search");
  tap(withText((t) => t === "▸▸")[0]);
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

// ---------------------------------------------------------------- health marks, the wait on subagents, the seen mark
// A second data set, after the view went back to its defaults above. The tab order is the reverse of the attention
// order, so the sort check can fail. h-bad carries only forms that the panel must leave out.
const N = (n) => "BBBBBBBB-0000-0000-0000-00000000000" + n;
const newDescription = ["new",
  "h-loop: sonnet · loop 6 · overlap 2 · silent 1 · err 3",
  "h-over: sonnet · overlap 2 · silent 1 · err 3",
  "h-silent: sonnet · silent 1 · err 3",
  "h-err: sonnet · err 3",
  "h-bad: sonnet · err 0 · loop x · overlap 10000 · silent -1 · err 3.5 · loop 05",
  // Its turn ended and a subagent runs: cmux reports it as needs_input, with the plain wait reason "input".
  "h-agents: sonnet · waits input · sub 1/2: Explore repo",
  // A permission ask counts, whatever its subagents do.
  "h-ask: sonnet · waits permission prompt · sub 1/2: Review diff",
  "h-seen: sonnet",
  "@home: " + HOME].join(" | ");
const NAMES = ["h-seen", "h-over", "h-loop", "h-silent", "h-err", "h-bad", "h-agents", "h-ask"];
const STATES = { "h-seen": "working", "h-over": "working", "h-loop": "working", "h-silent": "working", "h-err": "idle", "h-bad": "idle", "h-agents": "needs_input", "h-ask": "needs_input" };
// focus: the session whose tab has the focus; seen: the state of h-seen.
const newData = (focus, seen) => [{
  id: "ws-new", title: "ignored", directory: "/work/new", description: newDescription, color: "#336699", selected: true, unread: 0,
  tabs: NAMES.map((n, i) => tab(i + 1, "[" + n + "] t" + i, { id: N(i + 1), focused: n === focus })),
  agents: NAMES.map((n, i) => agent(n, N(i + 1), n === "h-seen" ? seen : STATES[n], "claude")),
  prs: [],
}];
const subtree = (n) => { const out = []; const walk = (id) => { const x = node(id); if (!x) return; out.push(x); x.children.forEach(walk); }; if (n) walk(n.id); return out; };
// The card of a session row (the first one, for a row that also shows in NEEDS YOU) and the texts in it.
const cardOf = (name) => withText((t) => t === "[" + name + "]").map(tapTarget).find((n) => n && n.props.cornerRadius === 10);
const rowText = (name) => subtree(cardOf(name)).map((n) => n.props.text).filter((t) => typeof t === "string");
const lastAt = (name) => reachable().map((n) => n.props.text).lastIndexOf("[" + name + "]");
const YELLOW = "#FFD60A";

check("health marks: one per row, loop > overlap > silent, in red, yellow and yellow; no err total on a row", () => {
  ctx.__setData("workspaces", JSON.stringify(newData("h-err", "working")));
  must(withText((t) => t === "[h-loop]").length === 1, "the new data did not render");
  const mark = (t) => withText((x) => x === t).filter((n) => n.props.cornerRadius === 4);
  must(mark("loop 6").length === 1 && mark("loop 6")[0].props.color === "#FF6B61", "h-loop has no red loop 6 pill");
  must(rowText("h-loop").filter((t) => /^(loop|overlap|silent|err) \d/.test(t)).length === 1, "h-loop shows more than one health mark: " + rowText("h-loop").join(" | "));
  must(mark("overlap 2").length === 1 && mark("overlap 2")[0].props.color === YELLOW && rowText("h-over").includes("overlap 2"), "h-over has no yellow overlap 2 pill, or another row has one");
  must(mark("silent 1").length === 1 && mark("silent 1")[0].props.color === YELLOW && rowText("h-silent").includes("silent 1"), "h-silent has no yellow silent 1 pill, or another row has one");
  // The error count is a total of the whole session: every long session has one, so it is not a mark on the row.
  must(mark("err 3").length === 0, "a row shows the err total as a pill");
});
check("health fields with a bad value are left out, and none is taken for the model", () => {
  must(!rowText("h-bad").some((t) => /^(loop|overlap|silent|err)\b/.test(t)), "h-bad shows a mark: " + rowText("h-bad").join(" | "));
  // Both rows use sonnet, the usual model of their group, so the band names it once and the rows leave it out.
  must(withText((t) => t === "sonnet").length >= 1 && !rowText("h-bad").includes("sonnet"), "a health field took the place of the model");
  must(withText((t) => /^(loop|overlap|silent|err)$/.test(t)).length === 0, "a health field shows in the model column");
});
check("a session on its agents is not in NEEDS YOU and shows \"agents running\"; a permission ask still counts", () => {
  must(withText((t) => t === "[h-agents]").length === 1, "h-agents shows in the NEEDS YOU block");
  must(rowText("h-agents").some((t) => t === "agents running"), "h-agents does not show \"agents running\": " + rowText("h-agents").join(" | "));
  must(cardOf("h-agents").props.background !== "#FF9F0A26", "h-agents has the orange fill of an ask");
  must(withText((t) => t === "[h-ask]").length === 2 && rowText("h-ask").includes("asked · permission prompt"), "the permission ask with a running subagent left NEEDS YOU");
  must(withText((t) => t === "1 need you").length === 1 && withText((t) => t === "2 need you").length === 0, "the head count still counts h-agents");
  const head = withText((t) => t === "NEEDS YOU")[0];
  must(head && parentOf(head.id).children.map(node).some((n) => n?.props.text === "1"), "the NEEDS YOU block does not count 1");
});
check("a turn that ends in a tab without the focus is \"finished, not seen\"; a session idle at first sight is not", () => {
  ctx.__setData("workspaces", JSON.stringify(newData("h-err", "idle")));
  must(cardOf("h-seen").props.background === "#BF5AF217" && rowText("h-seen").includes("finished · not seen"), "h-seen is not marked unseen: " + rowText("h-seen").join(" | "));
  must(cardOf("h-bad").props.background === "clear", "h-bad was idle from the start and is marked");
});
check("the unseen mark clears when the owner focuses the tab, and stays clear after the focus moves on", () => {
  must(rowText("h-seen").includes("finished · not seen"), "h-seen is not marked unseen before the focus");
  ctx.__setData("workspaces", JSON.stringify(newData("h-seen", "idle")));
  must(!rowText("h-seen").includes("finished · not seen"), "the focused tab is still marked unseen");
  ctx.__setData("workspaces", JSON.stringify(newData("h-err", "idle")));
  must(cardOf("h-seen").props.background === "clear" && !rowText("h-seen").includes("finished · not seen"), "the mark came back after the focus moved on");
});
check("the detail lines name each health field in full; a bad value adds no line", () => {
  tap(subtree(cardOf("h-bad")).find((n) => n.props.text === "›"));
  must(!textOf().includes("failed tool") && !textOf().includes("also edited"), "h-bad has a health detail line");
  tap(subtree(cardOf("h-loop")).find((n) => n.props.text === "›"));
  for (const l of ["6 failed tool calls in a row", "2 files also edited by another session", "1 subagent silent for 10 min or more", "3 failed tool calls or API errors"]) mustContain(textOf(), l);
  // Problems stand first, in amber, one a line, with no label: the eye lands on them before the facts.
  must(withText((t) => t === "6 failed tool calls in a row").length >= 1 && withText((t) => t === "6 failed tool calls in a row").every((n) => n.props.color === "#F5A524" && n.props.font === 11.5), "a problem line is not an 11.5 pt amber line");
  must(withText((t) => t === "errors" || t === "loop" || t === "overlap" || t === "silent").length === 0, "a problem line still has a label");
});
check("rows keep their height and their columns with and without the new fields", () => {
  const rows = reachable().filter((n) => n.props.cornerRadius === 10 && n.props.borderWidth === 1);
  must(rows.length === 9 && rows.every((n) => {
    // The left column is 13 pt wide: the group line (42 pt at least) with the status dot on it. Then the text.
    const [gutter, text] = n.children.map(node);
    const line = node(gutter.children[0]);
    return gutter.props.width === 13 && line.props.minHeight === 42 && line.props.opacity === 0.35 && text.props.paddingVertical === 4;
  }), "a session row has another form");
  const seconds = rows.map((n) => node(node(n.children[1]).children[1])).filter((n) => n.props.minHeight === 16 && !n.props.paddingLeading);
  must(seconds.length === rows.length, "second lines: " + seconds.length + " for " + rows.length + " rows");
  const widths = (w) => reachable().filter((n) => n.props.width === w).length;
  must(widths(27) === rows.length && widths(49) === rows.length, "the context and cost columns are not on every row");
});
check("a row menu lists every view of the page, and each item opens its own view", () => {
  // The page's own list, so a view added there without a menu item fails here.
  const page = fs.readFileSync(new URL("../scripts/hive.html", import.meta.url), "utf8");
  const ids = [...page.match(/const VIEWS = \[([\s\S]*?)\];/)[1].matchAll(/\["([a-z]+)", "([A-Za-z]+)"/g)].map((m) => [m[2], m[1]]);
  must(ids.length === 10, "views on the page: " + JSON.stringify(ids));
  for (const [label, v] of ids.slice(2)) {
    const item = withText((t) => t === label).find((n) => parentOf(n.id) && parentOf(n.id).children.map(node).some((x) => x && x.props.text === "Hive"));
    must(item, "menu item " + JSON.stringify(label) + " not found");
    const before = cmuxCalls().length;
    tap(item);
    const calls = cmuxCalls().slice(before);
    must(calls.length === 1 && calls[0].method === "browser.open_split", "got " + JSON.stringify(calls));
    must(JSON.parse(decodeURIComponent(calls[0].params.url.split("#")[1])).v === v, "the link does not open the " + v + " view");
  }
});
// A third data set: an ask with no wait reason yet (the description trails cmux by one watcher pass), an ask on the
// screen with the plain reason, and an idle session whose subagent runs, with no next step.
// New tab ids: the panel keeps the last state per tab id, so ids of the data set above would carry its states over.
const K = (n) => "CCCCCCCC-0000-0000-0000-00000000000" + n;
const kidsData = (nowaitReason) => [{
  id: "ws-kids", title: "ignored", directory: "/work/kids", description: ["kids",
    "k-nowait: sonnet" + (nowaitReason ? " · waits input" : "") + " · sub 1/2: Explore repo",
    "k-screen: sonnet · waits input · screen asks · sub 1/2: Lint",
    "k-idle: sonnet · sub 1/2: Review diff"].join(" | "),
  color: "#336699", selected: true, unread: 0,
  tabs: ["k-nowait", "k-screen", "k-idle", "k-other"].map((n, i) => tab(i + 1, "[" + n + "] t" + i, { id: K(i + 1), focused: n === "k-other" })),
  agents: [agent("k-nowait", K(1), "needs_input", "claude"), agent("k-screen", K(2), "needs_input", "claude"),
    agent("k-idle", K(3), "idle", "claude"), agent("k-other", K(4), "idle", "claude")],
  prs: [],
}];
check("an ask with no wait reason yet, or a menu on the screen, counts even while a subagent runs", () => {
  ctx.__setData("workspaces", JSON.stringify(kidsData(false)));
  must(withText((t) => t === "[k-nowait]").length === 2 && withText((t) => t === "[k-screen]").length === 2, "an ask with a running subagent left NEEDS YOU");
  must(withText((t) => t === "2 need you").length === 1, "the head count does not count both asks");
  must(rowText("k-idle").includes("agents running"), "the idle session with a running subagent does not show \"agents running\": " + rowText("k-idle").join(" | "));
});
check("when the plain reason arrives, the ask becomes a wait on its agents and its turn end is not seen", () => {
  ctx.__setData("workspaces", JSON.stringify(kidsData(true)));
  must(withText((t) => t === "[k-nowait]").length === 1 && withText((t) => t === "1 need you").length === 1, "k-nowait still shows in NEEDS YOU");
  must(rowText("k-nowait").includes("finished · not seen · agents running"), "k-nowait is not an unseen wait on its agents: " + rowText("k-nowait").join(" | "));
});
// A workspace that began with no description: label-tabs.py left only its own parts there, so the text starts
// with "| ". The group must take the folder name, not that label text.
const B = (n) => "DDDDDDDD-0000-0000-0000-00000000000" + n;
check("a workspace whose description holds no folder is named by its folder, not by the label text", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", description: "| b-one: sonnet · $1.00", color: "#336699", selected: true, unread: 0,
    tabs: [tab(1, "[b-one] t", { id: B(1), focused: true })], agents: [agent("b-one", B(1), "idle", "claude")], prs: [],
  }]));
  must(withText((t) => t === "bare").length >= 1, "the group is not named \"bare\"");
  must(withText((t) => t.startsWith("| b-one")).length === 0, "the label text shows as a group name");
  // The one row of the group: its model is on the band, its cost on the row.
  must(withText((t) => t === "sonnet").length >= 1 && rowText("b-one").includes("$1.00"), "the session lost its fields: " + rowText("b-one").join(" | "));
});
check("a tab title that the shell left (user@host, or a start command with a variable) is not shown as the work", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", description: "/work/bare | b-two: sonnet · title Fix the login form", color: "#336699", selected: true, unread: 0,
    tabs: [tab(1, "[b-one] me@my-laptop: ~/work", { id: B(2), focused: true }), tab(2, "[b-two] TOOL_HOME=~/.tool-x tool", { id: B(3) }), tab(3, "[b-three] Review the diff", { id: B(4) })],
    agents: [agent("b-one", B(2), "idle", "claude"), agent("b-two", B(3), "idle", "claude"), agent("b-three", B(4), "idle", "claude")], prs: [],
  }]));
  must(withText((t) => /my-laptop|TOOL_HOME/.test(t)).length === 0, "a shell title shows on a row");
  must(rowText("b-two").includes("Fix the login form"), "the session title does not replace the start command: " + rowText("b-two").join(" | "));
  must(rowText("b-three").includes("Review the diff"), "a real tab title was dropped");
});
// The start menu of a group: its items come from the tools and accounts in "@limits", never from a list in the panel.
// The fixture mixes the 7-part items of the current watcher (reset epoch last, an empty account before it) with
// 5- and 6-part items: an account with a reset time once dropped out of the menu.
check("the group menu starts a plain terminal first, then each tool with each account, by a fixed command", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "@primary: main", "@limits: claude,week,4,Sat 09:39,1799999300,,1794700000;claude,5h,7,12:00,1799999300,work,1794700000;claude,,,,0,work;codex,,,,0;codex,,,,0,team;grok,,,,0;agy,,,,0", "b-one: sonnet"].join(" | "),
    tabs: [tab(1, "[b-one] t", { id: B(5), focused: true })], agents: [agent("b-one", B(5), "idle", "claude")], prs: [],
  }]));
  const want = ["New Terminal", "New Claude", "main  \u2605 default", "work", "New Codex", "team", "New Grok", "New Antigravity", "Add Account", "Claude…", "Codex…", "Grok…"];
  const once = [...new Set(withText((t) => want.includes(t)).map((n) => n.props.text))];
  must(JSON.stringify(once) === JSON.stringify(want), "menu items: " + JSON.stringify(once));
  must(withText((t) => t.endsWith("Antigravity…")).length === 0, "a tool with no account support got an add item");
  let before = cmuxCalls().length;
  tap(withText((t) => t === "team")[0]);
  let calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "surface.create" && calls[0].params.workspace_id === "ws-bare", "got " + JSON.stringify(calls));
  must(calls[0].params.initial_command === "\"$SHELL\" -lic 'AGENT_ACCOUNT=team \"$HOME/.config/cmux/scripts/agent-run.sh\" codex; exec \"$SHELL\" -l'", "command: " + calls[0].params.initial_command);
  before = cmuxCalls().length;
  tap(withText((t) => t.endsWith("Codex…"))[0]);
  calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].params.initial_command === "\"$SHELL\" -lic 'printf \"New Codex account name (a-z, 0-9, -): \"; read -r n; \"$HOME/.config/cmux/scripts/agents-account-add.sh\" codex \"$n\"; exec \"$SHELL\" -l'", "add command: " + JSON.stringify(calls));
  before = cmuxCalls().length;
  tap(withText((t) => t === "New Grok")[0]);
  calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].params.initial_command === "\"$SHELL\" -lic 'AGENT_ACCOUNT=main \"$HOME/.config/cmux/scripts/agent-run.sh\" grok; exec \"$SHELL\" -l'", "grok command: " + JSON.stringify(calls));
  before = cmuxCalls().length;
  tap(withText((t) => t === "New Terminal")[0]);
  calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "surface.create" && !("initial_command" in calls[0].params), "a plain terminal got a command: " + JSON.stringify(calls));
});
// Closing tabs: each close is behind a second, named "Yes, close ..." item, so one stray click closes nothing.
check("Close finished lists idle sessions only (not the open one, not pinned, not working) and closes after Yes", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "@pin: b-pin", "b-open: sonnet", "b-done: sonnet", "b-busy: sonnet", "b-pin: sonnet"].join(" | "),
    tabs: [tab(1, "[b-open] t", { id: B(1), focused: true }), tab(2, "[b-done] t", { id: B(2) }), tab(3, "[b-busy] t", { id: B(3) }), tab(4, "[b-pin] t", { id: B(4) })],
    agents: [agent("b-open", B(1), "idle", "claude"), agent("b-done", B(2), "idle", "claude"), agent("b-busy", B(3), "working", "claude"), agent("b-pin", B(4), "idle", "claude")], prs: [],
  }]));
  must(withText((t) => t === "Close Finished Tabs (1)").length === 1, "no Close finished (1): " + JSON.stringify(withText((t) => t.startsWith("Close")).map((n) => n.props.text)));
  const yes = withText((t) => t === "Yes, close b-done");
  must(yes.length >= 2, "b-done has no Yes item in the group menu and its row menu");
  must(withText((t) => t === "Yes, close all 1: b-done").length === 1, "no Close all confirm item");
  // The submenu titles do nothing on their own.
  let before = cmuxCalls().length;
  tap(withText((t) => t === "Close Finished Tabs (1)")[0]);
  for (const n of withText((t) => t === "Close Tab")) tap(n);
  must(cmuxCalls().slice(before).every((c) => c.method !== "surface.close"), "a submenu title closed a tab");
  before = cmuxCalls().length;
  tap(withText((t) => t === "Yes, close all 1: b-done")[0]);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "surface.close" && calls[0].params.surface_id === "SF-2" && calls[0].params.workspace_id === "ws-bare" && String(calls[0].params.force) === "true", "close calls (force is needed for a tab with a running process): " + JSON.stringify(calls));
  // Every session row has its own Close tab, the open one too: the owner chose it by hand.
  must(withText((t) => t === "Yes, close b-open").length === 1 && withText((t) => t === "Yes, close b-busy (working)").length === 1, "a row has no Close tab");
});
// Approve once was removed (2026-11-18): in cmux its key never reached the tab, and the click failed with no sign.
// A permission prompt is answered in the tab itself.
check("a row that waits on a permission prompt has no Approve item", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "b-ask: sonnet · waits permission prompt"].join(" | "),
    tabs: [tab(1, "[b-ask] t", { id: B(1) })], agents: [agent("b-ask", B(1), "needs_input", "claude")], prs: [],
  }]));
  must(withText((t) => /approve/i.test(t)).length === 0, "an Approve item shows");
});
// Send /compact cannot be undone, so it asks first; the Close Tab item says when a session is busy or cannot come back.
check("Send /compact asks first and Close Tab names a busy or non-resumable session", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "b-idle: sonnet", "b-cx: x"].join(" | "),
    tabs: [tab(1, "[b-idle] t", { id: B(1) }), tab(2, "[b-cx] t", { id: B(2) })],
    agents: [agent("b-idle", B(1), "idle", "claude"), agent("b-cx", B(2), "working", "codex")], prs: [],
  }]));
  let before = cmuxCalls().length;
  for (const n of withText((t) => t === "Send /compact")) tap(n);
  must(cmuxCalls().length === before, "the Send /compact title alone typed into the tab");
  tap(withText((t) => t === "Yes, send to b-idle")[0]);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "surface.send_text" && calls[0].params.text === "/compact\n", "compact calls: " + JSON.stringify(calls));
  must(withText((t) => t.startsWith("Yes, close b-idle (")).length === 0 && withText((t) => t === "Yes, close b-idle").length >= 1, "an idle Claude row got a note");
  must(withText((t) => t === "Yes, close b-cx (working, cannot resume)").length === 1, "the Codex row does not say it is busy and cannot resume");
});
check("an account name that is not plain (it could carry shell text) gives no menu item", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "@limits: claude,,,,0,a;rm -rf x;codex,,,,0,$(id);claude,,,,0,ok-1", "b-one: sonnet"].join(" | "),
    tabs: [tab(1, "[b-one] t", { id: B(5), focused: true })], agents: [agent("b-one", B(5), "idle", "claude")], prs: [],
  }]));
  const once = [...new Set(withText((t) => ["a", "ok-1", "$(id)", "x"].includes(t) || t.endsWith("Terminal")).map((n) => n.props.text))];
  must(JSON.stringify(once) === JSON.stringify(["New Terminal", "a", "ok-1"]), "menu items: " + JSON.stringify(once));
});

// Start profiles: "@profiles" gives names only. An account becomes a submenu "normal" + names, and a name reaches the
// shell only as AGENT_PROFILE=<plain name>; agent-run.sh reads the arguments from the user's own file.
check("a start profile nests under the account and starts with AGENT_PROFILE; a name that is not plain gives no item", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "@limits: claude,,,,0;codex,,,,0,team", "@profiles: claude=sandbox,$(id),normal,A b;agy=x;codex=ro", "b-one: sonnet"].join(" | "),
    tabs: [tab(1, "[b-one] t", { id: B(5), focused: true })], agents: [agent("b-one", B(5), "idle", "claude")], prs: [],
  }]));
  const once = [...new Set(withText((t) => ["New Claude", "New Codex", "normal", "sandbox", "ro", "$(id)", "A b", "x"].includes(t)).map((n) => n.props.text))];
  must(JSON.stringify(once) === JSON.stringify(["New Claude", "normal", "sandbox", "New Codex", "ro"]), "menu items: " + JSON.stringify(once));
  const run = (label, i = 0) => { const before = cmuxCalls().length; tap(withText((t) => t === label)[i]); return cmuxCalls().slice(before); };
  const cmd = (inner) => "\"$SHELL\" -lic '" + inner + "; exec \"$SHELL\" -l'";
  let calls = run("sandbox");
  must(calls.length === 1 && calls[0].params.initial_command === cmd('AGENT_PROFILE=sandbox "$HOME/.config/cmux/scripts/agent-run.sh" claude'), "sandbox: " + JSON.stringify(calls));
  calls = run("ro");
  must(calls.length === 1 && calls[0].params.initial_command === cmd('AGENT_PROFILE=ro AGENT_ACCOUNT=team "$HOME/.config/cmux/scripts/agent-run.sh" codex'), "ro: " + JSON.stringify(calls));
  calls = run("normal");
  must(calls.length === 1 && calls[0].params.initial_command === cmd('"$HOME/.config/cmux/scripts/agent-run.sh" claude'), "normal: " + JSON.stringify(calls));
});

// A session that runs with a start profile: "profile sandbox" from the watcher puts a shield before the name.
check("a session with a start profile has a shield before its name; a field that is not plain gives none", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "b-sb: sonnet · profile sandbox", "b-no: sonnet", "b-bad: sonnet · profile $(id)"].join(" | "),
    tabs: [tab(1, "[b-sb] t", { id: B(1) }), tab(2, "[b-no] t", { id: B(2) }), tab(3, "[b-bad] t", { id: B(3) })],
    agents: [agent("b-sb", B(1), "idle", "claude"), agent("b-no", B(2), "idle", "claude"), agent("b-bad", B(3), "idle", "claude")], prs: [],
  }]));
  must(withText((t) => t === "\u26E8 [b-sb]").length >= 1, "no shield on b-sb: " + JSON.stringify(withText((t) => /b-sb/.test(t)).map((n) => n.props.text)));
  must(withText((t) => t === "\u26E8 [b-no]" || t === "\u26E8 [b-bad]").length === 0, "a session without a plain profile got a shield");
});

// What every row of a group shares moves to the band: the account when all rows have it, the model most rows use.
check("a group whose rows share an account and a model names both once on its band, and the rows leave them out", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "g-1: opus · acct team · $1.00", "g-2: opus · acct team · $2.00", "g-3: sonnet · acct team"].join(" | "),
    tabs: [tab(1, "[g-1] t", { id: B(1) }), tab(2, "[g-2] t", { id: B(2) }), tab(3, "[g-3] t", { id: B(3) })],
    agents: [agent("g-1", B(1), "idle", "claude"), agent("g-2", B(2), "idle", "claude"), agent("g-3", B(3), "idle", "claude")], prs: [],
  }]));
  must(withText((t) => t === "team").some((n) => n.props.cornerRadius !== 4), "the band does not name the shared account");
  must(!withText((t) => t === "team").some((n) => n.props.cornerRadius === 4), "a row still has the shared account pill");
  must(withText((t) => t === "opus").length === 1, "the usual model is not named once (on the band)");
  must(rowText("g-3").includes("sonnet"), "a row with another model does not name it");
  ctx.__setData("workspaces", JSON.stringify(workspaces));
});

check("mixed accounts leave the band and return to the rows; a model tie names no model on the band", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "m-1: opus · acct team", "m-2: opus · acct team", "m-3: sonnet · acct solo", "m-4: sonnet · acct team"].join(" | "),
    tabs: [1, 2, 3, 4].map((k) => tab(k, "[m-" + k + "] t", { id: B(k) })),
    agents: [1, 2, 3, 4].map((k) => agent("m-" + k, B(k), "idle", "claude")), prs: [],
  }]));
  // The band names an account in a 10 pt text with no pill shape; the filter chips above use 11 pt.
  must(!withText((t) => t === "team" || t === "solo").some((n) => n.props.font === 10 && n.props.cornerRadius !== 4), "the band names an account that not every row has");
  must(withText((t) => t === "solo").some((n) => n.props.cornerRadius === 4), "m-3 lost its account pill");
  must(withText((t) => t === "opus").length === 2 && withText((t) => t === "sonnet").length === 2, "with a 2 to 2 tie every row must name its own model");
  ctx.__setData("workspaces", JSON.stringify(workspaces));
});

// Workspaces with no session fold into one line at the end; two workspaces in one folder get a number.
check("two or more empty workspaces fold into one line that opens on a click; a repeated group name gets a number", () => {
  const empty = (id, dir) => ({ id, title: "ignored", directory: dir, description: dir, color: "#336699", selected: false, unread: 0, tabs: [], agents: [], prs: [] });
  ctx.__setData("workspaces", JSON.stringify([
    { ...empty("ws-a", "/work/same"), selected: true, description: ["/work/same", "@home: " + HOME, "e-1: opus"].join(" | "),
      tabs: [tab(1, "[e-1] t", { id: B(1) })], agents: [agent("e-1", B(1), "idle", "claude")] },
    empty("ws-b", "/work/same"), empty("ws-c", "/work/other"),
  ]));
  must(withText((t) => t === "2 idle workspaces").length === 1, "the empty workspaces did not fold into one line");
  must(withText((t) => t === "other" || t === "same 2").length === 0, "a folded workspace still shows its own line");
  must(withText((t) => t === "same").length === 1, "the workspace with a session lost its band");
  tap(parentOf(withText((t) => t === "2 idle workspaces")[0].id));
  must(withText((t) => t === "same 2").length === 1 && withText((t) => t === "other").length === 1, "a click did not open the idle workspaces, or the repeated name has no number");
  tap(parentOf(withText((t) => t === "2 idle workspaces")[0].id));
  ctx.__setData("workspaces", JSON.stringify(workspaces));
});

check("the new mark keeps its own width on one line, so a full row cannot squeeze it into one letter a line", () => {
  const marks = withText((t) => t === "new");
  must(marks.length >= 1 && marks.every((n) => n.props.fixedSize === true && n.props.lineLimit === 1), "a new mark can wrap");
});

check("after state words the next step says next itself, and no bare next label stands before the state", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: false, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "n-1: opus · next the lead merges"].join(" | "),
    tabs: [tab(1, "[n-1] t", { id: B(1), hasUnread: true })], agents: [agent("n-1", B(1), "idle", "claude")], prs: [],
  }]));
  must(withText((t) => t === "finished · not seen · next the lead merges").length === 1, "the line is not \"finished · not seen · next the lead merges\": " + rowText("n-1").join(" | "));
  must(withText((t) => t === "next").length === 0, "a bare next label stands before the state words");
  // A seen row has no state words, so the bare label stays at the start of the line.
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: false, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "n-1: opus · next the lead merges"].join(" | "),
    tabs: [tab(1, "[n-1] t", { id: B(1) })], agents: [agent("n-1", B(1), "idle", "claude")], prs: [],
  }]));
  must(withText((t) => t === "next").length === 1 && withText((t) => t === "the lead merges").length === 1, "a seen row lost its bare next label: " + rowText("n-1").join(" | "));
  // Line 2 shows that short next step in full, so the details do not repeat it.
  tap(withText((t) => t === "›")[0]);
  must(withText((t) => t === "the lead merges").length === 1, "the details repeat a next step that line 2 shows in full");
  must(withText((t) => t === "tokens" || t === "folder").length >= 1, "the details did not open");
  ctx.__setData("workspaces", JSON.stringify(workspaces));
});

check("a tool from @tools gets a flat item with a neutral dot and starts by its command word", () => {
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "@limits: claude,,,,0;grok,,,,0", "@tools: gemini=gemini=Gemini CLI;kiro=kiro-cli=Kiro CLI", "b-one: sonnet"].join(" | "),
    tabs: [tab(1, "[b-one] t", { id: B(5), focused: true })], agents: [agent("b-one", B(5), "idle", "claude")], prs: [],
  }]));
  const want = ["New Terminal", "New Claude", "New Grok", "New Gemini CLI", "New Kiro CLI"];
  const once = [...new Set(withText((t) => want.includes(t)).map((n) => n.props.text))];
  must(JSON.stringify(once) === JSON.stringify(want), "menu items: " + JSON.stringify(once));
  const before = cmuxCalls().length;
  tap(withText((t) => t === "New Kiro CLI")[0]);
  const calls = cmuxCalls().slice(before);
  must(calls.length === 1 && calls[0].method === "surface.create" && calls[0].params.initial_command === "\"$SHELL\" -lic 'kiro-cli; exec \"$SHELL\" -l'", "command: " + JSON.stringify(calls));
});
check("a tool in @tools with a command, id or label that is not plain gives no menu item", () => {
  const bad = ["a=$(id)=Aaa", "b=a;b=Bbb", "c=../x=Ccc", "d=x y=Ddd", "e=ok=$(id)", "f=ok=Fff`x`", "claude=ok=Claude2", "G=ok=Ggg", "h=ok=Hhh=extra", "i=1x=Iii", "j=" + "x".repeat(25) + "=Jjj"];
  ctx.__setData("workspaces", JSON.stringify([{
    id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
    description: ["/work/bare", "@home: " + HOME, "@limits: claude,,,,0", "@tools: " + [...bad, "good=good-1=Good One"].join(";"), "b-one: sonnet"].join(" | "),
    tabs: [tab(1, "[b-one] t", { id: B(5), focused: true })], agents: [agent("b-one", B(5), "idle", "claude")], prs: [],
  }]));
  const once = [...new Set(withText((t) => t === "New Claude" || t === "New Good One" || /^(New )?(Aaa|Bbb|Ccc|Ddd|\$\(id\)|Fff.*|Claude2|Ggg|Hhh.*|Iii|Jjj)$/.test(t)).map((n) => n.props.text))];
  must(JSON.stringify(once) === JSON.stringify(["New Claude", "New Good One"]), "menu items: " + JSON.stringify(once));
});

// "Open Config": the files come from "@cfg" (user level) and "@proj" (project) in the descriptions. The command is fixed
// text and a path of plain parts from a fixed table of names; anything else gives no item.
const cfgData = (...parts) => ctx.__setData("workspaces", JSON.stringify([{
  id: "ws-bare", title: "ignored", directory: "/work/bare", color: "#336699", selected: true, unread: 0,
  description: ["/work/bare", "@home: " + HOME, "@limits: claude,,,,0", ...parts, "b-one: sonnet"].join(" | "),
  tabs: [tab(1, "[b-one] t", { id: B(5), focused: true })], agents: [agent("b-one", B(5), "idle", "claude")], prs: [],
}]));
const cfgLabels = () => [...new Set(withText((t) => /^(Claude|Codex|OpenCode|Grok|Gemini CLI|Project) · /.test(t)).map((n) => n.props.text))];
const editorCommand = (rel) => "\"$SHELL\" -lic 'sh -c \"${EDITOR:-vi} \\\"\\$1\\\"\" sh \"$HOME/" + rel + "\"; exec \"$SHELL\" -l'";
check("with no @cfg and no @proj there is no Open config menu", () => {
  cfgData();
  must(withText((t) => t === "Open Config").length === 0, "an Open config menu shows with no file");
});
check("Open config lists the user files by tool and the project files, and opens one in the editor by a fixed command", () => {
  cfgData("@cfg: claude,,.claude,settings.json;claude,work,.claude-work,settings.json;claude,,.claude,CLAUDE.md;codex,,.codex,config.toml;opencode,,.config/opencode,opencode.jsonc",
    "@proj: Projects/app=CLAUDE.md,.claude/settings.json,.mcp.json");
  const want = ["Claude · settings.json", "Claude · work · settings.json", "Claude · CLAUDE.md", "Codex · config.toml", "OpenCode · opencode.jsonc",
    "Project · CLAUDE.md", "Project · .claude/settings.json", "Project · .mcp.json"];
  must(withText((t) => t === "Open Config").length >= 2, "the header menu and the row menu both need an Open config item");
  must(JSON.stringify(cfgLabels()) === JSON.stringify(want), "items: " + JSON.stringify(cfgLabels()));
  for (const [label, rel] of [["Claude · work · settings.json", ".claude-work/settings.json"], ["Project · .claude/settings.json", "Projects/app/.claude/settings.json"]]) {
    const before = cmuxCalls().length;
    tap(withText((t) => t === label)[0]);
    const calls = cmuxCalls().slice(before);
    must(calls.length === 1 && calls[0].method === "surface.create" && calls[0].params.workspace_id === "ws-bare", "got " + JSON.stringify(calls));
    must(calls[0].params.initial_command === editorCommand(rel), "command: " + calls[0].params.initial_command);
  }
});
check("the Colour menu of a group sets or clears the cmux workspace colour of that workspace only", () => {
  cfgData();
  must(withText((t) => t === "Workspace Colour").length === 1, "the group menu needs one Colour item");
  for (const [label, want] of [["Teal", { workspace_id: "ws-bare", action: "set_color", color: "Teal" }], ["No Colour", { workspace_id: "ws-bare", action: "clear_color" }]]) {
    const before = cmuxCalls().length;
    tap(withText((t) => t === label)[0]);
    const calls = cmuxCalls().slice(before);
    must(calls.length === 1 && calls[0].method === "workspace.action" && JSON.stringify(calls[0].params) === JSON.stringify(want), label + " sent " + JSON.stringify(calls));
  }
});
check("a config item with an account, folder, file or project part that is not plain gives no menu item and no command", () => {
  cfgData("@cfg: " + ["claude,wo rk,.claude,settings.json", "claude,a;b,.claude,settings.json", "claude,$(id),.claude,settings.json", "claude,,../etc,settings.json",
    "claude,,.claude,auth.json", "claude,,.claude,settings.json$(id)", "claude,,.cl aude,settings.json", "claude,,.claude,.claude.json", "codex,,.codex/..,config.toml",
    "claude,,.claude-auth,settings.json", "claude,,.claude,config.toml", "claude,,.claude,credentials.json", "claude,,.claude'x,settings.json", "claude,,/etc,settings.json",
    "rm,,.claude,settings.json", "claude,,.claude,settings.json"].join(";"),
    "@proj: Projects/a b=CLAUDE.md", "@proj: ../x=CLAUDE.md");
  must(JSON.stringify(cfgLabels()) === JSON.stringify(["Claude · settings.json"]), "items: " + JSON.stringify(cfgLabels()));
  cfgData("@proj: Projects/app=CLAUDE.md,auth.json,.claude.json,$(id),.mcp.json,x y,;id");
  must(JSON.stringify(cfgLabels()) === JSON.stringify(["Project · CLAUDE.md", "Project · .mcp.json"]), "project items: " + JSON.stringify(cfgLabels()));
  for (const bad of ["@proj: Projects/a b=CLAUDE.md", "@proj: ../x=CLAUDE.md", "@proj: Projects/x'y=CLAUDE.md", "@proj: /etc=CLAUDE.md", "@proj: Projects/auth-kit=CLAUDE.md"]) {
    cfgData(bad);
    must(cfgLabels().length === 0 && withText((t) => t === "Open Config").length === 0, "an item for " + bad);
  }
});

console.log(failed === 0 ? "\nOK: all checks passed (runtime: " + path.basename(path.dirname(runtimePath)) + ")" : "\nFAILED: " + failed + " check(s)");
process.exit(failed === 0 ? 0 : 1);
