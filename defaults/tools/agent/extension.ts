/**
 * Team agent surface — launch and orchestrate child agents.
 *
 * Registers `team_delegate` (spawn an isolated child agent in your worktree —
 * blocking one-shot by default, `non_blocking` opt-in) plus the orchestration
 * verbs (`team_wait`, `team_prompt`, `team_dismiss`, `team_steer`,
 * `team_abort`) that operate over the caller's OWN child sessions. Also
 * registers `read_session` (transcript reader) for every session.
 *
 * All verbs are agent-process tools: they call the gateway over authenticated
 * REST using on-disk credentials (`_shared/gateway.ts`) and hit the
 * server-side `/api/sessions/:id/orchestrate/*` routes, which invoke the
 * in-process `OrchestrationCore`. There is NO inlined creds logic and NO
 * client-side spawn/wait loop — the server owns the child lifecycle.
 *
 * A spawned child agent gets full tool access (bash, read, write, etc.) but
 * sees only AGENTS.md + the instructions you provide — it does NOT see the
 * parent conversation. The child inherits the parent's current model and a
 * copy of the parent's allowed tools MINUS every spawn verb (no grandchildren).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readGatewayCreds, apiCall } from "../_shared/gateway.js";

// ── Types ──

/** One child entry in the blocking-delegate response (drop-in parity). */
interface DelegateResultEntry {
	id: string;
	sessionId: string;
	status: "completed" | "failed" | "timeout" | "terminated";
	output: string;
	durationMs: number;
	error?: string;
}

interface DelegateRouteResponse {
	delegates: DelegateResultEntry[];
	summary?: string;
}

/** Child status vocabulary returned by the orchestrate routes (§9). */
type ChildStatus =
	| "idle"
	| "streaming"
	| "queued"
	| "not-started"
	| "terminated"
	| "timeout"
	| "failed";

interface WaitStatusEntry {
	sessionId: string;
	status: ChildStatus;
	title?: string;
}

interface WaitRouteResponse {
	firstIdle?: string;
	statuses?: WaitStatusEntry[];
	outputTail?: string;
	remaining?: number;
}

interface SpawnedChild {
	id?: string;
	sessionId?: string;
	childSessionId?: string;
	title?: string;
	status?: string;
}

interface SpawnRouteResponse {
	children?: SpawnedChild[];
	childSessionId?: string;
	sessionId?: string;
	title?: string;
}

/** Details shape consumed by the (shared) DelegateRenderer. */
interface DelegateDetails {
	delegates: Array<{
		id: string;
		sessionId: string;
		instructions: string;
		status: string;
		durationMs: number;
	}>;
}

// ── Helpers ──

function getCallerSessionId(): string | undefined {
	return process.env.BOBBIT_SESSION_ID || undefined;
}

function firstLine(s: string, max = 100): string {
	return (s || "").split("\n")[0].slice(0, max);
}

/** Map an orchestration ChildStatus to the renderer card status vocabulary. */
function cardStatus(status: string): string {
	switch (status) {
		case "idle":
		case "completed":
			return "completed";
		case "streaming":
			return "running";
		case "queued":
			return "running";
		case "not-started":
			return "starting";
		case "timeout":
			return "timeout";
		case "terminated":
		case "failed":
			return "failed";
		default:
			return status;
	}
}

const TERMINAL_STATUSES = new Set<ChildStatus>(["terminated", "timeout", "failed"]);
const SETTLED_STATUSES = new Set<ChildStatus>(["idle", "terminated", "timeout", "failed"]);

// ── read_session helpers ──

interface ReadSessionParams {
	session_id: string;
	offset?: number;
	limit?: number;
	pattern?: string;
	case_sensitive?: boolean;
	context?: number;
	verbose?: boolean;
}

