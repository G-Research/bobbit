/**
 * E2E tests for sandbox container resilience — process_exit event handling
 * plus the narrow live-Docker models.json inode-remount contract.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./in-process-harness.js";
import { globalAgentDir } from "../../src/server/bobbit-dir.js";
import { projectSandboxVolumeNames } from "../../src/server/agent/docker-args.js";
import { ProjectSandbox } from "../../src/server/agent/project-sandbox.js";
import { isDockerAvailable } from "./test-utils/docker.js";
import {
	apiFetch,
	nonGitCwd,
	connectWs,
	waitForSessionStatus,
	statusPredicate,
} from "./e2e-setup.js";

// ---------------------------------------------------------------------------
// Live Docker inode-remount contract. The v2 E2E runner reports this file as
// Docker-gated, while this case self-skips only when no usable daemon is
// reachable. With Docker available, every container and remount assertion runs.
// ---------------------------------------------------------------------------

test.describe("atomic models.json bind mount", () => {
	test("refresh restores exact managed AIGW publication without disturbing a sibling run", async () => {
		test.skip(!isDockerAvailable(), "Docker not available");
		const root = mkdtempSync(path.join(tmpdir(), "bobbit-model-remount-"));
		const source = path.join(root, "source");
		const projectId = `remount-${randomUUID()}`;
		const runA = `run-a-${randomUUID()}`;
		const runB = `run-b-${randomUUID()}`;
		const originalRunId = process.env.BOBBIT_E2E_RUN_ID;
		const agentDir = globalAgentDir();
		const modelsJson = path.join(agentDir, "models.json");
		const replacement = path.join(agentDir, "models.next.json");
		const originalModels = existsSync(modelsJson) ? readFileSync(modelsJson) : undefined;
		const originalReplacement = existsSync(replacement) ? readFileSync(replacement) : undefined;
		const docker = (args: string[]): string => execFileSync("docker", args, { encoding: "utf-8" }).trim();
		const containerLabels = (containerId: string): Record<string, string> => JSON.parse(docker([
			"inspect", "--format", "{{json .Config.Labels}}", containerId,
		]));
		const volumeLabels = (volume: string): Record<string, string> => JSON.parse(docker([
			"volume", "inspect", "--format", "{{json .Labels}}", volume,
		]));
		const mountedModels = (containerId: string): string => docker([
			"exec", containerId, "cat", "/home/node/.bobbit/agent/models.json",
		]);
		const workspaceOwnership = (containerId: string): string => docker([
			"exec", containerId, "stat", "-c", "%U:%G", "/workspace",
		]);
		const exists = (containerId: string): boolean => {
			try {
				execFileSync("docker", ["inspect", containerId], { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		};
		const volumeExists = (volume: string): boolean => {
			try {
				execFileSync("docker", ["volume", "inspect", volume], { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		};
		const removeSeededResources = (runId: string): void => {
			const expectedLabels = { "bobbit-project": projectId, "bobbit-e2e-run": runId };
			let containerIds: string[] = [];
			try {
				containerIds = docker([
					"ps", "-aq", "--filter", `label=bobbit-project=${projectId}`,
					"--filter", `label=bobbit-e2e-run=${runId}`,
				]).split(/\s+/).filter(Boolean);
			} catch { /* Docker cleanup is best effort after an assertion failure. */ }
			for (const containerId of containerIds) {
				try {
					const labels = containerLabels(containerId);
					if (labels["bobbit-project"] === expectedLabels["bobbit-project"] && labels["bobbit-e2e-run"] === expectedLabels["bobbit-e2e-run"]) {
						docker(["rm", "-f", containerId]);
					}
				} catch { /* Container may already have been removed by remount. */ }
			}
			for (const volume of Object.values(projectSandboxVolumeNames(projectId, runId))) {
				try {
					const labels = volumeLabels(volume);
					if (labels["bobbit-project"] === projectId && labels["bobbit-e2e-run"] === runId) {
						docker(["volume", "rm", "-f", volume]);
					}
				} catch { /* Volume was not created or has already been removed. */ }
			}
		};
		try {
			mkdirSync(source, { recursive: true });
			docker(["image", "inspect", "bobbit-agent"]);
			execFileSync("git", ["init"], { cwd: source, stdio: "ignore" });
			writeFileSync(path.join(source, "README.md"), "sandbox source\n");
			execFileSync("git", ["add", "README.md"], { cwd: source, stdio: "ignore" });
			execFileSync("git", ["-c", "user.name=Bobbit", "-c", "user.email=bobbit@bobbit.ai", "commit", "-m", "sandbox source"], { cwd: source, stdio: "ignore" });
			mkdirSync(agentDir, { recursive: true });
			const publishedV1 = JSON.stringify({
				providers: {
					aigw: {
						baseUrl: "https://gateway.example",
						apiKey: "none",
						api: "openai-completions",
						models: [{
							id: "model-o1-lookalike",
							name: "Exact Custom Model",
							api: "openai-completions",
							baseUrl: "https://gateway.example/custom/v1",
							contextWindow: 73_000,
							maxTokens: 9_000,
							reasoning: false,
							input: ["text"],
							cost: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0 },
						}],
						"x-bobbit-managed": { kind: "aigw-publication", version: 1 },
					},
				},
			});
			const publishedV2 = JSON.stringify({
				providers: {
					aigw: {
						baseUrl: "https://gateway.example",
						apiKey: "none",
						api: "openai-completions",
						models: [{
							id: "model-o1-lookalike",
							name: "Exact Custom Model",
							api: "openai-completions",
							baseUrl: "https://gateway.example/custom/v1",
							contextWindow: 91_000,
							maxTokens: 11_000,
							reasoning: false,
							input: ["text", "image"],
							cost: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0 },
						}],
						"x-bobbit-managed": { kind: "aigw-publication", version: 1 },
					},
				},
			});
			writeFileSync(modelsJson, `${publishedV1}\n`);

			const createSandbox = () => new ProjectSandbox({
				projectId,
				projectDir: root,
				repoUrl: "file:///workspace-src",
				cloneSource: { kind: "mounted", hostPath: source, mountPath: "/workspace-src", cloneUrl: "file:///workspace-src" },
				image: "bobbit-agent",
			});
			process.env.BOBBIT_E2E_RUN_ID = runA;
			const sandboxA = createSandbox();
			await sandboxA.init();
			const initialA = await sandboxA.getContainerId();

			process.env.BOBBIT_E2E_RUN_ID = runB;
			const sandboxB = createSandbox();
			await sandboxB.init();
			const initialB = await sandboxB.getContainerId();
			const volumesA = Object.values(projectSandboxVolumeNames(projectId, runA));
			const volumesB = Object.values(projectSandboxVolumeNames(projectId, runB));
			expect(volumesA).not.toEqual(volumesB);
			for (const [runId, containerId, volumes] of [[runA, initialA, volumesA], [runB, initialB, volumesB]] as const) {
				expect(containerLabels(containerId)).toMatchObject({ "bobbit-project": projectId, "bobbit-e2e-run": runId });
				expect(workspaceOwnership(containerId)).toBe("node:node");
				for (const volume of volumes) {
					expect(volume).toContain(`-e2e-${runId}`);
					expect(volumeLabels(volume)).toMatchObject({ "bobbit-project": projectId, "bobbit-e2e-run": runId });
				}
			}
			expect(mountedModels(initialA)).toBe(publishedV1);

			writeFileSync(replacement, `${publishedV2}\n`);
			renameSync(replacement, modelsJson);
			// A sandbox's owner was captured at construction. An unrelated ambient
			// value must not retarget its lookup/removal/replacement lifecycle.
			process.env.BOBBIT_E2E_RUN_ID = `ambient-retarget-${randomUUID()}`;
			await sandboxA.refreshAgentModelMount();
			const recreatedA = await sandboxA.getContainerId();
			expect(recreatedA).not.toBe(initialA);
			expect(exists(initialA)).toBe(false);
			expect(containerLabels(recreatedA)).toMatchObject({ "bobbit-project": projectId, "bobbit-e2e-run": runA });
			const restoredPublication = mountedModels(recreatedA);
			expect(restoredPublication).toBe(publishedV2);
			expect(JSON.parse(restoredPublication).providers.aigw.models[0]).toMatchObject({
				id: "model-o1-lookalike",
				contextWindow: 91_000,
				maxTokens: 11_000,
				reasoning: false,
				input: ["text", "image"],
			});

			// Run B has the same project ID but a distinct E2E ownership label.
			// Its container and its independently labelled named volumes must survive.
			expect(exists(initialB)).toBe(true);
			expect(containerLabels(initialB)).toMatchObject({ "bobbit-project": projectId, "bobbit-e2e-run": runB });
			for (const volume of volumesB) {
				expect(volumeLabels(volume)).toMatchObject({ "bobbit-project": projectId, "bobbit-e2e-run": runB });
			}

			// Destruction must use that same captured owner rather than the now-
			// ambient Run B owner, which would otherwise delete sibling volumes.
			process.env.BOBBIT_E2E_RUN_ID = runB;
			await sandboxA.destroy();
			expect(exists(recreatedA)).toBe(false);
			for (const volume of volumesA) expect(volumeExists(volume)).toBe(false);
			expect(exists(initialB)).toBe(true);
			for (const volume of volumesB) {
				expect(volumeLabels(volume)).toMatchObject({ "bobbit-project": projectId, "bobbit-e2e-run": runB });
			}
		} finally {
			removeSeededResources(runA);
			removeSeededResources(runB);
			if (originalModels) writeFileSync(modelsJson, originalModels);
			else rmSync(modelsJson, { force: true });
			if (originalReplacement) writeFileSync(replacement, originalReplacement);
			else rmSync(replacement, { force: true });
			if (originalRunId === undefined) delete process.env.BOBBIT_E2E_RUN_ID;
			else process.env.BOBBIT_E2E_RUN_ID = originalRunId;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Empty root-owned named volumes are recoverable after a failed create.
// ---------------------------------------------------------------------------

test.describe("sandbox ownership recovery", () => {
	test("repairs a pre-created empty root-owned worktrees volume", async () => {
		test.skip(!isDockerAvailable(), "Docker not available");
		const root = mkdtempSync(path.join(tmpdir(), "bobbit-worktrees-recovery-"));
		const source = path.join(root, "source");
		const projectId = `worktrees-recovery-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const priorRunId = process.env.BOBBIT_E2E_RUN_ID;
		const volumes = projectSandboxVolumeNames(projectId, runId);
		const docker = (args: string[]): string => execFileSync("docker", args, { encoding: "utf-8" }).trim();
		let sandbox: ProjectSandbox | undefined;
		try {
			docker(["image", "inspect", "bobbit-agent"]);
			mkdirSync(source, { recursive: true });
			execFileSync("git", ["init"], { cwd: source, stdio: "ignore" });
			writeFileSync(path.join(source, "README.md"), "sandbox source\n");
			execFileSync("git", ["add", "README.md"], { cwd: source, stdio: "ignore" });
			execFileSync("git", ["-c", "user.name=Bobbit", "-c", "user.email=bobbit@bobbit.ai", "commit", "-m", "sandbox source"], { cwd: source, stdio: "ignore" });

			// This models a first create which allocated the volume but died before
			// its ownership-repair exec. Docker initializes named-volume roots as root.
			docker([
				"volume", "create",
				"--label", `bobbit-project=${projectId}`,
				"--label", `bobbit-e2e-run=${runId}`,
				"--label", `bobbit-volume-initialization=${randomUUID()}`,
				volumes.worktrees,
			]);

			process.env.BOBBIT_E2E_RUN_ID = runId;
			sandbox = new ProjectSandbox({
				projectId,
				projectDir: root,
				repoUrl: "file:///workspace-src",
				cloneSource: { kind: "mounted", hostPath: source, mountPath: "/workspace-src", cloneUrl: "file:///workspace-src" },
				image: "bobbit-agent",
			});
			await sandbox.init();
			const containerId = await sandbox.getContainerId();

			expect(docker(["exec", containerId, "stat", "-c", "%U:%G", "/workspace-wt"])).toBe("node:node");
			expect(docker(["exec", containerId, "find", "/workspace-wt", "-mindepth", "1", "-maxdepth", "1", "-print", "-quit"])).toBe("");
		} finally {
			await sandbox?.destroy().catch(() => {});
			for (const volume of Object.values(volumes)) {
				try { docker(["volume", "rm", "-f", volume]); } catch { /* best-effort cleanup */ }
			}
			if (priorRunId === undefined) delete process.env.BOBBIT_E2E_RUN_ID;
			else process.env.BOBBIT_E2E_RUN_ID = priorRunId;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// process_exit event handling (no Docker needed)
// ---------------------------------------------------------------------------

test.describe("process_exit event handling", () => {

	test("process_exit transitions session to terminated", async ({ gateway }) => {
		// 1. Create a session via API
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(createResp.status).toBe(201);
		const { id } = await createResp.json();

		// 2. Wait for the session to become idle
		await waitForSessionStatus(id, "idle", 15_000);

		// 3. Connect WebSocket to observe status changes
		const conn = await connectWs(id);

		try {
			// 4. Access the session's RPC client and emit a synthetic process_exit event
			const session = gateway.sessionManager.getSession(id);
			expect(session).toBeTruthy();

			// The RPC bridge has private eventListeners — access them to simulate
			// the event that would fire when the agent process dies
			const rpcClient = session!.rpcClient;
			const listeners = (rpcClient as any).eventListeners as Array<(event: any) => void>;
			expect(listeners.length).toBeGreaterThan(0);

			// Emit a synthetic process_exit event
			for (const listener of listeners) {
				try {
					listener({ type: "process_exit", code: 1, signal: null });
				} catch { /* listener errors are non-fatal, matching RpcBridge behavior */ }
			}

			// 5. Verify session transitions to terminated via WebSocket
			const statusMsg = await conn.waitFor(statusPredicate("terminated"), 5_000);
			expect(statusMsg).toBeTruthy();
			expect(statusMsg.type).toBe("session_status");
			expect(statusMsg.status).toBe("terminated");

			// 6. Verify session status via REST API
			const statusResp = await apiFetch(`/api/sessions/${id}`);
			expect(statusResp.status).toBe(200);
			const statusData = await statusResp.json();
			expect(statusData.status).toBe("terminated");
		} finally {
			conn.close();
			await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("process_exit clears streaming state in persisted store", async ({ gateway }) => {
		// 1. Create a session
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(createResp.status).toBe(201);
		const { id } = await createResp.json();

		await waitForSessionStatus(id, "idle", 15_000);

		try {
			// 2. Simulate process_exit
			const session = gateway.sessionManager.getSession(id);
			expect(session).toBeTruthy();

			const listeners = (session!.rpcClient as any).eventListeners as Array<(event: any) => void>;
			for (const listener of listeners) {
				try {
					listener({ type: "process_exit", code: 137, signal: "SIGKILL" });
				} catch { /* non-fatal */ }
			}

			// 3. Wait for status transition
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${id}`);
				const data = await resp.json();
				return data.status;
			}, { timeout: 5_000 }).toBe("terminated");

			// 4. Verify persisted store was updated (wasStreaming cleared)
			const persisted = gateway.sessionManager.getPersistedSession(id);
			expect(persisted).toBeTruthy();
			expect(persisted.wasStreaming).toBeFalsy();
		} finally {
			await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("process_exit from streaming session transitions to terminated", async ({ gateway }) => {
		// 1. Create a session
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(createResp.status).toBe(201);
		const { id } = await createResp.json();

		await waitForSessionStatus(id, "idle", 15_000);

		// 2. Connect WebSocket and start a streaming turn
		const conn = await connectWs(id);

		try {
			// Send a message to trigger streaming
			conn.send({ type: "prompt", text: "Hello test" });

			// Wait briefly for the agent to start processing
			await conn.waitFor(
				(m) => m.type === "session_status" && m.status === "streaming",
				5_000,
			);

			// 3. While streaming, emit process_exit (simulating container kill)
			const session = gateway.sessionManager.getSession(id);
			expect(session).toBeTruthy();
			expect(session!.status).toBe("streaming");

			const listeners = (session!.rpcClient as any).eventListeners as Array<(event: any) => void>;
			for (const listener of listeners) {
				try {
					listener({ type: "process_exit", code: 137, signal: "SIGKILL" });
				} catch { /* non-fatal */ }
			}

			// 4. Should transition to terminated
			const statusMsg = await conn.waitFor(statusPredicate("terminated"), 5_000);
			expect(statusMsg.status).toBe("terminated");
		} finally {
			conn.close();
			await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
