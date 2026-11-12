// Everything that is counted: the live snapshot, reports, CSV export and the daily email.
import { config, localDate, localStamp, localTime, daysAgoDate } from "./config.mjs";
import { db } from "./store.mjs";
import { team, employees, runningEmployees, installedManifest } from "./agents.mjs";
import { llm } from "./llm.mjs";
import { sheets } from "./sheets.mjs";

const day = (iso) => (iso ? localDate(iso) : "");
const label = (e) => e.name + " (" + e.title + ")";
const OPEN = ["Queued", "In Progress", "Blocked"];

function producedBy(empId, from, to) {
  const inRange = (iso) => { const d = day(iso); return d >= from && d <= to; };
  return db.leads.filter((l) => l.foundById === empId && inRange(l.createdAt)).length +
    db.posts.filter((p) => p.authorId === empId && inRange(p.createdAt)).length +
    db.outputs.filter((o) => o.agentId === empId && inRange(o.createdAt)).length;
}

export function employeeCards() {
  const today = localDate();
  const kits = new Map(((installedManifest() || {}).employees || []).map((k) => [k.id, k]));
  return employees.map((e) => {
    const mine = db.tasks.filter((t) => t.employeeId === e.id);
    const current = mine.find((t) => t.status === "In Progress") || null;
    const kit = kits.get(e.id);
    return {
      id: e.id, name: e.name, title: e.title, isManager: Boolean(e.isManager), kit: e.kit, kitVersion: kit ? kit.kit_version : null,
      responsibilities: e.responsibilities, tools: e.tools, kpis: e.kpis, kpiLabel: e.kpiLabel, reportsTo: e.reportsTo, handsOverTo: e.handsOverTo,
      status: current || runningEmployees().has(e.id) ? "active" : "idle",
      currentTask: current ? { id: current.id, title: current.title } : null,
      queued: mine.filter((t) => t.status === "Queued").length,
      blocked: mine.filter((t) => t.status === "Blocked").length,
      completedToday: mine.filter((t) => t.status === "Completed" && day(t.completedAt) === today).length,
      outputToday: producedBy(e.id, today, today),
    };
  });
}

function compactTask(t) {
  return { id: t.id, title: t.title, employee: t.agentName, priority: t.priority, status: t.status, assignedBy: t.assignedBy,
    created: localStamp(t.createdAt), deadline: t.deadline || undefined, completed: t.completedAt ? localStamp(t.completedAt) : undefined,
    blockedReason: t.blockedReason || undefined };
}

// The facts the Project Manager is allowed to talk about. Built from the same store the dashboard and the sheet use.
export function snapshot() {
  const today = localDate(), weekFrom = daysAgoDate(6);
  const counts = { total: db.tasks.length };
  for (const s of ["Queued", "In Progress", "Blocked", "Completed"]) counts[s] = db.tasks.filter((t) => t.status === s).length;
  const week = employees.map((e) => ({ employee: label(e), completedThisWeek: db.tasks.filter((t) => t.employeeId === e.id && t.status === "Completed" && day(t.completedAt) >= weekFrom).length }))
    .sort((a, b) => b.completedThisWeek - a.completedThisWeek);
  const postRow = (p) => ({ id: p.id, platform: p.platform, title: p.title, status: p.status, link: p.link || undefined, time: p.publishedAt ? localTime(p.publishedAt) : localTime(p.createdAt) });
  return {
    now: localStamp() + " (" + config.timezone + ")", today, weekStartsOn: weekFrom,
    taskCounts: counts,
    runningTasks: db.tasks.filter((t) => t.status === "In Progress").map(compactTask),
    queuedTasks: db.tasks.filter((t) => t.status === "Queued").map(compactTask),
    blockedTasks: db.tasks.filter((t) => t.status === "Blocked").map(compactTask),
    completedToday: db.tasks.filter((t) => t.status === "Completed" && day(t.completedAt) === today).map(compactTask),
    leadsToday: db.leads.filter((l) => day(l.createdAt) === today).map((l) => ({ id: l.id, name: l.name, company: l.company, contact: l.contact, source: l.source, status: l.status })),
    leadsTotal: db.leads.length,
    postsCreatedToday: db.posts.filter((p) => day(p.createdAt) === today).map(postRow),
    postsPublishedToday: db.posts.filter((p) => p.status === "Published" && day(p.publishedAt) === today).map(postRow),
    postsAwaitingApproval: db.posts.filter((p) => p.status === "Awaiting approval").map(postRow),
    completedThisWeekByEmployee: week,
    employees: employeeCards().map((c) => ({ id: c.id, employee: c.name + " (" + c.title + ")", status: c.status, currentTask: c.currentTask ? c.currentTask.id + " " + c.currentTask.title : null, queued: c.queued, blocked: c.blocked, completedToday: c.completedToday, outputToday: c.outputToday })),
    recentTasks: db.tasks.slice(-30).map(compactTask),
  };
}

