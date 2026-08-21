import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
	HostHookScope,
	HostNotification,
} from "../../shared/extension-host/host-hooks.js";
import type { ServerMessage } from "../ws/protocol.js";
import { isSocketSendable } from "../ws/socket-sendability.js";
import type { HostNotificationDeliveryAdapter } from "./host-notification-dispatcher.js";

interface HostNotificationSocketBinding {
	readonly sessionId: string;
	readonly projectId: string;
}

const SOCKET_BINDINGS = new WeakMap<WebSocket, HostNotificationSocketBinding>();

type BoundWebSocket = WebSocket & {
	authenticated?: boolean;
	isViewer?: boolean;
};

interface StreamState {
	readonly epoch: string;
	sequence: number;
	refreshRequired: boolean;
	refreshScheduled: boolean;
	refreshAttempts: number;
	active: boolean;
	refreshTimer?: ReturnType<typeof setTimeout>;
}

export interface HostNotificationSocketRouterOptions {
	readonly epochGenerator?: () => string;
	/** If a socket already has this many unsent bytes, drop the delta and require
	 * an authoritative refresh rather than growing transport memory unbounded. */
	readonly maxBufferedBytes?: number;
	/** Initial retry delay for a refresh frame rejected by transport pressure. */
	readonly refreshRetryDelayMs?: number;
	/** Failed refresh attempts before closing with WebSocket retry-later code 1013. */
	readonly maxRefreshRetries?: number;
}

/**
 * Install the server-derived authority used by canonical notification routing.
 * Call only after authentication and exact session/project resolution.
 */
export function bindHostNotificationSocket(
	ws: WebSocket,
	binding: { sessionId: string; projectId: string },
): void {
	if (!binding.sessionId || !binding.projectId || binding.sessionId === "__viewer__") {
		unbindHostNotificationSocket(ws);
		return;
	}
	SOCKET_BINDINGS.set(ws, Object.freeze({ sessionId: binding.sessionId, projectId: binding.projectId }));
}

export function unbindHostNotificationSocket(ws: WebSocket): void {
	SOCKET_BINDINGS.delete(ws);
}

/** Exact, server-authorized live browser delivery. No viewer/client filtering. */
export class HostNotificationSocketRouter implements HostNotificationDeliveryAdapter {
	readonly consumer = "browser" as const;
	private readonly states = new WeakMap<WebSocket, Map<HostHookScope, StreamState>>();
	private readonly closeListeners = new WeakSet<WebSocket>();
	private readonly epochGenerator: () => string;
	private readonly maxBufferedBytes: number;
	private readonly refreshRetryDelayMs: number;
	private readonly maxRefreshRetries: number;

	constructor(
		private readonly sockets: Iterable<WebSocket> | (() => Iterable<WebSocket>),
		options: HostNotificationSocketRouterOptions = {},
	) {
		this.epochGenerator = options.epochGenerator ?? randomUUID;
		this.maxBufferedBytes = Math.max(1, options.maxBufferedBytes ?? 512 * 1024);
		this.refreshRetryDelayMs = Math.max(1, Math.min(options.refreshRetryDelayMs ?? 25, 1_000));
		this.maxRefreshRetries = Math.max(1, Math.min(options.maxRefreshRetries ?? 8, 32));
	}

	deliver(notification: HostNotification): void {
		for (const ws of this.recipients(notification)) {
			const state = this.state(ws, notification.scope);
			if (state.refreshRequired) {
				this.scheduleRefresh(ws, notification.scope, state);
				continue;
			}
			if (!this.canSend(ws)) {
				state.refreshRequired = true;
				this.scheduleRefresh(ws, notification.scope, state);
				continue;
			}
			const frame: ServerMessage = {
				type: "host_notification",
				notification,
				stream: { epoch: state.epoch, sequence: ++state.sequence },
			};
			try {
				ws.send(JSON.stringify(frame), (error?: Error) => {
					if (!error) return;
					state.refreshRequired = true;
					this.scheduleRefresh(ws, notification.scope, state);
				});
			} catch {
				state.refreshRequired = true;
				this.scheduleRefresh(ws, notification.scope, state);
			}
		}
	}

	/** Coalesced explicit gap signal used when the dispatcher's browser queue drops. */
	refreshRequired(notification: HostNotification): void {
		for (const ws of this.recipients(notification)) {
			const state = this.state(ws, notification.scope);
			state.refreshRequired = true;
			this.scheduleRefresh(ws, notification.scope, state);
		}
	}

