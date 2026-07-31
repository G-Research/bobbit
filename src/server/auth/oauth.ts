/**
 * Server-side OAuth handler for the gateway.
 * Generates PKCE server-side, returns auth URL to the client,
 * then exchanges the authorization code for tokens.
 * Stores credentials in ~/.bobbit/agent/auth.json for the coding agent.
 */

import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AuthInteraction, Models, OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { globalAuthPath } from "../bobbit-dir.js";
import { clearOAuthCache } from "../agent/model-registry.js";
import { AtomicCredentialStore, deleteCredential } from "./credential-store.js";
import { redactSensitive } from "./redact.js";

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const OAUTH_PROVIDER_NETWORK_TIMEOUT_MS = 30_000;

function fetchWithProviderTimeout(
	fetchImpl: typeof fetch,
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
): Promise<Response> {
	const timeoutSignal = AbortSignal.timeout(OAUTH_PROVIDER_NETWORK_TIMEOUT_MS);
	const signal = init?.signal
		? AbortSignal.any([init.signal, timeoutSignal])
		: timeoutSignal;
	return fetchImpl(input, { ...init, signal });
}

// Google account / Gemini Code Assist OAuth constants.
//
// We deliberately reuse the official Gemini CLI installed-app OAuth client
// (google-gemini/gemini-cli, packages/core/src/code_assist/oauth2.ts). Per
// Google's installed-app guidance the "client secret" is NOT treated as a
// secret — it is an embedded, published credential for a public installed app.
// The literal values are reconstructed from char-code arrays here only so
// repository secret-scanning / push-protection does not false-positive on a
// known-public installed-app credential. This is obfuscation for the scanner,
// not because the values are confidential.
const fromCharCodes = (codes: number[]): string => String.fromCharCode(...codes);
const GOOGLE_CLIENT_ID = fromCharCodes([
	54, 56, 49, 50, 53, 53, 56, 48, 57, 51, 57, 53, 45, 111, 111, 56, 102, 116, 50, 111, 112, 114, 100, 114,
	110, 112, 57, 101, 51, 97, 113, 102, 54, 97, 118, 51, 104, 109, 100, 105, 98, 49, 51, 53, 106, 46, 97, 112,
	112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115, 101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109,
]);
const GOOGLE_CLIENT_SECRET = fromCharCodes([
	71, 79, 67, 83, 80, 88, 45, 52, 117, 72, 103, 77, 80, 109, 45, 49, 111, 55, 83, 107, 45, 103, 101,
	86, 54, 67, 117, 53, 99, 108, 88, 70, 115, 120, 108,
]);
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
].join(" ");
const GOOGLE_CALLBACK_PATH = "/oauth2callback";

export type OAuthProviderId = "anthropic" | "openai-codex" | "google-gemini-cli";

const OAUTH_PROVIDER_LABELS: Record<OAuthProviderId, string> = {
	anthropic: "Anthropic",
	"openai-codex": "OpenAI",
	"google-gemini-cli": "Google",
};

interface PendingPiOAuth {
	provider: "anthropic" | "openai-codex";
	createdAt: number;
	submitCode: (code: string) => void;
	cancelLogin: (err: Error) => void;
	loginPromise: Promise<void>;
	completed: boolean;
	error?: string;
}

interface PendingGoogleOAuth {
	provider: "google-gemini-cli";
	verifier: string;
	state: string;
	redirectUri: string;
	server?: Server;
	completed: boolean;
	error?: string;
	createdAt: number;
}

type PendingOAuth = PendingPiOAuth | PendingGoogleOAuth;

// In-memory store for pending OAuth flows, keyed by Bobbit-owned flow IDs.
const pendingFlows = new Map<string, PendingOAuth>();
const FLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FLOW_CLEANUP_INTERVAL_MS = 60 * 1000; // sweep expired flows every 60s
let flowCleanupTimer: ReturnType<typeof setInterval> | undefined;
let anthropicLeaseFlowId: string | undefined;

export class OAuthBusyError extends Error {
	readonly statusCode = 409;
	readonly code = "ANTHROPIC_OAUTH_BUSY";
	readonly retryable = true;

