/**
 * Delegate extension — create independent agent sessions to perform tasks.
 *
 * Registers a `delegate` tool that creates real Bobbit sessions for each delegate.
 * Each delegate session appears in the sidebar, has full chat history, survives
 * restarts, and can be viewed in real-time by clicking on it.
 *
 * The delegate agent has full tool access (bash, read, write, etc.) but gets
 * only AGENTS.md + the instructions you provide — it does NOT see the parent conversation.
 *
 * Restart resilience: parent ↔ child rendezvous flows through the
 * `DelegateHarness` blocking-tool pattern (mirrors VerificationHarness; see
 * docs/design/delegate-restart-resilience.md).  The tool POSTs
 * /api/internal/delegate/wait to register a parked Promise keyed by
 * (parentSessionId, toolUseId). The harness persists the entry to
 * <stateDir>/active-delegates.json before resolving, so a server restart
 * mid-flight is recoverable: on resume the parent re-POSTs and either drains
 * a latched result or re-registers an awaiter for an in-flight child.
 *
 * Parallel array: each slot uses key `${toolUseId}#${i}` so independent
 * (parent, slot) waits never collide. Cancel: parent abort fires
 * /api/internal/delegate/cancel before deleting the child session — this
 * settles the parked Promise on the server side cleanly rather than letting
 * the harness leak a pending entry.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ──

export interface DelegateResult {
	id: string;
	sessionId: string;
	status: "completed" | "failed" | "timeout" | "terminated";
	output: string;
	durationMs: number;
	error?: string;
}

/** Details passed to the UI renderer */
export interface DelegateDetails {
	delegates: Array<{
		id: string;
		sessionId: string;
		instructions: string;
		status: string;
		durationMs: number;
	}>;
}

// ── Gateway API helpers ──

function getGatewayUrl(): string {
	if (process.env.BOBBIT_GATEWAY_URL) return process.env.BOBBIT_GATEWAY_URL.replace(/\/+$/, "");
	// Prefer BOBBIT_DIR (always set by rpc-bridge), fall back to ~/.pi/
	const stateDir = process.env.BOBBIT_DIR
		? path.join(process.env.BOBBIT_DIR, "state")
		: path.join(os.homedir(), ".pi");
	const urlPath = path.join(stateDir, "gateway-url");
	if (fs.existsSync(urlPath)) {
		return fs.readFileSync(urlPath, "utf-8").trim();
	}
	throw new Error(`Gateway URL not found at ${urlPath} — is the gateway running?`);
}

function getGatewayToken(): string {
	if (process.env.BOBBIT_TOKEN) return process.env.BOBBIT_TOKEN;
	// Prefer BOBBIT_DIR (always set by rpc-bridge), fall back to ~/.pi/
	const stateDir = process.env.BOBBIT_DIR
		? path.join(process.env.BOBBIT_DIR, "state")
		: path.join(os.homedir(), ".pi");
	const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
	const tokenPath = path.join(stateDir, tokenFile);
	if (fs.existsSync(tokenPath)) {
		return fs.readFileSync(tokenPath, "utf-8").trim();
	}
	throw new Error(`Gateway token not found at ${tokenPath}`);
}

async function gatewayFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
	const url = getGatewayUrl();
	const token = getGatewayToken();

	return fetch(`${url}${endpoint}`, {
		...options,
		headers: {
			"Authorization": `Bearer ${token}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
}

/** Create a delegate session and return its ID */
export async function createDelegateSession(
	parentSessionId: string,
	instructions: string,
	cwd: string,
	opts?: { title?: string; context?: Record<string, string>; toolUseId?: string; timeoutMs?: number },
): Promise<string> {
	const resp = await gatewayFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			delegateOf: parentSessionId,
			instructions,
			cwd,
			title: opts?.title,
			context: opts?.context,
			// Threading toolUseId+timeoutMs so the server can wire the live-path
			// completion listener via attachDelegateCompletionListener (see
			// docs/design/delegate-restart-resilience.md §6.3). The server-side
			// /api/sessions delegate-create branch forwards these to
			// SessionManager.createDelegateSession.
			toolUseId: opts?.toolUseId,
			timeoutMs: opts?.timeoutMs,
		}),
	});
	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Failed to create delegate session: ${err}`);
	}
	const data = await resp.json() as any;
	return data.id;
}

