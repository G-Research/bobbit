import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd } from "./e2e-setup.js";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function writeAuthJson(data: Record<string, unknown>): void {
	if (!agentDir) throw new Error("agentDir not initialised");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(data, null, 2), "utf-8");
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
