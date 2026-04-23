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
import { apiFetch, waitForHealth } from "../e2e-setup.js";
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

	test("CT-01-a: Send message and observe streaming lifecycle @smoke", async () => {
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

	test("CT-01-b: Abort mid-stream preserves partial response @smoke", async () => {
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
		await s.send_message("STAY_BUSY:1500 long task");
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
		await s.send_message("STAY_BUSY:1500 first");
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
		await s.send_message("STAY_BUSY:1500 working");
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

	// ---------------------------------------------------------------
	// ST-DEDUP-01: Reconnect mid-stream does not duplicate or reorder events
	// ---------------------------------------------------------------
	//
	// Reproduces the live-streaming dedup/reorder bug described in
	// docs/design/streaming-dedup-reorder.md §1.1. The server's broadcast
	// envelope currently carries no monotonic seq — so when the same
	// `{type:"event"}` frame is delivered twice (e.g. reconnect-catchup replay
	// overlapping with live events), the client cannot dedupe and appends the
	// assistant message / toolResult a second time.
	//
	// We simulate that overlap deterministically via a BOBBIT_E2E-only REST hook
	// (POST /api/internal/test/replay-buffered-events/:id) that re-broadcasts
	// every event currently in the session's EventBuffer on the SAME broadcast
	// path production uses. Pre-fix: clients see duplicate assistant and
	// toolResult messages. Post-fix (seq+ts on envelope, client dedupe by seq):
	// replayed events are dropped and the message list stays stable.
	test("ST-DEDUP-01: Reconnect mid-stream does not duplicate or reorder events", async () => {
		s.begin(defineStory({
			id: "ST-DEDUP-01",
			title: "Reconnect mid-stream does not duplicate or reorder events",
			contracts: [CT_01, CT_05],
			covers: ["reconnect-mid-stream-dedup"],
		}));

		// setup
		const sessionId = await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// Send a prompt that drives the mock agent through a tool-use burst:
		//   message_end (user) → tool_execution_start(Bash) →
		//   message_end (assistant, with toolCall) →
		//   message_end (toolResult) → tool_execution_end.
		// The "bash" keyword in the prompt matches MockAgentCore.respondToPrompt
		// and produces a deterministic unique-token echo we can count.
		await s.send_message("please run the bash tool and echo BOBBIT_TOOL_TEST_OK_12345");
		await s.wait_for_idle();

		// Snapshot the authoritative DOM counts right after the turn ends.
		// We count rendered custom elements (not appState, which isn't exposed on
		// window) — this matches what the user actually sees.
		const snapshot = async () => await s.page.evaluate(() => ({
			user: document.querySelectorAll("user-message").length,
			assistant: document.querySelectorAll("assistant-message").length,
			tool: document.querySelectorAll("tool-message").length,
			bashOutputs: Array.from(document.querySelectorAll("tool-message"))
				.filter(el => (el.textContent || "").includes("BOBBIT_TOOL_TEST_OK_12345")).length,
		}));
		// wait_for_idle returns when the server reports idle, but the final
		// toolResult message_end may still be in-flight to the client. Poll the
		// DOM until the echoed unique marker is rendered before capturing the
		// baseline — otherwise the replay assertion is meaningless.
		await expect.poll(
			async () => (await snapshot()).bashOutputs,
			{ timeout: 15_000, message: "bash tool output did not render before baseline" },
		).toBeGreaterThan(0);
		const baseline = await snapshot();
		expect(baseline.assistant).toBeGreaterThan(0);
		expect(baseline.tool).toBeGreaterThan(0);

		// act — replay every buffered event to the live client, simulating a
		// reconnect-catch-up stream that overlaps with already-rendered state.
		s.act();
		const replayResp = await apiFetch(`/api/internal/test/replay-buffered-events/${sessionId}`, { method: "POST" });
		expect(replayResp.status).toBe(200);
		const replayBody = await replayResp.json() as { replayed: number; bufferSize: number };
		expect(replayBody.replayed).toBeGreaterThan(0);

		// Give the client a short window to process replayed frames, then poll
		// until DOM counts stabilise (either because dedup worked, or because the
		// bug finished appending duplicate messages).
		let last = baseline;
		let stableTicks = 0;
		const deadline = Date.now() + 3_000;
		while (Date.now() < deadline) {
			await s.page.waitForTimeout(100);
			const cur = await snapshot();
			if (cur.user === last.user && cur.assistant === last.assistant
				&& cur.tool === last.tool && cur.bashOutputs === last.bashOutputs) {
				stableTicks++;
			} else { stableTicks = 0; last = cur; }
			if (stableTicks >= 5) break;
		}

		// assert — the replayed buffered events must not produce any extra
		// rendered messages. Pre-fix the assistant turn (toolCall + toolResult)
		// is silently appended a second time because the client has no seq-based
		// identity to dedupe against. The bash-tool output token is our
		// deterministic unique marker — it must appear exactly once.
		s.assert();
		const post = await snapshot();
		if (post.user !== baseline.user || post.assistant !== baseline.assistant
			|| post.tool !== baseline.tool || post.bashOutputs !== baseline.bashOutputs
			|| post.bashOutputs !== 1) {
			throw new Error(
				`ST-DEDUP-01: duplicated messages after mid-stream replay. `
				+ `baseline=${JSON.stringify(baseline)}, postReplay=${JSON.stringify(post)}, `
				+ `replayed=${replayBody.replayed} events. Expected bashOutputs=1 exactly; `
				+ `a count >1 means the toolResult message_end was processed twice `
				+ `because the broadcast envelope lacks a monotonic seq the client can dedupe on.`
			);
		}
		expect(post.bashOutputs).toBe(1);
		expect(post.assistant).toBe(baseline.assistant);
		expect(post.tool).toBe(baseline.tool);
		expect(post.user).toBe(baseline.user);
	});

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
		await s.send_message("STAY_BUSY:1500 working");
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
