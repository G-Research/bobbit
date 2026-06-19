/**
 * Hindsight agent tools (P5) — `hindsight_recall`, `hindsight_retain`,
 * `hindsight_reflect`.
 *
 * These are PACK-OWNED tools: they ship with the built-in `hindsight` market
 * pack (`pack.yaml.contents.tools: [hindsight]`), so disabling the pack at any
 * scope removes them from session tool resolution.
 *
 * The tools NEVER talk to Hindsight directly and NEVER construct a
 * HindsightClient or read provider config. Instead each tool:
 *   1. mints a tool-bound SERVER-MINTED surface token via
 *      `POST /api/ext/surface-token` ({ sessionId, tool }), then
 *   2. dispatches the pack's own route via `POST /api/ext/route/<name>` with the
 *      minted `surfaceToken`.
 * The route (market-packs/hindsight/src/routes.ts) owns config merge, bank
 * resolution (single shared bank, default `bobbit`), external/managed-mode
 * handling, dormancy, and scope→tag mapping. This keeps the agent surface thin
 * and routes all authorization through the existing surface-token + tool-guard
 * path.
 *
 * CREDENTIALS: read the on-disk gateway URL + token (disk first, env fallback),
 * mirroring `defaults/tools/_shared/gateway.ts`. The logic is inlined rather than
 * imported because the relative depth from this pack file to `defaults/tools` is
 * NOT stable across the repo-source layout and the shipped `dist/.../builtin-packs`
 * layout.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// ── Gateway credential resolution (mirrors defaults/tools/_shared/gateway.ts) ──

function diskStateDir(): string {
	return process.env.BOBBIT_DIR
		? path.join(process.env.BOBBIT_DIR, "state")
		: path.join(homedir(), ".pi");
}

function diskTokenPath(): string {
	const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
	return path.join(diskStateDir(), tokenFile);
}

function diskUrlPath(): string {
	return path.join(diskStateDir(), "gateway-url");
}

type Creds = { token: string; baseUrl: string };

/** Disk-first, env-fallback creds resolver. Returns `{ error }` on miss. */
function readCreds(): Creds | { error: string } {
	try {
		const token = fs.readFileSync(diskTokenPath(), "utf-8").trim();
		const baseUrl = fs.readFileSync(diskUrlPath(), "utf-8").trim().replace(/\/+$/, "");
		if (token && baseUrl) return { token, baseUrl };
	} catch {
		// Disk read failed; fall through to env.
	}
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) return { token: envToken, baseUrl: envUrl.replace(/\/+$/, "") };
	return { error: "BOBBIT credentials not found on disk or in env" };
}

const TRANSIENT_RE = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR_SOCKET|fetch failed/i;

function isTransient(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const cause = (err as { cause?: unknown }).cause;
	const causeMsg = cause instanceof Error ? cause.message : "";
	const causeCode = cause && typeof cause === "object" && "code" in cause
		? String((cause as { code?: unknown }).code)
		: "";
	return TRANSIENT_RE.test([err.message, causeMsg, causeCode].filter(Boolean).join(" "));
}

/** Authenticated JSON POST against the gateway, with light transient-retry +
 *  one creds refresh on 401. Throws on non-2xx with the server `error` field. */
async function apiPost(
	creds: Creds,
	urlPath: string,
	body: unknown,
	sessionId: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const maxAttempts = 4;
	let used = creds;
	let didRefresh = false;
	let lastErr: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const resp = await fetch(`${used.baseUrl}${urlPath}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${used.token}`,
					"Content-Type": "application/json",
					"x-bobbit-session-id": sessionId,
				},
				body: JSON.stringify(body),
				signal,
			});
			if (resp.status === 401 && !didRefresh) {
				didRefresh = true;
				const fresh = readCreds();
				if (!("error" in fresh)) {
					used = fresh;
					continue;
				}
			}
			const text = await resp.text();
			let data: unknown;
			try { data = JSON.parse(text); } catch { data = text; }
			if (!resp.ok) {
				const msg = typeof data === "object" && data !== null && "error" in data
					? String((data as Record<string, unknown>).error)
					: `HTTP ${resp.status}: ${text}`;
				throw new Error(msg);
			}
			return data;
		} catch (err) {
			lastErr = err;
			if (!isTransient(err) || attempt === maxAttempts - 1) throw err;
			await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt)));
		}
	}
	throw lastErr;
}

