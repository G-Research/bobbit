/**
 * Reproducing tests for archived sidebar query search API support.
 *
 * These tests pin the backend contract needed by the sidebar archived filter:
 * q must filter the full archived corpus before pagination, not the current
 * page after normal archived pagination.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, defaultProjectId, deleteGoal, nonGitCwd } from "./_e2e/e2e-setup.js";

const REPRO = "ARCHIVED_QUERY_SEARCH_REPRO";
const QUERY = "coverage";

function setArchivedSessionTime(gateway: any, sessionId: string, archivedAt: number): void {
	gateway.sessionManager.updateArchivedMeta(sessionId, { archivedAt } as any);
}

function setArchivedGoalTime(gateway: any, goalId: string, archivedAt: number): void {
	for (const ctx of gateway.projectContextManager.visible()) {
		if (ctx.goalStore.update(goalId, { archivedAt } as any)) return;
	}
	throw new Error(`${REPRO}: failed to set archivedAt for goal ${goalId}`);
}

async function createCoverageRole(): Promise<string> {
	const roleName = `coverage-repro-role-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
	const resp = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({
			name: roleName,
			label: "Coverage Repro Role",
			promptTemplate: "Role used by archived query search reproducing tests.",
		}),
	});
	expect(resp.status, `${REPRO}: failed to create role`).toBe(201);
	return roleName;
}

async function deleteRole(roleName: string | undefined): Promise<void> {
	if (!roleName) return;
	await apiFetch(`/api/roles/${encodeURIComponent(roleName)}`, { method: "DELETE" }).catch(() => {});
}

async function createSessionWithMeta(opts: { title: string; roleId?: string; goalId?: string }): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			cwd: nonGitCwd(),
			projectId: await defaultProjectId(),
			goalId: opts.goalId,
			roleId: opts.roleId,
		}),
	});
	expect(resp.status, `${REPRO}: failed to create session`).toBe(201);
	const { id } = await resp.json();

	const patchResp = await apiFetch(`/api/sessions/${id}`, {
		method: "PATCH",
		body: JSON.stringify({ title: opts.title }),
	});
	expect(patchResp.ok, `${REPRO}: failed to set session title`).toBe(true);
	return id;
}

async function archiveSession(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `${REPRO}: failed to archive session ${id}`).toBe(true);
}

async function getArchivedSessionPage(q: string, limit: number, after?: number): Promise<any> {
	const params = new URLSearchParams({ include: "archived", q, limit: String(limit) });
	if (after !== undefined) params.set("after", String(after));
	const resp = await apiFetch(`/api/sessions?${params}`);
	expect(resp.status, `${REPRO}: archived sessions query request failed`).toBe(200);
	return resp.json();
}

async function getArchivedGoalPage(q: string, limit: number, after?: number): Promise<any> {
	const params = new URLSearchParams({ archived: "true", q, limit: String(limit) });
	if (after !== undefined) params.set("after", String(after));
	const resp = await apiFetch(`/api/goals?${params}`);
	expect(resp.status, `${REPRO}: archived goals query request failed`).toBe(200);
	return resp.json();
}

function archivedOnly(sessions: any[]): any[] {
	return sessions.filter((s: any) => s?.archived === true || s?.status === "archived");
}

test.describe("archived query search API repro", () => {
	test("sessions q filters by title or role across the full archived corpus before pagination", async ({ gateway }) => {
		let roleName: string | undefined;
		const createdSessions: string[] = [];
		const baseArchivedAt = Date.now();
		try {
			roleName = await createCoverageRole();

			const titleMatchId = await createSessionWithMeta({ title: "Coverage Overhead archived title match" });
			createdSessions.push(titleMatchId);
			await archiveSession(titleMatchId);
			setArchivedSessionTime(gateway, titleMatchId, baseArchivedAt + 1);

			const roleMatchId = await createSessionWithMeta({ title: "Role matched archived session", roleId: roleName });
			createdSessions.push(roleMatchId);
			await archiveSession(roleMatchId);
			setArchivedSessionTime(gateway, roleMatchId, baseArchivedAt + 2);

			const nonMatchId = await createSessionWithMeta({ title: "Newest unrelated archived session" });
			createdSessions.push(nonMatchId);
			await archiveSession(nonMatchId);
			setArchivedSessionTime(gateway, nonMatchId, baseArchivedAt + 3);

			const page1 = await getArchivedSessionPage(QUERY, 1);
			const page1Archived = archivedOnly(page1.sessions as any[]);
			expect(
				page1Archived.map((s: any) => s.id),
				`${REPRO}: /api/sessions?include=archived&q=${QUERY}&limit=1 must apply q before pagination and skip newer non-matching archived sessions`,
			).toEqual([roleMatchId]);
			expect(page1.total, `${REPRO}: archived session q total should count only matching title/role results`).toBe(2);
			expect(page1.hasMore, `${REPRO}: archived session q pagination should report another matching result`).toBe(true);
			expect(page1.nextCursor, `${REPRO}: archived session q pagination should return a matching-corpus cursor`).toBeDefined();

			const page2 = await getArchivedSessionPage(QUERY, 1, page1.nextCursor);
			const page2Archived = archivedOnly(page2.sessions as any[]);
			expect(
				page2Archived.map((s: any) => s.id),
				`${REPRO}: archived session q cursor should page through only matching archived title/role results`,
			).toEqual([titleMatchId]);
			expect(page2.hasMore, `${REPRO}: archived session q second page should exhaust matching results`).toBe(false);
		} finally {
			for (const id of createdSessions.reverse()) {
				await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
			}
			await deleteRole(roleName);
		}
	});

	test("goals q filters by goal title or affiliated archived session title/role before pagination", async ({ gateway }) => {
		let roleName: string | undefined;
		const createdGoals: string[] = [];
		const createdSessions: string[] = [];
		const baseArchivedAt = Date.now();
		let goalOrder = 0;
		async function createArchivedGoalWithOptionalSession(opts: { goalTitle: string; sessionTitle?: string; sessionRoleId?: string }): Promise<{ goalId: string; sessionId?: string }> {
			const goal = await createGoal({ title: opts.goalTitle });
			const goalId = goal.id as string;
			createdGoals.push(goalId);
			let sessionId: string | undefined;
			if (opts.sessionTitle || opts.sessionRoleId) {
				sessionId = await createSessionWithMeta({
					goalId,
					title: opts.sessionTitle ?? "Affiliated role-only archived session",
					roleId: opts.sessionRoleId,
				});
				createdSessions.push(sessionId);
				await archiveSession(sessionId);
				setArchivedSessionTime(gateway, sessionId, baseArchivedAt + 100 + goalOrder);
			}
			await deleteGoal(goalId);
			goalOrder += 1;
			setArchivedGoalTime(gateway, goalId, baseArchivedAt + goalOrder);
			return { goalId, sessionId };
		}

		try {
			roleName = await createCoverageRole();

			const titleGoal = await createArchivedGoalWithOptionalSession({ goalTitle: "Coverage archived goal title match" });
			const sessionTitleGoal = await createArchivedGoalWithOptionalSession({
				goalTitle: "Affiliated title goal without query in title",
				sessionTitle: "Coverage affiliated archived session title match",
			});
			const sessionRoleGoal = await createArchivedGoalWithOptionalSession({
				goalTitle: "Affiliated role goal without query in title",
				sessionTitle: "Affiliated role-only archived session",
				sessionRoleId: roleName,
			});
			await createArchivedGoalWithOptionalSession({ goalTitle: "Newest unrelated archived goal" });

			const page1 = await getArchivedGoalPage(QUERY, 2);
			expect(
				(page1.goals as any[]).map((g: any) => g.id),
				`${REPRO}: /api/goals?archived=true&q=${QUERY}&limit=2 must apply q before pagination across goal title and affiliated archived session title/role`,
			).toEqual([sessionRoleGoal.goalId, sessionTitleGoal.goalId]);
			expect(page1.total, `${REPRO}: archived goal q total should count only matching goal/session title/role results`).toBe(3);
			expect(page1.hasMore, `${REPRO}: archived goal q pagination should report another matching result`).toBe(true);
			expect(page1.nextCursor, `${REPRO}: archived goal q pagination should return a matching-corpus cursor`).toBeDefined();
			expect(
				(page1.archivedSessions as any[]).map((s: any) => s.id),
				`${REPRO}: archived goal q response should include affiliated archived sessions for matching goal page`,
			).toEqual(expect.arrayContaining([sessionRoleGoal.sessionId, sessionTitleGoal.sessionId]));

			const page2 = await getArchivedGoalPage(QUERY, 2, page1.nextCursor);
			expect(
				(page2.goals as any[]).map((g: any) => g.id),
				`${REPRO}: archived goal q cursor should page through only matching goals`,
			).toEqual([titleGoal.goalId]);
			expect(page2.hasMore, `${REPRO}: archived goal q second page should exhaust matching results`).toBe(false);
		} finally {
			for (const id of createdSessions.reverse()) {
				await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
			}
			for (const id of createdGoals.reverse()) {
				await deleteGoal(id).catch(() => {});
			}
			await deleteRole(roleName);
		}
	});
});
