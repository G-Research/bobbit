import { guardProcessEnv } from "../../../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();
delete process.env.PI_OAUTH_CALLBACK_HOST;

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthInteraction, Credential, Models, OAuthCredential } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";
import { resetAgentDirStateForTests } from "../../../../../src/server/bobbit-dir.js";
import { AtomicCredentialStore } from "../../../../../src/server/auth/credential-store.js";

type FakeCallbackHandler = (
	request: { url?: string },
	response: { writeHead(statusCode: number): void; end(body?: string): void },
) => void;

const callbackServerHarness = {
	handler: undefined as FakeCallbackHandler | undefined,
};
const originalCreateServer = http.createServer;
http.createServer = ((handler: FakeCallbackHandler) => {
	callbackServerHarness.handler = handler;
	const server = {
		on: () => server,
		listen: (...args: unknown[]) => {
			let callback: (() => void) | undefined;
			for (let i = args.length - 1; i >= 0; i--) {
				if (typeof args[i] === "function") {
					callback = args[i] as () => void;
					break;
				}
			}
			queueMicrotask(() => callback?.());
			return server;
		},
		close: () => server,
	};
	return server;
}) as unknown as typeof http.createServer;
syncBuiltinESMExports();

const tmp = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-adapter-"));
const agentDir = path.join(tmp, "agent");
const authPath = path.join(agentDir, "auth.json");
mkdirSync(agentDir, { recursive: true });
process.env.BOBBIT_AGENT_DIR = agentDir;
resetAgentDirStateForTests();

const {
	oauthCancel,
	oauthCancelAndWait,
	oauthComplete,
	oauthFinalize,
	oauthFlowStatus,
	invalidateRejectedAnthropicDirectCredential,
	oauthLogout,
	oauthStart,
	oauthStatus,
	refreshOAuthToken,
	shutdownOAuthFlows,
	stopFlowCleanup,
} = await import("../../../../../src/server/auth/oauth.js");

const activeFlowIds = new Set<string>();
const SERVER_SOURCE = readFileSync(new URL("../../../../../src/server/server.ts", import.meta.url), "utf8");

const REQUIRED_SCOPES = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
] as const;

const OFFLINE_FETCH: typeof fetch = async () => {
	throw new Error("offline OAuth contract blocked provider network access");
};

interface LoginCapture {
	providerId?: string;
	type?: string;
	interaction?: AuthInteraction;
	resolve?: (credential: Credential) => void;
	reject?: (error: Error) => void;
}

function oauthCredential(): OAuthCredential {
	return {
		type: "oauth",
		access: randomUUID(),
		refresh: randomUUID(),
		expires: Date.now() + 60 * 60 * 1000,
	};
}

function currentAuthorizeUrl(state = randomUUID()): string {
	const query = new URLSearchParams({
		code: "true",
		client_id: randomUUID(),
		response_type: "code",
		redirect_uri: "http://localhost:53692/callback",
		scope: REQUIRED_SCOPES.join(" "),
		code_challenge: randomUUID(),
		code_challenge_method: "S256",
		state,
	});
	return `https://claude.ai/oauth/authorize?${query.toString()}`;
}

function pendingModels(capture: LoginCapture, authorizeUrl = currentAuthorizeUrl()): Pick<Models, "login"> {
	return {
		login: ((providerId: string, type: string, interaction: AuthInteraction) => {
			capture.providerId = providerId;
			capture.type = type;
			capture.interaction = interaction;
			interaction.notify({
				type: "auth_url",
				url: authorizeUrl,
				instructions: "Complete the mocked Pi OAuth flow",
			});
			return new Promise<Credential>((resolve, reject) => {
				capture.resolve = resolve;
				capture.reject = reject;
			});
		}) as Models["login"],
	};
}

async function startAnthropic(
	models?: Pick<Models, "login">,
	fetchImpl: typeof fetch = OFFLINE_FETCH,
): ReturnType<typeof oauthStart> {
	const started = await oauthStart("anthropic", fetchImpl, models);
	activeFlowIds.add(started.flowId);
	return started;
}

function dispatchPiCallback(url: string): { statusCode: number; body: string } {
	assert.ok(callbackServerHarness.handler, "Pi should create its callback server before notifying auth_url");
	const result = { statusCode: 0, body: "" };
	callbackServerHarness.handler(
		{ url },
		{
			writeHead(statusCode) {
				result.statusCode = statusCode;
			},
			end(body = "") {
				result.body = body;
			},
		},
	);
	return result;
}

function assertCurrentAuthorizeUrl(value: string): void {
	const url = new URL(value);
	assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
	assert.equal(url.searchParams.get("code"), "true");
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:53692/callback");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.ok(url.searchParams.get("client_id"));
	assert.ok(url.searchParams.get("code_challenge"));
	assert.ok(url.searchParams.get("state"));
	assert.deepEqual((url.searchParams.get("scope") ?? "").split(" "), REQUIRED_SCOPES);
}

async function releasePending(capture: LoginCapture, flowId: string): Promise<void> {
	capture.reject?.(new Error("test teardown"));
	for (let i = 0; i < 20; i++) await Promise.resolve();
	oauthFlowStatus(flowId, "anthropic");
}

