// A client of the hub, like `status --json`: it reads /v1/state, forwards /v1/stream, and writes rules.json for the
// owner. The owner's key stays on this machine; the browser only ever reaches this server on loopback. Nothing here
// decides what the hub does, so it is no part of the kernel.
import { createServer } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { readConfig, type Config } from "../host/config.ts";
import { RULES_FILE } from "../host/home.ts";
import { hubClient, HubError } from "../protocol/client.ts";
import { parseRules, RulesError } from "../protocol/rules.ts";

const PAGE = join(import.meta.dirname, "public", "index.html");
const DEFAULT_PORT = 3351;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only the page this server served may borrow the owner's key: another site, or a DNS rebound name, must not. */
function denied(request: Request): Response | null {
  const host = request.headers.get("host");
  if (!host || /[/\\?#@\s]/.test(host)) return json({ error: "只能从本机回环地址打开这个页面" }, 403);
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return json({ error: "只能从本机回环地址打开这个页面" }, 403);
  }
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!loopback) return json({ error: "只能从本机回环地址打开这个页面" }, 403);
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let same = false;
    try {
      same = new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {}
    if (!same) return json({ error: "别的网站不能借本人的密钥操作" }, 403);
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return json({ error: "别的网站不能借本人的密钥操作" }, 403);
  }
  return null;
}

/** The whole file is checked before it is written: a rejected task must leave the old rules running. */
function addRule(given: unknown): Response {
  if (!isObject(given)) return json({ error: "新任务要是一个 JSON 对象" }, 400);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(RULES_FILE, "utf8"));
  } catch (error) {
    return json({ error: `读不到规则文件：${(error as Error).message}` }, 500);
  }
  if (!Array.isArray(raw.rules)) return json({ error: "rules.json 里没有 rules 列表" }, 400);
  const next = { ...raw, rules: [...raw.rules, given] };
  const zone = typeof raw.timezone === "string" ? raw.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    // A string copy: parseRules fills in defaults on its own copy, none of which belong in the file we write.
    parseRules(JSON.stringify(next), Date.now(), zone);
  } catch (error) {
    if (error instanceof RulesError) return json({ error: error.issues.join("；") }, 400);
    throw error;
  }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  writeFileSync(`${RULES_FILE}.tmp`, text, { mode: 0o600 });
  renameSync(`${RULES_FILE}.tmp`, RULES_FILE);
  return json({ ok: true, rule: given });
}

/** An SSE stream stays open: abort the upstream as soon as the browser goes away. */
async function streamOf(request: Request, config: Config, after: string): Promise<Response> {
  if (!/^\d+$/.test(after)) return json({ error: "日志序号不正确" }, 400);
  const stopped = new AbortController();
  request.signal.addEventListener("abort", () => stopped.abort(), { once: true });
  const upstream = await fetch(`${config.url.replace(/\/$/, "")}/v1/stream?after=${after}`, {
    headers: { authorization: `Bearer ${config.owner}` },
    signal: stopped.signal,
  });
  if (!upstream.ok || !upstream.body) {
    const message = upstream.status === 401 ? "本人的密钥不对" : `中台返回 ${upstream.status}`;
    return json({ error: message }, upstream.status);
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

async function handle(request: Request): Promise<Response> {
  const refused = denied(request);
  if (refused) return refused;
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(readFileSync(PAGE, "utf8"), { headers: PAGE_HEADERS });
  }
  let config: Config;
  try {
    config = readConfig();
  } catch (error) {
    return json({ error: (error as Error).message }, 500);
  }
  if (!config.owner) return json({ error: "这台电脑上没有本人的密钥，看不了全局" }, 403);
  const hub = hubClient(config.url, config.owner);
  try {
    if (request.method === "GET" && path === "/api/rules.json") {
      // The form only picks an agent id and a source id; it has no use for command lines, program paths or keys.
      const raw = JSON.parse(readFileSync(RULES_FILE, "utf8"));
      const agents = Object.fromEntries(
        Object.entries(raw.agents ?? {}).map(([id, agent]) => [
          id,
          { name: (agent as { name?: string }).name ?? id, use: (agent as { use?: string }).use },
        ]),
      );
      const sources = Object.fromEntries(
        Object.entries(raw.sources ?? {}).map(([id, source]) => [
          id,
          { name: (source as { name?: string }).name ?? id },
        ]),
      );
      return json({ ...raw, agents, sources });
    }
    if (request.method === "GET" && path === "/api/state") {
      const before = url.searchParams.get("before");
      return json(await hub.state(before === null ? undefined : Number(before)));
    }
    if (request.method === "GET" && path === "/api/stream") {
      return await streamOf(request, config, url.searchParams.get("after") ?? "0");
    }
    if (request.method === "POST" && path === "/api/rules") return addRule(await request.json());
    const rule = /^\/api\/rules\/([^/]+)\/(pause|resume|run)$/.exec(path);
    if (request.method === "POST" && rule) {
      const name = decodeURIComponent(rule[1]);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (rule[2] === "pause") return json(await hub.pause(name, body as { reason?: string; until?: string }));
      if (rule[2] === "resume") return json(await hub.resume(name));
      return json(await hub.run(name, body as { subject?: string; reason?: string }));
    }
    const card = /^\/api\/cards\/([1-9][0-9]*)\/(answer|resolve)$/.exec(path);
    if (request.method === "POST" && card) {
      const body = (await request.json()) as Record<string, unknown>;
      if (card[2] === "answer") return json(await hub.answer(Number(card[1]), body));
      return json(await hub.resolve(Number(card[1]), String(body.reason ?? "")));
    }
    const run = /^\/api\/runs\/([1-9][0-9]*)\/(cancel|why)$/.exec(path);
    if (request.method === "POST" && run && run[2] === "cancel") return json(await hub.cancel(Number(run[1])));
    if (request.method === "GET" && run && run[2] === "why") return json(await hub.why(Number(run[1])));
    return json({ error: "没有这个地址" }, 404);
  } catch (error) {
    if (error instanceof HubError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return json({ error: "不是 JSON" }, 400);
    return json({ error: "页面这边出错了" }, 500);
  }
}

function toNode(res: import("node:http").ServerResponse, answer: Response) {
  res.writeHead(answer.status, Object.fromEntries(answer.headers));
  if (!answer.body) return void res.end();
  Readable.fromWeb(answer.body as never)
    .on("error", () => res.destroy())
    .pipe(res);
}

export type Dashboard = { port: number; host: string; url: string; close(): Promise<void> };

/** An independent client with its own port: starting or stopping it never takes the hub down with it. */
export async function serveDashboard({ port = DEFAULT_PORT, host = "127.0.0.1" } = {}): Promise<Dashboard> {
  const server = createServer((req, res) => {
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const body = !["GET", "HEAD"].includes(req.method!) && {
      body: Readable.toWeb(req) as ReadableStream,
      duplex: "half",
    };
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as HeadersInit,
      signal: gone.signal,
      ...body,
    });
    handle(request)
      .then((answer) => toNode(res, answer))
      .catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actual = (server.address() as { port: number }).port;
  return {
    port: actual,
    host,
    url: `http://${host}:${actual}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** `agent-autoloop ui`: the same client on its own, for when `up` is not running it. */
export async function dashboardCommand(args: string[]): Promise<void> {
  const given = args[args.indexOf("--port") + 1];
  const port = given === undefined ? DEFAULT_PORT : Number(given);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口要写成 0 到 65535 的数字");
  const dashboard = await serveDashboard({ port });
  console.log(`页面在 ${dashboard.url}（按 Ctrl+C 结束）`);
}
