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
