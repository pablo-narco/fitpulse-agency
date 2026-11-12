#!/usr/bin/env node
/*
 * Hires the 8 FitPulse AI employees with the official ai-employees installer.
 *
 *   node scripts/hire-team.mjs
 *
 * For every employee in agency/team.json it:
 *   1. runs `node vendor/ai-employees/installer/cli.mjs hire <kit> --to agency/employees/<kit>`
 *      (the installer copies the kit and writes its .installed.json receipt),
 *   2. writes AGENCY-ROLE.md, the FitPulse role definition layered on top of the kit,
 *   3. writes agency/.installed.json, one manifest for the whole 7+1 team.
 *
 * Safe to run again: an employee that is already hired is left untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "vendor", "ai-employees");
const AGENCY = path.join(ROOT, "agency");
const REPO = "https://github.com/markfulton/ai-employees";

function log(s) { process.stdout.write(s + "\n"); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

if (!fs.existsSync(path.join(VENDOR, "installer", "cli.mjs"))) {
  log("Cloning " + REPO + " into vendor/ai-employees ...");
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  const r = spawnSync("git", ["clone", "--depth", "1", REPO, VENDOR], { stdio: "inherit" });
  if (r.status !== 0) { log("git clone failed. Download the repository ZIP and extract it to vendor/ai-employees."); process.exit(1); }
}

const team = readJson(path.join(AGENCY, "team.json"));
const kitVersion = readJson(path.join(VENDOR, "package.json")).version;
const manifest = {
  schema: "fitpulse-agency/1",
  agency: team.agency.name,
  type: team.agency.type,
  source: { repository: REPO, version: kitVersion },
  hired_on: new Date().toISOString().slice(0, 10),
  employees: [],
};

function roleMarkdown(e) {
  const list = (a) => a.map((x) => "- " + x).join("\n");
  const routines = team.routines.filter((r) => r.employee === e.id);
  return [
    "# " + e.name + ": " + e.title,
    "",
    "Agency: " + team.agency.name + " (" + team.agency.type + ")",
    "Built on the ai-employees kit: `" + e.kit + "`",
    "",
    "## Responsibilities", list(e.responsibilities), "",
    "## Inputs", e.inputs, "",
    "## Outputs", e.outputs, "",
    "## Tools and integrations", list(e.tools), "",
    "## KPIs", list(e.kpis), "",
    "## Workflow", "Reports to: " + e.reportsTo, "", "Hands work over to: " + e.handsOverTo, "",
    "## Scheduled routines",
    routines.length
      ? routines.map((r) => "- `" + r.id + "` at " + r.time + " (" + r.days + "): " + r.description).join("\n")
      : "- None. Works on tasks assigned by the Boss and on the daily audit.",
    "",
    "## Guardrails",
    "- Works only from real data in the ledger. Never invents numbers, leads or links.",
    "- Publishing and outbound messages go only to channels the Boss has released. Everything else waits for approval.",
    "- If something needed for the task is missing, sets the task to Blocked and says exactly what is missing.",
    "",
  ].join("\n");
}

for (const e of team.employees) {
  const dst = path.join(AGENCY, "employees", e.kit);
  if (fs.existsSync(path.join(dst, ".installed.json"))) {
    log("Already hired: " + e.name + " (" + e.title + ") in agency/employees/" + e.kit);
  } else {
    log("Hiring " + e.name + " (" + e.title + ") from kit " + e.kit + " ...");
    const r = spawnSync(process.execPath, [path.join(VENDOR, "installer", "cli.mjs"), "hire", e.kit, "--to", dst], { encoding: "utf8" });
    // The installer prints its long install prompt after a line of "=". Show only the part before it.
    const head = (r.stdout || "").split("=".repeat(78))[0].trim();
    log(head.split("\n").map((l) => "    " + l).join("\n"));
    if (r.status !== 0) { log((r.stderr || "").trim()); log("Hire failed for " + e.kit); process.exit(1); }
  }
  fs.writeFileSync(path.join(dst, "AGENCY-ROLE.md"), roleMarkdown(e));
  const receipt = readJson(path.join(dst, ".installed.json"));
  manifest.employees.push({
    id: e.id,
    name: e.name,
    title: e.title,
    kit: e.kit,
    kit_version: receipt.version,
    standard: receipt.standard,
    installed_on: receipt.installed_on,
    folder: "agency/employees/" + e.kit,
    receipt: "agency/employees/" + e.kit + "/.installed.json",
    role_file: "agency/employees/" + e.kit + "/AGENCY-ROLE.md",
    kit_files: Object.keys(receipt.files || {}).length,
    reports_to: e.reportsTo,
  });
}

fs.writeFileSync(path.join(AGENCY, ".installed.json"), JSON.stringify(manifest, null, 2) + "\n");
log("");
log("Wrote agency/.installed.json: " + manifest.employees.length + " employees hired (1 Project Manager + " + (manifest.employees.length - 1) + " specialists).");
