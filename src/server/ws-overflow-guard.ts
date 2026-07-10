/**
 * Decision logic and diagnostics for WebSocket buffer-overflow guards.
 *
 * Production callers keep the 4 MiB hard overflow protection but defer the
 * terminate decision once so short kernel-buffer spikes can drain. This module
 * keeps that policy testable and shared across per-session and per-goal WS fanout.
 */

export type OverflowAction =
	| { kind: "send" }
	| { kind: "send-and-defer-check" }
	| { kind: "terminate" };

export interface OverflowGuardConfig {
	overflowBytes: number;
	warnBytes: number;
}

export const DEFAULT_OVERFLOW_GUARD: OverflowGuardConfig = {
	overflowBytes: 4 * 1024 * 1024,
	warnBytes: 1 * 1024 * 1024,
};

export interface WsOverflowClient {
	readyState: number;
	bufferedAmount?: number;
	terminate(): void;
}

export interface WsOverflowGuardState<T extends object = object> {
	pendingOverflowCheck: WeakSet<T>;
	warnedClients: WeakSet<T>;
}

export interface WsOverflowGuardRuntime {
	setTimeout(cb: () => void, ms: number): unknown;
	warn(message: string): void;
}

export interface WsPayloadDiagnostics {
	outerType: string;
	innerType?: string;
	bytes: number;
	recipientKind?: string;
	context?: string;
}

function eventType(value: unknown): string | undefined {
	return value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
		? (value as { type: string }).type
		: undefined;
}

export function describeWsPayload(msg: unknown, serialized?: string): WsPayloadDiagnostics {
	const data = serialized ?? JSON.stringify(msg);
	const outerType = eventType(msg) ?? "unknown";
	const inner = msg && typeof msg === "object" ? (msg as { data?: unknown }).data : undefined;
	const innerType = outerType === "event" ? eventType(inner) : undefined;
	return { outerType, innerType, bytes: Buffer.byteLength(data) };
}

export function formatWsPayloadDiagnostics(meta: WsPayloadDiagnostics): string {
	return [
		`outerType=${meta.outerType}`,
		`innerType=${meta.innerType ?? "-"}`,
		`bytes=${meta.bytes}`,
		meta.recipientKind ? `recipient=${meta.recipientKind}` : undefined,
		meta.context ? `context=${meta.context}` : undefined,
	].filter(Boolean).join(" ");
}

/**
 * Returns the action a sender should take given the current `bufferedAmount`
 * and whether a deferred re-check is already in flight.
 */
export function decideOverflowAction(
	bufferedAmount: number,
	isDeferredRecheck: boolean,
	cfg: OverflowGuardConfig = DEFAULT_OVERFLOW_GUARD,
): OverflowAction {
	if (bufferedAmount <= cfg.overflowBytes) return { kind: "send" };
	if (isDeferredRecheck) return { kind: "terminate" };
	return { kind: "send-and-defer-check" };
}

/**
 * Shared production guard. Callers should invoke this immediately before
 * `send(data)`; it schedules the deferred terminate check when needed and logs
 * payload diagnostics for both warning and confirmed-overflow paths.
 */
export function guardWebSocketOverflow<T extends WsOverflowClient & object>(
	client: T,
	meta: WsPayloadDiagnostics,
	state: WsOverflowGuardState<T>,
	runtime: WsOverflowGuardRuntime,
	cfg: OverflowGuardConfig = DEFAULT_OVERFLOW_GUARD,
): OverflowAction {
	const buffered = client.bufferedAmount ?? 0;
	const details = formatWsPayloadDiagnostics(meta);
	const action = decideOverflowAction(buffered, /* isDeferredRecheck */ false, cfg);
	if (action.kind === "send-and-defer-check" && !state.pendingOverflowCheck.has(client)) {
		state.pendingOverflowCheck.add(client);
		runtime.warn(
			`[ws] bufferedAmount=${buffered}B > ${cfg.overflowBytes}B threshold; deferring terminate decision 10ms. ${details}`,
		);
		runtime.setTimeout(() => {
			state.pendingOverflowCheck.delete(client);
			if (client.readyState !== 1) return;
			const bufferedNow = client.bufferedAmount ?? 0;
			const recheck = decideOverflowAction(bufferedNow, /* isDeferredRecheck */ true, cfg);
			if (recheck.kind === "terminate") {
				runtime.warn(
					`[ws] confirmed overflow after 10ms drain attempt: ${bufferedNow}B; terminating client. ${details}`,
				);
				try { client.terminate(); } catch { /* ignore */ }
			}
		}, 10);
	}
	if (buffered > cfg.warnBytes && !state.warnedClients.has(client)) {
		state.warnedClients.add(client);
		runtime.warn(`[ws] client bufferedAmount=${buffered}B (warn threshold ${cfg.warnBytes}B); ${details}`);
	}
	return action;
}
