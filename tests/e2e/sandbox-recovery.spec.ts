/**
 * E2E tests for sandbox container resilience — process_exit event handling
 * plus the narrow live-Docker models.json inode-remount contract.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./in-process-harness.js";
import { ProjectSandbox } from "../../src/server/agent/project-sandbox.js";
import { toDockerPath } from "../../src/server/agent/rpc-bridge.js";
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
	test("ProjectSandbox recreation remounts the atomically published inode", async () => {
		test.skip(!isDockerAvailable(), "Docker not available");
		test.setTimeout(60_000);
		const root = mkdtempSync(path.join(tmpdir(), "bobbit-model-remount-"));
		const modelsJson = path.join(root, "models.json");
		const replacement = path.join(root, "models.next.json");
		const prefix = `bobbit-remount-${process.pid}-${Date.now()}`;
		let activeName = `${prefix}-0`;
		let activeId = "";
		const createContainer = (name: string): string => execFileSync("docker", [
			"run", "-d", "--name", name,
			"-v", `${toDockerPath(modelsJson)}:/tmp/models.json:ro`,
			"bobbit-agent", "sh", "-c", "while true; do sleep 3600; done",
		], { encoding: "utf-8", timeout: 30_000 }).trim();
		const readMounted = (containerId: string): string => execFileSync(
			"docker", ["exec", containerId, "cat", "/tmp/models.json"],
			{ encoding: "utf-8", timeout: 10_000 },
		).trim();
		try {
			writeFileSync(modelsJson, '{"generation":0}\n');
			activeId = createContainer(activeName);
			expect(readMounted(activeId)).toBe('{"generation":0}');

			writeFileSync(replacement, '{"generation":1}\n');
			renameSync(replacement, modelsJson);
			// Docker still exposes the old bound inode until recreation.
			expect(readMounted(activeId)).toBe('{"generation":0}');

			const sandbox = new ProjectSandbox({
				projectId: `${prefix}-project`,
				projectDir: root,
				repoUrl: "https://example.test/repo.git",
				image: "bobbit-agent",
			});
			(sandbox as any).containerId = activeId;
			(sandbox as any)._status = "ready";
			(sandbox as any)._initContainer = async () => {
				activeName = `${prefix}-1`;
				activeId = createContainer(activeName);
				(sandbox as any).containerId = activeId;
			};

			await sandbox.refreshAgentModelMount();
			expect(readMounted(await sandbox.getContainerId())).toBe('{"generation":1}');
		} finally {
			for (const suffix of ["0", "1"]) {
				try { execFileSync("docker", ["rm", "-f", `${prefix}-${suffix}`], { stdio: "ignore", timeout: 10_000 }); } catch { /* best effort */ }
			}
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
