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

const { activeAgentSessionsDir, sessionTranscriptRoot } = await import("../../src/server/agent/agent-session-path.ts");
const { initAuthorSidecarDir } = await import("../../src/server/agent/author-sidecar.ts");
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
initAuthorSidecarDir(root, {
	secretsDir: path.join(root, "private-secrets"),
	hmacKey: Buffer.alloc(32, 0x50),
});

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

function transcript(name: string, sandboxed: boolean): string {
	const relative = path.join("--promotion-runtime--", `${name}.jsonl`);
	const dir = sandboxed
		? path.join(sessionTranscriptRoot(name), "--promotion-runtime--")
		: path.join(activeAgentSessionsDir(), "--promotion-runtime--");
	fs.mkdirSync(dir, { recursive: true });
	const hostFile = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(hostFile, `${JSON.stringify({
		type: "message",
		id: "existing-user-message",
		parentId: null,
		message: { role: "user", content: [{ type: "text", text: "work already in progress" }] },
	})}\n`, "utf8");
	files.push(hostFile);
	return sandboxed
		? `/home/node/.bobbit/agent/sessions/${relative.replace(/\\/g, "/")}`
		: hostFile;
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
	const file = transcript(name, overrides.sandboxed === true);
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
	if (persisted.sandboxed && persisted.goalId) {
		persisted.containerId ??= "same-container";
	}
	const updates: Record<string, unknown>[] = [];
	const store = {
		get: vi.fn(() => persisted),
		getLive: vi.fn(() => [persisted]),
		getAll: vi.fn(() => [persisted]),
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
		repoPath: persisted.repoPath,
		worktreePath: persisted.worktreePath,
		repoWorktrees: persisted.repoWorktrees,
		worktreeOwnerSessionId: persisted.id,
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
		...(persisted.role ? { role: persisted.role } : {}),
		...(persisted.accessory ? { accessory: persisted.accessory } : {}),
		...(persisted.containerId ? { containerId: persisted.containerId } : {}),
		spawnPinnedModel: `${provider}/${modelId}`,
		spawnPinnedThinkingLevel: thinkingLevel,
	};
	manager.sessions.set(persisted.id, live);
	return { manager, persisted, live, oldBridge, store };
}

function reservePromotion(fx: ReturnType<typeof fixture>, goalId: string): any {
	const reservation = fx.manager.reserveSessionGoalPromotion(fx.live.id);
	fx.manager.bindSessionGoalPromotion(reservation, goalId);
	return reservation;
}

