/* FitPulse AI: Boss Command Center (vanilla JS, no build step) */
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const main = $("#main");
  const STATUSES = ["Queued", "In Progress", "Blocked", "Completed"];
  const stClass = (s) => String(s).split(" ")[0];

  let state = null;         // last /api/state answer
  let view = "";            // current view name
  let pollTimer = null;
  const filters = { employee: "", status: "", priority: "", from: "", to: "" };
  let reportRange = "daily";
  let report = null;
  let openTaskId = null;
  let chatChannel = "pm";
  let chatBusy = false;

  // ---- api ---------------------------------------------------------------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Please sign in."); }
    if (!res.ok) throw new Error((data && data.error) || "Request failed (" + res.status + ")");
    return data;
  }

  let toastTimer = null;
  function toast(text, bad = false) {
    const el = $("#toast");
    el.textContent = text;
    el.className = "toast" + (bad ? " bad" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 3500);
  }

  const fmt = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { timeZone: state ? state.timezone : undefined, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const localDay = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: state ? state.timezone : undefined }) : "");
  const empName = (id) => { const e = state.employees.find((x) => x.id === id); return e ? e.name + " (" + e.title + ")" : id; };
  const dur = (v) => (v == null ? "" : v < 1 ? Math.round(v * 60) + " s" : v + " min");
  const statusBadge = (s) => '<span class="badge st-' + stClass(s) + '">' + esc(s) + "</span>";

  // ---- auth ----------------------------------------------------------------
  function showLogin() {
    clearInterval(pollTimer);
    $("#app").hidden = true;
    $("#login").hidden = false;
  }
  async function showApp() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    await refresh();
    route();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => refresh().catch(() => {}), 4000);
  }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    $("#login-error").textContent = "";
    try {
      await api("/api/login", { method: "POST", body: { username: f.get("username"), password: f.get("password") } });
      e.target.reset();
      await showApp();
    } catch (err) { $("#login-error").textContent = err.message; }
  });
  $("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST", body: {} }).catch(() => {}); showLogin(); });

  // ---- data refresh ----------------------------------------------------------
  async function refresh() {
    state = await api("/api/state");
    $("#clock").textContent = state.now + " " + state.timezone;
    if (view === "team") renderTeam();
    if (view === "board") renderBoardColumns();
    if (view === "assign") renderRecent();
    if (openTaskId) loadTask(openTaskId, true);
  }

  // ---- router ----------------------------------------------------------------
  function route() {
    if (!state) return;
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    let name = parts[0] || "team";
    if (name === "task" && parts[1]) { name = "board"; openTask(parts[1]); }
    if (!["team", "assign", "board", "reports", "chat"].includes(name)) name = "team";
    view = name;
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
    if (name === "team") renderTeam();
    if (name === "assign") renderAssign(parts[1]);
    if (name === "board") renderBoard();
    if (name === "reports") renderReports();
    if (name === "chat") renderChat(parts[1] || "pm");
  }
  window.addEventListener("hashchange", route);

  // ---- E) team overview --------------------------------------------------------
  function integrationChips() {
    const i = state.integrations;
    const chip = (ok, text) => '<span class="chip ' + (ok ? "ok" : "off") + '">' + esc(text) + "</span>";
    return '<div class="status-strip">' +
      chip(i.llm.enabled, i.llm.enabled ? "AI model: " + i.llm.provider + (i.llm.model ? " " + i.llm.model : "") : "AI model: not connected") +
      chip(i.sheets.enabled && !i.sheets.lastError, i.sheets.enabled ? (i.sheets.lastError ? "Google Sheet: sync error" : "Google Sheet ledger: connected") : "Google Sheet ledger: not connected") +
      chip(i.email.enabled, i.email.enabled ? "Daily email: on" : "Daily email: not connected") +
      chip(i.telegram.enabled, i.telegram.enabled ? "Telegram channel released" : "Publishing: Boss approval") +
      chip(Boolean(i.kits), i.kits ? i.kits.hired + " ai-employees kits hired (v" + i.kits.source.version + ")" : "ai-employees kits: run npm run hire") +
      chip(i.autopilot, i.autopilot ? "Daily routines: on" : "Daily routines: off") +
      (i.sheets.sheetUrl ? '<a class="chip" href="' + esc(i.sheets.sheetUrl) + '" target="_blank" rel="noopener">Open the ledger</a>' : "") +
      "</div>";
  }

  function renderTeam() {
    const today = localDay(new Date().toISOString());
    const count = (s) => state.tasks.filter((t) => t.status === s).length;
    const doneToday = state.tasks.filter((t) => t.status === "Completed" && localDay(t.completedAt) === today).length;
    const leadsToday = state.leads.filter((l) => localDay(l.createdAt) === today).length;
    const pubToday = state.posts.filter((p) => p.status === "Published" && localDay(p.publishedAt) === today).length;
    const tile = (n, label) => '<div class="tile"><b>' + n + "</b><span>" + label + "</span></div>";
    main.innerHTML =
      '<div class="head"><div><h1>Team</h1><p class="muted">' + esc(state.agency.name) + ": 1 Project Manager and 7 specialists, live.</p></div></div>" +
      '<div class="tiles">' + tile(count("In Progress"), "Running now") + tile(count("Queued"), "Queued") + tile(count("Blocked"), "Blocked") +
      tile(doneToday, "Completed today") + tile(leadsToday, "Leads today") + tile(pubToday, "Posts published today") + "</div>" +
      integrationChips() +
      '<div class="grid">' + state.employees.map((e) =>
        '<article class="card emp">' +
          '<div class="emp-top"><div><div class="emp-name">' + esc(e.name) + '</div><div class="muted small">' + esc(e.title) + "</div></div>" +
          '<span class="badge ' + e.status + '">' + e.status + "</span></div>" +
          '<div class="now">' + (e.currentTask ? "<b>" + esc(e.currentTask.id) + "</b> " + esc(e.currentTask.title) : '<span class="muted">No task in progress</span>') + "</div>" +
          '<div class="emp-stats"><div><b>' + e.outputToday + "</b><span>Output today</span></div><div><b>" + e.completedToday + "</b><span>Done today</span></div><div><b>" + e.queued + "</b><span>Queued</span></div></div>" +
          '<div class="muted small">' + esc(e.kpiLabel) + (e.blocked ? ' · <span style="color:var(--blocked)">' + e.blocked + " blocked</span>" : "") + (e.kitVersion ? " · kit " + esc(e.kit) + " v" + esc(e.kitVersion) : "") + "</div>" +
          '<div class="row"><a class="btn small" href="#/assign/' + esc(e.id) + '">Assign task</a><a class="btn small" href="#/chat/' + esc(e.id) + '">Chat</a></div>' +
        "</article>").join("") + "</div>";
  }

  // ---- A) task assignment --------------------------------------------------------
  function renderAssign(preselect) {
    const opts = state.employees.map((e) => '<option value="' + esc(e.id) + '"' + (e.id === preselect ? " selected" : "") + ">" + esc(e.name + " · " + e.title) + "</option>").join("");
    main.innerHTML =
      '<div class="head"><div><h1>Assign task</h1><p class="muted">Give work to the Project Manager or straight to any employee. It goes to the queue and to the Google Sheet ledger.</p></div></div>' +
      '<form id="assign-form" class="card form">' +
        '<label>Assign to<select name="employeeId" required>' + opts + "</select></label>" +
        '<label>Title<input name="title" maxlength="160" required placeholder="Write 3 LinkedIn posts about our new service"></label>' +
        '<label>Description<textarea name="description" maxlength="4000" placeholder="What exactly should be done, for whom, and what the result should look like"></textarea></label>' +
        '<div class="two"><label>Priority<select name="priority">' + state.priorities.map((p) => "<option" + (p === "Medium" ? " selected" : "") + ">" + p + "</option>").join("") + "</select></label>" +
        '<label>Deadline<input name="deadline" type="date"></label></div>' +
        '<div class="row"><button class="btn primary" type="submit">Assign task</button><span id="assign-msg" class="muted"></span></div>' +
      "</form>" +
      '<div class="section"><h2>Recently assigned</h2><div id="recent" class="card table-wrap"></div></div>';
    $("#assign-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const btn = $("button[type=submit]", e.target);
      btn.disabled = true;
      try {
        const res = await api("/api/tasks", { method: "POST", body: Object.fromEntries(f.entries()) });
        toast(res.task.id + " assigned to " + res.task.agentName);
        e.target.elements.title.value = ""; e.target.elements.description.value = "";
        await refresh();
      } catch (err) { toast(err.message, true); }
      btn.disabled = false;
    });
    renderRecent();
  }
  function renderRecent() {
    const el = $("#recent");
    if (!el) return;
    const rows = state.tasks.slice(-8).reverse();
    el.innerHTML = rows.length ? "<table><tr><th>Task</th><th>Assigned to</th><th>By</th><th>Priority</th><th>Status</th></tr>" + rows.map((t) =>
      '<tr><td><a href="#/task/' + esc(t.id) + '"><b>' + esc(t.id) + "</b> " + esc(t.title) + "</a></td><td>" + esc(t.agentName) + "</td><td>" + esc(t.assignedBy) + '</td><td><span class="pr ' + esc(t.priority) + '">' + esc(t.priority) + "</span></td><td>" + statusBadge(t.status) + "</td></tr>").join("") + "</table>"
      : '<p class="muted">No tasks yet.</p>';
  }

  // ---- B) live task board ----------------------------------------------------------
  function renderBoard() {
    const sel = (name, label, options) => "<label>" + label + '<select data-f="' + name + '"><option value="">All</option>' + options.map(([v, t]) => '<option value="' + esc(v) + '"' + (filters[name] === v ? " selected" : "") + ">" + esc(t) + "</option>").join("") + "</select></label>";
    main.innerHTML =
      '<div class="head"><div><h1>Live task board</h1><p class="muted">Every task of every employee. Updates every few seconds.</p></div><span id="board-count" class="muted"></span></div>' +
      '<div class="filters card">' +
        sel("employee", "Employee", state.employees.map((e) => [e.id, e.name + " · " + e.title])) +
        sel("status", "Status", STATUSES.map((s) => [s, s])) +
        sel("priority", "Priority", state.priorities.map((p) => [p, p])) +
        '<label>Created from<input type="date" data-f="from" value="' + esc(filters.from) + '"></label>' +
        '<label>Created to<input type="date" data-f="to" value="' + esc(filters.to) + '"></label>' +
      "</div>" +
      '<div id="board" class="board"></div>';
    main.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", () => { filters[el.dataset.f] = el.value; renderBoardColumns(); }));
    renderBoardColumns();
  }
  function renderBoardColumns() {
    const el = $("#board");
    if (!el) return;
    const list = state.tasks.filter((t) =>
      (!filters.employee || t.employeeId === filters.employee) && (!filters.status || t.status === filters.status) &&
      (!filters.priority || t.priority === filters.priority) &&
      (!filters.from || localDay(t.createdAt) >= filters.from) && (!filters.to || localDay(t.createdAt) <= filters.to));
    $("#board-count").textContent = list.length + " of " + state.tasks.length + " tasks";
    el.innerHTML = STATUSES.map((s) => {
      const items = list.filter((t) => t.status === s).reverse();
      return '<div class="col"><h3><span>' + s + "</span><span class=\"muted\">" + items.length + "</span></h3>" + (items.map((t) =>
        '<button class="tcard s-' + stClass(t.status) + '" data-task="' + esc(t.id) + '">' +
          '<div class="meta"><span>' + esc(t.id) + '</span><span class="pr ' + esc(t.priority) + '">' + esc(t.priority) + "</span></div>" +
          '<div class="t">' + esc(t.title) + "</div>" +
          '<div class="meta"><span>' + esc(t.agentName) + "</span><span>" + esc(fmt(t.completedAt || t.startedAt || t.createdAt)) + "</span></div>" +
        "</button>").join("") || '<p class="muted small" style="padding:4px">Nothing here</p>') + "</div>";
    }).join("");
  }
  main.addEventListener("click", (e) => {
    const card = e.target.closest("[data-task]");
    if (card) openTask(card.dataset.task);
  });

  // ---- task details ------------------------------------------------------------------
  const taskDialog = $("#task-dialog");
  function openTask(id) { openTaskId = id; loadTask(id, false); }
  async function loadTask(id, silent) {
    let d;
    try { d = await api("/api/tasks/" + encodeURIComponent(id)); } catch (err) { if (!silent) toast(err.message, true); openTaskId = null; return; }
    if (openTaskId !== id) return;
    const t = d.task;
    const kv = (k, v) => "<div><span>" + k + "</span>" + (v || "<i class=\"muted\">n/a</i>") + "</div>";
    const scroll = $(".output", taskDialog) ? $(".output", taskDialog).scrollTop : 0;
    taskDialog.innerHTML = '<div class="dlg">' +
      '<div class="dlg-head"><div><div class="muted small">' + esc(t.id) + "</div><h2>" + esc(t.title) + '</h2></div><button class="btn small" data-close>Close</button></div>' +
      '<div class="row">' + statusBadge(t.status) + '<span class="pr ' + esc(t.priority) + '">' + esc(t.priority) + "</span></div>" +
      (t.description ? "<div>" + esc(t.description) + "</div>" : "") +
      '<div class="kv">' + kv("Assigned to", esc(t.agentName)) + kv("Assigned by", esc(t.assignedBy)) + kv("Deadline", esc(t.deadline)) +
        kv("Created", esc(fmt(t.createdAt))) + kv("Started", esc(fmt(t.startedAt))) + kv("Completed", esc(fmt(t.completedAt))) +
        kv("Time to complete", dur(t.durationMin)) + kv("Items produced", String(t.outputCount || 0)) + (t.parentId ? kv("Part of", esc(t.parentId)) : "") + "</div>" +
      (t.status === "Blocked" ? '<div class="blocked-box"><b>Blocked:</b> ' + esc(t.blockedReason) + '</div><div><button class="btn primary small" data-retry="' + esc(t.id) + '">Retry task</button></div>' : "") +
      (t.output ? "<div><h3>Output</h3><div class=\"output\">" + esc(t.output) + "</div></div>" : (t.status === "Queued" || t.status === "In Progress" ? '<p class="muted">' + (t.status === "Queued" ? "Waiting in the queue." : "The employee is working on it now.") + "</p>" : "")) +
      (d.subtasks.length ? "<div><h3>Tasks created from this one</h3><table>" + d.subtasks.map((s) => "<tr><td><b>" + esc(s.id) + "</b> " + esc(s.title) + "</td><td>" + esc(s.agentName) + "</td><td>" + statusBadge(s.status) + "</td></tr>").join("") + "</table></div>" : "") +
      (d.leads.length ? "<div><h3>Leads</h3><table><tr><th>Lead</th><th>Source</th><th>Status</th></tr>" + d.leads.map((l) => "<tr><td><b>" + esc(l.id) + "</b> " + esc([l.name, l.company].filter(Boolean).join(", ")) + "<br><span class=\"muted small\">" + esc(l.contact) + "</span></td><td>" + esc(l.source) + "</td><td>" + esc(l.status) + "</td></tr>").join("") + "</table></div>" : "") +
      (d.posts.length ? "<div><h3>Posts</h3><table><tr><th>Post</th><th>Platform</th><th>Status</th></tr>" + d.posts.map((p) => "<tr><td><b>" + esc(p.id) + "</b> " + esc(p.title) + "</td><td>" + esc(p.platform) + "</td><td>" + esc(p.status) + "</td></tr>").join("") + "</table></div>" : "") +
      "</div>";
    if ($(".output", taskDialog)) $(".output", taskDialog).scrollTop = scroll;
    if (!taskDialog.open) taskDialog.showModal();
  }
  taskDialog.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close]") || e.target === taskDialog) taskDialog.close();
    const retry = e.target.closest("[data-retry]");
    if (retry) {
      try { await api("/api/tasks/" + retry.dataset.retry + "/retry", { method: "POST", body: {} }); toast("Task sent back to the queue"); await refresh(); } catch (err) { toast(err.message, true); }
    }
  });
  taskDialog.addEventListener("close", () => { openTaskId = null; if (location.hash.startsWith("#/task/")) history.replaceState(null, "", "#/board"); });

  // ---- C) reports ----------------------------------------------------------------------
  function bars(rows, series) {
    // rows: [{label, values: [n, ...]}], series: [{name, color}]
    const W = 420, H = 190, padL = 28, padB = 26, padT = 10;
    const max = Math.max(1, ...rows.flatMap((r) => r.values));
    const step = (W - padL - 8) / rows.length;
    const bw = Math.min(26, (step - 8) / series.length);
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    let out = '<svg viewBox="0 0 ' + W + " " + H + '" role="img">';
    for (const g of [...new Set([0, Math.round(max / 2), max])]) {
      const yy = y(g);
      out += '<line x1="' + padL + '" x2="' + (W - 4) + '" y1="' + yy + '" y2="' + yy + '" stroke="#e3e6e1"/><text x="' + (padL - 6) + '" y="' + (yy + 4) + '" font-size="10" text-anchor="end" fill="#68716c">' + g + "</text>";
    }
    rows.forEach((r, i) => {
      const x0 = padL + i * step + (step - bw * series.length) / 2;
      r.values.forEach((v, k) => {
        const yy = y(v), hh = Math.max(0, H - padB - yy);
        out += '<rect x="' + (x0 + k * bw) + '" y="' + yy + '" width="' + (bw - 2) + '" height="' + hh + '" rx="3" fill="' + series[k].color + '"><title>' + esc(r.label + ": " + v + " " + series[k].name) + "</title></rect>";
        if (v > 0) out += '<text x="' + (x0 + k * bw + (bw - 2) / 2) + '" y="' + (yy - 3) + '" font-size="10" text-anchor="middle" fill="#171b19">' + v + "</text>";
      });
      out += '<text x="' + (padL + i * step + step / 2) + '" y="' + (H - 8) + '" font-size="10" text-anchor="middle" fill="#68716c">' + esc(r.label) + "</text>";
    });
    out += "</svg>";
    if (series.length > 1) out += '<div class="legend">' + series.map((s) => '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + "</span>").join("") + "</div>";
    return out;
  }

  async function renderReports() {
    main.innerHTML =
      '<div class="head"><div><h1>Reports</h1><p class="muted" id="rep-sub">Loading…</p></div>' +
      '<div class="row no-print"><div class="seg"><button data-range="daily">Daily</button><button data-range="weekly">Weekly</button></div>' +
      '<a class="btn small" data-csv="summary">CSV report</a><a class="btn small" data-csv="tasks">CSV tasks</a><a class="btn small" data-csv="leads">CSV leads</a><a class="btn small" data-csv="posts">CSV posts</a>' +
      '<button class="btn small" id="print">Save as PDF</button><button class="btn small lime" id="send-email">Email report now</button></div></div>' +
      '<div id="rep-body"></div>';
    main.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => { reportRange = b.dataset.range; loadReport(); }));
    $("#print").addEventListener("click", () => window.print());
    $("#send-email").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { const r = await api("/api/reports/send-email", { method: "POST", body: {} }); toast("Email sent: " + r.subject); } catch (err) { toast(err.message, true); }
      e.target.disabled = false;
    });
    await loadReport();
  }
  async function loadReport() {
    try { report = await api("/api/reports?range=" + reportRange); } catch (err) { toast(err.message, true); return; }
    if (view !== "reports") return;
    main.querySelectorAll("[data-range]").forEach((b) => b.classList.toggle("on", b.dataset.range === reportRange));
    main.querySelectorAll("[data-csv]").forEach((a) => { a.href = "/api/reports/export.csv?kind=" + a.dataset.csv + "&range=" + reportRange; });
    const r = report, s = r.summary;
    $("#rep-sub").textContent = r.agency + " " + r.range + " report, " + (r.from === r.to ? r.to : r.from + " to " + r.to) + ". Generated " + r.generatedAt + " from the live ledger.";
    const tile = (n, label) => '<div class="tile"><b>' + n + "</b><span>" + label + "</span></div>";
    const short = (d) => d.slice(5);
    $("#rep-body").innerHTML =
      '<div class="tiles">' + tile(s.tasksCompleted, "Tasks completed") + tile(s.tasksInProgress + s.tasksQueued, "In progress or queued") + tile(s.tasksBlocked, "Blocked") +
        tile(s.leadsGenerated, "Leads generated") + tile(s.postsCreated, "Posts created") + tile(s.postsPublished, "Posts published") +
        tile(s.followUps, "Follow-ups") + tile(s.retentionMessages, "Retention messages") + tile(s.reviewReplies, "Review replies") + tile(s.insights, "Insights") + "</div>" +
      '<div class="charts">' +
        '<div class="card chart"><h3>Tasks completed, last 7 days</h3>' + bars(r.days.map((d) => ({ label: short(d.date), values: [d.completed] })), [{ name: "tasks", color: "#1f8a4c" }]) + "</div>" +
        '<div class="card chart"><h3>Leads generated, last 7 days</h3>' + bars(r.days.map((d) => ({ label: short(d.date), values: [d.leads] })), [{ name: "leads", color: "#1d6fe0" }]) + "</div>" +
        '<div class="card chart"><h3>Posts, last 7 days</h3>' + bars(r.days.map((d) => ({ label: short(d.date), values: [d.postsCreated, d.postsPublished] })), [{ name: "created", color: "#9aa39d" }, { name: "published", color: "#101412" }]) + "</div>" +
        '<div class="card chart"><h3>Tasks completed by employee (' + r.range + ")</h3>" + bars(r.perEmployee.map((e) => ({ label: e.name, values: [e.completed] })), [{ name: "tasks", color: "#7a9a00" }]) + "</div>" +
      "</div>" +
      '<div class="section"><h2>Per employee</h2><div class="card table-wrap"><table><tr><th>Employee</th><th>Completed</th><th>Pending</th><th>Blocked</th><th>Avg completion</th><th>KPI</th></tr>' +
        r.perEmployee.map((e) => "<tr><td><b>" + esc(e.name) + '</b><br><span class="muted small">' + esc(e.title) + "</span></td><td>" + e.completed + "</td><td>" + e.pending + "</td><td>" + e.blocked + "</td><td>" + dur(e.avgCompletionMin) + "</td><td>" + esc(e.kpiLabel) + ": <b>" + e.kpiValue + "</b></td></tr>").join("") + "</table></div></div>" +
      '<div class="section"><h2>Leads (' + r.leads.length + ')</h2><div class="card table-wrap">' + (r.leads.length ? "<table><tr><th>Lead</th><th>Company</th><th>Contact</th><th>Source</th><th>Status</th><th>Time</th></tr>" +
        r.leads.map((l) => "<tr><td><b>" + esc(l.id) + "</b> " + esc(l.name) + "</td><td>" + esc(l.company) + "</td><td>" + esc(l.contact) + "</td><td>" + (l.sourceUrl ? '<a href="' + esc(l.sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(l.source) + "</a>" : esc(l.source)) + "</td><td>" + esc(l.status) + "</td><td>" + esc(l.time) + "</td></tr>").join("") + "</table>" : '<p class="muted">No leads in this period.</p>') + "</div></div>" +
      '<div class="section"><h2>Posts (' + r.posts.length + ')</h2><div class="card table-wrap">' + (r.posts.length ? "<table><tr><th>Post</th><th>Platform</th><th>Status</th><th>Created</th><th>Published</th><th></th></tr>" +
        r.posts.map((p) => "<tr><td><b>" + esc(p.id) + "</b> " + esc(p.title) + "</td><td>" + esc(p.platform) + "</td><td>" + esc(p.status) + "</td><td>" + esc(p.created) + "</td><td>" + esc(p.published) + (p.link ? ' <a href="' + esc(p.link) + '" target="_blank" rel="noopener noreferrer">link</a>' : "") + "</td><td>" +
          (p.status !== "Published" ? '<button class="btn small no-print" data-publish="' + esc(p.id) + '">Mark published</button>' : "") + "</td></tr>").join("") + "</table>" : '<p class="muted">No posts in this period.</p>') + "</div></div>" +
      '<div class="section"><h2>Blocked tasks (' + r.blocked.length + ')</h2><div class="card table-wrap">' + (r.blocked.length ? "<table><tr><th>Task</th><th>Employee</th><th>Why</th></tr>" +
        r.blocked.map((t) => '<tr><td><a href="#/task/' + esc(t.id) + '"><b>' + esc(t.id) + "</b> " + esc(t.title) + "</a></td><td>" + esc(t.employee) + "</td><td>" + esc(t.reason) + "</td></tr>").join("") + "</table>" : '<p class="muted">No blocked tasks.</p>') + "</div></div>";
  }
  setInterval(() => { if (view === "reports" && !$("#post-dialog").open) loadReport(); }, 15000);

  const postDialog = $("#post-dialog");
  main.addEventListener("click", (e) => {
    const b = e.target.closest("[data-publish]");
    if (!b) return;
    postDialog.innerHTML = '<form class="dlg" method="dialog"><h2>Approve and mark ' + esc(b.dataset.publish) + ' as published</h2><p class="muted">Publish the post on its platform, then paste the link here. The link is optional.</p>' +
      '<label>Link to the published post<input name="link" type="url" placeholder="https://"></label><div class="row"><button class="btn primary" value="ok">Mark published</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div></form>';
    postDialog.dataset.post = b.dataset.publish;
    postDialog.returnValue = "";
    postDialog.showModal();
  });
  postDialog.addEventListener("close", async () => {
    if (postDialog.returnValue !== "ok") return;
    try {
      await api("/api/posts/" + postDialog.dataset.post + "/publish", { method: "POST", body: { link: $("input[name=link]", postDialog).value.trim() } });
      toast("Post marked as published");
      await refresh(); await loadReport();
    } catch (err) { toast(err.message, true); }
  });

  // ---- D) chat ----------------------------------------------------------------------------
  const PM_QUESTIONS = ["How many tasks are currently running?", "What is the status of the sales team? How many leads were generated today? Give me the details.", "How many posts were published today, and on which platforms?", "Which tasks are blocked, and why?", "Which employee completed the most tasks this week?"];
  async function renderChat(channel) {
    chatChannel = state.employees.some((e) => e.id === channel) ? channel : "pm";
    const emp = state.employees.find((e) => e.id === chatChannel);
    main.innerHTML =
      '<div class="head"><div><h1>Chat</h1><p class="muted">Talk to the Project Manager or any employee. Answers come from the live ledger, and the history is saved.</p></div></div>' +
      '<div class="chat"><div class="card channels">' + state.employees.map((e) => '<a href="#/chat/' + esc(e.id) + '" class="' + (e.id === chatChannel ? "active" : "") + '">' + esc(e.name) + "<span>" + esc(e.title) + "</span></a>").join("") + "</div>" +
      '<div class="card thread"><div id="msgs" class="msgs"></div>' +
      (emp.isManager ? '<div class="suggest">' + PM_QUESTIONS.map((q, i) => '<button data-q="' + i + '">' + esc(q.length > 46 ? q.slice(0, 44) + "…" : q) + "</button>").join("") + "</div>" : "") +
      '<form id="chat-form" class="composer"><textarea name="message" maxlength="4000" placeholder="Message ' + esc(emp.name) + '…" required></textarea><button class="btn primary" type="submit">Send</button></form></div></div>';
    const form = $("#chat-form");
    form.addEventListener("submit", (e) => { e.preventDefault(); sendChat(form.elements.message.value); });
    form.elements.message.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(form.elements.message.value); } });
    main.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => sendChat(PM_QUESTIONS[Number(b.dataset.q)])));
    try {
      const res = await api("/api/chat?channel=" + encodeURIComponent(chatChannel));
      if (res.channel === chatChannel) { $("#msgs").innerHTML = ""; res.messages.forEach(addMsg); if (!res.messages.length) $("#msgs").innerHTML = '<p class="muted" id="empty-chat">No messages yet. Ask ' + esc(emp.name) + " something.</p>"; }
    } catch (err) { toast(err.message, true); }
  }
  function addMsg(m) {
    const box = $("#msgs");
    if (!box) return;
    const empty = $("#empty-chat"); if (empty) empty.remove();
    const el = document.createElement("div");
    el.className = "msg " + (m.role === "boss" ? "boss" : "agent");
    el.textContent = m.text;
    const meta = document.createElement("small");
    meta.textContent = (m.from || "") + (m.createdAt ? " · " + fmt(m.createdAt) : "");
    el.appendChild(meta);
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }
  async function sendChat(text) {
    text = String(text || "").trim();
    if (!text || chatBusy) return;
    const channel = chatChannel;
    chatBusy = true;
    const form = $("#chat-form");
    form.elements.message.value = "";
    const mine = addMsg({ role: "boss", from: "Boss", text });
    const wait = addMsg({ role: "agent", from: "", text: "Checking the ledger…" });
    try {
      const res = await api("/api/chat", { method: "POST", body: { channel, message: text } });
      if (chatChannel === channel) { mine.remove(); wait.remove(); res.messages.forEach(addMsg); }
      if (res.created.length) { toast("Created " + res.created.join(", ")); refresh().catch(() => {}); }
    } catch (err) { wait.remove(); toast(err.message, true); }
    chatBusy = false;
  }

  // ---- start ----------------------------------------------------------------------------------
  api("/api/me").then((me) => (me.authed ? showApp() : showLogin())).catch(showLogin);
})();
