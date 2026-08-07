/**
 * Controlled gateway journey for the Agent SDK Docker-sandbox runtime.
 *
 * The SDK and ProjectSandbox seams are deliberately in-process fakes: this
 * proves SessionManager's production sandbox wiring, recovery, persistence,
 * and transcript ownership without a Docker daemon or subscription.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./gateway-harness.js";
import { apiFetch, connectWs, defaultProjectId, nonGitCwd, waitForSessionStatus } from "./e2e-setup.js";

const SDK_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const OAUTH_POLICY = "ANTHROPIC_OAUTH_TOKEN";

type QueryArgs = { prompt: AsyncIterable<any>; options: Record<string, any> };
type SdkMessage = { type: "user" | "assistant"; uuid: string; session_id: string; message: any; parent_tool_use_id: null; parent_agent_id: null };

class ControlledQuery implements AsyncIterable<unknown> {
	readonly inputs: string[] = [];
	private readonly queued: unknown[] = [];
	private readonly readers: Array<(value: IteratorResult<unknown>) => void> = [];
	private closed = false;

	constructor(readonly args: QueryArgs, private readonly sdk: ControlledSdk) { void this.consume(); }
	async initializationResult(): Promise<{ session_id: string }> { return { session_id: SDK_SESSION_ID }; }
	async interrupt(): Promise<void> {}
	async setModel(): Promise<void> {}
	async setMaxThinkingTokens(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
		for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
	}
	private emit(value: unknown): void {
		const reader = this.readers.shift();
		if (reader) reader({ done: false, value });
		else this.queued.push(value);
	}
	private async consume(): Promise<void> {
		try {
			for await (const input of this.args.prompt) {
				const text = typeof input?.message?.content === "string" ? input.message.content : "";
				this.inputs.push(text);
				const assistant = this.sdk.append(text);
				this.emit({ type: "assistant", session_id: SDK_SESSION_ID, uuid: assistant.uuid, message: assistant.message });
				this.emit({ type: "result", session_id: SDK_SESSION_ID, subtype: "success" });
			}
		} catch { /* Closing a bridge closes the async input. */ }
	}
	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return { next: () => {
			const value = this.queued.shift();
			if (value !== undefined) return Promise.resolve({ done: false, value });
			if (this.closed) return Promise.resolve({ done: true, value: undefined });
			return new Promise(resolve => this.readers.push(resolve));
		} };
	}
}

class ControlledSdk {
	readonly queries: ControlledQuery[] = [];
	readonly history: SdkMessage[] = [];
	private turn = 0;
	append(text: string): SdkMessage {
		const turn = ++this.turn;
		this.history.push({ type: "user", uuid: `sandbox-user-${turn}`, session_id: SDK_SESSION_ID, message: { role: "user", content: text, timestamp: turn }, parent_tool_use_id: null, parent_agent_id: null });
		const assistant: SdkMessage = { type: "assistant", uuid: `sandbox-assistant-${turn}`, session_id: SDK_SESSION_ID, message: { role: "assistant", content: [{ type: "text", text: `SANDBOX_SDK:${text}` }], timestamp: turn }, parent_tool_use_id: null, parent_agent_id: null };
		this.history.push(assistant);
		return assistant;
	}
	async getSessionInfo(sessionId: string): Promise<any> {
		return sessionId === SDK_SESSION_ID ? { sessionId, summary: "controlled sandbox", lastModified: this.history.length } : undefined;
	}
	async getSessionMessages(sessionId: string): Promise<SdkMessage[]> {
		return sessionId === SDK_SESSION_ID ? structuredClone(this.history) : [];
	}
	readonly depsFactory = () => ({
		query: ((args: QueryArgs) => {
			const query = new ControlledQuery(args, this);
			this.queries.push(query);
			return query;
		}) as any,
		sessionAccess: { loadSdk: async () => this, sandboxSdk: this },
		clock: { now: () => Date.now(), setTimeout, clearTimeout, setInterval, clearInterval },
	});
}

const sdk = new ControlledSdk();
const bridgeLaunches: Array<Record<string, any>> = [];
test.use({ claudeAgentSdkBridgeDepsFactory: { create: (options: Record<string, any>) => {
	if (options.claudeSdkSandboxLaunch) bridgeLaunches.push(options.claudeSdkSandboxLaunch);
	return sdk.depsFactory();
} } });

