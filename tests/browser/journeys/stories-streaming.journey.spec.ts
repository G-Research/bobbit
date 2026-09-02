/**
 * Streaming Lifecycle stories — CT-01, CT-06
 *
 * These stories ARE the specification. Each test reads as a behavioral
 * requirement and runs as a Playwright browser journey.
 *
 * Phase annotations control what gets tracked in the spec graph:
 *   setup  → preconditions, incidental navigation (not tracked)
 *   act    → the user actions under test (tracked)
 *   assert → the expected outcomes (tracked)
 *   cleanup → teardown (not tracked)
 */
import { test, expect } from "../../e2e/ui/fixtures.js";
import { apiFetch, waitForHealth } from "../../e2e/e2e-setup.js";
import { SpecContext, defineStory } from "../../e2e/ui/spec-framework.js";
import { CT_01, CT_02, CT_05, CT_06 } from "../../e2e/ui/spec-contracts.js";

test.describe("CT-01: Streaming lifecycle", () => {
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
	// CT-01-b / CT-01-c: Abort mid-stream and re-send
	// ---------------------------------------------------------------

	test("CT-01-b/c: Abort mid-stream preserves editor and allows re-send @smoke", async () => {
		const abortStory = defineStory({
			id: "CT-01-b",
			title: "Abort mid-stream preserves partial response",
			contracts: [CT_01, CT_06],
			covers: ["abort-mid-stream"],
		});
		const resendStory = defineStory({
			id: "CT-01-c",
			title: "Re-send after abort",
			contracts: [CT_01],
			covers: ["re-send-after-abort"],
		});

		// setup
		s.begin(abortStory);
		await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act — abort a live stream
		s.act();
		await s.send_message("STAY_BUSY:1500 first");
		await s.wait_for_streaming();
		await s.stop_streaming();
		await s.wait_for_idle();

		// assert — CT-01-b leaves the editor usable
		s.assert();
		await s.editor.can("send_message");
		// After abort, click textarea to confirm it's usable (focus may stay on
		// the now-removed stop button rather than auto-transferring)
		await s.page.locator("message-editor textarea").first().click();
		await s.editor.is_focused();

		// act/assert — CT-01-c can re-send after the abort
		s.begin(resendStory);
		s.act();
		await s.send_message("hello");
		s.assert();
		await s.wait_for_idle();
		await s.message_list.contains_text("hello");
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
		await s.send_message("STAY_BUSY:3000 working");
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
	test("ST-DEDUP-01: Reconnect mid-stream does not duplicate or reorder events", async ({ rec }) => {
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
		await rec.capture("Bash tool turn complete");

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
		await rec.capture(`Replayed ${replayBody.replayed} buffered events`);

		// Give the client a short window to process replayed frames, then poll
		// in-page until DOM counts stabilise for ~500ms (5 ticks × 100ms).
		// This runs entirely inside `page.waitForFunction` so no host-side
		// `waitForTimeout` is needed; the polling delay is the page poll
		// interval (100ms) baked into Playwright's waitForFunction.
		await s.page.waitForFunction(() => {
			const w = window as unknown as { __streamingStability?: { last: number; ticks: number } };
			const snap = {
				user: document.querySelectorAll("user-message").length,
				assistant: document.querySelectorAll("assistant-message").length,
				tool: document.querySelectorAll("tool-message").length,
				bash: Array.from(document.querySelectorAll("tool-message"))
					.filter(el => (el.textContent || "").includes("BOBBIT_TOOL_TEST_OK_12345")).length,
			};
			const hash = `${snap.user}|${snap.assistant}|${snap.tool}|${snap.bash}`;
			const hashHash = hash.split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
			if (!w.__streamingStability || w.__streamingStability.last !== hashHash) {
				w.__streamingStability = { last: hashHash, ticks: 1 };
				return false;
			}
			w.__streamingStability.ticks++;
			return w.__streamingStability.ticks >= 5;
		}, null, { timeout: 5_000, polling: 100 });

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
		await rec.capture("Post-replay DOM stable — no duplicates");
	});

	// ---------------------------------------------------------------
	// ST-DEDUP-02 / ST-DEDUP-03: Proposal burst ordering and replay dedup.
	// ---------------------------------------------------------------
	//
	// Pre-fix: legacy `_deferredAssistantMessage` could overwrite the first
	// `propose_*` assistant turn in a burst, and replayed buffered events could
	// append a second copy of either widget. The unified reducer keys transcript
	// rows by (_order, _insertionTick) and live-event seq, so the same burst can
	// prove both source order and replay stability.
	test("ST-DEDUP-02/03: Proposal burst order survives replay", async ({ rec }) => {
		const burstOrderStory = defineStory({
			id: "ST-DEDUP-02",
			title: "Proposal burst keeps both widgets in order",
			contracts: [CT_01],
			covers: ["unified-message-ordering-reducer", "proposal-burst"],
		});
		const replayStory = defineStory({
			id: "ST-DEDUP-03",
			title: "Mid-burst reconnect preserves widgets exactly once",
			contracts: [CT_01, CT_05],
			covers: ["unified-message-ordering-reducer", "replay-dedup"],
		});

		const countWidgets = async () => await s.page.evaluate(() => {
			const body = document.body.textContent || "";
			const order: string[] = [];
			let goal = 0, role = 0;
			for (const el of document.querySelectorAll("assistant-message")) {
				const t = el.textContent || "";
				if (t.includes("Goal Proposal")) { order.push("goal"); goal++; }
				if (t.includes("Role Proposal")) { order.push("role"); role++; }
			}
			return {
				goal,
				role,
				order,
				assistant: document.querySelectorAll("assistant-message").length,
				done: body.split("BURST_DONE_E2E").length - 1,
			};
		});

		// setup
		s.begin(burstOrderStory);
		const sessionId = await s.createTestSession("A");
		await s.open();
		await s.navigate_to("session", "A");

		// act — one burst supplies both ordering and replay-dedup coverage
		s.act();
		await rec.capture("Empty session before burst");
		await s.send_message("please run a proposal_burst for E2E");
		await s.wait_for_idle();
		await rec.capture("Burst complete — idle");

		await expect.poll(async () => (await countWidgets()).done, {
			timeout: 15_000,
			message: "burst close marker did not render",
		}).toBeGreaterThan(0);

		// assert — ST-DEDUP-02: both proposal widgets render once, in source order.
		s.assert();
		const before = await countWidgets();
		expect(before.goal).toBe(1);
		expect(before.role).toBe(1);
		expect(before.order).toEqual(["goal", "role"]);
		await rec.capture("Both widgets rendered in order");

		// act — ST-DEDUP-03: replay every buffered event.
		s.begin(replayStory);
		s.act();
		const replayResp = await apiFetch(`/api/internal/test/replay-buffered-events/${sessionId}`, { method: "POST" });
		expect(replayResp.status).toBe(200);
		await rec.capture("Replay dispatched");

		// Wait for DOM to stabilise.
		await s.page.waitForFunction(() => {
			let goal = 0, role = 0;
			for (const el of document.querySelectorAll("assistant-message")) {
				const t = el.textContent || "";
				if (t.includes("Goal Proposal")) goal++;
				if (t.includes("Role Proposal")) role++;
			}
			const hash = `${goal}|${role}|${document.querySelectorAll("assistant-message").length}`;
			const w = window as any;
			if (!w.__burstStability || w.__burstStability.last !== hash) {
				w.__burstStability = { last: hash, ticks: 1 };
				return false;
			}
			w.__burstStability.ticks++;
			return w.__burstStability.ticks >= 5;
		}, null, { timeout: 5_000, polling: 100 });

		// assert — replay must not duplicate widgets or assistant rows.
		s.assert();
		const after = await countWidgets();
		expect(after.goal).toBe(1);
		expect(after.role).toBe(1);
		expect(after.assistant).toBe(before.assistant);
		await rec.capture("Post-replay — widgets unique");
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

	test.beforeEach(async ({ page, gateway }) => {
		s = new SpecContext(page, gateway);
	});

	test.afterEach(async () => {
		await s.cleanup();
	});

	// ---------------------------------------------------------------
	// CT-06-a / CT-06-b: Focus follows navigation intent
	// ---------------------------------------------------------------

	test("CT-06-a/b: Focus follows session switch and settings detour", async () => {
		const switchStory = defineStory({
			id: "CT-06-a",
			title: "Focus follows rapid session switch",
			contracts: [CT_06],
			covers: ["rapid-session-switch"],
		});
		const dialogStory = defineStory({
			id: "CT-06-b",
			title: "Focus returns after dialog close",
			contracts: [CT_06],
			covers: ["dialog-close"],
		});

		// setup
		s.begin(switchStory);
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.open();

		// act/assert — CT-06-a rapid session switching keeps focus in the editor
		s.act();
		await s.navigate_to("session", "A");
		s.assert();
		await s.editor.is_focused();

		s.act();
		await s.navigate_to("session", "B");
		s.assert();
		await s.editor.is_focused();

		s.act();
		await s.navigate_to("session", "A");
		s.assert();
		await s.editor.is_focused();

		// act/assert — CT-06-b focus returns after leaving and re-entering chat
		s.begin(dialogStory);
		s.act();
		await s.navigate_to("settings");
		await s.navigate_to("session", "A");
		s.assert();
		await s.editor.is_focused();
	});
});
