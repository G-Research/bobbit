import assert from "node:assert/strict";
import { test } from "node:test";
import { getRouteFromHash } from "../src/app/routing.ts";

type FakeLocation = {
	pathname: string;
	search?: string;
	hash?: string;
};

function routeWithLocation(location: FakeLocation): ReturnType<typeof getRouteFromHash> {
	const originalWindow = (globalThis as any).window;
	(globalThis as any).window = {
		location: {
			pathname: location.pathname,
			search: location.search ?? "",
			hash: location.hash ?? "",
		},
	};
	try {
		return getRouteFromHash();
	} finally {
		if (originalWindow === undefined) {
			delete (globalThis as any).window;
		} else {
			(globalThis as any).window = originalWindow;
		}
	}
}

test("hash session route still parses as a session route", () => {
	const sessionId = "session_hash-123";
	const route = routeWithLocation({ pathname: "/", hash: `#/session/${sessionId}` });
	assert.deepEqual(
		route,
		{ view: "session", sessionId },
		`ROUTE_MISMATCH: #/session/${sessionId} should parse as a session route, got ${JSON.stringify(route)}`,
	);
});

test("path session deep link parses as the same session route as the hash form", () => {
	const sessionId = "session_path-123";
	const route = routeWithLocation({ pathname: `/session/${sessionId}` });
	assert.deepEqual(
		route,
		{ view: "session", sessionId },
		`ROUTE_MISMATCH: /session/${sessionId} should parse as a session route instead of landing, got ${JSON.stringify(route)}`,
	);
});

test("path session deep link with auth token query still parses as a session route", () => {
	const sessionId = "session_token-123";
	const route = routeWithLocation({ pathname: `/session/${sessionId}`, search: "?token=e2e-token" });
	assert.deepEqual(
		route,
		{ view: "session", sessionId },
		`ROUTE_MISMATCH: /session/${sessionId}?token=... should parse as a session route without consuming auth query, got ${JSON.stringify(route)}`,
	);
});

test("hash session route wins over path session fallback", () => {
	const route = routeWithLocation({ pathname: "/session/old", hash: "#/session/new" });
	assert.deepEqual(
		route,
		{ view: "session", sessionId: "new" },
		`ROUTE_MISMATCH: /session/old#/session/new should parse the hash session route, got ${JSON.stringify(route)}`,
	);
});

test("hash settings route wins over path session fallback", () => {
	const route = routeWithLocation({ pathname: "/session/old", hash: "#/settings" });
	assert.deepEqual(
		route,
		{ view: "settings" },
		`ROUTE_MISMATCH: /session/old#/settings should parse the hash settings route, got ${JSON.stringify(route)}`,
	);
});

test("deprecated /walkthrough pathname no longer resolves to a dedicated route", () => {
	// The built-in walkthrough viewer was deleted; the first-party pack serves it
	// via the generic `#/ext/pr-walkthrough` deep-link instead. The legacy pathname
	// falls through to the landing view.
	const route = routeWithLocation({ pathname: "/walkthrough", search: "?session=abc&tab=review" });
	assert.deepEqual(route, { view: "landing" });
});
