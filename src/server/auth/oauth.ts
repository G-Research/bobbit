/**
 * Server-side OAuth handler for the gateway.
 * Generates PKCE server-side, returns auth URL to the client,
 * then exchanges the authorization code for tokens.
 * Stores credentials in ~/.bobbit/agent/auth.json for the coding agent.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getOAuthProvider, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { globalAuthPath } from "../bobbit-dir.js";
import { clearOAuthCache } from "../agent/model-registry.js";

// Anthropic OAuth constants (same as in @earendil-works/pi-ai)
const CLIENT_ID = Buffer.from("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl", "base64").toString();
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

export type OAuthProviderId = "anthropic" | "openai-codex";

const OAUTH_PROVIDER_LABELS: Record<OAuthProviderId, string> = {
	anthropic: "Anthropic",
	"openai-codex": "OpenAI",
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
	rejectCode: (err: Error) => void;
	loginPromise: Promise<void>;
	completed: boolean;
	error?: string;
}

type PendingOAuth = PendingAnthropicOAuth | PendingExternalOAuth;

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

/**
 * Mask anything that looks like a JWT (three dot-separated base64url segments)
 * or a long bearer-shaped token in a free-form log/error string. Best-effort:
 * we redact aggressively rather than risk leaking access tokens via stderr.
 */
function redactSensitive(s: string): string {
	if (typeof s !== "string" || !s) return s;
	let out = s;
	// JWT-ish: aaa.bbb.ccc with base64url segments.
	out = out.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-jwt>");
	// Long bearer-shaped tokens (32+ url-safe chars).
	out = out.replace(/[A-Za-z0-9_-]{32,}/g, "<redacted-token>");
	return out;
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
	throw new Error(`Unsupported OAuth provider: ${provider}`);
}

