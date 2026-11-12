// Dashboard chat: the Boss talks to the Project Manager or to any employee.
// Answers are built from the live store (the same data as the ledger), and the chat can create tasks.
import { localDate, localStamp, addDays } from "./config.mjs";
import { db, store } from "./store.mjs";
import { team, employees, employeeById, resolveEmployee, createTask } from "./agents.mjs";
import { complete, extractJson, llm } from "./llm.mjs";
import { snapshot } from "./reports.mjs";

const label = (e) => e.name + " (" + e.title + ")";

export function history(channel, limit = 200) {
  return db.chat.filter((m) => m.channel === channel).slice(-limit);
}

function say(channel, emp, role, text) {
  return store.add("chat", { channel, channelName: label(emp), role, from: role === "boss" ? "Boss" : label(emp), text: String(text).slice(0, 8000) });
}

// ---- task creation from chat -------------------------------------------------
function parseDeadline(text) {
  const t = text.toLowerCase(), today = localDate();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\btoday\b|\btonight\b/.test(t)) return today;
  const inDays = t.match(/\bin (\d+) days?\b/);
  if (inDays) return addDays(today, Number(inDays[1]));
  if (/\bnext week\b/.test(t)) return addDays(today, 7);
  return "";
}

function applyActions(actions, fallbackEmployeeId) {
  const created = [];
  for (const a of Array.isArray(actions) ? actions.slice(0, 6) : []) {
    if (!a || a.type !== "create_task") continue;
    const emp = employeeById(a.employee) || resolveEmployee(a.employee) || employeeById(fallbackEmployeeId);
    if (!emp) continue;
    try {
      created.push(createTask({ title: a.title, description: a.description || a.title, employeeId: emp.id, priority: a.priority, deadline: a.deadline, assignedBy: "Boss (chat)" }));
    } catch { /* skip an invalid action */ }
  }
  return created;
}

const confirmation = (tasks) => tasks.map((t) => "Created " + t.id + " for " + t.agentName + ": \"" + t.title + "\", priority " + t.priority + (t.deadline ? ", due " + t.deadline : "") + ". It is in the queue and in the ledger.").join("\n");

