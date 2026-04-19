/**
 * Typed event bus for index lifecycle events. Forwarded into the WS
 * broadcast pipeline by `server.ts` (T11) and consumed by the in-process
 * `SearchService` state machine.
 *
 * Payloads match `src/server/ws/protocol.ts` additions (design §9) exactly
 * so forwarding is a no-op cast — the WS layer just stamps a `type` prefix
 * and ships it.
 */

import { EventEmitter } from "node:events";

// ── Event payloads ───────────────────────────────────────────────────

export interface IndexProgressEvent {
	projectId: string;
	phase: "rebuild" | "incremental";
	total: number;
	completed: number;
	backlog: number;
}

export interface IndexCompleteEvent {
	projectId: string;
	phase: "rebuild" | "incremental";
	durationMs: number;
	rowsWritten: number;
}

export interface IndexErrorEvent {
	projectId: string;
	message: string;
	recoverable: boolean;
}

export interface ProgressBusEvents {
	"index:progress": [IndexProgressEvent];
	"index:complete": [IndexCompleteEvent];
	"index:error": [IndexErrorEvent];
}

// ── Typed emitter ────────────────────────────────────────────────────

/**
 * Thin typed wrapper over `EventEmitter`. We use a hand-rolled generic
 * rather than TS 5's built-in typed emitter so downstream code doesn't
 * need `@types/node` >= 22 semantics leaking.
 */
export class ProgressBus {
	private readonly emitter = new EventEmitter();

	on<K extends keyof ProgressBusEvents>(
		event: K,
		listener: (...args: ProgressBusEvents[K]) => void,
	): this {
		this.emitter.on(event, listener as (...args: unknown[]) => void);
		return this;
	}

	off<K extends keyof ProgressBusEvents>(
		event: K,
		listener: (...args: ProgressBusEvents[K]) => void,
	): this {
		this.emitter.off(event, listener as (...args: unknown[]) => void);
		return this;
	}

	once<K extends keyof ProgressBusEvents>(
		event: K,
		listener: (...args: ProgressBusEvents[K]) => void,
	): this {
		this.emitter.once(event, listener as (...args: unknown[]) => void);
		return this;
	}

	emit<K extends keyof ProgressBusEvents>(event: K, ...args: ProgressBusEvents[K]): boolean {
		return this.emitter.emit(event, ...args);
	}

	removeAllListeners<K extends keyof ProgressBusEvents>(event?: K): this {
		if (event) this.emitter.removeAllListeners(event);
		else this.emitter.removeAllListeners();
		return this;
	}
}

/**
 * Shared singleton — there is one bus per server process. Per-project
 * scoping is carried in each event's `projectId` field; the WS layer
 * filters subscribers.
 */
export const progressBus = new ProgressBus();
