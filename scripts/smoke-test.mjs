#!/usr/bin/env node
/*
 * End-to-end smoke test. Starts the server twice against local stand-ins:
 *   - a fake Apps Script bridge (keeps the "sheet" in memory),
 *   - a fake OpenAI-compatible LLM that answers with fixed JSON.
 * No real keys, no network. Run: npm test
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name, ok, detail = "") {
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (ok || !detail ? "" : "  -> " + detail));
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const body = async (req) => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString() || "{}"); };

// ---- fake bridge ---------------------------------------------------------------
const sheet = {}; // tab -> rows (first row = headers)
const emails = [];
const bridge = http.createServer(async (req, res) => {
  const b = await body(req);
  const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (b.secret !== "test-secret") return reply({ ok: false, error: "unauthorized" });
  if (b.action === "upsert") {
    for (const op of b.ops) {
      const rows = (sheet[op.tab] = sheet[op.tab] || [op.headers]);
      const i = rows.findIndex((r, n) => n > 0 && r[0] === op.row[0]);
      if (i > 0) rows[i] = op.row; else rows.push(op.row);
    }
    return reply({ ok: true });
  }
  if (b.action === "read") return reply({ ok: true, tabs: Object.fromEntries(b.tabs.map((t) => [t, sheet[t] || []])) });
  if (b.action === "email") { emails.push(b); return reply({ ok: true }); }
  reply({ ok: false, error: "unknown action" });
});

// ---- fake LLM --------------------------------------------------------------------
const fakeLlm = http.createServer(async (req, res) => {
  const b = await body(req);
  const system = b.messages[0].content, user = b.messages[b.messages.length - 1].content;
  let out;
  if (system.includes("Content Creator") && system.includes('"posts"')) out = { summary: "Two drafts ready.", posts: [{ platform: "Instagram", title: "Morning mobility", body: "Five minutes of mobility before work.", hashtags: ["#fitness"] }, { platform: "Telegram", title: "Free trial", body: "Book your free trial visit this week." }] };
  else if (system.includes("Sales and Booking Agent") && system.includes('"followups"')) {
    const id = (user.match(/"leadId": "(L-\d+)"/) || [])[1] || "";
    out = { summary: "Follow-up prepared.", followups: [{ leadId: id, channel: "email", title: "Trial invite", message: "Hi! Your free trial visit is waiting for you." }] };
  } else if (system.includes("talking with the Boss")) {
    if (/assign a new task/i.test(user)) out = { reply: "Done.", actions: [{ type: "create_task", employee: "content-creator", title: "Write 3 LinkedIn posts about our new service", description: "Write 3 LinkedIn posts about our new service.", priority: "Medium", deadline: "2030-01-01" }] };
    else { const data = JSON.parse(user.slice(user.indexOf("{"))); out = { reply: "Running: " + data.taskCounts["In Progress"] + ". Published today: " + data.postsPublishedToday.length + ".", actions: [] }; }
  } else out = { summary: "Done.", insights: [{ title: "Note", detail: "All good." }], messages: [{ title: "Check-in", audience: "inactive members", message: "We miss you." }], replies: [{ title: "Reply", platform: "Google Maps", message: "Thank you." }], subtasks: [] };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(out) + "\n```" } }] }));
});

// ---- helpers ------------------------------------------------------------------------
function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  return { child, log: () => log };
}
function client(port) {
  let cookie = "";
  return async function call(method, p, data, headers = {}) {
    const res = await fetch("http://127.0.0.1:" + port + p, { method, headers: { ...(data ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* csv or html */ }
    return { status: res.status, json, text };
  };
}
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); }
  return null;
}
async function freePort() { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; }

// ---- run ------------------------------------------------------------------------------
const bridgePort = await listen(bridge);
const llmPort = await listen(fakeLlm);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fitpulse-test-"));
const baseEnv = { BOSS_USERNAME: "boss", BOSS_PASSWORD: "test-pass", SESSION_SECRET: "s", TIMEZONE: "UTC", AUTOPILOT: "false", SHEETS_WEBAPP_URL: "http://127.0.0.1:" + bridgePort, BRIDGE_SECRET: "test-secret" };

