import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { vi } from "vitest";
import type { AuthInteraction, Credential, Models } from "@earendil-works/pi-ai";
import { AtomicCredentialStore } from "../../../src/server/auth/credential-store.js";
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { readE2EToken, base } from "./_helpers/e2e/e2e-setup.js";
import { loadServerTestRuntime } from "../../support/harnesses/shared/server-runtime.js";

let globalAuthPath: typeof import("../../../src/server/bobbit-dir.js").globalAuthPath;
let oauthCancel: typeof import("../../../src/server/auth/oauth.js").oauthCancel;
let refreshOAuthToken: typeof import("../../../src/server/auth/oauth.js").refreshOAuthToken;
let setOAuthModelsFactoryForTests: typeof import("../../../src/server/auth/oauth.js").setOAuthModelsFactoryForTests;
let deterministicLoginInvocations = 0;
const activeFlows = new Set<string>();
const originalFetch = globalThis.fetch;

const headers = () => ({
	Authorization: `Bearer ${readE2EToken()}`,
	"Content-Type": "application/json",
});

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: { ...headers(), ...(opts.headers as Record<string, string> | undefined) },
	});
}

function restoreCredentialFixture(): void {
	// Keep the shared gateway usable for later specs without committing any
	// credential material to the test fixture.
	rmSync(`${globalAuthPath()}.bobbit-rejected-oauth.json`, { force: true });
	rmSync(`${globalAuthPath()}.bobbit-rejected-oauth.anthropic.json`, { force: true });
	writeFileSync(globalAuthPath(), JSON.stringify({
		anthropic: { type: "oauth", expires: Date.now() + 60_000 },
	}), "utf8");
}

