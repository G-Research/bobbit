import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, base, createSession, deleteSession, readE2EToken } from "./_e2e/e2e-setup.js";
import { API_CORS_ALLOWED_HEADERS, API_CORS_ALLOWED_METHODS, API_CORS_PREFLIGHT_MAX_AGE_SECONDS } from "../../src/server/cors.js";

const API_ROUTE_SOURCES = [
	readFileSync(fileURLToPath(new URL("../../src/server/server.ts", import.meta.url)), "utf8"),
	readFileSync(fileURLToPath(new URL("../../src/server/side-panel-workspace-routes.ts", import.meta.url)), "utf8"),
	readFileSync(fileURLToPath(new URL("../../src/server/agent/nested-goal-routes.ts", import.meta.url)), "utf8"),
	readFileSync(fileURLToPath(new URL("../../src/server/pr-walkthrough/routes.ts", import.meta.url)), "utf8"),
] as const;

function headerList(value: string | null): string[] {
	return (value ?? "").split(",").map(item => item.trim()).filter(Boolean);
}

function routedMethodLiterals(): string[] {
	const methods = new Set<string>();
	const predicate = /req\.method\s*(?:===|!==)\s*["']([A-Z]+)["']|["']([A-Z]+)["']\s*(?:===|!==)\s*req\.method/g;
	for (const source of API_ROUTE_SOURCES) {
		for (const match of source.matchAll(predicate)) methods.add(match[1] ?? match[2]);
	}
	return [...methods].sort();
}

test("CORS preflight advertises every routed API method and required request metadata", async () => {
	const origin = "http://127.0.0.1:5173";
	const res = await fetch(`${base()}/api/ext/route/run`, {
		method: "OPTIONS",
		headers: {
			Origin: origin,
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "authorization,content-type,x-bobbit-session-id,x-bobbit-session-secret",
		},
	});
	expect(res.status).toBe(204);
	expect(headerList(res.headers.get("access-control-allow-methods")).map(method => method.toUpperCase()))
		.toEqual([...API_CORS_ALLOWED_METHODS]);
	expect(routedMethodLiterals()).toEqual([...API_CORS_ALLOWED_METHODS].sort());
	expect(headerList(res.headers.get("access-control-allow-headers")).map(header => header.toLowerCase()).sort())
		.toEqual([...API_CORS_ALLOWED_HEADERS].map(header => header.toLowerCase()).sort());
	expect(Number(res.headers.get("access-control-max-age"))).toBe(API_CORS_PREFLIGHT_MAX_AGE_SECONDS);
	expect(API_CORS_PREFLIGHT_MAX_AGE_SECONDS).toBeGreaterThan(0);
	expect(API_CORS_PREFLIGHT_MAX_AGE_SECONDS).toBeLessThanOrEqual(86_400);
	expect(res.headers.get("access-control-allow-credentials")).toBeNull();

	// Preserve the existing wildcard/reflection decision and pair Vary only with reflection.
	const allowedOrigin = res.headers.get("access-control-allow-origin");
	if (allowedOrigin === "*") {
		expect(res.headers.get("vary")?.toLowerCase() ?? "").not.toContain("origin");
	} else {
		expect(allowedOrigin).toBe(origin);
		expect(res.headers.get("vary")?.toLowerCase()).toContain("origin");
	}
});

test("authenticated cross-origin side-panel workspace PATCH persists after its preflight", async () => {
	const sessionId = await createSession();
	try {
		const tabId = "proposal:goal";
		const tabPath = `/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent(tabId)}`;
		const opened = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
			method: "POST",
			body: JSON.stringify({
				tab: {
					id: tabId,
					kind: "proposal",
					title: "Goal Proposal",
					label: "Goal",
					source: { type: "proposal", sessionId, proposalType: "goal" },
					updatedAt: 1,
				},
			}),
		});
		expect(opened.status).toBe(200);
		const workspace = await opened.json();

		const origin = "https://remote-ui.example.test";
		const preflight = await fetch(`${base()}${tabPath}`, {
			method: "OPTIONS",
			headers: {
				Origin: origin,
				"Access-Control-Request-Method": "PATCH",
				"Access-Control-Request-Headers": "authorization,content-type,x-bobbit-session-id,x-bobbit-session-secret",
			},
		});
		expect(preflight.status).toBe(204);
		expect(headerList(preflight.headers.get("access-control-allow-methods")).map(method => method.toUpperCase())).toContain("PATCH");

		const patch = await fetch(`${base()}${tabPath}`, {
			method: "PATCH",
			headers: {
				Origin: origin,
				Authorization: `Bearer ${readE2EToken()}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				baseRevision: workspace.revision,
				patch: {
					title: "Persisted cross-origin update",
					state: { selectedSection: "details" },
				},
			}),
		});
		expect(patch.status).toBe(200);

		const refetched = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`);
		expect(refetched.status).toBe(200);
		const persisted = await refetched.json();
		expect(persisted.tabs.find((tab: any) => tab.id === tabId)).toMatchObject({
			title: "Persisted cross-origin update",
			state: { selectedSection: "details" },
		});
	} finally {
		await deleteSession(sessionId);
	}
});

test("POST /api/ext/surface-token denies caller-selected pack-bound identities", async () => {
	const sessionId = await createSession();
	try {
		const res = await apiFetch("/api/ext/surface-token", {
			method: "POST",
			headers: { "x-bobbit-session-id": sessionId },
			body: JSON.stringify({
				sessionId,
				packId: "terminal",
				contributionKind: "panel",
				contributionId: "terminal",
			}),
		});
		const body = await res.json().catch(() => ({}));
		expect(res.status).toBe(403);
		expect(body.error).toContain("trusted session WebSocket");
	} finally {
		await deleteSession(sessionId);
	}
});
