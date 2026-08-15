import { createManualClock, type ManualClock } from "../../harness/clock.js";

export interface LocalMockAgentClock {
	readonly clock: ManualClock;
	advanceUntilSettled<T>(promise: Promise<T>, maxVirtualMs?: number): Promise<T>;
	waitUntil(predicate: () => boolean, description: string, maxVirtualMs?: number): Promise<void>;
	settleCurrentPrompt(maxVirtualMs?: number): Promise<void>;
}

/**
 * Restore a session with its per-bridge virtual clock installed before either
 * the interrupted-turn boot continuation or the recovered queue drain. The
 * continuation must finish before its terminal boundary can release next-turn
 * work, so both prompt-chain generations belong to one deterministic clock.
 */
export async function restoreWithLocalMockAgentClock(gateway: any, sessionId: string): Promise<LocalMockAgentClock> {
	const manager = gateway.sessionManager;
	const originalBootContinuation = manager._dispatchBootContinuation;
	const originalDrainQueue = manager.drainQueue;
	let localClock: LocalMockAgentClock | undefined;

	const ensureLocalClock = (session: { id?: string }) => {
		if (session?.id === sessionId && !localClock) {
			localClock = attachLocalMockAgentClock(gateway, sessionId);
		}
	};
	const patchedBootContinuation = function (session: { id?: string }) {
		ensureLocalClock(session);
		return originalBootContinuation.call(manager, session);
	};
	const patchedDrainQueue = (session: { id?: string }) => {
		ensureLocalClock(session);
		return originalDrainQueue.call(manager, session);
	};
	manager._dispatchBootContinuation = patchedBootContinuation;
	manager.drainQueue = patchedDrainQueue;
	try {
		await manager.restoreSessions();
	} finally {
		if (manager._dispatchBootContinuation === patchedBootContinuation) {
			manager._dispatchBootContinuation = originalBootContinuation;
		}
		if (manager.drainQueue === patchedDrainQueue) manager.drainQueue = originalDrainQueue;
	}
	if (!localClock) {
		throw new Error(`session ${sessionId} did not start recovered mock-agent work`);
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
		// Let RPC/event microtasks append follow-up work without consuming real time.
		await new Promise<void>((resolve) => setImmediate(resolve));
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
		const followPromptChain = async () => {
			let chain = agent?._promptChain;
			if (!chain || typeof chain.then !== "function") {
				throw new Error(`session ${sessionId} has no active mock-agent prompt chain`);
			}
			while (true) {
				await chain;
				// agent_end may synchronously release a recovered next-turn drain, whose
				// RPC appends a replacement chain in a later event-loop turn.
				await yieldTurn();
				const replacement = agent?._promptChain;
				if (!replacement || replacement === chain) return;
				chain = replacement;
			}
		};
		await advanceUntilSettled(followPromptChain(), maxVirtualMs);
	}

	return { clock, advanceUntilSettled, waitUntil, settleCurrentPrompt };
}
