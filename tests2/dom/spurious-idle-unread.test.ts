import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/spurious-idle-unread.spec.ts (v2-dom tier).
// The legacy file:// fixture bundled the REAL updateLocalSessionStatus, state, and
// hasUnseenActivity. This port imports those same real symbols directly and
// re-implements the thin __seedSession helper inline, asserting the identical
// heartbeat-must-not-clobber-lastActivity behaviour.
//
// updateLocalSessionStatus() calls renderApp() (a no-op here since render.ts is
// not imported) which schedules a RAF; we still stub fetch defensively — including
// the /side-panel-workspace branch — so no fire-and-forget workspace hydration can
// reject after the test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateLocalSessionStatus } from "../../src/app/api.js";
import { state, type GatewaySession } from "../../src/app/state.js";
import { hasUnseenActivity } from "../../src/app/render-helpers.js";

function seedSession(id: string, lastActivity: number, lastReadAt?: number): void {
	const sess: GatewaySession = {
		id,
		title: "test session",
		cwd: "/tmp",
		status: "idle",
		createdAt: lastActivity,
		lastActivity,
		lastReadAt,
		clientCount: 1,
	} as GatewaySession;
	state.gatewaySessions.length = 0;
	state.gatewaySessions.push(sess);
}

beforeEach(() => {
	state.gatewaySessions.length = 0;
	state.archivedSessions.length = 0;
	state.goals.length = 0;
	state.selectedSessionId = null as any;
	vi.stubGlobal("fetch", async (url: any) => {
		if (String(url).includes("/side-panel-workspace")) {
			return new Response(JSON.stringify({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	state.gatewaySessions.length = 0;
});

describe("updateLocalSessionStatus — heartbeat must not clobber lastActivity", () => {
	it("lastActivity is preserved across a status_heartbeat-driven call", () => {
		const T0 = Date.now() - 600_000; // 10 minutes ago — server-recorded last activity
		const lastReadAt = T0 + 1_000; // user has read past the last activity
		seedSession("s1", T0, lastReadAt);

		const stateBefore = state.gatewaySessions[0]!;
		const unseenBefore = hasUnseenActivity(stateBefore);

		// Simulate a session_status heartbeat (status unchanged, no new activity).
		updateLocalSessionStatus("s1", "idle");

		const stateAfter = state.gatewaySessions[0]!;
		const unseenAfter = hasUnseenActivity(stateAfter);

		// Sanity: precondition holds — no unread before the heartbeat.
		expect(unseenBefore).toBe(false);
		expect(stateBefore.lastActivity).toBe(T0);

		// CORE ASSERTION: lastActivity must NOT be clobbered by the status frame.
		expect(
			stateAfter.lastActivity,
			`updateLocalSessionStatus must not mutate lastActivity. Expected T0=${T0}, got ${stateAfter.lastActivity}.`,
		).toBe(T0);

		// Secondary: with lastActivity preserved, the sidebar must not spuriously
		// light up the unread dot.
		expect(unseenAfter, "hasUnseenActivity() must remain false after a heartbeat").toBe(false);

		// The status is still set correctly (the one field the function MAY mutate).
		expect(stateAfter.status).toBe("idle");
	});
});
