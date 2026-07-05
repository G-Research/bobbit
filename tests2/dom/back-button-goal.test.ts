import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/back-button-goal.spec.ts (v2-dom tier).
// The legacy file:// fixture REPRODUCED setHashRoute inline; per the migration
// guide this port imports the REAL setHashRoute (src/app/routing.ts). Pins that
// creating a goal navigates to the dashboard with replace:true so the browser
// Back button reaches the sessions list (#/), not the stale assistant session.
import { afterEach, describe, expect, it } from "vitest";
import { setHashRoute } from "../../src/app/routing.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
	// Reset the hash so a following test starts clean.
	history.replaceState({}, "", "#/");
});

describe("Back button after goal creation", () => {
	it("back button should reach sessions list, not stale assistant session", async () => {
		// sessions list → assistant session (push) → goal dashboard (replace:true, the fix)
		window.location.hash = "#/";
		await delay(50);
		setHashRoute("session", "assistant-123");
		await delay(50);
		setHashRoute("goal-dashboard", "goal-456", true);
		await delay(50);

		const hashAfterBack: string = await new Promise((resolve) => {
			window.addEventListener("hashchange", function onBack() {
				window.removeEventListener("hashchange", onBack);
				resolve(window.location.hash);
			});
			history.back();
		});

		// Without replace:true, back would land on #/session/assistant-123.
		expect(hashAfterBack).toBe("#/");
	});
});
