import {
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

const SEED_PROMPT = "gateway lifecycle dormant seed";
const BOUNDARY_FOLLOW_UP = "follow up at the finish-run boundary";
const FALSE_FATAL = /Agent process not running|Agent is already processing|COMMAND_ERROR/i;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function textOf(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

async function transcript(session: any): Promise<any[]> {
	const response = await session.rpcClient.getMessages();
	return response.data?.messages ?? response.data ?? [];
}

function exactTextCount(messages: any[], role: string, text: string): number {
	return messages.filter((message) => message?.role === role && textOf(message) === text).length;
}

async function collectFalseFatals(
	page: import("@playwright/test").Page,
	observed: string[],
): Promise<void> {
	const fatal = page.locator("error-message").filter({ hasText: FALSE_FATAL });
	for (const text of await fatal.allTextContents()) {
		observed.push(text.match(FALSE_FATAL)?.[0] ?? text.trim());
	}
	while (await fatal.count() > 0) {
		await fatal.first().locator("button[title='Dismiss']").click();
	}
}

test.describe("Journey: dormant wake and finish-run follow-up", () => {
	test.describe.configure({ retries: 0 });

	test("reconciles a durable boundary follow-up across reload exactly once without a false fatal error", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		const manager: any = gateway.sessionManager;
		const restoreStarted = deferred();
		const releaseRestore = deferred();
		let restoreReleased = false;
		let originalRestoreSession: any;
		const falseFatals: string[] = [];

		try {
			await waitForSessionStatus(sessionId, "idle");
			const initial = manager.getSession(sessionId);
			expect(initial, "journey requires a live in-process mock session").toBeTruthy();

			// Seed one durable exchange so the stopped session has a real transcript
			// that the ordinary dormant-revival path can rehydrate.
			await initial.rpcClient.prompt(SEED_PROMPT);
			await expect.poll(async () => {
				const messages = await transcript(initial);
				return {
					user: exactTextCount(messages, "user", SEED_PROMPT),
					assistant: exactTextCount(messages, "assistant", "OK"),
					status: initial.status,
				};
			}, { timeout: 20_000 }).toEqual({ user: 1, assistant: 1, status: "idle" });
			await initial.rpcClient.getState();
			const persisted = manager.getPersistedSession(sessionId);
			expect(persisted?.agentSessionFile, "seed exchange must publish a restorable transcript path").toEqual(expect.any(String));

			// Reuse SessionManager's real dormant capsule and restore seams. Holding
			// restore after coordinator acquisition makes browser get_state race the
			// stopped placeholder bridge deterministically.
			initial.unsubscribe?.();
			await initial.rpcClient.stop();
			manager.addDormantSession(persisted);
			expect(manager.getSession(sessionId)?.dormant).toBe(true);
			originalRestoreSession = manager.restoreSession;
			manager.restoreSession = async (record: any) => {
				restoreStarted.resolve();
				await releaseRestore.promise;
				return originalRestoreSession.call(manager, record);
			};

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await restoreStarted.promise;
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
			await page.waitForTimeout(150);
			await collectFalseFatals(page, falseFatals);

			restoreReleased = true;
			releaseRestore.resolve();
			await expect.poll(() => {
				const current = manager.getSession(sessionId);
				return !!current && current.dormant !== true && current.status === "idle";
			}, { timeout: 20_000 }).toBe(true);
			manager.restoreSession = originalRestoreSession;
			originalRestoreSession = undefined;

			// Reconnect after wake so the browser obtains the revived session's
			// canonical status and the rehydrated seed transcript.
			await page.reload({ waitUntil: "domcontentloaded" });
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("user-message").filter({ hasText: SEED_PROMPT })).toHaveCount(1);
			await collectFalseFatals(page, falseFatals);

			const live = manager.getSession(sessionId);
			const core = live?.rpcClient?._agent;
			expect(core, "journey requires the in-process Pi busy-guard seam").toBeTruthy();
			const baseline = await transcript(live);
			const baselineOk = exactTextCount(baseline, "assistant", "OK");

			// Pi can emit agent_end while finishRun still owns its busy guard. Model
			// that exact boundary: Bobbit sees idle, but the first prompt RPC rejects.
			core._busyOverride = true;
			await editor.fill(BOUNDARY_FOLLOW_UP);
			await editor.press("Enter");

			await expect.poll(() => manager.getSession(sessionId)?.promptQueue
				?.toArray()
				.filter((row: any) => row.text === BOUNDARY_FOLLOW_UP).length ?? 0, {
				timeout: 15_000,
				message: "busy-rejected follow-up must remain durably queued for retry",
			}).toBe(1);
			await expect(page.locator(".queue-pill").filter({ hasText: BOUNDARY_FOLLOW_UP })).toHaveCount(1, { timeout: 15_000 });
			await page.waitForTimeout(200);
			await collectFalseFatals(page, falseFatals);

			// Reload while retry is parked. The queue pill is server-backed, and the
			// optimistic user row must not multiply during snapshot reconciliation.
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(editor).toBeVisible({ timeout: 20_000 });
			await expect(page.locator(".queue-pill").filter({ hasText: BOUNDARY_FOLLOW_UP })).toHaveCount(1, { timeout: 20_000 });
			expect(
				await page.locator("user-message").filter({ hasText: BOUNDARY_FOLLOW_UP }).count(),
				"reload must not multiply the optimistic follow-up row",
			).toBeLessThanOrEqual(1);
			await collectFalseFatals(page, falseFatals);

			// finishRun releases the guard; the next lifecycle drain retries the one
			// durable FIFO row. No fresh user send is allowed to unstick delivery.
			const retrySession = manager.getSession(sessionId);
			retrySession.rpcClient._agent._busyOverride = false;
			manager.handleAgentLifecycle(retrySession, { type: "agent_end" });

			await expect.poll(async () => {
				const messages = await transcript(manager.getSession(sessionId));
				return {
					user: exactTextCount(messages, "user", BOUNDARY_FOLLOW_UP),
					newResponses: exactTextCount(messages, "assistant", "OK") - baselineOk,
					queued: manager.getSession(sessionId).promptQueue.toArray()
						.filter((row: any) => row.text === BOUNDARY_FOLLOW_UP).length,
					status: manager.getSession(sessionId).status,
				};
			}, { timeout: 20_000 }).toEqual({ user: 1, newResponses: 1, queued: 0, status: "idle" });

			await expect(page.locator(".queue-pill").filter({ hasText: BOUNDARY_FOLLOW_UP })).toHaveCount(0, { timeout: 15_000 });
			await expect(page.locator("user-message").filter({ hasText: BOUNDARY_FOLLOW_UP })).toHaveCount(1, { timeout: 15_000 });
			await expect(page.locator("assistant-message").filter({ hasText: "OK" })).toHaveCount(baselineOk + 1, { timeout: 15_000 });
			await collectFalseFatals(page, falseFatals);
			expect(falseFatals, "recoverable dormant/busy windows must never surface fatal COMMAND_ERROR rows").toEqual([]);
		} finally {
			if (!restoreReleased) releaseRestore.resolve();
			if (originalRestoreSession) manager.restoreSession = originalRestoreSession;
			const current = manager.getSession(sessionId);
			if (current?.rpcClient?._agent) current.rpcClient._agent._busyOverride = false;
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
