import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { test, expect } from "./gateway-harness.js";

const ANTHROPIC_SANDBOX_TOKEN = "ANTHROPIC_OAUTH_TOKEN";

type OAuthRow = {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
};

function authPath(bobbitDir: string): string {
	return join(bobbitDir, "agent", "auth.json");
}

function writeAnthropicCredential(file: string, credential: OAuthRow): void {
	writeFileSync(file, JSON.stringify({ anthropic: credential }, null, 2));
}

async function oauthStatus(baseURL: string): Promise<Record<string, unknown>> {
	const response = await fetch(`${baseURL}/api/oauth/status?provider=anthropic`, {
		headers: { Authorization: `Bearer ${process.env.BOBBIT_TOKEN}` },
	});
	expect(response.status).toBe(200);
	return response.json() as Promise<Record<string, unknown>>;
}

async function assertMockModelUsesStoredCredential(access: string): Promise<void> {
	const [{ clearOAuthCache }, { completeModelText }] = await Promise.all([
		import("../../dist/server/agent/model-registry.js"),
		import("../../dist/server/agent/model-completion.js"),
	]);
	clearOAuthCache();
	let observedApiKey: unknown;
	const result = await completeModelText({
		id: "claude-opus-5",
		name: "Claude Opus 5",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "http://127.0.0.1/mock-anthropic",
		contextWindow: 200_000,
		maxTokens: 128,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		authenticated: true,
	} as any, undefined, {
		systemPrompt: "test system prompt",
		userPrompt: "Reply with OK",
		maxTokens: 5,
		thinkingLevel: "off",
	}, async (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
		observedApiKey = options.apiKey;
		return { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } as any;
	}, {
		env: {},
		providerConfigReader: () => undefined,
	});

	expect(result).toBe("OK");
	// Compare booleans so a failure cannot print the dynamically generated credential.
	expect(observedApiKey === access).toBe(true);
}

