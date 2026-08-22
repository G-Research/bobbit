import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { applyRuntimeSessionThinkingSelection } from "../../src/server/ws/runtime-model-selection.js";

const SESSION_ID = "runtime-recovery-owner";
const DURABLE_A = {
	provider: "anthropic",
	id: "claude-sonnet-5",
	thinkingLevel: "high",
} as const;
const DURABLE_B = {
	provider: "openai",
	id: "gpt-5",
	thinkingLevel: "medium",
} as const;
const DURABLE_C = {
	provider: "google",
	id: "gemini-2.5-pro",
	thinkingLevel: "high",
} as const;
const MARKER = "RUNTIME_RECOVERY_OWNERSHIP";

type Tuple = { provider: string; id: string; thinkingLevel: string };
type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function state(tuple: Tuple): unknown {
	return {
		success: true,
		data: {
			model: { provider: tuple.provider, id: tuple.id },
			thinkingLevel: tuple.thinkingLevel,
		},
	};
}

function makeBridge(name: string, getState: () => Promise<unknown>) {
	const bridge: any = {
		name,
		running: true,
		getState: vi.fn(getState),
		setModel: vi.fn(async () => ({ success: true })),
		setThinkingLevel: vi.fn(async () => ({ success: true })),
		stop: vi.fn(async () => { bridge.running = false; }),
	};
	return bridge;
}

function makeSession(name: string, bridge: any) {
	return {
		name,
		id: SESSION_ID,
		clients: new Set(),
		rpcClient: bridge,
		spawnPinnedModel: `${DURABLE_A.provider}/${DURABLE_A.id}`,
		spawnPinnedThinkingLevel: DURABLE_A.thinkingLevel,
	};
}

function makeHarness(restartBridge: any) {
	let durable: Tuple = { ...DURABLE_A };
	let originalReads = 0;
	const originalBridge = makeBridge("O", async () => {
		originalReads += 1;
		// The requested thinking mutation and correction read remain on A/high.
		// The rollback model read then returns the wrong identity, forcing restart.
		return originalReads < 4
			? state(DURABLE_A)
			: state({ provider: "anthropic", id: "rollback-mismatch", thinkingLevel: "high" });
	});
	const original = makeSession("O", originalBridge);
	const restart = makeSession("R", restartBridge);
	let canonical: any = original;
	const terminated: string[] = [];
	const archived: string[] = [];
	const broadcasts: string[] = [];

	const manager: any = {
		getPersistedSession: () => ({
			modelProvider: durable.provider,
			modelId: durable.id,
			effectiveThinkingLevel: durable.thinkingLevel,
		}),
		persistSessionModel: (_id: string, provider: string, id: string, thinkingLevel: string) => {
			durable = { provider, id, thinkingLevel };
		},
		updateModelNameFile: vi.fn(),
		getSession: () => canonical,
		restartAgent: vi.fn(async () => {
			await originalBridge.stop();
			canonical = restart;
		}),
		terminateSession: vi.fn(async () => {
			if (!canonical) return false;
			terminated.push(canonical.name);
			await canonical.rpcClient.stop();
			canonical = undefined;
			return true;
		}),
		storeArchive: vi.fn(async () => {
			archived.push(canonical?.name ?? "none");
			return true;
		}),
	};
	const broadcast = (_clients: Set<unknown>, message: any) => {
		const model = message?.data?.model;
		broadcasts.push(`${model?.provider}/${model?.id}/${message?.data?.thinkingLevel}`);
	};
	const install = (session: any, tuple: Tuple) => {
		canonical = session;
		durable = { ...tuple };
	};

	return {
		manager,
		original,
		restart,
		originalBridge,
		broadcast,
		broadcasts,
		terminated,
		archived,
		install,
		canonical: () => canonical,
		durable: () => ({ ...durable }),
	};
}

function startFailedSelection(harness: ReturnType<typeof makeHarness>): Promise<unknown> {
	return applyRuntimeSessionThinkingSelection(
		harness.manager,
		harness.original as any,
		"medium",
		harness.broadcast,
	);
}

