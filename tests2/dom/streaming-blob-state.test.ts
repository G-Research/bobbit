import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/streaming-blob-state.spec.ts (v2-dom tier).
// Renders the REAL <streaming-message-container> lit component under happy-dom
// (was an esbuild file:// bundle driven by Playwright's page.clock). Time is
// driven deterministically with vitest fake timers so the 700/900ms Math.random
// exit/entry variants don't matter — we just step past both windows.
//
// Pins the orphan exit-timer regression: when isStreaming flips false→true
// inside the exit-animation window, the blob must snap back to 'active' and the
// stale exit timer must NOT later overwrite _blobState back to 'idle'.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/ui/components/StreamingMessageContainer.js";

// happy-dom's <canvas>.getContext("2d") returns null and lacks getAnimations, so
// the blob's decorative pixel-eye animation (src/ui/bobbit-render.ts) would throw
// while rendering the REAL blob. Stub a no-op 2d context + getAnimations so the
// component mounts; the assertions here are purely about the blob STATE MACHINE
// (_blobState + CSS class), not the canvas pixels.
beforeEach(() => {
	vi.useFakeTimers();
	const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true });
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctxStub as any);
	if (!(Element.prototype as any).getAnimations) {
		(Element.prototype as any).getAnimations = () => [];
	}
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("StreamingMessageContainer — blob never goes idle while streaming", () => {
	it("orphan exit-timer must not overwrite _blobState to 'idle' after streaming resumes", async () => {
		// Step 1: mount with isStreaming = true → entry animation scheduled.
		const el: any = document.createElement("streaming-message-container");
		el.isStreaming = true;
		document.body.appendChild(el);
		await el.updateComplete;

		// Step 2: advance past the entry animation (max 900ms variant) → 'active'.
		vi.advanceTimersByTime(950);
		await el.updateComplete;
		expect(el._blobState, "entry animation should land on 'active'").toBe("active");

		// Step 3: flip isStreaming → false. Exit timer scheduled (700 or 900ms).
		el.isStreaming = false;
		await el.updateComplete;
		expect(el._blobState, "stopping should put blob into 'exiting'").toBe("exiting");

		// Step 4: advance 200ms (well inside both 700/900ms exit variants).
		vi.advanceTimersByTime(200);

		// Step 5: flip isStreaming → true again. Should snap back to 'active'.
		el.isStreaming = true;
		await el.updateComplete;
		expect(el._blobState, "resuming streaming should put blob back to 'active'").toBe("active");

		// Step 6: advance well past the original exit window. On master the orphan
		// timer from step 3 fires here and overwrites _blobState back to 'idle'.
		vi.advanceTimersByTime(2000);
		await el.updateComplete;

		const blobDiv = el.querySelector(".bobbit-blob") as HTMLElement | null;

		expect(el.isStreaming, "sanity: still streaming").toBe(true);
		expect(blobDiv !== null, "blob div should be rendered").toBe(true);

		// PRIMARY assertion — fails on master with the orphan timer bug.
		expect(el._blobState, "_blobState must not be 'idle' while isStreaming is true").not.toBe("idle");
		expect(el._blobState, "_blobState should still be 'active' after resume").toBe("active");

		// Class assertions — `bobbit-blob--idle` renders the zzz/desaturated state.
		expect(blobDiv?.className ?? "", "must not have 'bobbit-blob--idle' while streaming").not.toContain("bobbit-blob--idle");
		expect(blobDiv?.className ?? "", "should reflect an active/streaming state").toContain("bobbit-blob");
	});
});