function cleanupExpiredFlows(): void {
	const now = Date.now();
	// Snapshot entries before mutating the map to avoid mutation-during-iteration UB.
	const entries = Array.from(pendingFlows.entries());
	for (const [id, flow] of entries) {
		if (now - flow.createdAt > FLOW_TTL_MS) {
			if (flow.provider !== "anthropic") {
				flow.rejectCode(new Error("OAuth flow expired"));
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
export async function oauthStart(providerInput?: string): Promise<{ flowId: string; url: string; provider: OAuthProviderId; callbackServer?: boolean; instructions?: string }> {
	cleanupExpiredFlows();
	ensureFlowCleanupTimer();

	const provider = normalizeProvider(providerInput);
	if (provider !== "anthropic") {
		return oauthStartExternal(provider);
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

async function oauthStartExternal(provider: Exclude<OAuthProviderId, "anthropic">): Promise<{ flowId: string; url: string; provider: OAuthProviderId; callbackServer?: boolean; instructions?: string }> {
	const oauthProvider = getOAuthProvider(provider);
	if (!oauthProvider) throw new Error(`OAuth provider unavailable: ${provider}`);
	await Promise.all([import("node:crypto"), import("node:http")]);

	const { randomBytes } = await import("node:crypto");
	const flowId = randomBytes(16).toString("hex");
	const createdAt = Date.now();

	let submitCode!: (code: string) => void;
	let rejectCode!: (err: Error) => void;
	const manualCodePromise = new Promise<string>((resolve, reject) => {
		submitCode = resolve;
		rejectCode = reject;
	});

	let resolveStarted!: (info: { url: string; instructions?: string }) => void;
	let rejectStarted!: (err: Error) => void;
	const started = new Promise<{ url: string; instructions?: string }>((resolve, reject) => {
		resolveStarted = resolve;
		rejectStarted = reject;
	});

	// `started` can only resolve once. Wrap so that whichever of `onAuth` /
	// `onDeviceCode` fires first wins; subsequent calls are logged only. This
	// matches the documented contract that Bobbit surfaces the *initial*
	// browser URL or device-code prompt to the UI dialog, and avoids the
	// unhandled-rejection / silent-drop hazard that comes from calling a
	// settled resolver again.
	let startedResolved = false;
	const safeResolveStarted = (info: { url: string; instructions?: string }) => {
		if (startedResolved) return;
		startedResolved = true;
		resolveStarted(info);
	};

	// Initialise the flow record up-front so the `loginPromise.then/catch`
	// callbacks below always see a fully-constructed `flow` reference — even if
	// pi-ai resolves synchronously before this scope finishes evaluating.
	const flow: PendingExternalOAuth = {
		provider,
		createdAt,
		submitCode,
		rejectCode,
		loginPromise: Promise.resolve(), // overwritten below
		completed: false,
	};

	// Construct the real loginPromise; the .then/.catch callbacks reference
	// `flow` (already in scope above) without TDZ risk.
	const loginPromise = oauthProvider.login({
		onAuth: (info) => safeResolveStarted(info),
		onDeviceCode: (info) => {
			// Device Authorization Grant: surface user-code + verification URI
			// both to the server log AND through the started promise so the UI
			// dialog can display them. Bobbit does not currently render a
			// dedicated device-code dialog, so we reuse the existing
			// { url, instructions } shape by pointing url at the verification
			// URI and packing the user code into instructions.
			const instructions = `Visit ${info.verificationUri} and enter code ${info.userCode}`;
			console.log(`[oauth] ${OAUTH_PROVIDER_LABELS[provider]}: ${redactSensitive(instructions)}`);
			safeResolveStarted({ url: info.verificationUri, instructions });
		},
		onPrompt: async () => manualCodePromise,
		onManualCodeInput: async () => manualCodePromise,
		onSelect: async (prompt) => {
			// Bobbit has no generic OAuth selection UI today. If the provider
			// presents a single option, auto-pick it deterministically (this is
			// safe — there is nothing for the user to choose). Otherwise fail
			// loudly so the flow surfaces a clear error rather than hanging
			// indefinitely waiting for a UI that does not exist.
			if (prompt.options.length === 1) return prompt.options[0].id;
			const available = prompt.options.map((o) => o.label).join(", ");
			throw new Error(
				`OAuth provider requested a selection Bobbit does not support yet (\"${prompt.message}\"; options: ${available || "none"})`,
			);
		},
		onProgress: (message) => console.log(`[oauth] ${OAUTH_PROVIDER_LABELS[provider]}: ${redactSensitive(message)}`),
	}).then((credentials) => {
		storeOAuthCredentials(provider, credentials);
		flow.completed = true;
	}).catch((err) => {
		const raw = err instanceof Error ? err.message : String(err);
		flow.error = redactSensitive(raw);
		rejectStarted(err instanceof Error ? err : new Error(String(err)));
		throw err;
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
		callbackServer: !!oauthProvider.usesCallbackServer,
		instructions: info.instructions,
	};
}

/**
 * Complete an OAuth flow. Exchanges the authorization code for tokens
 * and stores them in ~/.bobbit/agent/auth.json.
 */
export async function oauthComplete(
	flowId: string,
	authCode: string,
): Promise<{ success: boolean; error?: string }> {
	const flow = pendingFlows.get(flowId);
	if (!flow) {
		return { success: false, error: "Unknown or expired flow ID" };
	}

	if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
		if (flow.provider !== "anthropic") {
			flow.rejectCode(new Error("OAuth flow expired"));
		}
		pendingFlows.delete(flowId);
		return { success: false, error: "OAuth flow expired" };
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
		const tokenResponse = await fetch(TOKEN_URL, {
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
export function oauthStatus(providerInput?: string): { authenticated: boolean; expires?: number; provider: OAuthProviderId } {
	const provider = normalizeProvider(providerInput);
	const authPath = getAuthJsonPath();
	if (!existsSync(authPath)) return { authenticated: false, provider };

	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data[provider];
		if (!cred || cred.type !== "oauth") return { authenticated: false, provider };

		const expired = cred.expires && Date.now() > cred.expires;

		// strict-OAuth contract: never echo bearer credentials in /status
		return {
			provider,
			authenticated: !expired,
			expires: cred.expires,
		};
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
		pendingFlows.delete(flowId);
		return { complete: true };
	}
	if (flow.error) {
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
export async function refreshOAuthToken(): Promise<string | null> {
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
		const tokenResponse = await fetch(TOKEN_URL, {
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
