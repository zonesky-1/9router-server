import { BaseExecutor } from "./base.js";
import { randomUUID } from "node:crypto";
import {
  hasTools,
  buildToolSystemPrompt,
  renderSpecialMessages,
  parseToolCallReply,
  emitToolCallChunks,
  buildToolCallResponse,
  isSoftError,
} from "./geminiWebToolBridge.js";

const GEMINI_URL = "https://gemini.google.com/app";
const STREAM_URL = "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";

const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Map of model name -> { id, num, cap } for gemini.google.com web.
// Discovered live from the GetUserStatus RPC (models are per-account). `id` is the
// 16-hex model id, `num` the ordinal Google uses in the model header / inner[79],
// `cap` the capacity tail. Argon ("4 Argon") is the newest, Pro-tier model.
const MODEL_MAP = {
  "gemini-3.1-pro": { id: "e6fa609c3fa255c0", num: 3, cap: 4 },
  "gemini-3-pro": { id: "e6fa609c3fa255c0", num: 3, cap: 4 },
  "gemini-3.7-flash": { id: "56fdd199312815e2", num: 1, cap: 4 },
  "gemini-3.5-flash": { id: "56fdd199312815e2", num: 1, cap: 4 },
  "gemini-3.1-flash-lite": { id: "8c46e95b1a07cecc", num: 6, cap: 4 },
  "gemini-3.5-flash-lite": { id: "8c46e95b1a07cecc", num: 6, cap: 4 },
  argon: { id: "95a4c0abcba24364", num: 4, cap: 4 },
  "gemini-4-argon": { id: "95a4c0abcba24364", num: 4, cap: 4 },
  "4-argon": { id: "95a4c0abcba24364", num: 4, cap: 4 },
};

function resolveModel(model) {
  const key = String(model || "").trim().toLowerCase();
  return MODEL_MAP[key] || null;
}

export function normalizeGeminiCookieInput(raw, cookieName = "__Secure-1PSID") {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const cookies =
        parsed.cookies && typeof parsed.cookies === "object" && !Array.isArray(parsed.cookies)
          ? parsed.cookies
          : parsed;
      const pairs = Object.entries(cookies)
        .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
        .map(([k, v]) => `${k}=${String(v).trim()}`);
      if (pairs.length > 0) return pairs.join("; ");
    } catch {}
  }
  return trimmed.includes("=") ? trimmed : `${cookieName}=${trimmed}`;
}