test.describe.serial("Claude Agent SDK controlled Docker sandbox", () => {
	test.setTimeout(90_000);

	test("fails closed for unavailable auth/image, then preserves sandbox SDK history and UUID across recovery and gateway restart", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const manager = gateway.sessionManager as any;
		const sandboxManager = manager.sandboxManager as any;
		// Patch the manager prototype so the fixture's real gateway restart gets
		// the same controlled pooled-container seam before it restores sessions.
		const sandboxPrototype = Object.getPrototypeOf(sandboxManager) as Record<string, any>;
		const originalEnsure = sandboxPrototype.ensureForProject;
		const originalGet = sandboxPrototype.get;
		const originalAccess = manager.sdkSessionAccessDeps;
		const authFile = join(gateway.bobbitDir, "agent", "auth.json");
		const originalAuth = readFileSync(authFile, "utf8");
		const access = randomUUID();
		let containerId = "controlled-sdk-container-a";
		let capable = true;
		const sandbox = {
			getContainerId: async () => containerId,
			hasClaudeAgentSdkCapability: async () => capable,
			getStatus: () => ({ containerId, status: "ready", projectId }),
		};
		// Keep transcript reads on the controlled SDK seam; a sandbox session must
		// never silently fall back to the host SDK store.
		manager.sdkSessionAccessDeps = () => ({ loadSdk: async () => sdk, sandboxSdk: sdk });
		sandboxPrototype.ensureForProject = async function(this: unknown, id: string) {
			if (id === projectId) return;
			return originalEnsure.call(this, id);
		};
		sandboxPrototype.get = function(this: unknown, id: string) {
			return id === projectId ? sandbox : originalGet.call(this, id);
		};

		const createSandboxSdkSession = async (): Promise<Response> => apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId, cwd: nonGitCwd(), worktree: false, initialModel: "claude-agent-sdk/controlled-sandbox" }),
		});
		try {
			const config = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({ sandbox: "docker", sandbox_tokens: [{ key: OAUTH_POLICY, enabled: true }] }),
			});
			expect(config.status, await config.text()).toBe(200);
			const provider = await apiFetch("/api/custom-providers", { method: "POST", body: JSON.stringify({
				id: "claude-agent-sdk", name: "claude-agent-sdk", type: "manual", baseUrl: "http://127.0.0.1:9",
				models: [{ id: "controlled-sandbox", name: "Controlled sandbox SDK" }],
			}) });
			expect(provider.status, await provider.text()).toBe(200);

			// No token is present in the isolated auth store: creation must fail before
			// Query construction with the stable, credential-free action message.
			writeFileSync(authFile, JSON.stringify({ anthropic: { type: "oauth", expires: Date.now() + 60_000 } }));
			let response = await createSandboxSdkSession();
			const authFailure = await response.text();
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(authFailure).toContain("CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE");
			expect(authFailure.includes(access)).toBe(false);
			expect(sdk.queries).toHaveLength(0);

			writeFileSync(authFile, JSON.stringify({ anthropic: { type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60 * 60_000 } }));
			capable = false;
			response = await createSandboxSdkSession();
			const imageFailure = await response.text();
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(imageFailure).toContain("CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE");
			expect(imageFailure.includes(access)).toBe(false);
			expect(sdk.queries).toHaveLength(0);

			capable = true;
			response = await createSandboxSdkSession();
			expect(response.status, await response.clone().text()).toBe(201);
			const { id } = await response.json() as { id: string };
			await waitForSessionStatus(id, "idle", 30_000);
			expect(sdk.queries).toHaveLength(1);
			expect(bridgeLaunches).toHaveLength(1);
			expect(bridgeLaunches[0].containerId).toBe("controlled-sdk-container-a");
			expect(bridgeLaunches[0].cwd).toBe("/workspace");
			expect(bridgeLaunches[0].oauthAccessToken === access).toBe(true);

			const connection = await connectWs(id);
			try {
				const cursor = connection.messageCount();
				connection.send({ type: "prompt", text: "SANDBOX_BEFORE_RESTART" });
				await connection.waitForFrom(cursor, message => message.type === "event" && message.data?.type === "agent_end", 15_000);
			} finally { connection.close(); }
			const live = manager.getSession(id);
			const before = await manager.getMessagesSnapshotBase(live);
			expect(before.success).toBe(true);
			expect(JSON.stringify(before.data)).toContain("SANDBOX_SDK:SANDBOX_BEFORE_RESTART");
			const persisted = manager.getPersistedSession(id);
			expect(persisted).toMatchObject({ sandboxed: true, runtime: "claude-agent-sdk", claudeAgentSdkSessionId: SDK_SESSION_ID });
			expect(JSON.stringify(persisted).includes(access)).toBe(false);

			// A co-resident Pi session retains its own bridge: no SDK launch and no
			// Pi switch_session command are ever attributed to the SDK session.
			const pi = await apiFetch("/api/sessions", { method: "POST", body: JSON.stringify({ projectId, cwd: nonGitCwd(), worktree: false, initialModel: "mock/mock-model" }) });
			expect(pi.status, await pi.text()).toBe(201);
			const piId = (await pi.json() as { id: string }).id;
			await waitForSessionStatus(piId, "idle");
			const piBefore = gateway.piCommandLog.length;

			containerId = "controlled-sdk-container-b";
			await gateway.crash();
			await gateway.restart();
			// Restart builds a new manager; re-install only the transcript seam. The
			// SandboxManager prototype retains this controlled manager instance seam.
			const restoredManager = gateway.sessionManager as any;
			restoredManager.sdkSessionAccessDeps = () => ({ loadSdk: async () => sdk, sandboxSdk: sdk });
			await waitForSessionStatus(id, "idle", 30_000);
			await waitForSessionStatus(piId, "idle", 30_000);
			expect(sdk.queries).toHaveLength(2);
			expect(sdk.queries[1].args.options.resume).toBe(SDK_SESSION_ID);
			expect(bridgeLaunches[1].containerId).toBe("controlled-sdk-container-b");
			const after = await restoredManager.getMessagesSnapshotBase(restoredManager.getSession(id));
			expect(after).toEqual(before);
			expect(gateway.piCommandLog.slice(piBefore).filter((row: any) => row.sessionId === id)).toEqual([]);
		} finally {
			writeFileSync(authFile, originalAuth);
			manager.sdkSessionAccessDeps = originalAccess;
			sandboxPrototype.ensureForProject = originalEnsure;
			sandboxPrototype.get = originalGet;
			await apiFetch("/api/custom-providers/claude-agent-sdk", { method: "DELETE" }).catch(() => undefined);
			await apiFetch(`/api/projects/${projectId}/config`, { method: "PUT", body: JSON.stringify({ sandbox: "none", sandbox_tokens: null }) }).catch(() => undefined);
		}
	});
});