async function callReadSessionEndpoint(
	params: ReadSessionParams,
): Promise<{ ok: boolean; status: number; body: any }> {
	const credsResult = readGatewayCreds();
	if ("error" in credsResult) {
		throw new Error(credsResult.error);
	}
	const { token, baseUrl } = credsResult;
	const qs = new URLSearchParams();
	if (params.offset !== undefined) qs.set("offset", String(params.offset));
	if (params.limit !== undefined) qs.set("limit", String(params.limit));
	if (params.pattern !== undefined && params.pattern !== "") qs.set("pattern", params.pattern);
	if (params.case_sensitive) qs.set("case_sensitive", "1");
	if (params.context !== undefined) qs.set("context", String(params.context));
	if (params.verbose) qs.set("verbose", "1");
	const suffix = qs.toString() ? `?${qs.toString()}` : "";
	const headers: Record<string, string> = {
		"Authorization": `Bearer ${token}`,
		"Content-Type": "application/json",
	};
	const caller = getCallerSessionId();
	if (caller) headers["x-bobbit-session-id"] = caller;
	const resp = await fetch(
		`${baseUrl}/api/sessions/${encodeURIComponent(params.session_id)}/transcript${suffix}`,
		{ method: "GET", headers },
	);
	let body: any = undefined;
	try { body = await resp.json(); } catch { body = undefined; }
	return { ok: resp.ok, status: resp.status, body };
}

// ── Extension registration ──

