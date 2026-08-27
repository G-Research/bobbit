import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	registerProject,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

const SOURCE_DIR = fileURLToPath(new URL("../../support/fixtures/browser/host-project-read", import.meta.url));
const PACK_NAME = "host-project-read-fixture";
const PANEL = '[data-testid="host-project-read-fixture-panel"]';

type LookupEnvelope = { mode: "ids"; results: Array<{ id: string; status: string; value?: Record<string, unknown> }> };
type PageEnvelope = { mode: "page"; items: Record<string, unknown>[]; page: { cursor: number; limit: number; total: number; hasMore: boolean; nextCursor?: number } };

async function responseText(response: Response): Promise<string> {
	return response.clone().text().catch(() => "");
}

async function addFixtureSource(): Promise<string> {
	const response = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	if (response.status === 409) {
		const list = await apiFetch("/api/marketplace/sources");
		const source = ((await list.json()).sources ?? []).find((item: { id: string; url: string }) => item.url === SOURCE_DIR);
		expect(source, "the existing project-read fixture source should be discoverable").toBeTruthy();
		return source.id;
	}
	expect(response.status, `fixture source registration failed: ${await responseText(response)}`).toBe(201);
	return (await response.json()).source.id;
}

async function installFixturePack(sourceId: string, projectId: string): Promise<void> {
	const response = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "project", projectId }),
	});
	expect(response.status, `fixture pack installation failed: ${await responseText(response)}`).toBe(201);
}

async function uninstallFixturePack(projectId: string): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "project", projectId, packName: PACK_NAME }),
	}).catch(() => {});
}

async function deleteProject(projectId: string | undefined): Promise<void> {
	if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
}

async function createWorkflowGoal(projectId: string, cwd: string): Promise<{ id: string }> {
	const workflowId = `host-project-read-${Date.now().toString(36)}`;
	const response = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: "Host project read primary goal",
			spec: "Browser fixture goal with safe task, gate, and pull-request summary reads.",
			projectId,
			cwd,
			worktree: false,
			team: false,
			autoStartTeam: false,
			workflowId,
			workflow: {
				id: workflowId,
				name: "Host project read fixture workflow",
				description: "One inert gate for granular Host read coverage.",
				gates: [{ id: "browser-gate", name: "Browser gate", dependsOn: [] }],
			},
		}),
	});
	expect(response.status, `workflow goal creation failed: ${await responseText(response)}`).toBe(201);
	return response.json();
}

async function createTask(goalId: string, title: string): Promise<{ id: string }> {
	const response = await apiFetch(`/api/goals/${encodeURIComponent(goalId)}/tasks`, {
		method: "POST",
		body: JSON.stringify({ title, type: "testing", spec: "Private fixture task spec must never appear in Host summaries." }),
	});
	expect(response.status, `task creation failed: ${await responseText(response)}`).toBe(201);
	return response.json();
}

async function jsonText<T>(page: Page, testId: string): Promise<T> {
	const text = await page.getByTestId(testId).textContent();
	if (!text) throw new Error(`${testId} did not contain JSON`);
	return JSON.parse(text) as T;
}

async function numericText(page: Page, testId: string): Promise<number> {
	return Number(await page.getByTestId(testId).textContent());
}

async function injectProjectGap(page: Page, projectId: string): Promise<void> {
	await page.evaluate((boundProjectId) => {
		const socket = (window as any).__bobbitState?.remoteAgent?.ws as WebSocket | undefined;
		if (!socket?.onmessage) throw new Error("active WebSocket was unavailable for the project-read gap fixture");
		const deliver = (message: unknown) => socket.onmessage?.call(socket, new MessageEvent("message", { data: JSON.stringify(message) }));
		deliver({
			type: "host_notification",
			stream: { epoch: "project-read-gap", sequence: 11 },
			notification: {
				id: "project-read-gap-dropped",
				scope: "project",
				name: "goalCreated",
				payloadVersion: 1,
				occurredAt: Date.now(),
				projectId: boundProjectId,
				aggregate: { kind: "goal", id: "gap-record-must-not-be-read", revision: 11 },
				payload: { goalId: "gap-record-must-not-be-read", state: "in-progress" },
			},
		});
		deliver({ type: "host_notifications_refresh_required", scope: "project", epoch: "project-read-gap", sequence: 12 });
	}, projectId);
}

