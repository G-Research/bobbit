/**
 * Journey: history prompt actions.
 *
 * Exercises the real transcript boundary and fork lifecycle. The UI-only error
 * case routes one fork response so stale-cursor behavior can be asserted
 * without mutating the source session.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	registerProject,
	test,
	waitForSessionStatus,
} from "../../../tests2/browser/_helpers/journey-fixture.js";
import { agentEndPredicate, connectWs } from "../../e2e/e2e-setup.js";
import { sendMessage } from "../../../tests/e2e/ui/ui-helpers.js";

const RETAINED = "HISTORY_FORK_RETAINED_ALPHA";
const SELECTED = [
	"HISTORY_FORK_SELECTED_BRAVO",
	"/review @docs/history-fork.md",
	"preserve this final line",
].join("\n");
const LATER = "HISTORY_FORK_LATER_CHARLIE";
const IN_FLIGHT = "HISTORY_FORK_IN_FLIGHT_DELTA";
const TOOLTIP = "The new session will include the conversation up to, but not including, this prompt.";

async function sendPromptAndWait(sessionId: string, text: string): Promise<void> {
	const ws = await connectWs(sessionId);
	try {
		ws.send({ type: "prompt", text });
		const echo = await ws.waitFor(message => message.type === "event"
			&& message.data?.type === "message_end"
			&& message.data?.message?.role === "user"
			&& message.data.message.content?.[0]?.text === text, 20_000);
		// Pi message events precede persistence and carry no SessionEntry id. The
		// action must arrive through the authoritative read-only cursor refresh,
		// never through invented event or message metadata in the test harness.
		expect(echo.data).not.toHaveProperty("entryId");
		expect(echo.data).not.toHaveProperty("id");
		expect(echo.data.message).not.toHaveProperty("entryId");
		await ws.waitFor(agentEndPredicate(), 20_000);
	} finally {
		ws.ws.close();
	}
}

async function seedHistory(sessionId: string): Promise<void> {
	for (const prompt of [RETAINED, SELECTED, LATER]) {
		await sendPromptAndWait(sessionId, prompt);
	}
	await waitForSessionStatus(sessionId, "idle", 20_000);
}

function promptRow(page: Page, marker = "HISTORY_FORK_SELECTED_BRAVO"): Locator {
	return page.locator("user-message").filter({ hasText: marker }).first();
}

function promptTrigger(page: Page, marker?: string): Locator {
	return promptRow(page, marker).getByRole("button", { name: /^Actions for prompt/ }).first();
}

function popover(page: Page): Locator {
	return page.locator("sidebar-actions-popover").filter({ has: page.getByRole("menu") }).last();
}

async function clipboardText(page: Page): Promise<string> {
	return page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"));
}

function forkRow(page: Page): Locator {
	return popover(page).getByRole("menuitem", { name: "Fork before this point" }).first();
}

function worktreeToggle(page: Page): Locator {
	return popover(page).getByRole("menuitemcheckbox", { name: /New worktree/i }).first();
}

async function openPromptActions(page: Page, marker?: string): Promise<void> {
	const trigger = promptTrigger(page, marker);
	await expect(trigger, "eligible historic prompt must have an always-visible overflow button").toBeVisible({ timeout: 20_000 });
	await trigger.click();
	await expect(popover(page).getByRole("menu")).toBeVisible({ timeout: 10_000 });
	await expect(forkRow(page)).toBeVisible();
	await expect(popover(page).getByRole("menuitem", { name: "Copy prompt" })).toBeVisible();
}

async function expectPromptControlsBelowBubble(page: Page, marker?: string): Promise<void> {
	const geometry = await promptRow(page, marker).evaluate((row) => {
		const bubble = row.querySelector(".user-message-container")!.getBoundingClientRect();
		const footer = row.querySelector(".prompt-metadata-row")!.getBoundingClientRect();
		const trigger = row.querySelector("[data-prompt-actions-trigger]")!.getBoundingClientRect();
		const timestamp = row.querySelector(".message-timestamp")!;
		const timestampRect = getComputedStyle(timestamp).display === "none"
			? undefined
			: timestamp.getBoundingClientRect();
		return {
			bubbleBottom: bubble.bottom,
			bubbleRight: bubble.right,
			footerTop: footer.top,
			footerRight: footer.right,
			controlsRight: Math.max(trigger.right, timestampRect?.right ?? 0),
		};
	});
	expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.bubbleBottom - 0.5);
	expect(geometry.footerRight).toBeCloseTo(geometry.bubbleRight, 0);
	expect(geometry.controlsRight).toBeCloseTo(geometry.footerRight, 0);
}

async function expectSourceHistory(page: Page): Promise<void> {
	for (const marker of [RETAINED, "HISTORY_FORK_SELECTED_BRAVO", LATER]) {
		await expect(promptRow(page, marker)).toBeVisible({ timeout: 20_000 });
	}
}

async function sourceTranscript(gateway: { sessionManager?: any }, sessionId: string): Promise<{ path: string; bytes: string }> {
	await expect.poll(() => gateway.sessionManager?.getPersistedSession(sessionId)?.agentSessionFile, { timeout: 20_000 }).toBeTruthy();
	const path = gateway.sessionManager.getPersistedSession(sessionId).agentSessionFile as string;
	return { path, bytes: readFileSync(path, "utf8") };
}

async function expectAuthoritativeCursorRpc(gateway: { sessionManager?: any }, sessionId: string): Promise<void> {
	const rpcClient = gateway.sessionManager?.getSession(sessionId)?.rpcClient;
	expect(rpcClient, "source session exposes its live Pi RPC bridge").toBeTruthy();
	const before = await sourceTranscript(gateway, sessionId);
	const entriesResponse = await rpcClient.sendCommand({ type: "get_entries" });
	expect(entriesResponse?.success).toBe(true);
	const entries = entriesResponse.data?.entries as any[];
	expect(Array.isArray(entries)).toBe(true);
	expect(entries.length).toBeGreaterThanOrEqual(6);
	expect(entriesResponse.data?.leafId).toBe(entries.at(-1)?.id);
	const afterLeaf = await rpcClient.sendCommand({ type: "get_entries", since: entries.at(-1)?.id });
	expect(afterLeaf).toMatchObject({ success: true, data: { entries: [], leafId: entries.at(-1)?.id } });
	const staleCursor = await rpcClient.sendCommand({ type: "get_entries", since: "missing-entry" });
	expect(staleCursor?.success).toBe(false);
	for (let index = 0; index < entries.length; index++) {
		expect(entries[index].id).toMatch(/^mock-entry-/);
		expect(entries[index].parentId).toBe(index === 0 ? null : entries[index - 1].id);
	}

	const forkMessagesResponse = await rpcClient.sendCommand({ type: "get_fork_messages" });
	expect(forkMessagesResponse?.success).toBe(true);
	expect(forkMessagesResponse.data?.messages).toEqual([
		expect.objectContaining({ entryId: expect.any(String), text: RETAINED }),
		expect.objectContaining({ entryId: expect.any(String), text: SELECTED }),
		expect.objectContaining({ entryId: expect.any(String), text: LATER }),
	]);

	const transcript = await sourceTranscript(gateway, sessionId);
	expect(transcript.path).toBe(before.path);
	expect(transcript.bytes).toBe(before.bytes);
	const records = transcript.bytes.trim().split(/\r?\n/).map(line => JSON.parse(line));
	expect(records[0]).toMatchObject({ type: "session", id: expect.any(String) });
	const persistedEntries = records.filter(record => record.type !== "session" && record.type !== "system");
	expect(persistedEntries).toEqual(entries);
}

async function sessionDetails(sessionId: string): Promise<any> {
	const response = await apiFetch(`/api/sessions/${sessionId}`);
	expect(response.status, await response.clone().text()).toBe(200);
	return response.json();
}

async function forkFromSelectedPrompt(page: Page, newWorktree: boolean): Promise<{ id: string; cwd: string }> {
	await openPromptActions(page);
	const toggle = worktreeToggle(page);
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	if (newWorktree) {
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	}

	const responsePromise = page.waitForResponse(
		response => response.url().includes("/fork") && response.request().method() === "POST",
		{ timeout: 60_000 },
	);
	await forkRow(page).click();
	const response = await responsePromise;
	const requestBody = response.request().postDataJSON() as Record<string, unknown>;
	expect(requestBody).toMatchObject({ newWorktree });
	expect(typeof requestBody.entryId).toBe("string");
	expect(requestBody).not.toHaveProperty("messages");
	expect(requestBody).not.toHaveProperty("index");
	const body = await response.json() as { id: string; cwd: string };
	expect(response.status(), JSON.stringify(body)).toBe(201);
	expect(body.id).toBeTruthy();
	await expect.poll(() => page.evaluate(() => location.hash), { timeout: 60_000 }).toBe(`#/session/${body.id}`);
	return body;
}

async function expectCutBeforeSelected(page: Page): Promise<void> {
	await expect(promptRow(page, RETAINED)).toBeVisible({ timeout: 30_000 });
	await expect(promptRow(page, "HISTORY_FORK_SELECTED_BRAVO")).toHaveCount(0);
	await expect(promptRow(page, LATER)).toHaveCount(0);
	await expect(page.locator("message-editor textarea").first()).toHaveValue("");
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function pathsEqual(left: string, right: string): boolean {
	const resolvedLeft = resolve(left);
	const resolvedRight = resolve(right);
	return process.platform === "win32"
		? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
		: resolvedLeft === resolvedRight;
}

test.describe("Journey: Fork before this point prompt actions", () => {
	test.use({ permissions: ["clipboard-read", "clipboard-write"], hasTouch: true });

	test("desktop and mobile expose copy/tooltip/toggle controls and a failed fork does not navigate", async ({ page }) => {
		test.setTimeout(120_000);
		const sourceId = await createSession();
		const requests: Array<Record<string, unknown>> = [];
		try {
			await seedHistory(sourceId);
			await page.setViewportSize({ width: 1280, height: 900 });
			await openApp(page);
			await navigateToHash(page, `#/session/${sourceId}`);
			await expectSourceHistory(page);
			await expectPromptControlsBelowBubble(page);

			// At agent_start the authoritative cursor refresh makes the current
			// durable prompt actionable while the assistant is still working.
			await sendMessage(page, `STAY_BUSY:4000 ${IN_FLIGHT}`);
			await expect(page.getByRole("button", { name: "Stop current turn" })).toBeVisible({ timeout: 20_000 });
			await expect(promptRow(page, IN_FLIGHT)).toBeVisible({ timeout: 10_000 });
			await expect(promptTrigger(page, IN_FLIGHT)).toBeVisible({ timeout: 10_000 });
			await expect(promptTrigger(page, LATER)).toBeVisible();
			await openPromptActions(page, IN_FLIGHT);
			await page.keyboard.press("Escape");
			await expect(popover(page)).toHaveCount(0);
			await waitForSessionStatus(sourceId, "idle", 20_000);

			await page.route(`**/api/sessions/${sourceId}/fork`, async route => {
				if (route.request().method() !== "POST") return route.fallback();
				requests.push(route.request().postDataJSON());
				await route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({ error: "This prompt is no longer available", code: "HISTORY_FORK_CURSOR_NOT_FOUND" }),
				});
			});

			// Desktop overflow is persistent rather than hover-only. Copy uses the
			// original prompt string, including newlines, slash syntax, and @path.
			await expect(promptTrigger(page)).toBeVisible();
			await openPromptActions(page);
			await expect(forkRow(page)).toHaveText("Fork before this point");
			await expect(forkRow(page)).toHaveAttribute("title", TOOLTIP);
			await expect(popover(page).locator("[data-sidebar-actions-help]")).toHaveCount(0);
			await expect(popover(page)).not.toContainText("(?)");
			await page.keyboard.press("Escape");
			await expect(popover(page)).toHaveCount(0);

			await openPromptActions(page);
			await popover(page).getByRole("menuitem", { name: "Copy prompt" }).click();
			await expect.poll(() => clipboardText(page)).toBe(SELECTED);
			await expect(page.getByText("Prompt copied", { exact: true })).toBeVisible();

			// Mobile uses the same overflow, label, and native row tooltip.
			await page.setViewportSize({ width: 390, height: 844 });
			await expect(promptTrigger(page)).toBeVisible();
			await expectPromptControlsBelowBubble(page);
			await openPromptActions(page);
			await expect(forkRow(page)).toHaveAttribute("title", TOOLTIP);
			await expect(popover(page).locator("[data-sidebar-actions-help]")).toHaveCount(0);
			await popover(page).getByRole("menuitem", { name: "Copy prompt" }).click();
			await expect.poll(() => clipboardText(page)).toBe(SELECTED);
			await openPromptActions(page);

			// The toggle starts off, changes without firing, and resets off on reopen.
			const toggle = worktreeToggle(page);
			await expect(toggle).toHaveAttribute("aria-checked", "false");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-checked", "true");
			expect(requests).toEqual([]);
			await page.keyboard.press("Escape");
			await expect(popover(page)).toHaveCount(0);
			await openPromptActions(page);
			await expect(worktreeToggle(page)).toHaveAttribute("aria-checked", "false");

			await forkRow(page).click();
			await expect.poll(() => requests.length).toBe(1);
			expect(requests[0]).toMatchObject({ newWorktree: false });
			expect(typeof requests[0].entryId).toBe("string");
			expect(requests[0]).not.toHaveProperty("messages");
			expect(requests[0]).not.toHaveProperty("index");
			await expect(page.getByText("This prompt is no longer available", { exact: true })).toBeVisible({ timeout: 10_000 });
			expect(await page.evaluate(() => location.hash)).toBe(`#/session/${sourceId}`);
			expect(requests).toHaveLength(1);
		} finally {
			await page.unroute(`**/api/sessions/${sourceId}/fork`).catch(() => {});
			await deleteSession(sourceId).catch(() => {});
		}
	});

	test("default history fork reuses the exact cwd and cuts before the selected prompt without touching the live source", async ({ page, gateway }) => {
		test.setTimeout(150_000);
		const sourceId = await createSession();
		let forkId = "";
		try {
			await seedHistory(sourceId);
			await expectAuthoritativeCursorRpc(gateway, sourceId);
			const sourceBefore = await sourceTranscript(gateway, sourceId);
			const source = await sessionDetails(sourceId);
			const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);

			await openApp(page);
			await navigateToHash(page, `#/session/${sourceId}`);
			await expectSourceHistory(page);
			const fork = await forkFromSelectedPrompt(page, false);
			forkId = fork.id;

			expect(fork.cwd).toBe(source.cwd);
			const forkDetails = await sessionDetails(forkId);
			expect(forkDetails.cwd).toBe(source.cwd);
			expect(forkDetails.branch).toBe(source.branch);
			const forkPersisted = gateway.sessionManager.getPersistedSession(forkId);
			expect(forkPersisted.cwd).toBe(sourcePersisted.cwd);
			expect(forkPersisted.worktreePath).toBe(sourcePersisted.worktreePath);
			expect(forkPersisted.branch).toBe(sourcePersisted.branch);
			await expectCutBeforeSelected(page);
			await page.reload();
			await expectCutBeforeSelected(page);
			await expect(page.getByTestId("footer-cwd-path")).toHaveText(source.cwd);

			// The source remains live/listed and its transcript bytes are untouched.
			expect(gateway.sessionManager?.getSession(sourceId)).toBeTruthy();
			const sessionsResponse = await apiFetch("/api/sessions");
			const sessionsBody = await sessionsResponse.json();
			const sessions = Array.isArray(sessionsBody) ? sessionsBody : Array.isArray(sessionsBody.sessions) ? sessionsBody.sessions : [];
			expect(sessions.some((session: any) => session.id === sourceId)).toBe(true);
			expect(readFileSync(sourceBefore.path, "utf8")).toBe(sourceBefore.bytes);

			await navigateToHash(page, `#/session/${sourceId}`);
			await expectSourceHistory(page);
		} finally {
			if (forkId) await deleteSession(forkId).catch(() => {});
			await deleteSession(sourceId).catch(() => {});
		}
	});

	test("New worktree history fork uses the established fresh-worktree lifecycle and survives reload", async ({ page, gateway }) => {
		test.setTimeout(180_000);
		const runRoot = process.env.BOBBIT_E2E_TMP_ROOT;
		if (!runRoot) throw new Error("BOBBIT_E2E_TMP_ROOT must identify the browser run root");
		const root = mkdtempSync(join(runRoot, "history-fork-git-"));
		let projectId = "";
		let sourceId = "";
		let forkId = "";
		let forkCwd = "";
		try {
			git(root, "init", "--initial-branch=main");
			git(root, "config", "user.name", "History Fork Journey");
			git(root, "config", "user.email", "history-fork@example.invalid");
			execFileSync(process.execPath, ["-e", "require('fs').writeFileSync('README.md', '# history fork journey\\n')"], { cwd: root });
			git(root, "add", "README.md");
			git(root, "commit", "-m", "initial fixture");

			projectId = (await registerProject({ name: `history-fork-${Date.now()}`, rootPath: root })).id;
			const createResponse = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: root, projectId, worktree: false }),
			});
			expect(createResponse.status, await createResponse.clone().text()).toBe(201);
			sourceId = (await createResponse.json()).id;
			await waitForSessionStatus(sourceId, "idle", 30_000);
			await seedHistory(sourceId);
			await expectAuthoritativeCursorRpc(gateway, sourceId);
			const sourceBefore = await sourceTranscript(gateway, sourceId);
			const source = await sessionDetails(sourceId);

			await openApp(page);
			await navigateToHash(page, `#/session/${sourceId}`);
			const fork = await forkFromSelectedPrompt(page, true);
			forkId = fork.id;
			forkCwd = fork.cwd;

			expect(forkCwd).not.toBe(source.cwd);
			expect(existsSync(join(forkCwd, ".git"))).toBe(true);
			const forkDetails = await sessionDetails(forkId);
			expect(forkDetails.cwd).toBe(forkCwd);
			expect(forkDetails.branch).not.toBe(source.branch);
			await expectCutBeforeSelected(page);
			await page.reload();
			await expectCutBeforeSelected(page);
			await expect(page.getByTestId("footer-cwd-path")).toHaveText(forkCwd);
			expect(readFileSync(sourceBefore.path, "utf8")).toBe(sourceBefore.bytes);
			expect(gateway.sessionManager?.getSession(sourceId)).toBeTruthy();
		} finally {
			if (forkId) await deleteSession(forkId).catch(() => {});
			if (sourceId) await deleteSession(sourceId).catch(() => {});
			if (forkCwd && !pathsEqual(forkCwd, root) && existsSync(forkCwd)) {
				try { git(root, "worktree", "remove", "--force", forkCwd); } catch { rmSync(forkCwd, { recursive: true, force: true }); }
			}
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			rmSync(`${root}-wt`, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});
