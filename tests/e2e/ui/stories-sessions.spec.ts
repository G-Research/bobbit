/**
 * Session lifecycle stories — CT-01, CT-02, CT-05, CT-15, CT-16
 *
 * These stories ARE the specification. Each test reads as a behavioral
 * requirement and runs as a Playwright E2E test.
 *
 * Phase annotations control what gets tracked in the spec graph:
 *   setup  → preconditions, incidental navigation (not tracked)
 *   act    → the user actions under test (tracked)
 *   assert → the expected outcomes (tracked)
 *   cleanup → teardown (not tracked)
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, base, readE2ETokenAsync, waitForHealth, deleteSession } from "../e2e-setup.js";
import { waitForAgentResponse } from "./ui-helpers.js";
import { SpecContext } from "./spec-framework.js";
import {
	STORY_S01,
	STORY_S02,
	STORY_S03,
	STORY_S04,
	STORY_S05,
	STORY_S06,
	STORY_S07,
	STORY_S11,
	STORY_S12,
} from "./story-registry.js";

async function openStoryApp(s: SpecContext): Promise<void> {
	await expect(async () => {
		const resp = await apiFetch("/api/oauth/status?provider=anthropic");
		expect(resp.ok).toBe(true);
		const status = await resp.json();
		expect(status.authenticated).toBe(true);
	}).toPass({ timeout: 20_000 });

	const page = s.page;
	const token = await readE2ETokenAsync();
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}`);
	await expect(
		page.locator("button").filter({ hasText: "Settings" }).first(),
	).toBeVisible({ timeout: 20_000 });
}

test.describe("Session lifecycle stories", () => {
	let s: SpecContext;

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page, gateway }) => {
		s = new SpecContext(page, gateway);
	});

	test.afterEach(async () => {
		await s.cleanup();
	});

	// ---------------------------------------------------------------
	// S-01 + S-03: Editor empty state and draft isolation
	// ---------------------------------------------------------------

	test("S-01/S-03: New session editor state and draft isolation", async () => {
		// shared setup
		await s.createTestSession("A");
		await s.createTestSession("B");
		await openStoryApp(s);

		s.begin(STORY_S01);

		// act
		s.act();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.is_focused();
		await s.editor.is_empty();
		await s.editor.cannot("send_message");

		s.begin(STORY_S03);

		// act
		s.act();
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");
		await s.type_in(s.editor, "draft for A");
		await s.wait_for_draft_saved("A", "draft for A");
		await s.navigate_to("session", "B");
		await s.session("B").in_state("active");
		await s.type_in(s.editor, "draft for B");
		await s.wait_for_draft_saved("B", "draft for B");
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.contains_text("draft for A");
	});

	// ---------------------------------------------------------------
	// S-02 + S-11 + S-12: Sending messages and sequential handling
	// ---------------------------------------------------------------

	test("S-02/S-11/S-12: Sending messages produces responses in sequence", async () => {
		// shared setup
		await s.createTestSession("A");
		await openStoryApp(s);
		await s.navigate_to("session", "A");

		s.begin(STORY_S02);

		// act
		s.act();
		await s.send_message("hello world");
		await waitForAgentResponse(s.page);

		// assert
		s.assert();
		await s.message_list.is_visible("hello world");
		await s.message_list.is_visible("OK");

		s.begin(STORY_S11);

		// act — the mock agent responds instantly with "OK"
		s.act();
		await s.send_message("test streaming");
		await waitForAgentResponse(s.page);

		// assert
		s.assert();
		await s.message_list.is_visible("test streaming");
		await s.message_list.is_visible("OK");

		s.begin(STORY_S12);

		// act — send another message after the prior turn completed
		s.act();
		await s.send_message("second message");
		await waitForAgentResponse(s.page);

		// assert — sequential messages are visible
		s.assert();
		await s.message_list.is_visible("test streaming");
		await s.message_list.is_visible("second message");
	});

	// ---------------------------------------------------------------
	// S-04: Terminated session disappears from sidebar
	// ---------------------------------------------------------------

	test("S-04: Terminated session disappears from sidebar", async () => {
		s.begin(STORY_S04);

		// setup
		const sessionId = await s.createTestSession("A");
		await openStoryApp(s);
		await s.navigate_to("session", "A");

		// act
		s.act();
		await deleteSession(sessionId);
		await s.navigate_to("landing");

		// assert — sidebar updates and the deleted session disappears
		s.assert();
		await s.sidebar.is_hidden(sessionId.slice(0, 8));
	});

	// ---------------------------------------------------------------
	// S-05 + S-06 + S-07: Isolation, rapid switching, reload persistence
	// ---------------------------------------------------------------

	test("S-05/S-06/S-07: Session content isolation survives switching and reload", async () => {
		// shared setup
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.createTestSession("C");
		await openStoryApp(s);

		s.begin(STORY_S05);

		// act
		s.act();
		await s.navigate_to("session", "A");
		await s.send_message("alpha");
		await waitForAgentResponse(s.page);

		await s.navigate_to("session", "B");
		await s.send_message("beta");
		await waitForAgentResponse(s.page);

		// assert — session A has alpha, not beta
		s.assert();
		await s.navigate_to("session", "A");
		await s.message_list.is_visible("alpha");
		await s.message_list.is_hidden("beta");

		// assert — session B has beta, not alpha
		await s.navigate_to("session", "B");
		await s.message_list.is_visible("beta");
		await s.message_list.is_hidden("alpha");

		s.begin(STORY_S06);

		// setup — add unique content to C so final rapid-switch target is verifiable
		await s.navigate_to("session", "C");
		await s.send_message("msg-c");
		await waitForAgentResponse(s.page);

		// act — rapidly switch without waiting
		s.act();
		await s.navigate_to("session", "A");
		await s.navigate_to("session", "B");
		await s.navigate_to("session", "C");

		// assert — final session is C with correct content (retry until UI settles)
		s.assert();
		await expect(async () => {
			await s.session("C").in_state("active");
			await s.message_list.is_visible("msg-c");
		}).toPass({ timeout: 5_000 });

		s.begin(STORY_S07);

		// act
		s.act();
		await s.reload();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.message_list.is_visible("alpha");
	});
});
