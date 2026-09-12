import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, sanitizeMcpRuntimeError } from "../../../src/server/mcp/mcp-client.ts";
import { McpManager } from "../../../src/server/mcp/mcp-manager.ts";
import type { McpServerConfig } from "../../../src/server/mcp/mcp-types.ts";

const EXPANDED_ENV_NAME = "BOBBIT_TEST_MCP_RUNTIME_SECRET";
const EXPANDED_SECRET = "expanded-runtime-secret-sentinel";

afterEach(() => {
	delete process.env[EXPANDED_ENV_NAME];
	vi.restoreAllMocks();
});

describe("MCP runtime error redaction", () => {
	it("removes raw and expanded env/header values plus every configured URL credential form", () => {
		process.env[EXPANDED_ENV_NAME] = EXPANDED_SECRET;
		const rawReference = `\${${EXPANDED_ENV_NAME}}`;
		const config: McpServerConfig = {
			env: {
				DIRECT_SECRET: "direct-environment-secret",
				EXPANDED_SECRET: `prefix-${rawReference}-suffix`,
			},
			headers: {
				Authorization: `Bearer ${rawReference}`,
				"X-Direct-Secret": "direct-header-secret",
			},
			url: "https://url%20user:url%2Fpassword@mcp.example.test/rpc?access_token=url%20query#url%20fragment",
		};
		const rawError = [
			"HTTP 401 initialize rejected",
			"direct-environment-secret",
			`prefix-${rawReference}-suffix`,
			`prefix-${EXPANDED_SECRET}-suffix`,
			`Bearer ${rawReference}`,
			`Bearer ${EXPANDED_SECRET}`,
			"direct-header-secret",
			config.url,
			"url%20user url user url%2Fpassword url/password url%20query url query url%20fragment url fragment",
		].join(" | ");

		const safe = sanitizeMcpRuntimeError(new Error(rawError), config);

		expect(safe).toContain("HTTP 401 initialize rejected");
		expect(safe).toContain("https://mcp.example.test/rpc");
		for (const secret of [
			"direct-environment-secret",
			rawReference,
			EXPANDED_SECRET,
			"direct-header-secret",
			"url%20user", "url user",
			"url%2Fpassword", "url/password",
			"url%20query", "url query",
			"url%20fragment", "url fragment",
			"access_token=",
		]) {
			expect(safe).not.toContain(secret);
		}
	});

	it.each(["connect", "list"] as const)("sanitizes %s failures before logs and status DTOs", async (stage) => {
		process.env[EXPANDED_ENV_NAME] = EXPANDED_SECRET;
		const config: McpServerConfig = {
			command: "stub",
			env: { TOKEN: `\${${EXPANDED_ENV_NAME}}` },
			headers: { Authorization: `Bearer ${EXPANDED_SECRET}` },
		};
		const failure = new Error(`${stage} rejected Authorization=Bearer ${EXPANDED_SECRET}`);
		class StubClient extends McpClient {
			override get connected(): boolean { return stage === "list"; }
			override async connect(): Promise<void> { throw failure; }
			override async listTools(): Promise<never> { throw failure; }
			override async disconnect(): Promise<void> {}
		}
		class TestManager extends McpManager {
			protected override _createClient(name: string): McpClient { return new StubClient(name); }
		}
		const manager = new TestManager(process.cwd());
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		await manager.connectPretrustedServer(`runtime-${stage}`, config);

		const status = manager.getServerStatuses()[0];
		expect(status).toMatchObject({ name: `runtime-${stage}`, status: "error" });
		expect(status.error).toContain(`${stage} rejected`);
		expect(JSON.stringify(status)).not.toContain(EXPANDED_SECRET);
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(EXPANDED_SECRET);
	});
});
