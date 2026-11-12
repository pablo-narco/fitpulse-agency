// The 7+1 team: task creation, the worker that lets each employee do its tasks, and the daily schedule.
import fs from "node:fs";
import path from "node:path";
import { ROOT, config, localDate, localTime, localDow } from "./config.mjs";
import { db, store } from "./store.mjs";
import { complete, extractJson, llm } from "./llm.mjs";

export const team = JSON.parse(fs.readFileSync(path.join(ROOT, "agency", "team.json"), "utf8"));
export const employees = team.employees;
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"];
export const STATUSES = ["Queued", "In Progress", "Blocked", "Completed"];

// Kit receipts written by the official ai-employees installer (see scripts/hire-team.mjs).
export function installedManifest() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "agency", ".installed.json"), "utf8")); } catch { return null; }
}

export function employeeById(id) { return employees.find((e) => e.id === id) || null; }

const ALIASES = {
  pm: ["pm", "project manager", "manager", "chief of staff", "maya"],
  "lead-researcher": ["lead researcher", "researcher", "lead research", "leads", "leo"],
  "sales-booking": ["sales", "booking", "outbound", "sofia"],
  "content-creator": ["content creator", "content writer", "writer", "content", "copywriter", "carter"],
  "social-publisher": ["publisher", "social media", "social", "smm", "piper"],
  retention: ["retention", "win-back", "winback", "riley"],
  reputation: ["reputation", "review", "reviews", "remy"],
  analyst: ["analyst", "performance", "analytics", "avery"],
};
// Finds an employee from free text such as "Content Writer" or "sales team".
export function resolveEmployee(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();
  const exact = employees.find((e) => e.id === t || e.name.toLowerCase() === t || e.title.toLowerCase() === t);
  if (exact) return exact;
  let best = null, bestLen = 0;
  for (const [id, words] of Object.entries(ALIASES)) {
    for (const w of words) if (t.includes(w) && w.length > bestLen) { best = id; bestLen = w.length; }
  }
  return best ? employeeById(best) : null;
}

const clean = (v, max) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);

export function createTask({ title, description, employeeId, priority, deadline, assignedBy = "Boss", parentId = null, routineKey = null }) {
  const emp = employeeById(employeeId);
  if (!emp) throw new Error("Unknown employee: " + employeeId);
  title = clean(title, 160);
  description = clean(description, 4000);
  if (!title && !description) throw new Error("A task needs a title or a description.");
  if (!title) title = description.split(/[.\n]/)[0].slice(0, 80);
  const pr = PRIORITIES.find((p) => p.toLowerCase() === String(priority || "").toLowerCase()) || "Medium";
  const dl = /^\d{4}-\d{2}-\d{2}$/.test(String(deadline || "")) ? deadline : "";
  const task = store.add("tasks", {
    title, description, employeeId: emp.id, agentName: emp.name + " (" + emp.title + ")",
    priority: pr, deadline: dl, assignedBy: clean(assignedBy, 60) || "Boss",
    status: "Queued", startedAt: null, completedAt: null, durationMin: null,
    output: "", outputCount: 0, blockedReason: "", parentId, routineKey,
  });
  setImmediate(workerTick);
  return task;
}

// ---- what each employee produces ------------------------------------------
function addOutput(task, emp, kind, title, details) {
  return store.add("outputs", { taskId: task.id, agentId: emp.id, agentName: emp.name + " (" + emp.title + ")", kind, title: clean(title, 200), details: clean(details, 6000) });
}

function basePrompt(emp, schema, extraRules = "") {
  const client = [config.clientName, config.clientCity && "located in " + config.clientCity, config.clientInfo].filter(Boolean).join(", ");
  return [
    "You are " + emp.name + ", the " + emp.title + " at " + team.agency.name + ", a " + team.agency.type + ".",
    "The agency works for: " + client + ".",
    "Your responsibilities: " + emp.responsibilities.join("; ") + ".",
    "Today is " + localDate() + ".",
    "",
    "Rules:",
    "- Do exactly the task you are given. Write in English unless the task asks for another language.",
    "- Use only facts from the task, the data given to you, or web search results. Never invent people, companies, phone numbers, emails, prices, statistics or links.",
    "- If something essential for the task is missing, do not guess: answer with {\"blocked\": \"<what exactly is missing>\"}.",
    extraRules,
    "",
    "Answer with ONE JSON object and nothing else, in this shape:",
    schema,
  ].filter((l) => l !== "").join("\n");
}

