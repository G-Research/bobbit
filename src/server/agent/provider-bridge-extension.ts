/**
 * Generates a pi-coding-agent extension that bridges per-turn provider
 * lifecycle hooks (Extension Platform G1.4).
 *
 * Unlike the gateway-internal `afterTurn` / `sessionShutdown` dispatches, the
 * per-turn `beforePrompt` and `beforeCompact` hooks need to run *inside* the
 * agent process so they can observe / amend the outgoing turn. The generated
 * extension subscribes to pi's `before_agent_start`, `context`, and
 * `session_before_compact` events and calls back into the gateway, which
 * dispatches through the `LifecycleHub`.
 *
 * NON-NEGOTIABLE invariant: the user's message text is NEVER mutated. Per-turn
 * recall is injected as a hidden custom/user-side message, never by amending
 * the system prompt. This keeps provider prompt-cache system bytes stable across
 * turns while preserving the transcript echo. Mutating the user prompt would
 * corrupt the transcript echo and re-open the comms-stack duplicate class.
 *
 * Transport/auth mirrors `tool-guard-extension.ts`: read
 * `BOBBIT_GATEWAY_URL` / `BOBBIT_TOKEN`, falling back to
 * `<BOBBIT_DIR || ~/.bobbit>/state/{gateway-url,token}`. All failures are
 * swallowed so a turn always proceeds even when the gateway or a provider is
 * down (the non-fatal invariant).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { ProviderContribution } from "./pack-contributions.js";
import type { LifecycleHub, LifecycleHook } from "./lifecycle-hub.js";

/** Delimiters wrapping the per-turn dynamic-context region in the system prompt. */
export const DYNAMIC_CONTEXT_START = "<!-- bobbit:dynamic-context:start -->";
export const DYNAMIC_CONTEXT_END = "<!-- bobbit:dynamic-context:end -->";

/** The per-turn hooks that require the in-process bridge extension. */
export const TURN_BRIDGE_HOOKS: readonly LifecycleHook[] = ["beforePrompt", "beforeCompact"];

/** Timeout (ms) for the before-prompt callback — blocking-with-timeout. */
export const BEFORE_PROMPT_TIMEOUT_MS = 2500;
/** Timeout (ms) for the before-compact callback. */
export const BEFORE_COMPACT_TIMEOUT_MS = 5000;

/**
 * Idempotently remove a prior Bobbit dynamic-context region from a system
 * prompt. Stripping then re-appending a fresh delimited tail leaves exactly one
 * region (no growth turn-over-turn). When no region is present the input is
 * returned unchanged.
 */
export function stripDelimitedTail(systemPrompt: string): string {
	if (!systemPrompt) return systemPrompt;
	const start = systemPrompt.indexOf(DYNAMIC_CONTEXT_START);
	if (start === -1) return systemPrompt;
	const endStart = systemPrompt.indexOf(DYNAMIC_CONTEXT_END, start);
	// Strip everything from (and including) the leading whitespace before the
	// start delimiter. When the end delimiter is missing (truncated tail) we
	// still drop the dangling region rather than retain a half-open marker.
	const before = systemPrompt.slice(0, start).replace(/\s+$/, "");
	if (endStart === -1) return before;
	const after = systemPrompt.slice(endStart + DYNAMIC_CONTEXT_END.length);
	return before + after;
}

/**
 * True when at least one (already activation-filtered) provider declares a
 * per-turn hook (`beforePrompt` or `beforeCompact`). Disabled providers are
 * dropped by the registry before this check, so a disabled provider never
 * triggers bridge generation. When false, the bridge extension is neither
 * generated nor pushed onto the spawn args — zero overhead with no provider.
 */
export function providersDeclareTurnHooks(
	providers: ReadonlyArray<Pick<ProviderContribution, "hooks">>,
): boolean {
	return providers.some((p) => p.hooks.some((h) => (TURN_BRIDGE_HOOKS as readonly string[]).includes(h)));
}

/**
 * True when the session's project has at least one enabled provider declaring a
 * per-turn hook (`beforePrompt` / `beforeCompact`). Delegates to the hub so
 * provider activation filtering stays centralized in the registry. When false,
 * session setup must NOT generate or push the bridge extension (zero overhead).
 *
 * `goalId` is the session's EFFECTIVE goal (`goalId ?? teamGoalId`): a goal
 * subtree that disables a provider via `bobbit.disabledProviders` gets no
 * bridge installed at all — clean disable across the whole tree.
 */
