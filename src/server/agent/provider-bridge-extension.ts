/**
 * Generates a pi-coding-agent extension that bridges per-turn provider
 * lifecycle hooks (Extension Platform G1.4).
 *
 * Unlike the gateway-internal `afterTurn` / `sessionShutdown` dispatches, the
 * per-turn `beforePrompt` and `beforeCompact` hooks need to run *inside* the
 * agent process so they can observe / amend the outgoing turn. The generated
 * extension subscribes to pi's `before_agent_start` and `session_before_compact`
 * events and calls back into the gateway, which dispatches through the
 * `LifecycleHub`.
 *
 * NON-NEGOTIABLE invariant: the user's message text is NEVER mutated. Recall is
 * injected only into the outgoing **system-prompt tail**, delimited and
 * idempotent turn-over-turn. The bridge strips any prior delimited tail before
 * appending the fresh one, so the dynamic-context region never grows across
 * turns. Mutating the user prompt would corrupt the transcript echo and
 * re-open the comms-stack duplicate class.
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

/** Delimiters wrapping the per-turn dynamic-context region in the system prompt. */
export const DYNAMIC_CONTEXT_START = "<!-- bobbit:dynamic-context:start -->";
export const DYNAMIC_CONTEXT_END = "<!-- bobbit:dynamic-context:end -->";

/** The per-turn hooks that require the in-process bridge extension. */
export const TURN_BRIDGE_HOOKS = ["beforePrompt", "beforeCompact"] as const;

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

  // Self-signed gateway certs: agents run with NODE_TLS_REJECT_UNAUTHORIZED=0
  // in the sandbox; mirror that here so fetch() trusts the local gateway over
  // https without TLS verification failures.
  if (gwUrl.startsWith("https:") && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  async function postHook(route, body, timeoutMs) {
    if (!gwUrl) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(gwUrl + "/api/sessions/" + sessionId + route, {
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

  // Per-turn beforePrompt: inject recall into the system-prompt TAIL only.
  // The user's prompt text (event.prompt) is forwarded read-only and never
  // mutated.
  pi.on("before_agent_start", async (event) => {
    const resp = await postHook(
      "/provider-hooks/before-prompt",
      { prompt: event.prompt },
      ${BEFORE_PROMPT_TIMEOUT_MS},
    );
    if (!resp) return undefined; // failure / timeout — proceed unchanged
    const stripped = stripDelimitedTail(event.systemPrompt || "");
    const tail = typeof resp.tail === "string" ? resp.tail : "";
    return { systemPrompt: stripped + tail };
  });

  // beforeCompact: notify providers; we do not amend compaction output here.
  pi.on("session_before_compact", async () => {
    await postHook("/provider-hooks/before-compact", {}, ${BEFORE_COMPACT_TIMEOUT_MS});
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
export function writeProviderBridgeExtension(sessionId: string): string {
	const cachedPath = bridgeFileCache.get(sessionId);
	if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;

	let code = bridgeCodeCache.get(sessionId);
	if (!code) {
		code = generateProviderBridgeExtension(sessionId);
		bridgeCodeCache.set(sessionId, code);
	}

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
}
