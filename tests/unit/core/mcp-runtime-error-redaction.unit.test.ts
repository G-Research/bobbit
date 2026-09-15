import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, sanitizeMcpRuntimeError } from "../../../src/server/mcp/mcp-client.ts";
import { McpManager } from "../../../src/server/mcp/mcp-manager.ts";
import type { McpServerConfig } from "../../../src/server/mcp/mcp-types.ts";

const EXPANDED_ENV_NAME = "BOBBIT_TEST_MCP_RUNTIME_SECRET";
const EXPANDED_SECRET = "expanded-runtime-secret-sentinel";
const PRIVATE_SNAPSHOT_ROOT = "C:\\Private\\marketplace-snapshots\\Snapshot-Call-Id";
const MIXED_PRIVATE_SNAPSHOT_ROOT = "c:/private/MARKETPLACE-snapshots/snapshot-call-id";

function configureConnectedClient(config: McpServerConfig): McpClient {
	const client = new McpClient("snapshot-call");
	Object.assign(client as any, {
		_connected: true,
		_config: config,
		_privateDiagnosticPaths: [PRIVATE_SNAPSHOT_ROOT],
	});
	return client;
}

function expectNoPrivateSnapshotPath(value: unknown): void {
	const serialized = JSON.stringify(value).toLowerCase();
	expect(serialized).not.toContain(PRIVATE_SNAPSHOT_ROOT.toLowerCase());
	expect(serialized).not.toContain("snapshot-call-id");
}

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

	it("redacts the complete private snapshot root independently of a configured subdirectory cwd", () => {
		const privateRoot = process.platform === "win32"
			? "C:\\private\\marketplace-snapshots\\snapshot-id"
			: "/private/marketplace-snapshots/snapshot-id";
		const cwd = `${privateRoot}${process.platform === "win32" ? "\\" : "/"}work`;
		const message = `${privateRoot}${process.platform === "win32" ? "\\" : "/"}server.mjs failed from ${cwd}`;
		const safe = sanitizeMcpRuntimeError(message, { command: "node", cwd }, [privateRoot]);

		expect(safe).toContain("server.mjs failed");
		expect(safe).not.toContain(privateRoot);
		expect(safe).not.toContain("snapshot-id");
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

	it("sanitizes private roots throughout successful tool results without truncating content", async () => {
		const longText = `prefix-${"x".repeat(1_100)}-${MIXED_PRIVATE_SNAPSHOT_ROOT}/server.mjs`;
		const client = configureConnectedClient({
			command: "node",
			cwd: `${MIXED_PRIVATE_SNAPSHOT_ROOT}/work`,
		});
		(client as any)._sendRequest = async () => ({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [{ type: "text", text: longText }],
				_meta: {
					diagnostic: `${MIXED_PRIVATE_SNAPSHOT_ROOT}/trace.log`,
					[`${MIXED_PRIVATE_SNAPSHOT_ROOT}/key`]: "nested diagnostic",
				},
			},
		});

		const result = await client.callTool("inspect", {});

		expect(result.content[0]?.text?.length).toBeGreaterThan(1_000);
		expect(result.content[0]?.text).toContain("server.mjs");
		expectNoPrivateSnapshotPath(result);
	});

	it("sanitizes private roots in tool error results", async () => {
		const client = configureConnectedClient({
			command: "node",
			cwd: `${MIXED_PRIVATE_SNAPSHOT_ROOT}/work`,
		});
		(client as any)._sendRequest = async () => ({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -1, message: `failed at ${MIXED_PRIVATE_SNAPSHOT_ROOT}/server.mjs` },
		});

		const result = await client.callTool("inspect", {});

		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toContain("server.mjs");
		expectNoPrivateSnapshotPath(result);
	});

	it("sanitizes private roots when a tool call throws", async () => {
		const client = configureConnectedClient({
			command: "node",
			cwd: `${MIXED_PRIVATE_SNAPSHOT_ROOT}/work`,
		});
		(client as any)._sendRequest = async () => {
			throw new Error(`transport failed at ${MIXED_PRIVATE_SNAPSHOT_ROOT}/server.mjs`);
		};

		const failure = await client.callTool("inspect", {}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("server.mjs");
		expectNoPrivateSnapshotPath(failure instanceof Error ? failure.message : failure);
	});

	it("sanitizes private roots in HTTP transport failures", async () => {
		const client = configureConnectedClient({
			url: "https://mcp.example.test/rpc",
			cwd: `${MIXED_PRIVATE_SNAPSHOT_ROOT}/work`,
		});
		(client as any)._postHttpJson = async () => {
			throw new Error(`socket failed at ${MIXED_PRIVATE_SNAPSHOT_ROOT}/server.mjs`);
		};

		const failure = await client.callTool("inspect", {}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("HTTP request failed");
		expect((failure as Error).message).toContain("server.mjs");
		expectNoPrivateSnapshotPath(failure instanceof Error ? failure.message : failure);
	});

	it("carries private snapshot roots through mixed-separator manager diagnostics without exposing them", async () => {
		const privateRoot = "C:\\Private\\marketplace-snapshots\\Snapshot-Id";
		const mixedPrivateRoot = "c:/private\\MARKETPLACE-snapshots/snapshot-id";
		const config: McpServerConfig = { command: "node", cwd: `${mixedPrivateRoot}\\work` };
		class StubClient extends McpClient {
			override async connect(): Promise<void> {
				throw new Error(`module not found at ${mixedPrivateRoot}\\server.mjs`);
			}
			override async disconnect(): Promise<void> {}
		}
		class TestManager extends McpManager {
			protected override _createClient(name: string): McpClient { return new StubClient(name); }
		}
		const manager = new TestManager(process.cwd(), undefined, undefined, {
			marketplaceResolver: () => [{
				listName: "snapshot",
				serverName: "snapshot",
				config,
				origin: {
					scope: "project",
					authority: "marketplace",
					trust: "pretrusted",
					sourceId: "snapshot-source",
					runtimePrivatePackRoot: privateRoot,
					reviewPackRoot: ".bobbit/config/market-packs/snapshot",
				},
			}],
		});
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });

		const serialized = JSON.stringify(manager.getServerStatuses());
		expect(serialized).toContain("module not found");
		expect(serialized).not.toContain(privateRoot);
		expect(serialized.toLowerCase()).not.toContain("snapshot-id");
		expect(JSON.stringify(errorLog.mock.calls).toLowerCase()).not.toContain("snapshot-id");
	});
});
