// Source: tests/cold-restart-reprompt.test.ts
// Bucket: v2-core | Method: optimized fixture

/**
 * Reproducing test (failing-first) — cold-restart re-prompt timeout & boot
 * unhandled rejection.
 *
 * See goal "Fix cold-restart re-prompt timeout" / the Issue Analysis gate.
 *
 * On gateway restart, two recovery mechanisms re-prompt freshly-restored
 * sessions while the agent process is still COLD (model init + MCP extension
 * load — 30–90s to first respond). Both dispatch with the default 30s RPC
 * prompt timeout and NEITHER waits for the agent to become ready, so they
 * reliably time out on boot. There is also a double-prompt race when a
 * team-lead is both mid-turn and has outstanding work.
 *
 * These three tests assert the DESIRED (fixed) behaviour through observable
 * seams (call order, the prompt timeout argument, whether a rejection escaped,
 * how many times the cold agent is prompted) — NOT new symbol names — so they
 * stay robust against the implementer's exact naming. They MUST FAIL on the
 * current (unfixed) branch and PASS once the fix lands:
 *
 *   1. Mid-turn re-prompt (session-manager.ts restoreSession) must call
 *      waitForReady BEFORE prompt and pass a generous (≥90s) timeout, so the
 *      cold prompt lands instead of rejecting with "Command timed out: prompt".
 *   2. Boot-resume nudge (team-manager.ts _bootResumeIdleTeamLeads) must not
 *      let the async drain's cold-start rejection escape as an unhandled
 *      rejection.
 *   3. A session that is BOTH mid-turn AND a team-lead with outstanding work
 *      must be re-prompted/nudged EXACTLY ONCE (the boot-resume path skips a
 *      lead already covered by the mid-turn re-prompt).
 *
 * Harness mirrors tests/image-only-prompt-dispatch.test.ts (real SessionManager
 * + recording fake bridge via registerRpcBridgeFactory) and
 * tests/team-manager-idle-nudge-backoff.test.ts (TeamManager with stubbed
 * deps). Promise-chain-flushed so a regression never waits on real
 * 30s/90s timeouts.
 */
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { TeamManager } from "../../src/server/agent/team-manager.ts";
import { registerRpcBridgeFactory } from "../../src/server/agent/rpc-bridge.ts";

// This suite exercises restore orchestration, not persistence or prompt assembly.
// Keep its fixture paths synthetic and process-owned so v2-core workers perform no
// Defender-scanned NTFS writes and cannot contend with another Vitest process.
const tmpRoot = path.resolve(".profiles", "testing-v2", "fixtures", `cold-restart-${process.pid}`);
const stateDir = path.join(tmpRoot, "state");

const GENEROUS_TIMEOUT_FLOOR_MS = 90_000;
const COLD_TIMEOUT_MSG = "Command timed out: prompt";

/** Let fire-and-forget promise chains settle without real timers. */
async function flush(times = 8): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

const managers: any[] = [];
const teamManagers: any[] = [];
beforeEach(() => {
	// Expected restore/nudge diagnostics are not part of this behavioral contract.
	// Suppress synchronous console writes so loaded unit workers do not contend on
	// a shared stdout pipe while these orchestration assertions execute.
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	registerRpcBridgeFactory(null);
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) clearInterval(m._statusHeartbeatTimer);
		m.sessions?.clear?.();
	}
	while (teamManagers.length > 0) {
		const tm = teamManagers.pop();
		try { tm.dispose?.(); } catch { /* ignore */ }
		try {
			for (const [, t] of tm.idleNudgeTimers ?? []) { clearTimeout(t); clearInterval(t); }
			tm.idleNudgeTimers?.clear?.();
			for (const [, t] of tm.noWorkersNudgeTimers ?? []) { clearTimeout(t); clearInterval(t); }
			tm.noWorkersNudgeTimers?.clear?.();
		} catch { /* ignore */ }
	}
	vi.restoreAllMocks();
});

