// Failure modes: the page or an API answer leaks the owner's key; a client reads state unauthenticated; a new task
// silently replaces the rules file, writes an invalid rule, overwrites an existing name, or is accepted with a typo'd
// field; a rejected new task still touches the file; the stream is not forwarded as SSE; the page binds a public address;
// the page's script fails to parse (a top-level await), leaving every section stuck on the skeleton while HTTP tests pass.
// A page on another site borrows the owner's key to write rules.json or read the whole state; a forged Host (DNS
// rebinding) reaches any route; a same-origin request is refused by mistake; words from the hub become markup.
// A forwarded hub call (pause, answer, cancel, why) drops or rewrites the owner's body, or the raw rules picker leaks
// command lines, program paths and worker assignments the form never uses.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
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

/** fetch cannot override Host; a raw HTTP request can, which is what a DNS-rebound page sends. */
const raw = (path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: dashboard.port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

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

test("the rules picker for the form carries agents and sources, not the whole file", async () => {
  const answer = await get("/api/rules.json");
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.deepEqual(Object.keys(body.agents.claude), ["name", "use"]);
  assert.equal(body.agents.claude.name, "Claude Code");
  assert.deepEqual(Object.keys(body.sources), []);
  assert.deepEqual(body.rules, RULES.rules);
  assert.equal(body.timezone, RULES.timezone);
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
function boot(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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

test("a cross-site write cannot borrow the owner's key: refused and rules.json untouched", async () => {
  const before = readFileSync(RULES_FILE, "utf8");
  const answer = await fetch(base + "/api/rules", {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({
      name: "跨站植入",
      when: { cron: "* * * * *" },
      to: "claude",
      cwd: "~/code",
      prompt: "干坏事",
    }),
  });
  assert.equal(answer.status, 403);
  assert.equal(readFileSync(RULES_FILE, "utf8"), before, "跨站请求改了规则文件");
});

test("a forged Host (DNS rebinding) reaches none of the routes", async () => {
  for (const path of ["/", "/api/state", "/api/rules.json", "/api/stream?after=0"]) {
    const answer = await raw(path, { host: "evil.example", origin: "http://evil.example" });
    assert.equal(answer.status, 403, `${path} 被别的域名读到了`);
  }
});

test("words the hub sends are escaped, not markup", async () => {
  const page = boot({
    cards: [
      {
        id: 3,
        title: "<img src=x onerror=alert(1)>",
        text: "<script>alert(1)</script>",
        options: ["<b>好</b>"],
      },
    ],
    lines: [
      {
        name: "<svg onload=alert(1)>",
        agent: "<i>claude</i>",
        every: "每天",
        source: "s",
        types: [],
        next: "",
        paused: null,
      },
    ],
    runs: [{ id: 4, rule: "<u>早报</u>", state: "done", error: "", summary: "<b>完成</b>", finishedAt: "" }],
  });
  await page.settle();
  const cards = String(page.node("cards").innerHTML);
  assert.ok(!/<img|<script/i.test(cards), "卡片里的字变成了标记");
  assert.match(cards, /&lt;img/);
  const rules = String(page.node("rules").innerHTML);
  assert.ok(!/<svg|<i>/i.test(rules), "规则名变成了标记");
  assert.match(rules, /&lt;svg/);
  const runs = String(page.node("runs").innerHTML);
  assert.ok(!/<u>|<b>完成/i.test(runs), "轮次里的字变成了标记");
  assert.match(runs, /&lt;u&gt;/);
});

test("the page's own same-origin requests still work", async () => {
  const answer = await fetch(base + "/api/rules", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      name: "同源新增",
      when: { cron: "0 11 * * *" },
      to: "claude",
      cwd: "~/notes",
      prompt: "写点东西",
    }),
  });
  assert.equal(answer.status, 200, await answer.text());
});

test("an empty prompt is left out: command agents may run without one, but '' is rejected", async () => {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(readFileSync(PAGE, "utf8"))![1];
  assert.match(script, /\.\.\.\(f\.prompt\.value\.trim\(\) && \{ prompt: f\.prompt\.value\.trim\(\) \}\)/);
  const before = readFileSync(RULES_FILE, "utf8");
  const answer = await post("/api/rules", {
    name: "空提示词",
    when: { cron: "0 12 * * *" },
    to: "claude",
    cwd: "~/notes",
    prompt: "",
  });
  assert.equal(answer.status, 400);
  assert.equal(readFileSync(RULES_FILE, "utf8"), before);
});

test("rule control is forwarded to the hub unchanged", async () => {
  const seen: { method: string; path: string; body: string }[] = [];
  hub.removeAllListeners();
  hub.on("request", (req, res) => {
    seen.push({ method: req.method!, path: req.url!, body: "" });
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      seen[seen.length - 1].body = body;
      if (req.url?.startsWith("/v1/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.end();
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  const pause = await post(`/api/rules/${encodeURIComponent("早报")}/pause`, { reason: "歇一下", until: "2099-01-01" });
  assert.equal(pause.status, 200);
  const resume = await post(`/api/rules/${encodeURIComponent("早报")}/resume`, {});
  assert.equal(resume.status, 200);
  const run = await post(`/api/rules/${encodeURIComponent("早报")}/run`, { subject: "今天的" });
  assert.equal(run.status, 200);
  const forwarded = seen.filter((call) => call.path.includes("/v1/rules/"));
  assert.equal(forwarded.length, 3, "暂停/恢复/运行没有全部转发到中台");
  assert.deepEqual(
    forwarded.map((call) => JSON.parse(call.body || "{}")),
    [{ reason: "歇一下", until: "2099-01-01" }, {}, { subject: "今天的" }],
    "转发时改写了本人的请求体",
  );
});

test("card answer and resolve reach the hub", async () => {
  const seen: { path: string; body: string }[] = [];
  hub.removeAllListeners();
  hub.on("request", (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      seen.push({ path: req.url!, body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ changed: true }));
    });
  });
  const answer = await post("/api/cards/5/answer", { choice: 1 });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { changed: true });
  const resolve = await post("/api/cards/5/resolve", { reason: "已处理" });
  assert.equal(resolve.status, 200);
  assert.deepEqual(
    seen.map((call) => call.path),
    ["/v1/cards/5/answer", "/v1/cards/5/resolve"],
  );
});

test("run cancel and why are forwarded", async () => {
  hub.removeAllListeners();
  hub.on("request", (req, res) => {
    if (req.url?.startsWith("/v1/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return void res.end();
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ type: "started", args: {} }]));
  });
  const cancel = await post("/api/runs/9/cancel", {});
  assert.equal(cancel.status, 200);
  const why = await get("/api/runs/9/why");
  assert.equal(why.status, 200);
  const facts = await why.json();
  assert.ok(Array.isArray(facts) && facts.length === 1, "why 的结果没转发");
});

test("the rules picker for the form carries only id and name, not command lines or program paths", async () => {
  writeFileSync(
    RULES_FILE,
    `${JSON.stringify(
      {
        ...RULES,
        agents: {
          claude: {
            name: "Claude Code",
            worker: "my-mac",
            use: "claude",
            access: "edit",
            command: ["claude", "--dangerous", "{prompt}"],
            program: "/usr/local/bin/secret",
          },
        },
        sources: { app: { name: "应用", key: "source-secret-key" } },
      },
      null,
      2,
    )}\n`,
  );
  const answer = await get("/api/rules.json");
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.agents.claude.command, undefined, "命令行进浏览器了");
  assert.equal(body.agents.claude.program, undefined, "程序路径进浏览器了");
  assert.equal(body.sources.app.key, undefined, "来源密钥进浏览器了");
  assert.equal(body.agents.claude.name, "Claude Code");
  assert.equal(body.sources.app.name, "应用");
});