function taskMessage(task, data) {
  return "TASK " + task.id + " (priority " + task.priority + (task.deadline ? ", deadline " + task.deadline : "") + ")\n" +
    "Title: " + task.title + "\nDescription: " + (task.description || task.title) +
    (data ? "\n\nDATA:\n" + JSON.stringify(data, null, 1) : "");
}

async function ask(emp, schema, task, { data = null, search = false, rules = "" } = {}) {
  const res = await complete({ system: basePrompt(emp, schema, rules), messages: [{ role: "user", content: taskMessage(task, data) }], maxTokens: 3000, search });
  const json = extractJson(res.text);
  if (!json) throw new Error("The model did not return valid JSON.");
  return { json, res };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const validUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "http:" || x.protocol === "https:" ? x.href : ""; } catch { return ""; } };

const EXECUTORS = {
  // Lead Researcher: named leads only when they come from real web search results.
  async lead(task, emp) {
    const schema = '{"summary": "2-3 sentences", "leads": [{"name": "organisation or contact name", "company": "company", "contact": "public phone, email or website, or empty", "source": "where it was found", "sourceUrl": "https://...", "notes": "why it is a good prospect"}], "segments": [{"title": "type of prospect to target", "detail": "why and how to approach"}]}';
    const rules = "- Put an entry in \"leads\" only if you found it with web search and can give the page URL in sourceUrl. If you cannot search the web, leave \"leads\" empty and fill \"segments\" instead.";
    const { json, res } = await ask(emp, schema, task, { search: true, rules });
    if (json.blocked) return { blocked: String(json.blocked) };
    const lines = [];
    let count = 0;
    const found = res.searched ? arr(json.leads).slice(0, 15) : [];
    for (const l of found) {
      const url = validUrl(l.sourceUrl);
      if (!clean(l.name, 10) && !clean(l.company, 10)) continue;
      const lead = store.add("leads", {
        name: clean(l.name, 120), company: clean(l.company, 120), contact: clean(l.contact, 160),
        source: clean(l.source, 120) || "Web search", sourceUrl: url, status: url ? "New" : "Unverified",
        notes: clean(l.notes, 500), foundBy: emp.name + " (" + emp.title + ")", foundById: emp.id, taskId: task.id,
      });
      count++;
      lines.push("- " + lead.id + ": " + (lead.name || lead.company) + (lead.company && lead.name ? " (" + lead.company + ")" : "") + " | " + lead.source + (url ? " | " + url : "") + " | " + lead.status);
    }
    const segs = arr(json.segments).slice(0, 8);
    for (const s of segs) { addOutput(task, emp, "prospect segment", s.title, s.detail); count++; }
    let out = clean(json.summary, 1500) + "\n";
    if (lines.length) out += "\nLeads added to the ledger (" + lines.length + "):\n" + lines.join("\n") + "\n";
    else out += "\nNo named leads were recorded" + (res.searched ? "." : ": web search is not available with the current LLM key, and leads are never invented.") + "\n";
    if (segs.length) out += "\nTarget segments:\n" + segs.map((s) => "- " + clean(s.title, 200) + ": " + clean(s.detail, 600)).join("\n") + "\n";
    if (res.sources.length) out += "\nSources:\n" + res.sources.slice(0, 10).map((s) => "- " + s.title + " " + s.url).join("\n");
    return { output: out, count };
  },

  // Sales and Booking Agent: a personal follow-up for every open lead.
  async followup(task, emp) {
    const open = db.leads.filter((l) => l.status === "New" || l.status === "Unverified").slice(-12)
      .map((l) => ({ leadId: l.id, name: l.name, company: l.company, contact: l.contact, source: l.source, notes: l.notes }));
    const schema = '{"summary": "2-3 sentences", "followups": [{"leadId": "L-0001 or empty for a general script", "channel": "email, phone, Instagram DM ...", "title": "short label", "message": "the full message text"}]}';
    const rules = "- DATA.openLeads lists the leads waiting for a follow-up. Write one follow-up per lead when the task is about leads. Use only lead ids from that list.";
    const { json } = await ask(emp, schema, task, { data: { openLeads: open }, rules });
    if (json.blocked) return { blocked: String(json.blocked) };
    const items = arr(json.followups).slice(0, 15);
    if (!items.length) return { blocked: open.length ? "The model produced no follow-ups." : "There are no leads with status New to follow up, and the task gives no other request." };
    const lines = [];
    for (const f of items) {
      const lead = db.leads.find((l) => l.id === f.leadId);
      const title = clean(f.title, 120) || (lead ? "Follow-up for " + (lead.name || lead.company) : "Sales script");
      addOutput(task, emp, "follow-up", (lead ? lead.id + ": " : "") + title + " (" + clean(f.channel, 40) + ")", f.message);
      if (lead) { lead.status = "Follow-up ready"; store.touch("leads", lead); }
      lines.push("### " + (lead ? lead.id + " " : "") + title + " [" + clean(f.channel, 40) + "]\n" + clean(f.message, 3000));
    }
    return { output: clean(json.summary, 1500) + "\n\n" + lines.join("\n\n"), count: items.length };
  },

  // Content Creator: drafts go to the Posts tab with status Draft.
  async post(task, emp) {
    const schema = '{"summary": "1-2 sentences", "posts": [{"platform": "Instagram | TikTok | Facebook | LinkedIn | Telegram", "title": "short title", "body": "the full post text", "hashtags": ["#tag"]}]}';
    const { json } = await ask(emp, schema, task);
    if (json.blocked) return { blocked: String(json.blocked) };
    const posts = arr(json.posts).slice(0, 12);
    if (!posts.length) return { blocked: "The model produced no posts." };
    const lines = [];
    for (const p of posts) {
      const tags = arr(p.hashtags).map((h) => clean(h, 40)).filter(Boolean).join(" ");
      const post = store.add("posts", {
        platform: clean(p.platform, 30) || "Instagram", title: clean(p.title, 160), body: clean(p.body, 5000) + (tags ? "\n\n" + tags : ""),
        status: "Draft", publishedAt: null, link: "", author: emp.name + " (" + emp.title + ")", authorId: emp.id, taskId: task.id,
      });
      lines.push("### " + post.id + " [" + post.platform + "] " + post.title + "\n" + post.body);
    }
    return { output: clean(json.summary, 1000) + "\n\n" + lines.join("\n\n"), count: posts.length };
  },

  // Social Media Publisher: publishes to the released channel, sends the rest for approval. No LLM needed.
  async publish(task, emp) {
    const drafts = db.posts.filter((p) => p.status === "Draft").slice(0, 12);
    if (!drafts.length) return { blocked: "There are no draft posts to publish. The Content Creator has to write drafts first." };
    const telegramReady = Boolean(config.telegramToken && config.telegramChannel);
    const lines = [];
    for (const post of drafts) {
      if (telegramReady && /telegram/i.test(post.platform)) {
        try {
          const res = await fetch("https://api.telegram.org/bot" + config.telegramToken + "/sendMessage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: config.telegramChannel, text: (post.title ? post.title + "\n\n" : "") + post.body }),
            signal: AbortSignal.timeout(30000),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.description || "Telegram error");
          post.status = "Published";
          post.publishedAt = new Date().toISOString();
          const chan = String(config.telegramChannel);
          post.link = chan.startsWith("@") ? "https://t.me/" + chan.slice(1) + "/" + json.result.message_id : "";
          lines.push("- " + post.id + " [" + post.platform + "] published" + (post.link ? ": " + post.link : ""));
        } catch (err) {
          post.status = "Awaiting approval";
          lines.push("- " + post.id + " [" + post.platform + "] could not be published (" + err.message + "), sent for approval");
        }
      } else {
        post.status = "Awaiting approval";
        lines.push("- " + post.id + " [" + post.platform + "] waiting for Boss approval (channel is not released for automatic publishing)");
      }
      store.touch("posts", post);
      addOutput(task, emp, "publishing", post.id + " [" + post.platform + "] " + post.status, post.title + (post.link ? " " + post.link : ""));
    }
    const published = drafts.filter((p) => p.status === "Published").length;
    return { output: "Processed " + drafts.length + " posts: " + published + " published, " + (drafts.length - published) + " waiting for approval.\n\n" + lines.join("\n"), count: drafts.length };
  },

  async winback(task, emp) {
    const schema = '{"summary": "1-2 sentences", "messages": [{"title": "short label", "audience": "who receives it", "message": "the full message text"}]}';
    const { json } = await ask(emp, schema, task);
    if (json.blocked) return { blocked: String(json.blocked) };
    const items = arr(json.messages).slice(0, 12);
    if (!items.length) return { blocked: "The model produced no messages." };
    for (const m of items) addOutput(task, emp, "retention message", clean(m.title, 120) + " (" + clean(m.audience, 80) + ")", m.message);
    return { output: clean(json.summary, 1000) + "\n\n" + items.map((m) => "### " + clean(m.title, 120) + " [" + clean(m.audience, 80) + "]\n" + clean(m.message, 3000)).join("\n\n"), count: items.length };
  },

  async review(task, emp) {
    const schema = '{"summary": "1-2 sentences", "replies": [{"title": "short label", "platform": "Google Maps | Yelp | other", "message": "the full reply or request text"}], "escalate": "a serious complaint the Project Manager must see, or empty"}';
    const { json } = await ask(emp, schema, task);
    if (json.blocked) return { blocked: String(json.blocked) };
    const items = arr(json.replies).slice(0, 12);
    if (!items.length) return { blocked: "The model produced no replies." };
    for (const m of items) addOutput(task, emp, "review reply", clean(m.title, 120) + " (" + clean(m.platform, 40) + ")", m.message);
    let out = clean(json.summary, 1000) + "\n\n" + items.map((m) => "### " + clean(m.title, 120) + " [" + clean(m.platform, 40) + "]\n" + clean(m.message, 3000)).join("\n\n");
    if (clean(json.escalate, 10)) { addOutput(task, emp, "escalation", "Escalated to the Project Manager", json.escalate); out += "\n\nEscalated: " + clean(json.escalate, 1000); }
    return { output: out, count: items.length };
  },

  async insight(task, emp, ctx) {
    const schema = '{"summary": "2-3 sentences", "insights": [{"title": "short headline", "detail": "what the data shows and what to do"}]}';
    const rules = "- DATA.agency is the live ledger summary. Every number you mention must come from it or from a web search result.";
    const search = /competitor|price|market|offer/i.test(task.title + " " + task.description);
    const { json, res } = await ask(emp, schema, task, { data: { agency: ctx.snapshot() }, rules, search });
    if (json.blocked) return { blocked: String(json.blocked) };
    const items = arr(json.insights).slice(0, 10);
    if (!items.length) return { blocked: "The model produced no insights." };
    for (const i of items) addOutput(task, emp, "insight", i.title, i.detail);
    let out = clean(json.summary, 1500) + "\n\n" + items.map((i) => "- " + clean(i.title, 200) + ": " + clean(i.detail, 1500)).join("\n");
    if (res.sources.length) out += "\n\nSources:\n" + res.sources.slice(0, 8).map((s) => "- " + s.title + " " + s.url).join("\n");
    return { output: out, count: items.length };
  },

  // Project Manager: splits a Boss request into tasks for the team, or audits the ledger.
  async assignment(task, emp, ctx) {
    const roster = employees.filter((e) => !e.isManager).map((e) => ({ id: e.id, title: e.title, does: e.responsibilities.join("; ") }));
    const schema = '{"summary": "what you decided, 2-4 sentences", "subtasks": [{"employee": "employee id from DATA.team", "title": "short title", "description": "clear instruction", "priority": "Urgent | High | Medium | Low", "deadline": "YYYY-MM-DD or empty"}]}';
    const rules = "- If the task needs work from the team, split it into subtasks for the right employees (ids from DATA.team). If it is an audit or a question, leave subtasks empty and answer in summary using DATA.agency only.";
    const { json } = await ask(emp, schema, task, { data: { team: roster, agency: ctx.snapshot() }, rules });
    if (json.blocked) return { blocked: String(json.blocked) };
    const lines = [];
    for (const s of arr(json.subtasks).slice(0, 8)) {
      const target = employeeById(s.employee) || resolveEmployee(s.employee);
      if (!target || target.isManager) continue;
      const sub = createTask({ title: s.title, description: s.description, employeeId: target.id, priority: s.priority, deadline: s.deadline || task.deadline, assignedBy: "Project Manager", parentId: task.id });
      addOutput(task, emp, "delegation", sub.id + " to " + target.title, sub.title);
      lines.push("- " + sub.id + " to " + target.name + " (" + target.title + "): " + sub.title);
    }
    if (!lines.length) addOutput(task, emp, "audit", task.title, json.summary);
    return { output: clean(json.summary, 2500) + (lines.length ? "\n\nTasks created:\n" + lines.join("\n") : ""), count: Math.max(1, lines.length) };
  },
};

