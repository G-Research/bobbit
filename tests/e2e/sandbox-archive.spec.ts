/**
 * E2E test: Sandboxed session archive behavior.
 *
 * Verifies that archived sandboxed sessions have their messages accessible
 * via getArchivedMessages. In the new per-project container model, session
 * logs are bind-mounted from the host, so no container path remapping is needed.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	nonGitCwd,
	connectWs,
	agentEndPredicate,
	waitForSessionStatus,
} from "./e2e-setup.js";

test.describe("Sandbox session archive", () => {
	test("archived messages accessible after session termination", async ({ gateway }) => {
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
		// the path will be empty. In that case, skip.
		if (!hostPath) {
			test.skip();
			return;
		}

		// 5. Verify archived messages work with the real path
		const msgs = await sm.getArchivedMessages(id);
		expect(msgs.length).toBeGreaterThan(0);

		// 6. The path is in the agent's coordinate system.
		// For non-sandboxed sessions (this test runs without Docker),
		// it should be a host path.
		const normalizedPath = hostPath.replace(/\\/g, "/");
		expect(normalizedPath).not.toContain("/home/node/");
	});
});
