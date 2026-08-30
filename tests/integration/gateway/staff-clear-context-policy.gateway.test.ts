// v2-native — Clear-policy inbox wake integration across staff and session owners.

import { guardProcessEnv } from "../../../tests2/core/helpers/env-guard.js";
guardProcessEnv();

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { makeTmpDir } from "../../helpers/tmp.ts";

const tmpRoot = makeTmpDir("staff-clear-context-policy-");
const stateDir = path.join(tmpRoot, "state");
const sessionStateDir = path.join(stateDir, "sessions-store");
const agentDir = path.join(tmpRoot, "agent");
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;
process.env.BOBBIT_TEST_NO_REMOTE = "1";
process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
fs.mkdirSync(sessionStateDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });

const { resetAgentDirStateForTests } = await import("../../../src/server/bobbit-dir.ts");
resetAgentDirStateForTests?.();
const { SessionManager } = await import("../../../src/server/agent/session-manager.ts");
const { SessionStore } = await import("../../../src/server/agent/session-store.ts");
const { StaffStore } = await import("../../../src/server/agent/staff-store.ts");
const { InboxStore } = await import("../../../src/server/agent/inbox-store.ts");
const { InboxNudger } = await import("../../../src/server/agent/inbox-nudger.ts");
const { EventBuffer } = await import("../../../src/server/agent/event-buffer.ts");
const { PromptQueue } = await import("../../../src/server/agent/prompt-queue.ts");
const { initAuthorSidecarDir } = await import("../../../src/server/agent/author-sidecar.ts");
const { initCompactionSidecarDir } = await import("../../../src/server/agent/compaction-sidecar.ts");
const { activeAgentSessionsDir } = await import("../../../src/server/agent/agent-session-path.ts");

const STAFF_ID = "staff-clear-integration";
const SESSION_ID = "staff-clear-session";
const PROJECT_ID = "staff-clear-project";
const PROVIDER = "anthropic";
const MODEL_ID = "claude-staff-clear-fixture";
const THINKING = "high";
const SYSTEM_PROMPT = "PINNED_STAFF_SYSTEM_PROMPT";
const DIGEST = "[INBOX] You have 1 pending item. Use inbox_list to inspect, then process each with inbox_complete or inbox_dismiss.";
const OLD_MARKERS = [
	"SECRET_PRIOR_USER",
	"SECRET_PRIOR_ASSISTANT",
	"SECRET_PRIOR_TOOL_INPUT",
	"SECRET_PRIOR_TOOL_RESULT",
	"SECRET_PRIOR_COMPACTION_SUMMARY",
];

const managers: any[] = [];

