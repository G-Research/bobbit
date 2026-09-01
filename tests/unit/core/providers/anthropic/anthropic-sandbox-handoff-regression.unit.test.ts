import { guardProcessEnv } from "../../../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { resetAgentDirStateForTests } from "../../../../../src/server/bobbit-dir.js";
import { SessionManager } from "../../../../../src/server/agent/session-manager.js";
import {
	buildSandboxAgentAuthJson,
	detectHostTokens,
	refreshSandboxAnthropicOAuthCredential,
	recoverAnthropicApiKeyRuntime,
	resolveHostTokenValue,
	sandboxAgentAuthPath,
	sandboxTokenPolicyAllowsAnthropicAuth,
} from "../../../../../src/server/agent/host-tokens.js";

const originalBobbitAgentDir = process.env.BOBBIT_AGENT_DIR;
const originalBobbitDir = process.env.BOBBIT_DIR;
const originalBobbitSecretsDir = process.env.BOBBIT_SECRETS_DIR;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalAnthropicOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
let root: string | undefined;
let agentDir: string | undefined;
const SYNTHETIC_PI_REFRESH = "synthetic-pi-refresh";

/** A renewable host row must use Pi's complete OAuth credential shape. */
function completePiOAuthCredential(access: string, expires: number): { type: "oauth"; access: string; refresh: string; expires: number } {
	return { type: "oauth", access, refresh: SYNTHETIC_PI_REFRESH, expires };
}

function isolatedSandboxManager(): any {
	return {
		ensureForProject: async () => {},
		get: () => ({
			getContainerId: async () => "container-test",
			getStatus: () => ({ status: "ready", containerId: "container-test" }),
		}),
		ensureSessionRuntime: async (_projectId: string, sessionId: string) => `runtime-${sessionId}`,
		isSessionRuntimeIsolated: async (_projectId: string, sessionId: string, id: string) => id === `runtime-${sessionId}`,
		releaseSessionRuntime: async () => {},
	};
}

function useHostAuth(auth: unknown): void {
	root = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-sandbox-"));
	agentDir = path.join(root, "agent");
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.BOBBIT_DIR = root;
	process.env.BOBBIT_SECRETS_DIR = path.join(root, "secrets");
	resetAgentDirStateForTests();
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(path.join(root, "secrets"), { recursive: true });
	mkdirSync(path.join(root, "state"), { recursive: true });
	writeFileSync(path.join(root, "state", "gateway-url"), "http://127.0.0.1:3001\n");
	writeFileSync(path.join(root, "secrets", "token"), `${"a".repeat(64)}\n`);
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
		anthropic: auth,
		"openai-codex": { type: "oauth", access: "unrelated-codex-access" },
		"google-gemini-cli": { type: "oauth", access: "unrelated-google-access" },
	}), { encoding: "utf-8", flag: "w" });
}

