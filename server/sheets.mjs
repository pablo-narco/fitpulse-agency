// Google Sheets + email bridge. Talks to the Apps Script web app in bridges/apps-script/Code.gs.
import { config, localStamp } from "./config.mjs";

const taskLink = (t) => (config.publicUrl ? config.publicUrl + "/boss#/task/" + t.id : "/boss#/task/" + t.id);
const stamp = (v) => (v ? localStamp(v) : "");

// One tab per collection. The first column is the row key. "Raw" keeps the full record so the
// dashboard can be restored from the sheet after a restart (the sheet is the database of record).
export const TABS = {
  tasks: {
    tab: "Ledger",
    columns: [
      ["Task ID", (t) => t.id],
      ["Timestamp", (t) => stamp(t.createdAt)],
      ["Assigned By", (t) => t.assignedBy],
      ["Agent Name", (t) => t.agentName],
      ["Task Description", (t) => t.description || t.title],
      ["Priority", (t) => t.priority],
      ["Status", (t) => t.status],
      ["Output / Result Link", (t) => (t.status === "Completed" || t.status === "Blocked" ? taskLink(t) : "")],
      ["Completion Time", (t) => stamp(t.completedAt)],
      ["Title", (t) => t.title],
      ["Deadline", (t) => t.deadline || ""],
      ["Duration (min)", (t) => (t.durationMin ?? "")],
      ["Blocked Reason", (t) => t.blockedReason || ""],
    ],
  },
  leads: {
    tab: "Leads",
    columns: [
      ["Lead ID", (l) => l.id], ["Timestamp", (l) => stamp(l.createdAt)], ["Name", (l) => l.name], ["Company", (l) => l.company],
      ["Contact", (l) => l.contact], ["Source", (l) => l.source], ["Source URL", (l) => l.sourceUrl], ["Status", (l) => l.status],
      ["Found By", (l) => l.foundBy], ["Task ID", (l) => l.taskId], ["Notes", (l) => l.notes],
    ],
  },
  posts: {
    tab: "Posts",
    columns: [
      ["Post ID", (p) => p.id], ["Created", (p) => stamp(p.createdAt)], ["Platform", (p) => p.platform], ["Title", (p) => p.title],
      ["Text", (p) => p.body], ["Status", (p) => p.status], ["Published At", (p) => stamp(p.publishedAt)], ["Link", (p) => p.link],
      ["Author", (p) => p.author], ["Task ID", (p) => p.taskId],
    ],
  },
  outputs: {
    tab: "Outputs",
    columns: [
      ["Output ID", (o) => o.id], ["Timestamp", (o) => stamp(o.createdAt)], ["Employee", (o) => o.agentName], ["Kind", (o) => o.kind],
      ["Title", (o) => o.title], ["Details", (o) => o.details], ["Task ID", (o) => o.taskId],
    ],
  },
  chat: {
    tab: "Chat",
    columns: [
      ["Message ID", (m) => m.id], ["Timestamp", (m) => stamp(m.createdAt)], ["Channel", (m) => m.channelName],
      ["From", (m) => m.from], ["Text", (m) => m.text],
    ],
  },
};

const MAX_CELL = 45000;
function cell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  let s = String(v);
  if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL) + " ...[truncated]";
  // Stop Sheets from reading text as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

function rawJson(record) {
  let s = JSON.stringify(record);
  if (s.length > MAX_CELL) {
    const copy = { ...record };
    for (const k of ["output", "body", "details", "text"]) {
      if (typeof copy[k] === "string" && copy[k].length > 8000) copy[k] = copy[k].slice(0, 8000) + " ...[truncated]";
    }
    s = JSON.stringify(copy);
  }
  return s;
}

export const sheets = {
  enabled: Boolean(config.sheetsWebAppUrl && config.bridgeSecret),
  lastSyncAt: null,
  lastError: null,
  pending: new Map(),
  timer: null,
  flushing: false,
  failures: 0,

  status() {
    return { enabled: this.enabled, lastSyncAt: this.lastSyncAt, lastError: this.lastError, pending: this.pending.size, sheetUrl: config.sheetUrl };
  },

  async call(body, timeoutMs = 60000) {
    if (!this.enabled) throw new Error("Google Sheets bridge is not configured (SHEETS_WEBAPP_URL and BRIDGE_SECRET).");
    const res = await fetch(config.sheetsWebAppUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: config.bridgeSecret, ...body }),
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("Bridge returned a non-JSON answer (HTTP " + res.status + "). Check that the Apps Script web app is deployed with access 'Anyone'."); }
    if (!json.ok) throw new Error("Bridge error: " + (json.error || "unknown"));
    return json;
  },

  queue(collection, record) {
    if (!this.enabled) return;
    const def = TABS[collection];
    if (!def) return;
    const headers = def.columns.map((c) => c[0]).concat("Raw");
    const row = def.columns.map((c) => cell(c[1](record))).concat(rawJson(record));
    this.pending.set(def.tab + "\u0000" + record.id, { tab: def.tab, headers, row });
    this.schedule(1500);
  },

  schedule(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, ms);
    this.timer.unref?.();
  },

  async flush() {
    if (this.flushing || !this.pending.size) return;
    this.flushing = true;
    const batch = [...this.pending.entries()].slice(0, 60);
    try {
      await this.call({ action: "upsert", ops: batch.map(([, op]) => op) });
      for (const [key, op] of batch) if (this.pending.get(key) === op) this.pending.delete(key);
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
      this.failures = 0;
    } catch (err) {
      this.failures++;
      this.lastError = err.message;
      console.error("[sheets] sync failed:", err.message);
    } finally {
      this.flushing = false;
      if (this.pending.size) this.schedule(this.failures ? Math.min(60000, 3000 * 2 ** this.failures) : 300);
    }
  },

  // Returns { tasks: [...], leads: [...], ... } rebuilt from the Raw column of every tab.
  async readAll() {
    const out = {};
    const res = await this.call({ action: "read", tabs: Object.values(TABS).map((d) => d.tab) }, 90000);
    for (const [collection, def] of Object.entries(TABS)) {
      const rows = (res.tabs && res.tabs[def.tab]) || [];
      const list = [];
      for (const row of rows.slice(1)) {
        const raw = row[row.length - 1];
        if (typeof raw !== "string" || !raw.startsWith("{")) continue;
        try { const rec = JSON.parse(raw); if (rec && rec.id) list.push(rec); } catch { /* skip a damaged row */ }
      }
      out[collection] = list;
    }
    this.lastSyncAt = new Date().toISOString();
    return out;
  },

  async sendEmail({ to, subject, html }) {
    return this.call({ action: "email", to, subject, html });
  },
};
