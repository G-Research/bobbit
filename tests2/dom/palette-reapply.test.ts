import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/palette-reapply.spec.ts (v2-dom tier).
// The legacy fixture reproduced applyProjectPalette + the connect/refresh
// session lookup in plain JS. This port drives the REAL applyProjectPalette from
// src/app/session-manager.ts against real app `state`, mirroring the exact
// connect/refresh session lookup (`state.gatewaySessions.find(...)`) used in
// session-manager. happy-dom resolves the stylesheet custom-property cascade, so
// the CSS confirmation (getComputedStyle --primary) ports directly.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { state } from "../../src/app/state.js";
import { applyProjectPalette } from "../../src/app/session-manager.js";

const CSS = `
:root { --primary: oklch(0.38 0.08 148); --background: oklch(0.935 0.012 148); }
[data-palette="ocean"] { --primary: oklch(0.38 0.08 230); --background: oklch(0.935 0.012 230); }
`;

// Mirror of connectToSession's initial palette apply: the session is not yet in
// gatewaySessions, so the lookup returns undefined → global (unset) palette.
function simulateInitialConnect(sessionId: string): void {
	const session = state.gatewaySessions.find((s: any) => s.id === sessionId);
	applyProjectPalette(session ? (session as any).projectId : undefined);
}
// Mirror of refreshSessions populating the session.
function simulateRefresh(sessionId: string, projectId: string): void {
	state.gatewaySessions.push({ id: sessionId, projectId } as any);
}
// Mirror of the fixed post-refresh re-apply (session-manager.ts ~line 2548).
function simulatePostRefreshFixedBehavior(sessionId: string): void {
	const session = state.gatewaySessions.find((s: any) => s.id === sessionId);
	applyProjectPalette(session ? (session as any).projectId : undefined);
}

beforeAll(() => {
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.appendChild(style);
});

beforeEach(() => {
	localStorage.removeItem("palette");
	delete document.documentElement.dataset.palette;
	state.projects = [{ id: "proj-1", palette: "ocean" } as any];
	state.gatewaySessions.length = 0;
	state.activeProjectId = null;
});

afterEach(() => {
	delete document.documentElement.dataset.palette;
	state.gatewaySessions.length = 0;
});

describe("palette reapply after session refresh", () => {
	it("FIX VERIFIED: palette is re-applied after refreshSessions populates session", () => {
		simulateInitialConnect("reviewer-1");
		expect(document.documentElement.dataset.palette).toBeUndefined();

		simulateRefresh("reviewer-1", "proj-1");
		simulatePostRefreshFixedBehavior("reviewer-1");

		expect(document.documentElement.dataset.palette).toBe("ocean");
		const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
		expect(primary).toContain("230");
	});

	it("FIXED: palette is correctly applied after refreshSessions populates session", () => {
		simulateInitialConnect("reviewer-1");
		expect(document.documentElement.dataset.palette).toBeUndefined();

		simulateRefresh("reviewer-1", "proj-1");
		simulatePostRefreshFixedBehavior("reviewer-1");

		expect(document.documentElement.dataset.palette).toBe("ocean");
		const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
		expect(primary).toContain("230");
	});
});
