import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();
delete process.env.PI_OAUTH_CALLBACK_HOST;

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthInteraction, Credential, Models, OAuthCredential } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";

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
	oauthComplete,
	oauthFlowStatus,
	oauthStart,
	stopFlowCleanup,
} = await import("../../src/server/auth/oauth.js");

const activeFlowIds = new Set<string>();

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
		assert.deepEqual(oauthCancel(started.flowId, "openai-codex"), { success: true });
		assert.equal(interactionSeen?.signal?.aborted, false, "provider mismatch must not cancel another provider's flow");
		assert.deepEqual(oauthCancel(started.flowId, "anthropic"), { success: true });
		for (let i = 0; i < 100 && !promptError; i++) await Promise.resolve();
		assert.equal(interactionSeen?.signal?.aborted, true);
		assert.match(promptError instanceof Error ? promptError.message : String(promptError), /cancelled/i);
		assert.deepEqual(oauthFlowStatus(started.flowId, "anthropic"), { complete: false, error: "flow not found" });

		const replacement: LoginCapture = {};
		const replacementStarted = await startAnthropic(pendingModels(replacement));
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
		for (let i = 0; i < 100 && !promptError; i++) await Promise.resolve();
		assert.equal(capture.interaction?.signal?.aborted, true);
		assert.match(promptError instanceof Error ? promptError.message : String(promptError), /OAuth flow expired/);

		const replacement: LoginCapture = {};
		const replacementStarted = await startAnthropic(pendingModels(replacement));
		await releasePending(replacement, replacementStarted.flowId);
	});
});
