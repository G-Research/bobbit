/**
 * Bug 1 — `StreamingMessageContainer._immediateUpdate` sticky flag drops one
 * streaming delta.
 *
 * After `setMessage(null, true)` (or any `immediate=true` call), the next
 * batched `setMessage(msg, false)` schedules a rAF; when the rAF fires it sees
 * `_immediateUpdate === true` (sticky from the previous immediate clear) and
 * silently skips the `this._message = pending` assignment, only THEN clearing
 * the flag. Result: one streaming delta is dropped — `_message` stays `null`.
 *
 * Repro via a Playwright file:// fixture: instantiate the component, drive
 *   1. setMessage(null, true)   // immediate clear; sets _immediateUpdate = true
 *   2. setMessage(<msg>, false) // batched delta; schedules rAF
 *   3. await one rAF tick
 * then assert _message reflects the message from step 2.
 *
 * On master this fails (msg dropped, _message stays null).
 * After the one-line fix (clearing `_immediateUpdate = false` synchronously
 * inside the immediate-clear branch) it passes.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/streaming-message-container.html");
const BUNDLE = path.resolve("tests/fixtures/streaming-message-container-bundle.js");
const ENTRY = path.resolve("tests/fixtures/streaming-message-container-entry.ts");
const SOURCE = path.resolve("src/ui/components/StreamingMessageContainer.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(SOURCE).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

test.describe("StreamingMessageContainer.setMessage — sticky _immediateUpdate flag", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);
	});

	test("batched setMessage after immediate-clear must NOT be silently dropped by the rAF callback", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const host = document.getElementById("host")!;
			const el: any = document.createElement("streaming-message-container");
			host.appendChild(el);
			// Wait one frame so the element is upgraded and connectedCallback ran.
			await new Promise((r) => requestAnimationFrame(() => r(null)));

			// Step 1: immediate clear. This sets `_immediateUpdate = true` and
			// returns synchronously without scheduling a rAF.
			el.setMessage(null, true);

			// Step 2: a batched streaming delta. This schedules a rAF. When the
			// rAF fires the buggy code sees `_immediateUpdate === true` (sticky
			// from step 1) and skips `_message = pending`, only THEN clearing
			// the flag — so the delta is silently dropped.
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "hello-delta" }],
				id: "msg-after-clear",
			};
			el.setMessage(msg, false);

			// Wait one rAF tick — long enough for the scheduled callback to run.
			await new Promise((r) => requestAnimationFrame(() => r(null)));
			// And one extra microtask flush, just in case.
			await new Promise((r) => setTimeout(r, 0));

			return {
				messageRole: el._message?.role ?? null,
				messageId: el._message?.id ?? null,
				messageText: Array.isArray(el._message?.content)
					? el._message.content[0]?.text ?? null
					: null,
				immediateFlag: el._immediateUpdate ?? null,
			};
		});

		// On master: messageRole === null (delta dropped). Fix flips this to
		// "assistant" with the expected text.
		expect(
			result.messageRole,
			"batched delta must land in _message after the immediate-clear branch",
		).toBe("assistant");
		expect(result.messageId).toBe("msg-after-clear");
		expect(result.messageText).toBe("hello-delta");
	});

	test("defensive clear: when isStreaming flips true → false with a stale _message, the container clears itself", async ({ page }) => {
		// Reproduces the "duplicate Thinking bubble at the end of an idle
		// chat" symptom. AgentInterface's `agent_end` / `message_end`
		// handlers normally call `setMessage(null, true)`, but they can be
		// bypassed by snapshot replays, status-only transitions, missed
		// agent_end events, or rAF races. `isStreaming=false` is the
		// authoritative "agent is idle" signal — the container must self
		// heal when it sees that flip while still holding a stale message.
		const result = await page.evaluate(async () => {
			const host = document.getElementById("host")!;
			const el: any = document.createElement("streaming-message-container");
			el.isStreaming = true;
			host.appendChild(el);
			// Wait for the element to upgrade and the initial render to commit.
			await new Promise((r) => requestAnimationFrame(() => r(null)));
			await el.updateComplete;

			// Simulate a `message_update` mid-stream populating the container.
			el.setMessage(
				{
					role: "assistant",
					id: "msg-mid-stream",
					content: [{ type: "thinking", thinking: "hmm let me think" }],
				},
				true,
			);
			await el.updateComplete;
			const beforeId = el._message?.id ?? null;

			// Status flips to idle WITHOUT AgentInterface calling
			// setMessage(null, true). Lit propagates the property change; the
			// container's `updated()` lifecycle must defensively clear the
			// stale `_message` on its own.
			el.isStreaming = false;
			await el.updateComplete;

			return {
				beforeId,
				afterMessage: el._message,
			};
		});

		expect(result.beforeId, "setup precondition: container holds the partial").toBe("msg-mid-stream");
		expect(
			result.afterMessage,
			"isStreaming → false must trigger a defensive clear so the duplicate " +
				"Thinking bubble cannot persist past the end of the turn",
		).toBeNull();
	});

	test("UX-05: archived flipping true in the SAME update as isStreaming going false strands the stale _message", async ({ page }) => {
		// Reproduces the realistic trigger for UX-05 (tracker W2.14): a session
		// mid-turn gets backgrounded (user switches away — the SESSION CACHE in
		// session-manager.ts keeps its ChatPanel/AgentInterface/RemoteAgent alive
		// off-screen, so nothing clears the container while it's not the active
		// view) and is then archived/terminated by another actor (another tab, a
		// goal-cascade reap, a scheduled purge) while backgrounded. The
		// backgrounded RemoteAgent's own `session_status` handler updates
		// `_state.status` immediately (remote-agent.ts's session_status case is
		// the sole writer), but nothing re-renders the inactive AgentInterface at
		// that moment (its onStatusChange callback in session-manager.ts guards
		// the readOnly write on `activeSessionId() === sessionId`, which is false
		// while backgrounded) — so the container's own `isStreaming`/`archived`
		// properties stay stale.
		//
		// When the user later re-selects that session from the sidebar/archived
		// list, connectToSession's fast-path cache-hit branch
		// (session-manager.ts ~1313-1332) reuses the SAME cached AgentInterface
		// and sets `ai.readOnly = true` in one property write. That single write
		// triggers one Lit re-render of AgentInterface, whose template
		// re-evaluates BOTH `.isStreaming=${state.isStreaming}` (now false, per
		// the status update received while backgrounded) and
		// `.archived=${this.readOnly && ...}` (now true) in the same pass — so
		// both properties land on the child in the same synchronous burst, and
		// Lit's own child-update batches them into one `updated()` call.
		//
		// StreamingMessageContainer.ts:94 early-returns on `archived` before the
		// `!isStreaming && _message !== null` defensive clear at :116-118, so the
		// stale in-flight assistant message is never dropped and keeps rendering
		// on top of the (now read-only) archived transcript.
		const result = await page.evaluate(async () => {
			const host = document.getElementById("host")!;
			const el: any = document.createElement("streaming-message-container");
			el.isStreaming = true;
			host.appendChild(el);
			await new Promise((r) => requestAnimationFrame(() => r(null)));
			await el.updateComplete;

			// Simulate the last `message_update` the container saw before the
			// session was backgrounded and then archived out from under it.
			el.setMessage(
				{
					role: "assistant",
					id: "msg-stranded",
					content: [{ type: "text", text: "partial reply before archive" }],
				},
				true,
			);
			await el.updateComplete;
			const beforeId = el._message?.id ?? null;
			const beforeHtml = el.innerHTML as string;

			// The reconnect/re-view re-render: AgentInterface's single template
			// pass feeds both new property values to the child in one
			// synchronous burst — exactly what a real parent re-render does.
			el.isStreaming = false;
			el.archived = true;
			await el.updateComplete;
			// The defensive clear calls setMessage(null, true) *inside* updated(),
			// which schedules its own follow-up requestUpdate(). Wait for that
			// nested render to settle too before inspecting the DOM.
			await el.updateComplete;
			await new Promise((r) => requestAnimationFrame(() => r(null)));

			return {
				beforeId,
				beforeHasAssistantMessage: beforeHtml.includes("<assistant-message"),
				afterMessage: el._message,
				afterHasAssistantMessage: (el.innerHTML as string).includes("<assistant-message"),
			};
		});

		expect(result.beforeId, "setup precondition: container holds the partial").toBe("msg-stranded");
		expect(result.beforeHasAssistantMessage, "setup precondition: the partial renders").toBe(true);
		expect(
			result.afterMessage,
			"archived flipping true in the same update as isStreaming->false must not " +
				"skip the defensive clear — otherwise the stale assistant card is " +
				"stranded on top of the now read-only archived transcript",
		).toBeNull();
		expect(
			result.afterHasAssistantMessage,
			"the stranded card must not still be in the DOM after the archived transition",
		).toBe(false);
	});

	test("a SECOND batched setMessage after the dropped one DOES land (proves only the first delta is lost)", async ({ page }) => {
		// This second test pins down the bug's signature: it's specifically
		// the FIRST delta after an immediate-clear that is dropped, because
		// after the buggy rAF runs and clears the flag, subsequent setMessage
		// calls behave normally. Without the fix, this test PASSES (proving
		// the asymmetry); the bug shows up only in the first test above.
		const result = await page.evaluate(async () => {
			const host = document.getElementById("host")!;
			const el: any = document.createElement("streaming-message-container");
			host.appendChild(el);
			await new Promise((r) => requestAnimationFrame(() => r(null)));

			el.setMessage(null, true);
			el.setMessage(
				{ role: "assistant", content: [{ type: "text", text: "first" }], id: "first" },
				false,
			);
			await new Promise((r) => requestAnimationFrame(() => r(null)));

			// Now drive a second batched delta. The flag has been cleared by
			// the prior rAF callback, so this one MUST land regardless.
			el.setMessage(
				{ role: "assistant", content: [{ type: "text", text: "second" }], id: "second" },
				false,
			);
			await new Promise((r) => requestAnimationFrame(() => r(null)));
			await new Promise((r) => setTimeout(r, 0));

			return {
				messageId: el._message?.id ?? null,
				messageText: Array.isArray(el._message?.content)
					? el._message.content[0]?.text ?? null
					: null,
			};
		});

		// Second delta always lands — this assertion holds on master AND post-fix.
		expect(result.messageId).toBe("second");
		expect(result.messageText).toBe("second");
	});
});
