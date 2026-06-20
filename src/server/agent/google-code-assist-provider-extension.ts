/**
 * Generates a pi-coding-agent extension that registers a first-class
 * `google-code-assist` API provider INSIDE the spawned agent process
 * (design: docs/design/google-session-models.md §4.3 — "Option B").
 *
 * Why this exists: agent sessions run in a separate `pi-coding-agent` process
 * whose `@earendil-works/pi-ai` has no `google-code-assist` api. Binding a
 * `google-gemini-cli/*` model would therefore throw "No API provider registered
 * for api: google-code-assist". Rather than patch pi-ai (which can't reach the
 * prebuilt Docker image), we use the supported `ExtensionAPI.registerProvider()`
 * hook to register the api with our own `streamSimple` handler. The handler:
 *
 *   1. fetches a FRESH Bearer token + Code Assist project id per request from the
 *      gateway (`GET /api/sessions/:id/google-code-assist/token`) so refresh stays
 *      single-sourced on the gateway and nothing account-scoped is persisted in
 *      the sandbox (with an env fallback for egress-restricted sandboxes);
 *   2. converts the pi `Context` (multi-turn messages, tool calls/results, system
 *      prompt, thinking) into a Code Assist `:streamGenerateContent` request body;
 *   3. streams the SSE response and emits pi `AssistantMessageEvent`s
 *      (text/thinking/toolcall deltas, usage, terminal done/error);
 *   4. honors `options.signal` (abort) and `options.timeoutMs`.
 *
 * The generated source is SELF-CONTAINED: all conversion/streaming helpers are
 * inlined into the emitted string so it runs verbatim in host and Docker
 * sessions. It imports only `@earendil-works/pi-ai` (for the
 * `createAssistantMessageEventStream` factory — same module instance the turn
 * loop consumes, so the stream class identity holds) and node builtins. Transport
 * / gateway-auth mirrors `provider-bridge-extension.ts`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import {
	GOOGLE_CODE_ASSIST_API,
	GOOGLE_GEMINI_CLI_PROVIDER,
} from "./google-code-assist.js";
import { getGoogleCodeAssistModels } from "./google-code-assist-models.js";

/** Code Assist (Gemini CLI) RPC base — the fixed public endpoint. */
export const CODE_ASSIST_PROVIDER_BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal";

