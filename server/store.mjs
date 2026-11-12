// In-memory store, mirrored to a local JSON file and to the Google Sheet ledger.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { sheets, TABS } from "./sheets.mjs";

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const FILE = path.join(DATA_DIR, "db.json");
const PREFIX = { tasks: ["T-", 4], leads: ["L-", 4], posts: ["P-", 4], outputs: ["O-", 4], chat: ["M-", 6] };

export const db = { tasks: [], leads: [], posts: [], outputs: [], chat: [] };
const counters = {};
let saveTimer = null;

function recount() {
  for (const [c, [p]] of Object.entries(PREFIX)) {
    counters[c] = db[c].reduce((max, r) => Math.max(max, Number(String(r.id).slice(p.length)) || 0), 0);
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE + ".tmp", JSON.stringify(db));
      fs.renameSync(FILE + ".tmp", FILE);
    } catch (err) { console.error("[store] could not write " + FILE + ": " + err.message); }
  }, 500);
  saveTimer.unref?.();
}

export const store = {
  source: "empty",

  async init() {
    try {
      if (fs.existsSync(FILE)) {
        const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
        for (const c of Object.keys(db)) if (Array.isArray(saved[c])) db[c] = saved[c];
        this.source = "local file";
      }
    } catch (err) { console.error("[store] could not read " + FILE + ": " + err.message); }

    if (sheets.enabled) {
      try {
        const remote = await sheets.readAll();
        const remoteCount = Object.values(remote).reduce((n, l) => n + l.length, 0);
        if (remoteCount > 0) {
          // The sheet is the database of record: it survives restarts of the host.
          for (const c of Object.keys(db)) db[c] = remote[c] || [];
          this.source = "Google Sheet";
        } else {
          for (const c of Object.keys(TABS)) for (const r of db[c]) sheets.queue(c, r);
          if (this.source === "empty") this.source = "new";
        }
      } catch (err) {
        sheets.lastError = err.message;
        console.error("[store] could not load the Google Sheet: " + err.message);
      }
    }
    for (const c of Object.keys(db)) db[c].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    // A task caught mid-run by a restart goes back to the queue.
    for (const t of db.tasks) if (t.status === "In Progress") { t.status = "Queued"; t.startedAt = null; sheets.queue("tasks", t); }
    recount();
    saveSoon();
    console.log("[store] loaded " + db.tasks.length + " tasks, " + db.leads.length + " leads, " + db.posts.length + " posts (source: " + this.source + ")");
  },

  nextId(collection) {
    const [p, width] = PREFIX[collection];
    counters[collection] = (counters[collection] || 0) + 1;
    return p + String(counters[collection]).padStart(width, "0");
  },

  add(collection, record) {
    if (!record.id) record.id = this.nextId(collection);
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    db[collection].push(record);
    this.touch(collection, record);
    return record;
  },

  // Call after changing a record in place.
  touch(collection, record) {
    record.updatedAt = new Date().toISOString();
    saveSoon();
    sheets.queue(collection, record);
  },

  get(collection, id) { return db[collection].find((r) => r.id === id) || null; },
};
