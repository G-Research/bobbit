/**
 * E2E tests for sandbox container resilience — process_exit event handling.
 *
 * Tests:
 * 1. `process_exit` event transitions session to `terminated` (no Docker needed)
 *
 * Docker-dependent tests (container health monitor, session recovery, worktree
 * branches) have been moved to sandbox-recovery-docker.spec.ts and run via
 * `npm run test:manual` instead.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	nonGitCwd,
	connectWs,
	waitForSessionStatus,
	statusPredicate,
} from "./e2e-setup.js";

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
