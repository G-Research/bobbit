import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import {
	buildSandboxAgentAuthJson,
	refreshSandboxAnthropicOAuthCredential,
	resolveHostTokenValue,
	sandboxTokenPolicyAllowsAnthropicAuth,
} from "../../src/server/agent/host-tokens.js";

let root: string | undefined;
let agentDir: string | undefined;

function useHostAuth(auth: unknown): void {
	root = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-sandbox-"));
	agentDir = path.join(root, "agent");
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.BOBBIT_SECRETS_DIR = path.join(root, "secrets");
	resetAgentDirStateForTests();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
		anthropic: auth,
		"openai-codex": { type: "oauth", access: "unrelated-codex-access" },
		"google-gemini-cli": { type: "oauth", access: "unrelated-google-access" },
	}), { encoding: "utf-8", flag: "w" });
}

afterEach(() => {
	vi.restoreAllMocks();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	agentDir = undefined;
	resetAgentDirStateForTests();
});

describe("Anthropic sandbox OAuth handoff regressions", () => {
	it("exports only a sanctioned, current non-renewable Anthropic OAuth credential", () => {
		const expires = Date.now() + 60_000;
		useHostAuth({
			type: "oauth",
			access: "sandbox-current-access",
			refresh: "sandbox-refresh-metadata",
			expires,
			email: "must-not-copy@example.test",
			scope: "must-not-copy",
		});

		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }]), true);
		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: false }]), false);
		assert.equal(sandboxTokenPolicyAllowsAnthropicAuth([{ key: "ANTHROPIC_API_KEY", enabled: true }]), false);
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {
			anthropic: { type: "oauth", access: "sandbox-current-access", expires },
		});
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: false }), {});
	});

	it("does not hand an expired host OAuth access token to a sandbox when refresh cannot run", () => {
		useHostAuth({ type: "oauth", access: "expired-access", refresh: "refresh-metadata", expires: Date.now() - 1 });

		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {});
		assert.equal(resolveHostTokenValue("ANTHROPIC_OAUTH_TOKEN", undefined, undefined as any, { allowStoredAnthropicOAuth: false }), undefined);
	});

	it("refreshes before producing the minimal sandbox auth entry", async () => {
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		useHostAuth({ type: "oauth", access: "expired-access", refresh: "refresh-metadata", expires: now - 1 });
		const refreshRequest = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
			assert.equal(init?.method, "POST");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.grant_type, "refresh_token");
			assert.equal(body.refresh_token, "refresh-metadata");
			assert.equal(typeof body.client_id, "string");
			return new Response(JSON.stringify({
				access_token: "rotated-access",
				refresh_token: "rotated-refresh",
				expires_in: 3_600,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const refreshedExpiry = now + 3_600_000 - 300_000;

		assert.equal(await refreshSandboxAnthropicOAuthCredential(), true);
		assert.equal(refreshRequest.mock.calls.length, 1);
		assert.deepEqual(buildSandboxAgentAuthJson({ includeAnthropicAuth: true }), {
			anthropic: { type: "oauth", access: "rotated-access", expires: refreshedExpiry },
		});
	});
});