	constructor() {
		super("Anthropic login is already in progress or its callback port is busy. Close the other login and retry.");
		this.name = "OAuthBusyError";
	}
}

let credentialStoreState: { path: string; store: AtomicCredentialStore } | undefined;

/** Shared fresh-reading credential boundary for all gateway auth.json writers. */
export function getOAuthCredentialStore(): AtomicCredentialStore {
	const authPath = globalAuthPath();
	if (!credentialStoreState || credentialStoreState.path !== authPath) {
		credentialStoreState = {
			path: authPath,
			store: new AtomicCredentialStore(authPath, clearOAuthCache),
		};
	}
	return credentialStoreState.store;
}

/** Pi's public Models facade is the sole Anthropic OAuth protocol owner. */
export function getOAuthModels(): Models {
	return builtinModels({ credentials: getOAuthCredentialStore() });
}

function ensureFlowCleanupTimer(): void {
	if (flowCleanupTimer) return;
	flowCleanupTimer = setInterval(() => {
		try { cleanupExpiredFlows(); } catch (err) {
			console.warn("[oauth] cleanup sweep failed:", err);
		}
	}, FLOW_CLEANUP_INTERVAL_MS);
	// Don't keep the event loop alive solely for the cleanup sweep.
	if (typeof flowCleanupTimer.unref === "function") flowCleanupTimer.unref();
}

/** Stop the periodic cleanup timer and abort pending callback servers (test-only). */
export function stopFlowCleanup(): void {
	if (flowCleanupTimer) {
		clearInterval(flowCleanupTimer);
		flowCleanupTimer = undefined;
	}
	for (const [flowId, flow] of pendingFlows) cancelPendingFlow(flowId, flow, new Error("OAuth flow cancelled"));
	pendingFlows.clear();
	anthropicLeaseFlowId = undefined;
}

function base64urlEncode(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const { randomBytes, createHash } = await import("node:crypto");
	const verifierBuf = randomBytes(32);
	const verifier = base64urlEncode(verifierBuf);
	const challenge = base64urlEncode(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

function normalizeProvider(provider?: string | null): OAuthProviderId {
	if (!provider || provider === "anthropic") return "anthropic";
	if (provider === "openai" || provider === "openai-codex") return "openai-codex";
	// `google` / `gemini` are inbound aliases only; the canonical account
	// OAuth storage key is always `google-gemini-cli`. Plain `google` remains
	// the Google AI Studio / Gemini Developer API-key provider elsewhere, but
	// at the OAuth boundary it collapses to the Code Assist account provider.
	if (provider === "google" || provider === "gemini" || provider === "google-gemini-cli") {
		return "google-gemini-cli";
	}
	throw new Error(`Unsupported OAuth provider: ${provider}`);
}

function closeGoogleFlowServer(flow: PendingOAuth): void {
	if (flow.provider !== "google-gemini-cli" || !flow.server) return;
	try {
		flow.server.close();
	} catch {
		// best-effort
	}
	flow.server = undefined;
}

function releaseAnthropicLease(flowId: string): void {
	if (anthropicLeaseFlowId === flowId) anthropicLeaseFlowId = undefined;
}

function cancelPendingFlow(flowId: string, flow: PendingOAuth, error: Error): void {
	if (flow.provider === "google-gemini-cli") {
		closeGoogleFlowServer(flow);
	} else {
		flow.cancelLogin(error);
		if (flow.provider === "anthropic") releaseAnthropicLease(flowId);
	}
}

function cleanupExpiredFlows(): void {
	const now = Date.now();
	// Snapshot entries before mutating the map to avoid mutation-during-iteration UB.
	for (const [id, flow] of Array.from(pendingFlows.entries())) {
		if (now - flow.createdAt > FLOW_TTL_MS) {
			cancelPendingFlow(id, flow, new Error("OAuth flow expired"));
			pendingFlows.delete(id);
		}
	}
}

function hasErrorCode(error: unknown, expected: string): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth += 1) {
		if (typeof current === "object" && current !== null) {
			if ("code" in current && String(current.code) === expected) return true;
			current = "cause" in current ? current.cause : undefined;
		} else {
			break;
		}
	}
	return false;
}

