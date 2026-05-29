import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildDockerRunArgs } from "../src/server/agent/docker-args.js";
import {
	buildSandboxAgentAuthJson,
	ensureSandboxAgentAuthFile,
	resolveHostTokenValue,
	sandboxAgentAuthPath,
	sandboxTokenPolicyAllowsCodexAuth,
} from "../src/server/agent/host-tokens.js";

const previousEnv: Record<string, string | undefined> = {};
let root: string;
let agentDir: string;
let bobbitDir: string;

function setEnv(key: string, value: string | undefined): void {
	if (!(key in previousEnv)) previousEnv[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function restoreEnv(): void {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const key of Object.keys(previousEnv)) delete previousEnv[key];
}

function writeAuthJson(data: unknown): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(data, null, 2));
}

function dockerVolumes(args: string[]): string[] {
	const volumes: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-v" && args[i + 1]) volumes.push(args[i + 1]);
	}
	return volumes;
}

describe("sandbox OpenAI Codex auth", () => {
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "bobbit-codex-auth-"));
		agentDir = path.join(root, "agent");
		bobbitDir = path.join(root, ".bobbit");
		setEnv("BOBBIT_AGENT_DIR", agentDir);
		setEnv("BOBBIT_DIR", bobbitDir);
		setEnv("OPENAI_API_KEY", undefined);
		setEnv("ANTHROPIC_API_KEY", undefined);
	});

	afterEach(() => {
		restoreEnv();
		rmSync(root, { recursive: true, force: true });
	});

	it("writes empty sandbox auth.json when OpenAI/Codex is not allowed", () => {
		writeAuthJson({
			"openai-codex": { type: "oauth", access: "codex-access", refresh: "codex-refresh" },
			anthropic: { type: "oauth", access: "anthropic-access" },
			openai: { type: "api_key", key: "sk-openai" },
		});

		const auth = buildSandboxAgentAuthJson({ includeCodexAuth: false });
		assert.deepEqual(auth, {});

		const file = ensureSandboxAgentAuthFile({ includeCodexAuth: false, scope: "excluded-project" });
		assert.equal(file, sandboxAgentAuthPath("excluded-project"));
		const written = readFileSync(file, "utf-8");
		assert.equal(written.includes("codex-access"), false);
		assert.deepEqual(JSON.parse(written), {});
	});

	it("writes a minimal sandbox auth.json with only allowed OpenAI Codex fields", () => {
		writeAuthJson({
			"openai-codex": {
				type: "oauth",
				access: "codex-access",
				refresh: "codex-refresh",
				expires: 12345,
				accountId: "must-not-copy",
				profile: { email: "user@example.test" },
			},
			anthropic: { type: "oauth", access: "anthropic-access" },
			openai: { type: "api_key", key: "sk-openai" },
		});

		const auth = buildSandboxAgentAuthJson({ includeCodexAuth: true });
		assert.deepEqual(auth, {
			"openai-codex": { type: "oauth", access: "codex-access", refresh: "codex-refresh", expires: 12345 },
		});

		const file = ensureSandboxAgentAuthFile({ includeCodexAuth: true, scope: "allowed-project" });
		assert.equal(file, sandboxAgentAuthPath("allowed-project"));
		const written = JSON.parse(readFileSync(file, "utf-8"));
		assert.deepEqual(written, auth);
	});

	it("mounts empty auth.json when sandbox token policy excludes OpenAI/Codex", () => {
		writeAuthJson({
			"openai-codex": { type: "oauth", access: "codex-access" },
			anthropic: { type: "oauth", access: "anthropic-access" },
		});

		const args = buildDockerRunArgs({
			image: "test",
			workspaceDir: path.join(root, "workspace"),
			projectId: "excluded-project",
			sandboxAgentAuthAllowed: sandboxTokenPolicyAllowsCodexAuth([{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true }]),
		});
		const volumes = dockerVolumes(args);
		const authMount = volumes.find((v) => v.endsWith(":/home/node/.bobbit/agent/auth.json:ro"));
		assert.ok(authMount, "sandbox auth.json should be mounted read-only");
		assert.ok(!authMount.includes(path.join(agentDir, "auth.json")), "must not mount the full host auth.json");
		assert.ok(!volumes.some((v) => v === `${agentDir}:/home/node/.bobbit/agent` || v === `${agentDir}:/home/node/.bobbit/agent:ro`));

		const written = readFileSync(sandboxAgentAuthPath("excluded-project"), "utf-8");
		assert.equal(written.includes("codex-access"), false);
		assert.deepEqual(JSON.parse(written), {});
	});

	it("mounts scoped sanitized auth.json when sandbox token policy allows OpenAI Codex", () => {
		writeAuthJson({
			"openai-codex": { type: "api_key", key: "codex-key", extra: "must-not-copy" },
			anthropic: { type: "oauth", access: "anthropic-access" },
		});

		const args = buildDockerRunArgs({
			image: "test",
			workspaceDir: path.join(root, "workspace"),
			projectId: "allowed-project",
			sandboxAgentAuthAllowed: sandboxTokenPolicyAllowsCodexAuth([{ key: "OPENAI_CODEX_AUTH", enabled: true }]),
		});
		const volumes = dockerVolumes(args);
		const authMount = volumes.find((v) => v.endsWith(":/home/node/.bobbit/agent/auth.json:ro"));
		assert.ok(authMount, "sandbox auth.json should be mounted read-only");
		assert.ok(!authMount.includes(path.join(agentDir, "auth.json")), "must not mount the full host auth.json");

		const written = JSON.parse(readFileSync(sandboxAgentAuthPath("allowed-project"), "utf-8"));
		assert.deepEqual(written, { "openai-codex": { type: "api_key", key: "codex-key" } });
	});

	it("keeps existing sandbox env-token resolution for Anthropic and OpenAI API keys", async () => {
		setEnv("ANTHROPIC_API_KEY", "anthropic-env-key");
		setEnv("OPENAI_API_KEY", "openai-env-key");
		setEnv("GITHUB_TOKEN", undefined);
		setEnv("GH_TOKEN", undefined);
		setEnv("NPM_TOKEN", undefined);
		assert.equal(resolveHostTokenValue("ANTHROPIC_OAUTH_TOKEN"), "anthropic-env-key");
		assert.equal(resolveHostTokenValue("OPENAI_API_KEY"), "openai-env-key");

		const { resolveSandboxTokens } = await import("../src/server/agent/session-manager.ts");
		const projectConfig = {
			getSandboxTokens: () => [
				{ key: "ANTHROPIC_OAUTH_TOKEN", enabled: true },
				{ key: "OPENAI_API_KEY", enabled: true },
			],
			get: () => "",
		};
		assert.deepEqual(resolveSandboxTokens(null, projectConfig as any, null), {
			ANTHROPIC_OAUTH_TOKEN: "anthropic-env-key",
			OPENAI_API_KEY: "openai-env-key",
		});
	});
});