export function hasProviderBridgeHooks(hub: LifecycleHub, projectId?: string, goalId?: string): boolean {
	return hub.hasProvidersForHooks(projectId, TURN_BRIDGE_HOOKS, goalId);
}

/**
 * Generate the TypeScript source for the provider-bridge extension.
 *
 * @param sessionId - The session ID (used to POST hook callbacks to the gateway)
 * @returns TypeScript source string for the extension
 */
export function generateProviderBridgeExtension(sessionId: string): string {
	return `import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DYNAMIC_CONTEXT_START = ${JSON.stringify(DYNAMIC_CONTEXT_START)};
const DYNAMIC_CONTEXT_END = ${JSON.stringify(DYNAMIC_CONTEXT_END)};

// Idempotent removal of a prior Bobbit dynamic-context region. Keep in sync
// with stripDelimitedTail in provider-bridge-extension.ts.
function stripDelimitedTail(systemPrompt) {
  if (!systemPrompt) return systemPrompt || "";
  const start = systemPrompt.indexOf(DYNAMIC_CONTEXT_START);
  if (start === -1) return systemPrompt;
  const endStart = systemPrompt.indexOf(DYNAMIC_CONTEXT_END, start);
  const before = systemPrompt.slice(0, start).replace(/\\s+$/, "");
  if (endStart === -1) return before;
  return before + systemPrompt.slice(endStart + DYNAMIC_CONTEXT_END.length);
}

// Cap (chars) for the compacted-span text forwarded to beforeCompact providers.
// Bounds the hook payload; the memory provider trims further before retaining.
const COMPACT_SPAN_CAP = 8000;

function isDynamicContextMessage(message) {
  return !!message && message.role === "custom" && message.customType === "bobbit:dynamic-context";
}

function latestRealUserMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") return i;
  }
  return -1;
}

// Remove stale dynamic-context custom messages from future provider contexts.
// Current-turn dynamic context is appended after the latest real user message;
// older persisted copies appear before it and must not be replayed.
function filterStaleDynamicContextMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const latestUser = latestRealUserMessageIndex(messages);
  let changed = false;
  const filtered = messages.filter((message, index) => {
    if (!isDynamicContextMessage(message)) return true;
    const stale = latestUser === -1 || index < latestUser;
    if (stale) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? filtered : messages;
}

// Extract the about-to-be-lost conversation span from the pi
// session_before_compact event so beforeCompact providers retain real content
// instead of an empty body. Reads event.preparation.messagesToSummarize (the
// messages compaction will discard), concatenating their text while skipping
// Bobbit's hidden per-turn dynamic context; falls back to a prior summary. All
// failures degrade to "" so a turn never breaks.
function extractCompactSpan(event) {
  try {
    const prep = event && event.preparation;
    const msgs = prep && Array.isArray(prep.messagesToSummarize) ? prep.messagesToSummarize : [];
    const parts = [];
    for (const m of msgs) {
      if (!m || typeof m !== "object" || isDynamicContextMessage(m)) continue;
      const role = typeof m.role === "string" ? m.role : "";
      const c = m.content;
      let text = "";
      if (typeof c === "string") {
        text = c;
      } else if (Array.isArray(c)) {
        text = c
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join(" ");
      }
      text = text.trim();
      if (!text) continue;
      parts.push(role ? role + ": " + text : text);
    }
    let span = parts.join("\\n\\n").trim();
    if (!span && prep && typeof prep.previousSummary === "string") span = prep.previousSummary.trim();
    return span.length > COMPACT_SPAN_CAP ? span.slice(0, COMPACT_SPAN_CAP) : span;
  } catch {
    return "";
  }
}

export default function(pi) {
  const sessionId = ${JSON.stringify(sessionId)};

  // Read gateway URL and auth token (same pattern as the tool_call guard).
  const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
  function readState(name, envVar) {
    const fromEnv = process.env[envVar];
    if (fromEnv) return fromEnv.trim();
    try { return fs.readFileSync(path.join(bobbitDir, "state", name), "utf-8").trim(); }
    catch { return ""; }
  }
  const gwUrl = readState("gateway-url", "BOBBIT_GATEWAY_URL");
  const token = readState("token", "BOBBIT_TOKEN");
  const fetchImpl = globalThis.fetch.bind(globalThis);

  // TLS for the local gateway is handled entirely by the spawner's inherited
  // env (the CA cert is pinned via NODE_EXTRA_CA_CERTS when present, with the
  // spawner's existing fallback only when no CA cert exists). The bridge must
  // NOT alter TLS verification here — a process-wide downgrade would defeat the
  // pinned-CA path and disable verification for ALL agent outbound HTTPS.

  async function postHook(route, body, timeoutMs) {
    if (!gwUrl) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(gwUrl + "/api/sessions/" + sessionId + route, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      return await res.json();
    } catch {
      // Swallow ALL failures (transport, timeout/abort, parse) — the turn must
      // proceed unchanged when the gateway or a provider is unavailable.
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  // Per-turn beforePrompt: inject recall as a hidden custom/user-side message.
  // The user's prompt text (event.prompt) is forwarded read-only and never
  // mutated; the system prompt is never amended here so provider prompt-cache
  // system bytes stay stable across turns.
  pi.on("before_agent_start", async (event) => {
    const resp = await postHook(
      "/provider-hooks/before-prompt",
      { prompt: event.prompt },
      ${BEFORE_PROMPT_TIMEOUT_MS},
    );
    if (!resp) return undefined; // failure / timeout — proceed unchanged
    const content = typeof resp.content === "string" ? resp.content : "";
    if (!content) return undefined;
    return {
      message: {
        customType: "bobbit:dynamic-context",
        content,
        display: false,
      },
    };
  });

  // Context filtering: pi may persist hidden custom messages after a turn. Do
  // not mutate message_end (that is too early for the current provider request);
  // instead, filter only the future LLM context. Stale dynamic messages before
  // the latest real user are removed, while current-turn dynamic messages after
  // that user are preserved for the in-flight request.
  pi.on("context", (event) => {
    const messages = event && Array.isArray(event.messages) ? event.messages : [];
    const filtered = filterStaleDynamicContextMessages(messages);
    return filtered === messages ? undefined : { messages: filtered };
  });

  // beforeCompact: forward the about-to-be-lost span so providers can retain it
  // before context is dropped. We do NOT amend compaction output here.
  pi.on("session_before_compact", async (event) => {
    const span = extractCompactSpan(event);
    await postHook("/provider-hooks/before-compact", span ? { span } : {}, ${BEFORE_COMPACT_TIMEOUT_MS});
    return undefined;
  });
}
`;
}

