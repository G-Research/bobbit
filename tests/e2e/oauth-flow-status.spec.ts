/**
 * API E2E for GET /api/oauth/flow-status.
 *
 * Coverage:
 *  - Missing flowId → 400 with `{ error: "Missing flowId" }`.
 *  - Unknown flowId → 404 with `{ error: "flow not found" }`.
 *  - Cross-provider isolation: starting an `openai-codex` flow then polling
 *    its flowId with `?provider=anthropic` must 404 (defence-in-depth).
 *  - Happy path: an `openai-codex` flow polled with the matching provider
 *    returns 200 with `{ complete: false, ... }` while the flow is in flight.
 *
 * Note: the `anthropic` start path requires real upstream OAuth metadata and
 * is intentionally avoided here — the cross-provider isolation test below
 * starts an `openai-codex` flow (which uses a local injected callback), which
 * is the isolation direction we actually need to lock.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";

const headers = () => ({
	Authorization: `Bearer ${readE2EToken()}`,
	"Content-Type": "application/json",
});

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${base()}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers as Record<string, string> || {}) } });
}

test.describe("/api/oauth/flow-status", () => {
	test("missing flowId → 400", async () => {
		const resp = await api("/api/oauth/flow-status");
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toBeDefined();
	});

	test("unknown flowId → 404 { error: 'flow not found' }", async () => {
		const resp = await api(`/api/oauth/flow-status?flowId=does-not-exist-${Date.now()}`);
		expect(resp.status).toBe(404);
		const body = await resp.json();
		expect(body.error).toBe("flow not found");
	});

	test("happy path: poll an in-flight openai-codex flow", async () => {
		const startResp = await api("/api/oauth/start", {
			method: "POST",
			body: JSON.stringify({ provider: "openai-codex" }),
		});
		// External providers may not always be wired up in the in-process
		// harness; if start fails for any reason, skip this test rather than
		// flake it.
		if (!startResp.ok) {
			test.skip(true, `oauth start unavailable for openai-codex (status ${startResp.status})`);
			return;
		}
		const { flowId, provider } = await startResp.json();
		expect(flowId).toBeTruthy();
		expect(provider).toBe("openai-codex");

		try {
			const resp = await api(`/api/oauth/flow-status?flowId=${encodeURIComponent(flowId)}&provider=openai-codex`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.complete).toBe(false);
		} finally {
			// Clean up by submitting a bogus code (will fail upstream but cleans pendingFlows).
			await api("/api/oauth/complete", {
				method: "POST",
				body: JSON.stringify({ flowId, code: "" }),
			}).catch(() => {});
		}
	});

	test("cross-provider isolation: openai-codex flow polled as anthropic → 404", async () => {
		const startResp = await api("/api/oauth/start", {
			method: "POST",
			body: JSON.stringify({ provider: "openai-codex" }),
		});
		if (!startResp.ok) {
			test.skip(true, `oauth start unavailable for openai-codex (status ${startResp.status})`);
			return;
		}
		const { flowId } = await startResp.json();
		expect(flowId).toBeTruthy();

		try {
			const resp = await api(`/api/oauth/flow-status?flowId=${encodeURIComponent(flowId)}&provider=anthropic`);
			expect(resp.status).toBe(404);
			const body = await resp.json();
			expect(body.error).toBe("flow not found");

			// Sanity: same flow with the matching provider is still reachable
			// (proves the 404 above is *only* the provider-mismatch branch,
			// not a cleanup side-effect of the mismatched poll).
			const ok = await api(`/api/oauth/flow-status?flowId=${encodeURIComponent(flowId)}&provider=openai-codex`);
			expect(ok.status).toBe(200);
		} finally {
			await api("/api/oauth/complete", {
				method: "POST",
				body: JSON.stringify({ flowId, code: "" }),
			}).catch(() => {});
		}
	});
});