/** A real SessionManager with only the restore-orchestration boundaries faked. */
function makeManager(bridge: any): any {
	registerRpcBridgeFactory(() => bridge);
	// Supplying a PCM prevents SessionManager's non-PCM constructor from opening
	// six unrelated durable stores. The records below remain the suite's explicit
	// in-memory persistence seam, as they were before this fixture optimization.
	const m: any = new SessionManager({ projectContextManager: {} as any, stateDir });
	m._testStore = {
		update: () => {},
		get: () => undefined,
		getLive: () => [],
		archive: () => {},
		archiveAsync: async () => {},
	};
	m.projectContextManager = {
		all: () => [],
		getAllLiveSessions: () => m._testStore.getLive?.() ?? [],
	};
	m.getSessionStore = () => m._testStore;
	m.resolveStoreForSession = () => m._testStore;
	m.resolveStoreForId = () => m._testStore;
	// Prompt bytes, admin-token loading, model discovery, and provider env are
	// orthogonal to every assertion here and are covered by their owning suites.
	m.assemblePrompt = () => undefined;
	m.applyScopedGatewayCredentials = () => {};
	m.applyDirectProviderEnv = () => {};
	m.buildToolActivationArgs = () => ({ args: [], runtimeExtensions: [], env: {} });
	m.tryAutoSelectModel = async () => {};
	m.sessionSecretStore = {
		getOrCreateSecret: () => "cold-restart-fixture-secret",
		remove: () => {},
	};
	managers.push(m);
	return m;
}

/** Minimal PersistedSession for an interactive, mid-turn (wasStreaming) session. */
function makeMidTurnPersistedSession(id: string): any {
	return {
		id,
		title: "Cold Restored Session", // non-default → titleGenerated, skips title gen
		cwd: tmpRoot,
		agentSessionFile: path.join(stateDir, `${id}.jsonl`),
		createdAt: Date.now(),
		lastActivity: Date.now(),
		wasStreaming: true,
		// interactive: nonInteractive intentionally unset
	};
}

/**
 * A fake PCM whose getContextForGoal() reports concrete outstanding work (one
 * failed gate) for any goal — so _outstandingWorkSummary() is non-null and the
 * boot-resume nudge is eligible to fire. all() returns [] so restoreTeams() is
 * a no-op (we seed team entries manually).
 */
function makeOutstandingWorkPcm(
	goalId: string,
	opts: { gateStatuses?: string[]; goal?: Record<string, unknown> } = {},
): any {
	const goal = {
		id: goalId,
		state: "in-progress",
		archived: false,
		paused: false,
		...opts.goal,
	};
	const gateStatuses = opts.gateStatuses ?? ["failed"];
	const ctx = {
		goalStore: { get: (id: string) => (id === goalId ? goal : undefined), getAll: () => [goal] },
		gateStore: { getGatesForGoal: () => gateStatuses.map(status => ({ status })) },
		taskStore: { getByGoalId: () => [] },
		goalManager: { listLiveGoals: () => [goal] },
		teamStore: { getAll: () => [] },
	};
	return { all: () => [], getContextForGoal: () => ctx };
}

function makeTeamManager(sm: any, pcm: any): any {
	const config: any = {
		gatewayUrl: "https://10.5.0.2:3000",
		authToken: "cold-restart-test-token",
		roleStore: { get: () => undefined, getAll: () => [] },
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
		projectContextManager: pcm,
	};
	const tm: any = new TeamManager(sm, config);
	teamManagers.push(tm);
	return tm;
}

