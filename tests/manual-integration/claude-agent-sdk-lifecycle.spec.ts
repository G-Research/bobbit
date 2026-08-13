/**
 * Opt-in smoke for the official Claude Agent SDK runtime.
 *
 * This deliberately runs against the user's locally authenticated Claude
 * subscription. It never copies auth files or credential values into the test
 * gateway, SDK options, assertions, or logs; the SDK must discover its normal
 * local subscription itself through the bridge's allowlisted environment.
 *
 * Run only when a local subscription is available:
 *   BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 npm run test:manual -- --grep "Claude Agent SDK lifecycle"
 */
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { manualTmpRoot } from "./manual-test-paths.ts";

const smokeEnvironmentKeys = [
	"BOBBIT_DIR",
	"BOBBIT_SECRETS_DIR",
	"BOBBIT_AGENT_DIR",
	"BOBBIT_SKIP_MCP",
	"BOBBIT_SKIP_AIGW_DISCOVERY",
	"BOBBIT_SKIP_TITLE_GEN",
	"BOBBIT_SKIP_WORKTREE_POOL",
	"BOBBIT_NO_OPEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
] as const;

function captureSmokeEnvironment(): Map<string, string | undefined> {
	return new Map(smokeEnvironmentKeys.map(key => [key, process.env[key]]));
}