/**
 * Register a parked Promise on the DelegateHarness and wait for completion.
 *
 * Replaces the legacy /api/sessions/:id/wait flow. The `/api/internal/delegate/wait`
 * endpoint:
 *   - registers the wait keyed by (parentSessionId, toolUseId), drains any
 *     latched result if present (the harness's submit-before-register
 *     idempotency contract).
 *   - holds the response open and writes chunked heartbeat newlines so undici
 *     bodyTimeout can't kill the connection mid-wait.
 *   - on terminal child status, resolves the Promise; the response body is
 *     `DelegateResultPayload` JSON (whitespace-trimmed by the heartbeat).
 *
 * On AbortSignal abort, the caller must POST /api/internal/delegate/cancel —
 * we fire-and-forget that from runDelegateSession() before the DELETE so the
 * server-side parked Promise doesn't leak.
 */
export async function waitForDelegate(
	args: {
		parentSessionId: string;
		toolUseId: string;
		delegateSessionId: string;
		cwd: string;
		title?: string;
		sandboxed?: boolean;
		instructions: string;
		timeoutMs: number;
	},
	signal?: AbortSignal,
): Promise<{ status: string; output: string; error?: string }> {
	// Server-side hardTimeout fires at timeoutMs+30s; let undici give us a few
	// seconds beyond that so the server-side timeout is authoritative.
	const fetchTimeout = AbortSignal.timeout(args.timeoutMs + 60_000);
	const combinedSignal = signal
		? AbortSignal.any([signal, fetchTimeout])
		: fetchTimeout;

	const resp = await gatewayFetch("/api/internal/delegate/wait", {
		method: "POST",
		body: JSON.stringify({
			parentSessionId: args.parentSessionId,
			toolUseId: args.toolUseId,
			delegateSessionId: args.delegateSessionId,
			cwd: args.cwd,
			title: args.title,
			sandboxed: args.sandboxed,
			instructions: args.instructions,
			timeoutMs: args.timeoutMs,
		}),
		signal: combinedSignal,
	});

	if (!resp.ok) {
		if (resp.status === 408) {
			return { status: "timeout", output: "" };
		}
		let bodyText = "";
		try { bodyText = await resp.text(); } catch { /* ignore */ }
		return { status: "failed", output: "", error: `delegate/wait HTTP ${resp.status}${bodyText ? ": " + bodyText : ""}` };
	}

	// Body is chunked with heartbeat newlines; the trailing entry is JSON.
	const rawText = await resp.text();
	let data: any;
	try {
		data = JSON.parse(rawText.trim());
	} catch (err: any) {
		return { status: "failed", output: "", error: `delegate/wait parse error: ${err.message}` };
	}
	// data shape: { status, output, error? } per DelegateResultPayload
	if (typeof data?.status !== "string") {
		return { status: "failed", output: "", error: "delegate/wait: malformed response" };
	}
	return { status: data.status, output: typeof data.output === "string" ? data.output : "", error: data.error };
}

/**
 * Fire-and-forget cancellation of a parked delegate wait.  Called on
 * AbortSignal abort BEFORE the DELETE /api/sessions/:id so the harness's
 * parked Promise resolves cleanly with status="terminated" instead of leaking.
 */
async function cancelDelegateWait(parentSessionId: string, toolUseId: string, reason: string): Promise<void> {
	try {
		await gatewayFetch("/api/internal/delegate/cancel", {
			method: "POST",
			body: JSON.stringify({ parentSessionId, toolUseId, reason }),
		});
	} catch { /* fire-and-forget */ }
}

/** Run a single delegate: create session, wait for completion, return result */
export async function runDelegateSession(
	parentSessionId: string,
	toolUseId: string,
	instructions: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	opts?: { title?: string; context?: Record<string, string> },
): Promise<DelegateResult> {
	const startTime = Date.now();
	let sessionId = "";

	try {
		sessionId = await createDelegateSession(parentSessionId, instructions, cwd, {
			...opts,
			toolUseId,
			timeoutMs,
		});

		const result = await waitForDelegate({
			parentSessionId,
			toolUseId,
			delegateSessionId: sessionId,
			cwd,
			title: opts?.title,
			instructions,
			timeoutMs,
		}, signal);

		// Terminate the delegate session (archives it). On abort the catch
		// branch already issued cancel + DELETE; this is the happy-path cleanup.
		try { await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }); } catch { /* ignore */ }

		return {
			id: sessionId.slice(0, 12),
			sessionId,
			status: result.status as DelegateResult["status"],
			output: result.output,
			durationMs: Date.now() - startTime,
			error: result.error,
		};
	} catch (err: any) {
		if (signal?.aborted) {
			// Cancel the parked Promise FIRST so the server-side wait settles
			// cleanly, then archive the child via DELETE.
			if (sessionId) {
				await cancelDelegateWait(parentSessionId, toolUseId, "Aborted by user");
				try { await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }); } catch { /* ignore */ }
			}
			return {
				id: sessionId?.slice(0, 12) || "unknown",
				sessionId,
				status: "failed",
				output: "",
				durationMs: Date.now() - startTime,
				error: "Aborted by user",
			};
		}
		return {
			id: sessionId?.slice(0, 12) || "unknown",
			sessionId,
			status: "failed",
			output: "",
			durationMs: Date.now() - startTime,
			error: err.message,
		};
	}
}

