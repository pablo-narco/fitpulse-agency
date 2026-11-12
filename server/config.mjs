import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dependencies). Real environment variables win.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;
const generatedPassword = env.BOSS_PASSWORD ? null : crypto.randomBytes(9).toString("base64url");

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, ""),
  timezone: env.TIMEZONE || "UTC",
  bossUsername: env.BOSS_USERNAME || "boss",
  bossPassword: env.BOSS_PASSWORD || generatedPassword,
  generatedPassword,
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  bossEmail: env.BOSS_EMAIL || "",
  // Google Sheets + email bridge (Apps Script web app)
  sheetsWebAppUrl: env.SHEETS_WEBAPP_URL || "",
  bridgeSecret: env.BRIDGE_SECRET || "",
  sheetUrl: env.SHEET_URL || "",
  // LLM
  llmProvider: (env.LLM_PROVIDER || "").toLowerCase(),
  llmModel: env.LLM_MODEL || "",
  anthropicKey: env.ANTHROPIC_API_KEY || "",
  geminiKey: env.GEMINI_API_KEY || "",
  openaiKey: env.OPENAI_API_KEY || "",
  openaiBaseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  webSearch: (env.WEB_SEARCH || "true").toLowerCase() !== "false",
  // Released publishing channel (Telegram)
  telegramToken: env.TELEGRAM_BOT_TOKEN || "",
  telegramChannel: env.TELEGRAM_CHANNEL || "",
  // Autonomy
  autopilot: (env.AUTOPILOT || "true").toLowerCase() !== "false",
  workerConcurrency: Math.max(1, Number(env.WORKER_CONCURRENCY || 2)),
  // Client the agency works for (used in agent prompts)
  clientName: env.CLIENT_NAME || "the client fitness club",
  clientCity: env.CLIENT_CITY || "",
  clientInfo: env.CLIENT_INFO || "",
};

// ---- time helpers in the agency timezone ---------------------------------
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hour12: false });
const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, weekday: "short" });

export function localDate(d = new Date()) { return dateFmt.format(new Date(d)); }            // YYYY-MM-DD
export function localTime(d = new Date()) { return timeFmt.format(new Date(d)).slice(0, 5); } // HH:MM
export function localDow(d = new Date()) { return dowFmt.format(new Date(d)).toLowerCase().slice(0, 3); } // mon..sun
export function localStamp(d = new Date()) { return localDate(d) + " " + localTime(d); }
export function daysAgoDate(n) { return localDate(new Date(Date.now() - n * 86400000)); }
export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
