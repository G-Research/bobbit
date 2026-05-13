/**
 * Bug — `StreamingMessageContainer` leaves the blob in `idle` (zzz) state
 * while the agent is actively streaming.
 *
 * Root cause: in `updated()` (src/ui/components/StreamingMessageContainer.ts
 * ~L62), the exit-animation `setTimeout` that writes `_blobState = 'idle'`
 * is neither stored to a tracked handle nor guarded by a current-state
 * check. So when `isStreaming` flips false→true within the 700–900 ms
 * exit window, the third `else if` correctly sets `_blobState = 'active'`,
 * but the orphan timer fires later and unconditionally overwrites it
 * back to `'idle'`. The blob renders with the `bobbit-blob--idle` class
 * (zzz visible) while the stop button is still showing.
 *
 * Repro mechanically:
 *   1. Mount <streaming-message-container isStreaming=true>; let entry
 *      animation (≤900 ms) complete → `_blobState === 'active'`.
 *   2. isStreaming = false → `_blobState === 'exiting'`, orphan timer
 *      scheduled to write 'idle' in 700–900 ms.
 *   3. Within 200 ms set isStreaming = true → `_blobState === 'active'`.
 *   4. Advance clock past the original exit window (e.g. +2 s).
 *   5. On master the orphan timer flips `_blobState` back to `'idle'`.
 *
 * Drives time deterministically with Playwright's `page.clock` so the
 * 700/900 ms Math.random variant doesn't matter — we just step past both.
 *
 * MUST fail on master (proves the bug). MUST pass after the fix.
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

test.describe("StreamingMessageContainer — blob never goes idle while streaming", () => {
	test("orphan exit-timer must not overwrite _blobState to 'idle' after streaming resumes", async ({ page }) => {
		// Install fake clock BEFORE navigation so the page sees the mocked
		// setTimeout/Date from the moment the module loads.
		await page.clock.install({ time: 0 });
		await page.goto(PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);

		// Step 1: mount with isStreaming = true.
		await page.evaluate(async () => {
			const host = document.getElementById("host")!;
			const el: any = document.createElement("streaming-message-container");
			el.isStreaming = true;
			host.appendChild(el);
			(window as any).__el = el;
			// Let Lit run the initial updated() so the entry-timer is scheduled.
			await el.updateComplete;
		});

		// Step 2: advance past the entry animation (max 900 ms variant).
		await page.clock.runFor(950);
		await page.evaluate(async () => {
			const el: any = (window as any).__el;
			await el.updateComplete;
		});
		const afterEntry = await page.evaluate(() => {
			const el: any = (window as any).__el;
			return { blobState: el._blobState };
		});
		expect(afterEntry.blobState, "entry animation should land on 'active'").toBe("active");

		// Step 3: flip isStreaming → false. Exit timer scheduled (700 or 900 ms).
		await page.evaluate(async () => {
			const el: any = (window as any).__el;
			el.isStreaming = false;
			await el.updateComplete;
		});
		const afterStop = await page.evaluate(() => {
			const el: any = (window as any).__el;
			return { blobState: el._blobState };
		});
		expect(afterStop.blobState, "stopping should put blob into 'exiting'").toBe("exiting");

		// Step 4: advance 200 ms (well inside both 700/900 ms exit variants).
		await page.clock.runFor(200);

		// Step 5: flip isStreaming → true again. Should snap back to 'active'.
		await page.evaluate(async () => {
			const el: any = (window as any).__el;
			el.isStreaming = true;
			await el.updateComplete;
		});
		const afterResume = await page.evaluate(() => {
			const el: any = (window as any).__el;
			return { blobState: el._blobState };
		});
		expect(afterResume.blobState, "resuming streaming should put blob back to 'active'").toBe("active");

		// Step 6: advance well past the original exit window (max 900 ms
		// from the stop, plus the 200 ms already elapsed → 700 ms remaining
		// at most; +2000 ms is a comfortable margin). The orphan timer
		// from step 3 fires somewhere in here and — on master — overwrites
		// `_blobState` back to 'idle'.
		await page.clock.runFor(2000);
		await page.evaluate(async () => {
			const el: any = (window as any).__el;
			await el.updateComplete;
		});

		const final = await page.evaluate(() => {
			const el: any = (window as any).__el;
			const blobDiv = el.querySelector(".bobbit-blob") as HTMLElement | null;
			return {
				blobState: el._blobState,
				isStreaming: el.isStreaming,
				className: blobDiv?.className ?? null,
				hasBlobDiv: blobDiv !== null,
			};
		});

		// The bug surface: streaming is still in progress but the blob has
		// been flipped back to idle by the orphan exit-timer.
		expect(final.isStreaming, "sanity: still streaming").toBe(true);
		expect(final.hasBlobDiv, "blob div should be rendered").toBe(true);

		// PRIMARY assertion — fails on master with the orphan timer bug.
		expect(
			final.blobState,
			"_blobState must not be 'idle' while isStreaming is true (orphan exit-timer regression)",
		).not.toBe("idle");
		expect(
			final.blobState,
			"_blobState should still be 'active' after resume",
		).toBe("active");

		// Class assertions — `bobbit-blob--idle` is what renders the zzz
		// sprite and desaturated state. It must not be present while streaming.
		expect(
			final.className,
			"rendered blob must not have 'bobbit-blob--idle' class while streaming",
		).not.toContain("bobbit-blob--idle");
		expect(
			final.className,
			"rendered blob should reflect an active/streaming state",
		).toContain("bobbit-blob");
	});
});
