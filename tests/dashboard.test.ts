// Failure modes: the page or an API answer leaks the owner's key; a client reads state unauthenticated; a new task
// silently replaces the rules file, writes an invalid rule, overwrites an existing name, or is accepted with a typo'd
// field; a rejected new task still touches the file; the stream is not forwarded as SSE; the page binds a public address;
// the page's script fails to parse (a top-level await), leaving every section stuck on the skeleton while HTTP tests pass.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext, Script } from "node:vm";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("dashboard");
const PAGE = join(import.meta.dirname, "..", "dashboard", "public", "index.html");
// The fixture is shared with other test files: keep the file this test rewrites inside its own temporary home.
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const { parseRules } = await import("../protocol/rules.ts");
const { RULES_FILE } = await import("../host/home.ts");
const { CONFIG_FILE } = await import("../host/config.ts");
const { serveDashboard } = await import("../dashboard/server.ts");

const OWNER = "owner-dashboard-test-key";
const STATE = { seq: 7, totals: { done: 2 }, lines: [], runs: [], cards: [], agents: [], channels: [], sources: [] };

const RULES = {
  timezone: "Asia/Shanghai",
  sources: {},
  agents: { claude: { name: "Claude Code", worker: "my-mac", use: "claude", access: "edit" } },
  rules: [{ name: "早报", when: { cron: "0 8 * * *" }, to: "claude", cwd: "~/notes", prompt: "写早报" }],
};

let hubPort = 0;
let seenAuthorization = "";
const hub = createServer((req, res) => {
  seenAuthorization = String(req.headers.authorization ?? "");
  if (req.url?.startsWith("/v1/stream")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return void res.end('id: 7\nevent: fact\ndata: {"seq":7}\n\n');
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(STATE));
});

let dashboard: Awaited<ReturnType<typeof serveDashboard>>;
let base = "";

before(async () => {
  writeFileSync(RULES_FILE, `${JSON.stringify(RULES, null, 2)}\n`);
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  hubPort = (hub.address() as { port: number }).port;
  writeFileSync(
    CONFIG_FILE,
    `${JSON.stringify({ url: `http://127.0.0.1:${hubPort}`, owner: OWNER, hub: { listen: "127.0.0.1:3350" } }, null, 2)}\n`,
  );
  dashboard = await serveDashboard({ port: 0 });
  base = dashboard.url;
});

after(async () => {
  await dashboard.close();
  await new Promise<void>((resolve) => hub.close(() => resolve()));
});

const get = (path: string) => fetch(base + path);
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the page opens and never contains the owner's key", async () => {
  const answer = await get("/");
  assert.equal(answer.status, 200);
  assert.match(answer.headers.get("content-type") ?? "", /text\/html/);
  const page = await answer.text();
  assert.ok(!page.includes(OWNER), "密钥进了页面");
  assert.match(page, /新增任务/);
});

test("state is read with the owner's key and the answer leaks none", async () => {
  const answer = await get("/api/state");
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), STATE);
  assert.equal(seenAuthorization, `Bearer ${OWNER}`);
  assert.ok(!JSON.stringify(STATE).includes(OWNER));
});

test("stream is forwarded as SSE", async () => {
  const answer = await get("/api/stream?after=6");
  assert.equal(answer.status, 200);
  assert.match(answer.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(await answer.text(), /event: fact/);
});

test("the raw rules file is available for the form's agent and source pickers", async () => {
  const answer = await get("/api/rules.json");
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), RULES);
});

test("a new task is appended, keeps the old rules, and is valid to the hub", async () => {
  const rule = {
    name: "巡检",
    when: { cron: "0 9 * * *" },
    to: "claude",
    cwd: "~/code",
    prompt: "检查一遍",
    tell: "always",
  };
  const answer = await post("/api/rules", rule);
  assert.equal(answer.status, 200, await answer.text());
  const written = JSON.parse(readFileSync(RULES_FILE, "utf8"));
  assert.equal(written.rules.length, 2);
  assert.deepEqual(written.rules[0], RULES.rules[0]);
  assert.deepEqual(written.rules[1], rule);
  assert.doesNotThrow(() => parseRules(readFileSync(RULES_FILE, "utf8"), Date.now(), "Asia/Shanghai"));
});