describe("runtime recovery bridge ownership", () => {
	it("does not commit, rollback, or restart a mutation superseded by clear generation ownership", async () => {
		let tuple: Tuple = { ...DURABLE_A };
		let replacement = { active: false, generation: 7 };
		const bridge = makeBridge("clear-owned", async () => state(tuple));
		bridge.setThinkingLevel.mockImplementation(async (thinkingLevel: string) => {
			tuple = { ...tuple, thinkingLevel };
			// Simulate clear installing its coordinator while the Pi mutation RPC is
			// settling. The retained bridge identity alone is not canonical ownership.
			replacement = { active: true, generation: 8 };
			return { success: true };
		});
		const session = makeSession("clear-owned", bridge);
		const persistSessionModel = vi.fn();
		const restartAgent = vi.fn();
		const terminateSession = vi.fn();
		const storeArchive = vi.fn();
		const manager: any = {
			getPersistedSession: () => ({
				modelProvider: DURABLE_A.provider,
				modelId: DURABLE_A.id,
				effectiveThinkingLevel: DURABLE_A.thinkingLevel,
			}),
			persistSessionModel,
			updateModelNameFile: vi.fn(),
			getSession: () => session,
			getSessionReplacementAdmission: () => replacement,
			restartAgent,
			terminateSession,
			storeArchive,
		};

		await assert.rejects(
			applyRuntimeSessionThinkingSelection(manager, session as any, "medium"),
			/superseded|replacement/i,
		);

		assert.equal(persistSessionModel.mock.calls.length, 0, `${MARKER}: superseded tuple was persisted`);
		assert.equal(restartAgent.mock.calls.length, 0, `${MARKER}: clear-owned bridge was restarted`);
		assert.equal(terminateSession.mock.calls.length, 0, `${MARKER}: clear-owned bridge was terminated`);
		assert.equal(storeArchive.mock.calls.length, 0, `${MARKER}: clear-owned session was archived`);
		assert.equal(bridge.stop.mock.calls.length, 0, `${MARKER}: clear-owned bridge was stopped`);
		assert.equal(bridge.setModel.mock.calls.length, 0, `${MARKER}: superseded mutation attempted rollback`);
	});

	it("retains B when it replaces restart bridge R during R read-back", async () => {
		const rReadStarted = deferred<void>();
		const rRead = deferred<unknown>();
		const rBridge = makeBridge("R", async () => {
			rReadStarted.resolve();
			return rRead.promise;
		});
		const harness = makeHarness(rBridge);
		const bBridge = makeBridge("B", async () => state(DURABLE_B));
		const b = makeSession("B", bBridge);

		const selection = startFailedSelection(harness);
		await rReadStarted.promise;
		harness.install(b, DURABLE_B);
		rRead.resolve({ success: true, data: {} });
		await assert.rejects(selection);

		assert.deepEqual(harness.terminated, [], `${MARKER}: stale R recovery terminated canonical B`);
		assert.deepEqual(harness.archived, [], `${MARKER}: stale R recovery archived canonical B`);
		assert.equal(rBridge.stop.mock.calls.length, 1, `${MARKER}: detached R must be stopped exactly once`);
		assert.equal(bBridge.stop.mock.calls.length, 0, `${MARKER}: canonical B must not be stopped`);
		assert.equal(harness.canonical(), b, `${MARKER}: B must remain canonical`);
		assert.deepEqual(harness.durable(), DURABLE_B, `${MARKER}: B must remain durable`);
		assert.equal(harness.broadcasts.at(-1), `${DURABLE_B.provider}/${DURABLE_B.id}/${DURABLE_B.thinkingLevel}`);
	});

	it("retains B when it commits after R failure is released but before quarantine admission", async () => {
		const rReadStarted = deferred<void>();
		const releaseRFailure = deferred<void>();
		const rBridge = makeBridge("R", async () => {
			rReadStarted.resolve();
			await releaseRFailure.promise;
			throw new Error("R read-back failed");
		});
		const harness = makeHarness(rBridge);
		const bBridge = makeBridge("B", async () => state(DURABLE_B));
		const b = makeSession("B", bBridge);

		const selection = startFailedSelection(harness);
		await rReadStarted.promise;
		releaseRFailure.resolve();
		// This synchronous staged commit runs before the failed read's continuation
		// can enter quarantine by session id.
		harness.install(b, DURABLE_B);
		await assert.rejects(selection);

		assert.deepEqual(harness.terminated, [], `${MARKER}: post-failure R recovery terminated canonical B`);
		assert.deepEqual(harness.archived, [], `${MARKER}: post-failure R recovery archived canonical B`);
		assert.equal(rBridge.stop.mock.calls.length, 1, `${MARKER}: failed detached R must be stopped`);
		assert.equal(bBridge.stop.mock.calls.length, 0, `${MARKER}: canonical B must not be stopped`);
		assert.equal(harness.canonical(), b, `${MARKER}: B must remain canonical`);
		assert.deepEqual(harness.durable(), DURABLE_B, `${MARKER}: B must remain durable`);
	});

	it("does not publish B after C replaces it while B verification is held", async () => {
		const rReadStarted = deferred<void>();
		const releaseRFailure = deferred<void>();
		const rBridge = makeBridge("R", async () => {
			rReadStarted.resolve();
			await releaseRFailure.promise;
			throw new Error("R read-back failed");
		});
		const harness = makeHarness(rBridge);
		const bReadStarted = deferred<void>();
		const releaseBRead = deferred<unknown>();
		const bBridge = makeBridge("B", async () => {
			bReadStarted.resolve();
			return releaseBRead.promise;
		});
		const b = makeSession("B", bBridge);
		const cBridge = makeBridge("C", async () => state(DURABLE_C));
		const c = makeSession("C", cBridge);

		const selection = startFailedSelection(harness);
		await rReadStarted.promise;
		harness.install(b, DURABLE_B);
		releaseRFailure.resolve();
		const admission = await Promise.race([
			bReadStarted.promise.then(() => "B-read" as const),
			selection.then(() => "settled" as const, () => "settled" as const),
		]);
		assert.equal(admission, "B-read", `${MARKER}: recovery quarantined B instead of verifying the newer canonical bridge`);

		harness.broadcasts.push("C-authoritative");
		harness.install(c, DURABLE_C);
		releaseBRead.resolve(state(DURABLE_B));
		await assert.rejects(selection);

		const cIndex = harness.broadcasts.indexOf("C-authoritative");
		assert.equal(
			harness.broadcasts.slice(cIndex + 1).some((entry) => entry === `${DURABLE_B.provider}/${DURABLE_B.id}/${DURABLE_B.thinkingLevel}`),
			false,
			`${MARKER}: stale B read-back was published after C became authoritative`,
		);
		assert.deepEqual(harness.terminated, [], `${MARKER}: stale B verification terminated canonical C`);
		assert.deepEqual(harness.archived, [], `${MARKER}: stale B verification archived canonical C`);
		assert.equal(cBridge.stop.mock.calls.length, 0, `${MARKER}: canonical C must not be stopped`);
		assert.equal(harness.canonical(), c, `${MARKER}: C must remain canonical`);
		assert.deepEqual(harness.durable(), DURABLE_C, `${MARKER}: C must remain durable`);
	});
});