// ── Discover parent session ID ──

/**
 * Try to find the current session's gateway session ID.
 * The gateway passes this via env or we can read from the session state.
 */
export function getParentSessionId(_ctx: any): string {
	// The session manager sets this in the agent's environment
	if (process.env.BOBBIT_SESSION_ID) return process.env.BOBBIT_SESSION_ID;
	// Fallback: use a placeholder (the server can figure it out from the auth)
	return "unknown";
}

// ── Extension registration ──

const extension: ExtensionFactory = (pi) => {
	// Prevent recursive delegation — delegate sessions should not spawn more delegates
	if (process.env.BOBBIT_DELEGATE_OF) {
		// Don't register the delegate tool in delegate sessions
		return;
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Run a task in a separate agent process. The delegate agent has full tool access (bash, read, write, edit) " +
			"but receives only the instructions you provide — it does not see this conversation. " +
			"Use this when you need isolated execution, parallel work, or an independent perspective. " +
			"The tool blocks until the delegate finishes and returns its output.",
		promptSnippet:
			"delegate - Run a task in a separate agent process with isolated context. Blocks until complete.",
		promptGuidelines: [
			"Use delegate when a task benefits from isolated context (e.g., code review, independent analysis)",
			"The delegate agent has full tool access — it can read files, run commands, write code, etc.",
			"Provide clear, self-contained instructions — the delegate cannot see this conversation",
			"Use the 'parallel' parameter to run multiple delegates concurrently",
		],
		parameters: Type.Object({
			instructions: Type.Optional(Type.String({ description: "Task instructions for the delegate agent. Be specific and self-contained. Required for single delegate, optional when using parallel." })),
			parallel: Type.Optional(Type.Array(
				Type.Object({
					instructions: Type.String({ description: "Instructions for this parallel delegate" }),
					context: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional context key-values" })),
				}),
				{ description: "Run multiple delegates in parallel instead. Each gets its own instructions." },
			)),
			context: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional context key-values passed to the delegate" })),
			timeout_minutes: Type.Optional(Type.Number({ description: "Timeout in minutes (default: 10)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = (ctx as any).cwd || process.cwd();
			const timeoutMs = (params.timeout_minutes ?? 10) * 60_000;
			const parentSessionId = getParentSessionId(ctx);

			if (params.parallel && params.parallel.length > 0) {
				const parallelN = params.parallel.length;
				const completedResults: DelegateResult[] = [];
				const startTime = Date.now();
				const sessionIds: string[] = new Array(parallelN).fill("");
				// Per-slot harness keys — `${toolUseId}#${i}` ensures independent
				// (parent, slot) tracking across the parallel array.
				const slotToolUseIds: string[] = Array.from({ length: parallelN }, (_, i) => `${toolCallId}#${i}`);

				// Helper: build current state snapshot for progress updates
				function buildProgressUpdate() {
					return {
						content: [{ type: "text" as const, text: `${completedResults.length}/${parallelN} delegates finished` }],
						details: {
							delegates: params.parallel!.map((p: any, j: number) => {
								const sid = sessionIds[j];
								const cr = completedResults.find((c) => c.sessionId === sid);
								if (cr) return { id: cr.id, sessionId: cr.sessionId, instructions: p.instructions.split("\n")[0].slice(0, 100), status: cr.status, durationMs: cr.durationMs };
								return { id: sid?.slice(0, 12) || "?", sessionId: sid || "", instructions: p.instructions.split("\n")[0].slice(0, 100), status: sid ? "running" : "starting", durationMs: Date.now() - startTime };
							}),
						},
					};
				}

				// Emit immediately so the UI shows "starting..." cards
				if (onUpdate) onUpdate(buildProgressUpdate());

				// Start heartbeat right away (before session creation)
				const heartbeat = setInterval(() => {
					if (onUpdate && completedResults.length < parallelN) {
						onUpdate(buildProgressUpdate());
					}
				}, 3000);

				// Create sessions — emit progress after each one so the UI updates incrementally
				for (let i = 0; i < parallelN; i++) {
					const p = params.parallel[i];
					try {
						const sid = await createDelegateSession(parentSessionId, p.instructions, cwd, {
							title: p.instructions.split("\n")[0].slice(0, 60),
							context: { ...params.context, ...p.context },
							toolUseId: slotToolUseIds[i],
							timeoutMs,
						});
						sessionIds[i] = sid;
						if (onUpdate) onUpdate(buildProgressUpdate());
					} catch (err: any) {
						completedResults.push({
							id: "error",
							sessionId: "",
							status: "failed",
							output: "",
							durationMs: 0,
							error: err.message,
						});
						if (onUpdate) onUpdate(buildProgressUpdate());
					}
				}

				// Wait for all delegates in parallel — each on its own (parent, toolUseId#i) key.
				const promises = sessionIds.map((sid, i) => {
					if (!sid) return Promise.resolve(); // already failed during creation
					const slotToolUseId = slotToolUseIds[i];
					const slotInstructions = params.parallel![i].instructions;
					return waitForDelegate({
						parentSessionId,
						toolUseId: slotToolUseId,
						delegateSessionId: sid,
						cwd,
						title: slotInstructions.split("\n")[0].slice(0, 60),
						instructions: slotInstructions,
						timeoutMs,
					}, signal).then(async (result) => {
						completedResults.push({
							id: sid.slice(0, 12),
							sessionId: sid,
							status: result.status as DelegateResult["status"],
							output: result.output,
							durationMs: Date.now() - startTime,
							error: result.error,
						});
						// Terminate the completed delegate session (archives it)
						try { await gatewayFetch(`/api/sessions/${sid}`, { method: "DELETE" }); } catch { /* ignore */ }
						if (onUpdate) onUpdate(buildProgressUpdate());
					}).catch(async (err: any) => {
						// On signal abort, cancel the parked wait first.
						if (signal?.aborted) {
							await cancelDelegateWait(parentSessionId, slotToolUseId, "Aborted by user");
						}
						completedResults.push({
							id: sid.slice(0, 12),
							sessionId: sid,
							status: "failed",
							output: "",
							durationMs: Date.now() - startTime,
							error: err.message,
						});
						// Terminate even failed delegate sessions (archives them)
						try { await gatewayFetch(`/api/sessions/${sid}`, { method: "DELETE" }); } catch { /* ignore */ }
						if (onUpdate) onUpdate(buildProgressUpdate());
					});
				});

				await Promise.all(promises);
				clearInterval(heartbeat);

				// Build final result
				const lines: string[] = [];
				const details: DelegateDetails = { delegates: [] };
				let failCount = 0;
				for (let i = 0; i < parallelN; i++) {
					const sid = sessionIds[i];
					const r = completedResults.find((c) => c.sessionId === sid);
					const ic = r?.status === "completed" ? "✓" : r?.status === "timeout" ? "⏱" : "✗";
					lines.push(`### ${ic} Delegate ${i + 1} (${r?.status || "failed"}, ${Math.round((r?.durationMs || 0) / 1000)}s)`);
					if (r?.error) lines.push(`**Error:** ${r.error}`);
					if (r?.output) {
						const truncated = r.output.length > 3000 ? r.output.slice(0, 3000) + "\n...(truncated)" : r.output;
						lines.push("```\n" + truncated + "\n```");
					}
					lines.push("");
					if (r?.status !== "completed") failCount++;
					details.delegates.push({
						id: sid?.slice(0, 12) || "?",
						sessionId: sid || "",
						instructions: params.parallel[i].instructions.split("\n")[0].slice(0, 100),
						status: r?.status || "failed",
						durationMs: r?.durationMs || 0,
					});
				}
				lines.push(`**Summary:** ${parallelN - failCount}/${parallelN} delegates completed.`);

				return { content: [{ type: "text", text: lines.join("\n") }], details };
			}

			// Single delegate
			if (!params.instructions) {
				return { content: [{ type: "text", text: "Error: 'instructions' is required for a single delegate. Use 'parallel' for multiple delegates." }] };
			}
			const result = await runDelegateSession(
				parentSessionId,
				toolCallId,
				params.instructions,
				cwd,
				timeoutMs,
				signal,
				{ context: params.context },
			);

			const lines: string[] = [];
			lines.push(`**Status:** ${result.status} (${Math.round(result.durationMs / 1000)}s)`);
			if (result.error) lines.push(`**Error:** ${result.error}`);
			if (result.output) {
				const truncated = result.output.length > 5000 ? result.output.slice(0, 5000) + "\n...(truncated)" : result.output;
				lines.push("", truncated);
			}

			const details: DelegateDetails = {
				delegates: [{
					id: result.id,
					sessionId: result.sessionId,
					instructions: params.instructions.split("\n")[0].slice(0, 100),
					status: result.status,
					durationMs: result.durationMs,
				}],
			};

			return { content: [{ type: "text", text: lines.join("\n") }], details };
		},
	});
};

export default extension;
