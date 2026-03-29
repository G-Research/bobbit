/**
 * Delegate extension — create independent agent sessions to perform tasks.
 *
 * Registers a `delegate` tool that creates real Bobbit sessions for each delegate.
 * Each delegate session appears in the sidebar, has full chat history, survives
 * restarts, and can be viewed in real-time by clicking on it.
 *
 * The delegate agent has full tool access (bash, read, write, etc.) but gets
 * only AGENTS.md + the instructions you provide — it does NOT see the parent conversation.
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
	status: "completed" | "failed" | "timeout";
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

	// Disable TLS verification for self-signed certs
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

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
	opts?: { title?: string; context?: Record<string, string> },
): Promise<string> {
	const resp = await gatewayFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			delegateOf: parentSessionId,
			instructions,
			cwd,
			title: opts?.title,
			context: opts?.context,
		}),
	});
	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Failed to create delegate session: ${err}`);
	}
	const data = await resp.json() as any;
	return data.id;
}

/** Wait for a delegate session to finish and get its output */
export async function waitForDelegate(
	sessionId: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ status: string; output: string }> {
	// Poll for completion — the /wait endpoint blocks
	const resp = await gatewayFetch(`/api/sessions/${sessionId}/wait`, {
		method: "POST",
		body: JSON.stringify({ timeout_ms: timeoutMs }),
		signal,
	});

	if (!resp.ok) {
		if (resp.status === 408) {
			return { status: "timeout", output: "" };
		}
		return { status: "failed", output: `API error: ${resp.status}` };
	}

	const data = await resp.json() as any;
	return { status: "completed", output: data.output || "" };
}

/** Run a single delegate: create session, wait for completion, return result */
export async function runDelegateSession(
	parentSessionId: string,
	instructions: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	opts?: { title?: string; context?: Record<string, string> },
): Promise<DelegateResult> {
	const startTime = Date.now();
	let sessionId = "";

	try {
		sessionId = await createDelegateSession(parentSessionId, instructions, cwd, opts);

		const result = await waitForDelegate(sessionId, timeoutMs, signal);

		// Terminate the delegate session now that it's done — no reason to keep it alive
		gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});

		return {
			id: sessionId.slice(0, 12),
			sessionId,
			status: result.status as DelegateResult["status"],
			output: result.output,
			durationMs: Date.now() - startTime,
		};
	} catch (err: any) {
		if (signal?.aborted) {
			// Try to terminate the delegate session on abort
			if (sessionId) {
				gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
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
export function getParentSessionId(ctx: any): string {
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

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = (ctx as any).cwd || process.cwd();
			const timeoutMs = (params.timeout_minutes ?? 10) * 60_000;
			const parentSessionId = getParentSessionId(ctx);

			if (params.parallel && params.parallel.length > 0) {
				const completedResults: DelegateResult[] = [];
				const startTime = Date.now();
				const sessionIds: string[] = new Array(params.parallel.length).fill("");

				// Helper: build current state snapshot for progress updates
				function buildProgressUpdate() {
					return {
						content: [{ type: "text" as const, text: `${completedResults.length}/${params.parallel!.length} delegates finished` }],
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
					if (onUpdate && completedResults.length < params.parallel!.length) {
						onUpdate(buildProgressUpdate());
					}
				}, 3000);

				// Create sessions — emit progress after each one so the UI updates incrementally
				for (let i = 0; i < params.parallel.length; i++) {
					const p = params.parallel[i];
					try {
						const sid = await createDelegateSession(parentSessionId, p.instructions, cwd, {
							title: p.instructions.split("\n")[0].slice(0, 60),
							context: { ...params.context, ...p.context },
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

				// Wait for all delegates in parallel
				const promises = sessionIds.map((sid, i) => {
					if (!sid) return Promise.resolve(); // already failed
					return waitForDelegate(sid, timeoutMs, signal).then((result) => {
						completedResults.push({
							id: sid.slice(0, 12),
							sessionId: sid,
							status: result.status as DelegateResult["status"],
							output: result.output,
							durationMs: Date.now() - startTime,
						});
						if (onUpdate) onUpdate(buildProgressUpdate());
					}).catch((err: any) => {
						completedResults.push({
							id: sid.slice(0, 12),
							sessionId: sid,
							status: "failed",
							output: "",
							durationMs: Date.now() - startTime,
							error: err.message,
						});
						if (onUpdate) onUpdate(buildProgressUpdate());
					});
				});

				await Promise.all(promises);
				clearInterval(heartbeat);

				// Build final result
				const lines: string[] = [];
				const details: DelegateDetails = { delegates: [] };
				let failCount = 0;
				for (let i = 0; i < params.parallel.length; i++) {
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
				lines.push(`**Summary:** ${params.parallel.length - failCount}/${params.parallel.length} delegates completed.`);

				return { content: [{ type: "text", text: lines.join("\n") }], details };
			}

			// Single delegate
			if (!params.instructions) {
				return { content: [{ type: "text", text: "Error: 'instructions' is required for a single delegate. Use 'parallel' for multiple delegates." }] };
			}
			const result = await runDelegateSession(
				parentSessionId,
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