describe("cold-restart re-prompt (reproducing)", () => {
	it("mid-turn re-prompt waits for ready, then prompts with a generous timeout", async () => {
		// Recording cold-agent bridge: prompt rejects with the cold-start timeout
		// UNLESS waitForReady was awaited first (ready flag flipped). This
		// simulates a freshly-revived agent that needs >30s before it can accept
		// a prompt.
		const log: Array<{ k: string; timeoutMs?: number }> = [];
		let ready = false;
		let coldRejection = false;
		const bridge: any = {
			running: true,
			async start() {},
			async stop() {},
			async waitForReady(t?: number) { log.push({ k: "waitForReady", timeoutMs: t }); ready = true; },
			prompt(_text: string, _images?: any, timeoutMs?: number) {
				log.push({ k: "prompt", timeoutMs });
				if (!ready) {
					coldRejection = true;
					return Promise.reject(new Error(COLD_TIMEOUT_MSG));
				}
				return Promise.resolve({ success: true });
			},
			// Robustness: the fix may funnel the cold re-prompt through a shared
			// `promptWhenReady` helper rather than calling waitForReady + prompt
			// inline. Mirror the real RpcBridge helper's contract (wait, then
			// prompt with a generous default) so EITHER fix shape is observed
			// identically through the call log.
			async promptWhenReady(text: string, images?: any, opts?: { readyTimeoutMs?: number; promptTimeoutMs?: number }) {
				await this.waitForReady(opts?.readyTimeoutMs ?? GENEROUS_TIMEOUT_FLOOR_MS);
				return this.prompt(text, images, opts?.promptTimeoutMs ?? 120_000);
			},
			steer() { return Promise.resolve({ success: true }); },
			abort() { return Promise.resolve({ success: true }); },
			getState() { return Promise.resolve({ success: true }); },
			getMessages() { return Promise.resolve({ success: true, data: { messages: [] } }); },
			setModel() { return Promise.resolve({ success: true }); },
			setThinkingLevel() { return Promise.resolve({ success: true }); },
			compact() { return Promise.resolve({ success: true }); },
			sendCommand() { return Promise.resolve({ success: true }); }, // switch_session etc.
			onEvent() { return () => {}; },
		};

		const m = makeManager(bridge);
		const ps = makeMidTurnPersistedSession("cold-midturn-1");

		await m.restoreSession(ps);
		// The re-prompt is dispatched fire-and-forget (.catch attached) — let the
		// waitForReady + prompt sequence settle.
		await flush();

		const promptIdx = log.findIndex((e) => e.k === "prompt");
		const readyIdx = log.findIndex((e) => e.k === "waitForReady");

		assert.ok(
			promptIdx >= 0,
			`expected restoreSession's mid-turn branch to dispatch a re-prompt to the agent bridge; call log: ${JSON.stringify(log)}`,
		);
		assert.ok(
			readyIdx >= 0 && readyIdx < promptIdx,
			`mid-turn re-prompt must call waitForReady BEFORE prompt on a cold restored agent, but it did not (readyIdx=${readyIdx}, promptIdx=${promptIdx}). The current code calls rpcClient.prompt() directly with no readiness wait. Call log: ${JSON.stringify(log)}`,
		);
		assert.ok(
			typeof log[promptIdx].timeoutMs === "number" && (log[promptIdx].timeoutMs as number) >= GENEROUS_TIMEOUT_FLOOR_MS,
			`mid-turn re-prompt must use a generous timeout (≥${GENEROUS_TIMEOUT_FLOOR_MS}ms) for a cold agent, but got ${log[promptIdx].timeoutMs}ms (the current code passes no timeout → the 30s RPC default). Call log: ${JSON.stringify(log)}`,
		);
		assert.equal(
			coldRejection,
			false,
			`the cold re-prompt rejected with "${COLD_TIMEOUT_MSG}" because it was dispatched before the agent was ready — this is the bug (it surfaces as "Failed to re-prompt … Command timed out: prompt"). After the fix, waitForReady is awaited first so the prompt lands. Call log: ${JSON.stringify(log)}`,
		);
	});

	it.each(["assign-role", "restart"])("defers wasStreaming continuation until queued %s installs the final bridge", async (kind) => {
		const provisionalPrompts: string[] = [];
		const finalPrompts: string[] = [];
		const provisional: any = {
			running: true,
			async start() {}, async stop() {}, async waitForReady() {},
			async promptWhenReady(text: string) { provisionalPrompts.push(text); return { success: true }; },
			async prompt() { return { success: true }; }, async steer() { return { success: true }; },
			async abort() { return { success: true }; }, async getState() { return { success: true, data: {} }; },
			async getMessages() { return { success: true, data: { messages: [] } }; },
			async setModel() { return { success: true }; }, async setThinkingLevel() { return { success: true }; },
			async compact() { return { success: true }; }, async sendCommand() { return { success: true }; },
			onEvent() { return () => {}; },
		};
		const finalBridge = {
			...provisional,
			async promptWhenReady(text: string) { finalPrompts.push(text); return { success: true }; },
		};
		const m = makeManager(provisional);
		const ps = makeMidTurnPersistedSession(`boot-final-${kind}`);
		let releaseRestore!: () => void;
		let restored!: () => void;
		const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
		const restoredGate = new Promise<void>((resolve) => { restored = resolve; });

		const restore = m._coordinateSessionReplacement(ps.id, "restore", async () => {
			await m.restoreSession(ps);
			restored();
			await restoreGate;
			return m.sessions.get(ps.id);
		}, { cancelOnTerminal: () => undefined });
		await restoredGate;
		assert.deepEqual(provisionalPrompts, [], "provisional restore bridge must not receive continuation");
		const replacement = m._coordinateSessionReplacement(ps.id, kind, async () => {
			m.sessions.get(ps.id).rpcClient = finalBridge;
			return undefined;
		}, { cancelOnTerminal: () => undefined });
		releaseRestore();
		await Promise.all([restore, replacement]);
		await flush();

		assert.deepEqual(provisionalPrompts, []);
		assert.equal(finalPrompts.length, 1, "only the final canonical bridge receives boot continuation");
		assert.match(finalPrompts[0], /server restarted while you were mid-turn/i);
	});

	it("keeps boot continuation durable across a restart between provisional install and finalizer", async () => {
		const firstPrompts: string[] = [];
		const secondPrompts: string[] = [];
		const baseBridge: any = {
			running: true,
			async start() {}, async stop() {}, async waitForReady() {},
			async prompt() { return { success: true }; }, async steer() { return { success: true }; },
			async abort() { return { success: true }; }, async getState() { return { success: true, data: {} }; },
			async getMessages() { return { success: true, data: { messages: [] } }; },
			async setModel() { return { success: true }; }, async setThinkingLevel() { return { success: true }; },
			async compact() { return { success: true }; }, async sendCommand() { return { success: true }; },
			onEvent() { return () => {}; },
		};
		const firstBridge = {
			...baseBridge,
			async promptWhenReady(text: string) { firstPrompts.push(text); return { success: true }; },
		};
		const ps = makeMidTurnPersistedSession("boot-restart-provisional");
		const first = makeManager(firstBridge);
		first._testStore = {
			get: () => ps,
			update: (_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates),
			archive: () => {},
		};
		let release!: () => void;
		let installed!: () => void;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		const installedGate = new Promise<void>((resolve) => { installed = resolve; });
		const restore = first._coordinateSessionReplacement(ps.id, "restore", async () => {
			await first.restoreSession(ps);
			installed();
			await hold;
		}, { cancelOnTerminal: () => undefined });
		await installedGate;

		assert.equal(ps.wasStreaming, true, "provisional restore must not clear durable continuation intent");
		assert.deepEqual(firstPrompts, []);
		// Model the old gateway disappearing before its coordinator finalizer.
		first._sessionReplacementCoordinators.get(ps.id).terminalRequest = "terminate";
		release();
		await restore;

		const secondBridge = {
			...baseBridge,
			async promptWhenReady(text: string) { secondPrompts.push(text); return { success: true }; },
		};
		const second = makeManager(secondBridge);
		second._testStore = first._testStore;
		await second.restoreSession(ps);
		await flush();

		assert.equal(firstPrompts.length, 0);
		assert.equal(secondPrompts.length, 1, "next boot must deliver the still-durable continuation once");
		assert.equal(ps.wasStreaming, false, "only accepted canonical dispatch clears the marker");
	});

	it("dispatches boot continuation once after a queued final replacement fails", async () => {
		const prompts: string[] = [];
		const bridge: any = {
			running: true,
			async start() {}, async stop() {}, async waitForReady() {},
			async promptWhenReady(text: string) { prompts.push(text); return { success: true }; },
			async prompt() { return { success: true }; }, async steer() { return { success: true }; },
			async abort() { return { success: true }; }, async getState() { return { success: true, data: {} }; },
			async getMessages() { return { success: true, data: { messages: [] } }; },
			async setModel() { return { success: true }; }, async setThinkingLevel() { return { success: true }; },
			async compact() { return { success: true }; }, async sendCommand() { return { success: true }; },
			onEvent() { return () => {}; },
		};
		const m = makeManager(bridge);
		const ps = makeMidTurnPersistedSession("boot-final-replacement-fails");
		m._testStore = {
			get: () => ps,
			update: (_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates),
			archive: () => {},
		};
		let release!: () => void;
		let installed!: () => void;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		const installedGate = new Promise<void>((resolve) => { installed = resolve; });
		const restore = m._coordinateSessionReplacement(ps.id, "restore", async () => {
			await m.restoreSession(ps);
			installed();
			await hold;
		}, { cancelOnTerminal: () => undefined });
		await installedGate;
		const failedFinal = m._coordinateSessionReplacement(ps.id, "assign-role", async () => {
			throw new Error("fixture final replacement failed");
		}, { cancelOnTerminal: () => undefined });

		release();
		await restore;
		await assert.rejects(failedFinal, /fixture final replacement failed/);
		await flush();

		assert.equal(prompts.length, 1, "rollback canonical bridge receives one continuation, never a provisional duplicate");
		assert.equal(ps.wasStreaming, false);
	});

	it.each(["stop", "terminate"])("cancels deferred wasStreaming continuation when queued %s wins", async (terminal) => {
		const bootPrompts: string[] = [];
		const bridge: any = {
			running: true,
			async start() {}, async stop() {}, async waitForReady() {},
			async promptWhenReady(text: string) { bootPrompts.push(text); return { success: true }; },
			async prompt() { return { success: true }; }, async steer() { return { success: true }; },
			async abort() { return { success: true }; }, async getState() { return { success: true, data: {} }; },
			async getMessages() { return { success: true, data: { messages: [] } }; },
			async setModel() { return { success: true }; }, async setThinkingLevel() { return { success: true }; },
			async compact() { return { success: true }; }, async sendCommand() { return { success: true }; },
			onEvent() { return () => {}; },
		};
		const m = makeManager(bridge);
		const ps = makeMidTurnPersistedSession(`boot-cancel-${terminal}`);
		m._testStore.get = () => ps;
		m._testStore.getLive = () => [ps];
		let releaseRestore!: () => void;
		let restored!: () => void;
		const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
		const restoredGate = new Promise<void>((resolve) => { restored = resolve; });
		const restore = m._coordinateSessionReplacement(ps.id, "restore", async () => {
			await m.restoreSession(ps);
			restored();
			await restoreGate;
			return m.sessions.get(ps.id);
		}, { cancelOnTerminal: () => undefined });
		await restoredGate;

		const terminalRequest = terminal === "stop"
			? m.forceAbort(ps.id, 5)
			: m.terminateSession(ps.id);
		releaseRestore();
		await restore;
		await terminalRequest;
		await flush();

		assert.deepEqual(bootPrompts, [], `${terminal} must suppress provisional boot continuation`);
		assert.equal(m._sessionReplacementCoordinators.has(ps.id), false);
	});

	it("boot-resume nudge never escapes as an unhandled rejection", async () => {
		// The real SessionManager.enqueuePrompt drains ASYNCHRONOUSLY: for an idle
		// lead with an empty queue it `await`s dispatchDirectPrompt → rpcClient
		// .prompt(), which on a cold agent rejects with the cold-start timeout and
		// rethrows. The defect is that _bootResumeIdleTeamLeads calls enqueuePrompt
		// WITHOUT awaiting/catching the returned promise (its try/catch only guards
		// the synchronous enqueue), so that rejection escapes as
		// "[gateway] Unhandled rejection: Error: Command timed out: prompt".
		//
		// We model enqueuePrompt's return value as a thenable that records whether
		// the caller attaches a rejection handler (i.e. awaits it inside a
		// try/catch, or .catch()es it). This observes the exact fix —
		// "the boot-resume dispatch rejection is OWNED, never discarded" — without
		// depending on internal symbol names, and without a real process-level
		// unhandled rejection that could be attributed to the wrong test. We ALSO
		// keep a process unhandledRejection guard: if the fix awaits but forgets
		// the try/catch, the rejection still escapes and this fails too.
		let rejectionConsumed = false;
		const coldDrainThenable: any = {
			then(onFulfilled: any, onRejected: any) {
				if (typeof onRejected === "function") {
					rejectionConsumed = true;
					queueMicrotask(() => onRejected(new Error(COLD_TIMEOUT_MSG)));
				} else if (typeof onFulfilled === "function") {
					queueMicrotask(() => onFulfilled(undefined));
				}
				return coldDrainThenable;
			},
			catch(onRejected: any) { return this.then(undefined, onRejected); },
			finally(onFinally: any) { if (typeof onFinally === "function") queueMicrotask(onFinally); return coldDrainThenable; },
		};

		const session: any = { id: "tl-cold", status: "idle", rpcClient: { onEvent: () => () => {} } };
		const sm: any = {
			getSession: (id: string) => (id === "tl-cold" ? session : undefined),
			// Returns the cold-drain thenable. The bug discards it (rejection
			// escapes); the fix awaits/catches it (rejectionConsumed → true).
			enqueuePrompt: () => coldDrainThenable,
			// The fixed team-manager may consult this to coordinate with the
			// mid-turn re-prompt; return false so the nudge still fires here.
			wasBootReprompted: () => false,
		};

		const pcm = makeOutstandingWorkPcm("goal-cold");
		const tm = makeTeamManager(sm, pcm);
		(tm.teams as Map<string, any>).set("goal-cold", {
			goalId: "goal-cold",
			teamLeadSessionId: "tl-cold",
			agents: [],
		});

		const captured: string[] = [];
		const onUnhandled = (reason: any) => {
			captured.push(reason && reason.message ? String(reason.message) : String(reason));
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			tm._bootResumeIdleTeamLeads();
			await flush(6);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}

		assert.equal(
			rejectionConsumed,
			true,
			`the boot-resume nudge did NOT consume (await/catch) the async dispatch promise — so a cold-start rejection has no owner and escapes as "[gateway] Unhandled rejection: Error: ${COLD_TIMEOUT_MSG}". The current code calls sessionManager.enqueuePrompt(...) without awaiting it; the fix must await it inside a try/catch.`,
		);
		const escaped = captured.filter((m) => m.includes(COLD_TIMEOUT_MSG));
		assert.equal(
			escaped.length,
			0,
			`a cold-start dispatch rejection escaped as a process-level unhandled rejection (${JSON.stringify(escaped)}). The boot-resume drain must be awaited inside a try/catch so the rejection is caught and logged, never surfaced as "[gateway] Unhandled rejection".`,
		);
	});

	it("boot-resumes a reopened goal with a pending reset gate exactly once", async () => {
		const prompts: string[] = [];
		const session: any = { id: "tl-reset-pending", status: "idle", rpcClient: { onEvent: () => () => {} } };
		const sm: any = {
			getSession: (id: string) => (id === session.id ? session : undefined),
			enqueuePrompt: (_id: string, message: string) => {
				prompts.push(message);
				return Promise.resolve({ status: "dispatched" });
			},
			wasBootReprompted: () => false,
		};
		const pcm = makeOutstandingWorkPcm("goal-reset-pending", { gateStatuses: ["pending"] });
		const tm = makeTeamManager(sm, pcm);
		(tm.teams as Map<string, any>).set("goal-reset-pending", {
			goalId: "goal-reset-pending",
			teamLeadSessionId: session.id,
			agents: [],
		});

		tm._bootResumeIdleTeamLeads();
		tm._bootResumeIdleTeamLeads();
		await flush();

		assert.equal(prompts.length, 1, "a pending reset gate must produce exactly one boot-resume nudge");
		assert.match(prompts[0], /1 unresolved gate/i, "boot-resume must explain the pending workflow work");
	});

	it.each([
		["complete", { state: "complete" }],
		["paused", { paused: true }],
		["shelved", { state: "shelved" }],
		["archived", { archived: true }],
	] as const)("does not boot-resume a %s goal even with a pending gate", async (_label, goal) => {
		const prompts: string[] = [];
		const session: any = { id: `tl-dormant-${_label}`, status: "idle", rpcClient: { onEvent: () => () => {} } };
		const sm: any = {
			getSession: (id: string) => (id === session.id ? session : undefined),
			enqueuePrompt: (_id: string, message: string) => prompts.push(message),
			wasBootReprompted: () => false,
		};
		const goalId = `goal-dormant-${_label}`;
		const tm = makeTeamManager(sm, makeOutstandingWorkPcm(goalId, { gateStatuses: ["pending"], goal }));
		(tm.teams as Map<string, any>).set(goalId, { goalId, teamLeadSessionId: session.id, agents: [] });

		tm._bootResumeIdleTeamLeads();
		await flush();

		assert.deepEqual(prompts, [], `${_label} goal must remain dormant across restart`);
	});

	it("does not duplicate pending-gate boot resume when the lead was already boot-reprompted", async () => {
		const prompts: string[] = [];
		const session: any = { id: "tl-reset-midturn", status: "idle", rpcClient: { onEvent: () => () => {} } };
		const sm: any = {
			getSession: (id: string) => (id === session.id ? session : undefined),
			enqueuePrompt: (_id: string, message: string) => prompts.push(message),
			wasBootReprompted: (id: string) => id === session.id,
		};
		const goalId = "goal-reset-midturn";
		const tm = makeTeamManager(sm, makeOutstandingWorkPcm(goalId, { gateStatuses: ["pending"] }));
		(tm.teams as Map<string, any>).set(goalId, { goalId, teamLeadSessionId: session.id, agents: [] });

		tm._bootResumeIdleTeamLeads();
		await flush();

		assert.deepEqual(prompts, [], "mid-turn continuation already owns the one boot prompt");
	});

	it("a session that is both mid-turn and a team-lead with open work is re-prompted exactly once", async () => {
		// One cold agent, two recovery mechanisms. The mid-turn re-prompt
		// (restoreSession) and the boot-resume nudge (_bootResumeIdleTeamLeads)
		// must not both fire — the boot-resume path must skip a lead the
		// mid-turn re-prompt already covered.
		let rePromptCalls = 0;
		const bridge: any = {
			running: true,
			async start() {},
			async stop() {},
			async waitForReady() {},
			prompt() { rePromptCalls++; return Promise.resolve({ success: true }); },
			async promptWhenReady(text: string, images?: any, opts?: { readyTimeoutMs?: number; promptTimeoutMs?: number }) {
				await this.waitForReady(opts?.readyTimeoutMs ?? GENEROUS_TIMEOUT_FLOOR_MS);
				return this.prompt(text, images, opts?.promptTimeoutMs ?? 120_000);
			},
			steer() { return Promise.resolve({ success: true }); },
			abort() { return Promise.resolve({ success: true }); },
			getState() { return Promise.resolve({ success: true }); },
			getMessages() { return Promise.resolve({ success: true, data: { messages: [] } }); },
			setModel() { return Promise.resolve({ success: true }); },
			setThinkingLevel() { return Promise.resolve({ success: true }); },
			compact() { return Promise.resolve({ success: true }); },
			sendCommand() { return Promise.resolve({ success: true }); },
			onEvent() { return () => {}; },
		};

		const m = makeManager(bridge);
		const ps = makeMidTurnPersistedSession("tl-both-1");

		// 1) Mid-turn re-prompt fires here (and, after the fix, records a
		//    boot-reprompt coordination marker for this session id).
		await m.restoreSession(ps);
		await flush();

		// Ensure the restored session is visible as an idle team-lead.
		const restored = m.sessions.get("tl-both-1");
		assert.ok(restored, "restored session should be registered in the manager");
		restored.status = "idle";

		// 2) Boot-resume pass. Replace enqueuePrompt with a counting stub so we
		//    measure nudge attempts without driving the heavy real dispatch path
		//    (which would re-enter the bridge via recovery redrains).
		let nudgeCalls = 0;
		m.enqueuePrompt = (_sid: string, _msg: string, _opts?: any) => {
			nudgeCalls++;
			return Promise.resolve({ status: "dispatched" });
		};

		const pcm = makeOutstandingWorkPcm("goal-both");
		const tm = makeTeamManager(m, pcm);
		(tm.teams as Map<string, any>).set("goal-both", {
			goalId: "goal-both",
			teamLeadSessionId: "tl-both-1",
			agents: [],
		});

		tm._bootResumeIdleTeamLeads();
		await flush();

		const totalDispatches = rePromptCalls + nudgeCalls;
		assert.equal(
			totalDispatches,
			1,
			`a session that is both mid-turn (wasStreaming) and a team-lead with outstanding work must be re-prompted/nudged EXACTLY ONCE, but the cold agent received ${totalDispatches} dispatches ` +
				`(mid-turn re-prompts=${rePromptCalls}, boot-resume nudges=${nudgeCalls}). The boot-resume pass must skip a lead already covered by the mid-turn re-prompt; the current code fires both and races two prompts at the same cold agent.`,
		);
	});
});
