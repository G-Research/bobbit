/**
 * Unit test for `oauthComplete` in `src/server/auth/oauth.ts`.
 *
 * Contract:
 *   - Empty `authCode`              → { success: false, error: "code required" }.
 *   - Whitespace-only `authCode`    → { success: false, error: "code required" }.
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

const { oauthComplete } = await import("../src/server/auth/oauth.js");

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
		assert.deepEqual(res1, { success: false, error: "code required" });
	});

	it("whitespace-only authCode for a real flow → 'code required'", async () => {
		const { oauthStart } = await import("../src/server/auth/oauth.js");
		const start = await oauthStart("anthropic");
		const res = await oauthComplete(start.flowId, "   \t\n  ");
		assert.deepEqual(res, { success: false, error: "code required" });
	});
});