test.describe.serial("Anthropic OAuth restart, sandbox, and lock regressions", () => {
	test("keeps an isolated-agent-dir credential authenticated and usable by the mock model after a real gateway restart", async ({ gateway }) => {
		const file = authPath(gateway.bobbitDir);
		const credential: OAuthRow = {
			type: "oauth",
			access: randomUUID(),
			refresh: randomUUID(),
			expires: Date.now() + 60 * 60 * 1000,
		};
		writeAnthropicCredential(file, credential);

		try {
			const before = await oauthStatus(gateway.baseURL);
			expect(before.authenticated).toBe(true);
			expect(JSON.stringify(before).includes(credential.access)).toBe(false);
			expect(JSON.stringify(before).includes(credential.refresh)).toBe(false);
			await assertMockModelUsesStoredCredential(credential.access);

			// A real reboot requires the live listener to be torn down before the
			// fixture creates the replacement gateway on the same isolated state dir.
			await gateway.crash();
			await gateway.restart();

			const after = await oauthStatus(gateway.baseURL);
			expect(after.authenticated).toBe(true);
			expect(after.expires).toBe(credential.expires);
			expect(JSON.stringify(after).includes(credential.access)).toBe(false);
			expect(JSON.stringify(after).includes(credential.refresh)).toBe(false);
			await assertMockModelUsesStoredCredential(credential.access);
		} finally {
			// The harness is already isolated, but leave its fixture state intact for
			// any later tests sharing this worker.
			writeFileSync(file, JSON.stringify({ anthropic: { type: "oauth", expires: Date.now() + 60_000 } }));
		}
	});

	test("gives explicit project credentials precedence and never forwards renewable host Anthropic OAuth by default", async ({ gateway }) => {
		const file = authPath(gateway.bobbitDir);
		const hostCredential: OAuthRow = {
			type: "oauth",
			access: randomUUID(),
			refresh: randomUUID(),
			expires: Date.now() + 60 * 60 * 1000,
		};
		const projectCredential = randomUUID();
		writeAnthropicCredential(file, hostCredential);

		const [{ buildSandboxAgentAuthJson, hasExplicitSandboxAnthropicCredential, sandboxTokenPolicyAllowsAnthropicAuth }, { resolveSandboxTokens }] = await Promise.all([
			import("../../dist/server/agent/host-tokens.js"),
			import("../../dist/server/agent/session-manager.js"),
		]);
		const noSandboxPolicy = { getSandboxTokens: () => [], get: () => undefined } as any;
		const explicitEmptyPolicy = {
			getSandboxTokens: () => [{ key: ANTHROPIC_SANDBOX_TOKEN, enabled: true }],
			get: () => undefined,
		} as any;
		const projectSecrets = { getAll: () => ({ [ANTHROPIC_SANDBOX_TOKEN]: projectCredential }) } as any;

		try {
			// An absent project policy is not permission to export account-level,
			// renewable OAuth; the session-manager passes this explicit deny option.
			const defaultCredentials = resolveSandboxTokens(
				undefined, noSandboxPolicy, undefined, undefined, { allowStoredAnthropicOAuth: false },
			);
			expect(sandboxTokenPolicyAllowsAnthropicAuth([])).toBe(false);
			expect(Object.hasOwn(defaultCredentials, ANTHROPIC_SANDBOX_TOKEN)).toBe(false);
			expect(buildSandboxAgentAuthJson({ includeAnthropicAuth: false })).toEqual({});

			// An enabled entry with no project secret is the only deliberate host
			// handoff path. Compare booleans so test failure cannot echo its value.
			const optedIn = resolveSandboxTokens(
				undefined, explicitEmptyPolicy, undefined, undefined, { allowStoredAnthropicOAuth: true },
			);
			expect(sandboxTokenPolicyAllowsAnthropicAuth(explicitEmptyPolicy.getSandboxTokens())).toBe(true);
			expect(optedIn[ANTHROPIC_SANDBOX_TOKEN] === hostCredential.access).toBe(true);

			// A project secret wins over the host and disables the renewable handoff.
			const explicit = resolveSandboxTokens(
				undefined, explicitEmptyPolicy, projectSecrets, undefined, { allowStoredAnthropicOAuth: false },
			);
			expect(hasExplicitSandboxAnthropicCredential(explicitEmptyPolicy.getSandboxTokens(), projectSecrets.getAll())).toBe(true);
			expect(Object.keys(explicit)).toEqual([ANTHROPIC_SANDBOX_TOKEN]);
			expect(explicit[ANTHROPIC_SANDBOX_TOKEN] === projectCredential).toBe(true);
		} finally {
			writeFileSync(file, JSON.stringify({ anthropic: { type: "oauth", expires: Date.now() + 60_000 } }));
		}
	});

	test("reclaims a stale auth lock without losing other provider records", async ({ gateway }) => {
		const file = authPath(gateway.bobbitDir);
		const anthropic: OAuthRow = {
			type: "oauth",
			access: randomUUID(),
			refresh: randomUUID(),
			expires: Date.now() + 60 * 60 * 1000,
		};
		const unrelatedKey = randomUUID();
		writeAnthropicCredential(file, anthropic);
		const lockPath = `${realpathSync(file)}.lock`;
		mkdirSync(lockPath, { recursive: true });
		const stale = new Date(Date.now() - 31_000);
		utimesSync(lockPath, stale, stale);

		try {
			const { AtomicCredentialStore } = await import("../../dist/server/auth/credential-store.js");
			const store = new AtomicCredentialStore(file);
			await store.modify("unrelated-provider", async () => ({ type: "api_key", key: unrelatedKey }));

			expect(existsSync(lockPath)).toBe(false);
			const document = JSON.parse(readFileSync(file, "utf-8")) as Record<string, any>;
			expect(document.anthropic?.type).toBe("oauth");
			expect(document.anthropic?.access === anthropic.access).toBe(true);
			expect(document["unrelated-provider"]?.type).toBe("api_key");
			expect(document["unrelated-provider"]?.key === unrelatedKey).toBe(true);
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
		}
	});
});