/** pi `ProviderModelConfig` subset embedded into the generated `models[]`. */
export interface CodeAssistModelDescriptor {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/**
 * Map the registry's account-model list (the single source of truth) into the
 * pi `ProviderModelConfig[]` the extension registers. Pulling live from
 * `getGoogleCodeAssistModels()` keeps the agent-side model list in lockstep with
 * what the gateway emits — no separate hand-maintained descriptor list to drift.
 */
export function codeAssistModelDescriptors(): CodeAssistModelDescriptor[] {
	// `ignoreCredential: true` — the provider is registered in EVERY spawned agent
	// (see writeGoogleCodeAssistProviderExtension), not only when a credential is
	// present at spawn time, so the descriptor list must not be credential-gated.
	return getGoogleCodeAssistModels({ ignoreCredential: true }).map((m) => ({
		id: m.id,
		// Account models carry a "(Google account)" suffix already; the provider
		// `name` distinguishes them in pi UIs.
		name: m.name,
		api: GOOGLE_CODE_ASSIST_API,
		baseUrl: CODE_ASSIST_PROVIDER_BASE_URL,
		reasoning: !!m.reasoning,
		...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
		input: (m.input ?? ["text"]) as ("text" | "image")[],
		cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow || 1_048_576,
		maxTokens: m.maxTokens || 65_536,
	}));
}

/**
 * Generate the TypeScript source for the Code Assist provider extension.
 *
 * @param sessionId - session id (used to fetch the per-request token from the gateway)
 * @param models - the model descriptors to register for the provider
 */
export function generateGoogleCodeAssistProviderExtension(
	sessionId: string,
	models: CodeAssistModelDescriptor[],
): string {
	return `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PROVIDER = ${JSON.stringify(GOOGLE_GEMINI_CLI_PROVIDER)};
const API = ${JSON.stringify(GOOGLE_CODE_ASSIST_API)};
const BASE_URL = ${JSON.stringify(CODE_ASSIST_PROVIDER_BASE_URL)};
const SESSION_ID = ${JSON.stringify(sessionId)};
const MODELS = ${JSON.stringify(models)};

// pi thinking level → Gemini thinkingBudget (mirrors THINKING_BUDGET in
// google-code-assist.ts). Kept inline so the extension is self-contained.
const THINKING_BUDGET = { minimal: 0, low: 4096, medium: 8192, high: 24576, xhigh: 32768 };

let toolCallCounter = 0;

// ── Gateway transport (mirrors provider-bridge-extension.ts) ────────────────
const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
function readState(name, envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv.trim();
  try { return fs.readFileSync(path.join(bobbitDir, "state", name), "utf-8").trim(); }
  catch { return ""; }
}
const gwUrl = readState("gateway-url", "BOBBIT_GATEWAY_URL");
const gwToken = readState("token", "BOBBIT_TOKEN");

// Minimal token redaction for surfaced error bodies — strip long Bearer-ish blobs.
function redact(s) {
  if (typeof s !== "string") return "";
  return s.replace(/ya29\\.[A-Za-z0-9._-]+/g, "[redacted]").replace(/Bearer\\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

// Sentinel thrown when the gateway definitively reports no usable Google account.
class GoogleAuthError extends Error {}

/**
 * Resolve a fresh Bearer token + Code Assist project id. The gateway is the
 * PRIMARY source (it refreshes); a stale env token is the fallback for
 * egress-restricted sandboxes that cannot reach the gateway. A definitive 401
 * from the gateway surfaces as a re-auth error rather than silently using a
 * possibly-stale env token.
 */
async function fetchCredential(signal) {
  if (gwUrl) {
    let res;
    try {
      res = await fetch(gwUrl + "/api/sessions/" + SESSION_ID + "/google-code-assist/token", {
        method: "GET",
        headers: { "Authorization": "Bearer " + gwToken },
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      res = undefined; // transport failure — try env fallback below
    }
    if (res) {
      if (res.status === 401 || res.status === 403) {
        throw new GoogleAuthError(
          "Google account not authenticated for Code Assist. Re-authenticate via Settings \\u2192 Account \\u2192 Google (Gemini).",
        );
      }
      if (res.ok) {
        let body;
        try { body = await res.json(); } catch { body = undefined; }
        const tok = body && (body.token || body.accessToken);
        if (tok) return { token: tok, project: body.project || body.projectId };
      }
    }
  }
  const envTok = process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
  if (envTok) {
    return { token: envTok, project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID };
  }
  throw new GoogleAuthError(
    "No Google account credential available for Code Assist. Log in via Settings \\u2192 Account \\u2192 Google (Gemini).",
  );
}

// ── pi Context → Code Assist request conversion ─────────────────────────────
const base64Sig = /^[A-Za-z0-9+/]+={0,2}$/;
function validSig(sig) {
  if (typeof sig !== "string" || sig.length === 0) return undefined;
  if (sig.length % 4 !== 0) return undefined;
  return base64Sig.test(sig) ? sig : undefined;
}

function geminiMajor(modelId) {
  const m = String(modelId).toLowerCase().match(/^gemini(?:-live)?-(\\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}
function supportsMultimodalFunctionResponse(modelId) {
  const v = geminiMajor(modelId);
  return v === undefined ? true : v >= 3;
}

function convertMessages(model, context) {
  const contents = [];
  for (const msg of context.messages || []) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({ role: "user", parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const parts = msg.content.map((item) =>
          item.type === "text" ? { text: item.text } : { inlineData: { mimeType: item.mimeType, data: item.data } },
        );
        if (parts.length) contents.push({ role: "user", parts });
      }
    } else if (msg.role === "assistant") {
      const sameModel = msg.provider === model.provider && msg.model === model.id;
      const parts = [];
      for (const block of msg.content || []) {
        if (block.type === "text") {
          if (!block.text || !block.text.trim()) continue;
          const sig = sameModel ? validSig(block.textSignature) : undefined;
          parts.push({ text: block.text, ...(sig ? { thoughtSignature: sig } : {}) });
        } else if (block.type === "thinking") {
          if (!block.thinking || !block.thinking.trim()) continue;
          if (sameModel) {
            const sig = validSig(block.thinkingSignature);
            parts.push({ thought: true, text: block.thinking, ...(sig ? { thoughtSignature: sig } : {}) });
          } else {
            parts.push({ text: block.thinking });
          }
        } else if (block.type === "toolCall") {
          const sig = sameModel ? validSig(block.thoughtSignature) : undefined;
          parts.push({ functionCall: { name: block.name, args: block.arguments || {} }, ...(sig ? { thoughtSignature: sig } : {}) });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (msg.role === "toolResult") {
      const textResult = (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\\n");
      const imageContent = (model.input || []).includes("image")
        ? (msg.content || []).filter((c) => c.type === "image")
        : [];
      const hasImages = imageContent.length > 0;
      const responseValue = textResult.length ? textResult : hasImages ? "(see attached image)" : "";
      const imageParts = imageContent.map((im) => ({ inlineData: { mimeType: im.mimeType, data: im.data } }));
      const multimodal = supportsMultimodalFunctionResponse(model.id);
      const frPart = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(hasImages && multimodal ? { parts: imageParts } : {}),
        },
      };
      // Code Assist requires all function responses in a single user turn — merge.
      const last = contents[contents.length - 1];
      if (last && last.role === "user" && Array.isArray(last.parts) && last.parts.some((p) => p.functionResponse)) {
        last.parts.push(frPart);
      } else {
        contents.push({ role: "user", parts: [frPart] });
      }
      if (hasImages && !multimodal) {
        contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
      }
    }
  }
  return contents;
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
    })),
  }];
}

// pi toolChoice ("auto"|"any"|"none") → Gemini functionCallingConfig.mode
// (mirrors toolChoiceMode in google-code-assist.ts).
function toolChoiceMode(choice) {
  switch (choice) {
    case "auto": return "AUTO";
    case "any": return "ANY";
    case "none": return "NONE";
    default: return undefined;
  }
}

function convertContext(model, context, options) {
  const request = { contents: convertMessages(model, context) };
  if (context.systemPrompt && context.systemPrompt.trim()) {
    request.systemInstruction = { role: "user", parts: [{ text: context.systemPrompt }] };
  }
  const tools = convertTools(context.tools);
  if (tools) {
    request.tools = tools;
    // toolChoice only applies when tools are present (mirrors server-side helper).
    const mode = options && toolChoiceMode(options.toolChoice);
    if (mode) request.toolConfig = { functionCallingConfig: { mode } };
  }

  const generationConfig = {};
  if (options && typeof options.maxTokens === "number" && options.maxTokens > 0) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  const reasoning = options && options.reasoning;
  if (reasoning && reasoning !== "off") {
    const budget = THINKING_BUDGET[reasoning];
    if (typeof budget === "number") generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  return { model: model.id, request };
}

// ── Gemini finishReason → pi StopReason ─────────────────────────────────────
function mapStopReason(reason) {
  switch (reason) {
    case "STOP": return "stop";
    case "MAX_TOKENS": return "length";
    default: return "error";
  }
}

function mapUsage(model, meta) {
  const usage = {
    input: (meta.promptTokenCount || 0) - (meta.cachedContentTokenCount || 0),
    output: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0),
    cacheRead: meta.cachedContentTokenCount || 0,
    cacheWrite: 0,
    totalTokens: meta.totalTokenCount || 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const c = model.cost || {};
  usage.cost.input = (usage.input / 1e6) * (c.input || 0);
  usage.cost.output = (usage.output / 1e6) * (c.output || 0);
  usage.cost.cacheRead = (usage.cacheRead / 1e6) * (c.cacheRead || 0);
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage;
}

// ── SSE transport ───────────────────────────────────────────────────────────
function parseSseLine(line) {
  const t = String(line).replace(/\\r$/, "").trim();
  if (!t || !t.startsWith("data:")) return undefined;
  const payload = t.slice(5).trim();
  if (!payload || payload === "[DONE]") return undefined;
  try { return JSON.parse(payload); } catch { return undefined; }
}

async function* sseChunks(bearer, body, options) {
  const url = BASE_URL + ":streamGenerateContent?alt=sse";
  const controller = new AbortController();
  const external = options && options.signal;
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onAbort);
  }
  let timer;
  if (options && typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + bearer, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let text = "";
      try { text = await res.text(); } catch { /* ignore */ }
      throw new Error("Code Assist streamGenerateContent failed: HTTP " + res.status + " " + redact(text).slice(0, 256));
    }
    if (!res.body || typeof res.body.getReader !== "function") {
      const text = await res.text();
      for (const line of text.split("\\n")) {
        const obj = parseSseLine(line);
        if (obj) yield obj;
      }
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const obj = parseSseLine(line);
        if (obj) yield obj;
      }
    }
    buf += decoder.decode();
    for (const line of buf.split("\\n")) {
      const obj = parseSseLine(line);
      if (obj) yield obj;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (external) external.removeEventListener("abort", onAbort);
  }
}

// ── Custom streamSimple handler for api "google-code-assist" ────────────────
function codeAssistStreamSimple(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const output = {
    role: "assistant",
    content: [],
    api: API,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  (async () => {
    try {
      if (options && options.signal && options.signal.aborted) throw new Error("Request was aborted");
      const cred = await fetchCredential(options && options.signal);
      const body = convertContext(model, context, options);
      if (cred.project) body.project = cred.project;

      stream.push({ type: "start", partial: output });

      let current = null;
      const idx = () => output.content.length - 1;
      const closeCurrent = () => {
        if (!current) return;
        if (current.type === "text") {
          stream.push({ type: "text_end", contentIndex: idx(), content: current.text, partial: output });
        } else {
          stream.push({ type: "thinking_end", contentIndex: idx(), content: current.thinking, partial: output });
        }
        current = null;
      };

      for await (const chunk of sseChunks(cred.token, body, options)) {
        const resp = chunk.response || chunk;
        const cand = resp.candidates && resp.candidates[0];
        const usageMeta = resp.usageMetadata;
        if (cand && cand.content && Array.isArray(cand.content.parts)) {
          for (const part of cand.content.parts) {
            if (typeof part.text === "string") {
              const isThinking = part.thought === true;
              if (!current || (isThinking && current.type !== "thinking") || (!isThinking && current.type !== "text")) {
                closeCurrent();
                if (isThinking) {
                  current = { type: "thinking", thinking: "", thinkingSignature: undefined };
                  output.content.push(current);
                  stream.push({ type: "thinking_start", contentIndex: idx(), partial: output });
                } else {
                  current = { type: "text", text: "" };
                  output.content.push(current);
                  stream.push({ type: "text_start", contentIndex: idx(), partial: output });
                }
              }
              if (current.type === "thinking") {
                current.thinking += part.text;
                if (validSig(part.thoughtSignature)) current.thinkingSignature = part.thoughtSignature;
                stream.push({ type: "thinking_delta", contentIndex: idx(), delta: part.text, partial: output });
              } else {
                current.text += part.text;
                if (validSig(part.thoughtSignature)) current.textSignature = part.thoughtSignature;
                stream.push({ type: "text_delta", contentIndex: idx(), delta: part.text, partial: output });
              }
            }
            if (part.functionCall) {
              closeCurrent();
              const tc = {
                type: "toolCall",
                id: (part.functionCall.name || "tool") + "_" + Date.now() + "_" + (++toolCallCounter),
                name: part.functionCall.name || "",
                arguments: part.functionCall.args || {},
                ...(validSig(part.thoughtSignature) ? { thoughtSignature: part.thoughtSignature } : {}),
              };
              output.content.push(tc);
              stream.push({ type: "toolcall_start", contentIndex: idx(), partial: output });
              stream.push({ type: "toolcall_delta", contentIndex: idx(), delta: JSON.stringify(tc.arguments), partial: output });
              stream.push({ type: "toolcall_end", contentIndex: idx(), toolCall: tc, partial: output });
            }
          }
        }
        if (cand && cand.finishReason) output.stopReason = mapStopReason(cand.finishReason);
        if (usageMeta) output.usage = mapUsage(model, usageMeta);
      }

      closeCurrent();
      if (options && options.signal && options.signal.aborted) throw new Error("Request was aborted");
      if (output.content.some((b) => b.type === "toolCall")) output.stopReason = "toolUse";
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error("Code Assist response ended with finishReason that maps to an error");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (err) {
      output.stopReason = options && options.signal && options.signal.aborted ? "aborted" : "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function (pi) {
  pi.registerProvider(PROVIDER, {
    name: "Google (Gemini, account)",
    api: API,
    baseUrl: BASE_URL,
    // Token is fetched per request inside streamSimple, not via apiKey. A literal
    // keeps pi-coding-agent's validateProviderConfig happy (it requires apiKey or
    // oauth when models are defined).
    apiKey: "code-assist-runtime",
    streamSimple: codeAssistStreamSimple,
    models: MODELS,
  });
}
`;
}

// ── File handling (mirrors writeProviderBridgeExtension) ────────────────────
const extCodeCache = new Map<string, string>();
const extFileCache = new Map<string, string>();

/**
 * Write the Code Assist provider extension to disk and return its file path, or
 * `undefined` only when no account models can be derived (e.g. pi-ai's `google`
 * catalog is unreadable).
 *
 * The extension is written UNCONDITIONALLY — even with no Google account
 * credential present — so the `google-code-assist` provider is registered inside
 * every spawned agent. This closes a gap where a session spawned BEFORE Google
 * sign-in had no provider registered, so selecting a `google-gemini-cli/*` model
 * in that already-running session failed with "No API provider registered for
 * api: google-code-assist". Registering always is safe: the runtime Bearer token
 * is fetched per request from the gateway (which returns a clear re-auth error
 * when no account is authenticated), nothing account-scoped is baked in at spawn
 * time, the gateway-side model selector still only surfaces these models once
 * authenticated, and the generated source contains no secrets.
 *
 * Content-addressed under `.bobbit/state/google-code-assist/<hash>/provider.ts`
 * for dedup, mirroring `writeProviderBridgeExtension`.
 */
export function writeGoogleCodeAssistProviderExtension(sessionId: string): string | undefined {
	let code = extCodeCache.get(sessionId);
	if (!code) {
		const models = codeAssistModelDescriptors();
		if (models.length === 0) return undefined;
		code = generateGoogleCodeAssistProviderExtension(sessionId, models);
		extCodeCache.set(sessionId, code);
	}

	const cachedPath = extFileCache.get(sessionId);
	if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;

	try {
		const baseDir = path.join(bobbitStateDir(), "google-code-assist");
		const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
		const extDir = path.join(baseDir, hash);
		fs.mkdirSync(extDir, { recursive: true });

		const filePath = path.join(extDir, "provider.ts");
		try {
			const existing = fs.readFileSync(filePath, "utf-8");
			if (existing === code) {
				extFileCache.set(sessionId, filePath);
				return filePath;
			}
		} catch { /* file doesn't exist yet */ }
		fs.writeFileSync(filePath, code, "utf-8");
		extFileCache.set(sessionId, filePath);
		return filePath;
	} catch {
		// Non-fatal: if the extension can't be written the session still spawns
		// (the model simply won't be runnable, surfacing a clear provider error).
		return undefined;
	}
}

/** Reset the in-memory codegen caches (test seam). */
export function resetGoogleCodeAssistExtensionCache(): void {
	extCodeCache.clear();
	extFileCache.clear();
}
