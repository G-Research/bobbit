/**
 * Server-side OAuth handler for the gateway.
 * Generates PKCE server-side, returns auth URL to the client,
 * then exchanges the authorization code for tokens.
 * Stores credentials in ~/.bobbit/agent/auth.json for the coding agent.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getOAuthProvider, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { globalAuthPath } from "../bobbit-dir.js";
import { clearOAuthCache } from "../agent/model-registry.js";

// Anthropic OAuth constants (same as in @mariozechner/pi-ai)
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
	for (const [id, flow] of pendingFlows) {
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

	const flow: PendingExternalOAuth = {
		provider,
		createdAt,
		submitCode,
		rejectCode,
		loginPromise: Promise.resolve(),
		completed: false,
	};
	pendingFlows.set(flowId, flow);

	flow.loginPromise = oauthProvider.login({
		onAuth: (info) => resolveStarted(info),
		onPrompt: async () => manualCodePromise,
		onManualCodeInput: async () => manualCodePromise,
		onProgress: (message) => console.log(`[oauth] ${OAUTH_PROVIDER_LABELS[provider]}: ${message}`),
	}).then((credentials) => {
		storeOAuthCredentials(provider, credentials);
		flow.completed = true;
	}).catch((err) => {
		flow.error = err instanceof Error ? err.message : String(err);
		rejectStarted(err instanceof Error ? err : new Error(String(err)));
		throw err;
	});
	void flow.loginPromise.catch(() => {});

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
		if (authCode.trim()) flow.submitCode(authCode.trim());
		try {
			await flow.loginPromise;
			pendingFlows.delete(flowId);
			return { success: true };
		} catch (err) {
			pendingFlows.delete(flowId);
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
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
			return { success: false, error: `Token exchange failed: ${errorText}` };
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

		return {
			provider,
			authenticated: !expired,
			expires: cred.expires,
		};
	} catch {
		return { authenticated: false, provider };
	}
}

export function oauthFlowStatus(flowId: string): { complete: boolean; error?: string } {
	const flow = pendingFlows.get(flowId);
	if (!flow) return { complete: false, error: "Unknown or expired flow ID" };
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