// ── File handling (mirrors writeToolGuardExtension) ─────────────────────────
const bridgeCodeCache = new Map<string, string>();
const bridgeFileCache = new Map<string, string>();

/**
 * Write the provider-bridge extension to disk and return its file path.
 * Content-addressed under `.bobbit/state/provider-bridge/<hash>/bridge.ts` for
 * dedup, mirroring `writeToolGuardExtension`'s caching and write-if-changed
 * handling.
 */
export function writeProviderBridgeExtension(sessionId: string): string | undefined {
	const cachedPath = bridgeFileCache.get(sessionId);
	if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;

	let code = bridgeCodeCache.get(sessionId);
	if (!code) {
		code = generateProviderBridgeExtension(sessionId);
		bridgeCodeCache.set(sessionId, code);
	}

	try {
		const baseDir = path.join(bobbitStateDir(), "provider-bridge");
		const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
		const extDir = path.join(baseDir, hash);
		fs.mkdirSync(extDir, { recursive: true });

		const filePath = path.join(extDir, "bridge.ts");
		try {
			const existing = fs.readFileSync(filePath, "utf-8");
			if (existing === code) {
				bridgeFileCache.set(sessionId, filePath);
				return filePath;
			}
		} catch { /* file doesn't exist yet */ }
		fs.writeFileSync(filePath, code, "utf-8");
		bridgeFileCache.set(sessionId, filePath);
		return filePath;
	} catch {
		// Non-fatal: if the bridge can't be written the turn proceeds without
		// dynamic context rather than failing session setup.
		return undefined;
	}
}