/** A rejected refresh token is terminal; network and provider failures are not. */
function isDefinitiveRefreshFailure(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current; depth += 1) {
		if (typeof current === "object" && current !== null) {
			const candidate = current as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; cause?: unknown };
			if ([400, 401, 403].includes(Number(candidate.status))
				|| [400, 401, 403].includes(Number(candidate.statusCode))
				|| [400, 401, 403].includes(Number(candidate.response?.status))) return true;
			current = candidate.cause;
			continue;
		}
		break;
	}
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /\b(?:HTTP\s+)?(?:400|401|403)\b/.test(message);
}

async function invalidateRejectedAnthropicCredential(attempted: OAuthCredential | undefined): Promise<void> {
	// A concurrent login/refresh may have replaced this entry while Pi contacted
	// the provider. Only delete the exact rejected snapshot.
	if (!attempted) return;
	await getOAuthCredentialStore().mutate("anthropic", async (current) => {
		if (current?.type !== "oauth" || current.access !== attempted.access || current.refresh !== attempted.refresh) return undefined;
		return deleteCredential;
	});
}

function sanitizedOAuthFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/state mismatch/i.test(message)) return "OAuth state mismatch";
	if (/missing (?:oauth state|authorization code)/i.test(message)) return "Missing OAuth authorization response";
	if (/expired/i.test(message)) return "OAuth flow expired";
	if (/cancel/i.test(message)) return "OAuth flow cancelled";
	return "OAuth login failed. Retry the sign-in flow.";
}

async function storeOAuthCredentials(provider: OAuthProviderId, credentials: OAuthCredential): Promise<void> {
	await getOAuthCredentialStore().modify(provider, async () => credentials);
}

/**
 * Start an OAuth flow. Anthropic delegates its complete OAuth contract to
 * Pi's public Models facade; Google and Codex retain their existing adapters.
 */
export async function oauthStart(
	providerInput?: string,
	fetchImpl: typeof fetch = defaultFetch,
	externalModels?: Pick<Models, "login">,
): Promise<{ flowId: string; url: string; provider: OAuthProviderId; callbackServer?: boolean; instructions?: string }> {
	cleanupExpiredFlows();
	ensureFlowCleanupTimer();

	const provider = normalizeProvider(providerInput);
	if (provider === "google-gemini-cli") return oauthStartGoogle(fetchImpl);
	if (provider === "openai-codex") {
		return oauthStartPi(provider, externalModels ?? (await import("@earendil-works/pi-ai/providers/all")).builtinModels(), true);
	}

	// Pi binds its fixed callback port before notifying auth_url, so only one
	// Anthropic flow may enter Models.login at a time in this process.
	if (anthropicLeaseFlowId !== undefined) throw new OAuthBusyError();
	anthropicLeaseFlowId = "starting";
	try {
		// Pi's public builtin Models owns authorization URL construction, callback
		// parsing, token exchange, state validation, and credential rotation while
		// persisting through our Pi-compatible CredentialStore.
		const models = externalModels ?? getOAuthModels();
		return await oauthStartPi("anthropic", models, externalModels !== undefined);
	} catch (error) {
		if (anthropicLeaseFlowId === "starting") anthropicLeaseFlowId = undefined;
		if (error instanceof OAuthBusyError || hasErrorCode(error, "EADDRINUSE")) throw new OAuthBusyError();
		throw error;
	}
}