test("a rejected new task leaves the rules file byte for byte unchanged", async () => {
  const before = readFileSync(RULES_FILE, "utf8");
  const bad = [
    { name: "早报", when: { cron: "0 9 * * *" }, to: "claude", cwd: "~/code", prompt: "重名" },
    { name: "坏定时", when: { cron: "不是 cron" }, to: "claude", cwd: "~/code", prompt: "x" },
    { name: "没 Agent", when: { cron: "0 9 * * *" }, to: "nobody", cwd: "~/code", prompt: "x" },
    { name: "没目录", when: { cron: "0 9 * * *" }, to: "claude", prompt: "x" },
    { name: "多字段", when: { cron: "0 9 * * *" }, to: "claude", cwd: "~/code", prompt: "x", typo: 1 },
  ];
  for (const rule of bad) {
    const answer = await post("/api/rules", rule);
    assert.equal(answer.status, 400, JSON.stringify(rule));
    assert.equal(readFileSync(RULES_FILE, "utf8"), before, JSON.stringify(rule));
  }
});

test("the page's script parses: a top-level await would leave every section stuck on the skeleton", () => {
  const page = readFileSync(PAGE, "utf8");
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
  assert.ok(script.length > 0, "页面里的脚本没找到");
  assert.doesNotThrow(() => new Script(script), "页面脚本解析失败，整页会停在骨架上");
});

/** Runs the page's script in a minimal DOM. The hub names its SSE frames "fact", so only addEventListener sees them. */
function boot() {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(readFileSync(PAGE, "utf8"))![1];
  const calls: string[] = [];
  const nodes = new Map<string, Record<string, unknown>>();
  const node = (id: string) => {
    let found = nodes.get(id);
    if (!found) {
      found = { innerHTML: "", textContent: "", hidden: false, value: "", showModal() {}, close() {} };
      nodes.set(id, found);
    }
    return found;
  };
  const state = {
    seq: 4,
    totals: { running: 1, queued: 0, attention: 0, doneToday: 3 },
    spending: { today: { tokens: 120, cost: 0.5 }, week: { rounds: 9 } },
    cards: [],
    lines: [],
    runs: [],
    agents: [],
    channels: [],
  };
  const listeners = new Map<string, (() => void)[]>();
  const sandbox = {
    document: { getElementById: node, querySelectorAll: () => [], body: {} },
    window: { alert() {} },
    fetch: async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => state };
    },
    EventSource: class {
      addEventListener(name: string, fn: () => void) {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      }
      close() {}
    },
    setInterval: () => 0,
    setTimeout,
    console,
  };
  runInNewContext(script, sandbox);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const frame = (name: string) => {
    for (const fn of listeners.get(name) ?? []) fn();
  };
  return { calls, node, settle, frame };
}

test("the page boots: its script really reads state and fills the panels", async () => {
  const page = boot();
  await page.settle();
  assert.ok(page.calls.includes("/api/state"), "页面没有读取状态");
  assert.match(String(page.node("stats").innerHTML), /正在跑/, "统计区没渲染，页面停在骨架上");
});

test("a fact frame refreshes the page: onmessage alone never sees the hub's named events", async () => {
  const page = boot();
  await page.settle();
  const before = page.calls.filter((call) => call === "/api/state").length;
  page.frame("fact");
  await page.settle();
  assert.ok(
    page.calls.filter((call) => call === "/api/state").length > before,
    "中台发来 event: fact，页面没有刷新（只写 onmessage 是不够的）",
  );
});

test("the dashboard binds loopback only", () => {
  assert.ok(["127.0.0.1", "::1", "localhost"].includes(dashboard.host), dashboard.host);
});
