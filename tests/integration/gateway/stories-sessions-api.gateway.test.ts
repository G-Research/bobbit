/**
 * API coverage split out from browser session stories.
 *
 * Browser stories keep UI behavior coverage; these persistence/worktree
 * assertions do not need a spawned browser gateway.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { Component } from "../../../src/server/agent/project-config-store.js";
import type { WorktreeSupportDeps } from "../../../src/server/agent/worktree-support.js";
import {
	resolveSessionWorktreeOptions,
	type SessionWorktreeOptions,
} from "../../../src/server/session-worktree-options.js";
import { ensureGateway } from "../../../tests/support/harnesses/integration/gateway/runtime.js";
import {
	apiFetch,
	connectWs,
	harnessDefaultProjectRoot,
} from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

type StoryProject = {
	id: string;
	rootPath: string;
	components: Component[];
	configuredBaseRef?: string;
};

type StorySession = {
	id: string;
	cwd: string;
	projectId: string;
	status: "preparing";
	worktreeOpts?: SessionWorktreeOptions;
};

type SessionCreateRequest = {
	cwd?: string;
	projectId?: string;
	worktree?: boolean;
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

class SessionStoryRouteFixture {
	readonly sessions = new Map<string, StorySession>();
	private readonly projects = new Map<string, StoryProject>();

	constructor(project: StoryProject, private readonly git: WorktreeSupportDeps) {
		this.projects.set(project.id, project);
	}

	async fetch(requestPath: string, init: RequestInit): Promise<Response> {
		if (requestPath !== "/api/sessions" || init.method !== "POST") {
			return json({ error: "Route not found" }, 404);
		}
		const request = JSON.parse(String(init.body ?? "{}")) as SessionCreateRequest;
		const project = request.projectId ? this.projects.get(request.projectId) : undefined;
		if (!project) return json({ error: "Project not found" }, 404);
		const cwd = request.cwd ?? project.rootPath;
		const worktreeOpts = await resolveSessionWorktreeOptions({
			worktree: request.worktree,
			projectId: project.id,
			headquartersProjectId: "headquarters",
			projectRoot: project.rootPath,
			components: project.components,
			configuredBaseRef: project.configuredBaseRef,
			cwd,
		}, this.git);
		const session: StorySession = {
			id: "session-worktree-decision",
			cwd,
			projectId: project.id,
			status: "preparing",
			worktreeOpts,
		};
		this.sessions.set(session.id, session);
		return json({
			id: session.id,
			cwd: session.cwd,
			projectId: session.projectId,
			status: session.status,
		}, 201);
	}
}

function seedLiveStorySession(gateway: any): { sessionId: string; cleanup: () => void } {
	const sessionManager = gateway.sessionManager;
	const projectId = gateway.defaultProjectId;
	const sessionId = `session-story-${randomUUID()}`;
	const cwd = harnessDefaultProjectRoot();
	const now = Date.now();
	let model = { provider: "mock", id: "mock-model" };
	let thinkingLevel = "off";
	const session = {
		id: sessionId,
		title: "Session story fixture",
		titleGenerated: true,
		cwd,
		projectId,
		status: "idle",
		statusVersion: 0,
		createdAt: now,
		lastActivity: now,
		clients: new Set(),
		isCompacting: false,
		eventBuffer: { size: 0 },
		promptQueue: { toArray: () => [] },
		rpcClient: {
			async setModel(provider: string, id: string) { model = { provider, id }; },
			async setThinkingLevel(level: string) { thinkingLevel = level; },
			async getState() { return { success: true, data: { model, thinkingLevel } }; },
		},
	};
	const store = sessionManager.getSessionStore(projectId);
	sessionManager.sessions.set(sessionId, session);
	store.put({
		id: sessionId,
		title: session.title,
		cwd,
		agentSessionFile: "",
		createdAt: now,
		lastActivity: now,
		projectId,
	});
	return {
		sessionId,
		cleanup() {
			sessionManager.sessions.delete(sessionId);
			store.remove(sessionId);
		},
	};
}

test.describe("Session story API invariants", () => {
	test("S-08: session in a detected repository selects worktree provisioning", async () => {
		const repoRoot = "C:/suite/story-repository";
		const projectId = "story-project";
		const git: WorktreeSupportDeps = {
			isGitRepo: async cwd => cwd === repoRoot,
			getRepoRoot: async cwd => {
				expect(cwd).toBe(repoRoot);
				return repoRoot;
			},
			isGitRepoRoot: async () => false,
			hasResolvedHead: async path => path === repoRoot,
		};
		const route = new SessionStoryRouteFixture({
			id: projectId,
			rootPath: repoRoot,
			components: [{ name: "app", repo: "." }],
		}, git);

		const resp = await route.fetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: repoRoot, projectId, worktree: true }),
		});
		expect(resp.status, await resp.clone().text()).toBe(201);
		expect(await resp.json()).toMatchObject({
			id: "session-worktree-decision",
			cwd: repoRoot,
			projectId,
			status: "preparing",
		});
		expect(route.sessions.get("session-worktree-decision")?.worktreeOpts).toEqual({ repoPath: repoRoot });
	});

	test("S-09/S-10: renamed title and session properties persist", async () => {
		const fixture = seedLiveStorySession(await ensureGateway());
		try {
			const patchResp = await apiFetch(`/api/sessions/${fixture.sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "My Custom Title", colorIndex: 5 }),
			});
			expect(patchResp.ok).toBe(true);

			const connection = await connectWs(fixture.sessionId);
			try {
				const cursor = connection.messageCount();
				connection.send({
					type: "set_model",
					provider: "mock",
					modelId: "mock-model",
					thinkingLevel: "off",
				});
				connection.send({ type: "get_state" });
				const state = await connection.waitForFrom(
					cursor,
					(message) =>
						message.type === "state" &&
						message.data?.model?.provider === "mock" &&
						message.data?.model?.id === "mock-model" &&
						message.data?.thinkingLevel === "off" &&
						message.data?.model?.contextWindow === 8_192,
					1_000,
				);
				expect(state.data.model).toMatchObject({
					provider: "mock",
					id: "mock-model",
					contextWindow: 8_192,
					maxTokens: 4_096,
					reasoning: false,
				});
				expect(state.data.thinkingLevel).toBe("off");

				const resp = await apiFetch(`/api/sessions/${fixture.sessionId}`);
				expect(resp.ok).toBe(true);
				expect(await resp.json()).toMatchObject({
					title: "My Custom Title",
					colorIndex: 5,
					modelProvider: "mock",
					modelId: "mock-model",
				});
			} finally {
				connection.close();
			}
		} finally {
			fixture.cleanup();
		}
	});
});