const extension: ExtensionFactory = (pi) => {
	const ownerSessionId = getCallerSessionId();
	const isTeamLead = !!process.env.BOBBIT_GOAL_ID;

	/** POST/GET the orchestrate route family against the OWNER session. */
	async function orchestrate(method: string, verb: string, body?: unknown): Promise<unknown> {
		const credsResult = readGatewayCreds();
		if ("error" in credsResult) {
			throw new Error(credsResult.error);
		}
		const owner = ownerSessionId || "unknown";
		return apiCall(credsResult, method, `/api/sessions/${owner}/orchestrate/${verb}`, body);
	}

	function ok(text: string, details?: unknown) {
		return { content: [{ type: "text" as const, text }], details };
	}

	function fail(msg: string) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
	}

	// ── read_session (registered for every session) ──
	pi.registerTool({
		name: "read_session",
		label: "Read Session",
		description: "Read another session's transcript. Paginated, regex-filterable.",
		promptSnippet:
			"read_session - Read another session's transcript with pagination and regex filtering.",
		promptGuidelines: [
			"Default returns compact summaries — use verbose:true only when you need full tool inputs/results",
			"Tail with offset:-N, limit:N (e.g. -20, 20 for the last 20 messages)",
			"Find specific events with pattern (regex). Combine with offset:-N, limit:N to get the last N matches.",
			"Use context:1..5 to expand each pattern match by ±N neighbours",
		],
		parameters: Type.Object({
			session_id: Type.String(),
			offset: Type.Optional(Type.Number({ description: "Default 0. Negative indexes from end." })),
			limit: Type.Optional(Type.Number({ description: "Default 20, clamped to [1, 200]." })),
			pattern: Type.Optional(Type.String({ description: "Regex filter on message text and tool blocks." })),
			case_sensitive: Type.Optional(Type.Boolean()),
			context: Type.Optional(Type.Number({ description: "Expand each match by ±N neighbours (0..5)." })),
			verbose: Type.Optional(Type.Boolean({ description: "Return full content blocks instead of summaries." })),
		}),

		async execute(_toolCallId, params) {
			let result: { ok: boolean; status: number; body: any };
			try {
				result = await callReadSessionEndpoint(params as ReadSessionParams);
			} catch (err: any) {
				return {
					isError: true,
					content: [{ type: "text", text: JSON.stringify({ error: "transcript_unavailable", detail: err?.message ?? String(err) }) }],
				};
			}
			if (!result.ok) {
				const code = (result.body && typeof result.body.error === "string") ? result.body.error : "transcript_unavailable";
				const detail = (result.body && typeof result.body.detail === "string") ? result.body.detail : undefined;
				return {
					isError: true,
					content: [{ type: "text", text: JSON.stringify(detail ? { error: code, detail } : { error: code }) }],
				};
			}
			const envelope = result.body;
			return {
				content: [{ type: "text", text: JSON.stringify(envelope) }],
				details: {
					session_id: (params as ReadSessionParams).session_id,
					total: envelope?.total,
					matchCount: envelope?.matchCount,
					returned: envelope?.returned,
					offsetStart: envelope?.offsetStart,
					offsetEnd: envelope?.offsetEnd,
					messages: envelope?.messages,
				},
			};
		},
	});

	// ── team_delegate ──
	pi.registerTool({
		name: "team_delegate",
		label: "Delegate to Agent",
		description: "Spawn a child agent in your worktree. Blocks until it finishes; non_blocking to detach.",
		promptSnippet:
			"team_delegate - Spawn a child agent in your worktree with isolated context. Blocking one-shot by default.",
		promptGuidelines: [
			"Use team_delegate when a task benefits from isolated context (e.g. code review, independent analysis)",
			"The child has full tool access but cannot spawn its own children, and cannot see this conversation",
			"Provide clear, self-contained instructions — pass file paths and requirements in context",
			"Use 'parallel' to run multiple children concurrently; blocking mode waits for all to finish",
			"non_blocking:true detaches — the child shares your worktree for an open-ended life (last-write-wins); orchestrate it with team_wait/team_prompt/team_dismiss",
		],
		parameters: Type.Object({
			instructions: Type.Optional(Type.String({ description: "Required for a single child; optional with parallel." })),
			parallel: Type.Optional(Type.Array(
				Type.Object({
					instructions: Type.String(),
					context: Type.Optional(Type.Record(Type.String(), Type.String())),
				}),
				{ description: "Run multiple children concurrently." },
			)),
			context: Type.Optional(Type.Record(Type.String(), Type.String())),
			role: Type.Optional(Type.String({ description: "Optional role to inject into the child." })),
			model: Type.Optional(Type.String({ description: "Child model. Default: inherit your current model." })),
			thinking_level: Type.Optional(Type.String({ description: "Child thinking level. Default: inherit yours." })),
			read_only: Type.Optional(Type.Boolean({ description: "Spawn a read-only child (cannot edit files)." })),
			non_blocking: Type.Optional(Type.Boolean({ description: "Detach instead of blocking; orchestrate via team_wait." })),
			timeout_minutes: Type.Optional(Type.Number({ description: "Blocking-mode timeout. Default 10." })),
		}),

		async execute(_toolCallId, params) {
			const timeoutMs = (params.timeout_minutes ?? 10) * 60_000;
			const hasParallel = Array.isArray(params.parallel) && params.parallel.length > 0;
			if (!hasParallel && !params.instructions) {
				return fail("Error: 'instructions' is required for a single child. Use 'parallel' for multiple children.");
			}

			const common: Record<string, unknown> = {};
			if (params.role) common.role = params.role;
			if (params.model) common.model = params.model;
			if (params.thinking_level) common.thinking_level = params.thinking_level;
			if (params.read_only) common.read_only = params.read_only;
			if (params.context) common.context = params.context;

			// ── Non-blocking: spawn and return immediately ──
			if (params.non_blocking) {
				const body: Record<string, unknown> = { ...common };
				if (hasParallel) body.parallel = params.parallel;
				else body.instructions = params.instructions;
				let resp: SpawnRouteResponse;
				try {
					resp = (await orchestrate("POST", "spawn", body)) as SpawnRouteResponse;
				} catch (e: any) {
					return fail(e?.message ?? String(e));
				}
				const children = normalizeSpawned(resp);
				const instrFor = (i: number) =>
					hasParallel ? firstLine(params.parallel![i].instructions) : firstLine(params.instructions || "");
				const details: DelegateDetails = {
					delegates: children.map((c, i) => ({
						id: (c.sessionId || "").slice(0, 12) || "?",
						sessionId: c.sessionId || "",
						instructions: c.title || instrFor(i),
						status: "running",
						durationMs: 0,
					})),
				};
				const lines = [
					`Spawned ${children.length} non-blocking child agent(s):`,
					...children.map((c, i) => `  • ${c.sessionId} — ${c.title || instrFor(i)}`),
					"",
					"They run in YOUR worktree (shared, last-write-wins). Call team_wait to collect results, team_prompt to follow up, or team_dismiss to stop them.",
				];
				return ok(lines.join("\n"), details);
			}

			// ── Blocking one-shot: spawn → wait(all) → auto-dismiss (server-side) ──
			const body: Record<string, unknown> = { ...common, timeout_ms: timeoutMs };
			if (hasParallel) body.parallel = params.parallel;
			else body.instructions = params.instructions;

			let resp: DelegateRouteResponse;
			try {
				resp = (await orchestrate("POST", "delegate", body)) as DelegateRouteResponse;
			} catch (e: any) {
				return fail(e?.message ?? String(e));
			}

			const delegates = Array.isArray(resp?.delegates) ? resp.delegates : [];
			const instrFor = (i: number) =>
				hasParallel ? firstLine(params.parallel![i].instructions) : firstLine(params.instructions || "");

			const details: DelegateDetails = {
				delegates: delegates.map((d, i) => ({
					id: d.id || (d.sessionId || "").slice(0, 12) || "?",
					sessionId: d.sessionId || "",
					instructions: instrFor(i),
					status: cardStatus(d.status),
					durationMs: d.durationMs || 0,
				})),
			};

			const lines: string[] = [];
			if (delegates.length <= 1) {
				const d = delegates[0];
				lines.push(`**Status:** ${d?.status ?? "failed"} (${Math.round((d?.durationMs ?? 0) / 1000)}s)`);
				if (d?.error) lines.push(`**Error:** ${d.error}`);
				if (d?.output) {
					const out = d.output.length > 5000 ? d.output.slice(0, 5000) + "\n...(truncated)" : d.output;
					lines.push("", out);
				}
			} else {
				delegates.forEach((d, i) => {
					const ic = d.status === "completed" ? "✓" : d.status === "timeout" ? "⏱" : "✗";
					lines.push(`### ${ic} Child ${i + 1} (${d.status}, ${Math.round((d.durationMs || 0) / 1000)}s)`);
					if (d.error) lines.push(`**Error:** ${d.error}`);
					if (d.output) {
						const out = d.output.length > 3000 ? d.output.slice(0, 3000) + "\n...(truncated)" : d.output;
						lines.push("```\n" + out + "\n```");
					}
					lines.push("");
				});
				lines.push(resp.summary ?? `**Summary:** ${delegates.filter(d => d.status === "completed").length}/${delegates.length} children completed.`);
			}
			return ok(lines.join("\n"), details);
		},
	});

	// ── team_wait ──
	pi.registerTool({
		name: "team_wait",
		label: "Wait for Child Agent",
		description: "Wait for your child agents; returns when the first becomes idle, with the status of the rest.",
		promptSnippet:
			"team_wait - Wait for your child agents; returns on the first idle child plus status of the others.",
		promptGuidelines: [
			"Returns as soon as ONE awaited child becomes idle (or settles) — process it, then call team_wait again for the rest",
			"Omit child_session_ids to await all your live children",
			"Use read_session on the returned child to read its full transcript",
		],
		parameters: Type.Object({
			child_session_ids: Type.Optional(Type.Array(Type.String(), { description: "Children to await. Default: all your live children." })),
			timeout_minutes: Type.Optional(Type.Number({ description: "Heartbeat timeout. Default 10." })),
		}),

		async execute(_toolCallId, params) {
			const body: Record<string, unknown> = {};
			if (params.child_session_ids && params.child_session_ids.length > 0) {
				body.childSessionIds = params.child_session_ids;
			}
			body.timeout_ms = (params.timeout_minutes ?? 10) * 60_000;
			let resp: WaitRouteResponse;
			try {
				resp = (await orchestrate("POST", "wait", body)) as WaitRouteResponse;
			} catch (e: any) {
				return fail(e?.message ?? String(e));
			}
			const { text, details } = formatWaitResult(resp);
			return ok(text, details);
		},
	});

	// ── Own-children orchestration verbs ──
	// Goal/team-lead sessions get these (goal-scoped) from team/extension.ts;
	// non-team-lead sessions get them here, routed through /orchestrate/* to
	// operate over the caller's OWN child agents.
	if (!isTeamLead) {
		pi.registerTool({
			name: "team_prompt",
			label: "Prompt Child Agent",
			description: "Prompt one of your child agents. Runs immediately if idle, else queues.",
			promptSnippet: "team_prompt - Send a prompt to your child agent (immediate if idle, queued if busy).",
			parameters: Type.Object({
				session_id: Type.String(),
				message: Type.String(),
			}),
			async execute(_id, params) {
				try {
					return ok(JSON.stringify(await orchestrate("POST", "prompt", { childSessionId: params.session_id, message: params.message }), null, 2));
				} catch (e: any) { return fail(e?.message ?? String(e)); }
			},
		});

		pi.registerTool({
			name: "team_steer",
			label: "Steer Child Agent",
			description: "Send an urgent mid-turn redirect to a streaming child. Fails if idle; use team_prompt.",
			promptSnippet: "team_steer - Steer a running child agent with an urgent message (mid-turn only).",
			parameters: Type.Object({
				session_id: Type.String(),
				message: Type.String(),
			}),
			async execute(_id, params) {
				try {
					return ok(JSON.stringify(await orchestrate("POST", "steer", { childSessionId: params.session_id, message: params.message }), null, 2));
				} catch (e: any) { return fail(e?.message ?? String(e)); }
			},
		});

		pi.registerTool({
			name: "team_abort",
			label: "Abort Child Agent",
			description: "Force-abort a stuck child agent; kills and restarts its process.",
			promptSnippet: "team_abort - Force-abort a stuck child agent by session ID.",
			parameters: Type.Object({
				session_id: Type.String(),
			}),
			async execute(_id, params) {
				try {
					return ok(JSON.stringify(await orchestrate("POST", "abort", { childSessionId: params.session_id }), null, 2));
				} catch (e: any) { return fail(e?.message ?? String(e)); }
			},
		});

		pi.registerTool({
			name: "team_dismiss",
			label: "Dismiss Child Agent",
			description: "Terminate and archive one of your child agents.",
			promptSnippet: "team_dismiss - Dismiss (terminate + archive) a child agent by session ID.",
			parameters: Type.Object({
				session_id: Type.String(),
			}),
			async execute(_id, params) {
				try {
					return ok(JSON.stringify(await orchestrate("POST", "dismiss", { childSessionId: params.session_id }), null, 2));
				} catch (e: any) { return fail(e?.message ?? String(e)); }
			},
		});
	}
};

