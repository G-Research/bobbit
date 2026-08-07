import { createManualClock, type ManualClock } from "../../harness/clock.js";

export interface LocalMockAgentClock {
	readonly clock: ManualClock;
	advanceUntilSettled<T>(promise: Promise<T>, maxVirtualMs?: number): Promise<T>;
	waitUntil(predicate: () => boolean, description: string, maxVirtualMs?: number): Promise<void>;
	settleCurrentPrompt(maxVirtualMs?: number): Promise<void>;
}

/**
 * Drive timer-backed gateway lifecycle work in the v2 integration harness.
 * Production uses real timers; the fork-scoped test gateway deliberately uses
 * a manual clock, so positive-delay queue drains only run when a test advances
 * that clock. Yielding through the host timer phase also lets WS and mock-agent
 * promises publish the state that schedules the next lifecycle timer.
 */
export async function advanceGatewayClockUntil(
	gateway: any,
	predicate: () => boolean,
	description: string,
	maxVirtualMs = 10_000,
	stepMs = 25,
): Promise<void> {
	for (let advanced = 0; advanced <= maxVirtualMs; advanced += stepMs) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		if (predicate()) return;
		if (advanced < maxVirtualMs) gateway.clock.advance(Math.min(stepMs, maxVirtualMs - advanced));
	}
	throw new Error(`gateway did not reach ${description} after ${maxVirtualMs}ms of virtual time`);
}

/**
 * Restore a session with its per-bridge virtual clock installed at the exact
 * queue-drain boundary. `restoreSessions()` re-enqueues durable steers, then
 * releases its replacement coordinator which drains that queue synchronously.
 * Attaching after restore returns races the mock's first sleep: that sleep can
 * already have captured the real-time implementation, while the caller only
 * advances the local clock. Installing immediately before the drain makes the
 * entire recovered turn belong to one deterministic clock.
 */
export async function restoreWithLocalMockAgentClock(gateway: any, sessionId: string): Promise<LocalMockAgentClock> {
	const manager = gateway.sessionManager;
	const originalDrainQueue = manager.drainQueue;
	let localClock: LocalMockAgentClock | undefined;

	const patchedDrainQueue = (session: { id?: string }) => {
		if (session?.id === sessionId && !localClock) {
			localClock = attachLocalMockAgentClock(gateway, sessionId);
		}
		return originalDrainQueue.call(manager, session);
	};
	manager.drainQueue = patchedDrainQueue;
	try {
		await manager.restoreSessions();
	} finally {
		if (manager.drainQueue === patchedDrainQueue) manager.drainQueue = originalDrainQueue;
	}
	if (!localClock) {
		throw new Error(`session ${sessionId} did not drain a recovered mock-agent prompt`);
	}
	return localClock;
}

/**
 * Give one in-process mock agent its own virtual clock.
 *
 * The gateway clock is fork-scoped, so advancing it from a test also fires
 * timers owned by unrelated sessions. This clock is attached only to the
 * requested bridge and is discarded with that session.
 */
export function attachLocalMockAgentClock(gateway: any, sessionId: string): LocalMockAgentClock {
	const session = gateway.sessionManager.getSession(sessionId);
	const bridge = session?.rpcClient;
	if (typeof bridge?.setSleep !== "function") {
		throw new Error(`session ${sessionId} does not use the in-process mock bridge`);
	}

	const clock = createManualClock(gateway.clock.now());
	bridge.setSleep((ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
		let settled = false;
		let timer: any;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clock.clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		if (signal?.aborted) {
			finish();
			return;
		}
		timer = clock.setTimeout(finish, Math.max(0, ms));
		signal?.addEventListener("abort", finish, { once: true });
	}));

	async function yieldTurn(): Promise<void> {
		// A prompt may have started its first real-time sleep just before setSleep()
		// installs this clock. Yield through the timers phase so that hand-off can
		// settle; a setImmediate-only loop can starve that pre-existing timer while
		// virtual time reaches its limit.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	async function advanceUntilSettled<T>(promise: Promise<T>, maxVirtualMs = 10_000): Promise<T> {
		let settled = false;
		let value: T | undefined;
		let failure: unknown;
		void promise.then(
			(result) => { settled = true; value = result; },
			(error) => { settled = true; failure = error; },
		);
		for (let advanced = 0; !settled && advanced < maxVirtualMs; advanced += 5) {
			await yieldTurn();
			clock.advance(Math.min(5, maxVirtualMs - advanced));
		}
		await yieldTurn();
		if (failure) throw failure;
		if (!settled) throw new Error(`mock-agent operation did not settle after ${maxVirtualMs}ms of local virtual time`);
		return value as T;
	}

	async function waitUntil(predicate: () => boolean, description: string, maxVirtualMs = 10_000): Promise<void> {
		for (let advanced = 0; advanced <= maxVirtualMs; advanced += 5) {
			await yieldTurn();
			if (predicate()) return;
			if (advanced < maxVirtualMs) clock.advance(Math.min(5, maxVirtualMs - advanced));
		}
		throw new Error(`mock-agent did not reach ${description} after ${maxVirtualMs}ms of local virtual time`);
	}

	async function settleCurrentPrompt(maxVirtualMs = 10_000): Promise<void> {
		const agent = bridge._agent;
		if (!agent?._promptChain || typeof agent._promptChain.then !== "function") {
			throw new Error(`session ${sessionId} has no active mock-agent prompt chain`);
		}

		// Durable prompt acceptance is published before the bridge RPC. A caller can
		// therefore attach after SessionManager reports streaming but before the mock
		// has appended that prompt to `_promptChain`. Follow chain replacements until
		// the canonical session is idle; awaiting only the pre-publication resolved
		// chain would falsely report settlement while the real prompt starts later.
		for (let advanced = 0; advanced <= maxVirtualMs; advanced += 5) {
			const chain = agent._promptChain as Promise<void>;
			await advanceUntilSettled(chain, Math.max(5, maxVirtualMs - advanced));
			await yieldTurn();
			if (gateway.sessionManager.getSession(sessionId)?.status === "idle" && agent._promptChain === chain) return;
			if (advanced < maxVirtualMs) clock.advance(Math.min(5, maxVirtualMs - advanced));
		}
		throw new Error(`session ${sessionId} prompt chain settled without reaching idle after ${maxVirtualMs}ms of local virtual time`);
	}

	return { clock, advanceUntilSettled, waitUntil, settleCurrentPrompt };
}
