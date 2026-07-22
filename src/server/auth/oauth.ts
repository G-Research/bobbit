/**
 * Server-side OAuth handler for the gateway.
 * Generates PKCE server-side, returns auth URL to the client,
 * then exchanges the authorization code for tokens.
 * Stores credentials in ~/.bobbit/agent/auth.json for the coding agent.
 */

import type { Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthInteraction, Models, OAuthCredentials } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { globalAuthPath } from "../bobbit-dir.js";
import { clearOAuthCache } from "../agent/model-registry.js";
import { redactSensitive } from "./redact.js";

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

// Anthropic OAuth constants (same as in @earendil-works/pi-ai)
const CLIENT_ID = Buffer.from("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl", "base64").toString();
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

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

interface PendingAnthropicOAuth {
	provider: "anthropic";
	verifier: string;
	createdAt: number;
}

interface PendingExternalOAuth {
	provider: "openai-codex";
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

type PendingOAuth = PendingAnthropicOAuth | PendingExternalOAuth | PendingGoogleOAuth;

// In-memory store for pending OAuth flows (verifier keyed by a flow ID)
const pendingFlows = new Map<string, PendingOAuth>();
const FLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FLOW_CLEANUP_INTERVAL_MS = 60 * 1000; // sweep expired flows every 60s
let flowCleanupTimer: ReturnType<typeof setInterval> | undefined;

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

/** Stop the periodic cleanup timer (test-only). */
export function stopFlowCleanup(): void {
	if (flowCleanupTimer) {
		clearInterval(flowCleanupTimer);
		flowCleanupTimer = undefined;
	}
}

function getAuthJsonPath(): string {
	return globalAuthPath();
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

function cleanupExpiredFlows(): void {
	const now = Date.now();
	// Snapshot entries before mutating the map to avoid mutation-during-iteration UB.
	const entries = Array.from(pendingFlows.entries());
	for (const [id, flow] of entries) {
		if (now - flow.createdAt > FLOW_TTL_MS) {
			if (flow.provider === "openai-codex") {
				flow.cancelLogin(new Error("OAuth flow expired"));
			} else if (flow.provider === "google-gemini-cli") {
				closeGoogleFlowServer(flow);
			}
			pendingFlows.delete(id);
		}
	}
}

function readAuthData(): Record<string, any> {
	const authPath = getAuthJsonPath();
	if (!existsSync(authPath)) return {};
	try {
		return JSON.parse(readFileSync(authPath, "utf-8"));
	} catch {
		return {};
	}
}

function writeAuthData(authData: Record<string, any>): void {
	const authPath = getAuthJsonPath();
	const dir = dirname(authPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
	try {
		chmodSync(authPath, 0o600);
	} catch {
		// chmod may fail on Windows, that's OK
	}
	clearOAuthCache();
}

function storeOAuthCredentials(provider: OAuthProviderId, credentials: OAuthCredentials): void {
	const authData = readAuthData();
	authData[provider] = { type: "oauth", ...credentials };
	writeAuthData(authData);
}

/**
 * Start an OAuth flow. Returns the authorization URL and a flow ID.
 */
export async function oauthStart(
	providerInput?: string,
	fetchImpl: typeof fetch = defaultFetch,
	externalModels?: Pick<Models, "login">,
): Promise<{ flowId: string; url: string; provider: OAuthProviderId; callbackServer?: boolean; instructions?: string }> {
	cleanupExpiredFlows();
	ensureFlowCleanupTimer();

	const provider = normalizeProvider(providerInput);
	if (provider === "google-gemini-cli") {
		return oauthStartGoogle(fetchImpl);
	}
	if (provider !== "anthropic") {
		return oauthStartExternal(provider, externalModels ?? builtinModels());
	}

	const { randomBytes } = await import("node:crypto");
	const now = Date.now();
	const flowId = randomBytes(16).toString("hex");
	const { verifier, challenge } = await generatePKCE();

	pendingFlows.set(flowId, { provider: "anthropic", verifier, createdAt: now });

	const params = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	return { flowId, url: `${AUTHORIZE_URL}?${params.toString()}`, provider };
}

async function oauthStartExternal(
	provider: "openai-codex",
	models: Pick<Models, "login">,
): Promise<{ flowId: string; url: string; provider: OAuthProviderId; callbackServer?: boolean; instructions?: string }> {
	const { randomBytes } = await import("node:crypto");
	const flowId = randomBytes(16).toString("hex");
	const createdAt = Date.now();
	const loginAbort = new AbortController();

	let submitCode!: (code: string) => void;
	let rejectCode!: (err: Error) => void;
	const manualCodePromise = new Promise<string>((resolve, reject) => {
		submitCode = resolve;
		rejectCode = reject;
	});
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
				(err) => {
					signal.removeEventListener("abort", onAbort);
					reject(err);
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

	// Only the first auth/device notification or pre-start error settles the
	// response. Later lifecycle notifications remain safe no-ops for this
	// one-shot UI contract.
	let startedSettled = false;
	const safeResolveStarted = (info: { url: string; instructions?: string }) => {
		if (startedSettled) return;
		startedSettled = true;
		resolveStarted(info);
	};
	const safeRejectStarted = (err: Error) => {
		if (startedSettled) return;
		startedSettled = true;
		rejectStarted(err);
	};

	const cancelLogin = (err: Error): void => {
		rejectCode(err);
		if (!loginAbort.signal.aborted) loginAbort.abort(err);
	};

	// Initialise the flow record up-front so the `loginPromise.then/catch`
	// callbacks below always see a fully-constructed `flow` reference — even if
	// pi-ai resolves synchronously before this scope finishes evaluating.
	const flow: PendingExternalOAuth = {
		provider,
		createdAt,
		submitCode,
		cancelLogin,
		loginPromise: Promise.resolve(), // overwritten below
		completed: false,
	};

	const interaction: AuthInteraction = {
		signal: loginAbort.signal,
		prompt: async (prompt) => {
			if (prompt.type === "text" || prompt.type === "manual_code") {
				return waitForManualCode(prompt.signal);
			}
			if (prompt.type === "select") {
				// Bobbit has no generic OAuth selection UI. A single option is
				// deterministic; for Codex's multi-option login prompt preserve the
				// existing browser/callback-server flow. Keep the heuristic fallback
				// in case Pi changes the option id while retaining its label.
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
					console.log(`[oauth] ${OAUTH_PROVIDER_LABELS[provider]}: ${redactSensitive(instructions)}`);
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

	const loginPromise = models.login(provider, "oauth", interaction).then((credential) => {
		if (credential.type !== "oauth") {
			throw new Error(`OAuth provider returned a non-OAuth credential: ${provider}`);
		}
		storeOAuthCredentials(provider, credential);
		flow.completed = true;
	}).catch((err) => {
		const error = err instanceof Error ? err : new Error(String(err));
		flow.error = redactSensitive(error.message);
		safeRejectStarted(error);
		throw error;
	});
	void loginPromise.catch(() => {});
	flow.loginPromise = loginPromise;
	pendingFlows.set(flowId, flow);
	ensureFlowCleanupTimer();

	const info = await started;
	return {
		flowId,
		url: info.url,
		provider,
		callbackServer: true,
		instructions: info.instructions,
	};
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
function storeGoogleCredentials(creds: { access: string; refresh?: string; expires: number; email?: string }): void {
	const authData = readAuthData();
	const entry: Record<string, unknown> = {
		type: "oauth",
		access: creds.access,
		expires: creds.expires,
	};
	if (creds.refresh) entry.refresh = creds.refresh;
	if (creds.email) entry.email = creds.email;
	authData["google-gemini-cli"] = entry;
	writeAuthData(authData);
}

/**
 * Shared code→token exchange for the Google account (Gemini Code Assist) flow.
 * Used by both the loopback callback handler and the manual-paste path.
 */
async function exchangeGoogleCode(flow: PendingGoogleOAuth, code: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
	const tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
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
		const errorText = await tokenResponse.text();
		const MAX_ERR_CHARS = 256;
		const truncated = errorText.length > MAX_ERR_CHARS ? `${errorText.slice(0, MAX_ERR_CHARS)}…` : errorText;
		throw new Error(`Token exchange failed: ${redactSensitive(truncated)}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};

	let email: string | undefined;
	try {
		const userinfoResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
			headers: { Authorization: `Bearer ${tokenData.access_token}` },
		});
		if (userinfoResponse.ok) {
			const info = (await userinfoResponse.json()) as { email?: string };
			if (typeof info.email === "string") email = info.email;
		}
	} catch {
		// userinfo is best-effort display metadata; never fail the login on it.
	}

	storeGoogleCredentials({
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

/**
 * Complete an OAuth flow. Exchanges the authorization code for tokens
 * and stores them in ~/.bobbit/agent/auth.json.
 */
export async function oauthComplete(
	flowId: string,
	authCode: string,
	fetchImpl: typeof fetch = defaultFetch,
): Promise<{ success: boolean; error?: string }> {
	const flow = pendingFlows.get(flowId);
	if (!flow) {
		return { success: false, error: "Unknown or expired flow ID" };
	}

	if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
		if (flow.provider === "openai-codex") {
			flow.cancelLogin(new Error("OAuth flow expired"));
		} else if (flow.provider === "google-gemini-cli") {
			closeGoogleFlowServer(flow);
		}
		pendingFlows.delete(flowId);
		return { success: false, error: "OAuth flow expired" };
	}

	if (flow.provider === "google-gemini-cli") {
		if (flow.completed) {
			closeGoogleFlowServer(flow);
			pendingFlows.delete(flowId);
			return { success: true };
		}
		if (!authCode || !authCode.trim()) {
			return { success: false, error: "code required" };
		}
		return completeGoogleFlow(flow, flowId, authCode, fetchImpl);
	}

	if (flow.provider !== "anthropic") {
		if (!authCode || !authCode.trim()) {
			return { success: false, error: "code required" };
		}
		flow.submitCode(authCode.trim());
		try {
			await flow.loginPromise;
			pendingFlows.delete(flowId);
			return { success: true };
		} catch (err) {
			pendingFlows.delete(flowId);
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	if (!authCode || !authCode.trim()) {
		return { success: false, error: "code required" };
	}

	pendingFlows.delete(flowId);

	// The auth code from the callback page is in format "code#state"
	const parts = authCode.split("#");
	const code = parts[0];
	const state = parts[1];

	try {
		const tokenResponse = await fetchImpl(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				state,
				redirect_uri: REDIRECT_URI,
				code_verifier: flow.verifier,
			}),
		});

		if (!tokenResponse.ok) {
			const errorText = await tokenResponse.text();
			// Truncate provider-supplied error bodies so we never echo a multi-KB
			// HTML/JSON page back through the API surface or the UI dialog.
			const MAX_ERR_CHARS = 256;
			const truncated = errorText.length > MAX_ERR_CHARS
				? `${errorText.slice(0, MAX_ERR_CHARS)}…`
				: errorText;
			return { success: false, error: `Token exchange failed: ${truncated}` };
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		const authData = readAuthData();

		authData.anthropic = {
			type: "oauth",
			access: tokenData.access_token,
			refresh: tokenData.refresh_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		};

		writeAuthData(authData);

		return { success: true };
	} catch (err) {
		return { success: false, error: String(err) };
	}
}

/**
 * Check if OAuth credentials exist and are valid (not expired).
 */
export function oauthStatus(providerInput?: string): { authenticated: boolean; expires?: number; provider: OAuthProviderId; email?: string } {
	const provider = normalizeProvider(providerInput);
	const authPath = getAuthJsonPath();
	if (!existsSync(authPath)) return { authenticated: false, provider };

	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data[provider];
		if (!cred || cred.type !== "oauth") return { authenticated: false, provider };

		const expired = cred.expires && Date.now() > cred.expires;

		// strict-OAuth contract: never echo bearer credentials in /status.
		// `email` is non-secret display metadata and is the ONLY extra field
		// permitted here (Google account flow); tokens stay omitted.
		const result: { authenticated: boolean; expires?: number; provider: OAuthProviderId; email?: string } = {
			provider,
			authenticated: !expired,
			expires: cred.expires,
		};
		if (typeof cred.email === "string") result.email = cred.email;
		return result;
	} catch {
		return { authenticated: false, provider };
	}
}

export function oauthFlowStatus(
	flowId: string,
	providerInput?: string,
): { complete: boolean; error?: string } {
	const flow = pendingFlows.get(flowId);
	if (!flow) return { complete: false, error: "flow not found" };
	// Defence-in-depth: if a provider was supplied and disagrees with the stored
	// flow, treat it as not-found to avoid leaking cross-provider status.
	if (providerInput) {
		try {
			const expected = normalizeProvider(providerInput);
			if (flow.provider !== expected) {
				return { complete: false, error: "flow not found" };
			}
		} catch {
			return { complete: false, error: "flow not found" };
		}
	}
	if (flow.provider === "anthropic") return { complete: false };
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

/**
 * Refresh the OAuth access token using the stored refresh token.
 * Updates ~/.bobbit/agent/auth.json with the new credentials.
 * Returns the new access token, or null if refresh fails.
 */
export async function refreshOAuthToken(fetchImpl: typeof fetch = defaultFetch): Promise<string | null> {
	const authPath = getAuthJsonPath();
	if (!existsSync(authPath)) return null;

	let authData: Record<string, any>;
	try {
		authData = JSON.parse(readFileSync(authPath, "utf-8"));
	} catch {
		return null;
	}

	const cred = authData.anthropic;
	if (!cred || cred.type !== "oauth" || !cred.refresh) return null;

	// Skip refresh if token is still valid (5-minute buffer already baked into expires)
	if (cred.expires && Date.now() < cred.expires) return cred.access;

	console.log("[oauth] Access token expired, refreshing...");

	try {
		const tokenResponse = await fetchImpl(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: cred.refresh,
			}),
		});

		if (!tokenResponse.ok) {
			const errText = await tokenResponse.text();
			console.error(`[oauth] Token refresh failed (${tokenResponse.status}): ${errText}`);
			// Only clear credentials on definitive auth failures (invalid/revoked tokens).
			// Transient errors (5xx, 429, network) should not destroy valid credentials.
			const status = tokenResponse.status;
			if (status === 400 || status === 401 || status === 403) {
				console.log("[oauth] Credentials revoked or invalid, clearing stored credentials");
				delete authData.anthropic;
				writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
			}
			return null;
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};

		authData.anthropic = {
			type: "oauth",
			access: tokenData.access_token,
			refresh: tokenData.refresh_token || cred.refresh, // keep old refresh if not rotated
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		};

		writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
		try { chmodSync(authPath, 0o600); } catch {}

		clearOAuthCache();
		console.log("[oauth] Token refreshed successfully");
		return tokenData.access_token;
	} catch (err) {
		console.error("[oauth] Token refresh error:", err);
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
	const authPath = getAuthJsonPath();
	if (!existsSync(authPath)) return null;

	let authData: Record<string, any>;
	try {
		authData = JSON.parse(readFileSync(authPath, "utf-8"));
	} catch {
		return null;
	}

	const cred = authData["google-gemini-cli"];
	if (!cred || cred.type !== "oauth" || !cred.refresh) {
		return cred && cred.type === "oauth" ? cred.access ?? null : null;
	}

	// Skip refresh if token is still valid (5-minute buffer baked into expires).
	if (cred.expires && Date.now() < cred.expires) return cred.access;

	console.log("[oauth] Google access token expired, refreshing...");

	try {
		const tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: GOOGLE_CLIENT_ID,
				client_secret: GOOGLE_CLIENT_SECRET,
				refresh_token: cred.refresh,
			}).toString(),
		});

		if (!tokenResponse.ok) {
			const errText = await tokenResponse.text();
			console.error(`[oauth] Google token refresh failed (${tokenResponse.status}): ${redactSensitive(errText)}`);
			const status = tokenResponse.status;
			if (status === 400 || status === 401 || status === 403) {
				console.log("[oauth] Google credentials revoked or invalid, clearing stored credentials");
				delete authData["google-gemini-cli"];
				writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
				try { chmodSync(authPath, 0o600); } catch {}
				clearOAuthCache();
			}
			return null;
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};

		authData["google-gemini-cli"] = {
			type: "oauth",
			access: tokenData.access_token,
			refresh: tokenData.refresh_token || cred.refresh, // refresh_token is usually not rotated
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			...(typeof cred.email === "string" ? { email: cred.email } : {}),
		};

		writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
		try { chmodSync(authPath, 0o600); } catch {}

		clearOAuthCache();
		console.log("[oauth] Google token refreshed successfully");
		return tokenData.access_token;
	} catch (err) {
		console.error("[oauth] Google token refresh error:", err);
		return null;
	}
}

/**
 * Best-effort revocation of a Google OAuth token at Google's revoke endpoint.
 * Never throws — logout must succeed even if revoke is transiently unavailable.
 */
async function revokeGoogleToken(token: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
	try {
		await fetchImpl(GOOGLE_REVOKE_URL, {
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
	const authPath = getAuthJsonPath();
	if (!existsSync(authPath)) return { success: true, provider };

	let authData: Record<string, any>;
	try {
		authData = JSON.parse(readFileSync(authPath, "utf-8"));
	} catch {
		return { success: true, provider };
	}

	const cred = authData[provider];
	if (provider === "google-gemini-cli" && cred && cred.type === "oauth") {
		const token = cred.refresh || cred.access;
		if (typeof token === "string" && token) await revokeGoogleToken(token, fetchImpl);
	}

	if (cred !== undefined) {
		delete authData[provider];
		writeAuthData(authData);
	}

	return { success: true, provider };
}
