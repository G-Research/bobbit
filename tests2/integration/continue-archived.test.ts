/**
 * API E2E tests for Continue-Archived (POST /api/sessions/:archivedId/continue).
 *
 * Lossless flow:
 *   - Source `.jsonl` is cloned into a fresh slot under <globalAgentDir()>/sessions/.
 *   - The new session's `agentSessionFile` field points at the clone.
 *   - The agent CLI rehydrates from the clone via `switch_session`.
 *   - There is no seed-mode parameter, no system-prompt seeding, no byte cap.
 */

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, nonGitCwd, createSession as createSessionFromHarness } from "./_e2e/e2e-setup.js";
import {
	createSessionTracker,
	localApiFetch,
	seedArchivedSession,
	trackGoal,
	waitForSessionIdle,
} from "./helpers/session-fixtures.js";
import fs from "node:fs";

// ── Helpers ───────────────────────────────────────────────────────────────

const sessions = createSessionTracker();

async function archive(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `archive ${id}: ${resp.status}`).toBe(true);
}

async function getArchivedRec(id: string): Promise<any> {
	const arch = await (await apiFetch("/api/sessions?include=archived")).json();
	return (arch.sessions as any[]).find(s => s.id === id) || null;
}

async function makeArchivedSourceSession(gateway: any, opts?: {
	promptText?: string;
	roleId?: string;
}): Promise<string> {
	return sessions.add(seedArchivedSession(gateway, {
		cwd: nonGitCwd(),
		...(opts?.roleId ? { role: opts.roleId } : {}),
	}, [{
		role: "user",
		text: opts?.promptText || "Hello from the original session, please acknowledge.",
	}]));
}

async function trackContinuedSession(resp: Response): Promise<void> {
	if (resp.status !== 201) return;
	const data = await resp.clone().json();
	if (data?.id) sessions.add(data.id);
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe("Continue-Archived API (lossless)", () => {
	test.afterEach(async ({ gateway }) => sessions.cleanup(gateway));
	test("happy path: returns 201 with Continued: title and a fresh session id", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway, {
			promptText: "UNIQUE_MARKER_ALPHA hello world",
		});

		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessions.add(data.id);
		expect(data.id).toBeTruthy();
		expect(data.id).not.toBe(archivedId);
		expect(data.title).toMatch(/^Continued: /);

		// switch_session completes in the create pipeline; observe its live state
		// directly instead of polling the REST representation.
		await waitForSessionIdle(gateway, data.id);
		expect(gateway.sessionManager.getSession(data.id)?.status).toBe("idle");
	});

	test("body fields are ignored — legacy {mode:'summary'} no longer 400s", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway);

		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({ mode: "summary" }),
		});
		expect(resp.status).toBe(201);
		await trackContinuedSession(resp);
	});

	test("empty body returns 201", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway);
		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: "",
		});
		expect(resp.status).toBe(201);
		await trackContinuedSession(resp);
	});

	test("title format: 'Continued: <original title>' and survives first prompt", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway);
		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessions.add(data.id);

		const before = gateway.sessionManager.getPersistedSession(data.id)?.title;
		expect(before?.startsWith("Continued: ")).toBe(true);

		// markGenerated:true protects the title from the first-prompt auto-titler.
		const prompt = await gateway.sessionManager.enqueuePrompt(data.id, "hi");
		expect(prompt.status).toBe("dispatched");
		await waitForSessionIdle(gateway, data.id);
		expect(gateway.sessionManager.getPersistedSession(data.id)?.title).toBe(before);
	});

	test("unknown session returns 404", async ({ gateway }) => {
		const resp = await localApiFetch(gateway, `/api/sessions/does-not-exist-abc123/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(404);
	});

	test("not-archived (live) session returns 409", async ({ gateway }) => {
		const liveId = sessions.add(await createSessionFromHarness());
		try {
			const resp = await localApiFetch(gateway, `/api/sessions/${liveId}/continue`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(resp.status).toBe(409);
		} finally {
			await archive(liveId).catch(() => {});
		}
	});

	test("goal-linked session returns 422", async ({ gateway }) => {
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Archived goal test", cwd: nonGitCwd(), team: false, worktree: false, workflowId: "general" }),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		trackGoal(goal.id);
		const sid = sessions.add(seedArchivedSession(gateway, {
			cwd: nonGitCwd(),
			goalId: goal.id,
		}));

		const resp = await localApiFetch(gateway, `/api/sessions/${sid}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(422);
	});

	test("delegate session returns 422", async ({ gateway }) => {
		const delegateId = sessions.add(seedArchivedSession(gateway, {
			cwd: nonGitCwd(),
			delegateOf: "fixture-parent-session",
		}));

		const resp = await localApiFetch(gateway, `/api/sessions/${delegateId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(422);
	});

	test("assistant session (assistantType) is now allowed — returns 201", async ({ gateway }) => {
		// Path B of the Reopen-Archived-Proposals design: assistant sessions can
		// now be continued. The 422 block remains only for goal/delegate/team
		// sessions (covered by sibling tests above).
		const sid = sessions.add(seedArchivedSession(gateway, {
			cwd: nonGitCwd(),
			assistantType: "goal",
		}, [{ role: "user", text: "assistant init" }]));

		const cont = await localApiFetch(gateway, `/api/sessions/${sid}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(cont.status).toBe(201);
		const data = await cont.json();
		sessions.add(data.id);
		expect(data.id).toBeTruthy();
		expect(data.id).not.toBe(sid);
		expect(data.assistantType).toBe("goal");
	});

	test("role copied to new session", async ({ gateway }) => {
		const archivedId = await makeArchivedSourceSession(gateway, { roleId: "general" });
		const resp = await localApiFetch(gateway, `/api/sessions/${archivedId}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessions.add(data.id);
		expect(gateway.sessionManager.getPersistedSession(data.id)?.role).toBe("general");
	});

	test("archived session with empty .jsonl returns 404", async ({ gateway }) => {
		const id = sessions.add(seedArchivedSession(gateway, { cwd: nonGitCwd() }, []));

		const rec = await getArchivedRec(id);
		if (rec?.agentSessionFile && fs.existsSync(rec.agentSessionFile)) {
			fs.writeFileSync(rec.agentSessionFile, "");
		}

		const cont = await localApiFetch(gateway, `/api/sessions/${id}/continue`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(cont.status).toBe(404);
	});
});
