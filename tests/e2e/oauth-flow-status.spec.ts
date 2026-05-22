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
 *  - Callback completion: an external OAuth provider can finish via its
 *    callback server, `/flow-status` enables the owning provider preference,
 *    and the REST response remains `{ complete: true }` (no provider/secret
 *    details on the wire).
 *  - Google OAuth unavailable path: start fails with 501 and status surfaces
 *    `oauthSupported:false` plus clear API-key fallback guidance.
 *
 * Note: external OAuth providers usually require live upstream metadata in the
 * in-process harness. For callback completion we register a temporary
 * `openai-codex` OAuth provider through pi-ai's public registry, exercising
 * Bobbit's real `oauthStart`/`oauthFlowStatus`/REST code without network I/O.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider, type OAuthProviderInterface } from "@earendil-works/pi-ai/oauth";
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, bobbitDir } from "./e2e-setup.js";
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

const TEST_AGENT_DIR = () => join(bobbitDir(), "agent-oauth-flow-status");
const OAUTH_ACCESS_SECRET = "test-openai-callback-access-secret";
const OAUTH_REFRESH_SECRET = "test-openai-callback-refresh-secret";
const CLOUD_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;
const originalAgentDir = process.env.BOBBIT_AGENT_DIR;
const originalCloudEnv = new Map<string, string | undefined>(CLOUD_ENV_KEYS.map((key) => [key, process.env[key]]));
let finishCallbackLogin: (() => void) | undefined;

function resetIsolatedAgentDir(authData: Record<string, unknown> = {}): void {
	const dir = TEST_AGENT_DIR();
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(authData, null, 2));
	process.env.BOBBIT_AGENT_DIR = dir;
	for (const key of CLOUD_ENV_KEYS) delete process.env[key];
}

async function setCloudProviderEnabled(provider: "anthropic" | "openai" | "google", enabled: boolean): Promise<void> {
	const resp = await api(`/api/cloud-providers/${provider}`, {
		method: "PUT",
		body: JSON.stringify({ enabled }),
	});
	expect(resp.ok).toBe(true);
}

function registerCallbackOpenAIProvider(): void {
	let resolveLogin!: () => void;
	const callbackApproved = new Promise<void>((resolve) => { resolveLogin = resolve; });
	finishCallbackLogin = resolveLogin;
	const provider: OAuthProviderInterface = {
		id: "openai-codex",
		name: "OpenAI Codex Test Provider",
		usesCallbackServer: true,
		async login(callbacks) {
			callbacks.onAuth({ url: "https://auth.example.test/openai", instructions: "Test callback provider" });
			await callbackApproved;
			return {
				access: OAUTH_ACCESS_SECRET,
				refresh: OAUTH_REFRESH_SECRET,
				expires: Date.now() + 60_000,
			};
		},
		async refreshToken(credentials) { return credentials; },
		getApiKey(credentials) { return String(credentials.access); },
	};
	registerOAuthProvider(provider);
}

async function nextFlowStatus(flowId: string, provider: string): Promise<{ status: number; body: any }> {
	const resp = await api(`/api/oauth/flow-status?flowId=${encodeURIComponent(flowId)}&provider=${encodeURIComponent(provider)}`);
	return { status: resp.status, body: await resp.json() };
}

test.describe("/api/oauth/flow-status", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeEach(() => {
		resetIsolatedAgentDir();
		finishCallbackLogin = undefined;
	});

	test.afterEach(async () => {
		finishCallbackLogin?.();
		await Promise.resolve();
		finishCallbackLogin = undefined;
		unregisterOAuthProvider("openai-codex");
		resetIsolatedAgentDir();
		await setCloudProviderEnabled("anthropic", false);
		await setCloudProviderEnabled("openai", false);
		await setCloudProviderEnabled("google", false);
	});

	test.afterAll(() => {
		if (originalAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = originalAgentDir;
		for (const key of CLOUD_ENV_KEYS) {
			const value = originalCloudEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

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

	test("callback completion enables provider preference without exposing provider on flow-status wire", async () => {
		await setCloudProviderEnabled("openai", false);
		registerCallbackOpenAIProvider();

		const startResp = await api("/api/oauth/start", {
			method: "POST",
			body: JSON.stringify({ provider: "openai-codex" }),
		});
		expect(startResp.status).toBe(200);
		const started = await startResp.json();
		expect(started.provider).toBe("openai-codex");
		expect(started.callbackServer).toBe(true);
		expect(started.flowId).toBeTruthy();

		const inFlight = await nextFlowStatus(started.flowId, "openai-codex");
		expect(inFlight).toEqual({ status: 200, body: { complete: false } });

		finishCallbackLogin?.();
		await expect.poll(
			async () => nextFlowStatus(started.flowId, "openai-codex"),
			{ timeout: 5_000, intervals: [50, 100, 250] },
		).toEqual({ status: 200, body: { complete: true } });

		const prefsResp = await api("/api/preferences");
		expect(prefsResp.status).toBe(200);
		const prefs = await prefsResp.json();
		expect(prefs["providerEnabled.openai"]).toBe(true);

		const statusResp = await api("/api/cloud-providers/status");
		expect(statusResp.status).toBe(200);
		const publicStatusText = JSON.stringify(await statusResp.json());
		expect(publicStatusText).not.toContain(OAUTH_ACCESS_SECRET);
		expect(publicStatusText).not.toContain(OAUTH_REFRESH_SECRET);
	});

	test("google OAuth start and status report unavailable with API-key fallback guidance", async () => {
		resetIsolatedAgentDir({
			google: {
				type: "oauth",
				access: "test-google-oauth-access-secret",
				refresh: "test-google-oauth-refresh-secret",
				expires: Date.now() + 60_000,
			},
		});
		await setCloudProviderEnabled("google", true);

		const startResp = await api("/api/oauth/start", {
			method: "POST",
			body: JSON.stringify({ provider: "google" }),
		});
		expect(startResp.status).toBe(501);
		const startBody = await startResp.json();
		expect(startBody.error).toContain("Google sign-in is not available");
		expect(startBody.error).toContain("Gemini API key");

		const oauthStatusResp = await api("/api/oauth/status?provider=google");
		expect(oauthStatusResp.status).toBe(200);
		const oauthStatus = await oauthStatusResp.json();
		expect(oauthStatus.provider).toBe("google");
		expect(oauthStatus.authenticated).toBe(false);
		expect(oauthStatus.configured).toBe(true);
		expect(oauthStatus.oauthSupported).toBe(false);
		expect(oauthStatus.message).toContain("Gemini API key");

		const cloudStatusResp = await api("/api/cloud-providers/status");
		expect(cloudStatusResp.status).toBe(200);
		const cloudStatus = await cloudStatusResp.json();
		const google = cloudStatus.providers.find((p: any) => p.id === "google");
		expect(google).toMatchObject({
			enabled: true,
			configured: true,
			authenticated: false,
			status: "oauth_unavailable",
			oauthSupported: false,
		});
		expect(google.message).toContain("Gemini API key");
		const publicText = JSON.stringify({ startBody, oauthStatus, cloudStatus });
		expect(publicText).not.toContain("test-google-oauth-access-secret");
		expect(publicText).not.toContain("test-google-oauth-refresh-secret");
	});
});