function restoreSmokeEnvironment(environment: Map<string, string | undefined>): void {
	for (const [key, value] of environment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

test.describe("Claude Agent SDK lifecycle (manual subscription smoke)", () => {
	test("discovers a local subscription and supports ready, prompt, steer, soft interrupt, and termination", async () => {
		test.skip(
			process.env.BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE !== "1",
			"Set BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 to use a local Claude subscription.",
		);
		test.setTimeout(300_000);

		const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const root = join(manualTmpRoot(), `bobbit-claude-agent-sdk-smoke-${nonce}`);
		const bobbitDir = join(root, ".bobbit");
		const secretsDir = join(root, ".secrets");
		const projectRoot = join(root, "project");
		let gateway: { shutdown(): Promise<void>; sessionManager: any } | undefined;
		let token = "";
		let baseURL = "";
		const originalEnvironment = captureSmokeEnvironment();

		try {
			mkdirSync(projectRoot, { recursive: true });
			mkdirSync(join(bobbitDir, "state"), { recursive: true });
			writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
			writeFileSync(join(bobbitDir, "state", "setup-complete"), "manual-sdk-smoke\n");

			// Do not use seedManualTestModelPreferences: that helper can explicitly
			// copy authentication/config files for Pi manual tests. The SDK bridge
			// must instead discover the normal local subscription on its own.
			process.env.BOBBIT_DIR = bobbitDir;
			process.env.BOBBIT_SECRETS_DIR = secretsDir;
			process.env.BOBBIT_AGENT_DIR = join(bobbitDir, "agent");
			process.env.BOBBIT_SKIP_MCP = "1";
			process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
			process.env.BOBBIT_SKIP_TITLE_GEN = "1";
			process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
			process.env.BOBBIT_NO_OPEN = "1";

			const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
			const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
			const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
			const { createGateway } = await import("../../dist/server/server.js");
			setProjectRoot(bobbitDir);
			scaffoldBobbitDir(bobbitDir);
			token = loadOrCreateToken();
			gateway = createGateway({
				host: "127.0.0.1",
				port: 0,
				portExplicit: true,
				authToken: token,
				defaultCwd: root,
				forceAuth: true,
			});
			const port = await (gateway as any).start();
			baseURL = `http://127.0.0.1:${port}`;

			const api = (path: string, init: RequestInit = {}) => fetch(`${baseURL}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...(init.headers as Record<string, string> | undefined),
				},
			});
			const waitFor = async <T>(read: () => T | undefined, label: string, timeoutMs = 90_000): Promise<T> => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const value = read();
					if (value !== undefined) return value;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				throw new Error(`Timed out waiting for ${label}`);
			};

			const projectResponse = await api("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `sdk-smoke-${nonce}`, rootPath: projectRoot, acceptCanonical: true }),
			});
			expect(projectResponse.status, await projectResponse.clone().text()).toBe(201);
			const project = await projectResponse.json() as { id: string };

			const configuredModel = process.env.MANUAL_CLAUDE_AGENT_SDK_MODEL?.trim();
			if (!configuredModel || configuredModel.startsWith("claude-agent-sdk/")) {
				throw new Error(
					"Claude Agent SDK smoke requires MANUAL_CLAUDE_AGENT_SDK_MODEL to be a non-empty SDK model id " +
					"without the provider prefix (for example, claude-sonnet-4-5).",
				);
			}
			const sessionModel = `claude-agent-sdk/${configuredModel}`;
			const providerResponse = await api("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: "claude-agent-sdk",
					name: "claude-agent-sdk",
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [{ id: configuredModel, name: "Manual Claude Agent SDK smoke" }],
				}),
			});
			expect(providerResponse.status, await providerResponse.text()).toBe(200);
			const preferencesResponse = await api("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": sessionModel, "default.sessionThinkingLevel": "off" }),
			});
			expect(preferencesResponse.status, await preferencesResponse.text()).toBe(200);
			const createResponse = await api("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ projectId: project.id, cwd: projectRoot, worktree: false }),
			});
			expect(createResponse.status, await createResponse.clone().text()).toBe(201);
			const created = await createResponse.json() as { id: string };
			const session = await waitFor(
				() => gateway!.sessionManager.getSession(created.id),
				"SDK bridge installation",
			);
			expect(session.runtime, `default session model ${sessionModel} must select the Claude Agent SDK runtime`).toBe("claude-agent-sdk");
			await session.rpcClient.waitForReady(90_000);
			expect(session.rpcClient.running, "SDK query must remain usable after readiness").toBe(true);

			// Use the same SessionManager queue/steer path as the gateway. This keeps
			// the smoke on the production IRpcBridge boundary while avoiding a second
			// browser protocol and never recording model output in test diagnostics.
			const firstTurnVersion = session.agentObservedTurnVersion ?? 0;
			await gateway.sessionManager.enqueuePrompt(created.id, "Reply with exactly: SDK_SMOKE_READY", { source: "user" });
			await waitFor(
				() => (session.agentObservedTurnVersion ?? 0) > firstTurnVersion ? true : undefined,
				"translated SDK prompt output",
				120_000,
			);
			await waitFor(
				() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined,
				"first SDK prompt to settle",
				120_000,
			);

			await gateway.sessionManager.enqueuePrompt(
				created.id,
				"Count from 1 to 1000 slowly, one number per line, until you receive a new instruction.",
				{ source: "user" },
			);
			await waitFor(
				() => gateway!.sessionManager.getSession(created.id)?.status === "streaming" ? true : undefined,
				"SDK streaming turn",
			);
			await gateway.sessionManager.deliverLiveSteer(created.id, "Stop counting now and briefly acknowledge this steer.");
			await gateway.sessionManager.abortSessionTurn(created.id);
			expect(session.rpcClient.running, "soft interrupt must not close the SDK query").toBe(true);
			await waitFor(
				() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined,
				"soft interrupt to settle",
				120_000,
			);

			const terminated = await gateway.sessionManager.terminateSession(created.id);
			expect(terminated).toBe(true);
			expect(gateway.sessionManager.getSession(created.id)?.status).toBe("terminated");
		} finally {
			if (gateway) await gateway.shutdown().catch(() => {});
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
			restoreSmokeEnvironment(originalEnvironment);
		}
	});
});

// This intentionally has a separate gate: the direct SDK smoke above remains
// useful on hosts without Docker, while this proof requires the rebuilt image.
test.describe("Claude Agent SDK Docker sandbox lifecycle (manual subscription smoke)", () => {
	test("uses the pooled Docker container with an explicit OAuth policy and resumes after replacement", async () => {
		test.skip(
			process.env.BOBBIT_RUN_CLAUDE_AGENT_SDK_SANDBOX_SMOKE !== "1",
			"Set BOBBIT_RUN_CLAUDE_AGENT_SDK_SANDBOX_SMOKE=1 with Docker, a rebuilt bobbit-agent image, and a local Claude subscription.",
		);
		test.setTimeout(360_000);
		try {
			execFileSync("docker", ["image", "inspect", "bobbit-agent"], { stdio: "ignore", timeout: 10_000 });
		} catch {
			throw new Error("Claude Agent SDK sandbox smoke requires Docker and a rebuilt bobbit-agent image.");
		}
		const configuredModel = process.env.MANUAL_CLAUDE_AGENT_SDK_MODEL?.trim();
		if (!configuredModel || configuredModel.startsWith("claude-agent-sdk/")) {
			throw new Error("Claude Agent SDK sandbox smoke requires MANUAL_CLAUDE_AGENT_SDK_MODEL without the provider prefix.");
		}
		const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const root = join(manualTmpRoot(), `bobbit-claude-agent-sdk-sandbox-${nonce}`);
		const bobbitDir = join(root, ".bobbit");
		const projectRoot = join(root, "project");
		let gateway: { shutdown(): Promise<void>; sessionManager: any } | undefined;
		let token = "";
		const originalEnvironment = captureSmokeEnvironment();
		try {
			mkdirSync(projectRoot, { recursive: true });
			// A remote-less checkout exercises Bobbit's mounted clone without copying
			// any credentials, settings, or authentication files into the sandbox.
			execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "manual-smoke@example.invalid"], { cwd: projectRoot });
			execFileSync("git", ["config", "user.name", "Manual SDK Smoke"], { cwd: projectRoot });
			writeFileSync(join(projectRoot, "README.md"), "sandbox SDK manual smoke\n");
			execFileSync("git", ["add", "README.md"], { cwd: projectRoot, stdio: "ignore" });
			execFileSync("git", ["commit", "-m", "manual sandbox smoke"], { cwd: projectRoot, stdio: "ignore" });
			mkdirSync(join(bobbitDir, "state"), { recursive: true });
			writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
			writeFileSync(join(bobbitDir, "state", "setup-complete"), "manual-sdk-sandbox-smoke\n");
			process.env.BOBBIT_DIR = bobbitDir;
			process.env.BOBBIT_SECRETS_DIR = join(root, ".secrets");
			// Do not set BOBBIT_AGENT_DIR: production resolves the current local
			// subscription itself. This test never reads, copies, or logs its contents.
			delete process.env.BOBBIT_AGENT_DIR;
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_AUTH_TOKEN;
			process.env.BOBBIT_SKIP_MCP = "1";
			process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
			process.env.BOBBIT_SKIP_TITLE_GEN = "1";
			process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
			process.env.BOBBIT_NO_OPEN = "1";
			const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
			const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
			const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
			const { createGateway } = await import("../../dist/server/server.js");
			setProjectRoot(bobbitDir);
			scaffoldBobbitDir(bobbitDir);
			token = loadOrCreateToken();
			gateway = createGateway({ host: "127.0.0.1", port: 0, portExplicit: true, authToken: token, defaultCwd: root, forceAuth: true });
			const port = await (gateway as any).start();
			const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
				...init,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
			});
			const waitFor = async <T>(read: () => T | undefined, label: string, timeoutMs = 120_000): Promise<T> => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const value = read();
					if (value !== undefined) return value;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				throw new Error(`Timed out waiting for ${label}`);
			};
			const projectResponse = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `sdk-sandbox-${nonce}`, rootPath: projectRoot, acceptCanonical: true }) });
			expect(projectResponse.status, await projectResponse.clone().text()).toBe(201);
			const project = await projectResponse.json() as { id: string };
			const config = await api(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ sandbox: "docker", sandbox_tokens: [{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }] }),
			});
			expect(config.status, await config.text()).toBe(200);
			const savedConfigResponse = await api(`/api/projects/${project.id}/config`);
			expect(savedConfigResponse.status, await savedConfigResponse.clone().text()).toBe(200);
			const savedConfig = await savedConfigResponse.json() as { sandbox_tokens?: Array<{ key: string; enabled: boolean; value: string }> };
			expect(savedConfig.sandbox_tokens).toEqual([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true, value: "" }]);
			const sessionModel = `claude-agent-sdk/${configuredModel}`;
			const providerResponse = await api("/api/custom-providers", {
				method: "POST",
				body: JSON.stringify({
					id: "claude-agent-sdk",
					name: "claude-agent-sdk",
					type: "manual",
					baseUrl: "http://127.0.0.1:9",
					models: [{ id: configuredModel, name: "Manual Claude Agent SDK sandbox smoke" }],
				}),
			});
			expect(providerResponse.status, await providerResponse.text()).toBe(200);
			const preferencesResponse = await api("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "default.sessionModel": sessionModel, "default.sessionThinkingLevel": "off" }),
			});
			expect(preferencesResponse.status, await preferencesResponse.text()).toBe(200);
			const createdResponse = await api("/api/sessions", { method: "POST", body: JSON.stringify({ projectId: project.id, cwd: projectRoot, worktree: false }) });
			expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
			const created = await createdResponse.json() as { id: string };
			let session = await waitFor(() => gateway!.sessionManager.getSession(created.id), "sandbox SDK bridge installation");
			expect(session.runtime).toBe("claude-agent-sdk");
			expect(session.sandboxed).toBe(true);
			expect(session.cwd).toBe("/workspace");
			await session.rpcClient.waitForReady(120_000);
			const firstVersion = session.agentObservedTurnVersion ?? 0;
			await gateway.sessionManager.enqueuePrompt(created.id, "Reply with exactly: SDK_SANDBOX_READY", { source: "user" });
			await waitFor(() => (session.agentObservedTurnVersion ?? 0) > firstVersion ? true : undefined, "sandbox SDK prompt output");
			await gateway.sessionManager.enqueuePrompt(created.id, "Count slowly until told to stop.", { source: "user" });
			await waitFor(() => gateway!.sessionManager.getSession(created.id)?.status === "streaming" ? true : undefined, "sandbox SDK streaming turn");
			await gateway.sessionManager.deliverLiveSteer(created.id, "Stop now and acknowledge this steer.");
			await gateway.sessionManager.abortSessionTurn(created.id);
			await waitFor(() => gateway!.sessionManager.getSession(created.id)?.status === "idle" ? true : undefined, "sandbox SDK interrupt to settle");
			const sdkId = gateway.sessionManager.getPersistedSession(created.id).claudeAgentSdkSessionId;
			expect(typeof sdkId).toBe("string");
			await gateway.sessionManager.forceAbort(created.id);
			session = await waitFor(() => gateway!.sessionManager.getSession(created.id)?.rpcClient?.running ? gateway!.sessionManager.getSession(created.id) : undefined, "sandbox SDK replacement");
			expect(gateway.sessionManager.getPersistedSession(created.id).claudeAgentSdkSessionId).toBe(sdkId);
			// Rebuild the gateway against the same isolated state. This exercises the
			// persisted SDK UUID, fresh container wiring, and subscription handoff a
			// second time without exposing any credential material to the test.
			await gateway.shutdown();
			gateway = createGateway({ host: "127.0.0.1", port: 0, portExplicit: true, authToken: token, defaultCwd: root, forceAuth: true });
			await (gateway as any).start();
			session = await waitFor(() => gateway!.sessionManager.getSession(created.id), "sandbox SDK gateway restart");
			await session.rpcClient.waitForReady(120_000);
			expect(gateway.sessionManager.getPersistedSession(created.id).claudeAgentSdkSessionId).toBe(sdkId);
			await gateway.sessionManager.terminateSession(created.id);
			expect(gateway.sessionManager.getSession(created.id)?.status).toBe("terminated");
		} finally {
			if (gateway) await gateway.shutdown().catch(() => {});
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
			restoreSmokeEnvironment(originalEnvironment);
		}
	});
});
