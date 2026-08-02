import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { oauthStart } from "../../src/server/auth/oauth.js";

describe("Anthropic OAuth Pi callback contract", () => {
	it("uses Pi's loopback callback and complete current scope set", async () => {
		const started = await oauthStart("anthropic");
		const authorizationUrl = new URL(started.url);

		assert.equal(
			authorizationUrl.searchParams.get("redirect_uri"),
			"http://localhost:53692/callback",
			"Anthropic OAuth must use Pi's loopback callback instead of the stale Console callback",
		);
		assert.deepEqual(
			new Set((authorizationUrl.searchParams.get("scope") ?? "").split(" ").filter(Boolean)),
			new Set([
				"org:create_api_key",
				"user:profile",
				"user:inference",
				"user:sessions:claude_code",
				"user:mcp_servers",
				"user:file_upload",
			]),
			"Anthropic OAuth must request Pi's complete current scope set",
		);
	});
});
