import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import { afterAll, afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { McpServerConfig, McpToolDef, McpToolResult } from "../../../src/server/mcp/mcp-types.ts";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-special-key-home-"));
process.env.HOME = path.join(fixtureRoot, "home");
process.env.USERPROFILE = path.join(fixtureRoot, "home");
process.env.BOBBIT_DIR = path.join(fixtureRoot, "headquarters");
fs.mkdirSync(process.env.HOME, { recursive: true });

const {
	McpApprovalStore,
	canonicalMcpServerConfig,
	validateMcpServerConfig,
} = await import("../../../src/server/mcp/mcp-approval-store.ts");
const {
	McpManager,
	redactMcpServerConfig,
	redactRecord,
} = await import("../../../src/server/mcp/mcp-manager.ts");
const { McpClient, buildMcpProcessEnv, expandEnvRecord } = await import("../../../src/server/mcp/mcp-client.ts");
const { marketplaceMcpBehaviorFingerprint } = await import("../../../src/server/mcp/marketplace-mcp-install-attestation.ts");

const temporaryRoots: string[] = [];
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function temporaryCase(): { cwd: string; stateDir: string; root: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-special-key-"));
	temporaryRoots.push(root);
	const cwd = path.join(root, "project");
	const stateDir = path.join(root, "state");
	fs.mkdirSync(cwd, { recursive: true });
	return { cwd, stateDir, root };
}

function specialHttpConfig(value: string): McpServerConfig {
	return JSON.parse(`{"url":"https://example.test/mcp","headers":{"__proto__":${JSON.stringify(value)}}}`) as McpServerConfig;
}

function writeProjectConfig(cwd: string, config: McpServerConfig): void {
	fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { repository: config } }));
}

class StubMcpClient {
	connected = false;
	connectCount = 0;
	disconnectCount = 0;
	callCount = 0;

	async connect(_config: McpServerConfig): Promise<void> {
		this.connectCount += 1;
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.disconnectCount += 1;
		this.connected = false;
	}

	async listTools(): Promise<McpToolDef[]> {
		return [{ name: "inspect", inputSchema: { type: "object" } }];
	}

	async callTool(): Promise<McpToolResult> {
		this.callCount += 1;
		return { content: [{ type: "text", text: "ok" }] };
	}
}

class TestMcpManager extends (McpManager as any) {
	createCount = 0;

	constructor(
		cwd: string,
		stateDir: string,
		private readonly stub: StubMcpClient,
		approvalStore: InstanceType<typeof McpApprovalStore>,
	) {
		super(cwd, undefined, stateDir, { projectId: "project-1", approvalStore });
	}

	protected _createClient(): any {
		this.createCount += 1;
		return this.stub;
	}
}

async function approveCurrent(manager: any): Promise<void> {
	const current = manager.getEffectiveDefinitionForDecision("repository");
	assert.ok(current?.approval.fingerprint);
	await manager.decideApproval({
		projectId: current.origin.projectId,
		sourceId: current.origin.sourceId,
		serverName: "repository",
		fingerprint: current.approval.fingerprint,
	}, "approved");
}

function rawHeaderValue(rawHeaders: string[], name: string): string | undefined {
	for (let index = 0; index < rawHeaders.length; index += 2) {
		if (rawHeaders[index]?.toLowerCase() === name.toLowerCase()) return rawHeaders[index + 1];
	}
	return undefined;
}