// ---- worker ----------------------------------------------------------------
const running = new Set();
let context = { snapshot: () => ({}) };
export function setContext(ctx) { context = ctx; }
export function runningEmployees() { return running; }

async function runTask(task) {
  const emp = employeeById(task.employeeId);
  running.add(task.employeeId);
  task.status = "In Progress";
  task.startedAt = new Date().toISOString();
  task.blockedReason = "";
  store.touch("tasks", task);
  const started = Date.now();
  let result;
  try {
    const exec = EXECUTORS[emp.kpiKind];
    if (emp.kpiKind !== "publish" && !llm.enabled) result = { blocked: "No LLM API key is configured on the server, so the employee cannot work. Set GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY." };
    else result = await exec(task, emp, context);
  } catch (err) {
    console.error("[worker] " + task.id + " failed:", err.message);
    result = { blocked: "Error while working on the task: " + String(err.message).slice(0, 300) };
  }
  const wait = 2500 - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait)); // keep "In Progress" visible on the live board
  if (result.blocked) {
    task.status = "Blocked";
    task.blockedReason = clean(result.blocked, 600);
    task.output = "";
  } else {
    task.status = "Completed";
    task.output = clean(result.output, 30000);
    task.outputCount = result.count || 0;
  }
  task.completedAt = task.status === "Completed" ? new Date().toISOString() : null;
  task.durationMin = task.completedAt ? Math.round((Date.parse(task.completedAt) - Date.parse(task.createdAt)) / 6000) / 10 : null;
  store.touch("tasks", task);
  running.delete(task.employeeId);
  setImmediate(workerTick);
}