// ── Pure formatting helpers (module scope for testability) ──

function normalizeSpawned(resp: SpawnRouteResponse): Array<{ sessionId: string; title?: string }> {
	if (Array.isArray(resp?.children)) {
		return resp.children.map((c) => ({ sessionId: c.sessionId || c.childSessionId || c.id || "", title: c.title }));
	}
	const single = resp?.childSessionId || resp?.sessionId;
	if (single) return [{ sessionId: single, title: resp?.title }];
	return [];
}

/** Build the §9 team_wait result text + renderer details from a WaitResult. */
function formatWaitResult(wr: WaitRouteResponse): { text: string; details: DelegateDetails } {
	const statuses = Array.isArray(wr?.statuses) ? wr.statuses : [];
	const byId = new Map(statuses.map((s) => [s.sessionId, s]));
	const titleOf = (id: string) => byId.get(id)?.title || id.slice(0, 12);

	const lines: string[] = [];
	const first = wr.firstIdle;
	if (first) {
		const fstatus = byId.get(first)?.status;
		const header = fstatus && TERMINAL_STATUSES.has(fstatus) ? "First settled child" : "First idle child";
		lines.push(`${header}: ${first} ("${titleOf(first)}")`);
		if (wr.outputTail) {
			lines.push("--- output tail ---");
			lines.push(wr.outputTail);
		}
		lines.push("");
	}

	lines.push(`Awaited children (${statuses.length}):`);
	for (const s of statuses) {
		lines.push(`  • ${s.sessionId} "${titleOf(s.sessionId)}" — ${s.status}`);
	}

	const remaining = typeof wr.remaining === "number"
		? wr.remaining
		: statuses.filter((s) => !SETTLED_STATUSES.has(s.status)).length;
	if (remaining > 0) {
		lines.push(`Remaining: ${remaining} child(ren) not yet settled.`);
		lines.push("➜ Process this result now, then call team_wait again to await the remaining children.");
	} else {
		lines.push("All awaited children are settled.");
	}

	const details: DelegateDetails = {
		delegates: statuses.map((s) => ({
			id: s.sessionId.slice(0, 12),
			sessionId: s.sessionId,
			instructions: titleOf(s.sessionId),
			status: cardStatus(s.status),
			durationMs: 0,
		})),
	};
	return { text: lines.join("\n"), details };
}

export default extension;
