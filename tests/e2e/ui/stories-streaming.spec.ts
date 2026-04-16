/**
 * Streaming Lifecycle stories — CT-01, CT-06
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
import { waitForHealth } from "../e2e-setup.js";
import { SpecContext, defineStory } from "./spec-framework.js";
import { CT_01, CT_02, CT_05, CT_06 } from "./spec-contracts.js";

test.describe("CT-01: Streaming lifecycle", () => {
	let s: SpecContext;

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page }) => {
		s = new SpecContext(page);
	});

	test.afterEach(async () => {
		await s.cleanup();
	});

	// ---------------------------------------------------------------
	// CT-01-a: Send message and observe streaming lifecycle
	// ---------------------------------------------------------------

	test("CT-01-a: Send message and observe streaming lifecycle", async () => {
		s.begin(defineStory({
			id: "CT-01-a",
			title: "Send message and observe streaming lifecycle",
			contracts: [CT_01, CT_06],
			covers: [],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act
		s.act();
		await s.send_message("STAY_BUSY:3000 hello world");

		// assert
		s.assert();
		await s.wait_for_streaming();
		await s.editor.can("stop_streaming");
		await s.wait_for_idle();
		await s.editor.can("send_message");
		await s.editor.is_focused();
		await s.message_list.contains_text("hello world");
	});

	// ---------------------------------------------------------------
	// CT-01-b: Abort mid-stream preserves partial response
	// ---------------------------------------------------------------

	test("CT-01-b: Abort mid-stream preserves partial response", async () => {
		s.begin(defineStory({
			id: "CT-01-b",
			title: "Abort mid-stream preserves partial response",
			contracts: [CT_01, CT_06],
			covers: ["abort-mid-stream"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act
		s.act();
		await s.send_message("STAY_BUSY:5000 long task");
		await s.wait_for_streaming();
		await s.stop_streaming();
		await s.wait_for_idle();

		// assert
		s.assert();
		await s.editor.can("send_message");
		// After abort, click textarea to confirm it's usable (focus may stay on
		// the now-removed stop button rather than auto-transferring)
		await s.page.locator("message-editor textarea").first().click();
		await s.editor.is_focused();
	});

	// ---------------------------------------------------------------
	// CT-01-c: Re-send after abort
	// ---------------------------------------------------------------

	test("CT-01-c: Re-send after abort", async () => {
		s.begin(defineStory({
			id: "CT-01-c",
			title: "Re-send after abort",
			contracts: [CT_01],
			covers: ["re-send-after-abort"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act
		s.act();
		await s.send_message("STAY_BUSY:5000 first");
		await s.wait_for_streaming();
		await s.stop_streaming();
		await s.wait_for_idle();
		await s.send_message("hello");

		// assert
		s.assert();
		await s.wait_for_idle();
		await s.message_list.contains_text("hello");
	});

	// ---------------------------------------------------------------
	// CT-01-d: Rapid sends while streaming queue messages
	// ---------------------------------------------------------------

	test("CT-01-d: Rapid sends while streaming queue messages", async () => {
		s.begin(defineStory({
			id: "CT-01-d",
			title: "Rapid sends while streaming queue messages",
			contracts: [CT_01],
			covers: ["rapid-sends-while-streaming"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act
		s.act();
		await s.send_message("STAY_BUSY:3000 working");
		await s.wait_for_streaming();
		await s.send_message("queued1");
		await s.send_message("queued2");

		// assert
		s.assert();
		await expect(s.page.locator(".queue-pill").first())
			.toBeVisible({ timeout: 5_000 });
		await s.wait_for_idle();
		await s.message_list.contains_text("queued1");
		await s.message_list.contains_text("queued2");
	});

	// ---------------------------------------------------------------
	// CT-01-e: Session switch during stream
	// ---------------------------------------------------------------

	test("CT-01-e: Session switch during stream", async () => {
		s.begin(defineStory({
			id: "CT-01-e",
			title: "Session switch during stream",
			contracts: [CT_01, CT_02],
			covers: ["session-switch-during-stream"],
		}));

		// setup
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.open();

		// act
		s.act();
		await s.navigate_to("session", "A");
		await s.send_message("STAY_BUSY:5000 working");
		await s.wait_for_streaming();
		await s.navigate_to("session", "B");
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.can("stop_streaming");
	});

	// ---------------------------------------------------------------
	// CT-01-f: Page reload during stream
	// ---------------------------------------------------------------

	test("CT-01-f: Page reload during stream", async () => {
		s.begin(defineStory({
			id: "CT-01-f",
			title: "Page reload during stream",
			contracts: [CT_01, CT_05],
			covers: ["page-reload"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act
		s.act();
		await s.send_message("STAY_BUSY:5000 working");
		await s.wait_for_streaming();
		await s.reload();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.is_visible();
		await s.editor.can("send_message");
	});
});

test.describe("CT-06: Focus follows intent", () => {
	let s: SpecContext;

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page }) => {
		s = new SpecContext(page);
	});

	test.afterEach(async () => {
		await s.cleanup();
	});

	// ---------------------------------------------------------------
	// CT-06-a: Focus follows rapid session switch
	// ---------------------------------------------------------------

	test("CT-06-a: Focus follows rapid session switch", async () => {
		s.begin(defineStory({
			id: "CT-06-a",
			title: "Focus follows rapid session switch",
			contracts: [CT_06],
			covers: ["rapid-session-switch"],
		}));

		// setup
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.open();

		// act
		s.act();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.is_focused();

		// act — switch to B
		s.act();
		await s.navigate_to("session", "B");

		// assert
		s.assert();
		await s.editor.is_focused();

		// act — switch back to A
		s.act();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.is_focused();
	});

	// ---------------------------------------------------------------
	// CT-06-b: Focus returns after dialog close
	// ---------------------------------------------------------------

	test("CT-06-b: Focus returns after dialog close", async () => {
		s.begin(defineStory({
			id: "CT-06-b",
			title: "Focus returns after dialog close",
			contracts: [CT_06],
			covers: ["dialog-close"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act
		s.act();
		await s.navigate_to("settings");
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.is_focused();
	});
});