export function buildGeminiPrompt(messages) {
  const textMessages = (messages || []).filter(
    (m) => typeof m.content === "string" && m.content.trim().length > 0
  );
  const userMessages = textMessages.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  const lastUserContent = lastUser?.content ?? "";
  const lastUserIdx = lastUser ? textMessages.lastIndexOf(lastUser) : -1;
  const priorTurns = textMessages.filter(
    (m, i) => i < lastUserIdx && (m.role === "user" || m.role === "assistant")
  );
  const systemText = textMessages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  if (priorTurns.length === 0 && !systemText) return lastUserContent;
  if (priorTurns.length === 0) return `System:\n${systemText}\n\n${lastUserContent}`;
  const historyLines = priorTurns.map(
    (m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`
  );
  const parts = [];
  if (systemText) parts.push(`System:\n${systemText}`);
  parts.push(`Previous conversation:\n${historyLines.join("\n\n")}`);
  parts.push(`Current user message:\n${lastUserContent}`);
  return parts.join("\n\n");
}

// Tool-aware prompt: folds the tool catalogue, the special turns (assistant
// tool_calls + tool results) and the user request into one text prompt, since
// the web endpoint speaks text only.
export function buildGeminiToolPrompt(messages, tools) {
  const toolPrompt = buildToolSystemPrompt(tools);
  const specialTurns = renderSpecialMessages(messages);
  const normal = (messages || []).filter(
    (m) =>
      typeof m.content === "string" &&
      m.content.trim().length > 0 &&
      m.role !== "tool" &&
      !(m.role === "assistant" && Array.isArray(m.tool_calls))
  );
  const base = buildGeminiPrompt(normal);
  const transcript = specialTurns
    .map((t) => `${t.role === "tool" ? "Tool result" : "Assistant"}: ${t.text}`)
    .join("\n\n");
  const parts = [];
  if (toolPrompt) parts.push(toolPrompt);
  if (transcript) parts.push(`Tool transcript:\n${transcript}`);
  parts.push(base);
  return parts.join("\n\n");
}

export function parseStreamResponse(raw) {
  const lines = String(raw || "").split("\n");
  let lastText = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      const responseArray = inner?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter((c) => typeof c === "string").join("");
      if (text) lastText = text;
    } catch {}
  }
  return lastText;
}

function parseCookies(raw) {
  return String(raw || "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return null;
      const name = part.substring(0, eq).trim();
      const value = part.substring(eq + 1).trim();
      if (!name || !value) return null;
      if (["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"].includes(name.toLowerCase())) {
        return null;
      }
      return { name, value };
    })
    .filter(Boolean);
}

async function fetchSessionParams(cookie) {
  const res = await fetch(GEMINI_URL, {
    headers: {
      Cookie: cookie,
      "User-Agent": GEMINI_USER_AGENT,
      Accept: "text/html",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/"SNlM0e":"([^"]+)"/) || html.match(/SNlM0e\\?":\\?"([^"\\]+)/);
  const bl = html.match(/"cfb2h":"([^"]+)"/) || html.match(/cfb2h\\?":\\?"([^"\\]+)/);
  if (!m) return null;
  return { at: m[1], bl: bl ? bl[1] : "boq_assistant-bard-web-server_20260315.08_p0" };
}

// Build the 81-slot inner request array StreamGenerate expects. The old executor
// sent a batchexecute-shaped f.req (`[[["SnzQ9e",...]]]`) which Google rejects with
// HTTP 400 ("af.httprm"). StreamGenerate needs `f.req=[null, "<81-element JSON>"]`.
function buildInnerRequest(prompt, sess, num) {
  const inner = new Array(81).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [1];
  inner[7] = 1; // streaming flag
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = sess;
  inner[61] = [];
  inner[68] = 1;
  inner[79] = num;
  inner[80] = 1;
  return inner;
}

// Model selection header. `x-goog-ext-525001261-jspb` carries the model id, capacity
// tail and ordinal; trailing 1 = normal (2 = extended thinking) and the session UUID.
function buildModelHeader(modelId, cap, num, sess, thinking = 1) {
  return JSON.stringify([
    1, null, null, null, modelId, null, null, 0, [4, 5, 6, 8], null, null, cap, null, null, num, thinking, sess,
  ]);
}

function errorResponse(status, message) {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error" } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { baseUrl: GEMINI_URL });
  }

  async testConnection(credentials) {
    try {
      const raw = credentials?.apiKey || credentials?.cookie || "";
      const cookie = normalizeGeminiCookieInput(raw);
      if (!cookie) return false;
      return parseCookies(cookie).some((p) => p.value.length > 0);
    } catch {
      return false;
    }
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = body || {};
    const rawCreds = credentials || {};
    const cookie = normalizeGeminiCookieInput(rawCreds.apiKey || rawCreds.cookie || "");
    if (!cookie) {
      return {
        response: errorResponse(401, "Missing Gemini cookies (__Secure-1PSID)"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }
    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const toolMode = hasTools(bodyObj);
    // The web endpoint is text-only; when the client offers tools we fold the
    // catalogue into the prompt and parse the model's declared calls back out.
    const prompt = toolMode
      ? buildGeminiToolPrompt(messages, bodyObj.tools)
      : buildGeminiPrompt(messages);
    const hasUser = messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
    );
    if (!prompt || !hasUser) {
      return {
        response: errorResponse(400, "No user message found"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const modelId = String(model || bodyObj.model || "gemini-3.1-pro");
    const spec = resolveModel(modelId) || MODEL_MAP["gemini-3.1-pro"];

    let session;
    try {
      session = await fetchSessionParams(cookie);
    } catch (err) {
      return {
        response: errorResponse(502, `Gemini session fetch failed: ${err instanceof Error ? err.message : "unknown"}`),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }
    if (!session) {
      return {
        response: errorResponse(401, "Gemini cookie expired or invalid, re-copy __Secure-1PSID from gemini.google.com cookies"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const sess = randomUUID().toUpperCase();
    const inner = buildInnerRequest(prompt, sess, spec.num);
    const params = new URLSearchParams({
      hl: "en",
      _reqid: String(reqId),
      rt: "c",
      bl: session.bl,
    });
    const reqBody = new URLSearchParams({
      at: session.at,
      "f.req": JSON.stringify([null, JSON.stringify(inner)]),
    }).toString();

    let upstream;
    try {
      upstream = await fetch(
        `${STREAM_URL}?${params.toString()}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Cookie: cookie,
            "User-Agent": GEMINI_USER_AGENT,
            Origin: "https://gemini.google.com",
            Referer: GEMINI_URL,
            "x-same-domain": "1",
            "x-goog-ext-525001261-jspb": buildModelHeader(spec.id, spec.cap, spec.num, sess),
            "x-goog-ext-525005358-jspb": JSON.stringify([sess, 1]),
            "x-goog-ext-73010989-jspb": "[0]",
            "x-goog-ext-73010990-jspb": "[0,0,0]",
          },
          body: reqBody,
          signal: signal ?? undefined,
        }
      );
    } catch (err) {
      return {
        response: errorResponse(502, `Gemini fetch failed: ${err instanceof Error ? err.message : "unknown"}`),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      log?.error?.("GEMINI-WEB", `Upstream HTTP ${upstream.status}`);
      return {
        response: errorResponse(upstream.status, `Gemini error: ${errText.slice(0, 300)}`),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const raw = await upstream.text().catch(() => "");
    const responseText = parseStreamResponse(raw);
    if (!responseText) {
      return {
        response: errorResponse(502, "No response from Gemini (cookie may be expired or the web endpoint changed)"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    if (isSoftError(responseText)) {
      log?.warn?.("GEMINI-WEB", `Soft error from Gemini (throttled/guarded): ${responseText.slice(0, 90)}`);
      return {
        response: errorResponse(502, "Gemini soft-error (throttled) - rotating account/model"),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Parse any tool call the model declared in prose (marker / fenced JSON /
    // XML shapes) back into structured tool_calls the client can execute.
    const parsed = toolMode ? parseToolCallReply(responseText) : { content: responseText, calls: [] };
    const messageText = parsed.content;
    const calls = parsed.calls || [];

    if (stream) {
      const encoder = new TextEncoder();
      const id = `chatcmpl-gwe-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const chunk = (delta, finish) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: delta || {}, finish_reason: finish ?? null }],
      });
      const readable = new ReadableStream({
        start(controller) {
          if (calls.length > 0) {
            let roleSent = false;
            const ensureRole = () => {
              if (!roleSent) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`));
                roleSent = true;
              }
            };
            if (messageText) {
              ensureRole();
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: messageText }))}\n\n`));
            }
            emitToolCallChunks((delta, finish) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(delta, finish))}\n\n`));
            }, ensureRole, calls);
          } else {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: messageText }))}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk("", "stop"))}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return {
        response: new Response(readable, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    if (calls.length > 0) {
      return {
        response: new Response(
          JSON.stringify(
            buildToolCallResponse({ id: `chatcmpl-${Date.now()}`, model: modelId, messageText, calls })
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    return {
      response: new Response(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            { index: 0, message: { role: "assistant", content: messageText }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
      url: GEMINI_URL,
      headers: {},
      transformedBody: body,
    };
  }
}