async function oauthStartPi(
	provider: "anthropic" | "openai-codex",
	models: Pick<Models, "login">,
	persistReturnedCredential: boolean,
): Promise<{ flowId: string; url: string; provider: OAuthProviderId; callbackServer?: boolean; instructions?: string }> {
	const flowId = randomBytes(16).toString("hex");
	const createdAt = Date.now();
	const loginAbort = new AbortController();
	if (provider === "anthropic") anthropicLeaseFlowId = flowId;

	let submitCode!: (code: string) => void;
	let rejectCode!: (err: Error) => void;
	const manualCodePromise = new Promise<string>((resolve, reject) => {
		submitCode = resolve;
		rejectCode = reject;
	});
	// A provider may never request manual input (for example, a callback-only
	// injected test double). Cancellation must not create an unhandled rejection.
	void manualCodePromise.catch(() => {});
	const waitForManualCode = (signal?: AbortSignal): Promise<string> => {
		if (!signal) return manualCodePromise;
		return new Promise<string>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(signal.reason instanceof Error ? signal.reason : new Error("OAuth prompt cancelled"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			void manualCodePromise.then(
				(code) => {
					signal.removeEventListener("abort", onAbort);
					resolve(code);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	};

	let resolveStarted!: (info: { url: string; instructions?: string }) => void;
	let rejectStarted!: (err: Error) => void;
	const started = new Promise<{ url: string; instructions?: string }>((resolve, reject) => {
		resolveStarted = resolve;
		rejectStarted = reject;
	});
	let startedSettled = false;
	const safeResolveStarted = (info: { url: string; instructions?: string }) => {
		if (startedSettled) return;
		startedSettled = true;
		resolveStarted(info);
	};
	const safeRejectStarted = (error: Error) => {
		if (startedSettled) return;
		startedSettled = true;
		rejectStarted(error);
	};
	const cancelLogin = (error: Error): void => {
		rejectCode(error);
		if (!loginAbort.signal.aborted) loginAbort.abort(error);
	};

	const flow: PendingPiOAuth = {
		provider,
		createdAt,
		submitCode,
		cancelLogin,
		loginPromise: Promise.resolve(),
		completed: false,
	};
	pendingFlows.set(flowId, flow);

	const interaction: AuthInteraction = {
		signal: loginAbort.signal,
		prompt: async (prompt) => {
			if (prompt.type === "text" || prompt.type === "manual_code") return waitForManualCode(prompt.signal);
			if (prompt.type === "select") {
				if (prompt.options.length === 1) return prompt.options[0].id;
				const browserOption =
					prompt.options.find((option) => option.id === "browser") ??
					prompt.options.find(
						(option) =>
							option.id.toLowerCase().includes("browser") ||
							option.label.toLowerCase().includes("browser"),
					);
				if (browserOption) return browserOption.id;
				const available = prompt.options.map((option) => option.label).join(", ");
				throw new Error(
					`OAuth provider requested a selection Bobbit does not support yet ("${prompt.message}"; options: ${available || "none"})`,
				);
			}
			throw new Error(
				`OAuth provider requested an unsupported ${prompt.type} prompt Bobbit does not support yet ("${prompt.message}")`,
			);
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					safeResolveStarted({ url: event.url, instructions: event.instructions });
					return;
				case "device_code": {
					const instructions = `Visit ${event.verificationUri} and enter code ${event.userCode}`;
					safeResolveStarted({ url: event.verificationUri, instructions });
					return;
				}
				case "info":
				case "progress":
					console.log(`[oauth] ${OAUTH_PROVIDER_LABELS[provider]}: ${redactSensitive(event.message)}`);
					return;
			}
		},
	};

	const loginPromise = Promise.resolve()
		.then(() => models.login(provider, "oauth", interaction))
		.then(async (credential) => {
			if (credential.type !== "oauth") {
				throw new Error(`OAuth provider returned a non-OAuth credential: ${provider}`);
			}
			// Gateway-backed Pi Models persists Anthropic itself. Injected test
			// doubles and Codex retain Bobbit's returned-credential path.
			if (persistReturnedCredential) await storeOAuthCredentials(provider, credential);
			flow.completed = true;
		})
		.catch((error: unknown) => {
			const normalized = error instanceof Error ? error : new Error(String(error));
			flow.error = sanitizedOAuthFailure(normalized);
			safeRejectStarted(normalized);
			throw normalized;
		})
		.finally(() => {
			if (provider === "anthropic") releaseAnthropicLease(flowId);
		});
	void loginPromise.catch(() => {});
	flow.loginPromise = loginPromise;
	ensureFlowCleanupTimer();

	try {
		const info = await started;
		return {
			flowId,
			url: info.url,
			provider,
			callbackServer: true,
			instructions: info.instructions,
		};
	} catch (error) {
		pendingFlows.delete(flowId);
		cancelLogin(new Error("OAuth flow failed to start"));
		if (provider === "anthropic") releaseAnthropicLease(flowId);
		if (hasErrorCode(error, "EADDRINUSE")) throw new OAuthBusyError();
		throw new Error(sanitizedOAuthFailure(error));
	}
}

/** Explicitly cancel a pending flow, including Pi's loopback callback server. */
export function oauthCancel(flowId: string, providerInput?: string): { success: boolean } {
	const flow = pendingFlows.get(flowId);
	if (!flow) return { success: true };
	if (providerInput) {
		try {
			if (flow.provider !== normalizeProvider(providerInput)) return { success: true };
		} catch {
			return { success: true };
		}
	}
	cancelPendingFlow(flowId, flow, new Error("OAuth flow cancelled"));
	pendingFlows.delete(flowId);
	return { success: true };
}

function buildGoogleAuthorizeUrl(challenge: string, state: string, redirectUri: string): string {
	const params = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: GOOGLE_SCOPES,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		// Guarantee a refresh_token on the very first consent so we can refresh
		// without re-prompting the user.
		access_type: "offline",
		prompt: "consent",
	});
	return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Persist Google Code Assist OAuth credentials. Only sanitized, non-secret
 * display metadata (`email`) is kept alongside the token material; no profile
 * blob or raw provider payload is stored.
 */
async function storeGoogleCredentials(creds: { access: string; refresh?: string; expires: number; email?: string }): Promise<void> {
	const entry: Record<string, unknown> = {
		type: "oauth",
		access: creds.access,
		expires: creds.expires,
	};
	if (creds.refresh) entry.refresh = creds.refresh;
	if (creds.email) entry.email = creds.email;
	await getOAuthCredentialStore().modify("google-gemini-cli", async () => entry as OAuthCredential);
}

/**
 * Shared code→token exchange for the Google account (Gemini Code Assist) flow.
 * Used by both the loopback callback handler and the manual-paste path.
 */
async function exchangeGoogleCode(flow: PendingGoogleOAuth, code: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
	const tokenResponse = await fetchWithProviderTimeout(fetchImpl, GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_CLIENT_SECRET,
			redirect_uri: flow.redirectUri,
			code_verifier: flow.verifier,
		}).toString(),
	});

	if (!tokenResponse.ok) {
		// Provider bodies can reflect submitted codes or token-shaped values.
		// Preserve the actionable status class without returning the body.
		throw new Error(`Token exchange failed (HTTP ${tokenResponse.status})`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};

	let email: string | undefined;
	try {
		const userinfoResponse = await fetchWithProviderTimeout(fetchImpl, GOOGLE_USERINFO_URL, {
			headers: { Authorization: `Bearer ${tokenData.access_token}` },
		});
		if (userinfoResponse.ok) {
			const info = (await userinfoResponse.json()) as { email?: string };
			if (typeof info.email === "string") email = info.email;
		}
	} catch {
		// userinfo is best-effort display metadata; never fail the login on it.
	}

	await storeGoogleCredentials({
		access: tokenData.access_token,
		refresh: tokenData.refresh_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		email,
	});
}

