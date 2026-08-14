import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { vi } from "vitest";
import { createSession } from "./_e2e/e2e-setup.js";
import { invalidateModelCache } from "../../src/server/agent/model-registry.js";
import { setClaudeAgentSdkBridgeDepsForTesting } from "../../src/server/agent/session-runtime.js";
import {
	createSessionTracker,
	localApiFetch,
	seedArchivedSession,
	seedSessionTranscript,
} from "./helpers/session-fixtures.js";

const sessions = createSessionTracker();
const SDK_PROVIDER = "claude-agent-sdk";
const SDK_MODEL = "saved-sdk-model";

async function registerSdkCatalogFixture(gateway: { baseURL: string; token: string }): Promise<void> {
	const response = await localApiFetch(gateway, "/api/custom-providers", {
		method: "POST",
		body: JSON.stringify({
			id: SDK_PROVIDER,
			name: SDK_PROVIDER,
			type: "manual",
			baseUrl: "http://127.0.0.1:9",
			apiKey: "test-key",
			models: [{ id: SDK_MODEL, name: "Saved Claude Agent SDK model" }],
		}),
	});
	expect(response.status, await response.text()).toBe(200);
	invalidateModelCache();

	const catalog = await localApiFetch(gateway, "/api/models");
	expect(catalog.status).toBe(200);
	const sdkModel = (await catalog.json()).find((model: any) =>
		model.provider === SDK_PROVIDER && model.id === SDK_MODEL,
	);
	expect(sdkModel).toMatchObject({ runtime: "claude-agent-sdk" });
	expect(sdkModel.sessionSelectable).not.toBe(false);
}

async function removeSdkCatalogFixture(gateway: { baseURL: string; token: string }): Promise<void> {
	try {
		const response = await localApiFetch(gateway, `/api/custom-providers/${SDK_PROVIDER}`, { method: "DELETE" });
		expect(response.status, await response.text()).toBe(200);
	} finally {
		invalidateModelCache();
	}
}

function installReadySdkBridgeFixture(
	gateway: { clock: any; sessionManager: any },
	unavailableSessionIds: readonly string[] = [],
	initializationError?: Error,
): { infoCalls: Array<{ sessionId: string; options: unknown }>; queryCount: () => number; restore: () => void } {
	const unavailable = new Set(unavailableSessionIds);
	const infoCalls: Array<{ sessionId: string; options: unknown }> = [];
	let queries = 0;
	const deps = {
		clock: gateway.clock,
		query: () => {
			queries++;
			let finish!: () => void;
			const done = new Promise<void>(resolve => { finish = resolve; });
			return {
				initializationResult: async () => {
					if (initializationError) throw initializationError;
					return { session_id: "00000000-0000-4000-8000-000000000005" };
				},
				interrupt: async () => {},
				setModel: async () => {},
				setMaxThinkingTokens: async () => {},
				close: async () => { finish(); },
				async *[Symbol.asyncIterator]() { await done; },
			};
		},
		sessionAccess: {
			loadSdk: async () => ({
				getSessionInfo: async (sessionId: string, options: unknown) => {
					infoCalls.push({ sessionId, options });
					return unavailable.has(sessionId) ? undefined : { sessionId, summary: "empty SDK history", lastModified: 1 };
				},
				getSessionMessages: async () => [],
			}),
		},
	};
	const previousFactory = gateway.sessionManager.claudeAgentSdkBridgeDepsFactory;
	setClaudeAgentSdkBridgeDepsForTesting(deps as any);
	gateway.sessionManager.claudeAgentSdkBridgeDepsFactory = () => deps;
	return {
		infoCalls,
		queryCount: () => queries,
		restore: () => {
			gateway.sessionManager.claudeAgentSdkBridgeDepsFactory = previousFactory;
			setClaudeAgentSdkBridgeDepsForTesting(undefined);
		},
	};
}

