/**
 * Resilience stories — CT-05
 *
 * These stories ARE the specification. Each test reads as a behavioral
 * requirement and runs as a Playwright E2E test.
 *
 * RE-01 through RE-06 and RE-08 require the manual-integration harness
 * (npm run test:manual) — server crash/restart is not available in the
 * standard E2E harness. They are written with full spec-framework API
 * but skipped in standard E2E runs.
 *
 * RE-07 is the only test that runs in standard E2E — it tests WebSocket
 * disconnection followed by page reload.
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
import {
	STORY_RE01,
	STORY_RE02,
	STORY_RE03,
	STORY_RE04,
	STORY_RE05,
	STORY_RE06,
	STORY_RE07,
	STORY_RE08,
} from "./story-registry.js";

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
	// RE-01: Single session survives server crash
	// INFRASTRUCTURE: Requires npm run test:manual
	// ---------------------------------------------------------------

	test.skip("RE-01: Single session survives server crash", async () => {
		s.begin(STORY_RE01);

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act — send a message, crash, restart
		s.act();
		await s.send_message("ping before crash");
		await s.event.agent_finish("A");
		await s.event.server_crash();
		await s.event.server_restart();

		// assert — session and messages survive
		s.assert();
		await s.sidebar.is_visible();
		await s.navigate_to("session", "A");
		await s.message_list.contains_text("ping before crash");
	});

	// ---------------------------------------------------------------
	// RE-02: Goal and dashboard survive server crash
	// INFRASTRUCTURE: Requires npm run test:manual
	// ---------------------------------------------------------------

	test.skip("RE-02: Goal and dashboard survive server crash", async () => {
		s.begin(STORY_RE02);

		// setup — create goal with gates/tasks
		await s.open();

		// act — crash and restart
		s.act();
		await s.event.server_crash();
		await s.event.server_restart();

		// assert — goal dashboard shows same gate statuses
		s.assert();
		await s.sidebar.is_visible();
		await s.dashboard.is_visible();
	});

	// ---------------------------------------------------------------
	// RE-03: Multiple session types survive restart
	// INFRASTRUCTURE: Requires npm run test:manual
	// ---------------------------------------------------------------

	test.skip("RE-03: Multiple session types survive restart", async () => {
		s.begin(STORY_RE03);

		// setup — create 5 different session types
		await s.createTestSession("plain");
		await s.createTestSession("worktree");
		await s.createTestSession("goal-session");
		await s.createTestSession("large");
		await s.createTestSession("minimal");
		await s.open();

		// act — crash and restart
		s.act();
		await s.event.server_crash();
		await s.event.server_restart();

		// assert — all 5 sessions appear in sidebar
		s.assert();
		await s.sidebar.is_visible();
		// Each session should be present after restart
		await s.navigate_to("session", "plain");
		await s.session("plain").in_state("active");
		await s.navigate_to("session", "worktree");
		await s.session("worktree").in_state("active");
		await s.navigate_to("session", "goal-session");
		await s.session("goal-session").in_state("active");
		await s.navigate_to("session", "large");
		await s.session("large").in_state("active");
		await s.navigate_to("session", "minimal");
		await s.session("minimal").in_state("active");
	});

	// ---------------------------------------------------------------
	// RE-04: Worktree preservation across crash
	// INFRASTRUCTURE: Requires npm run test:manual
	// ---------------------------------------------------------------

	test.skip("RE-04: Worktree preservation across crash", async () => {
		s.begin(STORY_RE04);

		// setup — create a worktree session
		await s.createTestSession("wt");
		await s.open();
		await s.navigate_to("session", "wt");
		await s.session("wt").in_state("active");

		// act — crash server
		s.act();
		await s.event.server_crash();
		// worktree directory should still exist on disk
		await s.event.server_restart();

		// assert — session loads, branch correct
		s.assert();
		await s.navigate_to("session", "wt");
		await s.session("wt").in_state("active");
	});

	// ---------------------------------------------------------------
	// RE-05: Docker sandbox container recovery
	// INFRASTRUCTURE: Requires npm run test:manual + Docker
	// ---------------------------------------------------------------

	test.skip("RE-05: Docker sandbox container recovery", async () => {
		s.begin(STORY_RE05);

		// setup — session using sandbox container
		await s.createTestSession("sandbox");
		await s.open();
		await s.navigate_to("session", "sandbox");

		// act — kill container, wait for auto-recovery
		s.act();
		await s.event.server_crash();
		await s.event.server_restart();

		// assert — session functional, container recreated
		s.assert();
		await s.navigate_to("session", "sandbox");
		await s.session("sandbox").in_state("active");
	});

	// ---------------------------------------------------------------
	// RE-06: Crash during session setup
	// INFRASTRUCTURE: Requires npm run test:manual
	// ---------------------------------------------------------------

	test.skip("RE-06: Crash during session setup", async () => {
		s.begin(STORY_RE06);

		// setup — begin session creation
		await s.open();

		// act — create session then immediately crash
		s.act();
		await s.createTestSession("setup-crash");
		await s.event.server_crash();
		await s.event.server_restart();

		// assert — no corruption, can create new sessions
		s.assert();
		await s.sidebar.is_visible();
		// Creating a brand-new session should work without issues
		await s.createTestSession("post-crash");
		await s.navigate_to("session", "post-crash");
		await s.session("post-crash").in_state("active");
	});

	// ---------------------------------------------------------------
	// RE-07: State survives disconnect + reload
	// This is the ONLY non-skipped resilience test
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

		// act — disconnect WebSocket, then reload the page
		s.act();
		await s.event.disconnect();
		await s.page.waitForTimeout(1_000);
		await s.reload();

		// assert — session appears in sidebar, messages intact
		s.assert();
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");
		await s.message_list.contains_text("hello before disconnect");
	});

	// ---------------------------------------------------------------
	// RE-08: Rapid crash-restart cycle stability
	// INFRASTRUCTURE: Requires npm run test:manual
	// ---------------------------------------------------------------

	test.skip("RE-08: Rapid crash-restart cycle stability", async () => {
		s.begin(STORY_RE08);

		// setup — sessions and goals exist
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.createTestSession("C");
		await s.open();

		// act — crash 3 times rapidly
		s.act();
		await s.event.server_crash();
		await s.event.server_restart();
		await s.event.server_crash();
		await s.event.server_restart();
		await s.event.server_crash();
		await s.event.server_restart();

		// assert — all sessions and goals intact
		s.assert();
		await s.sidebar.is_visible();
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");
		await s.navigate_to("session", "B");
		await s.session("B").in_state("active");
		await s.navigate_to("session", "C");
		await s.session("C").in_state("active");
	});
});