export function workerTick() {
  if (running.size >= config.workerConcurrency) return;
  const rank = (t) => PRIORITIES.indexOf(t.priority);
  const queued = db.tasks.filter((t) => t.status === "Queued").sort((a, b) => rank(a) - rank(b) || String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const t of queued) {
    if (running.size >= config.workerConcurrency) break;
    if (running.has(t.employeeId)) continue;
    runTask(t);
  }
}

export function retryTask(task) {
  if (task.status !== "Blocked") throw new Error("Only a blocked task can be retried.");
  task.status = "Queued";
  task.blockedReason = "";
  task.startedAt = null;
  store.touch("tasks", task);
  setImmediate(workerTick);
  return task;
}

// ---- schedule ----------------------------------------------------------------
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function dayMatches(spec, dow) {
  spec = String(spec || "daily").toLowerCase();
  if (spec === "daily") return true;
  return spec.split(",").some((part) => {
    const [a, b] = part.trim().split("-");
    if (!b) return a === dow;
    const i = DOW.indexOf(a), j = DOW.indexOf(b), k = DOW.indexOf(dow);
    return i >= 0 && j >= 0 && (i <= j ? k >= i && k <= j : k >= i || k <= j);
  });
}

// Creates today's routine tasks once their time has come. Called every minute and by the cron endpoint.
export function runSchedule() {
  if (!config.autopilot) return [];
  const today = localDate(), now = localTime(), dow = localDow();
  const created = [];
  for (const r of team.routines) {
    if (!dayMatches(r.days, dow) || now < r.time) continue;
    const key = r.id + ":" + today;
    if (db.tasks.some((t) => t.routineKey === key)) continue;
    created.push(createTask({ title: r.title, description: r.description, employeeId: r.employee, priority: r.priority, deadline: today, assignedBy: "Project Manager (schedule)", routineKey: key }));
  }
  return created;
}

export function startLoops() {
  setInterval(workerTick, 5000).unref?.();
  setInterval(runSchedule, 60000).unref?.();
  setTimeout(() => { runSchedule(); workerTick(); }, 3000).unref?.();
}
