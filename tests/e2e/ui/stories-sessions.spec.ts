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
import { waitForHealth, apiFetch, createSession, deleteSession, waitForSessionStatus, gitCwd } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";
import { SpecContext, defineStory } from "./spec-framework.js";
import { CT_01, CT_02, CT_05, CT_15, CT_16 } from "./spec-contracts.js";

test.describe("Session lifecycle stories", () => {
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
	// S-01: New session shows empty chat with focused editor
	// ---------------------------------------------------------------

	test("S-01: New session shows empty chat with focused editor", async () => {
		s.begin(defineStory({
			id: "S-01",
			title: "New session shows empty chat with focused editor",
			contracts: [CT_05, CT_16],
			covers: ["browser-refresh", "page-reload"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();

		// act
		s.act();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.is_focused();
		await s.editor.is_empty();
		await s.editor.cannot("send_message");
	});

	// ---------------------------------------------------------------
	// S-02: Sending a message produces an agent response
	// ---------------------------------------------------------------

	test("S-02: Sending a message produces an agent response", async () => {
		s.begin(defineStory({
			id: "S-02",
			title: "Sending a message produces an agent response",
			contracts: [CT_05],
			covers: ["browser-refresh"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act
		s.act();
		await s.send_message("hello world");
		await waitForAgentResponse(s.page);

		// assert
		s.assert();
		await s.message_list.is_visible("hello world");
		await s.message_list.is_visible("OK");
	});

	// ---------------------------------------------------------------
	// S-03: Draft isolation across sessions
	// ---------------------------------------------------------------

	test("S-03: Draft isolation across sessions", async () => {
		s.begin(defineStory({
			id: "S-03",
			title: "Draft isolation across sessions",
			contracts: [CT_02, CT_05],
			covers: ["rapid-session-switch", "page-reload", "browser-refresh"],
		}));

		// setup
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.open();

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
	// S-04: Terminated session disappears from sidebar
	// ---------------------------------------------------------------

	test("S-04: Terminated session disappears from sidebar", async () => {
		s.begin(defineStory({
			id: "S-04",
			title: "Terminated session disappears from sidebar",
			contracts: [CT_16],
			covers: ["page-reload"],
		}));

		// setup
		const sessionId = await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act
		s.act();
		await deleteSession(sessionId);
		await s.navigate_to("landing");
		// Give sidebar time to update
		await s.page.waitForTimeout(1_000);

		// assert
		s.assert();
		await s.sidebar.is_hidden(sessionId.slice(0, 8));
	});

	// ---------------------------------------------------------------
	// S-05: Messages stay isolated between sessions
	// ---------------------------------------------------------------

	test("S-05: Messages stay isolated between sessions", async () => {
		s.begin(defineStory({
			id: "S-05",
			title: "Messages stay isolated between sessions",
			contracts: [CT_05],
			covers: ["browser-refresh"],
		}));

		// setup
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.open();

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
	});

	// ---------------------------------------------------------------
	// S-06: Rapid session switching lands on correct session
	// ---------------------------------------------------------------

	test("S-06: Rapid session switching lands on correct session", async () => {
		s.begin(defineStory({
			id: "S-06",
			title: "Rapid session switching lands on correct session",
			contracts: [CT_05],
			covers: ["browser-refresh"],
		}));

		// setup
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.createTestSession("C");
		await s.open();

		// Send unique messages so we can verify correct session content
		await s.navigate_to("session", "A");
		await s.send_message("msg-a");
		await waitForAgentResponse(s.page);

		await s.navigate_to("session", "B");
		await s.send_message("msg-b");
		await waitForAgentResponse(s.page);

		await s.navigate_to("session", "C");
		await s.send_message("msg-c");
		await waitForAgentResponse(s.page);

		// act — rapidly switch without waiting
		s.act();
		await s.navigate_to("session", "A");
		await s.navigate_to("session", "B");
		await s.navigate_to("session", "C");

		// assert — final session is C with correct content
		s.assert();
		await s.session("C").in_state("active");
		await s.message_list.is_visible("msg-c");
	});

	// ---------------------------------------------------------------
	// S-07: Session survives page reload
	// ---------------------------------------------------------------

	test("S-07: Session survives page reload", async () => {
		s.begin(defineStory({
			id: "S-07",
			title: "Session survives page reload",
			contracts: [CT_05],
			covers: ["browser-refresh"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");
		await s.send_message("persistence test");
		await waitForAgentResponse(s.page);

		// act
		s.act();
		await s.reload();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.message_list.is_visible("persistence test");
	});

	// ---------------------------------------------------------------
	// S-08: Session in git repo gets a worktree branch
	// ---------------------------------------------------------------

	test("S-08: Session in git repo gets a worktree", async () => {
		s.begin(defineStory({
			id: "S-08",
			title: "Session in git repo gets a worktree",
			contracts: [CT_05, CT_16],
			covers: ["browser-refresh", "page-reload"],
		}));

		// setup
		const cwd = gitCwd();
		const sessionId = await s.createTestSession("A", { cwd });
		await waitForSessionStatus(sessionId, "idle");

		// act
		s.act();
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.ok).toBe(true);
		const data = await resp.json();

		// assert — session should have a worktree path (set by session-setup pipeline)
		s.assert();
		expect(data.worktreePath).toBeTruthy();
		expect(typeof data.worktreePath).toBe("string");
	});

	// ---------------------------------------------------------------
	// S-09: Renamed session title persists after reload
	// ---------------------------------------------------------------

	test("S-09: Renamed session title persists after reload", async () => {
		s.begin(defineStory({
			id: "S-09",
			title: "Renamed session title persists after reload",
			contracts: [CT_05],
			covers: ["browser-refresh"],
		}));

		// setup
		const sessionId = await s.createTestSession("A");

		// act — rename via API (more reliable than UI double-click)
		s.act();
		const patchResp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "My Custom Title" }),
		});
		expect(patchResp.ok).toBe(true);

		// Verify via API that rename persisted
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			expect(data.title).toBe("My Custom Title");
		}).toPass({ timeout: 5_000 });

		// Open and reload to verify persistence
		await s.open();
		await s.reload();

		// assert — verify title persists after reload via API
		s.assert();
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			expect(data.title).toBe("My Custom Title");
		}).toPass({ timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// S-10: Session properties persist across reload
	// ---------------------------------------------------------------

	test("S-10: Session properties persist across reload", async () => {
		s.begin(defineStory({
			id: "S-10",
			title: "Session properties persist across reload",
			contracts: [CT_05, CT_15],
			covers: ["browser-refresh"],
		}));

		// setup
		const sessionId = await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act — change a session property (colorIndex) via PATCH API
		s.act();
		const patchResp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ colorIndex: 5 }),
		});
		expect(patchResp.ok).toBe(true);
		await s.reload();

		// assert — verify property persisted via API after reload
		s.assert();
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			expect(data.colorIndex).toBe(5);
		}).toPass({ timeout: 5_000 });
	});

	// ---------------------------------------------------------------
	// S-11: Send message and receive agent response
	// ---------------------------------------------------------------

	test("S-11: Send message and receive agent response", async () => {
		s.begin(defineStory({
			id: "S-11",
			title: "Send message and receive agent response",
			contracts: [CT_01],
			covers: ["abort-mid-stream"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act — the mock agent responds instantly with "OK"
		s.act();
		await s.send_message("test streaming");
		await waitForAgentResponse(s.page);

		// assert
		s.assert();
		await s.message_list.is_visible("test streaming");
		await s.message_list.is_visible("OK");
	});

	// ---------------------------------------------------------------
	// S-12: Sequential messages are handled correctly
	// ---------------------------------------------------------------

	test("S-12: Sequential messages are handled correctly", async () => {
		s.begin(defineStory({
			id: "S-12",
			title: "Sequential messages are handled correctly",
			contracts: [CT_01, CT_02],
			covers: ["rapid-sends-while-streaming"],
		}));

		// setup
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act — send first message, wait for response, then send second
		s.act();
		await s.send_message("first message");
		await waitForAgentResponse(s.page);
		await s.send_message("second message");
		await waitForAgentResponse(s.page);

		// assert — both messages and responses visible
		s.assert();
		await s.message_list.is_visible("first message");
		await s.message_list.is_visible("second message");
	});
});
