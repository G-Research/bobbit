// src/server/extension-host/action-guard.ts
//
// The PURE authorization guard for the action endpoint
// (POST /api/tools/:tool/actions/:action), implementing design §4b steps 1–6
// and the §5 controls i / ii / iii / iii-b. It is factored out of server.ts so
// the whole guard sequence is unit-testable without a live gateway: the endpoint
// supplies real resolvers; tests supply stubs.
//
// Ordering is load-bearing (design §5 iii-b): the x-bobbit-session-id HEADER is
// the single canonical identity. The body `sessionId` is accepted ONLY to fail
// fast on a mismatch; EVERY downstream check (session resolve, allowedTools,
// toolUseId ownership) uses the header-bound session, so an action can never
// authorize with one session and inspect/act on another's transcript.

/** Minimal session shape the guard needs (allowedTools allowlist). */
export interface ActionGuardSession {
	allowedTools?: string[];
}

/**
 * Inputs for the SHARED authorization CORE (design §4b steps 1–4): the
 * header-canonical identity, the body-vs-header fail-fast, the session resolve,
 * and the allowedTools gate. Both `authorizeActionRequest` (action endpoint) and
 * `authorizeScopedRequest` (Phase-2 pack-scoped capabilities: store, session
 * reads, callRoute, postMessage) authorize through this same core, keyed off the
 * server-resolved contributing `tool`. Crucially it carries NO toolUseId — the
 * scoped capabilities act on no specific prior tool call, and panels/entrypoints
 * have no toolUseId, so ownership is an action-only concern layered on top.
 */
export interface ScopedGuardInput {
	tool: string;
	/** Raw x-bobbit-session-id header value (string | string[] | undefined). */
	headerSessionId: string | string[] | undefined;
	/** Untrusted body.sessionId — accepted only to fail fast on mismatch. */
	bodySessionId: unknown;
	/** Resolve a session (live or persisted) by id; undefined when not found. */
	resolveSession: (id: string) => ActionGuardSession | undefined;
}

export interface ActionGuardInput extends ScopedGuardInput {
	action: string;
	/** Untrusted body.toolUseId. */
	toolUseId: unknown;
	/** Declared action-name allowlist (from actions.names), if any. */
	actionNames?: string[];
	/**
	 * Verify the HEADER-BOUND session's transcript contains a tool_use block
	 * whose id === toolUseId AND whose tool name === `tool` (anti-replay/forgery).
	 */
	verifyToolUse: (sessionId: string, toolUseId: string, tool: string) => Promise<boolean> | boolean;
}

export type ActionGuardResult =
	| { ok: true; sessionId: string }
	| { ok: false; status: number; error: string };

function firstHeader(v: string | string[] | undefined): string | undefined {
	return Array.isArray(v) ? v[0] : v;
}

/**
 * The SHARED authorization core (design §4b steps 1–4). Returns
 * `{ ok: true, sessionId }` with the verified, header-bound session id, or
 * `{ ok: false, status, error }` with the exact HTTP status to surface.
 *
 * Ordering is load-bearing: the header is the single canonical identity; the
 * body is accepted ONLY to fail fast on a mismatch, and every downstream check
 * uses the header-bound session.
 */
export function authorizeScopedRequest(input: ScopedGuardInput): ActionGuardResult {
	// 1. Require the canonical x-bobbit-session-id header.
	const headerSessionId = firstHeader(input.headerSessionId);
	if (!headerSessionId) {
		return { ok: false, status: 403, error: "Missing x-bobbit-session-id header" };
	}

	// 2. Single-sourced identity: body.sessionId must match the header (fail fast).
	if (typeof input.bodySessionId !== "string" || input.bodySessionId !== headerSessionId) {
		return { ok: false, status: 403, error: "Session id mismatch between body and header" };
	}

	// 3. Resolve the header-bound session (live or persisted).
	const session = input.resolveSession(headerSessionId);
	if (!session) {
		return { ok: false, status: 403, error: `Session "${headerSessionId}" not found` };
	}

	// 4. Allowlist-bypass fix: require :tool ∈ the session's allowedTools.
	//    Mirror the mcp-call guard — only enforced when an allowlist is present
	//    and non-empty (an unrestricted session has no allowedTools list).
	const allowed = session.allowedTools;
	if (allowed && allowed.length > 0) {
		if (!allowed.some((t) => t.toLowerCase() === input.tool.toLowerCase())) {
			return { ok: false, status: 403, error: `Tool "${input.tool}" is not allowed for this session` };
		}
	}

	return { ok: true, sessionId: headerSessionId };
}

/**
 * Run the full guard sequence. Returns `{ ok: true, sessionId }` on success
 * (the verified, header-bound session id) or `{ ok: false, status, error }`
 * with the exact HTTP status the endpoint should surface.
 */
export async function authorizeActionRequest(input: ActionGuardInput): Promise<ActionGuardResult> {
	// 1–4. Shared core: header-canonical identity, body===header, session
	//       resolve, and the allowedTools gate.
	const core = authorizeScopedRequest(input);
	if (!core.ok) return core;
	const headerSessionId = core.sessionId;

	// 5. If the tool declares an action allowlist, reject unknown actions early.
	if (input.actionNames && input.actionNames.length > 0) {
		if (!input.actionNames.includes(input.action)) {
			return { ok: false, status: 404, error: `Unknown action "${input.action}" for tool "${input.tool}"` };
		}
	}

	// 6. toolUseId existence + ownership against the HEADER-BOUND session.
	if (typeof input.toolUseId !== "string" || input.toolUseId.length === 0) {
		return { ok: false, status: 409, error: "Missing or invalid toolUseId" };
	}
	const exists = await input.verifyToolUse(headerSessionId, input.toolUseId, input.tool);
	if (!exists) {
		return { ok: false, status: 409, error: "toolUseId not found in this session for this tool" };
	}

	return { ok: true, sessionId: headerSessionId };
}

/**
 * Scan an agent transcript (raw JSONL string) for a tool_use block whose id
 * matches `toolUseId` AND whose tool name matches `tool`. Tolerates both the
 * Anthropic `{ type:"tool_use", id, name }` shape and pi-coding-agent
 * `{ toolCallId, toolName }` rows. Returns false on any parse trouble.
 */
export function transcriptHasToolUse(jsonl: string | null | undefined, toolUseId: string, tool: string): boolean {
	if (!jsonl) return false;
	const toolLower = tool.toLowerCase();
	for (const rawLine of jsonl.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry: unknown;
		try { entry = JSON.parse(line); } catch { continue; }
		if (!entry || typeof entry !== "object") continue;
		const message = (entry as { message?: unknown }).message;
		const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			const isToolUse = b.type === "tool_use" || b.type === "toolCall" || typeof b.toolCallId === "string";
			if (!isToolUse) continue;
			const id = (b.id ?? b.toolCallId ?? b.tool_use_id) as unknown;
			const name = (b.name ?? b.toolName) as unknown;
			if (id === toolUseId && typeof name === "string" && name.toLowerCase() === toolLower) {
				return true;
			}
		}
	}
	return false;
}
