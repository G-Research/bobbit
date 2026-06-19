/**
 * Unit tests for the provider-partitioned Google account (Gemini Code Assist)
 * OAuth backend added to `src/server/auth/oauth.ts`.
 *
 * Coverage (design §5 unit list):
 *   - `normalizeProvider` aliases: `google` / `gemini` / `google-gemini-cli`
 *     all collapse to the canonical `google-gemini-cli` (observed via the
 *     `provider` field returned by `oauthStatus`); unknown providers reject.
 *   - `oauthStart("google-gemini-cli")` returns a loopback callback flow whose
 *     authorize URL targets accounts.google.com with the three Code Assist
 *     scopes, PKCE S256, `access_type=offline`, `prompt=consent`.
 *   - `oauthStatus` never echoes `access`/`refresh`; surfaces non-secret
 *     `email`; reflects expiry.
 *   - `oauthComplete` manual-paste exchange persists a sanitized
 *     `{type:"oauth",access,refresh,expires,email}` entry (no profile blob),
 *     auth.json is chmod 0600.
 *   - `refreshGoogleOAuthToken`: success persists; 401 clears; 500 retains.
 *   - Provider isolation: a Google flow id polled as `anthropic` → flow not
 *     found; `oauthLogout("google-gemini-cli")` deletes ONLY the Google entry.
 *
 * Outbound HTTP is stubbed via `globalThis.fetch`. The loopback callback
 * server binds a real ephemeral port (no network egress) and is closed when
 * the flow completes/fails.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "bobbit-oauth-google-"));
const agentDir = path.join(tmp, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.BOBBIT_AGENT_DIR = agentDir;
const authPath = path.join(agentDir, "auth.json");

const {
	oauthStart,
	oauthComplete,
	oauthStatus,
	oauthFlowStatus,
	oauthLogout,
	refreshGoogleOAuthToken,
	stopFlowCleanup,
} = await import("../src/server/auth/oauth.js");

const realFetch = globalThis.fetch;

function writeAuth(data: Record<string, unknown>): void {
	writeFileSync(authPath, JSON.stringify(data, null, 2), "utf-8");
}
function readAuth(): Record<string, any> {
	return existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf-8")) : {};
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

after(() => {
	stopFlowCleanup();
});

describe("Google OAuth — provider normalization & status", () => {
	before(() => writeAuth({}));

	it("aliases google / gemini / google-gemini-cli collapse to canonical id", () => {
		for (const alias of ["google", "gemini", "google-gemini-cli"]) {
			const status = oauthStatus(alias);
			assert.equal(status.provider, "google-gemini-cli", `alias ${alias}`);
		}
	});

	it("rejects unknown providers", () => {
		assert.throws(() => oauthStatus("not-a-provider"), /Unsupported OAuth provider/);
	});

	it("oauthStatus never echoes token material and reflects expiry + email", () => {
		writeAuth({
			"google-gemini-cli": {
				type: "oauth",
				access: "ACCESS-SECRET",
				refresh: "REFRESH-SECRET",
				expires: Date.now() + 60_000,
				email: "user@example.com",
			},
		});
		const ok = oauthStatus("google-gemini-cli") as Record<string, unknown>;
		assert.equal(ok.authenticated, true);
		assert.equal(ok.email, "user@example.com");
		assert.equal(ok.access, undefined);
		assert.equal(ok.refresh, undefined);
		assert.ok(!JSON.stringify(ok).includes("SECRET"), "status must not contain token material");

		writeAuth({
			"google-gemini-cli": { type: "oauth", access: "a", refresh: "r", expires: Date.now() - 1000 },
		});
		assert.equal(oauthStatus("google-gemini-cli").authenticated, false, "expired → not authenticated");

		writeAuth({});
		assert.equal(oauthStatus("google-gemini-cli").authenticated, false, "absent → not authenticated");
	});
});

describe("Google OAuth — start flow", () => {
	it("oauthStart builds a loopback authorize URL with scopes + PKCE + offline", async () => {
		const started = await oauthStart("google-gemini-cli");
		assert.ok(started.flowId);
		assert.equal(started.provider, "google-gemini-cli");
		assert.equal(started.callbackServer, true);

		const u = new URL(started.url);
		assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
		assert.equal(u.searchParams.get("response_type"), "code");
		assert.equal(u.searchParams.get("access_type"), "offline");
		assert.equal(u.searchParams.get("prompt"), "consent");
		assert.equal(u.searchParams.get("code_challenge_method"), "S256");
		assert.ok(u.searchParams.get("code_challenge"));
		assert.ok(u.searchParams.get("state"));
		const scope = u.searchParams.get("scope") ?? "";
		assert.ok(scope.includes("https://www.googleapis.com/auth/cloud-platform"));
		assert.ok(scope.includes("https://www.googleapis.com/auth/userinfo.email"));
		assert.ok(scope.includes("https://www.googleapis.com/auth/userinfo.profile"));
		const redirect = u.searchParams.get("redirect_uri") ?? "";
		assert.match(redirect, /^http:\/\/localhost:\d+\/oauth2callback$/);

		// Clean up the loopback server: completing with a stubbed-failing token
		// exchange closes the server and removes the flow.
		globalThis.fetch = (async () =>
			new Response("nope", { status: 400 })) as typeof globalThis.fetch;
		await oauthComplete(started.flowId, "dummy-code");
	});
});

describe("Google OAuth — manual-paste code exchange", () => {
	before(() => writeAuth({}));

	it("persists only sanitized fields and chmods auth.json 0600", async () => {
		const started = await oauthStart("google-gemini-cli");

		const calls: string[] = [];
		globalThis.fetch = (async (input: any) => {
			const urlStr = typeof input === "string" ? input : input.url;
			calls.push(urlStr);
			if (urlStr.startsWith("https://oauth2.googleapis.com/token")) {
				return new Response(
					JSON.stringify({ access_token: "tok-A", refresh_token: "tok-R", expires_in: 3600 }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (urlStr.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
				return new Response(
					JSON.stringify({ email: "me@example.com", name: "Me", picture: "http://x/y.png" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`unexpected fetch: ${urlStr}`);
		}) as typeof globalThis.fetch;

		const res = await oauthComplete(started.flowId, "the-auth-code");
		assert.deepEqual(res, { success: true });

		const entry = readAuth()["google-gemini-cli"];
		assert.equal(entry.type, "oauth");
		assert.equal(entry.access, "tok-A");
		assert.equal(entry.refresh, "tok-R");
		assert.equal(entry.email, "me@example.com");
		assert.ok(typeof entry.expires === "number" && entry.expires > Date.now());
		// No profile blob fields leaked into storage.
		assert.deepEqual(
			Object.keys(entry).sort(),
			["access", "email", "expires", "refresh", "type"],
		);

		if (process.platform !== "win32") {
			assert.equal(statSync(authPath).mode & 0o777, 0o600);
		}
		assert.ok(calls.some((c) => c.startsWith("https://oauth2.googleapis.com/token")));
	});

	it("returns a truncated, redacted error on token-exchange failure", async () => {
		const started = await oauthStart("google-gemini-cli");
		globalThis.fetch = (async () =>
			new Response("x".repeat(1000), { status: 400 })) as typeof globalThis.fetch;
		const res = await oauthComplete(started.flowId, "bad-code");
		assert.equal(res.success, false);
		assert.ok((res.error ?? "").length < 400, "error body must be truncated");
	});
});

describe("Google OAuth — refresh", () => {
	it("refreshGoogleOAuthToken persists rotated token on success", async () => {
		writeAuth({
			"google-gemini-cli": { type: "oauth", access: "old", refresh: "R", expires: Date.now() - 1000, email: "e@x.com" },
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as typeof globalThis.fetch;

		const token = await refreshGoogleOAuthToken();
		assert.equal(token, "new-access");
		const entry = readAuth()["google-gemini-cli"];
		assert.equal(entry.access, "new-access");
		assert.equal(entry.refresh, "R", "non-rotated refresh token preserved");
		assert.equal(entry.email, "e@x.com", "email metadata preserved across refresh");
	});

	it("returns the current token without refreshing when still valid", async () => {
		writeAuth({
			"google-gemini-cli": { type: "oauth", access: "valid", refresh: "R", expires: Date.now() + 60_000 },
		});
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;
		const token = await refreshGoogleOAuthToken();
		assert.equal(token, "valid");
		assert.equal(called, false, "must not hit the token endpoint when valid");
	});

	it("clears stored credentials on a definitive 401", async () => {
		writeAuth({
			anthropic: { type: "oauth", access: "a", refresh: "ar", expires: Date.now() + 1000 },
			"google-gemini-cli": { type: "oauth", access: "g", refresh: "gr", expires: Date.now() - 1000 },
		});
		globalThis.fetch = (async () =>
			new Response("invalid_grant", { status: 401 })) as typeof globalThis.fetch;
		const token = await refreshGoogleOAuthToken();
		assert.equal(token, null);
		const auth = readAuth();
		assert.equal(auth["google-gemini-cli"], undefined, "google entry cleared on 401");
		assert.ok(auth.anthropic, "other providers untouched by google clear");
	});

	it("retains stored credentials on a transient 500", async () => {
		writeAuth({
			"google-gemini-cli": { type: "oauth", access: "g", refresh: "gr", expires: Date.now() - 1000 },
		});
		globalThis.fetch = (async () =>
			new Response("upstream error", { status: 500 })) as typeof globalThis.fetch;
		const token = await refreshGoogleOAuthToken();
		assert.equal(token, null);
		assert.ok(readAuth()["google-gemini-cli"], "google entry retained on transient 5xx");
	});
});

describe("Google OAuth — provider isolation", () => {
	it("a Google flow id polled as anthropic reads as 'flow not found'", async () => {
		const started = await oauthStart("google-gemini-cli");
		const mismatch = oauthFlowStatus(started.flowId, "anthropic");
		assert.deepEqual(mismatch, { complete: false, error: "flow not found" });
		// Matching provider still resolves (proves the 404 was the mismatch branch).
		assert.deepEqual(oauthFlowStatus(started.flowId, "google-gemini-cli"), { complete: false });

		// Clean up the loopback server.
		globalThis.fetch = (async () => new Response("nope", { status: 400 })) as typeof globalThis.fetch;
		await oauthComplete(started.flowId, "x");
	});

	it("oauthLogout('google-gemini-cli') deletes only the Google entry and revokes", async () => {
		writeAuth({
			anthropic: { type: "oauth", access: "a", refresh: "ar", expires: Date.now() + 1000 },
			"openai-codex": { type: "oauth", access: "o", refresh: "or", expires: Date.now() + 1000 },
			google: { type: "api_key", key: "AISTUDIO-KEY" },
			"google-gemini-cli": { type: "oauth", access: "g", refresh: "gr", expires: Date.now() + 1000 },
		});
		let revokeUrl: string | undefined;
		globalThis.fetch = (async (input: any) => {
			revokeUrl = typeof input === "string" ? input : input.url;
			return new Response("", { status: 200 });
		}) as typeof globalThis.fetch;

		const res = await oauthLogout("google");
		assert.deepEqual(res, { success: true, provider: "google-gemini-cli" });
		assert.ok(revokeUrl?.startsWith("https://oauth2.googleapis.com/revoke"), "token revoked upstream");

		const auth = readAuth();
		assert.equal(auth["google-gemini-cli"], undefined, "google account entry deleted");
		assert.ok(auth.anthropic, "anthropic untouched");
		assert.ok(auth["openai-codex"], "openai-codex untouched");
		assert.deepEqual(auth.google, { type: "api_key", key: "AISTUDIO-KEY" }, "API-key google entry untouched");
	});
});
