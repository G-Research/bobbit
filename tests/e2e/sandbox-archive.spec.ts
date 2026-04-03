/**
 * E2E test: Sandboxed session archive path remapping.
 *
 * Verifies that archived sandboxed sessions whose agentSessionFile was stored
 * as a container-internal path (e.g. /home/node/.bobbit/agent/...) are still
 * accessible after the fix remaps container paths on the fly.
 *
 * Bug: When a sandbox session was restored after a server restart, the
 * SessionInfo object was missing `sandboxed: true`. So persistSessionMetadata
 * stored the raw container path (/home/node/.bobbit/agent/...) instead of the
 * remapped host path. On archive, getArchivedMessages couldn't find the file.
 *
 * This test simulates the bug by tampering with the stored agentSessionFile
 * to use a container path and verifying messages are still accessible.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	nonGitCwd,
	connectWs,
	agentEndPredicate,
	waitForSessionStatus,
} from "./e2e-setup.js";

test.describe("Sandbox session archive path remapping", () => {
	test("archived messages accessible when agentSessionFile is a container path", async ({ gateway }) => {
		// 1. Create a session
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(createResp.status).toBe(201);
		const { id } = await createResp.json();

		// 2. Connect via WebSocket and send a message to produce a .jsonl
		const conn = await connectWs(id);
		try {
			conn.send({ type: "prompt", text: "Hello test" });
			await conn.waitFor(agentEndPredicate(), 30_000);
		} finally {
			conn.close();
		}

		// 3. Wait for session to be idle, then terminate
		await waitForSessionStatus(id, "idle", 10_000);
		const termResp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
		expect(termResp.status).toBe(200);

		// 4. Get the stored agentSessionFile path
		const sm = gateway.sessionManager;
		const ps = sm.getPersistedSession(id);
		expect(ps).toBeTruthy();
		const hostPath = ps.agentSessionFile;

		// If persistSessionMetadata failed (mock agent stopped before getState),
		// the path will be empty. In that case, try recovery.
		if (!hostPath) {
			// Can't test remapping without a .jsonl file — skip
			test.skip();
			return;
		}

		// 5. Verify archived messages work with the real path
		const msgs1 = sm.getArchivedMessages(id);
		expect(msgs1.length).toBeGreaterThan(0);

		// 6. Simulate the bug: construct a fake container path from the host path.
		//    The container stores files under /home/node/.bobbit/agent/<relative>
		//    containerToHostSessionPath strips /home/node/.bobbit/agent/ and joins with globalAgentDir().
		//    So we need to extract the relative path after the host agent dir.
		const normalizedHost = hostPath.replace(/\\/g, "/");
		// Find the ".bobbit/agent/" or ".pi/agent/" prefix
		const agentMarkers = [".bobbit/agent/", ".pi/agent/"];
		let relativeFromAgent = "";
		for (const marker of agentMarkers) {
			const idx = normalizedHost.indexOf(marker);
			if (idx >= 0) {
				relativeFromAgent = normalizedHost.substring(idx + marker.length);
				break;
			}
		}
		expect(relativeFromAgent.length).toBeGreaterThan(0);
		const fakeContainerPath = `/home/node/.bobbit/agent/${relativeFromAgent}`;

		// Tamper the store directly to simulate the bug
		const store = (sm as any).resolveStoreForId(id);
		store.update(id, { agentSessionFile: fakeContainerPath });

		// Verify the tampered path is stored
		const ps2 = sm.getPersistedSession(id);
		expect(ps2.agentSessionFile).toBe(fakeContainerPath);

		// 7. Verify getArchivedMessages still works (the fix remaps container paths)
		const msgs2 = sm.getArchivedMessages(id);
		expect(msgs2.length).toBeGreaterThan(0);
		expect(msgs2.length).toBe(msgs1.length);

		// 8. Verify the store was auto-corrected (the fix persists the remapped path)
		const ps3 = sm.getPersistedSession(id);
		expect(ps3.agentSessionFile).not.toContain("/home/node/");
	});

	test("restoreOneSession remaps container paths", async ({ gateway }) => {
		// 1. Create session, send message, terminate
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(createResp.status).toBe(201);
		const { id } = await createResp.json();

		const conn = await connectWs(id);
		try {
			conn.send({ type: "prompt", text: "Hello restore test" });
			await conn.waitFor(agentEndPredicate(), 30_000);
		} finally {
			conn.close();
		}

		await waitForSessionStatus(id, "idle", 10_000);
		await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });

		const sm = gateway.sessionManager;
		const ps = sm.getPersistedSession(id);
		if (!ps?.agentSessionFile) {
			test.skip();
			return;
		}
		const hostPath = ps.agentSessionFile;

		// 2. Construct fake container path (same technique as first test)
		const normalizedHost = hostPath.replace(/\\/g, "/");
		const agentMarkers = [".bobbit/agent/", ".pi/agent/"];
		let relativeFromAgent = "";
		for (const marker of agentMarkers) {
			const idx = normalizedHost.indexOf(marker);
			if (idx >= 0) {
				relativeFromAgent = normalizedHost.substring(idx + marker.length);
				break;
			}
		}
		expect(relativeFromAgent.length).toBeGreaterThan(0);
		const fakeContainerPath = `/home/node/.bobbit/agent/${relativeFromAgent}`;

		// 3. Tamper the store: set container path and un-archive
		const store = (sm as any).resolveStoreForId(id);
		store.update(id, { agentSessionFile: fakeContainerPath, archived: false });

		const ps2 = store.get(id);
		expect(ps2.agentSessionFile).toBe(fakeContainerPath);
		expect(ps2.archived).toBe(false);

		// 4. Call restoreOneSession — should remap the container path
		await (sm as any).restoreOneSession(ps2);

		// 5. Verify the path was remapped
		const ps3 = store.get(id);
		expect(ps3.agentSessionFile).not.toContain("/home/node/");

		// Cleanup: terminate the restored session
		await sm.terminateSession(id).catch(() => {});
	});
});
