import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const piProvidersEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/all"));
const piAnthropicOAuthSource = readFileSync(
	path.join(path.dirname(piProvidersEntry), "..", "auth", "oauth", "anthropic.js"),
	"utf8",
);

describe("Anthropic OAuth Pi callback contract", () => {
	it("pins Pi's loopback callback and complete current scope set without starting its listener", () => {
		// This is the installed dependency that builtinModels() delegates to, not a
		// duplicated Bobbit URL/scopes fixture. Starting it would claim Pi's fixed
		// process-global port and make concurrent unit coordinators contend.
		assert.match(piAnthropicOAuthSource, /const CALLBACK_PORT = 53692;/);
		assert.match(piAnthropicOAuthSource, /const REDIRECT_URI = `http:\/\/localhost:\$\{CALLBACK_PORT\}\$\{CALLBACK_PATH\}`;/);
		assert.match(
			piAnthropicOAuthSource,
			/const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";/,
			"Anthropic OAuth must retain Pi's complete current scope set",
		);
	});
});
