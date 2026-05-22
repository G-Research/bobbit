/**
 * API coverage split out from browser session stories.
 *
 * Browser stories keep UI behavior coverage; these persistence/worktree
 * assertions do not need a spawned browser gateway.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	gitCwd,
	waitForSessionStatus,
} from "./e2e-setup.js";

test.describe("Session story API invariants", () => {
	const sessionIds: string[] = [];

	test.afterEach(async () => {
		for (const id of sessionIds.splice(0)) {
			await deleteSession(id).catch(() => {});
		}
	});

	test("S-08: session in git repo gets a worktree", async () => {
		const sessionId = await createSession({ cwd: gitCwd() });
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.ok).toBe(true);
		const data = await resp.json();

		expect(data.worktreePath).toBeTruthy();
		expect(typeof data.worktreePath).toBe("string");
	});

	test("S-09/S-10: renamed title and session properties persist", async () => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);

		const patchResp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "My Custom Title", colorIndex: 5 }),
		});
		expect(patchResp.ok).toBe(true);

		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(resp.ok).toBe(true);
			const data = await resp.json();
			expect(data.title).toBe("My Custom Title");
			expect(data.colorIndex).toBe(5);
		}).toPass({ timeout: 5_000 });
	});
});
