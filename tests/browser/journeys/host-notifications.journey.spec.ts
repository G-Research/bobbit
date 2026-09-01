/**
 * Journey: a real project-scoped marketplace panel consumes canonical session
 * and project notifications, while snapshots remain authoritative across load,
 * reload, stream gaps, unsubscribe/remount, and foreign-project mutations.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "../../support/helpers/browser/journeys/journey-fixture.js";

const SOURCE_DIR = fileURLToPath(new URL("../../support/fixtures/browser/packs/host-notifications", import.meta.url));
const PACK_NAME = "host-notifications-fixture";
const PANEL = '[data-testid="host-notifications-fixture-panel"]';

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
		expect(source, "the existing fixture source should be discoverable after a conflict").toBeTruthy();
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

async function numericText(page: import("@playwright/test").Page, testId: string): Promise<number> {
	return Number(await page.getByTestId(testId).textContent());
}

async function injectCoalescedTransportGap(
	page: import("@playwright/test").Page,
	sessionId: string,
	projectId: string,
): Promise<void> {
	await page.evaluate(({ sessionId, projectId }) => {
		const socket = (window as any).__bobbitState?.remoteAgent?.ws as WebSocket | undefined;
		if (!socket?.onmessage) throw new Error("active session WebSocket was not available for the gap fixture");
		const deliver = (message: unknown) => socket.onmessage?.call(socket, new MessageEvent("message", {
			data: JSON.stringify(message),
		}));
		const occurredAt = Date.now();
		deliver({
			type: "host_notification",
			stream: { epoch: "fixture-gap-epoch", sequence: 41 },
			notification: {
				id: "fixture-gap-session",
				scope: "session",
				name: "messageAppended",
				payloadVersion: 1,
				occurredAt,
				projectId,
				sessionId,
				aggregate: { kind: "session", id: sessionId, revision: 41 },
				payload: { messageId: "must-be-dropped", cursor: 41, role: "user", blockKinds: ["text"] },
			},
		});
		deliver({
			type: "host_notification",
			stream: { epoch: "fixture-gap-epoch", sequence: 73 },
			notification: {
				id: "fixture-gap-project",
				scope: "project",
				name: "goalCreated",
				payloadVersion: 1,
				occurredAt,
				projectId,
				aggregate: { kind: "goal", id: "must-be-dropped", revision: 73 },
				payload: { goalId: "must-be-dropped", state: "in-progress" },
			},
		});
		deliver({ type: "host_notifications_refresh_required", scope: "session", epoch: "fixture-gap-epoch", sequence: 42 });
		deliver({ type: "host_notifications_refresh_required", scope: "project", epoch: "fixture-gap-epoch", sequence: 74 });
	}, { sessionId, projectId });
}

test.describe("Journey: scoped Host notifications marketplace panel", () => {
	test("loads snapshots first, observes scoped live facts, recovers gaps, and remounts without leaks", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const firstRoot = mkdtempSync(join(tmpdir(), "bobbit-host-notifications-a-"));
		const secondRoot = mkdtempSync(join(tmpdir(), "bobbit-host-notifications-b-"));
		let firstProjectId: string | undefined;
		let secondProjectId: string | undefined;
		let sessionId: string | undefined;
		let sourceId: string | undefined;
		const goals: string[] = [];

		try {
			firstProjectId = (await registerProject({
				name: `host-notifications-a-${Date.now()}`,
				rootPath: firstRoot,
				seedWorkflows: false,
			})).id;
			secondProjectId = (await registerProject({
				name: `host-notifications-b-${Date.now()}`,
				rootPath: secondRoot,
				seedWorkflows: false,
			})).id;
			sourceId = await addFixtureSource();
			await installFixturePack(sourceId, firstProjectId);
			sessionId = await createSession({ projectId: firstProjectId, cwd: firstRoot });
			await waitForSessionStatus(sessionId, "idle", 30_000);

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, "#/ext/host-notifications-fixture");
			await expect(page.locator(PANEL)).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId("fixture-subscription-state")).toHaveText("mounted");
			await expect(page.getByTestId("fixture-refresh-error")).toHaveText("");
			await expect(page.getByTestId("fixture-snapshot-count"), "session + project mount invalidations must coalesce into one snapshot").toHaveText("1", { timeout: 20_000 });
			await expect(page.getByTestId("fixture-snapshot-session")).toHaveText(sessionId);
			const initialTranscriptTotal = await numericText(page, "fixture-transcript-total");

			const prompt = "HOST_NOTIFICATION_BROWSER_LIVE_MESSAGE";
			const promptResult = await gateway.sessionManager.enqueuePrompt(sessionId, prompt);
			expect(promptResult.status).toBe("dispatched");
			await waitForSessionStatus(sessionId, "idle", 30_000);
			await expect(page.getByTestId("fixture-session-events").locator("li").first(), "the panel should observe a live session fact").toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId("fixture-session-events")).toContainText("messageAppended");

			const ownGoal = await createGoal({ title: "Host notification own-project fact", projectId: firstProjectId, cwd: firstRoot });
			goals.push(ownGoal.id);
			await expect(page.locator(`[data-testid="fixture-project-events"] li[data-goal-id="${ownGoal.id}"]`), "the panel should observe its bound project's fact").toHaveCount(1, { timeout: 20_000 });
			const ownProjectEventCount = await page.getByTestId("fixture-project-events").locator("li").count();

			const foreignGoal = await createGoal({ title: "Host notification foreign-project fact", projectId: secondProjectId, cwd: secondRoot });
			goals.push(foreignGoal.id);
			await page.waitForTimeout(500);
			expect(await page.getByTestId("fixture-project-events").locator("li").count(), "a second project's fact must stay silent").toBe(ownProjectEventCount);
			await expect(page.locator(`[data-testid="fixture-project-events"] li[data-goal-id="${foreignGoal.id}"]`)).toHaveCount(0);

			await page.reload();
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, "#/ext/host-notifications-fixture");
			await expect(page.locator(PANEL), "the marketplace panel should remount after reload").toBeVisible({ timeout: 25_000 });
			await expect(page.getByTestId("fixture-snapshot-count"), "reload must re-read one coalesced authoritative snapshot").toHaveText("1", { timeout: 20_000 });
			await expect(page.getByTestId("fixture-snapshot-session")).toHaveText(sessionId);
			await expect.poll(() => numericText(page, "fixture-transcript-total"), {
				timeout: 20_000,
				message: "the reload snapshot should contain the authoritative post-prompt transcript",
			}).toBeGreaterThan(initialTranscriptTotal);
			await expect(page.getByTestId("fixture-session-events").locator("li"), "reload does not replay live deltas").toHaveCount(0);
			await expect(page.getByTestId("fixture-project-events").locator("li"), "reload does not rebuild project state from deltas").toHaveCount(0);

			await page.getByTestId("fixture-unsubscribe").click();
			await expect(page.getByTestId("fixture-subscription-state")).toHaveText("unsubscribed");
			const mutedGoal = await createGoal({ title: "Host notification while unsubscribed", projectId: firstProjectId, cwd: firstRoot });
			goals.push(mutedGoal.id);
			await page.waitForTimeout(500);
			await expect(page.getByTestId("fixture-project-events").locator("li"), "idempotent unsubscribe must fence stale callbacks").toHaveCount(0);

			await page.getByTestId("fixture-remount").click();
			await expect(page.getByTestId("fixture-subscription-state")).toHaveText("mounted");
			await expect(page.getByTestId("fixture-snapshot-count"), "remount should perform one new snapshot despite two scoped invalidations").toHaveText("2", { timeout: 20_000 });
			const remountedGoal = await createGoal({ title: "Host notification after remount", projectId: firstProjectId, cwd: firstRoot });
			goals.push(remountedGoal.id);
			await expect(page.locator(`[data-testid="fixture-project-events"] li[data-goal-id="${remountedGoal.id}"]`), "remount should install exactly one live handler").toHaveCount(1, { timeout: 20_000 });
			await expect(page.getByTestId("fixture-project-events").locator("li")).toHaveCount(1);

			const snapshotsBeforeGap = await numericText(page, "fixture-snapshot-count");
			await injectCoalescedTransportGap(page, sessionId, firstProjectId);
			await expect(page.getByTestId("fixture-snapshot-count"), "session/project gap burst must coalesce into one authoritative refresh").toHaveText(String(snapshotsBeforeGap + 1), { timeout: 20_000 });
			await expect(page.getByTestId("fixture-session-events")).not.toContainText("must-be-dropped");
			await expect(page.getByTestId("fixture-project-events")).not.toContainText("must-be-dropped");
		} finally {
			await page.getByTestId("fixture-unsubscribe").click({ timeout: 1_000 }).catch(() => {});
			for (const goalId of goals.reverse()) await deleteGoal(goalId).catch(() => {});
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (firstProjectId) await uninstallFixturePack(firstProjectId);
			if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
			await deleteProject(secondProjectId);
			await deleteProject(firstProjectId);
			rmSync(firstRoot, { recursive: true, force: true });
			rmSync(secondRoot, { recursive: true, force: true });
		}
	});
});
