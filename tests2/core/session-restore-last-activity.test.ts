import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import {
	beginSessionPromptActivity,
	cancelPendingSessionPromptActivity,
	cancelSessionPromptActivity,
	commitSessionPromptActivity,
	installSessionActivityAttribution,
	isUserVisibleActivity,
	recordSessionEventActivity,
	suppressSessionActivityUntilPrompt,
} from "../../src/server/agent/session-activity.ts";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.ts";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	initAuthorSidecarDir,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.ts";
import { registerRpcBridgeFactory, type RpcBridgeOptions } from "../../src/server/agent/rpc-bridge.ts";

class RestoreBridge {
	listener?: (event: any) => void;
	running = true;
	steerResponse: any = { success: true };
	steerError?: Error;
	steerEvents: any[] = [];
	steerCalls = 0;
	promptResponse: any = { success: true };
	promptError?: Error;
	promptEvents?: any[];
	promptTexts: string[] = [];
	messages: any[] = [];

	constructor(readonly id: string) {}

	onEvent(listener: (event: any) => void): () => void {
		this.listener = listener;
		return () => { if (this.listener === listener) this.listener = undefined; };
	}

	emit(event: any): void { this.listener?.(event); }
	async start(): Promise<void> {}
	async stop(): Promise<void> { this.running = false; }
	async waitForReady(): Promise<void> {}
	async abort(): Promise<any> { return { success: true }; }
	async steer(): Promise<any> {
		this.steerCalls += 1;
		for (const event of this.steerEvents) this.emit(event);
		if (this.steerError) throw this.steerError;
		return this.steerResponse;
	}
	async compact(): Promise<any> { return { success: true }; }
	async getMessages(): Promise<any> { return { success: true, data: { messages: this.messages } }; }
	async getState(): Promise<any> { return { success: true, data: {} }; }
	async setModel(): Promise<any> { return { success: true }; }
	async setThinkingLevel(): Promise<any> { return { success: true }; }

	async sendCommand(command: any): Promise<any> {
		if (command?.type === "switch_session") {
			// Production restore subscriber, production preparation, and production
			// replay guard all see these events before the response boundary.
			this.emit({ type: "message_update", message: { id: `old-${this.id}`, role: "assistant", content: [] } });
			this.emit({ type: "message_end", message: { id: `old-${this.id}`, role: "assistant", content: [] } });
			this.emit({ type: "tool_execution_start", toolName: "read" });
			this.emit({ type: "tool_execution_end", toolName: "read" });
			this.emit({ type: "agent_end" });
		}
		return { success: true };
	}

	async prompt(text: string): Promise<any> {
		this.promptTexts.push(text);
		const events = this.promptEvents ?? [
			{ type: "agent_start" },
			{ type: "message_end", message: { role: "user", content: text } },
			{ type: "message_update", message: { id: `new-${this.id}`, role: "assistant", content: [] } },
			{ type: "tool_execution_start", toolName: "read" },
			{ type: "tool_execution_end", toolName: "read" },
			{ type: "message_end", message: { id: `new-${this.id}`, role: "assistant", content: [] } },
			{ type: "agent_end" },
			{ type: "agent_settled" },
		];
		for (const event of events) this.emit(event);
		if (this.promptError) throw this.promptError;
		return this.promptResponse;
	}

	async promptWhenReady(text: string): Promise<any> { return this.prompt(text); }
}

const roots: string[] = [];
const managers: any[] = [];

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	registerRpcBridgeFactory(null);
	for (const manager of managers.splice(0)) {
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager.sessions?.clear?.();
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function makePersisted(root: string, id: string, lastActivity: number, lastReadAt: number): PersistedSession {
	const transcript = path.join(root, `${id}.jsonl`);
	fs.writeFileSync(transcript, `${JSON.stringify({ type: "session", id, cwd: root })}\n`, "utf8");
	return {
		id,
		title: `Ordinary ${id}`,
		cwd: root,
		agentSessionFile: transcript,
		createdAt: lastActivity - 1_000,
		lastActivity,
		lastReadAt,
		wasStreaming: false,
	};
}

function seedSettledKeylessPrompt(sessionId: string, text: string): void {
	appendPromptAuthorDispatch(sessionId, {
		promptId: "historical-keyless",
		dispatchedAt: 1,
		modelText: text,
		source: "user",
		author: { kind: "user", id: "user:local", label: "User" },
	});
	appendPromptAuthorSettlement(sessionId, {
		promptId: "historical-keyless",
		settledAt: 2,
		outcome: "echoed",
	});
}

function lateHistoricalPromptEvents(text: string, correlation: "keyed" | "keyless"): any[] {
	const identity = correlation === "keyed" ? { id: "late-historical-user" } : {};
	return [
		{ type: "message_update", message: { ...identity, role: "user", content: text } },
		{ type: "message_end", message: { ...identity, role: "user", content: text } },
	];
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function makeManager(
	store: SessionStore,
	bridges: Map<string, RestoreBridge>,
	now: () => number,
	restoredMessages: ReadonlyMap<string, any[]> = new Map(),
): any {
	const stateDir = (store as any).storeDir as string;
	// isolate:false workers retain author-sidecar module state across files. Give
	// this fixture the same keyed, durable prompt-attempt binding as production
	// instead of accidentally falling back to raw in-memory text correlation.
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "private-secrets"),
		hmacKey: Buffer.alloc(32, 0x41),
	});
	registerRpcBridgeFactory((options: RpcBridgeOptions) => {
		const id = options.env?.BOBBIT_SESSION_ID;
		if (!id) return null;
		const bridge = new RestoreBridge(id);
		bridge.messages = restoredMessages.get(id) ?? [];
		bridges.set(id, bridge);
		return bridge as any;
	});
	const manager: any = new SessionManager({
		projectContextManager: {} as any,
		stateDir,
		clock: {
			now,
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
		} as any,
	});
	manager._testStore = store;
	manager.projectContextManager = { all: () => [], getAllLiveSessions: () => store.getLive() };
	manager.getSessionStore = () => store;
	manager.resolveStoreForSession = () => store;
	manager.resolveStoreForId = () => store;
	manager.assemblePrompt = () => undefined;
	manager.applyScopedGatewayCredentials = () => {};
	manager.applyDirectProviderEnv = async () => {};
	manager.ensureMcpManagerForContext = async () => {};
	manager.buildToolActivationArgs = () => ({ args: [], runtimeExtensions: [], env: {} });
	manager.resolveCurrentCatalogSpawnModel = async () => "test/activity-model";
	manager.resolveCurrentCatalogThinkingLevel = async () => undefined;
	manager.resolveCurrentCatalogPreferredThinkingLevel = async () => undefined;
	manager.finalizeSpawnOptions = async () => {};
	manager.tryAutoSelectModel = async () => undefined;
	manager.tryApplyDefaultThinkingLevel = async () => undefined;
	manager.sessionSecretStore = { getOrCreateSecret: () => "activity-test-secret", remove: () => {} };
	managers.push(manager);
	return manager;
}