console.log("Run 1: with the fake LLM and the fake Google Sheet bridge");
let port = await freePort();
let srv = startServer({ ...baseEnv, PORT: String(port), DATA_DIR: path.join(tmp, "a"), LLM_PROVIDER: "openai", OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:" + llmPort, LLM_MODEL: "fake" });
let call = client(port);
check("server starts", await waitFor(async () => { try { return (await call("GET", "/healthz")).status === 200; } catch { return false; } }), srv.log());
check("state needs login", (await call("GET", "/api/state")).status === 401);
check("wrong password refused", (await call("POST", "/api/login", { username: "boss", password: "nope" })).status === 401);
check("login works", (await call("POST", "/api/login", { username: "boss", password: "test-pass" })).status === 200);
check("cross-site POST refused", (await call("POST", "/api/tasks", { title: "x", employeeId: "pm" }, { Origin: "https://evil.example" })).status === 403);
const st = (await call("GET", "/api/state")).json;
check("8 employees (1 manager + 7)", st.employees.length === 8 && st.employees.filter((e) => e.isManager).length === 1);

const t1 = (await call("POST", "/api/tasks", { title: "Two posts", description: "Write 2 posts", employeeId: "content-creator", priority: "High", deadline: "2030-01-01" })).json.task;
check("task created as Queued", t1 && t1.status === "Queued" && t1.id === "T-0001");
const done1 = await waitFor(async () => { const d = (await call("GET", "/api/tasks/" + t1.id)).json; return d.task.status === "Completed" ? d : null; });
check("content task completes with 2 draft posts", done1 && done1.posts.length === 2 && done1.task.output.includes("Morning mobility"), done1 ? JSON.stringify(done1.task) : srv.log());

const t2 = (await call("POST", "/api/tasks", { title: "Publish", employeeId: "social-publisher" })).json.task;
const done2 = await waitFor(async () => { const d = (await call("GET", "/api/tasks/" + t2.id)).json; return d.task.status === "Completed" ? d : null; });
check("publisher sends posts for approval (no released channel)", done2 && /2 waiting for approval/.test(done2.task.output), done2 && done2.task.output);
check("Boss approval marks a post published", (await call("POST", "/api/posts/P-0001/publish", { link: "https://example.com/p/1" })).json.post.status === "Published");
check("bad link refused", (await call("POST", "/api/posts/P-0002/publish", { link: "javascript:alert(1)" })).status === 400);

check("public form creates a lead", (await call("POST", "/api/public/lead", { name: "Test Person", contact: "test@example.com", goal: "=HYPERLINK(1)" })).status === 200);
const follow = await waitFor(async () => { const s = (await call("GET", "/api/state")).json; return s.tasks.find((t) => t.employeeId === "sales-booking" && t.status === "Completed") ? s : null; });
check("sales follow-up task runs and updates the lead", follow && follow.leads[0].status === "Follow-up ready", follow ? JSON.stringify(follow.leads) : "");

const chat1 = (await call("POST", "/api/chat", { channel: "pm", message: "How many posts were published today?" })).json;
check("PM chat answers from live data", chat1 && /Published today: 1/.test(chat1.messages[1].text), JSON.stringify(chat1));
const chat2 = (await call("POST", "/api/chat", { channel: "pm", message: "Assign a new task to the Content Writer: write 3 LinkedIn posts about our new service, due tomorrow." })).json;
check("PM chat creates a task", chat2 && chat2.created.length === 1 && /Created T-\d+/.test(chat2.messages[1].text), JSON.stringify(chat2));
check("the task created in chat gets done", await waitFor(async () => (await call("GET", "/api/state")).json.tasks.every((t) => t.status === "Completed")));
check("chat history is saved", (await call("GET", "/api/chat?channel=pm")).json.messages.length === 4);

const rep = (await call("GET", "/api/reports?range=daily")).json;
check("daily report counts", rep.summary.postsCreated === 4 && rep.summary.postsPublished === 1 && rep.summary.leadsGenerated === 1 && rep.perEmployee.length === 8, JSON.stringify(rep.summary));
const csvRes = await call("GET", "/api/reports/export.csv?kind=leads&range=daily");
check("CSV export, formula text neutralised", csvRes.status === 200 && csvRes.text.includes("Test Person") && !/,=HYPERLINK/.test(csvRes.text));
check("cron needs the key", (await call("GET", "/api/cron/daily-report")).status === 401);
const cron = await call("GET", "/api/cron/daily-report", null, { "x-cron-key": "test-secret" });
check("daily email is built from the ledger", cron.status === 200 && cron.json.html.includes("KPIs by employee") && /daily status/.test(cron.json.subject));
check("send email now goes through the bridge", (await call("POST", "/api/reports/send-email", {})).status === 200 && emails.length === 1);

await sleep(2500); // let the sheet sync flush
const required = ["Task ID", "Timestamp", "Assigned By", "Agent Name", "Task Description", "Priority", "Status", "Output / Result Link", "Completion Time"];
check("ledger tab has the 9 required columns", sheet.Ledger && required.every((h, i) => sheet.Ledger[0][i] === h), JSON.stringify(sheet.Ledger && sheet.Ledger[0]));
const tasksNow = (await call("GET", "/api/state")).json.tasks.length;
check("every task is in the ledger", sheet.Ledger.length - 1 === tasksNow, (sheet.Ledger.length - 1) + " rows vs " + tasksNow + " tasks");
check("leads, posts and chat tabs are written", sheet.Leads.length === 2 && sheet.Posts.length === 5 && sheet.Chat.length === 5, [sheet.Leads.length, sheet.Posts.length, sheet.Chat.length].join("/"));
check("formula text is stored as plain text in the sheet", sheet.Leads[1].some((c) => c === "'=HYPERLINK(1)"));
srv.child.kill();
await sleep(500);

console.log("Run 2: restart with an empty disk and no LLM key");
port = await freePort();
srv = startServer({ ...baseEnv, PORT: String(port), DATA_DIR: path.join(tmp, "b") });
call = client(port);
check("server restarts", await waitFor(async () => { try { return (await call("GET", "/healthz")).status === 200; } catch { return false; } }), srv.log());
await call("POST", "/api/login", { username: "boss", password: "test-pass" });
const st2 = (await call("GET", "/api/state")).json;
check("data is restored from the Google Sheet", st2.tasks.length === tasksNow && st2.posts.length === 4 && st2.leads.length === 1, st2.tasks.length + " tasks");
const t3 = (await call("POST", "/api/tasks", { title: "Win-back", employeeId: "retention" })).json.task;
check("task ids continue after the restart", t3.id === "T-" + String(tasksNow + 1).padStart(4, "0"), t3.id);
const blocked = await waitFor(async () => { const d = (await call("GET", "/api/tasks/" + t3.id)).json; return d.task.status === "Blocked" ? d.task : null; });
check("without an LLM key a task is Blocked with the reason", blocked && /No LLM API key/.test(blocked.blockedReason));
const ask = async (q) => (await call("POST", "/api/chat", { channel: "pm", message: q })).json.messages[1].text;
check("Q: running tasks", /Tasks running now: 0/.test(await ask("How many projects/tasks are currently running?")));
const q2 = await ask("What is the status of the sales team? How many leads were generated today? Give me the details.");
check("Q: sales team and leads", /Leads generated today: 1/.test(q2) && /Test Person/.test(q2), q2);
const q3 = await ask("How many posts were published today, and on which platforms?");
check("Q: posts and platforms", /Posts published today: 1 \(Instagram: 1\)/.test(q3), q3);
const q4 = await ask("Which tasks are blocked, and why?");
check("Q: blocked and why", /Blocked tasks \(1\)/.test(q4) && /No LLM API key/.test(q4), q4);
const q5 = await ask("Which employee completed the most tasks this week?");
check("Q: top employee this week", /completed the most tasks this week: \d/.test(q5), q5);
const q6 = await ask("Assign a new task to the Content Writer: write 3 LinkedIn posts about our new service, due tomorrow.");
check("Q: assign through chat", /Created T-\d+ for Carter \(Content Creator\)/.test(q6) && /due \d{4}-\d{2}-\d{2}/.test(q6), q6);
check("employee chat answers about its own work", /Blocked: 1/.test((await call("POST", "/api/chat", { channel: "retention", message: "What are you working on?" })).json.messages[1].text));
check("retry puts a blocked task back in the queue", (await call("POST", "/api/tasks/" + t3.id + "/retry", {})).status === 200);
srv.child.kill();

bridge.close(); fakeLlm.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "\n" + failed + " check(s) failed" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