describe("MCP prototype-like configuration keys", () => {
	it("retains own special keys in canonical approval and Marketplace fingerprints without persisting values", async () => {
		const stateDir = temporaryCase().stateDir;
		const store = new McpApprovalStore(stateDir);
		const original = JSON.parse('{"command":"node","env":{"__proto__":"env-first"},"headers":{"__proto__":"header-first"},"__proto__":{"mode":"unknown-first"}}') as McpServerConfig;
		const headerChanged = JSON.parse('{"command":"node","env":{"__proto__":"env-first"},"headers":{"__proto__":"header-second"},"__proto__":{"mode":"unknown-first"}}') as McpServerConfig;
		const envChanged = JSON.parse('{"command":"node","env":{"__proto__":"env-second"},"headers":{"__proto__":"header-first"},"__proto__":{"mode":"unknown-first"}}') as McpServerConfig;
		const unknownChanged = JSON.parse('{"command":"node","env":{"__proto__":"env-first"},"headers":{"__proto__":"header-first"},"__proto__":{"mode":"unknown-second"}}') as McpServerConfig;

		const canonical = canonicalMcpServerConfig(original) as Record<string, any>;
		assert.equal(Object.getOwnPropertyDescriptor(canonical.env, "__proto__")?.value, "env-first");
		assert.equal(Object.getOwnPropertyDescriptor(canonical.headers, "__proto__")?.value, "header-first");
		assert.deepEqual(Object.getOwnPropertyDescriptor(canonical.unknownOwnFields, "__proto__")?.value, { mode: "unknown-first" });

		const fingerprint = store.fingerprint(original);
		assert.notEqual(store.fingerprint(headerChanged), fingerprint);
		assert.notEqual(store.fingerprint(envChanged), fingerprint);
		assert.notEqual(store.fingerprint(unknownChanged), fingerprint);
		assert.notEqual(marketplaceMcpBehaviorFingerprint(headerChanged), marketplaceMcpBehaviorFingerprint(original));

		assert.ok(fingerprint);
		await store.decide({
			projectId: "project-1",
			sourceId: "project-file:.mcp.json",
			serverName: "repository",
			fingerprint,
		}, "approved");
		const ledger = fs.readFileSync(store.ledgerPath, "utf8");
		assert.doesNotMatch(ledger, /env-first|header-first|unknown-first/);
	});

	it("redacts every special-key value while retaining its own environment and header names", () => {
		const config = JSON.parse('{"command":"node","env":{"__proto__":"environment-secret"},"headers":{"__proto__":"header-secret"}}') as McpServerConfig;
		const redacted = redactMcpServerConfig(config);

		assert.equal(Object.getOwnPropertyDescriptor(redacted.env, "__proto__")?.value, "[redacted]");
		assert.equal(Object.getOwnPropertyDescriptor(redacted.headers, "__proto__")?.value, "[redacted]");
		assert.equal(Object.getOwnPropertyDescriptor(redactRecord(config.headers), "__proto__")?.value, "[redacted]");
		const serialized = JSON.stringify(redacted);
		assert.doesNotMatch(serialized, /environment-secret|header-secret/);
		const parsed = JSON.parse(serialized);
		assert.deepEqual(parsed.env, JSON.parse('{"__proto__":"[redacted]"}'));
		assert.deepEqual(parsed.headers, JSON.parse('{"__proto__":"[redacted]"}'));
	});

	it("still rejects case-insensitive duplicate headers without exposing either value", () => {
		const config = JSON.parse('{"url":"https://example.test/mcp","headers":{"__proto__":"first-secret","__PROTO__":"second-secret"}}');
		const error = validateMcpServerConfig(config);
		assert.equal(error, "Header names must be unique case-insensitively.");
		assert.doesNotMatch(error!, /first-secret|second-secret/);
	});

	it("treats special-key-only Marketplace config differences as distinct groups", () => {
		const origin = { scope: "manual", authority: "user-home", trust: "pretrusted", sourceId: "user-home:test", file: "~/.mcp.json" } as const;
		const groups = McpManager.groupMarketplaceContributions([
			{ listName: "first", serverName: "shared", runtimeServerKey: "shared", config: specialHttpConfig("first"), origin },
			{ listName: "second", serverName: "shared", runtimeServerKey: "shared", config: specialHttpConfig("second"), origin },
		]);

		assert.equal(groups.length, 1);
		assert.equal(groups[0].ownerContributions.length, 1);
		assert.equal(groups[0].ownerContributions[0].listName, "second");
		assert.equal(Object.getOwnPropertyDescriptor(groups[0].config.headers, "__proto__")?.value, "second");
	});

	it("disconnects an approved server and clears routes when only a special header value changes", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, specialHttpConfig("approved-secret"));
		const stub = new StubMcpClient();
		const manager = new TestMcpManager(cwd, stateDir, stub, new McpApprovalStore(stateDir)) as any;

		await approveCurrent(manager);
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(stub.connectCount, 1);
		assert.deepEqual(manager.getToolInfos().map((tool: any) => tool.name), ["mcp__repository__inspect"]);

		writeProjectConfig(cwd, specialHttpConfig("replacement-secret"));
		const result = await manager.reloadDiscoveredServers({ timeoutMs: 0 });
		assert.deepEqual(result.disconnected, ["repository"]);
		assert.equal(stub.disconnectCount, 1);
		assert.equal(manager.createCount, 1);
		assert.deepEqual(manager.getToolInfos(), []);
		const status = manager.getServerStatuses()[0];
		assert.equal(status.approval.state, "changed");
		assert.equal(status.status, "disconnected");
		assert.equal(Object.getOwnPropertyDescriptor(status.reviewConfig.headers, "__proto__")?.value, "[redacted]");
		assert.doesNotMatch(JSON.stringify(status), /approved-secret|replacement-secret/);
		await assert.rejects(manager.callTool("mcp__repository__inspect", {}));
		assert.equal(stub.callCount, 0);
	});
});

describe("MCP client special-key preparation", () => {
	it("retains an own special key while expanding configured environment values", () => {
		process.env.MCP_SPECIAL_ENV_VALUE = "expanded-secret";
		const configured = JSON.parse('{"__proto__":"${MCP_SPECIAL_ENV_VALUE}"}') as Record<string, string>;
		const expanded = expandEnvRecord(configured);
		assert.equal(Object.getOwnPropertyDescriptor(expanded, "__proto__")?.value, "expanded-secret");
		assert.deepEqual(Object.keys(expanded), ["__proto__"]);
	});

	it("retains configured special keys in the environment passed to stdio spawn", () => {
		process.env.MCP_INHERITED_ENV = "inherited";
		const configured = JSON.parse('{"__proto__":"spawned-secret","MCP_INHERITED_ENV":"overlaid"}') as Record<string, string>;
		const childEnv = buildMcpProcessEnv(configured);

		assert.equal(Object.getOwnPropertyDescriptor(childEnv, "__proto__")?.value, "spawned-secret");
		assert.equal(childEnv.MCP_INHERITED_ENV, "overlaid");
	});

	it("sends a configured special HTTP header as an own request header", async () => {
		const rawRequests: string[][] = [];
		const server = http.createServer(async (request, response) => {
			rawRequests.push([...request.rawHeaders]);
			let body = "";
			for await (const chunk of request) body += chunk;
			const message = JSON.parse(body);
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(message.id === undefined ? {} : {
				jsonrpc: "2.0",
				id: message.id,
				result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } },
			}));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const client = new McpClient("special-header");
		const headers = JSON.parse('{"__proto__":"http-secret"}') as Record<string, string>;

		try {
			await client.connect({ url: `http://127.0.0.1:${address.port}/mcp`, headers });
			assert.ok(rawRequests.length >= 2);
			for (const rawHeaders of rawRequests) assert.equal(rawHeaderValue(rawHeaders, "__proto__"), "http-secret");
		} finally {
			await client.disconnect();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});