/**
 * Mint a tool-bound surface token, then dispatch the pack route. The server
 * DERIVES {packId, tool} from the minted token and enforces allowedTools + own
 * session — the route body never carries a pack id.
 */
async function callRoute(
	toolName: string,
	routeName: string,
	routeBody: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const creds = readCreds();
	if ("error" in creds) throw new Error(creds.error);
	const sessionId = process.env.BOBBIT_SESSION_ID;
	if (!sessionId) throw new Error("BOBBIT_SESSION_ID is not set");

	const mint = (await apiPost(creds, "/api/ext/surface-token", { sessionId, tool: toolName }, sessionId, signal)) as {
		token?: string;
	};
	const surfaceToken = mint?.token;
	if (!surfaceToken) throw new Error("surface-token: empty response");

	return apiPost(
		creds,
		`/api/ext/route/${encodeURIComponent(routeName)}`,
		{ sessionId, surfaceToken, init: { method: "POST", body: routeBody } },
		sessionId,
		signal,
	);
}

const SCOPE_DESC = "Memory scope: 'project' (this project) or 'all' (shared bank). Defaults to config.";

interface ToolError {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError: true;
}

function errorResult(text: string, details: Record<string, unknown>): ToolError {
	return { content: [{ type: "text" as const, text }], details, isError: true };
}