beforeEach(() => {
	process.env.BOBBIT_AGENT_DIR = agentDir;
	resetAgentDirStateForTests();
	rmSync(authPath, { force: true });
	rmSync(`${authPath}.bobbit-rejected-oauth.json`, { force: true });
	rmSync(`${authPath}.bobbit-rejected-oauth.anthropic.json`, { force: true });
	rmSync(`${authPath}.bobbit-rejected-oauth.openai-codex.json`, { force: true });
	callbackServerHarness.handler = undefined;
});

afterEach(async () => {
	for (const flowId of activeFlowIds) oauthCancel(flowId, "anthropic");
	activeFlowIds.clear();
	for (let i = 0; i < 20; i++) await Promise.resolve();
});

afterAll(() => {
	stopFlowCleanup();
	http.createServer = originalCreateServer;
	syncBuiltinESMExports();
	rmSync(tmp, { recursive: true, force: true });
});

describe("installed Pi Anthropic OAuth contract", () => {
	it("emits the maintained loopback authorize URL and six scopes", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let notifiedUrl: string | undefined;
		const interaction: AuthInteraction = {
			notify(event) {
				if (event.type === "auth_url") notifiedUrl = event.url;
			},
			prompt: async () => {
				throw new Error("intentional offline cancellation");
			},
		};

		await assert.rejects(
			runtime.login("anthropic", "oauth", interaction),
			/intentional offline cancellation/,
		);
		assert.ok(notifiedUrl, "Pi should emit auth_url before requesting manual input");
		assertCurrentAuthorizeUrl(notifiedUrl);
	});

	it("rejects missing and mismatched loopback state before token exchange", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let notified = false;
		let rejectManual: ((error: Error) => void) | undefined;
		const login = runtime.login("anthropic", "oauth", {
			notify(event) {
				if (event.type === "auth_url") notified = true;
			},
			prompt: () => new Promise<string>((_resolve, reject) => {
				rejectManual = reject;
			}),
		});
		for (let i = 0; i < 100 && (!notified || !rejectManual); i++) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		assert.equal(notified, true);
		assert.ok(rejectManual);

		try {
			const missing = dispatchPiCallback(`/callback?code=${encodeURIComponent(randomUUID())}`);
			assert.equal(missing.statusCode, 400);
			assert.match(missing.body, /missing code or state/i);
			const mismatch = dispatchPiCallback(
				`/callback?code=${encodeURIComponent(randomUUID())}&state=${encodeURIComponent(randomUUID())}`,
			);
			assert.equal(mismatch.statusCode, 400);
			assert.match(mismatch.body, /state mismatch/i);
		} finally {
			rejectManual(new Error("intentional callback validation cancellation"));
		}
		await assert.rejects(login, /intentional callback validation cancellation/);
	});

	it("exchanges a validated authorization code through Pi's current PKCE contract", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		// Generate opaque fixture values at runtime: no token-shaped fixture is
		// checked into the repository or emitted by this test.
		const syntheticAccess = randomUUID();
		const syntheticRefresh = randomUUID();
		const syntheticCode = randomUUID();
		const fixedNow = Date.UTC(2030, 0, 2, 3, 4, 5);
		const notifications: unknown[] = [];
		const consoleLines: string[] = [];
		const exchangeRequests: Array<{
			url: string;
			method: string | undefined;
			body: Record<string, unknown>;
		}> = [];
		let authorizeUrl: string | undefined;
		let rejectManual: ((error: Error) => void) | undefined;
		let loginSettled = false;
		const originalFetch = globalThis.fetch;
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
		const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				consoleLines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
			}),
		);
		globalThis.fetch = (async (input, init) => {
			const url = typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
			exchangeRequests.push({
				url,
				method: init?.method,
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			return new Response(JSON.stringify({
				access_token: syntheticAccess,
				refresh_token: syntheticRefresh,
				expires_in: 3_600,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const login = runtime.login("anthropic", "oauth", {
			notify(event) {
				notifications.push(event);
				if (event.type === "auth_url") authorizeUrl = event.url;
			},
			prompt: () => new Promise<string>((_resolve, reject) => {
				rejectManual = reject;
			}),
		}).finally(() => {
			loginSettled = true;
		});

		try {
			for (let i = 0; i < 100 && (!authorizeUrl || !rejectManual); i++) {
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			assert.ok(authorizeUrl, "Pi should emit an authorization URL before token exchange");
			assert.ok(rejectManual, "Pi should offer manual callback completion without opening a listener");
			const authorization = new URL(authorizeUrl);
			const state = authorization.searchParams.get("state");
			const challenge = authorization.searchParams.get("code_challenge");
			assert.ok(state, "the authorization URL must carry callback state");
			assert.ok(challenge, "the authorization URL must carry a PKCE challenge");
			assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
			assert.equal(
				challenge === createHash("sha256").update(state).digest("base64url"),
				true,
				"the emitted challenge must be the S256 digest of Pi's verifier/state",
			);

			const callback = dispatchPiCallback(
				`/callback?code=${encodeURIComponent(syntheticCode)}&state=${encodeURIComponent(state)}`,
			);
			assert.equal(callback.statusCode, 200);
			assert.match(callback.body, /authentication completed/i);

			const credential = await login as OAuthCredential;
			assert.equal(exchangeRequests.length, 1, "authorization completion must make one token request");
			const exchange = exchangeRequests[0];
			assert.equal(exchange.url, "https://platform.claude.com/v1/oauth/token");
			assert.equal(exchange.method, "POST");
			assert.equal(exchange.body.grant_type, "authorization_code");
			assert.equal(exchange.body.redirect_uri, "http://localhost:53692/callback");
			assert.equal(exchange.body.code, syntheticCode);
			assert.equal(exchange.body.state === state, true, "token exchange state must match the validated callback");
			assert.equal(
				exchange.body.code_verifier === state,
				true,
				"token exchange must send the verifier whose S256 challenge was authorized",
			);
			assert.equal(
				exchange.body.client_id === authorization.searchParams.get("client_id"),
				true,
				"authorization and token exchange must use the same client identity",
			);

			assert.deepEqual(Object.keys(credential).sort(), ["access", "expires", "refresh", "type"]);
			assert.equal(credential.type, "oauth");
			assert.equal(credential.access === syntheticAccess, true);
			assert.equal(credential.refresh === syntheticRefresh, true);
			assert.equal(credential.expires, fixedNow + 3_600_000 - 5 * 60_000);
			const observableOutput = JSON.stringify({ consoleLines, notifications });
			assert.equal(observableOutput.includes(syntheticAccess), false, "access values must not enter logs or interaction output");
			assert.equal(observableOutput.includes(syntheticRefresh), false, "refresh values must not enter logs or interaction output");
		} finally {
			if (!loginSettled) {
				rejectManual?.(new Error("synthetic OAuth test cleanup"));
				await login.catch(() => undefined);
			}
			globalThis.fetch = originalFetch;
			dateNow.mockRestore();
			for (const spy of consoleSpies) spy.mockRestore();
		}
	});
});

describe("Anthropic OAuth Pi browser adapter", () => {
	it("delegates initiation to injected Models.login and surfaces Pi's notification unchanged", async () => {
		const capture: LoginCapture = {};
		const piAuthorizeUrl = currentAuthorizeUrl();
		let networkCalls = 0;
		const offlineFetch: typeof fetch = async () => {
			networkCalls += 1;
			throw new Error("offline Anthropic OAuth regression attempted network access");
		};

		const started = await startAnthropic(pendingModels(capture, piAuthorizeUrl), offlineFetch);
		assert.deepEqual(
			{ providerId: capture.providerId, type: capture.type },
			{ providerId: "anthropic", type: "oauth" },
			"ANTHROPIC_OAUTH_CONTRACT_STALE: oauthStart must delegate Anthropic login to injected Models.login",
		);
		assert.equal(started.url, piAuthorizeUrl, "oauthStart must surface Pi's auth_url notification verbatim");
		assert.equal(started.provider, "anthropic");
		assert.equal(started.callbackServer, true);
		assert.match(started.instructions ?? "", /mocked Pi OAuth flow/);
		assert.equal(networkCalls, 0, "the injected offline Pi boundary must not use the legacy exchange path");

		await releasePending(capture, started.flowId);
	});

	it("keeps a process-wide lease until the active Anthropic login settles", async () => {
		const first: LoginCapture = {};
		const started = await startAnthropic(pendingModels(first));
		await assert.rejects(
			() => startAnthropic(pendingModels({})),
			(error: unknown) => {
				assert.match(error instanceof Error ? error.message : String(error), /busy|in progress|retry/i);
				return true;
			},
		);

		await releasePending(first, started.flowId);
		const replacement: LoginCapture = {};
		const replacementStarted = await startAnthropic(pendingModels(replacement));
		await releasePending(replacement, replacementStarted.flowId);
	});

	it("maps callback-port contention to retryable busy and releases the process lease", async () => {
		let loginCalls = 0;
		const portBusyModels: Pick<Models, "login"> = {
			login: (async () => {
				loginCalls += 1;
				const error = new Error(
					"listen EADDRINUSE: address already in use 127.0.0.1:53692",
				) as NodeJS.ErrnoException;
				error.code = "EADDRINUSE";
				throw error;
			}) as Models["login"],
		};

		await assert.rejects(
			() => startAnthropic(portBusyModels),
			(error: unknown) => {
				const candidate = error as { code?: unknown; message?: unknown; statusCode?: unknown; retryable?: unknown };
				assert.match(String(candidate.message), /busy|retry/i);
				assert.equal(candidate.code, "ANTHROPIC_OAUTH_BUSY");
				assert.equal(candidate.statusCode, 409);
				assert.equal(candidate.retryable, true);
				return true;
			},
		);
		assert.equal(loginCalls, 1, "the injected Pi boundary must fail before an auth notification");

		const replacement: LoginCapture = {};
		const replacementStarted = await startAnthropic(pendingModels(replacement));
		await releasePending(replacement, replacementStarted.flowId);
	});

	it("explicit cancellation is provider-isolated, aborts Pi, and releases the lease", async () => {
		let interactionSeen: AuthInteraction | undefined;
		let promptError: unknown;
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interactionSeen = interaction;
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				try {
					await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				} catch (error) {
					promptError = error;
					throw error;
				}
				throw new Error("manual prompt unexpectedly resolved");
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		assert.deepEqual(oauthCancel(started.flowId, "openai-codex"), { success: false });
		assert.equal(interactionSeen?.signal?.aborted, false, "provider mismatch must not cancel another provider's flow");
		assert.deepEqual(oauthCancel(started.flowId, "anthropic"), { success: true });
		assert.deepEqual(oauthFlowStatus(started.flowId, "anthropic"), { complete: false, error: "flow not found" });

		// A prompt has no submitted authorization code, so cancellation must not
		// wait for Pi's asynchronous prompt rejection before allowing a retry.
		const replacement: LoginCapture = {};
		const replacementStarted = await startAnthropic(pendingModels(replacement));
		for (let i = 0; i < 100 && !promptError; i++) await Promise.resolve();
		assert.equal(interactionSeen?.signal?.aborted, true);
		assert.match(promptError instanceof Error ? promptError.message : String(promptError), /cancelled/i);
		await releasePending(replacement, replacementStarted.flowId);
	});

	it("waits for an active token exchange before releasing cancellation and blocks its credential", async () => {
		const credential = oauthCredential();
		let releaseExchange: (() => void) | undefined;
		let exchangeStarted = false;
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				exchangeStarted = true;
				await new Promise<void>((resolve) => { releaseExchange = resolve; });
				return credential;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 100 && !exchangeStarted; i++) await Promise.resolve();
		assert.equal(exchangeStarted, true, "the mocked provider must be in its token exchange");

		assert.deepEqual(oauthCancel(started.flowId, "anthropic"), { success: true });
		assert.deepEqual(oauthFlowStatus(started.flowId, "anthropic"), { complete: false }, "cancellation must retain the active flow until exchange settlement");
		await assert.rejects(() => startAnthropic(pendingModels({})), /busy|in progress|retry/i);

		releaseExchange?.();
		assert.deepEqual(await completion, { success: false, error: "OAuth flow cancelled" });
		const storedAfterCancel = existsSync(authPath)
			? JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>
			: {};
		assert.equal(storedAfterCancel.anthropic, undefined, "a cancelled exchange must not persist its credential");
		activeFlowIds.delete(started.flowId);

		const replacement: LoginCapture = {};
		const replacementStarted = await startAnthropic(pendingModels(replacement));
		await releasePending(replacement, replacementStarted.flowId);
	});

	it("makes direct gateway shutdown settle OAuth flows and exit despite cleanup failure", () => {
		const routeStart = SERVER_SOURCE.indexOf("// POST /api/shutdown");
		const routeEnd = SERVER_SOURCE.indexOf("// GET /api/ca-cert", routeStart);
		assert.ok(routeStart >= 0 && routeEnd > routeStart, "shutdown route must be present");
		const shutdownRoute = SERVER_SOURCE.slice(routeStart, routeEnd);
		assert.match(
			shutdownRoute,
			/setTimeout\(async \(\) => \{\s*try \{\s*await shutdownOAuthFlows\(\);\s*\} catch \(error\) \{[\s\S]*console\.warn\(\"\[shutdown\] OAuth flow cleanup failed:\", error\)[\s\S]*\} finally \{\s*process\.exit\(0\);\s*\}/,
			"direct shutdown must await OAuth settlement, log cleanup failure, and still exit",
		);
	});

	it("awaits a pending Anthropic exchange during gateway OAuth shutdown", async () => {
		const credential = oauthCredential();
		let releaseExchange!: () => void;
		let exchangeStarted = false;
		let interactionSeen: AuthInteraction | undefined;
		const exchangeBlocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interactionSeen = interaction;
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				exchangeStarted = true;
				await exchangeBlocked;
				return credential;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 100 && !exchangeStarted; i++) await Promise.resolve();
		assert.equal(exchangeStarted, true, "the mocked provider must be in its token exchange");

		let shutdownSettled = false;
		const shutdown = shutdownOAuthFlows().then(() => { shutdownSettled = true; });
		await Promise.resolve();
		assert.equal(interactionSeen?.signal?.aborted, true, "shutdown must abort Pi's pending interaction");
		assert.equal(shutdownSettled, false, "shutdown must wait for the active exchange to settle");

		releaseExchange();
		await shutdown;
		assert.deepEqual(await completion, { success: false, error: "OAuth flow cancelled" });
		assert.deepEqual(oauthFlowStatus(started.flowId, "anthropic"), { complete: false, error: "flow not found" });
		const stored = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown> : {};
		assert.equal(stored.anthropic, undefined, "shutdown cancellation must not persist the issued credential");
		activeFlowIds.delete(started.flowId);
	});

	it("retains a real Pi loopback callback flow and lease until its cancelled exchange settles", async () => {
		const previous = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: previous }), "utf8");
		const lateAccess = randomUUID();
		const lateRefresh = randomUUID();
		let exchangeStarted = false;
		let releaseExchange!: () => void;
		const exchangeBlocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url !== "https://platform.claude.com/v1/oauth/token") {
				throw new Error(`unexpected OAuth provider request: ${url}`);
			}
			exchangeStarted = true;
			await exchangeBlocked;
			return new Response(JSON.stringify({ access_token: lateAccess, refresh_token: lateRefresh, expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const started = await oauthStart("anthropic");
			activeFlowIds.add(started.flowId);
			const state = new URL(started.url).searchParams.get("state");
			assert.ok(state);
			dispatchPiCallback(`/callback?code=${encodeURIComponent(randomUUID())}&state=${encodeURIComponent(state)}`);
			for (let i = 0; i < 100 && !exchangeStarted; i++) await new Promise((resolve) => setTimeout(resolve, 2));
			assert.equal(exchangeStarted, true, "the real loopback callback must enter Pi token exchange");

			oauthCancel(started.flowId, "anthropic");
			assert.deepEqual(
				oauthFlowStatus(started.flowId, "anthropic"),
				{ complete: false },
				"a callback exchange has no manual code submission but must retain its flow",
			);
			await assert.rejects(() => startAnthropic(pendingModels({})), /busy|in progress|retry/i);

			releaseExchange();
			let replacement: { flowId: string } | undefined;
			let replacementCapture: LoginCapture | undefined;
			for (let i = 0; i < 100 && !replacement; i++) {
				try {
					const capture: LoginCapture = {};
					replacement = await startAnthropic(pendingModels(capture));
					replacementCapture = capture;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 2));
				}
			}
			assert.ok(replacement, "the loopback lease must release after Pi settles");
			assert.ok(replacementCapture);
			const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
			assert.equal(stored.access === previous.access, true, "cancelled callback exchange must restore the prior credential");
			assert.equal(stored.refresh === previous.refresh, true);
			activeFlowIds.delete(started.flowId);
			await releasePending(replacementCapture, replacement.flowId);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("restores the prior credential with a compare-and-swap after a cancelled re-login persists late", async () => {
		const previous = oauthCredential();
		const replacement = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: previous }), "utf8");
		let releaseExchange: (() => void) | undefined;
		let exchangeStarted = false;
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				exchangeStarted = true;
				await new Promise<void>((resolve) => { releaseExchange = resolve; });
				// Simulate Pi persisting before Models.login resolves.
				writeFileSync(authPath, JSON.stringify({ anthropic: replacement }), "utf8");
				return replacement;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 100 && !exchangeStarted; i++) await Promise.resolve();
		assert.equal(exchangeStarted, true);
		oauthCancel(started.flowId, "anthropic");
		releaseExchange?.();
		assert.deepEqual(await completion, { success: false, error: "OAuth flow cancelled" });
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
		assert.equal(stored.access === previous.access, true, "cancelled re-login must restore the prior access credential");
		assert.equal(stored.refresh === previous.refresh, true, "cancelled re-login must restore the prior refresh credential");
		assert.equal(stored.expires, previous.expires);
		activeFlowIds.delete(started.flowId);
	});

	it("reports a failed cancellation rollback and permits cleanup retry", async () => {
		const previous = oauthCredential();
		const issued = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: previous }), "utf8");
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		const rollback = vi.spyOn(AtomicCredentialStore.prototype, "rollbackCredentialIfCurrent")
			.mockRejectedValueOnce(new Error("credential rollback unavailable"));
		try {
			await assert.rejects(
				() => oauthCancelAndWait(started.flowId, "anthropic"),
				/credential rollback unavailable/,
				"cancellation must not report success when durable cleanup failed",
			);
			assert.equal(oauthStatus("anthropic").authenticated, false, "a failed rollback must leave a durable denied decision, not accepted auth");
			assert.equal(existsSync(`${authPath}.bobbit-rejected-oauth.anthropic.json`), true, "the cancellation denial must survive a gateway restart");
			assert.deepEqual(
				await oauthCancelAndWait(started.flowId, "anthropic"),
				{ success: true },
				"a failed cleanup remains actionable through retry",
			);
		} finally {
			rollback.mockRestore();
		}
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
		assert.equal(stored.access, previous.access, "successful retry must restore the preceding credential");
		activeFlowIds.delete(started.flowId);
	});

	it("retries a failed rollback after cancellation races an in-flight exchange", async () => {
		const previous = oauthCredential();
		const issued = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: previous }), "utf8");
		let releaseExchange!: () => void;
		let exchangeStarted = false;
		const exchangeBlocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				exchangeStarted = true;
				await exchangeBlocked;
				// Pi can persist before reporting its final result to the interaction.
				writeFileSync(authPath, JSON.stringify({ anthropic: issued }), "utf8");
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 100 && !exchangeStarted; i++) await Promise.resolve();
		assert.equal(exchangeStarted, true);

		const rollback = vi.spyOn(AtomicCredentialStore.prototype, "rollbackCredentialIfCurrent")
			.mockRejectedValueOnce(new Error("rollback temporarily unavailable"));
		try {
			const cancelling = oauthCancelAndWait(started.flowId, "anthropic");
			releaseExchange();
			await assert.rejects(() => cancelling, /rollback temporarily unavailable/);
			assert.deepEqual(await completion, { success: false, error: "OAuth flow cancelled" });
			assert.deepEqual(
				oauthFlowStatus(started.flowId, "anthropic"),
				{ complete: false, error: "OAuth flow cancelled" },
				"status must preserve the cancelled terminal outcome while cleanup remains retryable",
			);
			assert.deepEqual(await oauthCancelAndWait(started.flowId, "anthropic"), { success: true });
		} finally {
			rollback.mockRestore();
		}
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
		assert.equal(stored.access, previous.access);
		assert.equal(stored.refresh, previous.refresh);
		activeFlowIds.delete(started.flowId);
	});

	it("keeps a completed flow cancellable when its success response is lost", async () => {
		const previous = oauthCredential();
		const issued = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: previous }), "utf8");
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		// Treat this as a success response that reached the gateway but not the UI.
		assert.deepEqual(await oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH), { success: true });
		assert.deepEqual(oauthFlowStatus(started.flowId, "anthropic"), { complete: true });
		await oauthCancelAndWait(started.flowId, "anthropic");
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
		assert.equal(stored.access, previous.access);
		assert.equal(stored.refresh, previous.refresh);
		activeFlowIds.delete(started.flowId);
	});

	it("keeps a manually completed flow cancellable when its success response is lost", async () => {
		const previous = oauthCredential();
		const issued = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: previous }), "utf8");
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		assert.deepEqual(await oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH), { success: true });
		assert.deepEqual(oauthFlowStatus(started.flowId, "anthropic"), { complete: true });
		await oauthCancelAndWait(started.flowId, "anthropic");
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
		assert.equal(stored.access, previous.access);
		assert.equal(stored.refresh, previous.refresh);
		activeFlowIds.delete(started.flowId);
	});

	it("does not report a known rejected credential authenticated when durable deletion fails", async () => {
		const rejected = oauthCredential();
		const replacement = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: rejected }), "utf8");
		const originalAtomicWrite = (AtomicCredentialStore.prototype as any).atomicWrite as Function;
		const atomicWrite = vi.spyOn(AtomicCredentialStore.prototype as any, "atomicWrite")
			.mockImplementation(function (this: AtomicCredentialStore, ...args: unknown[]) {
				const [data, destination] = args;
				// The rejection fence is written first. Simulate only the subsequent
				// auth.json deletion failing, as can happen after a durable marker write.
				if (destination === authPath) throw new Error("credential store unavailable");
				return originalAtomicWrite.call(this, data, destination);
			});
		try {
			assert.equal(await refreshOAuthToken(OFFLINE_FETCH, {
				getAuth: async () => {
					const error = Object.assign(new Error("rejected"), { status: 401 });
					throw error;
				},
			}), null);
		} finally {
			atomicWrite.mockRestore();
		}
		assert.deepEqual(oauthStatus("anthropic"), {
			authenticated: false,
			stored: true,
			rejected: true,
			refreshable: false,
			expires: rejected.expires,
			provider: "anthropic",
		});
		// A newly constructed store models post-restart consumers: the durable,
		// non-secret rejection fence must hide the still-present raw row there too.
		assert.equal(await new AtomicCredentialStore(authPath).read("anthropic"), undefined);
		// The marker is keyed to the rejected access value, not the provider alone.
		writeFileSync(authPath, JSON.stringify({ anthropic: replacement }), "utf8");
		assert.equal(oauthStatus("anthropic").authenticated, true);
	});

	it("restores only its issued credential when cancellation wins after completion but before polling", async () => {
		const previous = oauthCredential();
		const issued = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: previous }), "utf8");
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		assert.equal(existsSync(authPath), true, "the completed flow should have issued its credential");
		// Do not poll the completed result away: this models a user cancelling the
		// waiting dialog after Pi completed but before the UI's next poll.
		await oauthCancelAndWait(started.flowId, "anthropic");
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
		assert.equal(stored.access === previous.access, true);
		assert.equal(stored.refresh === previous.refresh, true);
		activeFlowIds.delete(started.flowId);
	});

	it("preserves an Anthropic API-key row on OAuth logout", async () => {
		const apiKey = randomUUID();
		const codex = oauthCredential();
		writeFileSync(authPath, JSON.stringify({
			anthropic: { type: "api-key", key: apiKey },
			"openai-codex": codex,
		}), "utf8");

		assert.deepEqual(await oauthLogout("anthropic"), { success: true, provider: "anthropic" });
		const document = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(document.anthropic, { type: "api-key", key: apiKey });
		assert.deepEqual(document["openai-codex"], codex);
	});

	it("preserves an Anthropic API key while removing a late OAuth result after logout", async () => {
		const apiKey = { type: "api-key", key: randomUUID() };
		const issued = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: apiKey }), "utf8");
		let releaseExchange!: () => void;
		let exchangeStarted = false;
		const exchangeBlocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				exchangeStarted = true;
				await exchangeBlocked;
				// Pi can commit after logout but before reporting completion.
				writeFileSync(authPath, JSON.stringify({ anthropic: issued }), "utf8");
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 100 && !exchangeStarted; i++) await Promise.resolve();
		assert.equal(exchangeStarted, true);

		await oauthLogout("anthropic");
		releaseExchange();
		assert.deepEqual(await completion, { success: false, error: "OAuth flow cancelled" });
		const document = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(document.anthropic, apiKey, "logout must preserve an API key while terminally removing the late OAuth result");
		activeFlowIds.delete(started.flowId);
	});

	it("does not resurrect either cancelled credential when concurrent Codex flows settle out of order", async () => {
		const original = oauthCredential();
		const firstIssued = oauthCredential();
		const secondIssued = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ "openai-codex": original }), "utf8");
		const codexModels = (issued: OAuthCredential): Pick<Models, "login"> => ({
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				return issued;
			}) as Models["login"],
		});
		const first = await oauthStart("openai-codex", OFFLINE_FETCH, codexModels(firstIssued));
		const second = await oauthStart("openai-codex", OFFLINE_FETCH, codexModels(secondIssued));
		assert.deepEqual(await oauthComplete(first.flowId, randomUUID(), OFFLINE_FETCH, "openai-codex"), { success: true });
		assert.deepEqual(await oauthComplete(second.flowId, randomUUID(), OFFLINE_FETCH, "openai-codex"), { success: true });

		await oauthCancelAndWait(first.flowId, "openai-codex");
		await oauthCancelAndWait(second.flowId, "openai-codex");
		const document = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		assert.equal(document["openai-codex"], undefined, "a later cancellation must not restore the earlier cancelled flow's credential");
	});

	it("finalizes accepted auth and never reports an unknown cancel as cleaned up", async () => {
		const issued = oauthCredential();
		const models: Pick<Models, "login"> = {
			login: (async (_provider, _type, interaction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		assert.deepEqual(await oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH), { success: true });
		assert.deepEqual(oauthFinalize(started.flowId, "anthropic"), { success: true });
		assert.deepEqual(await oauthCancelAndWait(started.flowId, "anthropic"), {
			success: false,
			error: "Unknown or expired flow ID",
		});
		assert.equal(oauthStatus("anthropic").authenticated, true);
		activeFlowIds.delete(started.flowId);
	});

	it("does not resurrect a cancelled credential after logout tombstones the flow", async () => {
		const previous = oauthCredential();
		const issued = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: previous }), "utf8");
		let releaseExchange!: () => void;
		const exchangeBlocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				await exchangeBlocked;
				// Model Pi persisting after logout, before its cancelled login resolves.
				writeFileSync(authPath, JSON.stringify({ anthropic: issued }), "utf8");
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 100; i++) await Promise.resolve();
		oauthCancel(started.flowId, "anthropic");
		await oauthLogout("anthropic");
		releaseExchange();
		await oauthCancelAndWait(started.flowId, "anthropic");
		assert.deepEqual(await completion, { success: false, error: "OAuth flow cancelled" });
		const document = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown> : {};
		assert.equal(document.anthropic, undefined, "a logout must not be undone by a late cancelled callback");
		activeFlowIds.delete(started.flowId);
	});

	it("allows reauthentication started before an old credential rejection to complete", async () => {
		const oldCredential = oauthCredential();
		const renewedCredential = oauthCredential();
		writeFileSync(authPath, JSON.stringify({ anthropic: oldCredential }), "utf8");
		let releaseExchange!: () => void;
		const exchangeBlocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				await exchangeBlocked;
				return renewedCredential;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 20; i++) await Promise.resolve();

		assert.equal(await invalidateRejectedAnthropicDirectCredential(oldCredential.access), true);
		releaseExchange();
		assert.deepEqual(
			await completion,
			{ success: true },
			"rejecting the exact old row must not terminally cancel independent reauthentication",
		);
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
		assert.equal(stored.access, renewedCredential.access);
		assert.equal(stored.refresh, renewedCredential.refresh);
		activeFlowIds.delete(started.flowId);
	});

	it("makes logout terminal when a late Pi exchange succeeds", async () => {
		const issued = oauthCredential();
		let releaseExchange!: () => void;
		let exchangeStarted = false;
		const exchangeBlocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				exchangeStarted = true;
				await exchangeBlocked;
				// Model Pi persisting immediately before reporting successful login.
				writeFileSync(authPath, JSON.stringify({ anthropic: issued }), "utf8");
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 100 && !exchangeStarted; i++) await Promise.resolve();
		assert.equal(exchangeStarted, true);

		await oauthLogout("anthropic");
		releaseExchange();
		assert.deepEqual(await completion, { success: false, error: "OAuth flow cancelled" });
		const document = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown> : {};
		assert.equal(document.anthropic, undefined, "logout must remove the late flow's credential");
		activeFlowIds.delete(started.flowId);
	});

	it("removes only the late flow credential after logout", async () => {
		const issued = oauthCredential();
		const newer = oauthCredential();
		let releaseExchange!: () => void;
		let exchangeStarted = false;
		const exchangeBlocked = new Promise<void>((resolve) => { releaseExchange = resolve; });
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				exchangeStarted = true;
				await exchangeBlocked;
				writeFileSync(authPath, JSON.stringify({ anthropic: issued }), "utf8");
				// A newer login wins after Pi's write but before terminal cleanup.
				queueMicrotask(() => writeFileSync(authPath, JSON.stringify({ anthropic: newer }), "utf8"));
				return issued;
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const completion = oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH);
		for (let i = 0; i < 100 && !exchangeStarted; i++) await Promise.resolve();
		assert.equal(exchangeStarted, true);

		await oauthLogout("anthropic");
		releaseExchange();
		assert.deepEqual(await completion, { success: false, error: "OAuth flow cancelled" });
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as OAuthCredential;
		assert.equal(stored.access, newer.access, "terminal cleanup must not remove a newer credential");
		assert.equal(stored.refresh, newer.refresh);
		activeFlowIds.delete(started.flowId);
	});

	it("forwards a full remote redirect unchanged and accepts a bare authorization code", async () => {
		for (const mode of ["redirect", "bare"] as const) {
			const expectedState = randomUUID();
			const expectedCode = randomUUID();
			const credential = oauthCredential();
			let seenInput: string | undefined;
			const models: Pick<Models, "login"> = {
				login: (async (providerId: string, type: string, interaction: AuthInteraction) => {
					assert.equal(providerId, "anthropic");
					assert.equal(type, "oauth");
					interaction.notify({ type: "auth_url", url: currentAuthorizeUrl(expectedState) });
					seenInput = await interaction.prompt({
						type: "manual_code",
						message: "Paste redirect URL or code",
						placeholder: "http://localhost:53692/callback",
					});
					if (mode === "redirect") {
						const parsed = new URL(seenInput);
						if (parsed.searchParams.get("state") !== expectedState) throw new Error("OAuth state mismatch");
						if (!parsed.searchParams.get("code")) throw new Error("Missing authorization code");
					} else if (!seenInput.trim()) {
						throw new Error("Missing authorization code");
					}
					return credential;
				}) as Models["login"],
			};
			const started = await startAnthropic(models);
			const pasted = mode === "redirect"
				? `http://localhost:53692/callback?code=${encodeURIComponent(expectedCode)}&state=${encodeURIComponent(expectedState)}`
				: expectedCode;
			assert.deepEqual(await oauthComplete(started.flowId, pasted, OFFLINE_FETCH), { success: true });
			assert.equal(seenInput === pasted, true, "the adapter must not parse or rewrite Pi's manual input");
		}
	});

	it("preserves Pi's state error while redacting credential-shaped details", async () => {
		const expectedState = randomUUID();
		const sensitive = randomUUID();
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl(expectedState) });
				const input = await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				const parsed = new URL(input);
				if (parsed.searchParams.get("state") !== expectedState) {
					throw new Error(`OAuth state mismatch; access_token=${sensitive}`);
				}
				return oauthCredential();
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const result = await oauthComplete(
			started.flowId,
			`http://localhost:53692/callback?code=${encodeURIComponent(randomUUID())}&state=${encodeURIComponent(randomUUID())}`,
			OFFLINE_FETCH,
		);
		assert.equal(result.success, false);
		assert.match(result.error ?? "", /state mismatch/i);
		assert.equal((result.error ?? "").includes(sensitive), false, "manual-flow errors must not expose token material");
	});

	it("polls callback completion and persists the canonical returned credential", async () => {
		const capture: LoginCapture = {};
		const credential = oauthCredential();
		const started = await startAnthropic(pendingModels(capture));
		assert.deepEqual(oauthFlowStatus(started.flowId, "anthropic"), { complete: false });

		capture.resolve?.(credential);
		let completed: { complete: boolean; error?: string } = { complete: false };
		for (let i = 0; i < 100 && !completed.complete; i++) {
			await new Promise((resolve) => setTimeout(resolve, 2));
			completed = oauthFlowStatus(started.flowId, "anthropic");
		}
		assert.deepEqual(completed, { complete: true });
		const stored = JSON.parse(readFileSync(authPath, "utf8")).anthropic as Record<string, unknown>;
		assert.deepEqual(Object.keys(stored).sort(), ["access", "expires", "refresh", "type"]);
		assert.equal(stored.type, "oauth");
		assert.equal(stored.access === credential.access, true);
		assert.equal(stored.refresh === credential.refresh, true);
		assert.equal(stored.expires === credential.expires, true);
	});

	it("expires and aborts a pending manual prompt, then releases the lease", async () => {
		const capture: LoginCapture = {};
		let promptError: unknown;
		const models: Pick<Models, "login"> = {
			login: (async (_providerId: string, _type: string, interaction: AuthInteraction) => {
				capture.interaction = interaction;
				interaction.notify({ type: "auth_url", url: currentAuthorizeUrl() });
				try {
					await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
				} catch (error) {
					promptError = error;
					throw error;
				}
				throw new Error("manual prompt unexpectedly resolved");
			}) as Models["login"],
		};
		const started = await startAnthropic(models);
		const now = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
		try {
			assert.deepEqual(await oauthComplete(started.flowId, randomUUID(), OFFLINE_FETCH), {
				success: false,
				error: "OAuth flow expired",
			});
		} finally {
			dateNow.mockRestore();
		}
		assert.deepEqual(oauthFlowStatus(started.flowId, "anthropic"), { complete: false, error: "flow not found" });
		// Expiry at an unsubmitted prompt must release the lease synchronously,
		// rather than waiting for Pi to observe the abort signal.
		const replacement: LoginCapture = {};
		const replacementStarted = await startAnthropic(pendingModels(replacement));
		for (let i = 0; i < 100 && !promptError; i++) await Promise.resolve();
		assert.equal(capture.interaction?.signal?.aborted, true);
		assert.match(promptError instanceof Error ? promptError.message : String(promptError), /OAuth flow expired/);
		await releasePending(replacement, replacementStarted.flowId);
	});
});
