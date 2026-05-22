/**
 * Unit test for `oauthComplete` in `src/server/auth/oauth.ts`.
 *
 * Contract:
 *   - Empty `authCode`              → { success: false, error: "code required", provider: "anthropic" }.
 *   - Whitespace-only `authCode`    → { success: false, error: "code required", provider: "anthropic" }.
 *   - Unknown `flowId`              → { success: false, error: "Unknown or expired flow ID" }.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "bobbit-oauth-empty-"));
mkdirSync(path.join(tmp, "agent"), { recursive: true });
process.env.BOBBIT_AGENT_DIR = path.join(tmp, "agent");

const { oauthComplete, oauthStart } = await import("../src/server/auth/oauth.js");

async function completeAnthropicAndCaptureTokenBody(authCode: string): Promise<Record<string, any>> {
	const previousFetch = globalThis.fetch;
	let capturedBody: Record<string, any> | undefined;
	globalThis.fetch = (async (url: any, init?: any) => {
		assert.equal(String(url), "https://console.anthropic.com/v1/oauth/token");
		capturedBody = JSON.parse(String(init?.body || "{}"));
		return new Response(JSON.stringify({
			access_token: "anthropic-access-token-test",
			refresh_token: "anthropic-refresh-token-test",
			expires_in: 3600,
		}), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	try {
		const start = await oauthStart("anthropic");
		const res = await oauthComplete(start.flowId, authCode);
		assert.deepEqual(res, { success: true, provider: "anthropic" });
		assert.ok(capturedBody, "token exchange body should be captured");
		return capturedBody;
	} finally {
		globalThis.fetch = previousFetch;
	}
}

describe("oauthComplete — input validation", () => {
	it("unknown flowId → 'Unknown or expired flow ID'", async () => {
		const res = await oauthComplete("flow-does-not-exist", "anything");
		assert.deepEqual(res, { success: false, error: "Unknown or expired flow ID" });
	});

	// The empty-code branch lives downstream of the flow lookup. We can't
	// register a real flow without an upstream provider, but the flow lookup
	// fails first for unknown ids. We therefore monkey-patch `pendingFlows`
	// indirectly by starting an Anthropic flow (no network for the start
	// path — only PKCE crypto), then attempting to complete it with empty/
	// whitespace codes. The Anthropic branch ALSO enforces "code required"
	// on empty/whitespace, mirroring the external-provider branch.
	it("empty authCode for a real flow → 'code required'", async () => {
		const { oauthStart } = await import("../src/server/auth/oauth.js");
		const start = await oauthStart("anthropic");
		assert.ok(start.flowId, "flow id should be returned");

		const res1 = await oauthComplete(start.flowId, "");
		assert.deepEqual(res1, { success: false, error: "code required", provider: "anthropic" });
	});

	it("whitespace-only authCode for a real flow → 'code required'", async () => {
		const start = await oauthStart("anthropic");
		const res = await oauthComplete(start.flowId, "   \t\n  ");
		assert.deepEqual(res, { success: false, error: "code required", provider: "anthropic" });
	});

	it("Anthropic manual fallback preserves raw code#state input", async () => {
		const body = await completeAnthropicAndCaptureTokenBody("raw-code#raw-state");
		assert.equal(body.code, "raw-code");
		assert.equal(body.state, "raw-state");
		assert.equal(body.redirect_uri, "https://console.anthropic.com/oauth/code/callback");
		assert.equal(typeof body.code_verifier, "string");
		assert.ok(body.code_verifier.length > 0);
	});

	it("Anthropic manual fallback parses callback URL query code and hash state", async () => {
		const body = await completeAnthropicAndCaptureTokenBody(
			"https://console.anthropic.com/oauth/code/callback?code=callback-code%2F123#callback-state",
		);
		assert.equal(body.code, "callback-code/123");
		assert.equal(body.state, "callback-state");
	});

	it("Anthropic manual fallback parses code and state from URL hash parameters", async () => {
		const body = await completeAnthropicAndCaptureTokenBody(
			"https://console.anthropic.com/oauth/code/callback#code=hash-code&state=hash-state",
		);
		assert.equal(body.code, "hash-code");
		assert.equal(body.state, "hash-state");
	});
});
