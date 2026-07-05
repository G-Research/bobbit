// Migrated from tests/config-page-toggle.spec.ts (v2-dom tier).
// The legacy fixture copied getRouteFromHash + activeSessionId verbatim. This port
// drives the REAL functions from src/app/routing.ts + src/app/state.ts, mutating the
// real `state` singleton (restored in afterEach) and the window hash.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRouteFromHash } from "../../src/app/routing.js";
import { state, activeSessionId } from "../../src/app/state.js";

// All config-page routes that should suppress session highlighting.
const CONFIG_ROUTES = [
	{ hash: "#/roles", view: "roles" },
	{ hash: "#/tools", view: "tools" },
	{ hash: "#/workflows", view: "workflows" },
	{ hash: "#/skills", view: "skills" },
	{ hash: "#/roles/coder", view: "role-edit" },
	{ hash: "#/tools/browser_click", view: "tool-edit" },
	{ hash: "#/workflows/bug-fix", view: "workflow-edit" },
];

let saved: { sel: string | null; conn: string | null; remote: unknown };

beforeEach(() => {
	saved = { sel: state.selectedSessionId, conn: state.connectingSessionId, remote: state.remoteAgent };
	// A connected/selected session so activeSessionId() returns it on non-config routes.
	state.selectedSessionId = "mock-session-123";
	state.connectingSessionId = "mock-session-123";
	state.remoteAgent = null;
});

afterEach(() => {
	state.selectedSessionId = saved.sel;
	state.connectingSessionId = saved.conn;
	state.remoteAgent = saved.remote as typeof state.remoteAgent;
	window.location.hash = "";
});

describe("Config page toggle buttons — activeSessionId suppression", () => {
	it("baseline: activeSessionId() returns undefined for #/settings", () => {
		window.location.hash = "#/settings";
		expect(activeSessionId()).toBeUndefined();
	});

	it("baseline: activeSessionId() returns session ID for #/session/abc route", () => {
		window.location.hash = "#/session/abc";
		expect(activeSessionId()).toBe("mock-session-123");
	});

	it("baseline: activeSessionId() returns session ID on landing page", () => {
		window.location.hash = "#/";
		expect(activeSessionId()).toBe("mock-session-123");
	});

	for (const route of CONFIG_ROUTES) {
		it(`activeSessionId should be undefined on config route ${route.hash}`, () => {
			window.location.hash = route.hash;
			expect(activeSessionId()).toBeUndefined();
		});
	}

	it("getRouteFromHash correctly identifies config page views", () => {
		for (const route of CONFIG_ROUTES) {
			window.location.hash = route.hash;
			expect(getRouteFromHash().view).toBe(route.view);
		}
	});
});
