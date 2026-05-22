import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, createSession, nonGitCwd } from "./e2e-setup.js";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLOUD_PROVIDERS = ["anthropic", "openai", "google"] as const;
const PROVIDER_KEY_ALIASES = ["anthropic", "openai", "openai-codex", "google", "google-gemini-cli"] as const;
const TARGET_MODEL_PROVIDERS = new Set(["anthropic", "openai", "openai-codex", "google", "google-gemini-cli"]);
const ENV_KEYS = [
	"BOBBIT_AGENT_DIR",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"AWS_ACCESS_KEY_ID",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"XAI_API_KEY",
];

type CloudProviderId = typeof CLOUD_PROVIDERS[number];
type CloudStatus = {
	mode: "aigw" | "direct-cloud";
	aigwConfigured: boolean;
	authGateRequired: boolean;
	providers: Array<{
		id: CloudProviderId;
		enabled: boolean;
		configured: boolean;
		authenticated: boolean;
		expired: boolean;
		needsReauth: boolean;
		status: string;
		credentialTypes: string[];
	}>;
};

let agentDir: string | undefined;
const originalEnv = new Map<string, string | undefined>();

test.describe.configure({ mode: "serial" });

test.describe("provider opt-in API and model filtering", () => {
	test.beforeAll(() => {
		for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
	});

	test.beforeEach(async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		agentDir = mkdtempSync(path.join(tmpdir(), "bobbit-provider-opt-in-agent-"));
		process.env.BOBBIT_AGENT_DIR = agentDir;
		await resetProviderState();
	});

	test.afterEach(async () => {
		await resetProviderState();
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
		for (const key of ENV_KEYS) {
			const value = originalEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test("cloud provider status is redacted and reports disabled, enabled, and authenticated states", async () => {
		const oauthAccessSecret = "anthropic-access-secret-provider-opt-in";
		const oauthRefreshSecret = "anthropic-refresh-secret-provider-opt-in";
		const openAiKeySecret = "sk-provider-opt-in-openai-secret";
		writeAuthJson({
			anthropic: {
				type: "oauth",
				access: oauthAccessSecret,
				refresh: oauthRefreshSecret,
				expires: Date.now() + 60 * 60 * 1000,
			},
		});

		await setCloudProviderEnabled("anthropic", false);
		await setCloudProviderEnabled("google", true);
		await saveProviderKey("openai", openAiKeySecret);

		const status = await getCloudStatus();
		expect(status.mode).toBe("direct-cloud");
		expect(status.authGateRequired).toBe(false);

		const anthropic = providerStatus(status, "anthropic");
		expect(anthropic.enabled).toBe(false);
		expect(anthropic.configured).toBe(true);
		expect(anthropic.authenticated).toBe(false);
		expect(anthropic.needsReauth).toBe(false);
		expect(anthropic.status).toBe("disabled");
		expect(anthropic.credentialTypes).toContain("oauth");

		const google = providerStatus(status, "google");
		expect(google.enabled).toBe(true);
		expect(google.configured).toBe(false);
		expect(google.authenticated).toBe(false);
		expect(google.needsReauth).toBe(false);
		expect(google.status).toBe("enabled_without_credential");

		const openai = providerStatus(status, "openai");
		expect(openai.enabled).toBe(true);
		expect(openai.configured).toBe(true);
		expect(openai.authenticated).toBe(true);
		expect(openai.needsReauth).toBe(false);
		expect(openai.status).toBe("authenticated");
		expect(openai.credentialTypes).toContain("api_key");

		await expectPublicResponsesDoNotLeak([oauthAccessSecret, oauthRefreshSecret, openAiKeySecret]);
	});

	test("PUT cloud provider enablement persists and provider-key deletion leaves enablement unchanged", async () => {
		await setCloudProviderEnabled("google", true);
		let prefs = await getPreferences();
		expect(prefs["providerEnabled.google"]).toBe(true);
		expect(providerStatus(await getCloudStatus(), "google").status).toBe("enabled_without_credential");

		await setCloudProviderEnabled("google", false);
		prefs = await getPreferences();
		expect(prefs["providerEnabled.google"]).toBe(false);
		expect(providerStatus(await getCloudStatus(), "google").status).toBe("disabled");

		const disabledKeySecret = "google-disabled-key-provider-opt-in";
		await saveProviderKey("google", disabledKeySecret, { enable: false });
		let google = providerStatus(await getCloudStatus(), "google");
		expect(google.enabled).toBe(false);
		expect(google.configured).toBe(true);
		expect(google.authenticated).toBe(false);
		expect(google.status).toBe("disabled");

		const enabledKeySecret = "google-enabled-key-provider-opt-in";
		await saveProviderKey("google", enabledKeySecret);
		google = providerStatus(await getCloudStatus(), "google");
		expect(google.enabled).toBe(true);
		expect(google.configured).toBe(true);
		expect(google.authenticated).toBe(true);
		expect(google.status).toBe("authenticated");

		const del = await apiFetch("/api/provider-keys/google", { method: "DELETE" });
		expect(del.status).toBe(200);
		google = providerStatus(await getCloudStatus(), "google");
		expect(google.enabled).toBe(true);
		expect(google.configured).toBe(false);
		expect(google.authenticated).toBe(false);
		expect(google.status).toBe("enabled_without_credential");

		await expectPublicResponsesDoNotLeak([disabledKeySecret, enabledKeySecret]);
	});

	test("provider credential deletion removes auth.json aliases without disabling providers", async () => {
		await setCloudProviderEnabled("anthropic", true);
		await setCloudProviderEnabled("openai", true);
		await setCloudProviderEnabled("google", true);
		await saveProviderKey("openai", "sk-openai-primary-delete-test");
		await saveProviderKey("openai-codex", "sk-openai-codex-delete-test");
		await saveProviderKey("google-gemini-cli", "google-gemini-cli-delete-test");

		const secrets = [
			"anthropic-oauth-delete-test",
			"openai-oauth-delete-test",
			"openai-codex-oauth-delete-test",
			"google-oauth-delete-test",
			"google-gemini-cli-auth-key-delete-test",
		];
		writeAuthJson({
			anthropic: { type: "oauth", access: secrets[0], refresh: "anthropic-refresh-delete-test", expires: Date.now() + 60_000 },
			openai: { type: "oauth", access: secrets[1], refresh: "openai-refresh-delete-test", expires: Date.now() + 60_000 },
			"openai-codex": { type: "oauth", access: secrets[2], refresh: "openai-codex-refresh-delete-test", expires: Date.now() + 60_000 },
			google: { type: "oauth", access: secrets[3], refresh: "google-refresh-delete-test", expires: Date.now() + 60_000 },
			"google-gemini-cli": { key: secrets[4] },
		});

		expect(providerStatus(await getCloudStatus(), "openai").configured).toBe(true);
		expect(providerStatus(await getCloudStatus(), "google").configured).toBe(true);
		expect(providerStatus(await getCloudStatus(), "anthropic").configured).toBe(true);

		let del = await apiFetch("/api/provider-keys/openai", { method: "DELETE" });
		expect(del.status).toBe(200);
		let auth = readAuthJson();
		expect(auth.openai).toBeUndefined();
		expect(auth["openai-codex"]).toBeUndefined();
		expect(auth.google).toBeDefined();
		expect(auth["google-gemini-cli"]).toBeDefined();
		expect(providerStatus(await getCloudStatus(), "openai")).toMatchObject({
			enabled: true,
			configured: false,
			authenticated: false,
			status: "enabled_without_credential",
		});

		del = await apiFetch("/api/provider-keys/google-gemini-cli", { method: "DELETE" });
		expect(del.status).toBe(200);
		auth = readAuthJson();
		expect(auth.google).toBeUndefined();
		expect(auth["google-gemini-cli"]).toBeUndefined();
		expect(auth.anthropic).toBeDefined();
		expect(providerStatus(await getCloudStatus(), "google")).toMatchObject({
			enabled: true,
			configured: false,
			authenticated: false,
			status: "enabled_without_credential",
		});

		del = await apiFetch("/api/provider-keys/anthropic", { method: "DELETE" });
		expect(del.status).toBe(200);
		auth = readAuthJson();
		expect(auth.anthropic).toBeUndefined();
		const prefs = await getPreferences();
		expect(prefs["providerEnabled.anthropic"]).toBe(true);
		expect(prefs["providerEnabled.openai"]).toBe(true);
		expect(prefs["providerEnabled.google"]).toBe(true);

		await expectPublicResponsesDoNotLeak(secrets);
	});

	test("WebSocket rejects disabled cloud providers before set_model, prompt, and steer", async () => {
		await saveProviderKey("google", "google-ws-auth-test-key");
		await putPreferences({ "default.sessionModel": "google/gemini-ws-auth-test" });
		const sessionId = await createSession();
		try {
			const ws = await connectWs(sessionId);
			try {
				await ws.waitFor((m: any) => m.type === "state" && m.data?.model?.provider === "google", 5_000);
				await setCloudProviderEnabled("google", false);

				let cursor = ws.messageCount();
				ws.send({ type: "set_model", provider: "google", modelId: "gemini-rejected-by-opt-in" });
				let err = await ws.waitForFrom(cursor, (m: any) => m.type === "error" && m.code === "cloud_auth_required", 5_000);
				expect(err.message).toContain("Choose at least one cloud provider");

				cursor = ws.messageCount();
				ws.send({ type: "prompt", text: "this prompt must not be queued" });
				err = await ws.waitForFrom(cursor, (m: any) => m.type === "error" && m.code === "cloud_auth_required", 5_000);
				expect(err.message).toContain("Choose at least one cloud provider");

				cursor = ws.messageCount();
				ws.send({ type: "steer", text: "this steer must not be delivered" });
				err = await ws.waitForFrom(cursor, (m: any) => m.type === "error" && m.code === "cloud_auth_required", 5_000);
				expect(err.message).toContain("Choose at least one cloud provider");
			} finally {
				ws.close();
			}
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("AI Gateway mode bypasses cloud provider auth requirements and reauth prompts", async () => {
		writeAuthJson({
			"openai-codex": {
				type: "oauth",
				access: "expired-openai-access-provider-opt-in",
				refresh: "expired-openai-refresh-provider-opt-in",
				expires: Date.now() - 60 * 1000,
			},
		});
		await setCloudProviderEnabled("openai", true);
		await putPreferences({ "providerCredentialInvalid.openai": true });

		const server = await startMockAigwServer();
		try {
			const configure = await apiFetch("/api/aigw/configure", {
				method: "POST",
				body: JSON.stringify({ url: server.url }),
			});
			expect(configure.status).toBe(200);

			const status = await getCloudStatus();
			expect(status.mode).toBe("aigw");
			expect(status.aigwConfigured).toBe(true);
			expect(status.authGateRequired).toBe(false);
			for (const provider of status.providers) {
				expect(provider.status).toBe("aigw_bypass");
				expect(provider.authenticated).toBe(false);
				expect(provider.expired).toBe(false);
				expect(provider.needsReauth).toBe(false);
			}
		} finally {
			await apiFetch("/api/aigw/configure", { method: "DELETE" });
			await server.close();
		}
	});

	test("host-token/env-managed Google credentials count as authenticated without leaking values", async () => {
		const secret = "AIzaHostManagedProviderOptInSecret111111";
		process.env.GEMINI_API_KEY = secret;
		await setCloudProviderEnabled("google", true);

		const status = await getCloudStatus();
		expect(status.authGateRequired).toBe(false);
		const google = providerStatus(status, "google");
		expect(google.enabled).toBe(true);
		expect(google.configured).toBe(true);
		expect(google.authenticated).toBe(true);
		expect(google.needsReauth).toBe(false);
		expect(google.status).toBe("authenticated");
		expect(google.credentialTypes).toEqual(expect.arrayContaining(["env", "host_token"]));

		const imageModels = await (await apiFetch("/api/image-models")).json();
		expect(imageModels.some((model: any) => model.provider === "google" && model.authenticated === true)).toBe(true);
		await expectPublicResponsesDoNotLeak([secret]);
	});

	test("host-managed credential rotation clears provider invalid state", async () => {
		const badSecret = "AIzaInvalidHostManagedProviderOptIn111111";
		const rotatedSecret = "AIzaRotatedHostManagedProviderOptIn222222";
		process.env.GEMINI_API_KEY = badSecret;
		await setCloudProviderEnabled("google", true);
		await putPreferences({ "default.imageModel": "google/gemini-2.5-flash-image" });

		await withImageProviderFetchMock(async (href) => {
			if (!href.includes("generativelanguage.googleapis.com")) return undefined;
			return new Response(JSON.stringify({
				error: { message: `API key not valid: ${badSecret}` },
			}), { status: 401, headers: { "Content-Type": "application/json" } });
		}, async () => {
			const res = await apiFetch("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "draw a host token recovery test", model: "google/gemini-2.5-flash-image" }),
			});
			expect(res.status).toBe(500);
			expect(await res.text()).not.toContain(badSecret);
		});

		let prefs = await getPreferences();
		expect(prefs["providerCredentialInvalid.google"]).toBe(true);
		expect(prefs["providerCredentialInvalidFingerprint.google"]).toBeUndefined();
		let google = providerStatus(await getCloudStatus(), "google");
		expect(google.authenticated).toBe(false);
		expect(google.needsReauth).toBe(true);
		expect(google.status).toBe("invalid");

		process.env.GEMINI_API_KEY = rotatedSecret;
		google = providerStatus(await getCloudStatus(), "google");
		expect(google.configured).toBe(true);
		expect(google.authenticated).toBe(true);
		expect(google.needsReauth).toBe(false);
		expect(google.status).toBe("authenticated");
		prefs = await getPreferences();
		expect(prefs["providerCredentialInvalid.google"]).not.toBe(true);
		expect(prefs["providerCredentialInvalidFingerprint.google"]).toBeUndefined();

		const imageModels = await (await apiFetch("/api/image-models")).json();
		expect(imageModels.some((model: any) => model.provider === "google" && model.authenticated === true)).toBe(true);
		await expectPublicResponsesDoNotLeak([badSecret, rotatedSecret]);
	});

	test("definitive image provider auth failure marks credentials invalid and redacts status", async () => {
		const secret = "sk-invalid-openai-secret-provider-opt-in";
		await saveProviderKey("openai", secret);
		await putPreferences({ "default.imageModel": "openai/gpt-image-2" });

		await withImageProviderFetchMock(async (href, init) => {
			if (href !== "https://api.openai.com/v1/images/generations") return undefined;
			const requestBody = JSON.parse(String(init?.body || "{}"));
			expect(requestBody.model).toBe("gpt-image-2");
			return new Response(JSON.stringify({
				error: { message: `Incorrect API key provided: ${secret}` },
			}), { status: 401, headers: { "Content-Type": "application/json" } });
		}, async () => {
			const res = await apiFetch("/api/image-generation/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "draw a test square", model: "openai/gpt-image-2" }),
			});
			expect(res.status).toBe(500);
			expect(await res.text()).not.toContain(secret);
		});

		const prefs = await getPreferences();
		expect(prefs["providerCredentialInvalid.openai"]).toBe(true);
		const openai = providerStatus(await getCloudStatus(), "openai");
		expect(openai.enabled).toBe(true);
		expect(openai.configured).toBe(true);
		expect(openai.authenticated).toBe(false);
		expect(openai.needsReauth).toBe(true);
		expect(openai.status).toBe("invalid");
		expect(openai.credentialTypes).toContain("api_key");

		const imageModels = await (await apiFetch("/api/image-models")).json();
		expect(imageModels.some((model: any) => model.provider === "openai")).toBe(false);
		await expectPublicResponsesDoNotLeak([secret]);
	});

	test("transient image provider failures do not mark credentials invalid", async () => {
		const cases: Array<{ name: string; run: () => Promise<void> }> = [
			{
				name: "rate-limit",
				run: () => withImageProviderFetchMock(async (href) => {
					if (href !== "https://api.openai.com/v1/images/generations") return undefined;
					return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), { status: 429, headers: { "Content-Type": "application/json" } });
				}, () => requestImageGenerationExpectingFailure()),
			},
			{
				name: "server-error",
				run: () => withImageProviderFetchMock(async (href) => {
					if (href !== "https://api.openai.com/v1/images/generations") return undefined;
					return new Response(JSON.stringify({ error: { message: "provider temporarily unavailable" } }), { status: 500, headers: { "Content-Type": "application/json" } });
				}, () => requestImageGenerationExpectingFailure()),
			},
			{
				name: "network-error",
				run: () => withImageProviderFetchMock(async (href) => {
					if (href !== "https://api.openai.com/v1/images/generations") return undefined;
					throw new TypeError("simulated provider network failure");
				}, () => requestImageGenerationExpectingFailure()),
			},
		];

		for (const entry of cases) {
			await saveProviderKey("openai", `sk-transient-${entry.name}-provider-opt-in`);
			await putPreferences({ "default.imageModel": "openai/gpt-image-2" });
			await entry.run();
			expect((await getPreferences())["providerCredentialInvalid.openai"]).not.toBe(true);
			const openai = providerStatus(await getCloudStatus(), "openai");
			expect(openai.authenticated).toBe(true);
			expect(openai.needsReauth).toBe(false);
			expect(openai.status).toBe("authenticated");
		}
	});

	test("disabled target cloud providers are omitted from /api/models even when credentials exist", async () => {
		await saveProviderKey("anthropic", "anthropic-disabled-model-key", { enable: false });
		await saveProviderKey("openai", "openai-disabled-model-key", { enable: false });
		await saveProviderKey("google", "google-disabled-model-key", { enable: false });

		const res = await apiFetch("/api/models");
		expect(res.status).toBe(200);
		const models = await res.json();
		expect(Array.isArray(models)).toBe(true);

		const targetModels = models.filter((model: any) => TARGET_MODEL_PROVIDERS.has(model.provider));
		expect(targetModels, `target provider models should be hidden: ${targetModels.map((m: any) => `${m.provider}/${m.id}`).join(", ")}`).toEqual([]);
	});

	test("session creation is guarded when direct-cloud mode has no authenticated opt-in provider", async () => {
		const before = await listSessionIds();
		const res = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("cloud_auth_required");
		expect(body.status?.mode).toBe("direct-cloud");
		expect(body.status?.authGateRequired).toBe(true);

		const after = await listSessionIds();
		expect(after).toEqual(before);
	});
});

async function resetProviderState(): Promise<void> {
	await apiFetch("/api/aigw/configure", { method: "DELETE" });
	for (const provider of PROVIDER_KEY_ALIASES) {
		await apiFetch(`/api/provider-keys/${provider}`, { method: "DELETE" });
	}
	await putPreferences({
		"providerEnabled.anthropic": null,
		"providerEnabled.openai": null,
		"providerEnabled.google": null,
		"providerCredentialInvalid.anthropic": null,
		"providerCredentialInvalid.openai": null,
		"providerCredentialInvalid.google": null,
		"providerCredentialInvalidFingerprint.anthropic": null,
		"providerCredentialInvalidFingerprint.openai": null,
		"providerCredentialInvalidFingerprint.google": null,
		"default.sessionModel": null,
		"customProviders": null,
		"aigw.exclusive": null,
	});
}

async function putPreferences(values: Record<string, unknown>): Promise<void> {
	const res = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify(values),
	});
	expect(res.status).toBe(200);
}