const LIFECYCLE_EVENTS = [
	{ type: "agent_start" },
	{ type: "agent_idle" },
	{ type: "connection_state", connected: true },
	{ type: "state", model: "test/activity-model", thinkingLevel: "medium" },
	{ type: "session_title", title: "restore-only" },
];

const REPLAY_VISIBLE_EVENTS = [
	{ type: "message_update", message: { id: "late-old", role: "assistant", content: [] } },
	{ type: "message_end", message: { id: "late-old", role: "assistant", content: [] } },
	{ type: "tool_execution_start", toolName: "read" },
	{ type: "tool_execution_end", toolName: "read" },
	{ type: "agent_end" },
];

const RESTORE_QUESTIONS = [
	{ question: "Restore this exact ask?", options: ["yes", "no"] },
];

function postedAskMessages(id: string, legacy = false): any[] {
	return [
		{
			id: `call-${id}`,
			role: "assistant",
			content: [legacy
				? { type: "tool_use", id, name: "ask_user_choices", input: { questions: RESTORE_QUESTIONS } }
				: { type: "toolCall", id, name: "ask_user_choices", arguments: { questions: RESTORE_QUESTIONS } }],
		},
		{
			id: `posted-${id}`,
			role: "toolResult",
			toolCallId: id,
			toolName: "ask_user_choices",
			content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: id }) }],
		},
	];
}

function answerEnvelope(id: string): string {
	return `[ask_user_choices_response tool_use_id=${id}]\n${JSON.stringify({
		answers: [{ question: RESTORE_QUESTIONS[0]!.question, selected: "yes", other_text: null }],
	})}`;
}

