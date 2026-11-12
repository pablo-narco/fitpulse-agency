// One small LLM client for three kinds of provider: Anthropic, Google Gemini, and any
// OpenAI-compatible API (OpenAI, Groq, OpenRouter ...). No SDKs, only fetch.
import { config } from "./config.mjs";

function pickProvider() {
  if (config.llmProvider) return config.llmProvider;
  if (config.anthropicKey) return "anthropic";
  if (config.geminiKey) return "gemini";
  if (config.openaiKey) return "openai";
  return "";
}

export const llm = {
  provider: pickProvider(),
  model: config.llmModel,
  lastError: null,
  get enabled() { return Boolean(this.provider); },
  status() { return { enabled: this.enabled, provider: this.provider || null, model: this.model || null, lastError: this.lastError }; },
};

async function postJson(url, headers, body, timeoutMs = 120000) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      const err = new Error("HTTP " + res.status + ": " + text.slice(0, 400));
      err.status = res.status;
      if (res.status === 429 || res.status >= 500) { lastErr = err; await new Promise((r) => setTimeout(r, 2500 * (attempt + 1))); continue; }
      throw err;
    } catch (err) {
      if (err.status && err.status !== 429 && err.status < 500) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---- Anthropic -----------------------------------------------------------
async function anthropic({ system, messages, maxTokens, search }) {
  const model = llm.model || "claude-haiku-5-5";
  llm.model = model;
  const headers = { "x-api-key": config.anthropicKey, "anthropic-version": "2023-06-01" };
  const body = { model, max_tokens: maxTokens, system, messages: messages.map((m) => ({ role: m.role, content: m.content })) };
  if (search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
  let text = "";
  const sources = new Map();
  let searched = false;
  for (let turn = 0; turn < 4; turn++) {
    const res = await postJson("https://api.anthropic.com/v1/messages", headers, body, 180000);
    for (const block of res.content || []) {
      if (block.type === "text") {
        text += block.text;
        for (const c of block.citations || []) if (c.url) sources.set(c.url, c.title || c.url);
      } else if (block.type === "web_search_tool_result") {
        searched = true;
        if (Array.isArray(block.content)) for (const r of block.content) if (r.url) sources.set(r.url, r.title || r.url);
      }
    }
    if (res.stop_reason !== "pause_turn") break;
    body.messages = body.messages.concat({ role: "assistant", content: res.content }); // continue a paused search turn
  }
  return { text, sources: [...sources].map(([url, title]) => ({ url, title })), searched };
}

// ---- Gemini --------------------------------------------------------------
let geminiCandidates = null;
async function geminiModels() {
  if (llm.model) return [llm.model];
  if (geminiCandidates) return geminiCandidates;
  // Model names change often, so ask the API which Flash models this key can use.
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": config.geminiKey }, signal: AbortSignal.timeout(20000),
    });
    const json = await res.json();
    const names = (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n));
    const version = (n) => Number((n.match(/^gemini-([\d.]+)/) || [])[1]) || 0;
    names.sort((a, b) => version(b) - version(a) || a.length - b.length);
    if (names.length) geminiCandidates = names.slice(0, 4);
  } catch { /* fall through to the default below */ }
  if (!geminiCandidates) geminiCandidates = ["gemini-2.5-flash"];
  return geminiCandidates;
}

async function gemini({ system, messages, maxTokens, search }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: Math.max(maxTokens, 4096) },
  };
  if (search) body.tools = [{ google_search: {} }];
  let lastErr;
  for (const model of await geminiModels()) {
    try {
      const res = await postJson("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
        { "x-goog-api-key": config.geminiKey }, body, 180000);
      const cand = (res.candidates || [])[0] || {};
      const text = ((cand.content || {}).parts || []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
      if (!text) throw new Error("Gemini returned no text (finish reason: " + (cand.finishReason || "unknown") + ")");
      const chunks = (cand.groundingMetadata || {}).groundingChunks || [];
      const sources = chunks.filter((c) => c.web && c.web.uri).map((c) => ({ url: c.web.uri, title: c.web.title || c.web.uri }));
      llm.model = model;
      if (!config.llmModel) geminiCandidates = [model];
      return { text, sources, searched: sources.length > 0 };
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// ---- OpenAI-compatible ---------------------------------------------------
async function openai({ system, messages, maxTokens }) {
  if (!llm.model) throw new Error("Set LLM_MODEL to the model name of your OpenAI-compatible provider.");
  const res = await postJson(config.openaiBaseUrl + "/chat/completions", { Authorization: "Bearer " + config.openaiKey }, {
    model: llm.model,
    messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
    max_completion_tokens: maxTokens,
  });
  const text = ((res.choices || [])[0]?.message?.content) || "";
  return { text, sources: [], searched: false };
}

/**
 * complete({ system, messages: [{role: "user"|"assistant", content}], maxTokens, search })
 * -> { text, sources: [{url, title}], searched }
 */
export async function complete({ system, messages, maxTokens = 2500, search = false }) {
  if (!llm.enabled) throw new Error("No LLM API key is configured. Set GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  const fn = { anthropic, gemini, openai }[llm.provider];
  if (!fn) throw new Error("Unknown LLM_PROVIDER '" + llm.provider + "'. Use anthropic, gemini or openai.");
  const wantSearch = search && config.webSearch && llm.provider !== "openai";
  try {
    let out;
    try {
      out = await fn({ system, messages, maxTokens, search: wantSearch });
    } catch (err) {
      if (!wantSearch) throw err;
      // Web search is not available on every plan or model. Try once more without it.
      out = await fn({ system, messages, maxTokens, search: false });
    }
    llm.lastError = null;
    return out;
  } catch (err) {
    llm.lastError = err.message;
    throw err;
  }
}

// Pulls the first JSON object out of a model answer (handles ```json fences and stray prose).
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const c of candidates) {
    const start = c.indexOf("{");
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(c.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return null;
}
