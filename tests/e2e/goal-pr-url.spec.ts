/**
 * E2E test: Goal.prUrl is dropped — PrStatusStore is the single source of truth
 * for the re-attempt-context PR URL line.
 *
 * Verifies:
 *  A. PUT /api/goals/:id silently ignores `prUrl` (no 400, field not stored).
 *  B. Re-attempt session prompt includes `**PR URL:**` line when PrStatusStore
 *     has a URL for that goal id (seeded via the in-process server's store).
 *  C. Empty PrStatusStore omits the line cleanly.
 */
import { test, expect } from "./in-process-harness.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiFetch, defaultProjectId, nonGitCwd } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

async function createGoal(opts?: { title?: string }): Promise<{ id: string; projectId: string }> {
	const projectId = await defaultProjectId();
	expect(projectId, "default projectId should be available").toBeTruthy();
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: opts?.title ?? `pr-url-test ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: nonGitCwd(),
			team: false,
			workflowId: "general",
			projectId,
		}),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json();
	return { id: goal.id, projectId: projectId! };
}

async function deleteGoal(id: string): Promise<void> {
	await apiFetch(`/api/goals/${id}?cascade=true`, { method: "DELETE" }).catch(() => {});
}

test.describe("Goal.prUrl removal — PrStatusStore is source of truth", () => {
	test("PUT /api/goals/:id silently ignores prUrl field", async () => {
		const { id } = await createGoal();
		try {
			// Send PUT with prUrl — should be 200 and silently ignored.
			const putResp = await apiFetch(`/api/goals/${id}`, {
				method: "PUT",
				body: JSON.stringify({ prUrl: "https://example/foo" }),
			});
			expect(putResp.status).toBe(200);

			// Subsequent GET should not include prUrl on the goal.
			const getResp = await apiFetch(`/api/goals/${id}`);
			expect(getResp.status).toBe(200);
			const goal = await getResp.json();
			expect(goal.prUrl).toBeUndefined();
		} finally {
			await deleteGoal(id);
		}
	});

	test("re-attempt session prompt includes **PR URL:** when PrStatusStore has a URL", async ({ gateway }) => {
		const { id: origGoalId } = await createGoal({ title: "orig with PR" });
		try {
			// Seed the server's PrStatusStore directly via the gateway sessionManager.
			const sm = gateway.sessionManager;
			const store = sm.prStatusStore;
			expect(store, "sessionManager should expose prStatusStore").toBeTruthy();
			const seededUrl = "https://github.com/x/y/pull/424242";
			store.set(origGoalId, { state: "OPEN", url: seededUrl });

			// Create a re-attempt goal-assistant session.
			const projectId = await defaultProjectId();
			const sessResp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					assistantType: "goal",
					reattemptGoalId: origGoalId,
					projectId,
				}),
			});
			expect(sessResp.status).toBe(201);
			const sess = await sessResp.json();
			expect(sess.reattemptGoalId).toBe(origGoalId);

			// Prompt is written at <bobbitDir>/state/session-prompts/<sid>.md
			const promptPath = join(gateway.bobbitDir, "state", "session-prompts", `${sess.id}.md`);
			const prompt = await pollUntil(async () => {
				try {
					return readFileSync(promptPath, "utf-8");
				} catch {
					return null;
				}
			}, { timeoutMs: 10_000, intervalMs: 50, label: "prompt file written" });

			expect(prompt).toContain("**PR URL:** " + seededUrl);
			expect(prompt).toContain("## Re-attempt Context");

			// Cleanup session
			await apiFetch(`/api/sessions/${sess.id}`, { method: "DELETE" }).catch(() => {});
		} finally {
			await deleteGoal(origGoalId);
		}
	});

	test("re-attempt session prompt omits **PR URL:** when PrStatusStore is empty", async ({ gateway }) => {
		const { id: origGoalId } = await createGoal({ title: "orig without PR" });
		try {
			const sm = gateway.sessionManager;
			const store = sm.prStatusStore;
			// Make sure no entry exists for this goal.
			store.remove(origGoalId);

			const projectId = await defaultProjectId();
			const sessResp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					assistantType: "goal",
					reattemptGoalId: origGoalId,
					projectId,
				}),
			});
			expect(sessResp.status).toBe(201);
			const sess = await sessResp.json();

			const promptPath = join(gateway.bobbitDir, "state", "session-prompts", `${sess.id}.md`);
			const prompt = await pollUntil(async () => {
				try {
					return readFileSync(promptPath, "utf-8");
				} catch {
					return null;
				}
			}, { timeoutMs: 10_000, intervalMs: 50, label: "prompt file written" });

			expect(prompt).toContain("## Re-attempt Context");
			expect(prompt).not.toContain("**PR URL:");

			await apiFetch(`/api/sessions/${sess.id}`, { method: "DELETE" }).catch(() => {});
		} finally {
			await deleteGoal(origGoalId);
		}
	});
});