describe("SessionManager current-session runtime promotion", () => {
	it("parks one guarded kickoff through pause and active-turn settlement, then dispatches it once on resume", async () => {
		const fx = fixture("promotion-pause-guard");
		const replacement = bridge();
		registerRpcBridgeFactory(() => replacement);
		const goal = {
			id: "goal-pause-guard",
			title: "Promoted pause guard",
			state: "in-progress",
			setupStatus: "ready",
			paused: false,
			projectId: fx.persisted.projectId,
			repoPath: fx.persisted.repoPath,
			branch: fx.persisted.branch,
			worktreePath: fx.persisted.worktreePath,
			repoWorktrees: fx.persisted.repoWorktrees,
			worktreeOwnerSessionId: fx.live.id,
		};
		fx.manager.resolveGoal = vi.fn((goalId: string) => goalId === goal.id ? goal : undefined);

		const reservation = reservePromotion(fx, goal.id);
		await fx.manager.promoteToGoalLead(fx.live.id, goal.id, reservation);
		expect(fx.live).toMatchObject({
			goalId: goal.id,
			teamGoalId: goal.id,
			role: "team-lead",
		});

		// Finalization races an already-running turn on the canonical promoted
		// runtime. The kickoff must enter the durable reliable lane, not Pi.
		fx.live.titleGenerated = false;
		fx.live.clients.clear();
		fx.manager.handleAgentLifecycle(fx.live, { type: "agent_start" });
		const kickoff = `You have been promoted to the team lead for the goal "${goal.title}".  Proceed to complete the goal, following the instructions in your system prompt carefully.`;
		const intentId = `promotion-kickoff:${goal.id}`;
		const transcriptBefore = fs.readFileSync(fx.persisted.agentSessionFile, "utf8");
		await expect(fx.manager.enqueuePrompt(fx.live.id, kickoff, {
			source: "system",
			suppressTitleGen: true,
			intentId,
			goalDispatchGuardId: goal.id,
		})).resolves.toEqual({ status: "queued" });

		const guardedRows = () => fx.live.promptQueue.toArray()
			.filter((row: any) => row.id === intentId);
		expect(guardedRows()).toEqual([expect.objectContaining({
			id: intentId,
			text: kickoff,
			kind: "prompt",
			targetTurn: "next-turn",
			deliveryState: "queued",
			source: "system",
			author: expect.objectContaining({ kind: "system" }),
			suppressTitleGen: true,
			goalDispatchGuardId: goal.id,
		})]);
		expect(replacement.prompt).not.toHaveBeenCalled();

		// Operator pause commits before its soft abort settles. Both the natural
		// settlement drain and an extra recovery drain must retain the exact row.
		goal.paused = true;
		await fx.manager.abortSessionTurn(fx.live.id);
		expect(replacement.abort).toHaveBeenCalledTimes(1);
		fx.manager.handleAgentLifecycle(fx.live, { type: "agent_end", willRetry: false, messages: [] });
		fx.manager.handleAgentLifecycle(fx.live, { type: "agent_settled" });
		fx.manager.drainGoalGuardedPrompts(goal.id);
		await new Promise(resolve => setImmediate(resolve));

		expect(fx.live.status).toBe("idle");
		expect(replacement.prompt).not.toHaveBeenCalled();
		expect(guardedRows()).toHaveLength(1);
		expect(fs.readFileSync(fx.persisted.agentSessionFile, "utf8")).toBe(transcriptBefore);
		expect(JSON.stringify(fx.live.eventBuffer.getAll())).not.toContain(kickoff);
		expect(fx.live.pendingPromptAuthors ?? []).toEqual([]);

		// The explicit resume hook re-drains only after the durable pause bit is
		// cleared. Further drain/retry calls cannot dispatch the occurrence twice.
		goal.paused = false;
		fx.manager.drainGoalGuardedPrompts(goal.id);
		await vi.waitFor(() => expect(replacement.prompt).toHaveBeenCalledTimes(1));
		expect(replacement.prompt).toHaveBeenCalledWith(`[System]: ${kickoff}`, undefined);
		expect(guardedRows()).toEqual([]);
		expect(fx.live.pendingPromptAuthors).toEqual([
			expect.objectContaining({
				intentId,
				source: "system",
				author: expect.objectContaining({ kind: "system" }),
			}),
		]);
		expect(fx.live.titleGenerated).toBe(false);
		expect(fx.live.title).toBe("Existing regular session");

		fx.manager.drainGoalGuardedPrompts(goal.id);
		(fx.manager as any).drainQueue(fx.live);
		await new Promise(resolve => setImmediate(resolve));
		expect(replacement.prompt).toHaveBeenCalledTimes(1);
	});

	it("continues to drain a legacy unguarded row while its adopted goal is paused", async () => {
		const fx = fixture("promotion-legacy-unguarded", {
			goalId: "goal-legacy-unguarded",
			teamGoalId: "goal-legacy-unguarded",
			role: "team-lead",
		});
		Object.assign(fx.live, {
			goalId: "goal-legacy-unguarded",
			teamGoalId: "goal-legacy-unguarded",
			role: "team-lead",
			status: "idle",
			_piAgentRunSettled: true,
		});
		fx.live.clients.clear();
		fx.manager.resolveGoal = vi.fn(() => ({
			id: "goal-legacy-unguarded",
			state: "in-progress",
			setupStatus: "ready",
			paused: true,
			projectId: fx.persisted.projectId,
			worktreeOwnerSessionId: fx.live.id,
		}));

		const legacy = fx.live.promptQueue.enqueue("legacy unguarded prompt", {
			source: "system",
			suppressTitleGen: true,
		});
		expect(legacy).not.toHaveProperty("kind");
		expect(legacy).not.toHaveProperty("goalDispatchGuardId");

		(fx.manager as any).drainQueue(fx.live);
		await vi.waitFor(() => expect(fx.oldBridge.prompt).toHaveBeenCalledTimes(1));
		expect(fx.oldBridge.prompt).toHaveBeenCalledWith("[System]: legacy unguarded prompt", undefined);
		expect(fx.live.promptQueue.toArray()).toEqual([]);
	});

	it("commits goal/team runtime context while preserving the exact session capsule", async () => {
		const fx = fixture("promotion-success");
		const replacement = bridge();
		let options: any;
		const replacementFactory = vi.fn((nextOptions: any) => {
			options = nextOptions;
			return replacement;
		});
		registerRpcBridgeFactory(replacementFactory);
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

		const reservation = reservePromotion(fx, "goal-promoted");
		const promoted = await fx.manager.promoteToGoalLead(fx.live.id, "goal-promoted", reservation);

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

		promoted.status = "streaming";
		await expect(fx.manager.promoteToGoalLead(fx.live.id, "goal-promoted", reservation)).resolves.toBe(fx.live);
		expect(replacementFactory).toHaveBeenCalledTimes(1);
		expect(replacement.start).toHaveBeenCalledTimes(1);
	});

	it("rejects competing role and destructive lifecycle mutations while the promotion reservation is held", async () => {
		const fx = fixture("promotion-reservation", { role: "general", accessory: "spark" });
		const reservation = fx.manager.reserveSessionGoalPromotion(fx.live.id);
		const competingRole = { name: "reviewer", promptTemplate: "Review", accessory: "search" };

		await expect(fx.manager.assignRole(fx.live.id, competingRole)).rejects.toMatchObject({
			statusCode: 409,
			code: "SESSION_GOAL_PROMOTION_IN_PROGRESS",
			retryable: true,
		});
		await expect(fx.manager.terminateSession(fx.live.id)).rejects.toMatchObject({
			statusCode: 409,
			code: "SESSION_GOAL_PROMOTION_IN_PROGRESS",
		});
		expect(fx.live).toMatchObject({ role: "general", accessory: "spark", status: "idle" });
		expect(fx.persisted).toMatchObject({ role: "general", accessory: "spark" });
		expect(fx.oldBridge.stop).not.toHaveBeenCalled();
		expect(fx.manager.releaseSessionGoalPromotion({ ...reservation })).toBe(false);
		expect(fx.manager.releaseSessionGoalPromotion(reservation)).toBe(true);
		expect(() => fx.manager.assertSessionGoalPromotionMutationAllowed(fx.live.id)).not.toThrow();
	});

	it("reuses the existing sandbox realm and never requests worktree provisioning", async () => {
		const fx = fixture("promotion-sandbox", {
			agentSessionFile: "",
			sandboxed: true,
			containerId: "existing-container",
			cwd: "/workspace-wt/session/promotion-sandbox",
			worktreePath: "/workspace-wt/session/promotion-sandbox",
		});
		fx.live.cwd = fx.persisted.cwd;
		fx.live.worktreePath = fx.persisted.worktreePath;
		fx.live.sandboxed = true;
		// Exact-runtime transcript fixture: role staging probes the canonical
		// conversation path after the replacement bridge starts.
		fx.manager.sandboxManager = {
			runSessionTranscriptOperation: vi.fn(async (_projectId: string, sessionId: string, operation: { kind: string }) => {
				expect(sessionId).toBe(fx.live.id);
				return operation.kind === "exists" ? true : undefined;
			}),
		};
		const replacement = bridge();
		let options: any;
		registerRpcBridgeFactory((nextOptions: any) => {
			options = nextOptions;
			return replacement;
		});
		fx.manager.applySandboxWiring = vi.fn(async (bridgeOptions: any, sessionId: string, opts: any) => {
			expect(sessionId).toBe(fx.live.id);
			expect(opts).toEqual({
				projectId: fx.live.projectId,
				goalId: "goal-sandbox",
				expectedExistingContainerId: "existing-container",
				allowLegacyControlMigration: true,
				persistRuntimeIdentity: false,
			});
			bridgeOptions.sandboxed = true;
			bridgeOptions.containerId = "existing-container";
			bridgeOptions.cwd = fx.live.cwd;
			return true;
		});

		const reservation = reservePromotion(fx, "goal-sandbox");
		await fx.manager.promoteToGoalLead(fx.live.id, "goal-sandbox", reservation);

		expect(fx.manager.applySandboxWiring).toHaveBeenCalledTimes(1);
		expect(options).toMatchObject({
			sandboxed: true,
			containerId: "existing-container",
			cwd: fx.live.cwd,
		});
		expect(options).not.toHaveProperty("sandboxBranch");
		expect(options).not.toHaveProperty("sandboxBaseBranch");
		expect(fx.persisted.worktreePath).toBe("/workspace-wt/session/promotion-sandbox");
		expect(fx.persisted.containerId).toBe("existing-container");
		expect(fx.live.containerId).toBe("existing-container");

		fx.manager.applySandboxWiring = vi.fn(async () => {
			throw new Error("existing container was replaced");
		});
		await expect(fx.manager.promoteToGoalLead(fx.live.id, "goal-sandbox", reservation))
			.rejects.toThrow("existing container was replaced");
		expect(replacement.start).toHaveBeenCalledTimes(1);
	});

	it.each([
		["missing", "Expected session runtime was not found"],
		["mismatched", "Unexpected session runtime identity"],
	])("fails closed on a %s promoted execution runtime without candidate start", async (_case, runtimeError) => {
		const fx = fixture(`promotion-sandbox-${_case}`, {
			agentSessionFile: "",
			sandboxed: true,
			containerId: "runtime-exact",
			cwd: `/workspace-wt/session/promotion-sandbox-${_case}`,
			worktreePath: `/workspace-wt/session/promotion-sandbox-${_case}`,
		});
		fx.live.cwd = fx.persisted.cwd;
		fx.live.worktreePath = fx.persisted.worktreePath;
		fx.live.sandboxed = true;
		const replacement = bridge();
		const factory = vi.fn(() => replacement);
		registerRpcBridgeFactory(factory);
		const ensureForProject = vi.fn(async () => {});
		fx.manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [],
		};
		fx.manager.readGatewayUrlForAgent = () => "https://gateway.test";
		fx.manager.mintScopedGatewayToken = () => "scoped-token";
		fx.manager.sandboxManager = {
			ensureForProject,
			get: vi.fn(() => ({
				getStatus: () => ({ status: "ready", containerId: "control-container" }),
				getContainerId: async () => "control-container",
			})),
			ensureSessionRuntime: vi.fn(async () => { throw new Error(runtimeError); }),
			isSessionRuntimeIsolated: vi.fn(async () => false),
			releaseSessionRuntime: vi.fn(async () => {}),
		};
		const before = structuredClone(fx.persisted);

		const reservation = reservePromotion(fx, "goal-sandbox-race");
		await expect(fx.manager.promoteToGoalLead(fx.live.id, "goal-sandbox-race", reservation))
			.rejects.toThrow(runtimeError);

		expect(ensureForProject).toHaveBeenCalledTimes(1);
		expect(factory).not.toHaveBeenCalled();
		expect(replacement.start).not.toHaveBeenCalled();
		expect(fx.oldBridge.stop).not.toHaveBeenCalled();
		expect(fx.manager.getSession(fx.live.id)).toBe(fx.live);
		expect(fx.persisted).toEqual(before);
	});

	it("restores exact optional metadata and the original runtime when old stop rejects", async () => {
		const fx = fixture("promotion-stop-rollback");
		const replacement = bridge();
		registerRpcBridgeFactory(() => replacement);
		fx.oldBridge.stop = vi.fn(async () => { throw new Error("old bridge refused stop"); });
		for (const field of ["goalId", "teamGoalId", "role", "accessory", "containerId"]) {
			expect(Object.prototype.hasOwnProperty.call(fx.persisted, field)).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(fx.live, field)).toBe(false);
		}

		const reservation = reservePromotion(fx, "goal-rollback");
		await expect(fx.manager.promoteToGoalLead(fx.live.id, "goal-rollback", reservation))
			.rejects.toThrow("old bridge refused stop");

		expect(fx.manager.getSession(fx.live.id)).toBe(fx.live);
		expect(fx.live.rpcClient).toBe(fx.oldBridge);
		expect(fx.live.unsubscribe).toBeInstanceOf(Function);
		for (const field of ["goalId", "teamGoalId", "role", "accessory", "containerId"]) {
			expect(Object.prototype.hasOwnProperty.call(fx.persisted, field)).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(fx.live, field)).toBe(false);
		}
		expect(fx.store.flushAsync).toHaveBeenCalledTimes(1);
		expect(replacement.stop).toHaveBeenCalledTimes(1);
	});

	it("restores the exact canonical general baseline when promotion fails before commit", async () => {
		const fx = fixture("promotion-general-rollback", { role: "general", accessory: "spark" });
		const replacement = bridge();
		registerRpcBridgeFactory(() => replacement);
		fx.oldBridge.stop = vi.fn(async () => { throw new Error("old bridge refused stop"); });
		const reservation = reservePromotion(fx, "goal-general-rollback");

		await expect(fx.manager.promoteToGoalLead(fx.live.id, "goal-general-rollback", reservation))
			.rejects.toThrow("old bridge refused stop");

		expect(fx.live).toMatchObject({ role: "general", accessory: "spark", status: "idle" });
		expect(fx.persisted).toMatchObject({ role: "general", accessory: "spark" });
		expect(fx.store.flushAsync).toHaveBeenCalledTimes(1);
	});

	it("keeps a promoted source dormant and byte-stable when its transcript cannot be recovered", async () => {
		const fx = fixture("promotion-missing-transcript", {
			agentSessionFile: undefined,
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			accessory: "crown",
			sandboxed: true,
		});
		fx.manager.sessions.clear();
		fx.manager.recoverSessionFile = vi.fn(() => null);
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string) =>
			sessionId === fx.persisted.id ? "live adopted goal still owns source" : undefined);
		const before = structuredClone(fx.persisted);

		await fx.manager.restoreOneSession(fx.persisted);
		await fx.manager.restoreOneSession(fx.persisted);

		expect(fx.store.archive).not.toHaveBeenCalled();
		expect(fx.store.archiveAsync).not.toHaveBeenCalled();
		expect(fx.persisted).toEqual(before);
		expect(fx.manager.getSession(fx.persisted.id)).toMatchObject({
			id: fx.persisted.id,
			dormant: true,
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			cwd: before.cwd,
			worktreePath: before.worktreePath,
			repoPath: before.repoPath,
			branch: before.branch,
			sandboxed: true,
		});
		expect(fx.manager.getSession(fx.persisted.id).repoWorktrees).toEqual(fx.live.repoWorktrees);
	});

	it("retains a promoted sandbox source when its recorded transcript file is missing", async () => {
		const fx = fixture("promotion-missing-transcript-file", {
			agentSessionFile: "/home/node/.bobbit/agent/sessions/promotion-missing.jsonl",
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			sandboxed: true,
		});
		fx.manager.sessions.clear();
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string) =>
			sessionId === fx.persisted.id ? "live adopted goal still owns source" : undefined);
		const sandboxExec = vi.fn(async (args: string[]) => {
			if (args[0] === "test") throw new Error("transcript missing");
		});
		fx.manager.sandboxManager = { get: vi.fn(() => ({ exec: sandboxExec })) };
		const before = structuredClone(fx.persisted);

		await fx.manager.restoreOneSession(fx.persisted);

		expect(sandboxExec).not.toHaveBeenCalled();
		expect(fx.store.archive).not.toHaveBeenCalled();
		expect(fx.persisted).toEqual(before);
		expect(fx.manager.getSession(fx.persisted.id)).toMatchObject({
			dormant: true,
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			worktreePath: before.worktreePath,
			repoPath: before.repoPath,
			branch: before.branch,
			sandboxed: true,
		});
	});

	it("fails closed before promoted sandbox worktree repair or recreation on repeated restore", async () => {
		const fx = fixture("promotion-missing-sandbox-worktree", {
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			accessory: "crown",
			sandboxed: true,
			cwd: "/workspace-wt/session/promotion-missing-sandbox-worktree",
			worktreePath: "/workspace-wt/session/promotion-missing-sandbox-worktree",
		});
		fx.manager.sessions.clear();
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string) =>
			sessionId === fx.persisted.id ? "live adopted goal still owns source" : undefined);
		fx.manager.applySandboxWiring = vi.fn(async (options: any) => {
			options.containerId = "same-container";
			options.cwd = fx.persisted.cwd;
			return true;
		});
		const execFile = vi.fn(async (...args: any[]) => {
			if (args[1]?.includes("test")) throw new Error("worktree missing");
			throw new Error("repair must not run");
		});
		fx.manager.commandRunner = { execFile };
		const createWorktree = vi.fn(async () => { throw new Error("recreation must not run"); });
		fx.manager.sandboxManager = { get: vi.fn(() => ({ createWorktree, getContainerId: async () => "control-container" })) };
		const before = structuredClone(fx.persisted);

		await expect(fx.manager.restoreSession(fx.persisted)).rejects.toBeInstanceOf(PromotedSessionLifecycleConflictError);
		await expect(fx.manager.restoreSession(fx.persisted)).rejects.toBeInstanceOf(PromotedSessionLifecycleConflictError);

		expect(execFile).toHaveBeenCalledTimes(2);
		for (const call of execFile.mock.calls) expect(call[1]).not.toContain("repair");
		expect(createWorktree).not.toHaveBeenCalled();
		expect(fx.store.archive).not.toHaveBeenCalled();
		expect(fx.store.archiveAsync).not.toHaveBeenCalled();
		expect(fx.persisted).toEqual(before);
	});

	it("quarantines a promoted source when its exact runtime is missing after control recovery", async () => {
		const fx = fixture("promotion-sandbox-replaced-on-restart", {
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			sandboxed: true,
			containerId: "original-container",
			cwd: "/workspace-wt/session/promotion-sandbox-replaced-on-restart",
			worktreePath: "/workspace-wt/session/promotion-sandbox-replaced-on-restart",
		});
		fx.manager.sessions.clear();
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string) =>
			sessionId === fx.persisted.id ? "live adopted goal still owns source" : undefined);
		const ensureForProject = vi.fn(async () => {});
		fx.manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [],
		};
		fx.manager.sandboxManager = {
			ensureForProject,
			get: vi.fn(() => ({
				getStatus: () => ({ status: "ready", containerId: "replacement-control" }),
				getContainerId: vi.fn(async () => "replacement-control"),
			})),
			ensureSessionRuntime: vi.fn(async () => { throw new Error("Expected session runtime was not found"); }),
			isSessionRuntimeIsolated: vi.fn(async () => false),
			releaseSessionRuntime: vi.fn(async () => {}),
		};
		const before = structuredClone(fx.persisted);

		await fx.manager.restoreOneSession(fx.persisted);

		expect(ensureForProject).toHaveBeenCalledTimes(1);
		expect(fx.persisted).toEqual(before);
		expect(fx.manager.getSession(fx.persisted.id)).toMatchObject({
			dormant: true,
			sandboxed: true,
			containerId: "original-container",
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
		});
	});

	it("quarantines a promoted source instead of downgrading an unavailable sandbox realm", async () => {
		const fx = fixture("promotion-sandbox-unavailable", {
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			sandboxed: true,
			cwd: "/workspace-wt/session/promotion-sandbox-unavailable",
			worktreePath: "/workspace-wt/session/promotion-sandbox-unavailable",
		});
		fx.manager.sessions.clear();
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string) =>
			sessionId === fx.persisted.id ? "live adopted goal still owns source" : undefined);
		fx.manager.applySandboxWiring = vi.fn(async () => false);
		const before = structuredClone(fx.persisted);

		await fx.manager.restoreOneSession(fx.persisted);

		expect(fx.store.updates).not.toContainEqual({ sandboxed: false });
		expect(fx.persisted).toEqual(before);
		expect(fx.manager.getSession(fx.persisted.id)).toMatchObject({
			dormant: true,
			sandboxed: true,
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			cwd: before.cwd,
			worktreePath: before.worktreePath,
		});
	});

	it("keeps a promoted runtime live when only the project control container recovers", async () => {
		const fx = fixture("promotion-live-container-recovery", {
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			sandboxed: true,
			containerId: "runtime-promoted-exact",
			cwd: "/workspace-wt/session/promotion-live-container-recovery",
			worktreePath: "/workspace-wt/session/promotion-live-container-recovery",
		});
		fx.live.cwd = fx.persisted.cwd;
		fx.live.worktreePath = fx.persisted.worktreePath;
		fx.live.sandboxed = true;
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string) =>
			sessionId === fx.persisted.id ? "live adopted goal still owns source" : undefined);
		const execFile = vi.fn(async (..._args: any[]) => ({ stdout: "", stderr: "" }));
		fx.manager.commandRunner = { execFile };
		const createWorktree = vi.fn();
		fx.manager.sandboxManager = {
			get: vi.fn(() => ({ createWorktree })),
			isSessionRuntimeIsolated: vi.fn(async (_projectId: string, sessionId: string, id: string) =>
				sessionId === fx.persisted.id && id === "runtime-promoted-exact"),
		};

		await fx.manager.recoverSandboxSessions(fx.persisted.projectId, "replacement-control-id");

		expect(execFile).toHaveBeenCalledTimes(1);
		expect(execFile.mock.calls[0][1]).toContain("replacement-control-id");
		expect(createWorktree).not.toHaveBeenCalled();
		expect(fx.oldBridge.stop).not.toHaveBeenCalled();
		expect(fx.store.archive).not.toHaveBeenCalled();
		expect(fx.store.archiveAsync).not.toHaveBeenCalled();
		expect(fx.manager.getSession(fx.persisted.id)).toBe(fx.live);
		expect(fx.live.status).toBe("idle");
	});

	it("uses strict adopted container identity during force-abort replacement", async () => {
		const fx = fixture("promotion-force-abort", {
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			sandboxed: true,
			containerId: "force-abort-container",
			cwd: "/workspace-wt/session/promotion-force-abort",
			worktreePath: "/workspace-wt/session/promotion-force-abort",
		});
		Object.assign(fx.live, {
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			sandboxed: true,
			containerId: "force-abort-container",
			status: "streaming",
		});
		fx.live.clients.clear();
		fx.manager.applySandboxWiring = vi.fn(async (_options: any, _id: string, opts: any) => {
			expect(opts.expectedExistingContainerId).toBe("force-abort-container");
			throw new Error("stop after strict wiring assertion");
		});

		await expect(fx.manager.forceAbort(fx.live.id, 0)).rejects.toThrow("stop after strict wiring assertion");

		expect(fx.manager.applySandboxWiring).toHaveBeenCalledTimes(1);
		expect(fx.oldBridge.stop).toHaveBeenCalledTimes(1);
		expect(fx.persisted.containerId).toBe("force-abort-container");
	});

	it("does not run boot host recovery against any promoted multi-repo workspace", async () => {
		const fx = fixture("promotion-host-recovery", {
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			sandboxed: false,
		});
		fx.manager.sessions.clear();
		fx.manager.restoreOneSession = vi.fn(async () => {});
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string) =>
			sessionId === fx.persisted.id ? "live adopted goal still owns source" : undefined);
		const execFile = vi.fn(async () => { throw new Error("host git must not run"); });
		fx.manager.commandRunner = { execFile };
		const before = structuredClone(fx.persisted);

		await fx.manager.restoreSessions();

		expect(fx.manager.restoreOneSession).toHaveBeenCalledTimes(1);
		expect(execFile).not.toHaveBeenCalled();
		expect(fx.store.archive).not.toHaveBeenCalled();
		expect(fx.persisted).toEqual(before);
		expect(fx.persisted.repoWorktrees).toEqual(before.repoWorktrees);
	});

	it("classifies only exact canonical adopted multi-repo coordinates as source-owned cleanup", async () => {
		const fx = fixture("promotion-adopted-cleanup", {
			goalId: "goal-promoted",
			teamGoalId: "goal-promoted",
			role: "team-lead",
			archived: true,
		});
		const archivedGoal = {
			...fx.manager.resolveGoal("goal-promoted"),
			archived: true,
		};
		fx.manager.resolveGoal = vi.fn(() => archivedGoal);

		expect(fx.manager.isCanonicalAdoptedWorkspaceOwner(fx.persisted)).toBe(true);
		expect(fx.manager.hasGoalOwnedTeamLeadWorktrees(fx.persisted)).toBe(false);
		const borrower = {
			...fx.persisted,
			id: "live-borrower",
			archived: false,
			goalId: undefined,
			teamGoalId: undefined,
			role: undefined,
			cwd: path.join(fx.persisted.repoWorktrees.api, "packages", "api"),
			worktreePath: fx.persisted.repoWorktrees.api,
			repoWorktrees: undefined,
		};
		fx.store.getAll.mockReturnValue([fx.persisted, borrower]);
		expect(await fx.manager.adoptedWorkspaceHasLiveReference(fx.persisted)).toBe(true);
		fx.store.getAll.mockReturnValue([fx.persisted]);
		expect(await fx.manager.adoptedWorkspaceHasLiveReference(fx.persisted)).toBe(false);

		const ordinary = { ...fx.persisted, id: "ordinary-lead" };
		fx.manager.resolveGoal = vi.fn(() => ({ ...archivedGoal, worktreeOwnerSessionId: undefined }));
		expect(fx.manager.hasGoalOwnedTeamLeadWorktrees(ordinary)).toBe(true);

		fx.manager.resolveGoal = vi.fn(() => archivedGoal);
		const divergent = {
			...fx.persisted,
			repoWorktrees: { ...fx.persisted.repoWorktrees, api: `${fx.persisted.repoWorktrees.api}-other` },
		};
		expect(fx.manager.isCanonicalAdoptedWorkspaceOwner(divergent)).toBe(false);
		expect(fx.manager.hasGoalOwnedTeamLeadWorktrees(divergent)).toBe(true);

		fx.manager.readGitWorktreeRefs = vi.fn(async () => ({ entries: [] }));
		fx.manager.localBranchExists = vi.fn(async () => false);
		const scanContext = {
			candidateContexts: [],
			sessionPathRecords: [fx.persisted],
			goalRefs: [{
				...archivedGoal,
				id: "goal-promoted",
			}],
			teamRefs: [],
			staffRefs: [],
			branchGuardsByRepo: new Map(),
			archivedBranchGuardsByRepo: new Map(),
			gitRefsCache: new Map(),
			branchExistsCache: new Map(),
		};
		const items = await fx.manager.archivedSessionWorktreeItems(fx.persisted, scanContext, "Project");
		expect(items).toHaveLength(2);
		expect(items.map((item: any) => item.reason)).toEqual(["already-cleaned", "already-cleaned"]);
	});

	it("preserves ordinary missing-transcript archival and sandbox worktree recovery behavior", async () => {
		const missingTranscript = fixture("ordinary-missing-transcript", { agentSessionFile: undefined });
		missingTranscript.manager.sessions.clear();
		missingTranscript.manager.recoverSessionFile = vi.fn(() => null);
		await missingTranscript.manager.restoreOneSession(missingTranscript.persisted);
		expect(missingTranscript.store.archive).toHaveBeenCalledWith(missingTranscript.persisted.id);

		const sandbox = fixture("ordinary-missing-sandbox-worktree", {
			sandboxed: true,
			cwd: "/workspace-wt/session/ordinary-missing-sandbox-worktree",
			worktreePath: "/workspace-wt/session/ordinary-missing-sandbox-worktree",
		});
		sandbox.manager.sessions.clear();
		sandbox.manager.applySandboxWiring = vi.fn(async (options: any) => {
			options.containerId = "ordinary-container";
			return true;
		});
		const execFile = vi.fn(async () => { throw new Error("missing or unrepaired"); });
		sandbox.manager.commandRunner = { execFile };
		const createWorktree = vi.fn(async () => { throw new Error("recreation failed"); });
		sandbox.manager.sandboxManager = { get: vi.fn(() => ({ createWorktree, getContainerId: async () => "control-container" })) };

		await sandbox.manager.restoreSession(sandbox.persisted);

		expect(execFile.mock.calls.some((call: any[]) => call[1]?.includes("repair"))).toBe(true);
		expect(createWorktree).toHaveBeenCalledTimes(1);
		expect(sandbox.store.archive).toHaveBeenCalledWith(sandbox.persisted.id);

		const unavailable = fixture("ordinary-sandbox-unavailable", {
			sandboxed: true,
			cwd: "/workspace-wt/session/ordinary-sandbox-unavailable",
			worktreePath: "/workspace-wt/session/ordinary-sandbox-unavailable",
		});
		unavailable.manager.sessions.clear();
		unavailable.manager.applySandboxWiring = vi.fn(async () => false);
		registerRpcBridgeFactory(() => bridge());
		await unavailable.manager.restoreSession(unavailable.persisted);
		expect(unavailable.persisted.sandboxed).toBe(false);
		expect(unavailable.store.updates).toContainEqual({ sandboxed: false });
	});

	it("guards archiveWithCascade before child teardown and allows ordered goal archival", async () => {
		const fx = fixture("promotion-lifecycle-guard");
		let goalArchived = false;
		fx.manager.setPromotedSessionLifecycleGuard((sessionId: string, action: string) =>
			sessionId === fx.live.id && !goalArchived ? `live promoted goal owns ${action}` : undefined);
		fx.manager.cascadeReapOwner = vi.fn(async () => {});

		await expect(fx.manager.storeArchive(fx.live.id)).rejects.toBeInstanceOf(PromotedSessionLifecycleConflictError);
		await expect(fx.manager.storeArchive(fx.live.id, { allowPromotedGoalLifecycle: true }))
			.rejects.toBeInstanceOf(PromotedSessionLifecycleConflictError);
		await expect(fx.manager.terminateSession(fx.live.id, { allowPromotedGoalLifecycle: true }))
			.rejects.toBeInstanceOf(PromotedSessionLifecycleConflictError);
		await expect(fx.manager.archiveWithCascade(fx.live.id, fx.store)).rejects.toBeInstanceOf(PromotedSessionLifecycleConflictError);
		expect(fx.manager.cascadeReapOwner).not.toHaveBeenCalled();
		expect(fx.manager.getSession(fx.live.id)).toBe(fx.live);
		expect(fx.persisted.archived).toBeUndefined();

		// The ordered goal endpoint durably archives the goal before team/source teardown.
		goalArchived = true;
		await expect(fx.manager.storeArchive(fx.live.id)).resolves.toBe(true);
		expect(fx.manager.cascadeReapOwner).toHaveBeenCalledTimes(1);
		expect(fx.persisted.archived).toBe(true);
	});
});
