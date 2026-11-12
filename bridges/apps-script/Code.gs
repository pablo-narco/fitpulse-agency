/**
 * FitPulse AI: Google Sheets + Email bridge.
 *
 * Paste this file into the Apps Script editor of your ledger spreadsheet
 * (Extensions > Apps Script), fill in CONFIG, then:
 *   1. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
 *      Copy the web app URL into SHEETS_WEBAPP_URL on the server.
 *   2. Run setupTriggers() once from the editor and allow the permissions.
 *
 * What it does:
 *   - doPost: the server writes ledger rows (upsert), reads the tabs back, and sends email.
 *   - sendDailyReport: every day asks the server for the Project Manager's report and emails it.
 *   - tick: every 10 minutes wakes the server so scheduled routines and queued tasks run.
 */
const CONFIG = {
  SECRET: "PASTE_THE_SAME_VALUE_AS_BRIDGE_SECRET",   // must equal BRIDGE_SECRET on the server
  SERVER_URL: "https://your-app.onrender.com",       // public URL of the dashboard, no slash at the end
  BOSS_EMAIL: "you@example.com",                     // where the daily report goes
  REPORT_HOUR: 18,                                   // hour of the day (spreadsheet time zone) for the daily email
};

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: "invalid JSON" }); }
  if (!body || body.secret !== CONFIG.SECRET) return json_({ ok: false, error: "unauthorized" });
  try {
    if (body.action === "upsert") return json_({ ok: true, written: upsert_(body.ops || []) });
    if (body.action === "read") return json_({ ok: true, tabs: read_(body.tabs || []) });
    if (body.action === "email") {
      MailApp.sendEmail({ to: body.to || CONFIG.BOSS_EMAIL, subject: String(body.subject || "FitPulse AI report"), htmlBody: String(body.html || "") });
      return json_({ ok: true });
    }
    if (body.action === "ping") return json_({ ok: true, sheet: SpreadsheetApp.getActive().getUrl() });
    return json_({ ok: false, error: "unknown action" });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return json_({ ok: true, service: "FitPulse AI bridge" });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Text that starts like a formula is stored as plain text.
function safe_(v) {
  if (typeof v !== "string") return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (headers && headers.length) {
    const current = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    if (current.join("\u0001") !== headers.join("\u0001")) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

// ops: [{ tab, headers: [...], row: [...] }]. The first cell of a row is its key.
function upsert_(ops) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const byTab = {};
    ops.forEach(function (op) { (byTab[op.tab] = byTab[op.tab] || []).push(op); });
    let written = 0;
    Object.keys(byTab).forEach(function (tab) {
      const list = byTab[tab];
      const sh = sheet_(tab, list[0].headers);
      const last = sh.getLastRow();
      const index = {};
      if (last > 1) {
        sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) { index[String(r[0])] = i + 2; });
      }
      let next = Math.max(last, 1) + 1;
      list.forEach(function (op) {
        const row = op.row.map(safe_);
        const key = String(op.row[0]);
        let at = index[key];
        if (!at) { at = next++; index[key] = at; }
        sh.getRange(at, 1, 1, row.length).setValues([row]);
        written++;
      });
    });
    SpreadsheetApp.flush();
    return written;
  } finally {
    lock.releaseLock();
  }
}

function read_(tabs) {
  const ss = SpreadsheetApp.getActive();
  const out = {};
  tabs.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    out[name] = sh && sh.getLastRow() > 0 ? sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues() : [];
  });
  return out;
}

function fetchServer_(path) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // A free host can be asleep: the first call wakes it and may take up to a minute.
      const res = UrlFetchApp.fetch(CONFIG.SERVER_URL + path, { method: "get", headers: { "x-cron-key": CONFIG.SECRET }, muteHttpExceptions: true });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
      lastError = "HTTP " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200);
    } catch (err) { lastError = String(err); }
    Utilities.sleep(20000);
  }
  throw new Error("Server did not answer: " + lastError);
}

/** Daily email node: the Project Manager's status bulletin, built by the server from live data. */
function sendDailyReport() {
  const report = fetchServer_("/api/cron/daily-report");
  MailApp.sendEmail({ to: CONFIG.BOSS_EMAIL, subject: report.subject, htmlBody: report.html });
}

/** Keeps the agency working: runs scheduled routines and queued tasks. */
function tick() {
  fetchServer_("/api/cron/tick");
}

/** Run once from the editor. Creates the daily email trigger and the 10 minute tick. */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendDailyReport").timeBased().everyDays(1).atHour(CONFIG.REPORT_HOUR).create();
  ScriptApp.newTrigger("tick").timeBased().everyMinutes(10).create();
}
