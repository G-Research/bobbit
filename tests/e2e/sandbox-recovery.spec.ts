/**
 * E2E tests for sandbox container resilience — auto-recovery on container death.
 *
 * Tests:
 * 1. `process_exit` event transitions session to `terminated` (no Docker needed)
 * 2. Container health monitor detects death and recreates container (Docker required)
 * 3. Sandbox sessions recover after container death (Docker required)
 * 4. Worktree branches intact after recovery (Docker required)
 *
 * The non-Docker test (Test 1) uses the in-process harness to directly access
 * the session manager and simulate RPC events. Docker-dependent tests skip when
 * Docker is unavailable.
 */
import { execFileSync } from "node:child_process";
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	nonGitCwd,
	connectWs,
	waitForSessionStatus,
	statusPredicate,
	agentEndPredicate,
} from "./e2e-setup.js";

function isDockerAvailable(): boolean {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Test 1: process_exit event handling (no Docker required)
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

// ---------------------------------------------------------------------------
// Docker-dependent tests: container health monitor and session recovery
// ---------------------------------------------------------------------------

test.describe("sandbox container recovery", () => {
	const hasDocker = isDockerAvailable();

	test.describe.configure({ mode: "serial" });

	test("health monitor detects container death and recreates", async ({ gateway }) => {
		test.skip(!hasDocker, "Docker not available");
		test.setTimeout(120_000);

		// 1. Get sandbox manager from gateway
		const sm = gateway.sessionManager;
		const sandboxManager = (sm as any).sandboxManager;

		// If sandbox manager not available, skip
		if (!sandboxManager) {
			test.skip();
			return;
		}

		// 2. Configure sandbox mode
		const configResp = await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "docker" }),
		});
		expect(configResp.status).toBe(200);

		// 3. Initialize sandbox for the default project
		const projectId = (sm as any).pcm?.getDefaultProjectId?.() || "default";
		try {
			await sandboxManager.initForProject(projectId);
		} catch (err) {
			// If init fails (e.g., no git remote configured for sandbox), skip
			test.skip();
			return;
		}

		// 4. Get the current container ID
		const sandbox = sandboxManager.get(projectId);
		if (!sandbox) {
			test.skip();
			return;
		}

		let containerId: string;
		try {
			containerId = await sandbox.getContainerId();
		} catch {
			test.skip();
			return;
		}
		expect(containerId).toBeTruthy();

		// 5. Subscribe to health events and wait for recovery
		const events: any[] = [];
		const recoveryPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Recovery timeout (90s)")), 90_000);
			sandbox.onHealthEvent((event: any) => {
				events.push(event);
				if (event.type === "container-recovered") {
					clearTimeout(timeout);
					resolve();
				}
			});
		});

		// 6. Kill the container
		execFileSync("docker", ["rm", "-f", containerId], { timeout: 10_000, stdio: "ignore" });

		// 7. Wait for recovery
		await recoveryPromise;

		// 8. Verify events sequence: container-died then container-recovered
		expect(events.some(e => e.type === "container-died")).toBe(true);
		expect(events.some(e => e.type === "container-recovered")).toBe(true);

		// 9. Verify new container is running
		const newContainerId = await sandbox.getContainerId();
		expect(newContainerId).toBeTruthy();
		expect(newContainerId).not.toBe(containerId);

		const inspectResult = execFileSync("docker", [
			"inspect", "--format", "{{.State.Running}}", newContainerId,
		], { timeout: 5_000, encoding: "utf-8" }).trim();
		expect(inspectResult).toBe("true");

		// Cleanup
		try {
			await sandboxManager.shutdownAll();
		} catch { /* best-effort */ }
		await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "none" }),
		}).catch(() => {});
	});

	test("sandbox sessions recover to idle after container death", async ({ gateway }) => {
		test.skip(!hasDocker, "Docker not available");
		test.setTimeout(180_000);

		const sm = gateway.sessionManager;
		const sandboxManager = (sm as any).sandboxManager;
		if (!sandboxManager) {
			test.skip();
			return;
		}

		// 1. Configure sandbox
		await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "docker" }),
		});

		const projectId = (sm as any).pcm?.getDefaultProjectId?.() || "default";
		try {
			await sandboxManager.initForProject(projectId);
		} catch {
			test.skip();
			return;
		}

		const sandbox = sandboxManager.get(projectId);
		if (!sandbox) { test.skip(); return; }

		let containerId: string;
		try {
			containerId = await sandbox.getContainerId();
		} catch {
			test.skip();
			return;
		}

		// 2. Create a sandboxed session
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), sandbox: true }),
		});
		expect(createResp.status).toBe(201);
		const { id: sessionId } = await createResp.json();

		await waitForSessionStatus(sessionId, "idle", 30_000);

		// 3. Send a message to create chat history
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: "Hello from sandbox recovery test" });
			await conn.waitFor(agentEndPredicate(), 30_000);
		} finally {
			conn.close();
		}

		await waitForSessionStatus(sessionId, "idle", 10_000);

		// 4. Set up recovery watcher
		const recoveryPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Session recovery timeout (90s)")), 90_000);
			sandbox.onHealthEvent((event: any) => {
				if (event.type === "container-recovered") {
					clearTimeout(timeout);
					resolve();
				}
			});
		});

		// 5. Kill the container
		execFileSync("docker", ["rm", "-f", containerId], { timeout: 10_000, stdio: "ignore" });

		// 6. Session should go terminated first (from process_exit)
		await expect.poll(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			return data.status;
		}, { timeout: 30_000, intervals: [500] }).toBe("terminated");

		// 7. Wait for container recreation + session recovery
		await recoveryPromise;

		// 8. Session should recover to idle
		await expect.poll(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			return data.status;
		}, { timeout: 60_000, intervals: [1_000] }).toBe("idle");

		// 9. Verify chat history is preserved — fetch messages
		const messagesResp = await apiFetch(`/api/sessions/${sessionId}/messages`);
		expect(messagesResp.status).toBe(200);
		const messages = await messagesResp.json();
		expect(messages.length).toBeGreaterThan(0);

		// Cleanup
		await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		try { await sandboxManager.shutdownAll(); } catch { /* best-effort */ }
		await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "none" }),
		}).catch(() => {});
	});

	test("worktree branches intact after container recovery", async ({ gateway }) => {
		test.skip(!hasDocker, "Docker not available");
		test.setTimeout(180_000);

		const sm = gateway.sessionManager;
		const sandboxManager = (sm as any).sandboxManager;
		if (!sandboxManager) { test.skip(); return; }

		// 1. Configure sandbox
		await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "docker" }),
		});

		const projectId = (sm as any).pcm?.getDefaultProjectId?.() || "default";
		try {
			await sandboxManager.initForProject(projectId);
		} catch { test.skip(); return; }

		const sandbox = sandboxManager.get(projectId);
		if (!sandbox) { test.skip(); return; }

		let containerId: string;
		try {
			containerId = await sandbox.getContainerId();
		} catch { test.skip(); return; }

		// 2. Create a sandboxed session (which gets a worktree)
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), sandbox: true }),
		});
		expect(createResp.status).toBe(201);
		const { id: sessionId } = await createResp.json();

		await waitForSessionStatus(sessionId, "idle", 30_000);

		// 3. Get the session's branch and cwd
		const session = sm.getSession(sessionId);
		expect(session).toBeTruthy();
		const sessionBranch = (session as any).branch ||
			sm.getPersistedSession(sessionId)?.branch;
		const sessionCwd = session!.cwd;

		// 4. Set up recovery watcher
		const recoveryPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Recovery timeout (90s)")), 90_000);
			sandbox.onHealthEvent((event: any) => {
				if (event.type === "container-recovered") {
					clearTimeout(timeout);
					resolve();
				}
			});
		});

		// 5. Kill the container
		execFileSync("docker", ["rm", "-f", containerId], { timeout: 10_000, stdio: "ignore" });

		// 6. Wait for recovery
		await recoveryPromise;

		// 7. Wait for session to recover
		await expect.poll(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			return data.status;
		}, { timeout: 60_000, intervals: [1_000] }).toBe("idle");

		// 8. Verify the worktree and branch exist in the new container
		const newContainerId = await sandbox.getContainerId();
		expect(newContainerId).toBeTruthy();

		if (sessionCwd?.startsWith("/workspace-wt/")) {
			// Verify the worktree directory exists
			execFileSync("docker", [
				"exec", newContainerId, "test", "-d", sessionCwd,
			], { timeout: 5_000, encoding: "utf-8" });

			// Verify the correct branch is checked out
			if (sessionBranch) {
				const branchOutput = execFileSync("docker", [
					"exec", "-w", sessionCwd, newContainerId,
					"git", "rev-parse", "--abbrev-ref", "HEAD",
				], { timeout: 5_000, encoding: "utf-8" }).trim();
				expect(branchOutput).toBe(sessionBranch);
			}
		}

		// Cleanup
		await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		try { await sandboxManager.shutdownAll(); } catch { /* best-effort */ }
		await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "none" }),
		}).catch(() => {});
	});

	test("health monitor handles repeated container kills", async ({ gateway }) => {
		test.skip(!hasDocker, "Docker not available");
		test.setTimeout(240_000);

		const sm = gateway.sessionManager;
		const sandboxManager = (sm as any).sandboxManager;
		if (!sandboxManager) { test.skip(); return; }

		// 1. Configure sandbox
		await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "docker" }),
		});

		const projectId = (sm as any).pcm?.getDefaultProjectId?.() || "default";
		try {
			await sandboxManager.initForProject(projectId);
		} catch { test.skip(); return; }

		const sandbox = sandboxManager.get(projectId);
		if (!sandbox) { test.skip(); return; }

		// --- First kill/recovery cycle ---
		let containerId: string;
		try {
			containerId = await sandbox.getContainerId();
		} catch { test.skip(); return; }

		const firstRecovery = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("First recovery timeout")), 90_000);
			const unsub = sandbox.onHealthEvent((event: any) => {
				if (event.type === "container-recovered") {
					clearTimeout(timeout);
					unsub();
					resolve();
				}
			});
		});

		execFileSync("docker", ["rm", "-f", containerId], { timeout: 10_000, stdio: "ignore" });
		await firstRecovery;

		// Verify first recovery succeeded
		const afterFirst = await sandbox.getContainerId();
		expect(afterFirst).toBeTruthy();
		expect(afterFirst).not.toBe(containerId);

		// --- Second kill/recovery cycle ---
		const secondRecovery = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Second recovery timeout")), 90_000);
			const unsub = sandbox.onHealthEvent((event: any) => {
				if (event.type === "container-recovered") {
					clearTimeout(timeout);
					unsub();
					resolve();
				}
			});
		});

		execFileSync("docker", ["rm", "-f", afterFirst], { timeout: 10_000, stdio: "ignore" });
		await secondRecovery;

		// Verify second recovery also succeeded
		const afterSecond = await sandbox.getContainerId();
		expect(afterSecond).toBeTruthy();
		expect(afterSecond).not.toBe(afterFirst);

		const inspectResult = execFileSync("docker", [
			"inspect", "--format", "{{.State.Running}}", afterSecond,
		], { timeout: 5_000, encoding: "utf-8" }).trim();
		expect(inspectResult).toBe("true");

		// Cleanup
		try { await sandboxManager.shutdownAll(); } catch { /* best-effort */ }
		await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "none" }),
		}).catch(() => {});
	});
});