async function getPreferences(): Promise<Record<string, unknown>> {
	const res = await apiFetch("/api/preferences");
	expect(res.status).toBe(200);
	return await res.json();
}

async function getCloudStatus(): Promise<CloudStatus> {
	const res = await apiFetch("/api/cloud-providers/status");
	expect(res.status).toBe(200);
	return await res.json();
}

function providerStatus(status: CloudStatus, provider: CloudProviderId): CloudStatus["providers"][number] {
	const found = status.providers.find((p) => p.id === provider);
	expect(found, `missing provider status for ${provider}`).toBeTruthy();
	return found!;
}

async function setCloudProviderEnabled(provider: CloudProviderId, enabled: boolean): Promise<void> {
	const res = await apiFetch(`/api/cloud-providers/${provider}`, {
		method: "PUT",
		body: JSON.stringify({ enabled }),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body).toMatchObject({ ok: true, provider, enabled });
}

async function saveProviderKey(provider: string, key: string, opts: { enable?: boolean } = {}): Promise<void> {
	const body: Record<string, unknown> = { key };
	if (opts.enable !== undefined) body.enable = opts.enable;
	const res = await apiFetch(`/api/provider-keys/${provider}`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	const responseBody = await res.json();
	expect(responseBody.ok).toBe(true);
	expect(JSON.stringify(responseBody)).not.toContain(key);
}

async function expectPublicResponsesDoNotLeak(secrets: string[]): Promise<void> {
	for (const apiPath of ["/api/preferences", "/api/cloud-providers/status"]) {
		const res = await apiFetch(apiPath);
		expect(res.status).toBe(200);
		const text = JSON.stringify(await res.json());
		for (const secret of secrets) {
			expect(text).not.toContain(secret);
		}
	}
}

async function requestImageGenerationExpectingFailure(): Promise<void> {
	const res = await apiFetch("/api/image-generation/generate", {
		method: "POST",
		body: JSON.stringify({ prompt: "draw a transient failure test", model: "openai/gpt-image-2" }),
	});
	expect(res.status).toBe(500);
}

async function withImageProviderFetchMock<T>(
	handler: (url: string, init?: any) => Response | undefined | Promise<Response | undefined>,
	fn: () => Promise<T>,
): Promise<T> {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async (url: any, init?: any) => {
		const href = typeof url === "string"
			? url
			: url instanceof URL
				? url.toString()
				: typeof url?.url === "string"
					? url.url
					: String(url);
		const response = await handler(href, init);
		if (response) return response;
		return previousFetch(url, init);
	}) as typeof fetch;
	try {
		return await fn();
	} finally {
		globalThis.fetch = previousFetch;
	}
}

function writeAuthJson(data: Record<string, unknown>): void {
	if (!agentDir) throw new Error("agentDir not initialised");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(data, null, 2), "utf-8");
}

function readAuthJson(): Record<string, unknown> {
	if (!agentDir) throw new Error("agentDir not initialised");
	return JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf-8"));
}

async function startMockAigwServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const mockServer = http.createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			data: [
				{ id: "mock-provider/model-a", object: "model", created: 1700000000, owned_by: "system" },
			],
		}));
	});
	await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
	const port = (mockServer.address() as any).port;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve, reject) => mockServer.close((err) => err ? reject(err) : resolve())),
	};
}

async function listSessionIds(): Promise<string[]> {
	const res = await apiFetch("/api/sessions");
	expect(res.status).toBe(200);
	const body = await res.json();
	const sessions = Array.isArray(body) ? body : (body.sessions ?? []);
	return sessions.map((session: any) => session.id).sort();
}