function installMockAnthropicTokenProvider(status = 200): () => void {
	const access = randomUUID();
	const refresh = randomUUID();
	globalThis.fetch = (async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === "https://platform.claude.com/v1/oauth/token") {
			if (status !== 200) {
				return new Response(JSON.stringify({ error: "invalid_grant" }), {
					status,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	return () => { globalThis.fetch = originalFetch; };
}

function callbackFor(start: { url: string }): string {
	const authorization = new URL(start.url);
	const state = authorization.searchParams.get("state");
	if (!state) throw new Error("mock provider start omitted OAuth state");
	return `http://localhost:53692/callback?code=${encodeURIComponent(randomUUID())}&state=${encodeURIComponent(state)}`;
}

/**
 * The route contract needs a complete Pi-shaped interaction, not Pi's
 * process-global callback listener. This facade preserves callback parsing,
 * state validation, cancellation, and returned-credential persistence through
 * the production adapter without binding Pi's fixed localhost port.
 */
function deterministicAnthropicModels(): Pick<Models, "login"> {
	return {
		login: (async (provider: string, type: string, interaction: AuthInteraction) => {
			deterministicLoginInvocations += 1;
			if (provider !== "anthropic" || type !== "oauth") throw new Error("unexpected OAuth provider");
			const state = randomUUID();
			interaction.notify({
				type: "auth_url",
				url: `https://claude.ai/oauth/authorize?${new URLSearchParams({ state }).toString()}`,
				instructions: "Complete the deterministic Anthropic OAuth flow",
			});
			const supplied = await interaction.prompt({
				type: "manual_code",
				message: "Paste redirect URL",
			});
			const callback = new URL(supplied);
			if (callback.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
			if (!callback.searchParams.get("code")) throw new Error("Missing authorization code");
			return {
				type: "oauth",
				access: randomUUID(),
				refresh: randomUUID(),
				expires: Date.now() + 60 * 60 * 1000,
			} satisfies Credential;
		}) as Models["login"],
	};
}

test.beforeAll(async () => {
	const runtime = await loadServerTestRuntime();
	({ globalAuthPath } = runtime.bobbitDir);
	({ oauthCancel, refreshOAuthToken, setOAuthModelsFactoryForTests } = runtime.oauth);
	setOAuthModelsFactoryForTests(deterministicAnthropicModels);
});

test.afterAll(() => {
	setOAuthModelsFactoryForTests(undefined);
	deterministicLoginInvocations = 0;
});

test.beforeEach(() => {
	deterministicLoginInvocations = 0;
	restoreCredentialFixture();
});

test.afterEach(() => {
	for (const flowId of activeFlows) oauthCancel(flowId, "anthropic");
	activeFlows.clear();
	globalThis.fetch = originalFetch;
	deterministicLoginInvocations = 0;
	restoreCredentialFixture();
});

test.describe("Anthropic OAuth lifecycle routes", () => {
	test("uses the real start, cancel, retry, complete, status, and logout routes without returning credentials", async () => {
		const restoreFetch = installMockAnthropicTokenProvider();
		try {
			// A second provider proves Anthropic logout and flow operations are scoped.
			writeFileSync(globalAuthPath(), JSON.stringify({
				"openai-codex": { type: "oauth", expires: Date.now() + 60_000 },
			}), "utf8");

			const firstResponse = await api("/api/oauth/start", {
				method: "POST",
				body: JSON.stringify({ provider: "anthropic" }),
			});
			expect(firstResponse.status).toBe(200);
			const first = await firstResponse.json() as { flowId: string; provider: string; url: string };
			activeFlows.add(first.flowId);
			expect(first.provider).toBe("anthropic");
			expect(new URL(first.url).searchParams.get("state")).toBeTruthy();
			// The real gateway route must select the installed test facade, not Pi's listener.
			expect(deterministicLoginInvocations).toBe(1);

			const busy = await api("/api/oauth/start", {
				method: "POST",
				body: JSON.stringify({ provider: "anthropic" }),
			});
			expect(busy.status).toBe(409);
			expect(await busy.json()).toEqual({
				error: expect.any(String),
				code: "ANTHROPIC_OAUTH_BUSY",
				retryable: true,
			});

			const wrongProviderCancel = await api("/api/oauth/cancel", {
				method: "POST",
				body: JSON.stringify({ flowId: first.flowId, provider: "openai-codex" }),
			});
			expect(wrongProviderCancel.status).toBe(404);
			expect(await wrongProviderCancel.json()).toEqual({ success: false, error: "Unknown or expired flow ID" });
			const stillPending = await api(`/api/oauth/flow-status?flowId=${encodeURIComponent(first.flowId)}&provider=anthropic`);
			expect(stillPending.status).toBe(200);
			expect(await stillPending.json()).toEqual({ complete: false });

			const cancel = await api("/api/oauth/cancel", {
				method: "POST",
				body: JSON.stringify({ flowId: first.flowId, provider: "anthropic" }),
			});
			expect(cancel.status).toBe(200);
			expect(await cancel.json()).toEqual({ success: true });
			activeFlows.delete(first.flowId);

			// This intentionally follows cancellation with no retry delay: the route
			// must not leave the gateway's Anthropic sign-in lease stranded.
			const retryResponse = await api("/api/oauth/start", {
				method: "POST",
				body: JSON.stringify({ provider: "anthropic" }),
			});
			expect(retryResponse.status).toBe(200);
			expect(deterministicLoginInvocations).toBe(2);
			const retry = await retryResponse.json() as { flowId: string; url: string };
			activeFlows.add(retry.flowId);

			const complete = await api("/api/oauth/complete", {
				method: "POST",
				body: JSON.stringify({ flowId: retry.flowId, provider: "anthropic", code: callbackFor(retry) }),
			});
			expect(complete.status).toBe(200);
			expect(await complete.json()).toEqual({ success: true });
			activeFlows.delete(retry.flowId);

			const authenticated = await api("/api/oauth/status?provider=anthropic");
			expect(authenticated.status).toBe(200);
			expect(await authenticated.json()).toEqual({
				authenticated: true,
				provider: "anthropic",
				expires: expect.any(Number),
			});

			const logout = await api("/api/oauth/logout", {
				method: "POST",
				body: JSON.stringify({ provider: "anthropic" }),
			});
			expect(logout.status).toBe(200);
			expect(await logout.json()).toEqual({ success: true, provider: "anthropic" });
			const loggedOut = await api("/api/oauth/status?provider=anthropic");
			expect(await loggedOut.json()).toEqual({ authenticated: false, provider: "anthropic" });
			const isolated = await api("/api/oauth/status?provider=openai-codex");
			expect(await isolated.json()).toEqual({
				authenticated: true,
				provider: "openai-codex",
				expires: expect.any(Number),
			});
		} finally {
			restoreFetch();
		}
	});

	test("returns a bounded cancellation retry and blocks a replacement flow until that same flow succeeds", async () => {
		const restoreFetch = installMockAnthropicTokenProvider();
		const cancellationFailure = "private credential-store detail";
		try {
			const startResponse = await api("/api/oauth/start", {
				method: "POST",
				body: JSON.stringify({ provider: "anthropic" }),
			});
			expect(startResponse.status).toBe(200);
			const started = await startResponse.json() as { flowId: string; url: string };
			activeFlows.add(started.flowId);

			// The injected Pi-shaped facade settles through the real completion route.
			// Completed flows remain addressable through the acknowledgement window,
			// so cancellation still exercises the exact credential rollback path.
			const completed = await api("/api/oauth/complete", {
				method: "POST",
				body: JSON.stringify({ flowId: started.flowId, provider: "anthropic", code: callbackFor(started) }),
			});
			expect(completed.status).toBe(200);
			expect(await completed.json()).toEqual({ success: true });

			const rollback = vi.spyOn(AtomicCredentialStore.prototype, "rollbackCredentialIfCurrent")
				.mockRejectedValueOnce(new Error(cancellationFailure));
			try {
				const failedCancel = await api("/api/oauth/cancel", {
					method: "POST",
					body: JSON.stringify({ flowId: started.flowId, provider: "anthropic" }),
				});
				expect(failedCancel.status).toBe(503);
				expect(rollback).toHaveBeenCalledOnce();
				expect(await failedCancel.json()).toEqual({
					error: "OAuth cancellation did not complete. Retry cancellation before starting another sign-in.",
					code: "OAUTH_CANCEL_RETRY_REQUIRED",
					retryable: true,
					flowId: started.flowId,
				});

				const blockedStart = await api("/api/oauth/start", {
					method: "POST",
					body: JSON.stringify({ provider: "anthropic" }),
				});
				expect(blockedStart.status).toBe(409);
				expect(await blockedStart.json()).toEqual({
					error: "OAuth cancellation did not complete. Retry cancellation before starting another sign-in.",
					code: "OAUTH_CANCEL_RETRY_REQUIRED",
					retryable: true,
					flowId: started.flowId,
				});
			} finally {
				rollback.mockRestore();
			}

			const retryCancel = await api("/api/oauth/cancel", {
				method: "POST",
				body: JSON.stringify({ flowId: started.flowId, provider: "anthropic" }),
			});
			expect(retryCancel.status).toBe(200);
			expect(await retryCancel.json()).toEqual({ success: true });
			activeFlows.delete(started.flowId);

			const replacement = await api("/api/oauth/start", {
				method: "POST",
				body: JSON.stringify({ provider: "anthropic" }),
			});
			expect(replacement.status).toBe(200);
			const replacementFlow = await replacement.json() as { flowId: string };
			activeFlows.add(replacementFlow.flowId);
		} finally {
			restoreFetch();
		}
	});

	test("removes a definitively rejected stored credential before status can report it authenticated", async () => {
		const access = randomUUID();
		const refresh = randomUUID();
		writeFileSync(globalAuthPath(), JSON.stringify({
			anthropic: {
				type: "oauth",
				access,
				refresh,
				expires: Date.now() - 60_000,
			},
		}), "utf8");
		const restoreFetch = installMockAnthropicTokenProvider(401);
		try {
			expect(await refreshOAuthToken()).toBeNull();
			const status = await api("/api/oauth/status?provider=anthropic");
			expect(status.status).toBe(200);
			expect(await status.json()).toEqual({
				authenticated: false,
				stored: true,
				rejected: true,
				refreshable: false,
				provider: "anthropic",
			});
		} finally {
			restoreFetch();
		}
	});
});
