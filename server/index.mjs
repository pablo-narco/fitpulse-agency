// FitPulse AI: Boss Command Center server. Node 20+, no dependencies.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT, config, localStamp } from "./config.mjs";
import { db, store } from "./store.mjs";
import { sheets } from "./sheets.mjs";
import { team, employees, employeeById, createTask, retryTask, setContext, startLoops, runSchedule, workerTick, PRIORITIES, STATUSES } from "./agents.mjs";
import { snapshot, buildReport, exportCsv, buildDailyEmail, employeeCards, integrations } from "./reports.mjs";
import { chat, history } from "./pm.mjs";

const PUBLIC = path.join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---- sessions ---------------------------------------------------------------
const SESSION_HOURS = 24 * 7;
const sign = (payload) => crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ u: config.bossUsername, exp: Date.now() + SESSION_HOURS * 3600000 })).toString("base64url");
  return payload + "." + sign(payload);
}
function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function isAuthed(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)fp_session=([^;]+)/);
  if (!m) return false;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); } catch { return false; }
}
const isHttps = (req) => req.headers["x-forwarded-proto"] === "https" || config.publicUrl.startsWith("https://");
function cookie(req, value, maxAge) {
  return "fp_session=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + (isHttps(req) ? "; Secure" : "");
}

// ---- small rate limiter -------------------------------------------------------
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 900000)) buckets.delete(k); }, 600000).unref?.();
const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

// ---- helpers ------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, { "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(data);
}

async function readJson(req) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "Send JSON.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100000) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "Invalid JSON."); }
}

// A browser sends Origin on cross-site POSTs. Reject anything that is not this site.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function cronAllowed(req) {
  const key = req.headers["x-cron-key"];
  const expected = process.env.CRON_SECRET || config.bridgeSecret;
  return Boolean(expected && key && safeEqual(key, expected));
}

function taskListItem(t) {
  const { output, ...rest } = t;
  return { ...rest, hasOutput: Boolean(output) };
}

function serveStatic(req, res, urlPath) {
  const map = { "/": "home.html", "/join": "join.html", "/boss": "index.html" };
  const rel = map[urlPath] || urlPath.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found");
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", ...SECURITY_HEADERS });
  fs.createReadStream(file).pipe(res);
}

