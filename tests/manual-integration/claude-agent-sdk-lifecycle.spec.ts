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
import { join } from "node:path";
import { manualTmpRoot } from "./manual-test-paths.ts";

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
			const initialModel = `claude-agent-sdk/${configuredModel}`;
			const createResponse = await api("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					projectId: project.id,
					cwd: projectRoot,
					worktree: false,
					initialModel,
				}),
			});
			expect(createResponse.status, await createResponse.clone().text()).toBe(201);
			const created = await createResponse.json() as { id: string };
			const session = await waitFor(
				() => gateway!.sessionManager.getSession(created.id),
				"SDK bridge installation",
			);
			expect(session.runtime, `initialModel ${initialModel} must select the Claude Agent SDK runtime`).toBe("claude-agent-sdk");
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
		}
	});
});