const extension: ExtensionFactory = (pi) => {
	// ── hindsight_recall ──
	pi.registerTool({
		name: "hindsight_recall",
		label: "Hindsight Recall",
		description: "Recall relevant memories from the Hindsight bank for a query.",
		promptSnippet: "hindsight_recall: Recall relevant long-term memories for a query.",
		promptGuidelines: [
			"Use hindsight_recall to fetch durable context (past decisions, preferences, project facts) before acting.",
			"scope 'project' restricts to this project; 'all' searches the shared bank.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to recall." }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("all")], { description: SCOPE_DESC }),
			),
		}),
		async execute(_toolCallId: string, params: { query?: string; scope?: "project" | "all" }, signal?: AbortSignal) {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			if (!query) return errorResult("query is required", { query: params.query });
			let res: { configured?: boolean; memories?: unknown[]; error?: string };
			try {
				res = (await callRoute(
					"hindsight_recall",
					"recall",
					{ query, ...(params.scope ? { scope: params.scope } : {}) },
					signal,
				)) as typeof res;
			} catch (e) {
				return errorResult(`Recall failed: ${(e as Error).message}`, { query });
			}
			if (res?.error) return errorResult(`Recall error: ${res.error}`, { query, configured: res.configured });
			const memories = Array.isArray(res?.memories) ? res.memories : [];
			if (res?.configured === false) {
				return {
					content: [{ type: "text" as const, text: "Hindsight is not configured; no memories available." }],
					details: { query, configured: false, count: 0 },
				};
			}
			if (memories.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No relevant memories found." }],
					details: { query, configured: true, count: 0 },
				};
			}
			const text = memories
				.map((m, i) => {
					// Recall results follow the route/client shape `{ id, text, score, ... }`
					// (hindsight-client.ts RecallMemory). Prefer the human-readable `text`;
					// fall back to a legacy `content` field, then to JSON only as a last
					// resort so a successful recall shows memory prose, not a JSON blob.
					const mm = m as { text?: unknown; content?: unknown };
					const body =
						typeof mm?.text === "string" && mm.text.length > 0
							? mm.text
							: typeof mm?.content === "string" && mm.content.length > 0
								? mm.content
								: JSON.stringify(m);
					return `${i + 1}. ${body}`;
				})
				.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { query, configured: true, count: memories.length, memories },
			};
		},
	});

	// ── hindsight_retain ──
	pi.registerTool({
		name: "hindsight_retain",
		label: "Hindsight Retain",
		description: "Persist a memory to the Hindsight bank for future recall.",
		promptSnippet: "hindsight_retain: Save a durable memory for future recall.",
		promptGuidelines: [
			"Use hindsight_retain to durably record a decision, preference, or fact worth remembering.",
			"scope 'project' tags the memory to this project; 'all' keeps it unscoped on the shared bank.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "The memory text to store." }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("all")], { description: SCOPE_DESC }),
			),
			tags: Type.Optional(
				Type.Record(Type.String(), Type.String(), { description: "Extra key/value tags (additive)." }),
			),
			sync: Type.Optional(Type.Boolean({ description: "Wait for the write to be durable. Default false." })),
		}),
		async execute(
			_toolCallId: string,
			params: { content?: string; scope?: "project" | "all"; tags?: Record<string, string>; sync?: boolean },
			signal?: AbortSignal,
		) {
			const content = typeof params.content === "string" ? params.content.trim() : "";
			if (!content) return errorResult("content is required", {});
			let res: { ok?: boolean; configured?: boolean; error?: string };
			try {
				res = (await callRoute(
					"hindsight_retain",
					"retain",
					{
						content,
						...(params.scope ? { scope: params.scope } : {}),
						...(params.tags ? { tags: params.tags } : {}),
						...(params.sync !== undefined ? { sync: params.sync } : {}),
					},
					signal,
				)) as typeof res;
			} catch (e) {
				return errorResult(`Retain failed: ${(e as Error).message}`, {});
			}
			if (res?.ok) {
				return {
					content: [{ type: "text" as const, text: "Memory retained." }],
					details: { ok: true, configured: true },
				};
			}
			if (res?.configured === false) {
				return errorResult("Hindsight is not configured; memory not retained.", { configured: false });
			}
			return errorResult(`Retain failed: ${res?.error ?? "unknown error"}`, { configured: res?.configured });
		},
	});

	// ── hindsight_reflect ──
	pi.registerTool({
		name: "hindsight_reflect",
		label: "Hindsight Reflect",
		description: "Reflect over the Hindsight bank to synthesize an answer to a prompt.",
		promptSnippet: "hindsight_reflect: Synthesize an answer from long-term memory.",
		promptGuidelines: [
			"Use hindsight_reflect for a synthesized answer drawing on accumulated memory, not a raw recall list.",
			"scope 'project' filters reflection to this project's memories; 'all' reflects over the shared bank.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "The question to reflect on." }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("all")], { description: SCOPE_DESC }),
			),
		}),
		async execute(_toolCallId: string, params: { prompt?: string; scope?: "project" | "all" }, signal?: AbortSignal) {
			const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
			if (!prompt) return errorResult("prompt is required", {});
			let res: { configured?: boolean; text?: string; error?: string };
			try {
				res = (await callRoute(
					"hindsight_reflect",
					"reflect",
					{ prompt, ...(params.scope ? { scope: params.scope } : {}) },
					signal,
				)) as typeof res;
			} catch (e) {
				return errorResult(`Reflect failed: ${(e as Error).message}`, { prompt });
			}
			if (res?.error) return errorResult(`Reflect error: ${res.error}`, { prompt, configured: res.configured });
			if (res?.configured === false) {
				return {
					content: [{ type: "text" as const, text: "Hindsight is not configured; nothing to reflect on." }],
					details: { prompt, configured: false },
				};
			}
			const text = typeof res?.text === "string" && res.text.length > 0 ? res.text : "(no reflection produced)";
			return {
				content: [{ type: "text" as const, text }],
				details: { prompt, configured: true },
			};
		},
	});
};

export default extension;
