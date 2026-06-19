/**
 * API E2E for the Google account OAuth surface added to `src/server/server.ts`
 * + `src/server/auth/oauth.ts`:
 *
 *  - POST /api/oauth/start {provider:"google-gemini-cli"} returns a loopback
 *    flow whose authorize URL targets accounts.google.com with the Code Assist
 *    scopes + PKCE + access_type=offline.
 *  - POST /api/oauth/logout is provider-partitioned: logging out the Google
 *    account ("google" alias → canonical "google-gemini-cli") deletes ONLY
 *    that auth.json entry and leaves anthropic / openai-codex / API-key-only
 *    `google` credentials untouched. The response never echoes token material.
 *  - Unknown providers → 400.
 *
 * Like oauth-flow-status.spec.ts, this imports from dist/ so the spec and the
 * in-process gateway share the same module instance and auth.json path.
 *
 * To keep the test fully offline, the stored Google account entry carries no
 * access/refresh token, so logout's best-effort upstream revoke is skipped
 * (the mocked-fetch revoke path is covered by tests/oauth-google.test.ts).
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
// dist/ import: shared module instance + auth.json path with the gateway.
import { globalAuthPath } from "../../dist/server/bobbit-dir.js";

const headers = () => ({
	Authorization: `Bearer ${readE2EToken()}`,
	"Content-Type": "application/json",
});

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${base()}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers as Record<string, string> || {}) } });
}

function readAuth(): Record<string, any> {
	const p = globalAuthPath();
	return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
}

test.describe("/api/oauth Google account", () => {
	test("POST /api/oauth/start (google-gemini-cli) returns a Google authorize URL", async () => {
		const resp = await api("/api/oauth/start", {
			method: "POST",
			body: JSON.stringify({ provider: "google-gemini-cli" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.provider).toBe("google-gemini-cli");
		expect(body.callbackServer).toBe(true);
		expect(typeof body.flowId).toBe("string");

		const u = new URL(body.url);
		expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(u.searchParams.get("access_type")).toBe("offline");
		expect(u.searchParams.get("code_challenge_method")).toBe("S256");
		expect(u.searchParams.get("scope") ?? "").toContain("auth/cloud-platform");
	});

	test("POST /api/oauth/logout is provider-partitioned and echoes no tokens", async () => {
		// Seed every provider slot. The Google account entry is intentionally
		// tokenless so logout's upstream revoke is skipped (offline test).
		writeFileSync(
			globalAuthPath(),
			JSON.stringify(
				{
					anthropic: { type: "oauth", access: "A-tok", refresh: "A-ref", expires: Date.now() + 60000 },
					"openai-codex": { type: "oauth", access: "O-tok", refresh: "O-ref", expires: Date.now() + 60000 },
					google: { type: "api_key", key: "AISTUDIO-KEY" },
					"google-gemini-cli": { type: "oauth", expires: Date.now() + 60000, email: "me@example.com" },
				},
				null,
				2,
			),
			"utf-8",
		);

		// Use the "google" alias to prove it collapses to the canonical id.
		const resp = await api("/api/oauth/logout", {
			method: "POST",
			body: JSON.stringify({ provider: "google" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body).toEqual({ success: true, provider: "google-gemini-cli" });
		// No token material echoed.
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("tok");
		expect(serialized).not.toContain("ref");
		expect(serialized).not.toContain("AISTUDIO-KEY");

		const auth = readAuth();
		expect(auth["google-gemini-cli"]).toBeUndefined();
		expect(auth.anthropic).toBeTruthy();
		expect(auth["openai-codex"]).toBeTruthy();
		expect(auth.google).toEqual({ type: "api_key", key: "AISTUDIO-KEY" });

		// Status confirms the Google account is logged out, others unaffected.
		const gStatus = await (await api("/api/oauth/status?provider=google-gemini-cli")).json();
		expect(gStatus.authenticated).toBe(false);
		const aStatus = await (await api("/api/oauth/status?provider=anthropic")).json();
		expect(aStatus.authenticated).toBe(true);
	});

	test("POST /api/oauth/logout with an unknown provider → 400", async () => {
		const resp = await api("/api/oauth/logout", {
			method: "POST",
			body: JSON.stringify({ provider: "not-a-provider" }),
		});
		expect(resp.status).toBe(400);
	});
});
