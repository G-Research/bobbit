import { test, expect } from "../../e2e/_helpers/gateway-harness.js";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	waitForHealth,
	waitForSessionStatus,
	type WsConnection,
} from "../../e2e/_helpers/e2e-setup.js";
import { navigateToHash, openApp } from "../_helpers/journey-fixture.js";

async function promptAndWait(conn: WsConnection, text: string): Promise<void> {
	const cursor = conn.messageCount();
	conn.send({ type: "prompt", text });
	await conn.waitForFrom(cursor, agentEndPredicate(), 15_000);
	await conn.waitForFrom(
		cursor,
		(message) => message.type === "session_status" && message.status === "idle",
		15_000,
	);
}

async function primeRestorableSession(sessionId: string): Promise<void> {
	const conn = await connectWs(sessionId);
	try {
		await promptAndWait(conn, `prime restore ${sessionId}`);
		const cursor = conn.messageCount();
		conn.send({ type: "get_state" });
		await conn.waitForFrom(cursor, (message) => message.type === "state", 15_000);
	} finally {
		conn.close();
	}
}

async function sessionRow(sessionId: string): Promise<any> {
	const response = await apiFetch("/api/sessions");
	const text = await response.text();
	expect(response.status, `session list for ${sessionId}: ${text}`).toBe(200);
	const body = JSON.parse(text) as { sessions?: any[] } | any[];
	const rows = Array.isArray(body) ? body : body.sessions ?? [];
	const row = rows.find((candidate) => candidate.id === sessionId);
	expect(row, `session ${sessionId} missing from list`).toBeTruthy();
	return row;
}

test.describe.serial("Journey: read state survives gateway restart", () => {
	test("multiple ordinary sessions stay read with distinct activity, then genuine work becomes unread", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const ids: string[] = [];
		let gatewayOnline = true;
		try {
			for (let i = 0; i < 3; i++) {
				const id = await createSession();
				ids.push(id);
				await waitForSessionStatus(id, "idle");
				await primeRestorableSession(id);
			}

			const manager: any = gateway.sessionManager;
			const activityTimes = [
				Date.now() - 2 * 60_000,
				Date.now() - 2 * 60 * 60_000,
				Date.now() - 2 * 24 * 60 * 60_000,
			];
			for (let i = 0; i < ids.length; i++) {
				const id = ids[i];
				const persisted = manager.getPersistedSession(id);
				expect(persisted).toBeTruthy();
				const live = manager.getSession(id);
				expect(live).toBeTruthy();
				const store = manager.getSessionStore(persisted.projectId);
				store.update(id, { lastActivity: activityTimes[i] });
				live.lastActivity = activityTimes[i];
			}

			await openApp(page);
			// Navigation is the production mark-read path. Do not flush the stores:
			// the successful HTTP acknowledgement and graceful shutdown own durability.
			for (const id of ids) {
				await navigateToHash(page, `#/session/${id}`);
				await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
				await expect.poll(async () => (await sessionRow(id)).lastReadAt ?? 0, {
					timeout: 15_000,
					intervals: [100, 250],
				}).toBeGreaterThan((await sessionRow(id)).lastActivity);
			}
			await navigateToHash(page, "#/");

			const before = new Map<string, { lastActivity: number; lastReadAt: number }>();
			for (const id of ids) {
				const row = await sessionRow(id);
				expect(row.id).toBe(id);
				for (const linkage of ["goalId", "teamGoalId", "delegateOf", "staffId", "assistantType"]) {
					expect(row[linkage], `${id} must remain an ordinary session (${linkage})`).toBeFalsy();
				}
				expect(row.lastReadAt).toBeGreaterThan(row.lastActivity);
				before.set(id, { lastActivity: row.lastActivity, lastReadAt: row.lastReadAt });
				const sidebarRow = page.locator(`[data-session-id="${id}"]`).first();
				await expect(sidebarRow).toBeVisible({ timeout: 15_000 });
				await expect(sidebarRow.locator(".unseen-dot")).toHaveCount(0);
			}
			expect(new Set([...before.values()].map((row) => row.lastActivity)).size).toBe(ids.length);

			await gateway.crash();
			gatewayOnline = false;
			await gateway.restart();
			gatewayOnline = true;
			await waitForHealth(20_000);

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, "#/");
			for (const id of ids) {
				const row = await sessionRow(id);
				expect(row.lastActivity).toBe(before.get(id)!.lastActivity);
				expect(row.lastReadAt).toBe(before.get(id)!.lastReadAt);
				const sidebarRow = page.locator(`[data-session-id="${id}"]`).first();
				await expect(sidebarRow).toBeVisible({ timeout: 20_000 });
				await expect(sidebarRow.locator(".unseen-dot")).toHaveCount(0);
			}
			expect(new Set(await Promise.all(ids.map(async (id) => (await sessionRow(id)).lastActivity))).size).toBe(ids.length);

			const target = ids[1];
			const conn = await connectWs(target);
			try { await promptAndWait(conn, "genuine work after gateway restore"); }
			finally { conn.close(); }
			const changed = await sessionRow(target);
			expect(changed.lastActivity).toBeGreaterThan(before.get(target)!.lastActivity);
			expect(changed.lastActivity).toBeGreaterThan(changed.lastReadAt);

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, "#/");
			await expect(page.locator(`[data-session-id="${target}"] .unseen-dot`)).toHaveCount(1, { timeout: 20_000 });
		} finally {
			if (!gatewayOnline) {
				await gateway.restart().catch(() => {});
				await waitForHealth(20_000).catch(() => {});
			}
			for (const id of ids.reverse()) await deleteSession(id).catch(() => {});
		}
	});
});