export function buildReport(range = "daily") {
  const to = localDate();
  const from = range === "weekly" ? daysAgoDate(6) : to;
  const inRange = (iso) => { const d = day(iso); return d >= from && d <= to; };
  const perEmployee = employees.map((e) => {
    const mine = db.tasks.filter((t) => t.employeeId === e.id);
    const done = mine.filter((t) => t.status === "Completed" && inRange(t.completedAt));
    const durations = done.map((t) => t.durationMin).filter((n) => typeof n === "number");
    return {
      id: e.id, name: e.name, title: e.title,
      completed: done.length,
      pending: mine.filter((t) => t.status === "Queued" || t.status === "In Progress").length,
      blocked: mine.filter((t) => t.status === "Blocked").length,
      avgCompletionMin: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
      kpiLabel: e.kpiLabel, kpiValue: producedBy(e.id, from, to),
    };
  });
  const leads = db.leads.filter((l) => inRange(l.createdAt));
  const postsCreated = db.posts.filter((p) => inRange(p.createdAt));
  const postsPublished = db.posts.filter((p) => p.status === "Published" && inRange(p.publishedAt));
  const kind = (k) => db.outputs.filter((o) => o.kind === k && inRange(o.createdAt)).length;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = daysAgoDate(i);
    days.push({
      date: d,
      completed: db.tasks.filter((t) => t.status === "Completed" && day(t.completedAt) === d).length,
      leads: db.leads.filter((l) => day(l.createdAt) === d).length,
      postsCreated: db.posts.filter((p) => day(p.createdAt) === d).length,
      postsPublished: db.posts.filter((p) => p.status === "Published" && day(p.publishedAt) === d).length,
    });
  }
  return {
    range, from, to, generatedAt: localStamp(), timezone: config.timezone, agency: team.agency.name,
    summary: {
      tasksCreated: db.tasks.filter((t) => inRange(t.createdAt)).length,
      tasksCompleted: db.tasks.filter((t) => t.status === "Completed" && inRange(t.completedAt)).length,
      tasksInProgress: db.tasks.filter((t) => t.status === "In Progress").length,
      tasksQueued: db.tasks.filter((t) => t.status === "Queued").length,
      tasksBlocked: db.tasks.filter((t) => t.status === "Blocked").length,
      leadsGenerated: leads.length, postsCreated: postsCreated.length, postsPublished: postsPublished.length,
      postsAwaitingApproval: db.posts.filter((p) => p.status === "Awaiting approval").length,
      followUps: kind("follow-up"), retentionMessages: kind("retention message"), reviewReplies: kind("review reply"), insights: kind("insight"),
    },
    perEmployee,
    leads: leads.map((l) => ({ id: l.id, time: localStamp(l.createdAt), name: l.name, company: l.company, contact: l.contact, source: l.source, sourceUrl: l.sourceUrl, status: l.status })),
    posts: postsCreated.concat(postsPublished.filter((p) => !postsCreated.includes(p))).map((p) => ({ id: p.id, platform: p.platform, title: p.title, status: p.status, link: p.link, created: localStamp(p.createdAt), published: p.publishedAt ? localStamp(p.publishedAt) : "" })),
    blocked: db.tasks.filter((t) => t.status === "Blocked").map((t) => ({ id: t.id, title: t.title, employee: t.agentName, reason: t.blockedReason })),
    inProgress: db.tasks.filter((t) => t.status === "In Progress" || t.status === "Queued").map((t) => ({ id: t.id, title: t.title, employee: t.agentName, status: t.status })),
    completedTasks: db.tasks.filter((t) => t.status === "Completed" && inRange(t.completedAt)).map((t) => ({ id: t.id, title: t.title, employee: t.agentName, completed: localStamp(t.completedAt) })),
    days,
  };
}

// ---- CSV -------------------------------------------------------------------
function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function exportCsv(kind, range) {
  const r = buildReport(range);
  if (kind === "tasks") {
    return csv([["Task ID", "Timestamp", "Assigned By", "Agent Name", "Title", "Task Description", "Priority", "Status", "Deadline", "Completion Time", "Duration (min)", "Blocked Reason"]]
      .concat(db.tasks.map((t) => [t.id, localStamp(t.createdAt), t.assignedBy, t.agentName, t.title, t.description, t.priority, t.status, t.deadline, t.completedAt ? localStamp(t.completedAt) : "", t.durationMin ?? "", t.blockedReason])));
  }
  if (kind === "leads") return csv([["Lead ID", "Time", "Name", "Company", "Contact", "Source", "Source URL", "Status"]].concat(r.leads.map((l) => [l.id, l.time, l.name, l.company, l.contact, l.source, l.sourceUrl, l.status])));
  if (kind === "posts") return csv([["Post ID", "Platform", "Title", "Status", "Link", "Created", "Published"]].concat(r.posts.map((p) => [p.id, p.platform, p.title, p.status, p.link, p.created, p.published])));
  const rows = [[r.agency + " " + r.range + " report", r.from + " to " + r.to, "generated " + r.generatedAt + " " + r.timezone], [], ["Agency summary"], ["Metric", "Value"]];
  for (const [k, v] of Object.entries(r.summary)) rows.push([k, v]);
  rows.push([], ["Per employee"], ["Employee", "Role", "Completed", "Pending", "Blocked", "Avg completion (min)", "KPI", "KPI value"]);
  for (const e of r.perEmployee) rows.push([e.name, e.title, e.completed, e.pending, e.blocked, e.avgCompletionMin ?? "", e.kpiLabel, e.kpiValue]);
  rows.push([], ["Last 7 days"], ["Date", "Tasks completed", "Leads", "Posts created", "Posts published"]);
  for (const d of r.days) rows.push([d.date, d.completed, d.leads, d.postsCreated, d.postsPublished]);
  return csv(rows);
}