function fixtureHash(ids: {
	goalId: string;
	foreignGoalId: string;
	foreignSessionId: string;
	missingGoalId: string;
	missingSessionId: string;
}): string {
	const query = new URLSearchParams(ids);
	return `#/ext/host-project-read-fixture?${query.toString()}`;
}

async function waitForInitialRead(page: Page): Promise<void> {
	await expect(page.locator(PANEL)).toBeVisible({ timeout: 25_000 });
	await expect.poll(async () => {
		const error = await page.getByTestId("project-read-error").textContent();
		if (error) throw new Error(`project-read fixture failed: ${error}`);
		return page.getByTestId("project-read-route-loaded").textContent();
	}, { timeout: 20_000 }).toBe("true");
	await expect(page.getByTestId("project-read-load-order")).toContainText("readGoalPullRequest", { timeout: 20_000 });
}

test.describe("Journey: granular Host project reads", () => {
	test("loads pack data first, rereads targeted records, recovers gaps, reloads, and cleans up", async ({ page }) => {
		test.setTimeout(150_000);
		const firstRoot = mkdtempSync(join(tmpdir(), "bobbit-host-project-read-a-"));
		let firstProjectId: string | undefined;
		let sessionId: string | undefined;
		let sourceId: string | undefined;
		const goals: string[] = [];
		const sessions: string[] = [];

		try {
			firstProjectId = (await registerProject({
				name: `host-project-read-a-${Date.now()}`,
				rootPath: firstRoot,
				seedWorkflows: false,
			})).id;
			sourceId = await addFixtureSource();
			await installFixturePack(sourceId, firstProjectId);

			const primaryGoal = await createWorkflowGoal(firstProjectId, firstRoot);
			goals.push(primaryGoal.id);
			const [secondGoal, boundSessionId] = await Promise.all([
				createGoal({ title: "Host project read page two", projectId: firstProjectId, cwd: firstRoot }),
				createSession({ projectId: firstProjectId, cwd: firstRoot, goalId: primaryGoal.id }),
			]);
			goals.push(secondGoal.id);
			sessionId = boundSessionId;
			sessions.push(sessionId);

			const ids = {
				goalId: primaryGoal.id,
				foreignGoalId: primaryGoal.id,
				foreignSessionId: sessionId,
				missingGoalId: `missing-goal-${Date.now()}`,
				missingSessionId: `missing-session-${Date.now()}`,
			};
			const route = fixtureHash(ids);
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle", 30_000),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, route);
			await waitForInitialRead(page);

			await expect(page.getByTestId("project-read-capability"), "pack-owned panels get reads without a manifest permission").toHaveText("true");
			await expect(page.getByTestId("project-read-contract-version")).toHaveText("7");
			const order = (await page.getByTestId("project-read-load-order").textContent())?.split(",") ?? [];
			expect(order[0], "the panel must load its own route data before Host records").toBe("route");
			for (const method of ["readStaff", "readSessions", "readGoals", "readGoalTasks", "readGoalGates", "readGoalPullRequest"]) {
				expect(order, `${method} should be exercised by the neutral panel`).toContain(method);
			}

			const staffPage = await jsonText<PageEnvelope>(page, "project-read-staff-page");
			expect(staffPage).toMatchObject({ mode: "page", page: { cursor: 0, limit: 1 } });
			const sessionLookup = await jsonText<LookupEnvelope>(page, "project-read-session-lookup");
			expect(sessionLookup.results.map(result => [result.id, result.status])).toEqual([
				[sessionId, "found"],
				[sessionId, "found"],
				[ids.missingSessionId, "not-found"],
			]);
			const goalLookup = await jsonText<LookupEnvelope>(page, "project-read-goal-lookup");
			expect(goalLookup.results.map(result => [result.id, result.status])).toEqual([
				[primaryGoal.id, "found"],
				[primaryGoal.id, "found"],
				[ids.missingGoalId, "not-found"],
			]);
			const goalPages = await jsonText<PageEnvelope[]>(page, "project-read-goal-pages");
			expect(goalPages).toHaveLength(2);
			expect(goalPages[0].page).toMatchObject({ cursor: 0, limit: 1, hasMore: true, nextCursor: 1 });
			expect(goalPages[1].page.cursor).toBe(1);
			expect(goalPages[0].items[0]?.id).not.toBe(goalPages[1].items[0]?.id);
			const gateRead = await jsonText<PageEnvelope>(page, "project-read-gate-read");
			expect(gateRead.items).toEqual([expect.objectContaining({ gateId: "browser-gate", name: "Browser gate" })]);
			const prRead = await jsonText<{ id: string; status: string; value: unknown }>(page, "project-read-pr-read");
			expect(prRead).toEqual({ id: primaryGoal.id, status: "found", value: null });

			const goalCallsBefore = (await jsonText<Record<string, number>>(page, "project-read-calls")).readGoals;
			const ownInvalidationGoal = await createGoal({ title: "Host project read targeted invalidation", projectId: firstProjectId, cwd: firstRoot });
			goals.push(ownInvalidationGoal.id);
			await expect.poll(() => page.locator(`[data-testid="project-read-targeted"] li[data-target="goals:${ownInvalidationGoal.id}"]`).count()).toBeGreaterThan(0);
			await expect.poll(async () => (await jsonText<Record<string, number>>(page, "project-read-calls")).readGoals).toBeGreaterThan(goalCallsBefore);

			const task = await createTask(primaryGoal.id, "Host project read targeted task");
			await expect.poll(() => page.locator(`[data-testid="project-read-targeted"] li[data-target="tasks:${task.id}"]`).count()).toBeGreaterThan(0);
			const taskRead = await jsonText<LookupEnvelope>(page, "project-read-task-read");
			expect(taskRead.results).toEqual([expect.objectContaining({ id: task.id, status: "found" })]);
			expect(taskRead.results[0].value).not.toHaveProperty("spec");

			const refreshBeforeGap = await numericText(page, "project-read-refresh-count");
			await injectProjectGap(page, firstProjectId);
			await expect(page.getByTestId("project-read-refresh-count"), "a gap rereads active records once instead of consuming its dropped delta").toHaveText(String(refreshBeforeGap + 1), { timeout: 20_000 });
			await expect(page.getByTestId("project-read-targeted")).not.toContainText("gap-record-must-not-be-read");

			await page.reload();
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, route);
			await waitForInitialRead(page);
			await expect(page.getByTestId("project-read-load-order")).toHaveText(/^route,/);
			const reloadedTasks = await jsonText<PageEnvelope>(page, "project-read-task-read");
			expect(reloadedTasks.items).toEqual([expect.objectContaining({ id: task.id })]);

			await page.getByTestId("project-read-unsubscribe").click();
			await expect(page.getByTestId("project-read-state")).toHaveText("unsubscribed");
			const mutedCount = await page.getByTestId("project-read-targeted").locator("li").count();
			const mutedGoal = await createGoal({ title: "Host project read while unsubscribed", projectId: firstProjectId, cwd: firstRoot });
			goals.push(mutedGoal.id);
			await page.waitForTimeout(500);
			expect(await page.getByTestId("project-read-targeted").locator("li").count(), "idempotent unsubscribe fences queued invalidations").toBe(mutedCount);

			const refreshBeforeRemount = await numericText(page, "project-read-refresh-count");
			await page.getByTestId("project-read-remount").click();
			await expect(page.getByTestId("project-read-state")).toHaveText("mounted");
			await expect(page.getByTestId("project-read-refresh-count")).toHaveText(String(refreshBeforeRemount + 1), { timeout: 20_000 });

			await uninstallFixturePack(firstProjectId);
			await navigateToHash(page, "#/");
			await navigateToHash(page, route);
			await expect(page.locator(PANEL), "uninstall removes the contributed route/panel without retained Host state").toHaveCount(0, { timeout: 20_000 });
		} finally {
			await page.getByTestId("project-read-unsubscribe").click({ timeout: 1_000 }).catch(() => {});
			await Promise.all(sessions.map(session => deleteSession(session).catch(() => {})));
			await Promise.all(goals.map(goal => deleteGoal(goal).catch(() => {})));
			if (firstProjectId) await uninstallFixturePack(firstProjectId);
			if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
			await deleteProject(firstProjectId);
			rmSync(firstRoot, { recursive: true, force: true });
		}
	});
});
