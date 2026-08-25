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
import type { AuthInteraction, Credential, Models } from "@earendil-works/pi-ai";
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { readE2EToken, base } from "./_helpers/e2e/e2e-setup.js";
import { loadServerTestRuntime } from "../../support/harnesses/server-runtime.js";

let oauthStart: typeof import("../../../src/server/auth/oauth.js").oauthStart;
let oauthCancel: typeof import("../../../src/server/auth/oauth.js").oauthCancel;
let oauthFlowStatus: typeof import("../../../src/server/auth/oauth.js").oauthFlowStatus;
const activeFlowIds = new Set<string>();

/**
 * Flow-status only needs Pi's in-flight interaction. A test double avoids
 * claiming Pi's fixed loopback callback port while still exercising the
 * production lease, provider isolation, and cancellation lifecycle.
 */
function pendingAnthropicModels(): Pick<Models, "login"> {
	return {
		login: ((provider: string, type: string, interaction: AuthInteraction) => {
			if (provider !== "anthropic" || type !== "oauth") throw new Error("unexpected OAuth login");
			interaction.notify({
				type: "auth_url",
				url: "https://claude.ai/oauth/authorize?state=test",
				instructions: "Complete the mocked OAuth flow",
			});
			return new Promise<Credential>((_resolve, reject) => {
				const signal = interaction.signal;
				if (!signal) {
					reject(new Error("OAuth interaction did not provide an abort signal"));
					return;
				}
				signal.addEventListener("abort", () => {
					reject(signal.reason instanceof Error ? signal.reason : new Error("OAuth flow cancelled"));
				}, { once: true });
			});
		}) as Models["login"],
	};
}

async function startPendingAnthropicFlow(): ReturnType<typeof oauthStart> {
	const started = await oauthStart("anthropic", undefined, pendingAnthropicModels());
	activeFlowIds.add(started.flowId);
	return started;
}

test.beforeAll(async () => {
	({ oauthStart, oauthCancel, oauthFlowStatus } = (await loadServerTestRuntime()).oauth);
});

test.afterEach(async () => {
	for (const flowId of activeFlowIds) oauthCancel(flowId, "anthropic");
	activeFlowIds.clear();
	// oauthCancel is intentionally synchronous for the REST endpoint. Let the
	// aborted Pi login settle and release its single-flow lease before the next
	// test attempts another Anthropic login.
	for (let i = 0; i < 20; i += 1) await Promise.resolve();
});

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
		const started = await startPendingAnthropicFlow();
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
		const started = await startPendingAnthropicFlow();
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