// ---- daily email -------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function buildDailyEmail() {
  const r = buildReport("daily");
  const s = r.summary;
  const th = 'style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-size:12px;color:#555"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';
  const list = (items, fn, empty) => (items.length ? "<ul style=\"margin:6px 0 0 18px;padding:0\">" + items.map((i) => "<li style=\"margin:3px 0\">" + fn(i) + "</li>").join("") + "</ul>" : "<p style=\"margin:6px 0;color:#777\">" + empty + "</p>");
  const h = (t) => '<h3 style="margin:22px 0 4px;font-size:15px">' + t + "</h3>";
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:680px">',
    '<h2 style="margin:0 0 4px">' + esc(r.agency) + ": daily status, " + esc(r.to) + "</h2>",
    '<p style="margin:0;color:#666;font-size:13px">From Maya, Project Manager. Generated ' + esc(r.generatedAt) + " " + esc(r.timezone) + " from the live ledger.</p>",
    '<p style="font-size:14px;margin:14px 0"><b>' + s.tasksCompleted + "</b> completed, <b>" + (s.tasksInProgress + s.tasksQueued) + "</b> in progress or queued, <b>" + s.tasksBlocked + "</b> blocked. <b>" +
      s.leadsGenerated + "</b> leads, <b>" + s.postsCreated + "</b> posts created, <b>" + s.postsPublished + "</b> published.</p>",
    h("Completed today (" + r.completedTasks.length + ")"), list(r.completedTasks, (t) => esc(t.id) + " " + esc(t.title) + " <span style=\"color:#777\">" + esc(t.employee) + "</span>", "Nothing completed yet today."),
    h("In progress (" + r.inProgress.length + ")"), list(r.inProgress, (t) => esc(t.id) + " " + esc(t.title) + " <span style=\"color:#777\">" + esc(t.employee) + ", " + esc(t.status) + "</span>", "Nothing in progress."),
    h("Blocked (" + r.blocked.length + ")"), list(r.blocked, (t) => esc(t.id) + " " + esc(t.title) + " <span style=\"color:#777\">" + esc(t.employee) + "</span><br><span style=\"color:#b3261e\">" + esc(t.reason) + "</span>", "No blocked tasks."),
    h("KPIs by employee"),
    '<table style="border-collapse:collapse;width:100%"><tr><th ' + th + ">Employee</th><th " + th + ">Done</th><th " + th + ">Pending</th><th " + th + ">Blocked</th><th " + th + ">Avg min</th><th " + th + ">KPI today</th></tr>",
    r.perEmployee.map((e) => "<tr><td " + td + "><b>" + esc(e.name) + "</b><br><span style=\"color:#777;font-size:12px\">" + esc(e.title) + "</span></td><td " + td + ">" + e.completed + "</td><td " + td + ">" + e.pending + "</td><td " + td + ">" + e.blocked + "</td><td " + td + ">" + (e.avgCompletionMin ?? "") + "</td><td " + td + ">" + esc(e.kpiLabel) + ": <b>" + e.kpiValue + "</b></td></tr>").join(""),
    "</table>",
    config.publicUrl ? '<p style="margin:20px 0 0;font-size:13px"><a href="' + esc(config.publicUrl) + '">Open the Boss Command Center</a></p>' : "",
    "</div>",
  ].join("\n");
  return { subject: r.agency + " daily status " + r.to + ": " + s.tasksCompleted + " done, " + s.tasksBlocked + " blocked, " + s.leadsGenerated + " leads", html, report: r };
}

export function integrations() {
  const manifest = installedManifest();
  return {
    llm: llm.status(),
    sheets: sheets.status(),
    email: { enabled: sheets.enabled, to: config.bossEmail || "set in the Apps Script" },
    telegram: { enabled: Boolean(config.telegramToken && config.telegramChannel), channel: config.telegramChannel || null },
    kits: manifest ? { hired: manifest.employees.length, source: manifest.source, hiredOn: manifest.hired_on } : null,
    autopilot: config.autopilot, timezone: config.timezone,
  };
}