afterEach(() => {
	vi.restoreAllMocks();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	agentDir = undefined;
	if (originalBobbitAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = originalBobbitAgentDir;
	if (originalBobbitDir === undefined) delete process.env.BOBBIT_DIR;
	else process.env.BOBBIT_DIR = originalBobbitDir;
	if (originalBobbitSecretsDir === undefined) delete process.env.BOBBIT_SECRETS_DIR;
	else process.env.BOBBIT_SECRETS_DIR = originalBobbitSecretsDir;
	if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
	if (originalAnthropicOAuthToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
	else process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOAuthToken;
	resetAgentDirStateForTests();
});

describe("Anthropic sandbox OAuth handoff regressions", () => {
	it("exports only a sanctioned, current non-renewable Anthropic OAuth credential", () => {
		const expires = Date.now() + 60_000;
		useHostAuth({
			...completePiOAuthCredential("sandbox-current-access", expires),
			email: "must-not-copy@example.test",
			scope: "must-not-copy",
		});

		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }]), true);
		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: false }]), false);
		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_API_KEY", enabled: true }]), false);
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {
			anthropic: { type: "oauth", access: "sandbox-current-access", expires },
		});
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: false }), {});
	});

	it("does not hand an expired host OAuth access token to a sandbox when refresh cannot run", () => {
		useHostAuth(completePiOAuthCredential("expired-access", Date.now() - 1));

		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {});
		assert.equal(resolveHostTokenValue("ANTHROPIC_OAUTH_TOKEN", undefined, undefined as any, { allowStoredAnthropicOAuth: false }), undefined);
	});

	it.each([
		["missing refresh", { type: "oauth", access: "partial-access", expires: Date.now() + 60_000 }],
		["missing expiry", { type: "oauth", access: "partial-access", refresh: "partial-refresh" }],
	])("does not advertise, refresh, or export a host OAuth credential %s", async (_caseName, credential) => {
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		useHostAuth(credential);

		assert.equal(detectHostTokens().find(token => token.envVar === "ANTHROPIC_OAUTH_TOKEN")?.available, false);
		assert.equal(await refreshSandboxAnthropicOAuthCredential(), false);
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {});
		assert.equal(resolveHostTokenValue("ANTHROPIC_OAUTH_TOKEN", undefined, undefined as any, { allowStoredAnthropicOAuth: true }), undefined);
	});

	it("refreshes before producing the minimal sandbox auth entry", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		useHostAuth(completePiOAuthCredential("expired-access", now - 1));
		const refreshRequest = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
			assert.equal(init?.method, "POST");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.grant_type, "refresh_token");
			assert.equal(body.refresh_token, SYNTHETIC_PI_REFRESH);
			assert.equal(typeof body.client_id, "string");
			return new Response(JSON.stringify({
				access_token: "rotated-access",
				refresh_token: "rotated-refresh",
				expires_in: 3_600,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const refreshedExpiry = now + 3_600_000 - 300_000;

		assert.equal(await refreshSandboxAnthropicOAuthCredential(), true);
		assert.equal(refreshRequest.mock.calls.length, 1);
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {
			anthropic: { type: "oauth", access: "rotated-access", expires: refreshedExpiry },
		});
	});

	it("refreshes an explicitly opted-in host credential during wiring and exports only its minimal entry", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		useHostAuth(completePiOAuthCredential("expired-access", now - 1));
		const refreshRequest = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			access_token: "rotated-access",
			refresh_token: "rotated-refresh",
			expires_in: 3_600,
		}), { status: 200, headers: { "Content-Type": "application/json" } }));
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }],
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = isolatedSandboxManager();
		const bridgeOptions: any = { cwd: "/workspace", env: {} };

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-test", { projectId: "project-test" }), true);
		assert.equal(refreshRequest.mock.calls.length, 1);
		assert.deepEqual(bridgeOptions.sandboxCredentials, {}, "host OAuth must not also cross through the raw env handoff");
		assert.deepEqual(JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8")), {
			anthropic: { type: "oauth", access: "rotated-access", expires: now + 3_600_000 - 300_000 },
		});
	});

	it("keeps an explicit project credential ahead of host OAuth during wiring", async () => {
		useHostAuth(completePiOAuthCredential("expired-access", Date.now() - 1));
		const refreshRequest = vi.spyOn(globalThis, "fetch");
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [{ key: "ANTHROPIC_API_KEY", enabled: true, value: "project-provided-key" }],
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = isolatedSandboxManager();
		const bridgeOptions: any = { cwd: "/workspace", env: {} };

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-test", { projectId: "project-test" }), true);
		assert.equal(refreshRequest.mock.calls.length, 0, "project credentials must suppress host OAuth refresh");
		assert.deepEqual(bridgeOptions.sandboxCredentials, { ANTHROPIC_API_KEY: "project-provided-key" });
		assert.deepEqual(JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8")), {});
	});

	it("serializes handoffs and rechecks policy after a host refresh", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		useHostAuth(completePiOAuthCredential("expired-access", now - 1));
		let entries: Array<{ key: string; enabled: boolean; value?: string }> = [
			{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true },
		];
		let resolveRefresh!: (response: Response) => void;
		let refreshStarted!: () => void;
		const refreshStartedPromise = new Promise<void>((resolve) => { refreshStarted = resolve; });
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			refreshStarted();
			return await new Promise<Response>((resolve) => { resolveRefresh = resolve; });
		});
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => entries,
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = isolatedSandboxManager();
		const firstOptions: any = { cwd: "/workspace", env: {} };
		const secondOptions: any = { cwd: "/workspace", env: {} };

		const first = manager.applySandboxWiring(firstOptions, "session-one", { projectId: "project-test" });
		await refreshStartedPromise;
		entries = [{ key: "ANTHROPIC_API_KEY", enabled: true, value: "project-provided-key" }];
		const second = manager.applySandboxWiring(secondOptions, "session-two", { projectId: "project-test" });
		let secondSettled = false;
		void second.then(() => { secondSettled = true; });
		await Promise.resolve();
		assert.equal(secondSettled, false, "a second handoff must wait for the pending shared auth-file decision");

		resolveRefresh(new Response(JSON.stringify({
			access_token: "rotated-access",
			refresh_token: "rotated-refresh",
			expires_in: 3_600,
		}), { status: 200, headers: { "Content-Type": "application/json" } }));
		await Promise.all([first, second]);

		assert.deepEqual(firstOptions.sandboxCredentials, { ANTHROPIC_API_KEY: "project-provided-key" });
		assert.deepEqual(secondOptions.sandboxCredentials, { ANTHROPIC_API_KEY: "project-provided-key" });
		assert.deepEqual(JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8")), {});
	});

	it("leaves non-Anthropic startup untouched and makes API-key tombstone recovery best effort", async () => {
		useHostAuth({ type: "oauth_rejected", rejected: "a".repeat(64), version: 1 });
		process.env.ANTHROPIC_API_KEY = "test-api-key";

		await recoverAnthropicApiKeyRuntime(undefined, false);
		assert.equal(JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")).anthropic.type, "oauth_rejected");

		await recoverAnthropicApiKeyRuntime({ ANTHROPIC_API_KEY: "test-api-key" });
		const recovered = JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8"));
		assert.equal("anthropic" in recovered, false);
		assert.equal(recovered["openai-codex"].access, "unrelated-codex-access");

		writeFileSync(path.join(agentDir!, "auth.json"), "{ malformed", "utf-8");
		await assert.doesNotReject(() => recoverAnthropicApiKeyRuntime({ ANTHROPIC_API_KEY: "test-api-key" }));
	});

	it("prefers a host Anthropic API key over an opted-in stored OAuth credential", async () => {
		useHostAuth(completePiOAuthCredential("current-host-access", Date.now() + 60_000));
		process.env.ANTHROPIC_API_KEY = "host-api-key";
		const refreshRequest = vi.spyOn(globalThis, "fetch");
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }],
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = isolatedSandboxManager();
		const bridgeOptions: any = { cwd: "/workspace", env: {} };

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-test", { projectId: "project-test" }), true);
		assert.equal(refreshRequest.mock.calls.length, 0, "the API key makes host OAuth refresh unnecessary");
		assert.deepEqual(bridgeOptions.sandboxCredentials, { ANTHROPIC_OAUTH_TOKEN: "host-api-key" });
		assert.deepEqual(JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8")), {});
	});

	it("denies host OAuth by default during sandbox wiring", async () => {
		useHostAuth(completePiOAuthCredential("current-host-access", Date.now() + 60_000));
		const refreshRequest = vi.spyOn(globalThis, "fetch");
		const manager: any = new SessionManager();
		manager.projectContextManager = null;
		manager.projectConfigStore = {
			get: (key: string) => key === "sandbox" ? "docker" : undefined,
			getSandboxTokens: () => [],
		};
		manager.sandboxTokenStore = null;
		manager.sandboxManager = isolatedSandboxManager();
		const bridgeOptions: any = { cwd: "/workspace", env: {} };

		assert.equal(await manager.applySandboxWiring(bridgeOptions, "session-test", { projectId: "project-test" }), true);
		assert.equal(refreshRequest.mock.calls.length, 0, "default sandbox setup must not inspect host OAuth");
		assert.deepEqual(bridgeOptions.sandboxCredentials, {});
		const sandboxAuth = JSON.parse(readFileSync(sandboxAgentAuthPath("project-test"), "utf-8"));
		assert.equal(sandboxAuth.anthropic, undefined);
	});
});
