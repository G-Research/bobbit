// Test entry for the provider-neutral OAuth expiry modal.
// Drives gateway authentication through `authenticateGateway()` with a stubbed
// gateway so the fixture exercises the same client path used after connecting.
import { authenticateGateway } from "../../src/app/session-manager.js";
import { setRenderApp } from "../../src/app/state.js";

type OAuthStatus = { authenticated: boolean; expires?: number };
type ProviderId = "anthropic" | "openai-codex" | "google-gemini-cli";

type FetchLogEntry = { url: string; method: string; body: any };

const GATEWAY_URL = "https://oauth-expiry.fixture";
const GATEWAY_TOKEN = "fixture-token";

let statuses: Partial<Record<ProviderId, OAuthStatus>> = {};
const fetchLog: FetchLogEntry[] = [];
let lastAuthResult: { ok: boolean; error?: string } | null = null;

function installGatewayStorage(): void {
	localStorage.setItem("gateway.url", GATEWAY_URL);
	localStorage.setItem("gateway.token", GATEWAY_TOKEN);
}

function normalizeUrl(input: any): string {
	const raw = typeof input === "string" ? input : (input as Request).url;
	try {
		const u = new URL(raw, window.location.href);
		return u.pathname + u.search;
	} catch {
		return raw;
	}
}

function jsonResponse(body: any, init: { ok?: boolean; status?: number } = {}): Response {
	const status = init.status ?? (init.ok === false ? 500 : 200);
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function statusFor(path: string): Response | null {
	if (!path.startsWith("/api/oauth/status")) return null;
	const url = new URL(path, window.location.origin);
	const provider = url.searchParams.get("provider") as ProviderId | null;
	if (!provider) return jsonResponse({ authenticated: false });
	return jsonResponse(statuses[provider] ?? { authenticated: false });
}

window.fetch = (async (input: any, init?: RequestInit) => {
	const path = normalizeUrl(input);
	const method = (init?.method || "GET").toUpperCase();
	let body: any = null;
	if (typeof init?.body === "string") {
		try { body = JSON.parse(init.body); } catch { body = init.body; }
	}
	fetchLog.push({ url: path, method, body });

	if (path === "/api/health") {
		return jsonResponse({ localhost: false, aigw: false, setupComplete: true, orphanedTranscripts: 0 });
	}
	const oauthStatus = statusFor(path);
	if (oauthStatus) return oauthStatus;
	if (path === "/api/oauth/start") {
		// The expiry modal must not launch the legacy OAuth flow automatically.
		return jsonResponse({ error: "legacy OAuth flow should not start for expiry reminders" }, { ok: false, status: 500 });
	}
	if (path.startsWith("/api/sessions")) return jsonResponse({ sessions: [], archivedDelegates: [], generation: 0 });
	if (path.startsWith("/api/goals")) return jsonResponse({ goals: [], generation: 0 });
	if (path === "/api/projects") return jsonResponse([]);
	if (path === "/api/config/cwd") return jsonResponse({ cwd: "" });
	if (path === "/api/pr-status-cache") return jsonResponse({});
	if (path.startsWith("/api/gates/status")) return jsonResponse({});
	if (path.startsWith("/api/search/stats")) return jsonResponse({});
	return jsonResponse({});
}) as any;

(window as any).open = () => null;

setRenderApp(() => {
	// authenticateGateway() renders the shell after successful auth. The fixture
	// only cares about independently mounted dialogs, so keep app rendering inert.
});

async function runGatewayAuth(): Promise<{ ok: boolean; error?: string }> {
	try {
		await authenticateGateway(GATEWAY_URL, GATEWAY_TOKEN);
		lastAuthResult = { ok: true };
	} catch (err) {
		lastAuthResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	return lastAuthResult;
}

(window as any).__setOAuthExpiryStatuses = (next: Partial<Record<ProviderId, OAuthStatus>>) => {
	statuses = { ...next };
};

(window as any).__resetOAuthExpiryFixture = (next: Partial<Record<ProviderId, OAuthStatus>> = {}) => {
	localStorage.clear();
	sessionStorage.clear();
	installGatewayStorage();
	statuses = { ...next };
	fetchLog.length = 0;
	lastAuthResult = null;
	window.location.hash = "";
};

(window as any).__startGatewayAuth = () => {
	void runGatewayAuth();
};

(window as any).__runGatewayAuth = runGatewayAuth;
(window as any).__getOAuthExpiryFetchLog = () => fetchLog.slice();
(window as any).__getLastAuthResult = () => lastAuthResult;

installGatewayStorage();
(window as any).__oauthExpiryFixtureReady = true;
