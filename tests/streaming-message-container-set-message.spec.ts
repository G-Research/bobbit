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
