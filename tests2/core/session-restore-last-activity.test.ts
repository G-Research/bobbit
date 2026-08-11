import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import {
	isUserVisibleActivity,
} from "../../src/server/agent/session-activity.ts";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.ts";
import { registerRpcBridgeFactory, type RpcBridgeOptions } from "../../src/server/agent/rpc-bridge.ts";

class RestoreBridge {
	listener?: (event: any) => void;
	running = true;

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
	async steer(): Promise<any> { return { success: true }; }
	async compact(): Promise<any> { return { success: true }; }
	async getMessages(): Promise<any> { return { success: true, data: { messages: [] } }; }
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
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_end", message: { role: "user", content: text } });
		this.emit({ type: "message_update", message: { id: `new-${this.id}`, role: "assistant", content: [] } });
		this.emit({ type: "tool_execution_start", toolName: "read" });
		this.emit({ type: "tool_execution_end", toolName: "read" });
		this.emit({ type: "message_end", message: { id: `new-${this.id}`, role: "assistant", content: [] } });
		this.emit({ type: "agent_end" });
		return { success: true };
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

function makeManager(store: SessionStore, bridges: Map<string, RestoreBridge>, now: () => number): any {
	registerRpcBridgeFactory((options: RpcBridgeOptions) => {
		const id = options.env?.BOBBIT_SESSION_ID;
		if (!id) return null;
		const bridge = new RestoreBridge(id);
		bridges.set(id, bridge);
		return bridge as any;
	});
	const manager: any = new SessionManager({
		projectContextManager: {} as any,
		stateDir: path.dirname((store as any).storePath ?? ""),
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

describe("authoritative session activity attribution", () => {
	it("classifies meaningful work but excludes restore/lifecycle and retry frames", () => {
		for (const event of LIFECYCLE_EVENTS) expect(isUserVisibleActivity(event)).toBe(false);
		for (const event of REPLAY_VISIBLE_EVENTS) expect(isUserVisibleActivity(event)).toBe(true);
		expect(isUserVisibleActivity({ type: "agent_end", willRetry: true })).toBe(false);
		expect(isUserVisibleActivity(undefined)).toBe(false);
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
		await manager.enqueuePrompt(target.id, "genuine post-restore prompt");
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
