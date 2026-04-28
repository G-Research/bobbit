/**
 * API E2E for GET /api/oauth/flow-status.
 *
 * Coverage:
 *  - Missing flowId → 400.
 *  - Unknown flowId → 404 with `{ error: "flow not found" }`.
 *  - Cross-provider isolation: starting an `anthropic` flow and polling
 *    its flowId with `?provider=openai-codex` must 404 (defence-in-depth).
 *  - Happy path: an in-flight flow polled with no provider returns
 *    `{ complete: false, ... }`; with the matching provider also returns 200.
 *
 * Note: external OAuth providers (openai-codex) require live upstream
 * metadata in the in-process harness, which is brittle. We therefore drive
 * the flow-status logic directly via `oauthStart` / `oauthFlowStatus` in
 * `src/server/auth/oauth.ts`, exercising the real production code path
 * without going through the network/provider boundary. The HTTP-surface
 * 400/404 cases below still use the REST endpoint to lock the wire shape.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
// Import from dist/ so we share the same module instance (and therefore
// the same `pendingFlows` Map) as the in-process gateway, which also imports
// from dist/. Importing from src/ would yield a different module instance
// under tsx and the REST cross-checks would never see our flows.
import { oauthStart, oauthFlowStatus } from "../../dist/server/auth/oauth.js";

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

	test("happy path (direct): an in-flight anthropic flow returns { complete: false }", async () => {
		// `anthropic` flows are local: oauthStart only computes a PKCE pair and
		// builds an authorize URL. No upstream call is made. We can therefore
		// observe an in-flight flow deterministically.
		const started = await oauthStart("anthropic");
		expect(started.flowId).toBeTruthy();
		expect(started.provider).toBe("anthropic");

		// Poll directly — no provider arg.
		const statusNoProv = oauthFlowStatus(started.flowId);
		expect(statusNoProv).toEqual({ complete: false });

		// Poll with matching provider.
		const statusMatch = oauthFlowStatus(started.flowId, "anthropic");
		expect(statusMatch).toEqual({ complete: false });

		// And the REST surface confirms the same.
		const resp = await api(`/api/oauth/flow-status?flowId=${encodeURIComponent(started.flowId)}&provider=anthropic`);
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.complete).toBe(false);
	});

	test("cross-provider isolation (direct): anthropic flow polled as openai-codex → 404", async () => {
		const started = await oauthStart("anthropic");
		expect(started.flowId).toBeTruthy();

		// Direct call: cross-provider mismatch must read as 'flow not found'.
		const mismatch = oauthFlowStatus(started.flowId, "openai-codex");
		expect(mismatch).toEqual({ complete: false, error: "flow not found" });

		// Matching-provider sanity: still reachable (proves the 404 above is
		// only the provider-mismatch branch, not a cleanup side-effect of the
		// mismatched poll).
		const match = oauthFlowStatus(started.flowId, "anthropic");
		expect(match).toEqual({ complete: false });

		// REST surface mirrors the direct call.
		const resp = await api(`/api/oauth/flow-status?flowId=${encodeURIComponent(started.flowId)}&provider=openai-codex`);
		expect(resp.status).toBe(404);
		const body = await resp.json();
		expect(body.error).toBe("flow not found");
	});
});