test.describe("session runtime route boundary", () => {
	test.afterEach(async ({ gateway }) => sessions.cleanup(gateway));

	test("uses a cold cached catalog for audit identity and rejects SDK forks before transcript copies", async ({ gateway }) => {
		invalidateModelCache();
		const archivedSdkId = sessions.add(seedArchivedSession(gateway, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000001",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		}));
		const legacyId = sessions.add(seedArchivedSession(gateway, {}));

		const archiveList = await localApiFetch(gateway, "/api/sessions?include=archived");
		expect(archiveList.status).toBe(200);
		const archiveRows = (await archiveList.json()).sessions as any[];
		expect(archiveRows.find(row => row.id === archivedSdkId)).toMatchObject({
			runtime: "claude-agent-sdk",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		});
		expect(archiveRows.find(row => row.id === archivedSdkId)?.modelAvailable).toBeUndefined();
		expect(archiveRows.find(row => row.id === legacyId)).toMatchObject({ runtime: "pi" });
		expect(archiveRows.find(row => row.id === legacyId)?.modelAvailable).toBeUndefined();

		const archivedSingle = await localApiFetch(gateway, `/api/sessions/${archivedSdkId}`);
		expect(archivedSingle.status).toBe(200);
		const archivedSingleBody = await archivedSingle.json();
		expect(archivedSingleBody).toMatchObject({
			runtime: "claude-agent-sdk",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		});
		expect(archivedSingleBody.modelAvailable).toBeUndefined();

		const sourceId = sessions.add(await createSession());
		const sourceTranscript = seedSessionTranscript(gateway, sourceId, [
			{ role: "user", text: "SDK_FORK_MUST_NOT_COPY" },
		]);
		const sourceBefore = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourceBefore.projectId).update(sourceId, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000002",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		});
		const countBefore = gateway.sessionManager.listSessions().length;
		const liveSingle = await localApiFetch(gateway, `/api/sessions/${sourceId}`);
		expect(liveSingle.status).toBe(200);
		expect(await liveSingle.json()).toMatchObject({ runtime: "claude-agent-sdk" });

		const fork = await localApiFetch(gateway, `/api/sessions/${sourceId}/fork`, {
			method: "POST",
			body: JSON.stringify({ newWorktree: false }),
		});
		expect(fork.status).toBe(422);
		expect(await fork.json()).toMatchObject({ code: "RUNTIME_FORK_UNSUPPORTED" });
		expect(gateway.sessionManager.listSessions()).toHaveLength(countBefore);
		expect(gateway.sessionManager.getPersistedSession(sourceId)?.agentSessionFile).toBe(sourceTranscript);
	});

	test("continues a valid SDK source with empty SDK history without Pi JSONL recovery or copy side effects", async ({ gateway }) => {
		await registerSdkCatalogFixture(gateway);
		const sdk = installReadySdkBridgeFixture(gateway);
		const stateDir = join(gateway.bobbitDir, "state");
		const sidecarDirs: string[] = [];
		try {
			const sourceId = sessions.add(seedArchivedSession(gateway, {
				agentSessionFile: "",
				runtime: "claude-agent-sdk",
				claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000003",
				modelProvider: SDK_PROVIDER,
				modelId: SDK_MODEL,
			}, []));
			const promptDir = join(stateDir, "session-prompts");
			const agentJsonlBefore = readdirSync(promptDir).filter(file => file.endsWith(".jsonl")).sort();
			const sourceToolContent = join(stateDir, "tool-content", sourceId);
			const sourceProposals = join(stateDir, "proposal-drafts", sourceId);
			for (const [dir, file] of [[sourceToolContent, "tool.txt"], [sourceProposals, "goal.md"]]) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, file), "SDK_CONTINUE_MUST_NOT_COPY");
				sidecarDirs.push(dir);
			}

			const continued = await localApiFetch(gateway, `/api/sessions/${sourceId}/continue`, { method: "POST" });
			expect(continued.status).toBe(201);
			expect(sdk.infoCalls).toEqual([{
				sessionId: "00000000-0000-4000-8000-000000000003",
				options: { dir: gateway.bobbitDir },
			}]);
			const body = await continued.json() as { id: string };
			sessions.add(body.id);
			sidecarDirs.push(join(stateDir, "tool-content", body.id), join(stateDir, "proposal-drafts", body.id));
			expect(gateway.sessionManager.getPersistedSession(body.id)).toMatchObject({
				runtime: "claude-agent-sdk",
				claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000003",
				modelProvider: SDK_PROVIDER,
				modelId: SDK_MODEL,
			});
			expect(gateway.sessionManager.getPersistedSession(body.id)?.agentSessionFile).toBeFalsy();
			expect(readdirSync(promptDir).filter(file => file.endsWith(".jsonl")).sort()).toEqual(agentJsonlBefore);
			expect(existsSync(join(stateDir, "tool-content", body.id))).toBe(false);
			expect(existsSync(join(stateDir, "proposal-drafts", body.id))).toBe(false);
		} finally {
			for (const dir of sidecarDirs) rmSync(dir, { recursive: true, force: true });
			sdk.restore();
			await removeSdkCatalogFixture(gateway);
		}
	});

	test("logs only a stable unavailable category when SDK session creation fails", async ({ gateway }) => {
		await registerSdkCatalogFixture(gateway);
		const privateCwd = join(gateway.bobbitDir, "default-project", "private-sdk-cwd");
		const privateSessionId = "00000000-0000-4000-8000-000000000099";
		const privateResumeId = "00000000-0000-4000-8000-000000000098";
		const privatePrompt = "PRIVATE_SDK_PROMPT";
		const privateOutput = "PRIVATE_SDK_MODEL_OUTPUT";
		const privateProviderBody = JSON.stringify({
			project: gateway.defaultProjectId,
			cwd: privateCwd,
			session_id: privateSessionId,
			resume: privateResumeId,
			prompt: privatePrompt,
			output: privateOutput,
		});
		const providerFailure = new Error(`provider body=${privateProviderBody} Authorization: Bearer sk-create-secret abcdefgh.abcdefgh.ijklmnop /Users/aj/.claude/credentials.json opaque_12345678901234567890123456789012`);
		const sdk = installReadySdkBridgeFixture(gateway, [], providerFailure);
		const beforePreferences = await localApiFetch(gateway, "/api/preferences");
		expect(beforePreferences.status).toBe(200);
		const beforeDefault = (await beforePreferences.json())["default.sessionModel"];
		const logged: unknown[][] = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
		mkdirSync(privateCwd, { recursive: true });
		try {
			const setDefault = await localApiFetch(gateway, "/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": `${SDK_PROVIDER}/${SDK_MODEL}` }),
			});
			expect(setDefault.status).toBe(200);
			const response = await localApiFetch(gateway, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: privateCwd, projectId: gateway.defaultProjectId, worktree: false }),
			});
			expect(response.status, await response.clone().text()).toBe(503);
			const body = await response.json();
			expect(body).toEqual({ error: "SDK_SESSION_UNAVAILABLE", code: "SDK_SESSION_UNAVAILABLE" });
			const responseText = JSON.stringify(body);
			const logText = JSON.stringify(logged);
			for (const privateValue of [
				privateCwd, gateway.defaultProjectId, privateSessionId, privateResumeId,
				privatePrompt, privateOutput, privateProviderBody,
				"sk-create-secret", "abcdefgh.abcdefgh.ijklmnop", "/Users/aj/.claude/credentials.json", "opaque_12345678901234567890123456789012",
			]) {
				expect(responseText).not.toContain(privateValue);
				expect(logText).not.toContain(privateValue);
			}
			expect(logText).toContain("SDK_SESSION_UNAVAILABLE");
		} finally {
			errorSpy.mockRestore();
			rmSync(privateCwd, { recursive: true, force: true });
			await localApiFetch(gateway, "/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": beforeDefault }),
			});
			sdk.restore();
			await removeSdkCatalogFixture(gateway);
		}
	});

	test("rejects unavailable SDK continue before allocating a destination or touching Pi artifacts", async ({ gateway }) => {
		await registerSdkCatalogFixture(gateway);
		const sourceSdkSessionId = "00000000-0000-4000-8000-000000000006";
		const sdk = installReadySdkBridgeFixture(gateway, [sourceSdkSessionId]);
		const stateDir = join(gateway.bobbitDir, "state");
		const logged: unknown[][] = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
		try {
			const sourceId = sessions.add(seedArchivedSession(gateway, {
				runtime: "claude-agent-sdk",
				claudeAgentSdkSessionId: sourceSdkSessionId,
				modelProvider: SDK_PROVIDER,
				modelId: SDK_MODEL,
				// A preflight ordering regression would try (and fail) to resolve this.
				worktreePath: join(gateway.bobbitDir, "must-not-create-worktree"),
			}));
			const liveBefore = gateway.sessionManager.listSessions().length;
			const archivedBefore = gateway.sessionManager.listArchivedSessions().length;
			const promptDir = join(stateDir, "session-prompts");
			const piFilesBefore = readdirSync(promptDir).filter(file => file.endsWith(".jsonl")).sort();
			const sidecarRoots = [join(stateDir, "tool-content"), join(stateDir, "proposal-drafts")];
			const piSidecarsBefore = sidecarRoots.map(root => existsSync(root) ? readdirSync(root).sort() : []);

			const response = await localApiFetch(gateway, `/api/sessions/${sourceId}/continue`, { method: "POST" });
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				error: "SDK_SESSION_UNAVAILABLE",
				code: "SDK_SESSION_UNAVAILABLE",
			});
			expect(sdk.infoCalls).toEqual([{ sessionId: sourceSdkSessionId, options: { dir: gateway.bobbitDir } }]);
			expect(sdk.queryCount()).toBe(0);
			expect(gateway.sessionManager.listSessions()).toHaveLength(liveBefore);
			expect(gateway.sessionManager.listArchivedSessions()).toHaveLength(archivedBefore);
			expect(existsSync(join(gateway.bobbitDir, "must-not-create-worktree"))).toBe(false);
			expect(readdirSync(promptDir).filter(file => file.endsWith(".jsonl")).sort()).toEqual(piFilesBefore);
			expect(sidecarRoots.map(root => existsSync(root) ? readdirSync(root).sort() : [])).toEqual(piSidecarsBefore);
			const logText = JSON.stringify(logged);
			expect(logText).toContain("[POST /api/sessions/continue] SDK unavailable: SDK_SESSION_UNAVAILABLE");
			for (const privateId of [sourceId, sourceSdkSessionId]) expect(logText).not.toContain(privateId);
		} finally {
			errorSpy.mockRestore();
			sdk.restore();
			await removeSdkCatalogFixture(gateway);
		}
	});

	test("rejects SDK continue without a valid resume id or exact SDK model tuple before creation", async ({ gateway }) => {
		const missingResume = sessions.add(seedArchivedSession(gateway, {
			runtime: "claude-agent-sdk",
			modelProvider: "claude-agent-sdk",
			modelId: "saved-sdk-model",
		}));
		const missingTuple = sessions.add(seedArchivedSession(gateway, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "00000000-0000-4000-8000-000000000004",
			modelProvider: "claude-agent-sdk",
			modelId: "",
		}));
		const before = gateway.sessionManager.listSessions().length;

		for (const sourceId of [missingResume, missingTuple]) {
			const response = await localApiFetch(gateway, `/api/sessions/${sourceId}/continue`, { method: "POST" });
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({ code: "RUNTIME_CONTINUE_UNSUPPORTED" });
			expect(gateway.sessionManager.listSessions()).toHaveLength(before);
		}
	});

	test("returns only the stable unavailable category when SDK transcript access rejects", async ({ gateway }) => {
		const sdkSessionId = "00000000-0000-4000-8000-000000000008";
		const sessionId = sessions.add(seedArchivedSession(gateway, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: sdkSessionId,
			modelProvider: SDK_PROVIDER,
			modelId: SDK_MODEL,
		}));
		const manager = gateway.sessionManager as any;
		const original = manager.getSdkSessionAccessDeps;
		const providerFailure = "Authorization: Bearer sk-route-secret abcdefgh.abcdefgh.ijklmnop /Users/aj/.claude/credentials.json opaque_12345678901234567890123456789012";
		manager.getSdkSessionAccessDeps = () => ({ loadSdk: async () => { throw new Error(providerFailure); } });
		const logged: unknown[][] = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
		try {
			const response = await localApiFetch(gateway, `/api/sessions/${sessionId}/transcript`);
			expect(response.status).toBe(503);
			const body = await response.json();
			expect(body).toEqual({ error: "SDK_SESSION_UNAVAILABLE", code: "SDK_SESSION_UNAVAILABLE" });
			const logText = JSON.stringify(logged);
			for (const secret of ["sk-route-secret", "abcdefgh.abcdefgh.ijklmnop", "/Users/aj/.claude/credentials.json", "opaque_12345678901234567890123456789012", sessionId, sdkSessionId]) {
				expect(JSON.stringify(body)).not.toContain(secret);
				expect(logText).not.toContain(secret);
			}
			expect(logText).toContain("[GET /api/sessions/transcript] SDK unavailable: SDK_SESSION_UNAVAILABLE");
		} finally {
			errorSpy.mockRestore();
			manager.getSdkSessionAccessDeps = original;
		}
	});

	test("reads an SDK transcript through the session manager's injected SDK access seam", async ({ gateway }) => {
		const sdkSessionId = "00000000-0000-4000-8000-000000000007";
		const sessionId = sessions.add(seedArchivedSession(gateway, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: sdkSessionId,
			modelProvider: SDK_PROVIDER,
			modelId: SDK_MODEL,
			agentSessionFile: "/must-not-read.jsonl",
		}));
		const manager = gateway.sessionManager as any;
		const original = manager.getSdkSessionAccessDeps;
		const calls: string[] = [];
		manager.getSdkSessionAccessDeps = (persisted: any) => {
			calls.push(persisted.id);
			return {
				loadSdk: async () => ({
					getSessionInfo: async () => ({ sessionId: sdkSessionId, summary: "SDK history", lastModified: 1 }),
					getSessionMessages: async () => [{
						type: "user", uuid: "sdk-history-user", session_id: sdkSessionId,
						message: { role: "user", content: "SDK_TRANSCRIPT_MANAGER_SEAM" },
						parent_tool_use_id: null, parent_agent_id: null,
					}],
				}),
			};
		};
		try {
			const response = await localApiFetch(gateway, `/api/sessions/${sessionId}/transcript`);
			expect(response.status).toBe(200);
			expect(calls).toEqual([sessionId]);
			expect(JSON.stringify(await response.json())).toContain("SDK_TRANSCRIPT_MANAGER_SEAM");
		} finally {
			manager.getSdkSessionAccessDeps = original;
		}
	});
});
