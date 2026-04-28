/**
 * API E2E for GET /api/oauth/flow-status.
 *
 * Coverage required (Phase 2 — flesh out after Agent B merge):
 *  - Happy path: start an OAuth flow for `anthropic`, poll
 *    /api/oauth/flow-status?flowId=...&provider=anthropic — expect
 *    { complete: false|true, expiresAt: number }.
 *  - Cross-provider isolation: start an `anthropic` flow, poll its flowId
 *    with `provider=openai-codex` — expect 404 { error: "flow not found" }.
 *  - Missing/empty flowId → 400.
 *  - Unknown flowId → 404.
 *
 * Phase 1: scaffold; tests skipped until Agent B's `oauthFlowStatus` accepts
 * the optional `provider` arg and the route forwards `?provider`.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";

const headers = () => ({
	Authorization: `Bearer ${readE2EToken()}`,
	"Content-Type": "application/json",
});

async function api(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${base()}${path}`, { ...opts, headers: { ...headers(), ...(opts?.headers || {}) } });
}

test.describe("/api/oauth/flow-status", () => {
	test.skip("happy path: poll an in-flight anthropic flow", async () => {
		// TODO Phase 2: POST /api/oauth/start { provider: "anthropic" } →
		// extract flowId → GET /api/oauth/flow-status?flowId=...&provider=anthropic
		// → assert 200 + shape { complete, expiresAt }.
		const _ = api;
		expect(true).toBe(true);
	});

	test.skip("cross-provider isolation: anthropic flow polled as openai-codex → 404", async () => {
		// TODO Phase 2: start `anthropic` flow → poll with provider=openai-codex
		// → expect 404 { error: "flow not found" }.
		expect(true).toBe(true);
	});

	test.skip("unknown flowId → 404", async () => {
		// TODO Phase 2: GET with random flowId → 404.
		expect(true).toBe(true);
	});

	test.skip("missing flowId → 400", async () => {
		// TODO Phase 2: GET without flowId → 400.
		expect(true).toBe(true);
	});
});
