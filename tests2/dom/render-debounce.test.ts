import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/render-debounce.spec.ts (v2-dom tier).
//
// The legacy fixture was a plain-JS REPLICA of a requestAnimationFrame debounce
// (it invented a `renderAppSync()` that does not exist in the real source). This
// port drives the REAL `renderApp` / `setRenderApp` from src/app/state.ts and
// covers the genuine coalescing behavior. The two legacy tests exercising the
// fictional `renderAppSync()` are intentionally not carried over — there is no
// such function in src (`rg renderAppSync src/` → no matches), so porting them
// would require copying the fixture's mock logic (forbidden). See report note.
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp, setRenderApp } from "../../src/app/state.js";

let renderCount = 0;

/** Wait for the scheduled rAF (and one extra frame) to fire, mirroring the
 *  legacy fixture's `requestAnimationFrame(() => requestAnimationFrame(resolve))`. */
function nextFrames(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

beforeEach(() => {
	renderCount = 0;
	setRenderApp(() => { renderCount++; });
});

describe("renderApp debounce", () => {
	it("multiple renderApp() calls in one frame produce a single render", async () => {
		renderApp();
		renderApp();
		renderApp();
		renderApp();
		renderApp();
		await nextFrames();
		expect(renderCount).toBe(1);
	});

	it("renderApp() after rAF fires triggers a new render", async () => {
		renderApp();
		await nextFrames();
		// First rAF cycle done, count should be 1.
		expect(renderCount).toBe(1);
		renderApp();
		await nextFrames();
		expect(renderCount).toBe(2);
	});
});
