import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createMemFs } from "../harness/mem-fs.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-goal-promotion-runtime-"));
process.env.BOBBIT_DIR = root;
process.env.BOBBIT_AGENT_DIR = path.join(root, "agent");

const { activeAgentSessionsDir } = await import("../../src/server/agent/agent-session-path.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");
const { invalidateModelCache } = await import("../../src/server/agent/model-registry.ts");
const { PreferencesStore } = await import("../../src/server/agent/preferences-store.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { registerRpcBridgeFactory } = await import("../../src/server/agent/rpc-bridge.ts");
const { loadOrCreateToken } = await import("../../src/server/auth/token.ts");
const {
	PromotedSessionLifecycleConflictError,
	SessionManager,
} = await import("../../src/server/agent/session-manager.ts");

loadOrCreateToken();

const provider = "promotion-runtime";
const modelId = "continuity-model";
const thinkingLevel = "off";
const preferencesStore = new PreferencesStore(path.resolve("/memfs/session-goal-promotion-runtime"), createMemFs());
preferencesStore.set("customProviders", [{
	id: provider,
	name: provider,
	type: "manual",
	baseUrl: "http://127.0.0.1:9",
	apiKey: "test-key",
	models: [{
		id: modelId,
		name: "Continuity model",
		reasoning: true,
		thinkingLevelMap: { off: null, high: "high" },
	}],
}]);
preferencesStore.set("default.sessionModel", `${provider}/${modelId}`);
preferencesStore.set("default.sessionThinkingLevel", thinkingLevel);

const teamLeadRole = {
	name: "team-lead",
	label: "Team Lead",
	promptTemplate: "Lead {{AGENT_ID}} on {{GOAL_BRANCH}}",
	accessory: "crown",
	// Promotion must ignore these role defaults and preserve the source tuple.
	model: "other-provider/other-model",
	thinkingLevel: "high",
	createdAt: 1,
	updatedAt: 1,
};

const managers: any[] = [];
const files: string[] = [];

afterEach(() => {
	registerRpcBridgeFactory(null);
	invalidateModelCache();
	vi.restoreAllMocks();
	while (managers.length) {
		const manager = managers.pop();
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager.sessions.clear();
	}
	while (files.length) fs.rmSync(files.pop()!, { force: true });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function transcript(name: string): string {
	const dir = path.join(activeAgentSessionsDir(), "--promotion-runtime--");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(file, `${JSON.stringify({
		type: "message",
		id: "existing-user-message",
		parentId: null,
		message: { role: "user", content: [{ type: "text", text: "work already in progress" }] },
	})}\n`, "utf8");
	files.push(file);
	return file;
}

function bridge(initial: { provider?: string; modelId?: string; thinkingLevel?: string } = {}): any {
	let selectedProvider = initial.provider ?? provider;
	let selectedModel = initial.modelId ?? modelId;
	let selectedThinking = initial.thinkingLevel ?? thinkingLevel;
	let listener: ((event: unknown) => void) | undefined;
	return {
		running: true,
		start: vi.fn(async () => {}),
		stop: vi.fn(async function (this: any) { this.running = false; }),
		prompt: vi.fn(async () => ({ success: true })),
		promptWhenReady: vi.fn(async () => ({ success: true })),
		steer: vi.fn(async () => ({ success: true })),
		abort: vi.fn(async () => ({ success: true })),
		getMessages: vi.fn(async () => ({ success: true, data: { messages: [] } })),
		getState: vi.fn(async () => ({
			success: true,
			data: {
				sessionFile: undefined,
				model: { provider: selectedProvider, id: selectedModel },
				thinkingLevel: selectedThinking,
			},
		})),
		setModel: vi.fn(async (nextProvider: string, nextModel: string) => {
			selectedProvider = nextProvider;
			selectedModel = nextModel;
			return { success: true };
		}),
		setThinkingLevel: vi.fn(async (next: string) => {
			selectedThinking = next;
			return { success: true };
		}),
		sendCommand: vi.fn(async () => ({ success: true })),
		onEvent: vi.fn((next: (event: unknown) => void) => {
			listener = next;
			return vi.fn(() => { listener = undefined; });
		}),
		emit: (event: unknown) => listener?.(event),
	};
}

function fixture(name: string, overrides: Record<string, unknown> = {}): {
	manager: any;
	persisted: any;
	live: any;
	oldBridge: any;
	store: any;
} {
	const file = transcript(name);
	const persisted: any = {
		id: name,
		title: "Existing regular session",
		cwd: path.join(root, "repo-wt", "session", name),
		agentSessionFile: file,
		createdAt: 10,
		lastActivity: 20,
		projectId: "project-promotion",
		worktreePath: path.join(root, "repo-wt", "session", name),
		repoPath: path.join(root, "repo"),
		branch: `session/${name}`,
		repoWorktrees: {
			".": path.join(root, "repo-wt", "session", name),
			api: path.join(root, "repo-wt", "session", `${name}-api`),
		},
		modelProvider: provider,
		modelId,
		effectiveThinkingLevel: thinkingLevel,
		sandboxed: false,
		...overrides,
	};
	const updates: Record<string, unknown>[] = [];
	const store = {
		get: vi.fn(() => persisted),
		getLive: vi.fn(() => [persisted]),
		update: vi.fn((_id: string, patch: Record<string, unknown>) => {
			updates.push({ ...patch });
			Object.assign(persisted, patch);
		}),
		flushAsync: vi.fn(async () => {}),
		put: vi.fn(),
		archive: vi.fn(),
		archiveAsync: vi.fn(async () => {
			persisted.archived = true;
			persisted.archivedAt = Date.now();
			return true;
		}),
		updates,
	};
	const roleManager = {
		getRole: vi.fn((roleName: string) => roleName === "team-lead" ? teamLeadRole : undefined),
		listRoles: vi.fn(() => [teamLeadRole]),
	};
	const manager: any = new SessionManager({ preferencesStore, roleManager: roleManager as any });
	manager._testStore = store;
	manager.resolveGoal = vi.fn((goalId: string) => ({
		id: goalId,
		title: "Promoted goal",
		state: "active",
		spec: "Keep all existing work and continue as lead.",
		branch: persisted.branch,
		projectId: persisted.projectId,
	}));
	managers.push(manager);

	const oldBridge = bridge();
	oldBridge.getState = vi.fn(async () => ({
		success: true,
		data: {
			sessionFile: file,
			model: { provider, id: modelId },
			thinkingLevel,
		},
	}));
	const clients = new Set<any>([{ readyState: 1 }]);
	const eventBuffer = new EventBuffer();
	eventBuffer.seedNextSeq(18);
	const promptQueue = new PromptQueue();
	const unsubscribe = vi.fn();
	const live: any = {
		id: persisted.id,
		title: persisted.title,
		titleGenerated: true,
		cwd: persisted.cwd,
		status: "idle",
		statusVersion: 9,
		createdAt: persisted.createdAt,
		lastActivity: persisted.lastActivity,
		clients,
		rpcClient: oldBridge,
		eventBuffer,
		promptQueue,
		unsubscribe,
		isCompacting: false,
		projectId: persisted.projectId,
		worktreePath: persisted.worktreePath,
		repoPath: persisted.repoPath,
		branch: persisted.branch,
		repoWorktrees: Object.entries(persisted.repoWorktrees).map(([repo, worktreePath]) => ({
			repo,
			repoPath: repo === "." ? persisted.repoPath : path.join(persisted.repoPath, repo),
			worktreePath,
		})),
		sandboxed: persisted.sandboxed,
		spawnPinnedModel: `${provider}/${modelId}`,
		spawnPinnedThinkingLevel: thinkingLevel,
	};
	manager.sessions.set(persisted.id, live);
	return { manager, persisted, live, oldBridge, store };
}

describe("SessionManager current-session runtime promotion", () => {
	it("commits goal/team runtime context while preserving the exact session capsule", async () => {
		const fx = fixture("promotion-success");
		const replacement = bridge();
		let options: any;
		registerRpcBridgeFactory((nextOptions: any) => {
			options = nextOptions;
			return replacement;
		});
		const oldUnsubscribe = fx.live.unsubscribe;
		const before = {
			id: fx.live.id,
			title: fx.live.title,
			cwd: fx.live.cwd,
			worktreePath: fx.live.worktreePath,
			repoPath: fx.live.repoPath,
			branch: fx.live.branch,
			repoWorktrees: fx.live.repoWorktrees,
			clients: fx.live.clients,
			eventBuffer: fx.live.eventBuffer,
			promptQueue: fx.live.promptQueue,
		};
		const beforeStatusVersion = fx.live.statusVersion;

		const promoted = await fx.manager.promoteToGoalLead(fx.live.id, "goal-promoted");

		expect(promoted).toBe(fx.live);
		expect(fx.manager.getSession(fx.live.id)).toBe(fx.live);
		expect({
			id: promoted.id,
			title: promoted.title,
			cwd: promoted.cwd,
			worktreePath: promoted.worktreePath,
			repoPath: promoted.repoPath,
			branch: promoted.branch,
			repoWorktrees: promoted.repoWorktrees,
			clients: promoted.clients,
			eventBuffer: promoted.eventBuffer,
			promptQueue: promoted.promptQueue,
		}).toEqual(before);
		expect(promoted.statusVersion).toBeGreaterThan(beforeStatusVersion);
		expect(promoted).toMatchObject({
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			accessory: "crown",
			spawnPinnedModel: `${provider}/${modelId}`,
			spawnPinnedThinkingLevel: thinkingLevel,
		});
		expect(fx.persisted).toMatchObject({
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			accessory: "crown",
			modelProvider: provider,
			modelId,
			effectiveThinkingLevel: thinkingLevel,
		});
		expect(options.initialModel).toBe(`${provider}/${modelId}`);
		expect(options.initialThinkingLevel).toBe(thinkingLevel);
		expect(options.env).toMatchObject({ BOBBIT_SESSION_ID: fx.live.id, BOBBIT_GOAL_ID: "goal-promoted" });
		const normalizedArgs = options.args.join(" ").replaceAll("\\", "/");
		expect(normalizedArgs).toContain("tools/team/extension.ts");
		expect(normalizedArgs).toContain("tools/tasks/extension.ts");
		expect(replacement.sendCommand).toHaveBeenCalledWith(
			{ type: "switch_session", sessionPath: fx.persisted.agentSessionFile },
			15_000,
		);
		expect(fx.oldBridge.stop).toHaveBeenCalledTimes(1);
		expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
		expect(fx.live.unsubscribe).not.toBe(oldUnsubscribe);

		await expect(fx.manager.promoteToGoalLead(fx.live.id, "goal-promoted")).resolves.toBe(fx.live);
		expect(replacement.start).toHaveBeenCalledTimes(1);
	});

	it("reuses the existing sandbox realm and never requests worktree provisioning", async () => {
		const fx = fixture("promotion-sandbox", {
			agentSessionFile: "",
			sandboxed: true,
			cwd: "/workspace-wt/session/promotion-sandbox",
			worktreePath: "/workspace-wt/session/promotion-sandbox",
		});
		fx.live.cwd = fx.persisted.cwd;
		fx.live.worktreePath = fx.persisted.worktreePath;
		fx.live.sandboxed = true;
		const replacement = bridge();
		let options: any;
		registerRpcBridgeFactory((nextOptions: any) => {
			options = nextOptions;
			return replacement;
		});
		fx.manager.applySandboxWiring = vi.fn(async (bridgeOptions: any, sessionId: string, opts: any) => {
			expect(sessionId).toBe(fx.live.id);
			expect(opts).toEqual({ projectId: fx.live.projectId, goalId: "goal-sandbox" });
			bridgeOptions.sandboxed = true;
			bridgeOptions.containerId = "existing-container";
			bridgeOptions.cwd = fx.live.cwd;
			return true;
		});

		await fx.manager.promoteToGoalLead(fx.live.id, "goal-sandbox");

		expect(fx.manager.applySandboxWiring).toHaveBeenCalledTimes(1);
		expect(options).toMatchObject({
			sandboxed: true,
			containerId: "existing-container",
			cwd: fx.live.cwd,
		});
		expect(options).not.toHaveProperty("sandboxBranch");
		expect(options).not.toHaveProperty("sandboxBaseBranch");
		expect(fx.persisted.worktreePath).toBe("/workspace-wt/session/promotion-sandbox");
	});

	it("restores exact optional metadata and the original runtime when old stop rejects", async () => {
		const fx = fixture("promotion-stop-rollback");
		const replacement = bridge();
		registerRpcBridgeFactory(() => replacement);
		fx.oldBridge.stop = vi.fn(async () => { throw new Error("old bridge refused stop"); });
		for (const field of ["goalId", "teamGoalId", "role", "accessory"]) {
			expect(Object.prototype.hasOwnProperty.call(fx.persisted, field)).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(fx.live, field)).toBe(false);
		}

		await expect(fx.manager.promoteToGoalLead(fx.live.id, "goal-rollback"))
			.rejects.toThrow("old bridge refused stop");

		expect(fx.manager.getSession(fx.live.id)).toBe(fx.live);
		expect(fx.live.rpcClient).toBe(fx.oldBridge);
		expect(fx.live.unsubscribe).toBeInstanceOf(Function);
		for (const field of ["goalId", "teamGoalId", "role", "accessory"]) {
			expect(Object.prototype.hasOwnProperty.call(fx.persisted, field)).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(fx.live, field)).toBe(false);
		}
		expect(fx.store.flushAsync).toHaveBeenCalledTimes(1);
		expect(replacement.stop).toHaveBeenCalledTimes(1);
	});

	it("blocks direct archive and purge through the ownership guard while allowing ordered goal teardown", async () => {
		const fx = fixture("promotion-lifecycle-guard");
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string, action: string) =>
			sessionId === fx.live.id ? `live promoted goal owns ${action}` : undefined);

		await expect(fx.manager.storeArchive(fx.live.id)).rejects.toBeInstanceOf(PromotedSessionLifecycleConflictError);
		expect(fx.manager.getSession(fx.live.id)).toBe(fx.live);
		expect(fx.persisted.archived).toBeUndefined();

		await expect(fx.manager.storeArchive(fx.live.id, { allowPromotedGoalLifecycle: true })).resolves.toBe(true);
		expect(fx.persisted.archived).toBe(true);
	});
});