function generationPath(name: string): string {
	const dir = path.join(activeAgentSessionsDir(), "--staff-clear-context-policy--");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${name}.jsonl`);
}

function priorEntries(): any[] {
	return [
		{
			type: "message", id: "prior-user", parentId: null,
			message: { role: "user", content: [{ type: "text", text: OLD_MARKERS[0] }], timestamp: 1_700_000_000_001 },
		},
		{
			type: "message", id: "prior-assistant", parentId: "prior-user",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: OLD_MARKERS[1] },
					{ type: "toolCall", id: "prior-tool-call", name: "read", arguments: { path: OLD_MARKERS[2] } },
				],
				provider: PROVIDER, model: MODEL_ID, stopReason: "toolUse", timestamp: 1_700_000_000_002,
			},
		},
		{
			type: "message", id: "prior-tool-result", parentId: "prior-assistant",
			message: {
				role: "toolResult", toolCallId: "prior-tool-call", toolName: "read",
				content: [{ type: "text", text: OLD_MARKERS[3] }], isError: false, timestamp: 1_700_000_000_003,
			},
		},
		{
			type: "message", id: "prior-compaction-summary", parentId: "prior-tool-result",
			message: {
				role: "assistant", content: [{ type: "text", text: OLD_MARKERS[4] }],
				provider: PROVIDER, model: MODEL_ID, stopReason: "stop", timestamp: 1_700_000_000_004,
			},
		},
	];
}

function makeGenerationBridge(oldPath: string, newPath: string): any {
	let generation = 0;
	let model = { provider: PROVIDER, id: MODEL_ID };
	let thinkingLevel = THINKING;
	const listeners = new Set<(event: any) => void>();
	const modelMessages: any[][] = [priorEntries().map((entry) => entry.message), []];
	const transcriptEntries: any[][] = [priorEntries(), []];
	const providerRequests: Array<{ systemPrompt: string; messages: any[] }> = [];
	const prompt = vi.fn(async (text: string) => {
		const message = { role: "user", content: [{ type: "text", text }] };
		providerRequests.push({ systemPrompt: SYSTEM_PROMPT, messages: [...modelMessages[generation], message] });
		modelMessages[generation].push(message);
		transcriptEntries[generation].push({ type: "message", id: `generation-${generation}-prompt-1`, parentId: null, message });
		return { success: true };
	});
	return {
		running: true,
		providerRequests,
		prompt,
		promptWhenReady: prompt,
		steer: vi.fn(async () => ({ success: true })),
		abort: vi.fn(async () => ({ success: true })),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		waitForReady: vi.fn(async () => {}),
		getMessages: vi.fn(async () => ({ success: true, data: { messages: modelMessages[generation] } })),
		getTranscriptEntries: vi.fn(async () => ({
			success: true,
			data: { entries: transcriptEntries[generation], leafId: transcriptEntries[generation].at(-1)?.id ?? null },
		})),
		getTranscriptCursorSnapshot: vi.fn(async () => ({ success: true, data: { forkMessages: [], entries: [], leafId: null } })),
		getState: vi.fn(async () => ({
			success: true,
			data: {
				sessionFile: generation === 0 ? oldPath : newPath,
				model,
				thinkingLevel,
				messageCount: modelMessages[generation].length,
				pendingMessageCount: 0,
			},
		})),
		setModel: vi.fn(async (provider: string, id: string) => { model = { provider, id }; return { success: true }; }),
		setThinkingLevel: vi.fn(async (level: string) => { thinkingLevel = level; return { success: true }; }),
		newSession: vi.fn(async () => {
			generation = 1;
			return { type: "response", command: "new_session", success: true, data: { cancelled: false } };
		}),
		compact: vi.fn(async () => ({ success: true })),
		sendCommand: vi.fn(async (command: any) => {
			if (command?.type === "switch_session") generation = 0;
			return { success: true };
		}),
		onEvent(listener: (event: any) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event: any) { for (const listener of listeners) listener(event); },
		get generation() { return generation; },
		get activeModelMessages() { return modelMessages[generation]; },
	};
}

function staffRecord(): any {
	return {
		id: STAFF_ID,
		name: "Clear Worker",
		description: "Clear wake integration fixture",
		systemPrompt: SYSTEM_PROMPT,
		cwd: tmpRoot,
		state: "active",
		triggers: [],
		memory: "PINNED_STAFF_MEMORY",
		roleId: "tester",
		accessory: "flask",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		currentSessionId: SESSION_ID,
		worktreePath: path.join(tmpRoot, "staff-worktree"),
		branch: "staff/clear-worker",
		projectId: PROJECT_ID,
		sandboxed: false,
		contextPolicy: "clear",
	};
}

beforeAll(() => {
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "secrets"),
		hmacKey: Buffer.alloc(32, 0x53),
	});
	initCompactionSidecarDir(stateDir);
});

afterEach(() => {
	while (managers.length > 0) {
		const manager = managers.pop();
		manager.sessionsWithConnectedClients?.clear?.();
		manager.sessions?.clear?.();
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
	}
	vi.restoreAllMocks();
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("staff Clear context policy", () => {
	test("makes the wake digest the first replacement prompt while preserving identity, config, and display-only history across reload", async () => {
		const oldPath = generationPath("prior-generation");
		const newPath = generationPath("wake-generation");
		fs.writeFileSync(oldPath, `${priorEntries().map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

		const staffStore = new StaffStore(stateDir);
		staffStore.put(staffRecord());

		const sessionStore = new SessionStore(sessionStateDir);
		sessionStore.put({
			id: SESSION_ID,
			title: "Clear Worker session",
			cwd: tmpRoot,
			worktreePath: path.join(tmpRoot, "staff-worktree"),
			branch: "staff/clear-worker",
			agentSessionFile: oldPath,
			projectId: PROJECT_ID,
			staffId: STAFF_ID,
			role: "tester",
			allowedTools: ["inbox", "read"],
			createdAt: 1_700_000_000_000,
			lastActivity: 1_700_000_000_000,
			modelProvider: PROVIDER,
			modelId: MODEL_ID,
			effectiveThinkingLevel: THINKING,
			sandboxed: false,
		});
		await sessionStore.flushAsync();

		const manager: any = new SessionManager({ stateDir, projectContextManager: {} as any });
		if (manager._statusHeartbeatTimer) {
			clearInterval(manager._statusHeartbeatTimer);
			manager._statusHeartbeatTimer = null;
		}
		manager.projectContextManager = null;
		manager.getSessionStore = () => sessionStore;
		manager.resolveStoreForSession = () => sessionStore;
		manager.resolveStoreForId = () => sessionStore;
		manager.readCompactionTranscriptEntries = vi.fn(async () => undefined);
		manager.finalizeCompactionSidecar = vi.fn(async () => undefined);
		manager.assemblePrompt = vi.fn(() => undefined);
		managers.push(manager);

		const bridge = makeGenerationBridge(oldPath, newPath);
		const liveSession: any = {
			id: SESSION_ID,
			title: "Clear Worker session",
			titleGenerated: true,
			cwd: tmpRoot,
			worktreePath: path.join(tmpRoot, "staff-worktree"),
			branch: "staff/clear-worker",
			status: "idle",
			statusVersion: 0,
			createdAt: 1_700_000_000_000,
			lastActivity: 1_700_000_000_000,
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			inFlightSteerTexts: [],
			isCompacting: false,
			setupComplete: true,
			projectId: PROJECT_ID,
			staffId: STAFF_ID,
			role: "tester",
			allowedTools: ["inbox", "read"],
			sandboxed: false,
			spawnPinnedModel: `${PROVIDER}/${MODEL_ID}`,
			spawnPinnedThinkingLevel: THINKING,
			unsubscribe: vi.fn(),
			rpcClient: bridge,
		};
		manager.sessions.set(SESSION_ID, liveSession);
		const originalSessionIdentity = manager.getSession(SESSION_ID);
		const originalConfig = {
			id: liveSession.id,
			staffId: liveSession.staffId,
			cwd: liveSession.cwd,
			worktreePath: liveSession.worktreePath,
			branch: liveSession.branch,
			projectId: liveSession.projectId,
			role: liveSession.role,
			allowedTools: [...liveSession.allowedTools],
			sandboxed: liveSession.sandboxed,
			spawnPinnedModel: liveSession.spawnPinnedModel,
			spawnPinnedThinkingLevel: liveSession.spawnPinnedThinkingLevel,
		};

		const staffManager = {
			listStaff: () => staffStore.getAll(),
			getStaff: (id: string) => staffStore.get(id),
			updateStaff: (id: string, patch: Record<string, unknown>) => {
				staffStore.update(id, patch as any);
				return staffStore.get(id);
			},
		};
		const inboxStore = new InboxStore(stateDir);
		inboxStore.put({
			id: "clear-wake-entry",
			staffId: STAFF_ID,
			source: { type: "trigger", triggerId: "clear-wake-trigger" },
			title: "Clear wake",
			prompt: "Process the clear wake",
			state: "pending",
			createdAt: 1_700_000_010_000,
		});
		const nudger = new InboxNudger({ sessionManager: manager, staffManager: staffManager as any, inboxStore });

		nudger.poke(STAFF_ID);
		await vi.waitFor(() => expect(bridge.providerRequests).toHaveLength(1));

		expect(bridge.generation, "CLEAR_WAKE_REUSED_PRIOR_MODEL_GENERATION").toBe(1);
		expect(bridge.providerRequests[0].systemPrompt).toBe(SYSTEM_PROMPT);
		expect(bridge.providerRequests[0].messages).toHaveLength(1);
		expect(JSON.stringify(bridge.providerRequests[0].messages[0])).toContain(DIGEST);
		const replacementModelJson = JSON.stringify(bridge.providerRequests[0].messages);
		for (const marker of OLD_MARKERS) expect(replacementModelJson).not.toContain(marker);
		expect(bridge.compact).not.toHaveBeenCalled();

		expect(manager.getSession(SESSION_ID)).toBe(originalSessionIdentity);
		expect({
			id: liveSession.id,
			staffId: liveSession.staffId,
			cwd: liveSession.cwd,
			worktreePath: liveSession.worktreePath,
			branch: liveSession.branch,
			projectId: liveSession.projectId,
			role: liveSession.role,
			allowedTools: liveSession.allowedTools,
			sandboxed: liveSession.sandboxed,
			spawnPinnedModel: liveSession.spawnPinnedModel,
			spawnPinnedThinkingLevel: liveSession.spawnPinnedThinkingLevel,
		}).toEqual(originalConfig);
		expect(staffStore.get(STAFF_ID)).toMatchObject({
			id: STAFF_ID,
			currentSessionId: SESSION_ID,
			contextPolicy: "clear",
			systemPrompt: SYSTEM_PROMPT,
			memory: "PINNED_STAFF_MEMORY",
			roleId: "tester",
		});
		expect(inboxStore.listPending(STAFF_ID)).toEqual([
			expect.objectContaining({ id: "clear-wake-entry", state: "pending" }),
		]);
		expect(manager.projectDeliveryOutbox(SESSION_ID)).toEqual([
			expect.objectContaining({
				text: DIGEST,
				kind: "steer",
				targetTurn: "next-turn",
				deliveryState: "dispatching",
				source: "system",
			}),
		]);

		const persisted = sessionStore.get(SESSION_ID)!;
		expect(persisted.agentSessionFile).toBe(newPath);
		expect(persisted.contextClearBoundaries).toEqual([
			expect.objectContaining({
				previousAgentSessionFile: oldPath,
				activatedAgentSessionFile: newPath,
				previousTranscriptMaterialized: true,
			}),
		]);
		const visible = manager.buildVisibleMessageSnapshot(SESSION_ID, { messages: bridge.activeModelMessages });
		const visibleJson = JSON.stringify(visible);
		expect(visibleJson).toContain("__context_cleared");
		expect(visibleJson).toContain(DIGEST);
		for (const marker of OLD_MARKERS) expect(visibleJson).not.toContain(marker);
		const retainedDisplayOnlyHistory = fs.readFileSync(oldPath, "utf8");
		for (const marker of OLD_MARKERS) expect(retainedDisplayOnlyHistory).toContain(marker);

		// A gateway restart reconstructs both stores from their durable files. Flush
		// the sole SessionStore writer, then inspect its published payload read-only;
		// constructing a second live writer would not model a real gateway restart.
		await sessionStore.flushAsync();
		const reloadedStaffStore = new StaffStore(stateDir);
		const durableSessions = JSON.parse(
			fs.readFileSync(path.join(sessionStateDir, "sessions.json"), "utf8"),
		) as { sessions: any[] };
		const reloadedSession = durableSessions.sessions.find((session) => session.id === SESSION_ID);
		expect(reloadedStaffStore.get(STAFF_ID)).toMatchObject({
			id: STAFF_ID,
			currentSessionId: SESSION_ID,
			contextPolicy: "clear",
			systemPrompt: SYSTEM_PROMPT,
			memory: "PINNED_STAFF_MEMORY",
		});
		expect(reloadedSession).toMatchObject({
			id: SESSION_ID,
			staffId: STAFF_ID,
			agentSessionFile: newPath,
			contextClearBoundaries: [expect.objectContaining({ previousAgentSessionFile: oldPath })],
		});
	});
});
