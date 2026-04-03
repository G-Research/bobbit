/**
 * Unit tests verifying that buildDockerRunArgs() does NOT leak
 * sensitive tokens into the container's PID 1 environment.
 *
 * Background: PID 1 (`sleep infinity`) env is world-readable via
 * /proc/1/environ. The gateway token must NOT appear there — the
 * agent process receives its scoped token via `docker exec -e`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDockerRunArgs, type DockerRunConfig } from "../dist/server/agent/docker-args.js";

/** Minimal config that exercises all code paths. */
function baseConfig(overrides: Partial<DockerRunConfig> = {}): DockerRunConfig {
	return {
		image: "test-image:latest",
		workspaceDir: "/tmp/test-workspace",
		label: "test-label",
		labelPrefix: "bobbit-sandbox",
		labelVersion: "2",
		sandboxNetwork: "bobbit-sandbox-net",
		...overrides,
	};
}

/** Extract all `-e KEY=VALUE` pairs from docker args. */
function extractEnvVars(args: string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-e" && i + 1 < args.length) {
			const [key, ...rest] = args[i + 1].split("=");
			env[key] = rest.join("=");
		}
	}
	return env;
}

describe("buildDockerRunArgs — token sanitization", () => {
	it("does not include BOBBIT_TOKEN in env vars", () => {
		const args = buildDockerRunArgs(baseConfig());
		const env = extractEnvVars(args);
		assert.equal(env["BOBBIT_TOKEN"], undefined, "BOBBIT_TOKEN must not be in PID 1 environment");
	});

	it("does not include BOBBIT_GATEWAY_URL in env vars", () => {
		const args = buildDockerRunArgs(baseConfig());
		const env = extractEnvVars(args);
		assert.equal(env["BOBBIT_GATEWAY_URL"], undefined, "BOBBIT_GATEWAY_URL must not be in PID 1 environment");
	});

	it("does not accept gatewayUrl or gatewayToken config fields", () => {
		// TypeScript would catch this at compile time, but verify at runtime
		// that even if someone casts in extra fields, they don't leak.
		const config = {
			...baseConfig(),
			gatewayUrl: "https://evil.example.com",
			gatewayToken: "secret-admin-token",
		} as DockerRunConfig;
		const args = buildDockerRunArgs(config);
		const joined = args.join(" ");
		assert.ok(!joined.includes("secret-admin-token"), "Token value must not appear in args");
		assert.ok(!joined.includes("evil.example.com"), "Gateway URL must not appear in args");
	});

	it("still includes expected non-sensitive env vars", () => {
		const args = buildDockerRunArgs(baseConfig());
		const env = extractEnvVars(args);
		assert.equal(env["NODE_TLS_REJECT_UNAUTHORIZED"], "0");
		assert.equal(env["NODE_OPTIONS"], "--no-warnings");
		assert.equal(env["PI_CODING_AGENT_DIR"], "/home/node/.bobbit/agent");
	});

	it("includes sandbox credentials but not gateway token", () => {
		const args = buildDockerRunArgs(baseConfig({
			sandboxCredentials: { ANTHROPIC_API_KEY: "sk-test-123" },
		}));
		const env = extractEnvVars(args);
		assert.equal(env["ANTHROPIC_API_KEY"], "sk-test-123");
		assert.equal(env["BOBBIT_TOKEN"], undefined);
		assert.equal(env["BOBBIT_GATEWAY_URL"], undefined);
	});
});