// ---- answers without an LLM (also the safety net when the LLM call fails) -----
function ruleBasedPm(message) {
  const m = message.toLowerCase();
  const s = snapshot();
  const assign = message.match(/^\s*(?:please\s+)?(?:assign|give|create|add)\b[^:]*?\bto\s+(?:the\s+)?([^:]+?)\s*:\s*([\s\S]+)$/i);
  if (assign) {
    const emp = resolveEmployee(assign[1]);
    if (!emp) return { reply: "I could not match \"" + assign[1].trim() + "\" to an employee. The team: " + employees.map(label).join(", ") + "." };
    const body = assign[2].trim();
    const task = createTask({ title: body.replace(/,?\s*due .*$/i, "").slice(0, 120), description: body, employeeId: emp.id, priority: /urgent|asap/i.test(body) ? "Urgent" : "Medium", deadline: parseDeadline(body), assignedBy: "Boss (chat)" });
    return { reply: confirmation([task]), created: [task] };
  }
  const parts = [];
  const list = (items, fn) => items.map((i) => "- " + fn(i)).join("\n");
  if (/block/.test(m)) {
    parts.push(s.blockedTasks.length ? "Blocked tasks (" + s.blockedTasks.length + "):\n" + list(s.blockedTasks, (t) => t.id + " " + t.title + " (" + t.employee + "): " + (t.blockedReason || "no reason recorded")) : "No tasks are blocked right now.");
  }
  if (/lead|sales/.test(m)) {
    const sales = s.employees.find((e) => e.id === "sales-booking"), research = s.employees.find((e) => e.id === "lead-researcher");
    parts.push("Sales team: " + [research, sales].map((e) => e.employee + " is " + e.status + (e.currentTask ? " on " + e.currentTask : "") + ", " + e.completedToday + " tasks completed today, " + e.queued + " queued, " + e.blocked + " blocked").join("; ") + ".");
    parts.push(s.leadsToday.length ? "Leads generated today: " + s.leadsToday.length + ".\n" + list(s.leadsToday, (l) => l.id + " " + [l.name, l.company].filter(Boolean).join(", ") + " | source: " + l.source + " | status: " + l.status + (l.contact ? " | " + l.contact : "")) : "Leads generated today: 0.");
  }
  if (/post|publish|platform/.test(m)) {
    const byPlatform = {};
    for (const p of s.postsPublishedToday) byPlatform[p.platform] = (byPlatform[p.platform] || 0) + 1;
    parts.push("Posts published today: " + s.postsPublishedToday.length + (s.postsPublishedToday.length ? " (" + Object.entries(byPlatform).map(([k, v]) => k + ": " + v).join(", ") + ").\n" + list(s.postsPublishedToday, (p) => p.id + " [" + p.platform + "] " + p.title + " at " + p.time + (p.link ? " " + p.link : "")) : ".") +
      "\nPosts created today: " + s.postsCreatedToday.length + ". Waiting for your approval: " + s.postsAwaitingApproval.length + ".");
  }
  if (/most|top|best/.test(m) && /week|task|employee/.test(m)) {
    const top = s.completedThisWeekByEmployee[0];
    parts.push(top && top.completedThisWeek > 0 ? top.employee + " completed the most tasks this week: " + top.completedThisWeek + ".\n" + list(s.completedThisWeekByEmployee.filter((e) => e.completedThisWeek > 0), (e) => e.employee + ": " + e.completedThisWeek) : "No tasks have been completed this week yet.");
  }
  if (/running|in progress|current|how many (projects|tasks)|status|overview|summary/.test(m) || !parts.length) {
    const c = s.taskCounts;
    parts.unshift("Tasks running now: " + c["In Progress"] + ". Queued: " + c.Queued + ", blocked: " + c.Blocked + ", completed: " + c.Completed + " (total " + c.total + ")." +
      (s.runningTasks.length ? "\n" + list(s.runningTasks, (t) => t.id + " " + t.title + " (" + t.employee + ")") : ""));
  }
  return { reply: parts.join("\n\n") };
}

function ruleBasedEmployee(emp) {
  const mine = db.tasks.filter((t) => t.employeeId === emp.id);
  const cur = mine.find((t) => t.status === "In Progress");
  const today = localDate();
  const doneToday = mine.filter((t) => t.status === "Completed" && localDate(t.completedAt) === today);
  const blocked = mine.filter((t) => t.status === "Blocked");
  return [
    cur ? "I am working on " + cur.id + " \"" + cur.title + "\"." : "I am idle right now.",
    "Completed today: " + doneToday.length + (doneToday.length ? " (" + doneToday.map((t) => t.id + " " + t.title).join("; ") + ")." : "."),
    "Queued: " + mine.filter((t) => t.status === "Queued").length + ". Blocked: " + blocked.length + (blocked.length ? " (" + blocked.map((t) => t.id + ": " + t.blockedReason).join("; ") + ")." : "."),
  ].join("\n");
}

// ---- LLM chat -------------------------------------------------------------------
const JSON_SHAPE = '{"reply": "your answer to the Boss in plain text", "actions": [{"type": "create_task", "employee": "employee id", "title": "short title", "description": "clear instruction", "priority": "Urgent | High | Medium | Low", "deadline": "YYYY-MM-DD or empty"}]}';

function pmSystem() {
  return [
    "You are Maya, the Project Manager (Chief of Staff) of " + team.agency.name + ", a " + team.agency.type + ". You are talking with the Boss in the dashboard chat.",
    "Team (employee ids): " + employees.map((e) => e.id + " = " + label(e)).join("; ") + ".",
    "",
    "Rules:",
    "- Answer ONLY from the DATA block in the last message. It is the live ledger. Never invent tasks, numbers, leads, posts or links. If the data does not contain the answer, say so.",
    "- Give exact numbers and list the items with their ids when the Boss asks for details. \"Running\" means status In Progress.",
    "- When the Boss asks you to assign, create or delegate work, add a create_task action. Pick the employee id from the team. Turn words like \"tomorrow\" into a date using DATA.today. Do not say a task was created unless you add the action.",
    "- Be brief and direct. Plain text, no markdown tables.",
    "",
    "Answer with ONE JSON object and nothing else:",
    JSON_SHAPE,
  ].join("\n");
}