	private *recipients(notification: HostNotification): IterableIterator<WebSocket> {
		const sockets = typeof this.sockets === "function" ? this.sockets() : this.sockets;
		for (const ws of sockets) {
			const socket = ws as BoundWebSocket;
			const binding = SOCKET_BINDINGS.get(ws);
			if (socket.authenticated !== true || socket.isViewer === true || !binding) continue;
			if (binding.projectId !== notification.projectId) continue;
			if (notification.scope === "session" && binding.sessionId !== notification.sessionId) continue;
			yield ws;
		}
	}

	private state(ws: WebSocket, scope: HostHookScope): StreamState {
		let streams = this.states.get(ws);
		if (!streams) {
			streams = new Map();
			this.states.set(ws, streams);
			this.installCloseCleanup(ws);
		}
		let state = streams.get(scope);
		if (!state) {
			state = {
				epoch: this.epochGenerator(),
				sequence: 0,
				refreshRequired: false,
				refreshScheduled: false,
				refreshAttempts: 0,
				active: true,
			};
			streams.set(scope, state);
		}
		return state;
	}

	private canSend(ws: WebSocket): boolean {
		const bufferedAmount = typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : 0;
		return isSocketSendable(ws) && bufferedAmount < this.maxBufferedBytes;
	}

	private scheduleRefresh(ws: WebSocket, scope: HostHookScope, state: StreamState): void {
		if (!state.active || state.refreshScheduled || state.refreshTimer) return;
		state.refreshScheduled = true;
		queueMicrotask(() => {
			state.refreshScheduled = false;
			this.tryRefresh(ws, scope, state);
		});
	}

	private tryRefresh(ws: WebSocket, scope: HostHookScope, state: StreamState): void {
		if (!state.active) return;
		if (!state.refreshRequired) {
			state.refreshAttempts = 0;
			return;
		}
		if (!isSocketSendable(ws)) {
			if (ws.readyState === 1) this.closeRetryably(ws);
			else this.cleanupSocket(ws);
			return;
		}
		if (!this.canSend(ws)) {
			this.retryRefresh(ws, scope, state);
			return;
		}
		const frame: ServerMessage = {
			type: "host_notifications_refresh_required",
			scope,
			epoch: state.epoch,
			sequence: ++state.sequence,
		};
		state.refreshRequired = false;
		try {
			ws.send(JSON.stringify(frame), (error?: Error) => {
				if (!state.active) return;
				if (!error) {
					state.refreshAttempts = 0;
					return;
				}
				state.refreshRequired = true;
				this.retryRefresh(ws, scope, state);
			});
		} catch {
			state.refreshRequired = true;
			this.retryRefresh(ws, scope, state);
		}
	}

	private retryRefresh(ws: WebSocket, scope: HostHookScope, state: StreamState): void {
		if (!state.active || !state.refreshRequired || state.refreshTimer) return;
		state.refreshAttempts++;
		if (state.refreshAttempts >= this.maxRefreshRetries) {
			this.closeRetryably(ws);
			return;
		}
		const delay = Math.min(1_000, this.refreshRetryDelayMs * (2 ** Math.max(0, state.refreshAttempts - 1)));
		state.refreshTimer = setTimeout(() => {
			state.refreshTimer = undefined;
			this.tryRefresh(ws, scope, state);
		}, delay);
	}

	private installCloseCleanup(ws: WebSocket): void {
		if (this.closeListeners.has(ws)) return;
		this.closeListeners.add(ws);
		const once = (ws as WebSocket & { once?: (event: string, listener: () => void) => unknown }).once;
		if (typeof once === "function") once.call(ws, "close", () => this.cleanupSocket(ws));
	}

	private cleanupSocket(ws: WebSocket): void {
		const streams = this.states.get(ws);
		if (streams) {
			for (const state of streams.values()) {
				state.active = false;
				if (state.refreshTimer) clearTimeout(state.refreshTimer);
				state.refreshTimer = undefined;
				state.refreshScheduled = false;
				state.refreshRequired = false;
			}
		}
		this.states.delete(ws);
	}

	private closeRetryably(ws: WebSocket): void {
		this.cleanupSocket(ws);
		try { ws.close(1013, "host notification refresh required"); }
		catch {
			try { ws.terminate(); } catch { /* transport is already unusable */ }
		}
	}
}