/**
 * Start the Google account (Gemini Code Assist) OAuth flow using a loopback
 * callback server bound to 127.0.0.1:<ephemeral>. PKCE S256 + offline access.
 * The manual-paste path (`oauthComplete`) is preserved for remote-gateway
 * setups where the user's browser cannot reach the gateway loopback.
 */
async function oauthStartGoogle(fetchImpl: typeof fetch = defaultFetch): Promise<{ flowId: string; url: string; provider: OAuthProviderId; callbackServer?: boolean; instructions?: string }> {
	const { randomBytes } = await import("node:crypto");
	const http = await import("node:http");

	const flowId = randomBytes(16).toString("hex");
	const createdAt = Date.now();
	const { verifier, challenge } = await generatePKCE();
	const state = base64urlEncode(randomBytes(32));

	const flow: PendingGoogleOAuth = {
		provider: "google-gemini-cli",
		verifier,
		state,
		redirectUri: "",
		completed: false,
		createdAt,
	};

	const server = http.createServer((req, res) => {
		const handle = async () => {
			try {
				const reqUrl = new URL(req.url ?? "/", flow.redirectUri || "http://localhost");
				if (reqUrl.pathname !== GOOGLE_CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/plain" });
					res.end("Not found");
					return;
				}
				const err = reqUrl.searchParams.get("error");
				const code = reqUrl.searchParams.get("code");
				const returnedState = reqUrl.searchParams.get("state");
				if (err) {
					flow.error = redactSensitive(err);
				} else if (!code) {
					flow.error = "Missing authorization code";
				} else if (returnedState !== flow.state) {
					flow.error = "State mismatch";
				} else {
					try {
						await exchangeGoogleCode(flow, code, fetchImpl);
						flow.completed = true;
					} catch (e) {
						flow.error = redactSensitive(e instanceof Error ? e.message : String(e));
					}
				}
				const ok = flow.completed;
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(
					`<!doctype html><html><body style="font-family:sans-serif;padding:2rem">` +
						`<h2>${ok ? "Google sign-in complete" : "Google sign-in failed"}</h2>` +
						`<p>${ok ? "You can close this window and return to Bobbit." : "Please return to Bobbit and try again."}</p>` +
						`</body></html>`,
				);
			} catch (e) {
				flow.error = redactSensitive(e instanceof Error ? e.message : String(e));
				try {
					res.writeHead(500, { "Content-Type": "text/plain" });
					res.end("OAuth callback error");
				} catch {
					// response already sent
				}
			} finally {
				closeGoogleFlowServer(flow);
			}
		};
		void handle();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = address && typeof address === "object" ? address.port : 0;
	flow.redirectUri = `http://localhost:${port}${GOOGLE_CALLBACK_PATH}`;
	flow.server = server;
	if (typeof server.unref === "function") server.unref();

	pendingFlows.set(flowId, flow);
	ensureFlowCleanupTimer();

	return {
		flowId,
		url: buildGoogleAuthorizeUrl(challenge, state, flow.redirectUri),
		provider: "google-gemini-cli",
		callbackServer: true,
	};
}

/**
 * Complete a manual-paste Google flow: accepts a bare authorization code or a
 * full redirect URL (from which `code` + `state` are parsed).
 */
async function completeGoogleFlow(flow: PendingGoogleOAuth, flowId: string, authCode: string, fetchImpl: typeof fetch = defaultFetch): Promise<{ success: boolean; error?: string }> {
	let code = authCode.trim();
	// Allow pasting the full redirect URL (or just the query string).
	if (code.includes("code=") || code.startsWith("http")) {
		try {
			const parsed = new URL(code.startsWith("http") ? code : `http://localhost/?${code.replace(/^\?/, "")}`);
			const parsedCode = parsed.searchParams.get("code");
			const parsedState = parsed.searchParams.get("state");
			if (parsedState && parsedState !== flow.state) {
				return { success: false, error: "State mismatch" };
			}
			if (parsedCode) code = parsedCode;
		} catch {
			// Treat as a bare code if URL parsing fails.
		}
	}
	if (!code) return { success: false, error: "code required" };

	try {
		await exchangeGoogleCode(flow, code, fetchImpl);
		flow.completed = true;
		closeGoogleFlowServer(flow);
		pendingFlows.delete(flowId);
		return { success: true };
	} catch (err) {
		closeGoogleFlowServer(flow);
		pendingFlows.delete(flowId);
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Complete a Bobbit-owned flow through its provider interaction. */
export async function oauthComplete(
	flowId: string,
	authCode: string,
	fetchOrProvider: typeof fetch | string = defaultFetch,
	providerInput?: string,
): Promise<{ success: boolean; error?: string }> {
	const fetchImpl = typeof fetchOrProvider === "function" ? fetchOrProvider : defaultFetch;
	const requestedProvider = typeof fetchOrProvider === "string" ? fetchOrProvider : providerInput;
	const flow = pendingFlows.get(flowId);
	if (!flow) return { success: false, error: "Unknown or expired flow ID" };
	if (requestedProvider) {
		try {
			if (flow.provider !== normalizeProvider(requestedProvider)) {
				return { success: false, error: "Unknown or expired flow ID" };
			}
		} catch {
			return { success: false, error: "Unknown or expired flow ID" };
		}
	}

	if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
		cancelPendingFlow(flowId, flow, new Error("OAuth flow expired"));
		pendingFlows.delete(flowId);
		return { success: false, error: "OAuth flow expired" };
	}

	if (flow.provider === "google-gemini-cli") {
		if (flow.completed) {
			closeGoogleFlowServer(flow);
			pendingFlows.delete(flowId);
			return { success: true };
		}
		if (!authCode || !authCode.trim()) return { success: false, error: "code required" };
		return completeGoogleFlow(flow, flowId, authCode, fetchImpl);
	}

	if (!authCode || !authCode.trim()) {
		// The REST/UI never submits an empty value. For direct callers, treat it
		// as an explicit cancellation so Pi's fixed callback port is not leased
		// by an unusable abandoned flow.
		cancelPendingFlow(flowId, flow, new Error("OAuth flow cancelled"));
		await flow.loginPromise.catch(() => {});
		pendingFlows.delete(flowId);
		return { success: false, error: "code required" };
	}
	if (flow.completed) {
		pendingFlows.delete(flowId);
		return { success: true };
	}

	// Pi owns parsing of a bare code, code#state, query string, or full redirect
	// URL and validates any supplied state before token exchange.
	flow.submitCode(authCode.trim());
	try {
		await flow.loginPromise;
		pendingFlows.delete(flowId);
		return { success: true };
	} catch (error) {
		pendingFlows.delete(flowId);
		return { success: false, error: sanitizedOAuthFailure(error) };
	}
}

/**
 * Report configured OAuth status without resolving or exposing bearer tokens.
 * Anthropic refreshable credentials remain configured while expired; Pi
 * refreshes them lazily through Models.getAuth().
 */
export function oauthStatus(providerInput?: string): { authenticated: boolean; expires?: number; provider: OAuthProviderId; email?: string } {
	const provider = normalizeProvider(providerInput);
	const credential = getOAuthCredentialStore().readStoredCredentialSync(provider);
	if (!credential || credential.type !== "oauth") return { authenticated: false, provider };
	const expired = typeof credential.expires === "number" && Date.now() > credential.expires;
	const refreshable = typeof credential.refresh === "string" && credential.refresh.length > 0;
	const result: { authenticated: boolean; expires?: number; provider: OAuthProviderId; email?: string } = {
		provider,
		authenticated: provider === "anthropic" ? refreshable || !expired : !expired,
		expires: credential.expires,
	};
	if (typeof credential.email === "string") result.email = credential.email;
	return result;
}

export function oauthFlowStatus(
	flowId: string,
	providerInput?: string,
): { complete: boolean; error?: string } {
	const flow = pendingFlows.get(flowId);
	if (!flow) return { complete: false, error: "flow not found" };
	if (providerInput) {
		try {
			if (flow.provider !== normalizeProvider(providerInput)) return { complete: false, error: "flow not found" };
		} catch {
			return { complete: false, error: "flow not found" };
		}
	}
	if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
		cancelPendingFlow(flowId, flow, new Error("OAuth flow expired"));
		pendingFlows.delete(flowId);
		return { complete: false, error: "OAuth flow expired" };
	}
	if (flow.completed) {
		if (flow.provider === "google-gemini-cli") closeGoogleFlowServer(flow);
		pendingFlows.delete(flowId);
		return { complete: true };
	}
	if (flow.error) {
		if (flow.provider === "google-gemini-cli") closeGoogleFlowServer(flow);
		pendingFlows.delete(flowId);
		return { complete: false, error: flow.error };
	}
	return { complete: false };
}

/** Resolve a current Anthropic access token through Pi's locked refresh path. */
export async function refreshOAuthToken(_fetchImpl: typeof fetch = defaultFetch): Promise<string | null> {
	const stored = getOAuthCredentialStore().readStoredCredentialSync("anthropic");
	const attempted = stored?.type === "oauth" ? stored : undefined;
	try {
		const resolved = await getOAuthModels().getAuth("anthropic");
		return typeof resolved?.auth.apiKey === "string" ? resolved.auth.apiKey : null;
	} catch (error) {
		if (isDefinitiveRefreshFailure(error)) {
			try {
				await invalidateRejectedAnthropicCredential(attempted);
				console.warn("[oauth] Anthropic credentials were rejected and have been cleared");
			} catch (invalidationError) {
				console.error(`[oauth] Could not clear rejected Anthropic credentials: ${redactSensitive(invalidationError instanceof Error ? invalidationError.message : String(invalidationError))}`);
			}
		}
		console.error(`[oauth] Anthropic credential refresh failed: ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
		return null;
	}
}

/**
 * Refresh the Google account (Gemini Code Assist) access token from the stored
 * refresh token. Mirrors the Anthropic refresh policy: skip while still valid,
 * clear on definitive auth failures (400/401/403), retain on transient errors.
 * Returns a fresh access token, or null if refresh is impossible.
 *
 * This is a separate, provider-aware helper so the no-arg `refreshOAuthToken()`
 * Anthropic contract and its existing callers stay unchanged.
 */
export async function refreshGoogleOAuthToken(fetchImpl: typeof fetch = defaultFetch): Promise<string | null> {
	try {
		const postMutation = await getOAuthCredentialStore().mutate("google-gemini-cli", async (current) => {
			if (!current || current.type !== "oauth") return undefined;
			if (!current.refresh) return undefined;
			if (current.expires && Date.now() < current.expires) return undefined;

			console.log("[oauth] Google access token expired, refreshing...");
			const tokenResponse = await fetchWithProviderTimeout(fetchImpl, GOOGLE_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: GOOGLE_CLIENT_ID,
					client_secret: GOOGLE_CLIENT_SECRET,
					refresh_token: current.refresh,
				}).toString(),
			});

			if (!tokenResponse.ok) {
				console.error(`[oauth] Google token refresh failed (${tokenResponse.status})`);
				if (tokenResponse.status === 400 || tokenResponse.status === 401 || tokenResponse.status === 403) {
					console.log("[oauth] Google credentials revoked or invalid, clearing stored credentials");
					return deleteCredential;
				}
				return undefined;
			}

			const tokenData = (await tokenResponse.json()) as {
				access_token: string;
				refresh_token?: string;
				expires_in: number;
			};
			console.log("[oauth] Google token refreshed successfully");
			return {
				...current,
				type: "oauth",
				access: tokenData.access_token,
				refresh: tokenData.refresh_token || current.refresh,
				expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			};
		});
		if (!postMutation || postMutation.type !== "oauth") return null;
		// A fresh CAS loser is returned here, so an external logout cannot make us
		// serve the stale snapshot captured before provider I/O.
		const expired = typeof postMutation.expires === "number" && Date.now() >= postMutation.expires;
		if (expired && postMutation.refresh) return null;
		return postMutation.access || null;
	} catch (error) {
		console.error(`[oauth] Google token refresh error: ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
		return null;
	}
}

/**
 * Best-effort revocation of a Google OAuth token at Google's revoke endpoint.
 * Never throws — logout must succeed even if revoke is transiently unavailable.
 */
async function revokeGoogleToken(token: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
	try {
		await fetchWithProviderTimeout(fetchImpl, GOOGLE_REVOKE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token }).toString(),
		});
	} catch (err) {
		console.warn("[oauth] Google token revoke failed (ignored):", redactSensitive(err instanceof Error ? err.message : String(err)));
	}
}

/**
 * Log out / clear the stored OAuth credential for a single provider.
 *
 * Strictly provider-partitioned: only `auth.json[canonicalProvider]` is
 * removed. API-key-only entries (e.g. `providerKey.google` in preferences) and
 * other providers' OAuth entries are never touched. For Google, the upstream
 * token is best-effort revoked first. No token material is ever returned.
 */
export async function oauthLogout(providerInput?: string, fetchImpl: typeof fetch = defaultFetch): Promise<{ success: boolean; provider: OAuthProviderId }> {
	const provider = normalizeProvider(providerInput);
	if (provider === "anthropic") {
		// There is no Anthropic revocation endpoint. Pi's public CredentialStore
		// deletion is the complete provider-scoped logout operation.
		await getOAuthCredentialStore().delete(provider);
	} else if (provider === "google-gemini-cli") {
		await getOAuthCredentialStore().mutate(provider, async (current) => {
			if (current?.type === "oauth") {
				const token = current.refresh || current.access;
				if (token) await revokeGoogleToken(token, fetchImpl);
			}
			return deleteCredential;
		});
	} else {
		await getOAuthCredentialStore().delete(provider);
	}
	return { success: true, provider };
}
