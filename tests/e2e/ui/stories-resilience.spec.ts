/**
 * Resilience stories — CT-05
 *
 * Only RE-07 (state survives disconnect + reload) runs in standard E2E.
 *
 * RE-01..RE-06 and RE-08 require server crash/restart which is only
 * available in the manual-integration harness. They are covered by
 * `tests/manual-integration/session-resilience.spec.ts` (Phases D+E:
 * hard-kill + post-restart verify) and have been removed from this file
 * to avoid duplicate, unrunnable test stubs.
 *
 * Phase annotations control what gets tracked in the spec graph:
 *   setup  → preconditions, incidental navigation (not tracked)
 *   act    → the user actions under test (tracked)
 *   assert → the expected outcomes (tracked)
 *   cleanup → teardown (not tracked)
 */
import { test } from "../gateway-harness.js";
import { waitForHealth } from "../e2e-setup.js";
import { SpecContext } from "./spec-framework.js";
import { STORY_RE07 } from "./story-registry.js";

test.describe("CT-05: Resilience", () => {
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
	// RE-07: State survives disconnect + reload
	// The only resilience story that runs in standard E2E.
	// ---------------------------------------------------------------

	test("RE-07: State survives disconnect and reload", async () => {
		s.begin(STORY_RE07);

		// setup — create session with a message
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");
		await s.send_message("hello before disconnect");
		await s.event.agent_finish("A");

		// act — disconnect WebSocket, then reload the page.
		// The reload tears down the page entirely, so we don't need to wait
		// for the WS close to settle on the old context — the new page will
		// reconnect fresh.
		s.act();
		await s.event.disconnect();
		await s.reload();

		// assert — session appears in sidebar, messages intact
		s.assert();
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");
		await s.message_list.contains_text("hello before disconnect");
	});
});
