import { createManualClock, type ManualClock } from "../../harness/clock.js";

export interface LocalMockAgentClock {
	readonly clock: ManualClock;
	advanceUntilSettled<T>(promise: Promise<T>, maxVirtualMs?: number): Promise<T>;
	waitUntil(predicate: () => boolean, description: string, maxVirtualMs?: number): Promise<void>;
	settleCurrentPrompt(maxVirtualMs?: number): Promise<void>;
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
		const chain = agent?._promptChain;
		if (!chain || typeof chain.then !== "function") {
			throw new Error(`session ${sessionId} has no active mock-agent prompt chain`);
		}
		await advanceUntilSettled(chain, maxVirtualMs);
	}

	return { clock, advanceUntilSettled, waitUntil, settleCurrentPrompt };
}
