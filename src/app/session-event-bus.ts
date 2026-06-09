// src/app/session-event-bus.ts
//
// CLIENT-internal bridge from Bobbit's live session WebSocket stream onto the
// FROZEN, typed `HostSessionEventMap` consumed by `host.session.subscribe`
// (design docs/design/extension-host-phase2.md §8 C2.2). Mirrors the
// module-scoped `document`-CustomEvent bus pattern of `verification-event-bus.ts`
// / `gate-status-events.ts` (NOT a fork) — a single EventTarget so every
// per-session `RemoteAgent` can publish and every subscriber shares one fan-out.
//
// Packs see ONLY the contract shapes (`HostMessage` / `ToolCallRecord` / the
// status union), produced here by a client-side internal→contract mapper that is
// the analogue of the server `contract-adapter.ts` (the server module cannot be
// imported into the web bundle — web tsconfig excludes src/server — so the
// tolerant row-mapping is mirrored here for the live wire). Subscriptions are
// SCOPED to the bound session id: a subscriber never sees another session's events.

import type {
	HostMessage,
	HostContentBlock,
	ToolCallRecord,
	HostSessionEventMap,
	HostSessionEventName,
} from "../shared/extension-host/host-api.js";

const BUS = new EventTarget();
const EVENT = "bobbit-host-session-event";

interface Envelope {
	sessionId: string;
	event: HostSessionEventName;
	payload: HostSessionEventMap[HostSessionEventName];
}

/**
 * Subscribe to a typed session event, scoped to `sessionId`. Returns an
 * unsubscribe fn. A subscriber NEVER sees another session's events.
 *
 * SECURITY (own-session scoping): when `sessionId` is undefined the subscription
 * is INERT — it delivers NOTHING. An unbound Host API has no legitimate own-session
 * to observe, so wildcarding to EVERY session would leak cross-session activity to a
 * pack that failed to bind a session. The Host API always binds the active session,
 * so the legitimate own-session case still receives its own events; the unbound case
 * (unit fixtures, mis-construction) is silently empty rather than a firehose.
 */
export function subscribeHostSessionEvent<E extends HostSessionEventName>(
	sessionId: string | undefined,
	event: E,
	cb: (payload: HostSessionEventMap[E]) => void,
): () => void {
	// No bound session ⇒ no-op subscription (deliver nothing). Still returns a valid
	// unsubscribe fn so callers need no special-casing.
	if (!sessionId) return () => {};
	const handler = (e: Event): void => {
		const detail = (e as CustomEvent<Envelope>).detail;
		if (!detail || detail.event !== event) return;
		if (detail.sessionId !== sessionId) return;
		cb(detail.payload as HostSessionEventMap[E]);
	};
	BUS.addEventListener(EVENT, handler);
	return () => BUS.removeEventListener(EVENT, handler);
}

function emit<E extends HostSessionEventName>(sessionId: string, event: E, payload: HostSessionEventMap[E]): void {
	BUS.dispatchEvent(new CustomEvent<Envelope>(EVENT, { detail: { sessionId, event, payload } }));
}

// ── internal → contract mapping (the live-wire analogue of contract-adapter.ts) ──

/** Map ONE live content block onto a contract HostContentBlock, or null for an
 *  unknown/unsupported type. Shape-tolerant in the same way the server adapter is
 *  (Anthropic `tool_use`/`tool_result` AND pi-coding-agent `toolCall`/`toolCallId`). */
function blockToContract(block: unknown): HostContentBlock | null {
	if (!block || typeof block !== "object") return null;
	const b = block as Record<string, unknown>;
	const t = b.type;
	if (t === "text" && typeof b.text === "string") return { type: "text", text: b.text };
	if (t === "tool_result") {
		return {
			type: "tool_result",
			toolUseId: String(b.tool_use_id ?? b.toolCallId ?? b.id ?? ""),
			output: b.content ?? b.output ?? null,
			isError: b.is_error === true || b.isError === true,
		};
	}
	const isToolUse = t === "tool_use" || t === "toolCall" || typeof b.toolCallId === "string";
	if (isToolUse) {
		const nameRaw = b.name ?? b.toolName;
		return {
			type: "tool_use",
			toolUseId: String(b.id ?? b.toolCallId ?? b.tool_use_id ?? ""),
			tool: typeof nameRaw === "string" ? nameRaw : "",
			input: b.input ?? b.args ?? b.arguments ?? null,
		};
	}
	return null;
}

/** Map a live client message ({ id?, role, content }) onto a contract HostMessage,
 *  or null when it is not a recognizable message. Tolerant of a string body and a
 *  block array; unknown blocks are skipped. */
export function mapClientMessageToHost(msg: unknown): HostMessage | null {
	if (!msg || typeof msg !== "object") return null;
	const m = msg as Record<string, unknown>;
	const roleRaw = m.role;
	const role: HostMessage["role"] =
		roleRaw === "assistant" || roleRaw === "system" ? roleRaw : "user";
	const content = m.content;
	const blocks: HostContentBlock[] = [];
	if (typeof content === "string") {
		if (content.length > 0) blocks.push({ type: "text", text: content });
	} else if (Array.isArray(content)) {
		for (const raw of content) {
			const mapped = blockToContract(raw);
			if (mapped) blocks.push(mapped);
		}
	}
	const ts = typeof m.ts === "number" ? m.ts : typeof m.timestamp === "number" ? m.timestamp : Date.now();
	return { id: typeof m.id === "string" ? m.id : `msg-${ts}`, role, content: blocks, ts };
}

/** Map a live client session status onto the frozen contract status union. */
function mapStatus(status: string): HostSessionEventMap["status"]["status"] {
	if (status === "streaming" || status === "aborting") return "running";
	if (status === "error") return "error";
	return "idle";
}

// ── publishers (called from the per-session RemoteAgent live-event path) ──

/** Publish a live message onto the bus as a typed `message` event (and, for any
 *  joined tool_use+tool_result pair carried on the message, a `tool_result`
 *  event). Pending tool_use inputs are remembered so a later tool_result can be
 *  joined into a full ToolCallRecord. No-op when the message does not map. */
export function publishClientMessage(sessionId: string, msg: unknown): void {
	const host = mapClientMessageToHost(msg);
	if (!host) return;
	for (const block of host.content) {
		if (block.type === "tool_use") {
			pendingToolUses.set(`${sessionId}|${block.toolUseId}`, { tool: block.tool, input: block.input });
		} else if (block.type === "tool_result") {
			const key = `${sessionId}|${block.toolUseId}`;
			const call = pendingToolUses.get(key);
			const record: ToolCallRecord = {
				toolUseId: block.toolUseId,
				tool: call?.tool ?? "",
				input: call?.input ?? null,
				output: block.output,
				isError: block.isError,
			};
			pendingToolUses.delete(key);
			emit(sessionId, "tool_result", { record });
		}
	}
	emit(sessionId, "message", { message: host });
}

/** Bounded map of recently-seen tool_use inputs awaiting their tool_result, so a
 *  `tool_result` event can carry the matching tool + input. */
const pendingToolUses = new Map<string, { tool: string; input: unknown }>();
const MAX_PENDING = 2000;
function trimPending(): void {
	while (pendingToolUses.size > MAX_PENDING) {
		const first = pendingToolUses.keys().next().value;
		if (first === undefined) break;
		pendingToolUses.delete(first);
	}
}

/** Publish a live status transition as a typed `status` event. */
export function publishClientStatus(sessionId: string, status: string, detail?: string): void {
	trimPending();
	emit(sessionId, "status", { status: mapStatus(status), detail });
}