// ---- routes --------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const method = req.method;

  if (p === "/healthz") return send(res, 200, { ok: true, time: localStamp() });
  if (!p.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, p);
  }
  if (method !== "GET" && !sameOrigin(req) && !p.startsWith("/api/cron/")) throw new HttpError(403, "Cross-site request refused.");

  // -- public endpoints
  if (p === "/api/login" && method === "POST") {
    if (limited("login:" + clientIp(req), 8, 600000)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
    const body = await readJson(req);
    const ok = safeEqual(body.username || "", config.bossUsername) & safeEqual(body.password || "", config.bossPassword);
    if (!ok) throw new HttpError(401, "Wrong username or password.");
    return send(res, 200, { ok: true }, { "Set-Cookie": cookie(req, makeSession(), SESSION_HOURS * 3600) });
  }
  if (p === "/api/logout" && method === "POST") return send(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "", 0) });
  if (p === "/api/me" && method === "GET") return send(res, 200, { authed: isAuthed(req), agency: team.agency.name, type: team.agency.type });

  if (p === "/api/public/lead" && method === "POST") {
    if (limited("lead:" + clientIp(req), 5, 600000) || limited("lead:all", 60, 3600000)) throw new HttpError(429, "Too many requests. Please try again later.");
    const body = await readJson(req);
    if (body.website) return send(res, 200, { ok: true }); // honeypot field, filled only by bots
    const name = String(body.name || "").trim().slice(0, 80);
    const contact = String(body.contact || "").trim().slice(0, 120);
    if (name.length < 2 || contact.length < 5) throw new HttpError(400, "Please enter your name and a phone number or email.");
    const lead = store.add("leads", {
      name, company: "", contact, source: "Website trial form", sourceUrl: config.publicUrl ? config.publicUrl + "/join" : "", status: "New",
      notes: String(body.goal || "").trim().slice(0, 300), foundBy: "Website form", foundById: "", taskId: "",
    });
    createTask({ title: "Follow up trial request " + lead.id, description: "A visitor asked for a free trial visit through the website form. Prepare a personal follow-up for lead " + lead.id + " (" + name + ").", employeeId: "sales-booking", priority: "High", assignedBy: "Project Manager (website form)" });
    return send(res, 200, { ok: true });
  }

  // -- cron endpoints (called by the Apps Script triggers with the shared secret)
  if (p === "/api/cron/tick") {
    if (!cronAllowed(req)) throw new HttpError(401, "Bad cron key.");
    const created = runSchedule();
    workerTick();
    return send(res, 200, { ok: true, created: created.map((t) => t.id), time: localStamp() });
  }
  if (p === "/api/cron/daily-report") {
    if (!cronAllowed(req)) throw new HttpError(401, "Bad cron key.");
    const mail = buildDailyEmail();
    const pm = employees.find((e) => e.isManager);
    store.add("outputs", { taskId: "", agentId: pm.id, agentName: pm.name + " (" + pm.title + ")", kind: "daily email report", title: mail.subject, details: "Generated for the scheduled daily email." });
    return send(res, 200, { ok: true, subject: mail.subject, html: mail.html });
  }

  // -- everything below needs the Boss session
  if (!isAuthed(req)) throw new HttpError(401, "Please sign in.");

  if (p === "/api/state" && method === "GET") {
    return send(res, 200, {
      now: localStamp(), timezone: config.timezone, agency: team.agency,
      employees: employeeCards(), tasks: db.tasks.map(taskListItem),
      posts: db.posts.slice(-60), leads: db.leads.slice(-60),
      integrations: integrations(), priorities: PRIORITIES, statuses: STATUSES,
    });
  }

  if (p === "/api/tasks" && method === "POST") {
    const body = await readJson(req);
    if (!employeeById(body.employeeId)) throw new HttpError(400, "Choose an employee.");
    if (!String(body.title || "").trim()) throw new HttpError(400, "The task needs a title.");
    const task = createTask({ title: body.title, description: body.description, employeeId: body.employeeId, priority: body.priority, deadline: body.deadline, assignedBy: "Boss" });
    return send(res, 201, { ok: true, task: taskListItem(task) });
  }

  let m;
  if ((m = p.match(/^\/api\/tasks\/(T-\d+)$/)) && method === "GET") {
    const task = store.get("tasks", m[1]);
    if (!task) throw new HttpError(404, "Task not found.");
    return send(res, 200, {
      task,
      leads: db.leads.filter((l) => l.taskId === task.id), posts: db.posts.filter((x) => x.taskId === task.id),
      outputs: db.outputs.filter((o) => o.taskId === task.id), subtasks: db.tasks.filter((t) => t.parentId === task.id).map(taskListItem),
    });
  }
  if ((m = p.match(/^\/api\/tasks\/(T-\d+)\/retry$/)) && method === "POST") {
    const task = store.get("tasks", m[1]);
    if (!task) throw new HttpError(404, "Task not found.");
    try { retryTask(task); } catch (err) { throw new HttpError(400, err.message); }
    return send(res, 200, { ok: true });
  }

  if ((m = p.match(/^\/api\/posts\/(P-\d+)\/publish$/)) && method === "POST") {
    const post = store.get("posts", m[1]);
    if (!post) throw new HttpError(404, "Post not found.");
    const body = await readJson(req);
    let link = "";
    if (body.link) {
      try { const u = new URL(String(body.link)); if (!/^https?:$/.test(u.protocol)) throw 0; link = u.href.slice(0, 500); } catch { throw new HttpError(400, "The link must start with http:// or https://"); }
    }
    post.status = "Published";
    post.publishedAt = new Date().toISOString();
    post.link = link;
    post.approvedBy = "Boss";
    store.touch("posts", post);
    return send(res, 200, { ok: true, post });
  }

  if ((m = p.match(/^\/api\/leads\/(L-\d+)\/status$/)) && method === "POST") {
    const lead = store.get("leads", m[1]);
    if (!lead) throw new HttpError(404, "Lead not found.");
    const body = await readJson(req);
    const allowed = ["New", "Unverified", "Follow-up ready", "Contacted", "Trial booked", "Member", "Lost"];
    if (!allowed.includes(body.status)) throw new HttpError(400, "Unknown status.");
    lead.status = body.status;
    store.touch("leads", lead);
    return send(res, 200, { ok: true, lead });
  }

  if (p === "/api/reports" && method === "GET") {
    return send(res, 200, buildReport(url.searchParams.get("range") === "weekly" ? "weekly" : "daily"));
  }
  if (p === "/api/reports/export.csv" && method === "GET") {
    const range = url.searchParams.get("range") === "weekly" ? "weekly" : "daily";
    const kind = ["summary", "tasks", "leads", "posts"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "summary";
    return send(res, 200, "﻿" + exportCsv(kind, range), { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="fitpulse-' + kind + "-" + range + "-" + localStamp().slice(0, 10) + '.csv"' });
  }
  if (p === "/api/reports/send-email" && method === "POST") {
    if (!sheets.enabled) throw new HttpError(400, "The email bridge is not configured yet (SHEETS_WEBAPP_URL and BRIDGE_SECRET).");
    const mail = buildDailyEmail();
    try { await sheets.sendEmail({ to: config.bossEmail, subject: mail.subject, html: mail.html }); } catch (err) { throw new HttpError(502, err.message); }
    const pm = employees.find((e) => e.isManager);
    store.add("outputs", { taskId: "", agentId: pm.id, agentName: pm.name + " (" + pm.title + ")", kind: "daily email report", title: mail.subject, details: "Sent from the dashboard by the Boss." });
    return send(res, 200, { ok: true, subject: mail.subject });
  }

  if (p === "/api/chat" && method === "GET") {
    const channel = url.searchParams.get("channel") || "pm";
    if (!employeeById(channel)) throw new HttpError(400, "Unknown chat channel.");
    return send(res, 200, { channel, messages: history(channel) });
  }
  if (p === "/api/chat" && method === "POST") {
    if (limited("chat", 30, 60000)) throw new HttpError(429, "Slow down a little.");
    const body = await readJson(req);
    if (!employeeById(body.channel)) throw new HttpError(400, "Unknown chat channel.");
    if (!String(body.message || "").trim()) throw new HttpError(400, "Write a message first.");
    return send(res, 200, await chat(body.channel, body.message));
  }

  throw new HttpError(404, "Not found.");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error("[http]", req.method, req.url, err);
    if (!res.headersSent) send(res, status, { ok: false, error: status >= 500 && !err.status ? "Server error." : err.message });
    else res.end();
  });
});

setContext({ snapshot });
await store.init();
startLoops();
server.listen(config.port, () => {
  console.log("FitPulse AI Command Center is running on port " + config.port + (config.publicUrl ? " (" + config.publicUrl + ")" : ""));
  console.log("Login: " + config.bossUsername + (config.generatedPassword ? " / " + config.generatedPassword + "  (temporary password, set BOSS_PASSWORD to choose your own)" : " / password from BOSS_PASSWORD"));
  const i = integrations();
  console.log("LLM: " + (i.llm.enabled ? i.llm.provider : "not configured") + " | Google Sheet: " + (i.sheets.enabled ? "connected" : "not configured") + " | Telegram: " + (i.telegram.enabled ? "released" : "not released") + " | Autopilot: " + (config.autopilot ? "on" : "off") + " | Timezone: " + config.timezone);
});
