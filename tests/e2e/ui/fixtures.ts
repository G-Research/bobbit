/**
 * Tier 2.5 Playwright fixture — opt-in beat-capture + cursor overlay on top
 * of the standard browser-E2E gateway harness.
 *
 * Tests opt in by changing the import line **only**:
 *
 *   // before
 *   import { test, expect } from "../gateway-harness.js";
 *   // after
 *   import { test, expect } from "./fixtures.js";
 *
 * The test signature gains a `rec: BeatRecorder` parameter; sprinkle
 * `await rec.capture("label")` calls at user-visible UX moments. Run with
 * `TIER25=1` to actually capture screenshots and produce a video report;
 * without the env var, every recorder method is a no-op and the cursor
 * overlay is not injected. Behaviour matches the bare gateway-harness
 * import in that case.
 *
 * See `docs/testing-tier-2-5.md` for the full opt-in guide.
 */
import { test as baseTest } from "../gateway-harness.js";
import { BeatRecorder } from "./beat-recorder.js";
import { CURSOR_OVERLAY_SCRIPT } from "./cursor-overlay.js";

export const test = baseTest.extend<{ rec: BeatRecorder }>({
	rec: async ({ page }, use, testInfo) => {
		if (process.env.TIER25 === "1") {
			// addInitScript re-runs on every navigation — this is what we want
			// so the red cursor dot survives hash-route changes too.
			await page.addInitScript(CURSOR_OVERLAY_SCRIPT);
		}
		const rec = new BeatRecorder(page, testInfo);
		await use(rec);
		await rec.flush();
	},
});

export { expect } from "@playwright/test";