function employeeSystem(emp) {
  return [
    "You are " + emp.name + ", the " + emp.title + " of " + team.agency.name + ". You are talking with the Boss in the dashboard chat about your own work.",
    "Your responsibilities: " + emp.responsibilities.join("; ") + ". You report to " + emp.reportsTo + ".",
    "",
    "Rules:",
    "- Answer ONLY from the DATA block in the last message: your tasks and what you produced. Never invent work, numbers or links.",
    "- If the Boss gives you new work, add a create_task action with employee \"" + emp.id + "\". Do not say a task was created unless you add the action.",
    "- Be brief. Plain text.",
    "",
    "Answer with ONE JSON object and nothing else:",
    JSON_SHAPE,
  ].join("\n");
}

function employeeData(emp) {
  const today = localDate();
  const mine = db.tasks.filter((t) => t.employeeId === emp.id).slice(-15);
  return {
    now: localStamp(), today,
    myTasks: mine.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, assignedBy: t.assignedBy, created: localStamp(t.createdAt), completed: t.completedAt ? localStamp(t.completedAt) : undefined, blockedReason: t.blockedReason || undefined, output: t.output ? t.output.slice(0, 700) : undefined })),
    producedToday: {
      leads: db.leads.filter((l) => l.foundById === emp.id && localDate(l.createdAt) === today).map((l) => ({ id: l.id, name: l.name, company: l.company, source: l.source, status: l.status })),
      posts: db.posts.filter((p) => p.authorId === emp.id && localDate(p.createdAt) === today).map((p) => ({ id: p.id, platform: p.platform, title: p.title, status: p.status })),
      other: db.outputs.filter((o) => o.agentId === emp.id && localDate(o.createdAt) === today).map((o) => ({ kind: o.kind, title: o.title })),
    },
  };
}

export async function chat(channel, message) {
  const emp = employeeById(channel);
  if (!emp) throw new Error("Unknown chat channel.");
  message = String(message || "").trim().slice(0, 4000);
  if (!message) throw new Error("Empty message.");
  const past = history(channel, 8);
  const bossMsg = say(channel, emp, "boss", message);

  let reply = "", created = [], mode = "live data";
  if (llm.enabled) {
    try {
      const data = emp.isManager ? snapshot() : employeeData(emp);
      const messages = past.map((m) => ({ role: m.role === "boss" ? "user" : "assistant", content: m.text }));
      // Models need alternating turns that start with the user.
      while (messages.length && messages[0].role !== "user") messages.shift();
      const turns = [];
      for (const m of messages) { if (turns.length && turns[turns.length - 1].role === m.role) turns[turns.length - 1].content += "\n" + m.content; else turns.push({ ...m }); }
      if (turns.length && turns[turns.length - 1].role === "user") turns.pop();
      turns.push({ role: "user", content: "Boss: " + message + "\n\nDATA (live ledger, " + localStamp() + "):\n" + JSON.stringify(data) });
      const res = await complete({ system: emp.isManager ? pmSystem() : employeeSystem(emp), messages: turns, maxTokens: 1800 });
      const json = extractJson(res.text);
      if (json && typeof json.reply === "string") {
        created = applyActions(json.actions, emp.isManager ? null : emp.id);
        reply = json.reply.trim();
        // Ids come from the server, never from the model.
        if (created.length) reply = reply.replace(/\bT-\d{3,}\b/g, "").trim() + "\n\n" + confirmation(created);
      } else {
        reply = res.text.trim();
      }
      mode = "live data + " + llm.provider;
    } catch (err) {
      console.error("[chat] LLM failed, using the built-in answers:", err.message);
    }
  }
  if (!reply) {
    if (emp.isManager) { const r = ruleBasedPm(message); reply = r.reply; created = r.created || []; }
    else reply = ruleBasedEmployee(emp);
  }
  const answer = say(channel, emp, "agent", reply);
  return { messages: [bossMsg, answer], created: created.map((t) => t.id), mode };
}
