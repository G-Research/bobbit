/**
 * Journey: Prompt Interaction + BG Wait Steer — v2 browser smoke
 * Covers: journey-prompt-interaction, journey-bg-wait-steer
 * Consolidated from: prompt-tool-renderer-*, bg-wait-*, steer-*, etc.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../_helpers/journey-fixture.js";
import { sendMessage, createSessionViaUI } from "../../../tests/e2e/ui/ui-helpers.js";

test.describe("Journey: Prompt Interaction", () => {
	test("message editor textarea is visible", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("can type into message editor", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("hello journey test");
			const val = await editor.inputValue();
			expect(val).toContain("hello journey test");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("session shows message history area", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			// Session view loaded — editor visible means the session shell rendered
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(sessionId);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("send message → mock agent 'OK' response appears in chat", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("hello test");
			await editor.press("Enter");
			// The mock agent responds with "OK" — assert it appears in the chat
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("ask_user_choices trigger → widget renders, options selectable, submit dismisses widget", async ({ page }) => {
		// The mock agent recognises "ask_user_choices" and emits a non-blocking
		// ask_user_choices tool_use with 2 questions (tabs: Color + Team size).
		// The UI renders <ask-user-choices-widget> with radio options and a
		// Next / Submit primary button.  This test drives the full happy path:
		// pick Q1 option (auto-advances), pick Q2 option, submit.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const textarea = page.locator("message-editor textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });

			// Trigger the ask_user_choices mock response.
			await sendMessage(page, "ask_user_choices");

			// The widget custom element must appear.
			const widget = page.locator("ask-user-choices-widget").first();
			await expect(widget).toBeVisible({ timeout: 20_000 });

			// Wait for streaming to finish before interacting — mid-stream re-renders
			// can detach auto-advance timers (same guard as legacy ask-user-choices-ui.spec.ts).
			await page.waitForFunction(
				() => (window as any).__bobbitState?.remoteAgent?.state?.isStreaming === false,
				{ timeout: 15_000 },
			);

			// Q1: pick "red" — selecting via label click auto-advances to Q2.
			await widget.locator('label:has(input[value="red"])').click();
			await expect(widget.locator('[role="tab"][data-tab-index="1"]'))
				.toHaveAttribute("aria-selected", "true", { timeout: 15_000 });

			// Q2: pick "small".
			await widget.locator('label:has(input[value="small"])').click();

			// Submit button must be enabled on the last tab.
			const submit = widget.locator(".ask-submit");
			await expect(submit).toHaveText("Submit");
			await expect(submit).toBeEnabled({ timeout: 15_000 });
			await submit.click();

			// Once submitted the submit button disappears (widget becomes read-only).
			await expect(widget.locator(".ask-submit")).toHaveCount(0, { timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	// Ported from at-mention.spec.ts (audit: prompt-interaction GAP): typing '@'
	// in the composer opens the @-mention autocomplete menu (.at-menu), populated
	// by a server file fetch of the session cwd — so the session needs a cwd with
	// real files.
	test("typing '@' opens the @-mention autocomplete menu", async ({ page }) => {
		const cwd = join(tmpdir(), `bobbit-v2-atmention-${process.env.E2E_PORT ?? "0"}-${Date.now()}`);
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "notes.md"), "# notes\n");
		writeFileSync(join(cwd, "readme.txt"), "readme\n");
		let sessionId = "";
		let projectId = "";
		try {
			const projResp = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `v2-atmention-${Date.now()}`, rootPath: cwd }),
			});
			expect(projResp.status).toBe(201);
			projectId = (await projResp.json()).id;
			const created = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd, projectId, worktree: false }),
			});
			expect(created.status).toBe(201);
			sessionId = (await created.json()).id;

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const textarea = page.locator("message-editor textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });
			await textarea.click();
			await textarea.pressSequentially("@");
			await expect(page.locator(".at-menu").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	// Ported from at-mention.spec.ts (audit: prompt-interaction GAP / BR56): only
	// existing files outside Markdown code render as file-mention chips, and the
	// authoritative snapshot preserves that distinction across reload.
	test("a mixed sent prompt resolves only the existing file outside Markdown code", async ({ page }) => {
		test.setTimeout(90_000);
		const cwd = mkdtempSync(join(tmpdir(), `bobbit-v2-atchip-${process.env.E2E_PORT ?? "0"}-`));
		const proseFile = "prose-reference.txt";
		const inlineCodeFile = "inline-code-reference.txt";
		const fencedCodeFile = "fenced-code-reference.txt";
		const mixedPrompt = [
			`Please read @${proseFile} while leaving @variableName and @missing/path.txt literal.`,
			`Inline existing file: \`@${inlineCodeFile}\`.`,
			"```text",
			`Fenced existing file: @${fencedCodeFile}`,
			"```",
		].join("\n");
		let sessionId = "";
		let projectId = "";
		try {
			writeFileSync(join(cwd, proseFile), "prose mention fixture\n", "utf8");
			writeFileSync(join(cwd, inlineCodeFile), "inline code fixture\n", "utf8");
			writeFileSync(join(cwd, fencedCodeFile), "fenced code fixture\n", "utf8");
			const projResp = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `v2-atchip-${Date.now()}`, rootPath: cwd }),
			});
			expect(projResp.status).toBe(201);
			projectId = (await projResp.json()).id;
			const created = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd, projectId, worktree: false }),
			});
			expect(created.status).toBe(201);
			sessionId = (await created.json()).id;

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await sendMessage(page, mixedPrompt);

			const expectMixedPrompt = async () => {
				const bubble = page.locator("user-message").first();
				await expect(bubble).toBeVisible({ timeout: 20_000 });
				await expect(bubble).toContainText("@variableName");
				await expect(bubble).toContainText("@missing/path.txt");
				await expect(bubble).toContainText(`@${inlineCodeFile}`);
				await expect(bubble).toContainText(`@${fencedCodeFile}`);

				const chips = bubble.locator(".file-mention-chip-pill");
				await expect(chips).toHaveCount(1);
				await expect(chips).toHaveText(`@${proseFile}`);
				await expect(chips).toHaveAttribute("title", `File: @${proseFile}`);
				await expect(chips.filter({ hasText: `@${inlineCodeFile}` })).toHaveCount(0);
				await expect(chips.filter({ hasText: `@${fencedCodeFile}` })).toHaveCount(0);
			};

			await expectMixedPrompt();

			await page.reload();
			await expectMixedPrompt();
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Ported from tool-ask-policy.spec.ts (audit: prompt-interaction GAP / BR67):
	// a tool-grant-request on an ask-policy role shows a tool-permission-card and
	// 'Allow just <tool>' grants it.
	test("ask-policy tool grant request shows a permission card and grant works", async ({ page }) => {
		test.setTimeout(90_000);
		const askRole = `v2-ask-${Date.now()}`;
		const roleResp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: askRole, label: "V2 Ask Policy", toolPolicies: { Bash: "ask" } }),
		});
		expect(roleResp.status).toBe(201);
		let sessionId = "";
		try {
			await openApp(page);
			sessionId = await createSessionViaUI(page);
			await apiFetch(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ roleId: askRole }) });
			const grantPromise = apiFetch(`/api/sessions/${sessionId}/tool-grant-request`, {
				method: "POST", body: JSON.stringify({ toolName: "Bash", toolGroup: "Shell" }),
			});
			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 15_000 });
			await card.getByRole("button", { name: /Allow just/i }).click();
			await expect(card.getByText(/Permission granted/i)).toBeVisible({ timeout: 5_000 });
			const result = await grantPromise.then((r) => r.json());
			expect(result.granted).toBe(true);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await apiFetch(`/api/roles/${askRole}`, { method: "DELETE" }).catch(() => {});
		}
	});

	// Ported from queue-ui.spec.ts (audit: prompt-interaction GAP / BR65): a
	// follow-up typed mid-turn queues as a .queue-pill with a .steer-btn.
	test("typing during streaming queues a follow-up pill with a steer button", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const textarea = page.locator("message-editor textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });
			await sendMessage(page, "STAY_BUSY:3000 working");
			await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });
			await textarea.fill("steer me now");
			await textarea.press("Enter");
			await expect(page.locator(".queue-pill").first()).toBeVisible({ timeout: 5_000 });
			await expect(page.locator(".steer-btn")).toHaveCount(1, { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	// Ported from escape-aborts-anywhere.spec.ts (audit: prompt-interaction GAP / BR66):
	// Escape in the composer aborts a streaming agent (Stop button disappears).
	test("Escape in the composer aborts a streaming agent", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const textarea = page.locator("message-editor textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });
			await sendMessage(page, "STAY_BUSY:30000 working");
			await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });
			await textarea.focus();
			await textarea.press("Escape");
			await expect(page.locator("button[title='Stop streaming']")).toHaveCount(0, { timeout: 10_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
