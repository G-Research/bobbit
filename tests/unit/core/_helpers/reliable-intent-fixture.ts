import { vi } from "vitest";
import { SessionManager } from "../../../../src/server/agent/session-manager.js";
import { EventBuffer } from "../../../../src/server/agent/event-buffer.js";
import { PromptQueue } from "../../../../src/server/agent/prompt-queue.js";
import { createManualClock, type ManualClock } from "../../../support/harnesses/shared/clock.js";

export interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

/** A deterministic RPC/event barrier. Tests wait for entered before releasing it. */
export function barrier<T>() {
	const entered = deferred<void>();
	const released = deferred<T>();
	let enterCount = 0;
	return {
		entered: entered.promise,
		get enterCount() { return enterCount; },
		async hold(): Promise<T> {
			enterCount += 1;
			entered.resolve(undefined);
			return released.promise;
		},
		release(value: T): void { released.resolve(value); },
		reject(reason?: unknown): void { released.reject(reason); },
	};
}

export interface ReliableIntentHarness {
	manager: any;
	session: any;
	clock: ManualClock;
	prompt: ReturnType<typeof vi.fn>;
	steer: ReturnType<typeof vi.fn>;
	storeUpdates: Array<Record<string, unknown>>;
	cleanup(): void;
}

export function makeReliableIntentHarness(overrides: Record<string, any> = {}): ReliableIntentHarness {
	const clock = createManualClock(1_700_000_000_000);
	const manager: any = new SessionManager({
		clock,
		stateDir: "/.bobbit-test/reliable-intent",
		// Avoid constructor-owned disk stores. The fixture installs the exact
		// persistence seam used by these lifecycle tests below.
		projectContextManager: {} as any,
	});
	if (manager._statusHeartbeatTimer) {
		clock.clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager.projectContextManager = null;
	const storeUpdates: Array<Record<string, unknown>> = [];
	manager._testStore = {
		update: vi.fn((_id: string, update: Record<string, unknown>) => {
			storeUpdates.push(structuredClone(update));
		}),
		get: vi.fn(() => undefined),
	};
	// Compaction cards/tree reads are covered elsewhere. Keep these tests focused
	// on admission and release, with no filesystem or provider timing involved.
	manager.readCompactionTranscriptEntries = vi.fn(async () => undefined);
	manager.finalizeCompactionSidecar = vi.fn(async () => undefined);
	manager.refreshAfterCompaction = vi.fn(async () => undefined);

	const prompt = overrides.prompt ?? vi.fn(async () => ({ success: true }));
	const steer = overrides.steer ?? vi.fn(async () => ({ success: true }));
	const session = {
		id: "s-reliable-intent",
		title: "Reliable intent fixture",
		titleGenerated: true,
		cwd: "/virtual/reliable-intent",
		status: "streaming",
		statusVersion: 0,
		createdAt: clock.now(),
		lastActivity: clock.now(),
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		inFlightSteerTexts: [],
		isCompacting: false,
		setupComplete: true,
		unsubscribe: () => {},
		rpcClient: {
			prompt,
			steer,
			getState: vi.fn(async () => ({ success: true, data: {} })),
			getTranscriptEntries: vi.fn(async () => ({ success: true, data: { entries: [], leafId: null } })),
		},
		...overrides,
	};
	manager.sessions.set(session.id, session);

	return {
		manager,
		session,
		clock,
		prompt,
		steer,
		storeUpdates,
		cleanup() {
			manager.sessionsWithConnectedClients?.clear();
			manager.sessions?.clear();
			if (manager._statusHeartbeatTimer) clock.clearInterval(manager._statusHeartbeatTimer);
		},
	};
}

export async function flushMicrotasks(turns = 12): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

export function intentRow(overrides: Record<string, unknown> = {}): any {
	return {
		id: "intent-default",
		text: "intent",
		isSteered: false,
		createdAt: 1_700_000_000_000,
		kind: "prompt",
		targetTurn: "next-turn",
		sequence: 1,
		deliveryState: "queued",
		source: "user",
		author: { kind: "user", id: "user:local", label: "User" },
		...overrides,
	};
}