function failNextPrimaryRename(storeFile: string): any {
	let fail = true;
	const promises = new Proxy(fs.promises, {
		get(target, property) {
			if (property === "rename") {
				return async (from: fs.PathLike, to: fs.PathLike) => {
					if (fail && path.resolve(String(to)) === path.resolve(storeFile)) {
						fail = false;
						throw new Error("injected unanswered projection rename failure");
					}
					return target.rename(from, to);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return new Proxy(fs, {
		get(target, property) {
			if (property === "promises") return promises;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("restore repairs durable unanswered-question projections", () => {
	it("repairs stale false after a rejected live projection flush before publishing the restored session", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-ask-projection-restore-failure-"));
		roots.push(root);
		const stateDir = path.join(root, "state");
		const askId = "ask-restore-pending-exact";
		const baseline = new SessionStore(stateDir);
		const row = { ...makePersisted(root, "restore-stale-false-exact", 10_000, 11_000), hasUnansweredQuestion: false };
		baseline.put(row);
		await baseline.flushAsync();

		const failingStore = new SessionStore(
			stateDir,
			failNextPrimaryRename(path.join(stateDir, "sessions.json")),
		);
		const liveManager = makeManager(failingStore, new Map(), () => 12_000);
		liveManager.sessions.set(row.id, {
			id: row.id,
			rpcClient: { getMessages: async () => ({ success: true, data: { messages: postedAskMessages(askId) } }) },
			promptQueue: { toArray: () => [] },
			inFlightSteerTexts: [],
		});
		await expect(liveManager.recomputeHasUnansweredQuestion(row.id))
			.rejects.toThrow("injected unanswered projection rename failure");

		const restoreStore = new SessionStore(stateDir);
		expect(restoreStore.get(row.id)?.hasUnansweredQuestion).toBe(false);
		const bridges = new Map<string, RestoreBridge>();
		const restoreManager = makeManager(
			restoreStore,
			bridges,
			() => 13_000,
			new Map([[row.id, postedAskMessages(askId)]]),
		);
		const projectionPublicationStates: boolean[] = [];
		const update = restoreStore.update.bind(restoreStore);
		restoreStore.update = ((id: string, patch: any) => {
			if (id === row.id && "hasUnansweredQuestion" in patch) {
				projectionPublicationStates.push(restoreManager.sessions.has(row.id));
			}
			update(id, patch);
		}) as typeof restoreStore.update;

		await restoreManager.restoreSession(restoreStore.get(row.id)!);
		await restoreStore.flushAsync();

		expect(projectionPublicationStates).toEqual([false]);
		expect(restoreStore.get(row.id)?.hasUnansweredQuestion).toBe(true);
		expect(new SessionStore(stateDir).get(row.id)?.hasUnansweredQuestion).toBe(true);
		expect(restoreManager.listSessions().find((session: any) => session.id === row.id)?.hasUnansweredQuestion).toBe(true);
		expect(bridges.get(row.id)?.promptTexts).toEqual([]);
		expect(bridges.get(row.id)?.steerCalls).toBe(0);
	});

	it.each([
		{
			label: "canonical answer envelope",
			rowId: "restore-stale-true-answered-exact",
			askId: "ask-restore-answered-exact",
			messages: (id: string) => [...postedAskMessages(id), { id: `answer-${id}`, role: "user", content: answerEnvelope(id) }],
			dismissedAskToolUseIds: undefined,
		},
		{
			label: "durable whole-card dismissal with a legacy imported call",
			rowId: "restore-stale-true-dismissed-exact",
			askId: "ask-restore-dismissed-exact",
			messages: (id: string) => postedAskMessages(id, true),
			dismissedAskToolUseIds: ["ask-restore-dismissed-exact"],
		},
		{
			label: "accepted queued answer not yet echoed to the cloned transcript",
			rowId: "restore-stale-true-queued-exact",
			askId: "ask-restore-queued-exact",
			messages: (id: string) => postedAskMessages(id, true),
			dismissedAskToolUseIds: undefined,
			messageQueue: [{
				id: "queued-restore-answer-exact",
				text: answerEnvelope("ask-restore-queued-exact"),
				isSteered: false,
				createdAt: 19_999,
			}],
		},
	] as const)("repairs stale true from $label without dispatch", async (fixture) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-ask-projection-restore-terminal-"));
		roots.push(root);
		const stateDir = path.join(root, "state");
		const store = new SessionStore(stateDir);
		const messageQueue = "messageQueue" in fixture ? fixture.messageQueue : undefined;
		const row = {
			...makePersisted(root, fixture.rowId, 20_000, 21_000),
			hasUnansweredQuestion: true,
			...(fixture.dismissedAskToolUseIds ? { dismissedAskToolUseIds: [...fixture.dismissedAskToolUseIds] } : {}),
			...(messageQueue ? { messageQueue: [...messageQueue] } : {}),
		};
		store.put(row);
		await store.flushAsync();
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(
			store,
			bridges,
			() => 22_000,
			new Map([[row.id, fixture.messages(fixture.askId)]]),
		);

		await manager.restoreSession(row);
		await store.flushAsync();

		expect(store.get(row.id)?.hasUnansweredQuestion).toBe(false);
		expect(manager.listSessions().find((session: any) => session.id === row.id)?.hasUnansweredQuestion).toBe(false);
		expect(bridges.get(row.id)?.promptTexts).toEqual([]);
		expect(bridges.get(row.id)?.steerCalls).toBe(0);
		expect(store.get(row.id)?.dismissedAskToolUseIds).toEqual(fixture.dismissedAskToolUseIds);
	});

	it("projects a legacy cloned row with no boolean while preserving its exact ask ID", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-ask-projection-restore-legacy-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const askId = "ask-restore-legacy-clone-exact";
		const row = makePersisted(root, "restore-legacy-clone-exact", 30_000, 31_000);
		store.put(row);
		await store.flushAsync();
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(
			store,
			bridges,
			() => 32_000,
			new Map([[row.id, postedAskMessages(askId, true)]]),
		);

		await manager.restoreSession(row);
		await store.flushAsync();

		expect(store.get(row.id)?.hasUnansweredQuestion).toBe(true);
		expect(JSON.stringify(bridges.get(row.id)?.messages)).toContain(askId);
		expect(bridges.get(row.id)?.promptTexts).toEqual([]);
		expect(bridges.get(row.id)?.steerCalls).toBe(0);
	});
});

describe("authoritative session activity attribution", () => {
	it("classifies meaningful work but excludes restore/lifecycle, user projections, and retry frames", () => {
		for (const event of LIFECYCLE_EVENTS) expect(isUserVisibleActivity(event)).toBe(false);
		for (const event of REPLAY_VISIBLE_EVENTS) expect(isUserVisibleActivity(event)).toBe(true);
		for (const type of ["message_update", "message_end"]) {
			expect(isUserVisibleActivity({ type, message: { role: "user" } })).toBe(false);
			expect(isUserVisibleActivity({ type, message: { role: "user-with-attachments" } })).toBe(false);
		}
		expect(isUserVisibleActivity({ type: "agent_end", willRetry: true })).toBe(false);
		expect(isUserVisibleActivity(undefined)).toBe(false);
	});

	it("keeps begin and cancel side-effect free, then ignores stale late commits", () => {
		const session = { id: "boundary-cancel", lastActivity: 10_000 };
		const persisted = { lastActivity: 10_000, lastReadAt: 11_000 };
		const writes: number[] = [];
		installSessionActivityAttribution(session, {
			get: () => persisted,
			update: (_id, patch) => {
				persisted.lastActivity = patch.lastActivity;
				writes.push(patch.lastActivity);
			},
		}, { now: () => 20_000, suppressUntilPrompt: true });

		const boundary = beginSessionPromptActivity(session, "prompt:cancelled")!;
		expect(session.lastActivity).toBe(10_000);
		expect(cancelSessionPromptActivity(session, boundary)).toBe(true);
		expect(commitSessionPromptActivity(session, boundary)).toBe(false);
		expect(recordSessionEventActivity(session, REPLAY_VISIBLE_EVENTS[0])).toBe(false);
		expect(session.lastActivity).toBe(10_000);
		expect(persisted).toEqual({ lastActivity: 10_000, lastReadAt: 11_000 });
		expect(writes).toEqual([]);
	});

	it("commits concurrent exact tokens independently and monotonically once", () => {
		const session = { id: "boundary-concurrent", lastActivity: 12_000 };
		const persisted = { lastActivity: 12_000, lastReadAt: 12_000 };
		const writes: number[] = [];
		installSessionActivityAttribution(session, {
			get: () => persisted,
			update: (_id, patch) => {
				persisted.lastActivity = patch.lastActivity;
				writes.push(patch.lastActivity);
			},
		}, { now: () => 12_000, suppressUntilPrompt: true });

		const rejected = beginSessionPromptActivity(session, "prompt:rejected")!;
		const accepted = beginSessionPromptActivity(session, "prompt:accepted")!;
		expect(cancelSessionPromptActivity(session, rejected)).toBe(true);
		expect(commitSessionPromptActivity(session, accepted)).toBe(true);
		expect(commitSessionPromptActivity(session, accepted)).toBe(true);
		expect(commitSessionPromptActivity(session, rejected)).toBe(false);
		expect(session.lastActivity).toBe(12_001);
		expect(persisted.lastActivity).toBe(12_001);
		expect(writes).toEqual([12_001]);
	});

	it("cancels all pending replacement transactions without changing quarantine", () => {
		const session = { id: "boundary-transaction-only-cancel", lastActivity: 13_000 };
		const writes: number[] = [];
		installSessionActivityAttribution(session, {
			get: () => ({ lastReadAt: 13_000 }),
			update: (_id, patch) => writes.push(patch.lastActivity),
		}, { now: () => 14_000 });
		const first = beginSessionPromptActivity(session, "first")!;
		const second = beginSessionPromptActivity(session, "second")!;

		cancelPendingSessionPromptActivity(session);

		expect(first.state).toBe("cancelled");
		expect(second.state).toBe("cancelled");
		expect(commitSessionPromptActivity(session, first)).toBe(false);
		expect(commitSessionPromptActivity(session, second)).toBe(false);
		expect(session.lastActivity).toBe(13_000);
		expect(writes).toEqual([]);
		// Transaction-only cancellation does not itself enter restore quarantine.
		expect(recordSessionEventActivity(session, REPLAY_VISIBLE_EVENTS[0])).toBe(true);
		expect(session.lastActivity).toBe(14_000);
		expect(writes).toEqual([14_000]);
	});

	it("invalidates pending tokens when replacement re-enters quarantine", () => {
		const session = { id: "boundary-replacement", lastActivity: 15_000 };
		const writes: number[] = [];
		installSessionActivityAttribution(session, {
			get: () => ({ lastReadAt: 16_000 }),
			update: (_id, patch) => writes.push(patch.lastActivity),
		}, { now: () => 16_000 });
		const oldBridgeBoundary = beginSessionPromptActivity(session, "durable-row")!;
		suppressSessionActivityUntilPrompt(session);
		const retryBoundary = beginSessionPromptActivity(session, "durable-row")!;

		expect(commitSessionPromptActivity(session, oldBridgeBoundary)).toBe(false);
		expect(commitSessionPromptActivity(session, retryBoundary)).toBe(true);
		expect(session.lastActivity).toBe(16_001);
		expect(writes).toEqual([16_001]);
	});

	it("does not acknowledge mark-read before its persistence barrier completes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mark-read-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "ordinary-read", 10_000, 11_000);
		store.put(row);
		const manager = makeManager(store, new Map(), () => 12_000);

		let release!: () => void;
		const durable = new Promise<void>((resolve) => { release = resolve; });
		const realFlush = store.flushAsync.bind(store);
		const flush = vi.spyOn(store, "flushAsync").mockImplementation(async () => {
			await durable;
			await realFlush();
		});
		let acknowledged = false;
		const pending = manager.markSessionRead(row.id).then((ok: boolean) => {
			acknowledged = true;
			return ok;
		});
		await Promise.resolve();
		expect(acknowledged).toBe(false);
		expect(store.get(row.id)?.lastReadAt).toBe(12_000);
		expect(store.get(row.id)?.lastActivity).toBe(10_000);
		release();
		expect(await pending).toBe(true);
		expect(flush).toHaveBeenCalledOnce();
		expect(new SessionStore(path.join(root, "state")).get(row.id)?.lastReadAt).toBe(12_000);
	});

	it("keeps restored activity quarantined when a direct prompt is rejected after unrelated events", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-rejected-direct-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "ordinary-rejected-direct", 10_000, 11_000);
		store.put(row);

		const activityWrites: number[] = [];
		const update = store.update.bind(store);
		store.update = ((id: string, patch: any) => {
			if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
			update(id, patch);
		}) as typeof store.update;

		let clock = 20_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		await manager.restoreSession(row);
		const session = manager.getSession(row.id)!;
		const bridge = bridges.get(row.id)!;
		bridge.promptEvents = [
			{ type: "agent_start" },
			{ type: "message_end", message: { id: "unrelated-assistant", role: "assistant", content: [] } },
			{ type: "tool_execution_start", toolName: "replayed-read" },
		];
		bridge.promptResponse = { success: false, error: "Anthropic API key is missing" };

		await expect(manager.enqueuePrompt(row.id, "rejected restored direct prompt"))
			.rejects.toThrow(/authentication failure|missing-api-key/i);
		bridge.emit(REPLAY_VISIBLE_EVENTS[0]);
		await store.flushAsync();

		expect(session.lastActivity).toBe(row.lastActivity);
		expect(store.get(row.id)?.lastActivity).toBe(row.lastActivity);
		expect(store.get(row.id)?.lastReadAt).toBe(row.lastReadAt);
		expect(activityWrites).toEqual([]);
	});

	it.each([
		{ correlation: "keyed", failure: "negative" },
		{ correlation: "keyed", failure: "throw" },
		{ correlation: "keyless", failure: "negative" },
		{ correlation: "keyless", failure: "throw" },
	] as const)(
		"fails closed when missing-sidecar $correlation replay precedes a direct $failure",
		async ({ correlation, failure }) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-activity-missing-direct-${correlation}-${failure}-`));
			roots.push(root);
			const store = new SessionStore(path.join(root, "state"));
			const row = makePersisted(root, `missing-direct-${correlation}-${failure}`, 10_000, 11_000);
			store.put(row);
			const activityWrites: number[] = [];
			const update = store.update.bind(store);
			store.update = ((id: string, patch: any) => {
				if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
				update(id, patch);
			}) as typeof store.update;

			let clock = 20_000;
			const bridges = new Map<string, RestoreBridge>();
			const manager = makeManager(store, bridges, () => ++clock);
			await manager.restoreSession(row);
			const session = manager.getSession(row.id)!;
			const bridge = bridges.get(row.id)!;
			const text = "historical bytes absent from sidecar";
			expect(readAuthorSidecar(row.id)).toEqual([]);
			expect(session.promptAuthorAmbiguityFences).toMatchObject({ bindings: [], overflowed: true });
			bridge.promptEvents = lateHistoricalPromptEvents(text, correlation);
			if (failure === "negative") bridge.promptResponse = { success: false, error: "Anthropic API key is missing" };
			else bridge.promptError = new Error("Anthropic API key is missing");
			const recover = vi.spyOn(manager, "recoverPromptDispatch");

			await expect(manager.enqueuePrompt(row.id, text)).rejects.toThrow(/authentication failure|missing-api-key/i);
			bridge.emit({ type: "message_end", message: { id: "later-assistant", role: "assistant", content: "old output" } });
			await store.flushAsync();

			expect(session.lastActivity).toBe(row.lastActivity);
			expect(store.get(row.id)?.lastActivity).toBe(row.lastActivity);
			expect(store.get(row.id)?.lastReadAt).toBe(row.lastReadAt);
			expect(activityWrites).toEqual([]);
			expect(recover).toHaveBeenCalledTimes(1);
			expect(session.promptQueue.toArray()).toMatchObject([{ text }]);
			expect(session.pendingPromptAuthors).toEqual([]);
			expect(readAuthorSidecar(row.id).filter((binding) => binding.settlement?.outcome === "cancelled"))
				.toHaveLength(1);
		},
	);

	it.each(["keyed", "keyless"] as const)(
		"lets a positive acknowledgement finalize missing-sidecar %s replay exactly once",
		async (correlation) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-activity-missing-positive-${correlation}-`));
			roots.push(root);
			const store = new SessionStore(path.join(root, "state"));
			const row = makePersisted(root, `missing-positive-${correlation}`, 12_000, 13_000);
			store.put(row);
			const activityWrites: number[] = [];
			const update = store.update.bind(store);
			store.update = ((id: string, patch: any) => {
				if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
				update(id, patch);
			}) as typeof store.update;

			let clock = 30_000;
			const bridges = new Map<string, RestoreBridge>();
			const manager = makeManager(store, bridges, () => ++clock);
			await manager.restoreSession(row);
			const session = manager.getSession(row.id)!;
			const bridge = bridges.get(row.id)!;
			const text = "missing-sidecar accepted bytes";
			bridge.promptEvents = lateHistoricalPromptEvents(text, correlation);
			bridge.promptResponse = { success: true };

			await expect(manager.enqueuePrompt(row.id, text)).resolves.toEqual({ status: "dispatched" });
			await store.flushAsync();

			expect(session.lastActivity).toBeGreaterThan(row.lastReadAt!);
			expect(store.get(row.id)?.lastActivity).toBe(session.lastActivity);
			expect(activityWrites).toHaveLength(1);
			expect(session.pendingPromptAuthors).toEqual([]);
			expect(readAuthorSidecar(row.id)).toHaveLength(1);
			expect(readAuthorSidecar(row.id)[0].settlement?.outcome).toBe("echoed");
		},
	);

	it("keeps a missing-sidecar queued prompt recoverable after keyed historical replay", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-missing-queued-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "missing-queued", 14_000, 15_000);
		store.put(row);
		const activityWrites: number[] = [];
		const update = store.update.bind(store);
		store.update = ((id: string, patch: any) => {
			if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
			update(id, patch);
		}) as typeof store.update;

		let clock = 40_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		await manager.restoreSession(row);
		const session = manager.getSession(row.id)!;
		const bridge = bridges.get(row.id)!;
		const text = "missing-sidecar queued bytes";
		session.status = "streaming";
		await expect(manager.enqueuePrompt(row.id, text)).resolves.toEqual({ status: "queued" });
		session.status = "idle";
		bridge.promptEvents = lateHistoricalPromptEvents(text, "keyed");
		bridge.promptResponse = { success: false, error: "Anthropic API key is missing" };
		const recover = vi.spyOn(manager, "recoverPromptDispatch");
		manager.drainQueue(session);
		await flushMicrotasks();
		bridge.emit({ type: "message_end", message: { id: "later-assistant", role: "assistant", content: "old output" } });
		await store.flushAsync();

		expect(session.lastActivity).toBe(row.lastActivity);
		expect(store.get(row.id)?.lastActivity).toBe(row.lastActivity);
		expect(store.get(row.id)?.lastReadAt).toBe(row.lastReadAt);
		expect(activityWrites).toEqual([]);
		expect(recover).toHaveBeenCalledTimes(1);
		expect(session.promptQueue.toArray()).toMatchObject([{ text }]);
		expect(session.pendingPromptAuthors).toEqual([]);
	});

	it("keeps a missing-sidecar steer recoverable after keyless historical replay and a throw", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-missing-steer-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "missing-steer", 16_000, 17_000);
		store.put(row);
		const activityWrites: number[] = [];
		const update = store.update.bind(store);
		store.update = ((id: string, patch: any) => {
			if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
			update(id, patch);
		}) as typeof store.update;

		let clock = 50_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		await manager.restoreSession(row);
		const session = manager.getSession(row.id)!;
		const bridge = bridges.get(row.id)!;
		const text = "missing-sidecar steer bytes";
		session.status = "streaming";
		bridge.steerEvents = lateHistoricalPromptEvents(text, "keyless");
		bridge.steerError = new Error("synthetic missing-sidecar steer throw");

		await expect(manager.deliverLiveSteer(row.id, text)).rejects.toThrow("synthetic missing-sidecar steer throw");
		bridge.emit({ type: "message_end", message: { id: "later-assistant", role: "assistant", content: "old output" } });
		await store.flushAsync();

		expect(session.lastActivity).toBe(row.lastActivity);
		expect(store.get(row.id)?.lastActivity).toBe(row.lastActivity);
		expect(store.get(row.id)?.lastReadAt).toBe(row.lastReadAt);
		expect(activityWrites).toEqual([]);
		expect(session.inFlightSteerTexts).toEqual([]);
		expect(session.promptQueue.toArray()).toMatchObject([{ text, isSteered: true }]);
		expect(session.pendingPromptAuthors).toEqual([]);
	});

	it.each([
		{ correlation: "keyed", failure: "negative" },
		{ correlation: "keyed", failure: "throw" },
		{ correlation: "keyless", failure: "negative" },
		{ correlation: "keyless", failure: "throw" },
	] as const)(
		"keeps a restored same-text attempt quarantined when late settled $correlation replay precedes a $failure acknowledgement",
		async ({ correlation, failure }) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-activity-settled-${correlation}-${failure}-`));
			roots.push(root);
			const store = new SessionStore(path.join(root, "state"));
			const row = makePersisted(root, `ordinary-settled-${correlation}-${failure}`, 10_000, 11_000);
			store.put(row);

			const activityWrites: number[] = [];
			const update = store.update.bind(store);
			store.update = ((id: string, patch: any) => {
				if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
				update(id, patch);
			}) as typeof store.update;

			let clock = 20_000;
			const bridges = new Map<string, RestoreBridge>();
			const manager = makeManager(store, bridges, () => ++clock);
			const text = "same settled keyless bytes";
			seedSettledKeylessPrompt(row.id, text);
			await manager.restoreSession(row);
			const session = manager.getSession(row.id)!;
			const bridge = bridges.get(row.id)!;
			expect(session.promptAuthorReplayBindings).toBeUndefined();
			expect(session.promptAuthorAmbiguityFences?.bindings.map((binding: any) => binding.promptId))
				.toContain("historical-keyless");
			bridge.promptEvents = lateHistoricalPromptEvents(text, correlation);
			if (failure === "negative") bridge.promptResponse = { success: false, error: "Anthropic API key is missing" };
			else bridge.promptError = new Error("Anthropic API key is missing");
			const recover = vi.spyOn(manager, "recoverPromptDispatch");

			await expect(manager.enqueuePrompt(row.id, text)).rejects.toThrow(/authentication failure|missing-api-key/i);
			bridge.emit({ type: "message_end", message: { id: "later-replay", role: "assistant", content: "old output" } });
			await store.flushAsync();

			expect(session.lastActivity).toBe(row.lastActivity);
			expect(store.get(row.id)?.lastActivity).toBe(row.lastActivity);
			expect(store.get(row.id)?.lastReadAt).toBe(row.lastReadAt);
			expect(activityWrites).toEqual([]);
			expect(recover).toHaveBeenCalledTimes(1);
			expect(readAuthorSidecar(row.id).filter((binding) => binding.settlement?.outcome === "cancelled"))
				.toHaveLength(1);
			expect(session.pendingPromptAuthors).toEqual([]);
		},
	);

	it.each(["keyed", "keyless"] as const)(
		"lets a positive acknowledgement finalize one buffered attempt after late settled %s replay",
		async (correlation) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-activity-settled-positive-${correlation}-`));
			roots.push(root);
			const store = new SessionStore(path.join(root, "state"));
			const row = makePersisted(root, `ordinary-settled-positive-${correlation}`, 12_000, 13_000);
			store.put(row);

			const activityWrites: number[] = [];
			const update = store.update.bind(store);
			store.update = ((id: string, patch: any) => {
				if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
				update(id, patch);
			}) as typeof store.update;

			let clock = 30_000;
			const bridges = new Map<string, RestoreBridge>();
			const manager = makeManager(store, bridges, () => ++clock);
			const text = "same settled positive bytes";
			seedSettledKeylessPrompt(row.id, text);
			await manager.restoreSession(row);
			const session = manager.getSession(row.id)!;
			const bridge = bridges.get(row.id)!;
			bridge.promptEvents = lateHistoricalPromptEvents(text, correlation);
			bridge.promptResponse = { success: true };

			await expect(manager.enqueuePrompt(row.id, text)).resolves.toEqual({ status: "dispatched" });
			await store.flushAsync();

			expect(session.lastActivity).toBeGreaterThan(row.lastReadAt!);
			expect(store.get(row.id)?.lastActivity).toBe(session.lastActivity);
			expect(activityWrites).toHaveLength(1);
			const currentSettlements = readAuthorSidecar(row.id)
				.filter((binding) => binding.promptId !== "historical-keyless")
				.map((binding) => binding.settlement?.outcome);
			expect(currentSettlements).toEqual(["echoed"]);
			expect(session.pendingPromptAuthors).toEqual([]);
		},
	);

	it.each([
		{ correlation: "keyed", failure: "negative" },
		{ correlation: "keyed", failure: "throw" },
		{ correlation: "keyless", failure: "negative" },
		{ correlation: "keyless", failure: "throw" },
	] as const)(
		"keeps an unambiguous restored $correlation steer update cancellable before a $failure acknowledgement",
		async ({ correlation, failure }) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-activity-update-steer-${correlation}-${failure}-`));
			roots.push(root);
			const store = new SessionStore(path.join(root, "state"));
			const row = makePersisted(root, `ordinary-update-steer-${correlation}-${failure}`, 10_000, 11_000);
			store.put(row);

			const activityWrites: number[] = [];
			const updateStore = store.update.bind(store);
			store.update = ((id: string, patch: any) => {
				if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
				updateStore(id, patch);
			}) as typeof store.update;

			let clock = 20_000;
			const bridges = new Map<string, RestoreBridge>();
			const manager = makeManager(store, bridges, () => ++clock);
			await manager.restoreSession(row);
			const session = manager.getSession(row.id)!;
			session.status = "streaming";
			const bridge = bridges.get(row.id)!;
			const text = "unambiguous rejected steer update";
			const identity = correlation === "keyed" ? { id: "current-steer-update" } : {};
			bridge.steerEvents = [
				{ type: "message_update", message: { ...identity, role: "user", content: text } },
			];
			if (failure === "negative") bridge.steerResponse = { success: false, error: "synthetic update rejection" };
			else bridge.steerError = new Error("synthetic update throw");

			await expect(manager.deliverLiveSteer(row.id, text))
				.rejects.toThrow(/synthetic update (rejection|throw)/);
			await store.flushAsync();

			expect(session.lastActivity).toBe(row.lastActivity);
			expect(store.get(row.id)?.lastActivity).toBe(row.lastActivity);
			expect(store.get(row.id)?.lastReadAt).toBe(row.lastReadAt);
			expect(activityWrites).toEqual([]);
			expect(session.inFlightSteerTexts).toEqual([]);
			expect(session.promptQueue.toArray()).toMatchObject([{ text, isSteered: true }]);
			expect(readAuthorSidecar(row.id).filter((binding) => binding.settlement?.outcome === "cancelled"))
				.toHaveLength(1);

			// The update's later terminal projection belongs to the cancelled attempt.
			// It must neither release quarantine nor consume the one recovered row.
			bridge.emit({ type: "message_end", message: { ...identity, role: "user", content: text } });
			bridge.emit({ type: "message_end", message: { id: "later-assistant", role: "assistant", content: "old output" } });
			await store.flushAsync();
			expect(session.lastActivity).toBe(row.lastActivity);
			expect(activityWrites).toEqual([]);
			expect(session.promptQueue.toArray()).toMatchObject([{ text, isSteered: true }]);
		},
	);

	it("keeps a same-text restored steer quarantined behind late settled replay", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-rejected-steer-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "ordinary-rejected-steer", 10_000, 11_000);
		const originalLastActivity = row.lastActivity;
		const originalLastReadAt = row.lastReadAt;
		store.put(row);

		const activityWrites: number[] = [];
		const update = store.update.bind(store);
		store.update = ((id: string, patch: any) => {
			if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
			update(id, patch);
		}) as typeof store.update;

		let clock = 20_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		const text = "rejected restored steer";
		seedSettledKeylessPrompt(row.id, text);
		await manager.restoreSession(row);
		const session = manager.getSession(row.id)!;
		session.status = "streaming";
		const bridge = bridges.get(row.id)!;
		bridge.steerEvents = lateHistoricalPromptEvents(text, "keyless");
		bridge.steerResponse = { success: false, error: "synthetic pre-observation rejection" };

		await expect(manager.deliverLiveSteer(row.id, text))
			.rejects.toThrow("synthetic pre-observation rejection");

		// Replay can arrive after the negative acknowledgement. A rejected dispatch
		// must leave restore quarantine closed, so these otherwise-visible frames are
		// still restore-only and cannot mutate either copy of the timestamp.
		for (const event of REPLAY_VISIBLE_EVENTS.filter((candidate) => candidate.type !== "agent_end")) {
			bridge.emit(event);
		}
		await store.flushAsync();

		expect(
			session.lastActivity,
			"REJECTED_DISPATCH_MUTATED_LAST_ACTIVITY: in-memory activity changed before origin observation",
		).toBe(originalLastActivity);
		expect(
			store.get(row.id)?.lastActivity,
			"REJECTED_DISPATCH_MUTATED_LAST_ACTIVITY: persisted activity changed before origin observation",
		).toBe(originalLastActivity);
		expect(new SessionStore(path.join(root, "state")).get(row.id)?.lastActivity).toBe(originalLastActivity);
		expect(store.get(row.id)?.lastReadAt).toBe(originalLastReadAt);
		expect(activityWrites).toEqual([]);
	});

	it("accepts an exact user echo before a negative steer acknowledgement exactly once", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-echoed-steer-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "ordinary-echoed-steer", 10_000, 11_000);
		store.put(row);

		const activityWrites: number[] = [];
		const update = store.update.bind(store);
		store.update = ((id: string, patch: any) => {
			if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
			update(id, patch);
		}) as typeof store.update;

		let clock = 20_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		// Exercise the existing non-empty compatibility path. The reader exposes no
		// completeness metadata for partially readable files, so only its explicit
		// zero-row result enters the new fail-closed restore mode.
		seedSettledKeylessPrompt(row.id, "unrelated historical prompt");
		await manager.restoreSession(row);
		const session = manager.getSession(row.id)!;
		session.status = "streaming";
		const bridge = bridges.get(row.id)!;
		bridge.steerEvents = [
			{ type: "agent_start" },
			{ type: "message_end", message: { id: "accepted-steer", role: "user", content: "echoed restored steer" } },
		];
		bridge.steerResponse = { success: false, error: "late synthetic rejection" };

		await expect(manager.deliverLiveSteer(row.id, "echoed restored steer")).resolves.toBeUndefined();
		await store.flushAsync();

		expect(session.lastActivity).toBeGreaterThan(row.lastReadAt!);
		expect(store.get(row.id)?.lastActivity).toBe(session.lastActivity);
		expect(activityWrites.length).toBeGreaterThanOrEqual(1);
		expect(session.inFlightSteerTexts).toEqual([]);
		expect(session.promptQueue.toArray()).toEqual([]);
		expect(readAuthorSidecar(row.id).at(-1)?.settlement).toMatchObject({
			outcome: "echoed",
			messageId: "accepted-steer",
		});
	});

	it("accepts an exact user echo before a throwing steer acknowledgement", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-echoed-throw-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "ordinary-echoed-throw", 10_000, 11_000);
		store.put(row);

		let clock = 20_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		seedSettledKeylessPrompt(row.id, "unrelated historical prompt");
		await manager.restoreSession(row);
		const session = manager.getSession(row.id)!;
		session.status = "streaming";
		const bridge = bridges.get(row.id)!;
		bridge.steerEvents = [
			{ type: "message_end", message: { id: "accepted-throw", role: "user", content: "echoed before throw" } },
		];
		bridge.steerError = new Error("late transport failure");

		await expect(manager.deliverLiveSteer(row.id, "echoed before throw")).resolves.toBeUndefined();
		expect(session.lastActivity).toBeGreaterThan(row.lastReadAt!);
		expect(session.inFlightSteerTexts).toEqual([]);
		expect(session.promptQueue.toArray()).toEqual([]);
		expect(readAuthorSidecar(row.id).at(-1)?.settlement).toMatchObject({
			outcome: "echoed",
			messageId: "accepted-throw",
		});
	});

	it("makes a deferred old direct-prompt acknowledgement inert before object respawn", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-stale-respawn-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "ordinary-stale-respawn", 10_000, 11_000);
		const originalLastActivity = row.lastActivity;
		const originalLastReadAt = row.lastReadAt;
		store.put(row);

		const activityWrites: number[] = [];
		const update = store.update.bind(store);
		store.update = ((id: string, patch: any) => {
			if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
			update(id, patch);
		}) as typeof store.update;

		let clock = 20_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		await manager.restoreSession(row);
		const oldSession = manager.getSession(row.id)!;
		const oldBridge = bridges.get(row.id)!;
		let promptEntered!: () => void;
		let resolveOldAck!: () => void;
		const entered = new Promise<void>((resolve) => { promptEntered = resolve; });
		const oldAck = new Promise<void>((resolve) => { resolveOldAck = resolve; });
		oldBridge.prompt = vi.fn(async () => {
			promptEntered();
			await oldAck;
			return { success: true };
		});

		const dispatch = manager.enqueuePrompt(row.id, "old bridge deferred direct prompt");
		await entered;
		// Isolate replacement replay from the separately covered boot-continuation
		// activity boundary; this restart has no accepted replacement-side prompt.
		store.update(row.id, { wasStreaming: false });
		await manager.restartAgent(row.id);
		const replacement = manager.getSession(row.id)!;
		const replacementBridge = bridges.get(row.id)!;
		expect(replacement).not.toBe(oldSession);
		expect(replacementBridge).not.toBe(oldBridge);

		resolveOldAck();
		await expect(dispatch).resolves.toEqual({ status: "dispatched" });
		for (const event of REPLAY_VISIBLE_EVENTS) replacementBridge.emit(event);
		await store.flushAsync();

		expect(oldSession.lastActivity).toBe(originalLastActivity);
		expect(replacement.lastActivity).toBe(originalLastActivity);
		expect(store.get(row.id)?.lastActivity).toBe(originalLastActivity);
		expect(store.get(row.id)?.lastReadAt).toBe(originalLastReadAt);
		expect(activityWrites).toEqual([]);
		expect(replacement.promptQueue.toArray()).toEqual([]);
	});

	it("makes a deferred old prompt acknowledgement inert before same-object hard abort", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-stale-abort-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const row = makePersisted(root, "ordinary-stale-abort", 12_000, 13_000);
		const originalLastActivity = row.lastActivity;
		const originalLastReadAt = row.lastReadAt;
		store.put(row);

		const activityWrites: number[] = [];
		const update = store.update.bind(store);
		store.update = ((id: string, patch: any) => {
			if (id === row.id && "lastActivity" in patch) activityWrites.push(patch.lastActivity);
			update(id, patch);
		}) as typeof store.update;

		let clock = 30_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		await manager.restoreSession(row);
		const session = manager.getSession(row.id)!;
		const oldBridge = bridges.get(row.id)!;
		let promptEntered!: () => void;
		let resolveOldAck!: () => void;
		let stopEntered!: () => void;
		let releaseStop!: () => void;
		const entered = new Promise<void>((resolve) => { promptEntered = resolve; });
		const oldAck = new Promise<void>((resolve) => { resolveOldAck = resolve; });
		const stopping = new Promise<void>((resolve) => { stopEntered = resolve; });
		const stopped = new Promise<void>((resolve) => { releaseStop = resolve; });
		oldBridge.prompt = vi.fn(async () => {
			promptEntered();
			await oldAck;
			return { success: true };
		});
		oldBridge.abort = vi.fn(() => new Promise(() => {}));
		oldBridge.getState = vi.fn(async () => ({ success: true, data: { sessionFile: row.agentSessionFile } }));
		oldBridge.stop = vi.fn(async () => {
			stopEntered();
			await stopped;
			oldBridge.running = false;
		});

		const dispatch = manager.enqueuePrompt(row.id, "old bridge deferred abort prompt");
		await entered;
		const abort = manager.forceAbort(row.id, 1);
		await stopping;

		resolveOldAck();
		await expect(dispatch).resolves.toEqual({ status: "dispatched" });
		releaseStop();
		await abort;
		const replacementBridge = bridges.get(row.id)!;
		expect(manager.getSession(row.id)).toBe(session);
		expect(replacementBridge).not.toBe(oldBridge);
		for (const event of REPLAY_VISIBLE_EVENTS) replacementBridge.emit(event);
		await store.flushAsync();

		expect(session.lastActivity).toBe(originalLastActivity);
		expect(store.get(row.id)?.lastActivity).toBe(originalLastActivity);
		expect(store.get(row.id)?.lastReadAt).toBe(originalLastReadAt);
		expect(activityWrites).toEqual([]);
		expect(session.promptQueue.toArray()).toEqual([]);
	});

	it("drives the real concurrent restore handler without clustering either timestamp", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-activity-restore-"));
		roots.push(root);
		const store = new SessionStore(path.join(root, "state"));
		const base = 1_720_000_000_000;
		const rows = [
			makePersisted(root, "ordinary-a", base - 60_000, base + 1_000),
			makePersisted(root, "ordinary-b", base - 3_600_000, base + 2_000),
			makePersisted(root, "ordinary-c", base - 86_400_000, base + 3_000),
			makePersisted(root, "ordinary-d", base - 604_800_000, base + 4_000),
		];
		for (const row of rows) store.put(row);

		const transitions: Array<{ id: string; patch: Record<string, unknown> }> = [];
		const update = store.update.bind(store);
		store.update = ((id: string, patch: any) => {
			transitions.push({ id, patch: { ...patch } });
			update(id, patch);
		}) as typeof store.update;

		let clock = base + 10_000_000;
		const bridges = new Map<string, RestoreBridge>();
		const manager = makeManager(store, bridges, () => ++clock);
		await Promise.all(rows.map((row) => manager.restoreSession(row)));

		// Simulate restore-generated frames on the other side of the
		// switch_session response. Even user-visible replay event types stay in the
		// origin quarantine because no new prompt has been dispatched.
		for (const bridge of bridges.values()) {
			for (const event of [...LIFECYCLE_EVENTS, ...REPLAY_VISIBLE_EVENTS]) bridge.emit(event);
			bridge.emit({ type: "agent_settled" });
		}
		await store.flushAsync();

		for (const row of rows) {
			const restored = store.get(row.id)!;
			expect(restored.lastActivity).toBe(row.lastActivity);
			expect(restored.lastReadAt).toBe(row.lastReadAt);
			expect(manager.getSession(row.id)?.lastActivity).toBe(row.lastActivity);
		}
		expect(new Set(rows.map((row) => store.get(row.id)!.lastActivity)).size).toBe(rows.length);
		expect(transitions.filter(({ patch }) => "lastActivity" in patch)).toEqual([]);
		expect(transitions.filter(({ patch }) => "lastReadAt" in patch)).toEqual([]);

		const target = rows[1];
		await expect(manager.enqueuePrompt(target.id, "genuine post-restore prompt"))
			.resolves.toEqual({ status: "dispatched" });
		await store.flushAsync();
		const after = store.get(target.id)!;
		expect(after.lastActivity).toBeGreaterThan(after.lastReadAt!);
		expect(rows.filter((row) => row.id !== target.id).map((row) => store.get(row.id)!.lastActivity))
			.toEqual(rows.filter((row) => row.id !== target.id).map((row) => row.lastActivity));
		const targetActivityWrites = transitions.filter(({ id, patch }) => id === target.id && "lastActivity" in patch);
		expect(targetActivityWrites.length).toBeGreaterThanOrEqual(1);
		expect(transitions.filter(({ patch }) => "lastReadAt" in patch)).toEqual([]);
	});
});
