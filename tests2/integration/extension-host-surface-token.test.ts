import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, base, createSession, deleteSession } from "./_e2e/e2e-setup.js";

test("CORS preflight allows scoped Host API session headers", async () => {
	const res = await fetch(`${base()}/api/ext/route/run`, {
		method: "OPTIONS",
		headers: {
			Origin: "http://127.0.0.1:5173",
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "authorization,content-type,x-bobbit-session-id",
		},
	});
	expect(res.status).toBe(204);
	const allowed = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
	expect(allowed).toContain("authorization");
	expect(allowed).toContain("content-type");
	expect(allowed).toContain("x-bobbit-session-id");
	if (res.headers.get("access-control-allow-origin") !== "*") {
		expect(res.headers.get("vary")?.toLowerCase()).toContain("origin");
	}
});

test("CORS preflight authorizes PATCH for a cross-origin side-panel workspace tab update", async () => {
	const sessionId = await createSession();
	try {
		const tabId = "proposal:goal";
		const res = await fetch(`${base()}/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent(tabId)}`, {
			method: "OPTIONS",
			headers: {
				Origin: "https://remote-ui.example.test",
				"Access-Control-Request-Method": "PATCH",
				"Access-Control-Request-Headers": "authorization,content-type,x-bobbit-session-id",
			},
		});
		expect(res.status).toBe(204);
		const methods = (res.headers.get("access-control-allow-methods") ?? "")
			.split(",")
			.map(method => method.trim().toUpperCase());
		if (!methods.includes("PATCH")) {
			throw new Error("PATCH preflight regression: Access-Control-Allow-Methods must include PATCH for side-panel workspace tab updates");
		}
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
