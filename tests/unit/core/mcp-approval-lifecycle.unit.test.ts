import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import { afterAll, afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig, McpToolDef, McpToolResult } from "../../../src/server/mcp/mcp-types.ts";
import type { MarketplaceMcpResolver } from "../../../src/server/mcp/mcp-manager.ts";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-lifecycle-home-"));
process.env.HOME = path.join(fixtureRoot, "home");
process.env.USERPROFILE = path.join(fixtureRoot, "home");
process.env.BOBBIT_DIR = path.join(fixtureRoot, "headquarters");
fs.mkdirSync(process.env.HOME, { recursive: true });

const { McpManager } = await import("../../../src/server/mcp/mcp-manager.ts");
const { McpApprovalStore } = await import("../../../src/server/mcp/mcp-approval-store.ts");

const temporaryRoots: string[] = [];
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

class StubMcpClient {
	connected = false;
	connectCount = 0;
	disconnectCount = 0;
	listToolsCount = 0;
	callCount = 0;

	constructor(
		readonly name: string,
		private readonly options: {
			tools?: McpToolDef[];
			connectGate?: Promise<void>;
			listToolsGate?: Promise<void>;
		} = {},
	) {}

	async connect(_config: McpServerConfig): Promise<void> {
		this.connectCount += 1;
		if (this.options.connectGate) await this.options.connectGate;
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.disconnectCount += 1;
		this.connected = false;
	}

	async listTools(): Promise<McpToolDef[]> {
		this.listToolsCount += 1;
		if (this.options.listToolsGate) await this.options.listToolsGate;
		return this.options.tools ?? [{ name: "inspect", inputSchema: { type: "object" } }];
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
		private readonly stubs: Map<string, StubMcpClient>,
		opts: {
			projectId?: string;
			approvalStore?: InstanceType<typeof McpApprovalStore>;
			marketplaceResolver?: MarketplaceMcpResolver;
		} = {},
	) {
		super(cwd, undefined, stateDir, opts);
	}

	protected _createClient(name: string): any {
		this.createCount += 1;
		const stub = this.stubs.get(name);
		if (!stub) throw new Error(`Unexpected client creation for ${name}`);
		return stub;
	}
}

function temporaryCase() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-lifecycle-"));
	temporaryRoots.push(root);
	const cwd = path.join(root, "project");
	const stateDir = path.join(root, "state");
	fs.mkdirSync(cwd, { recursive: true });
	return { root, cwd, stateDir };
}

function writeProjectConfig(cwd: string, servers: Record<string, unknown>): void {
	fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}

async function decideCurrent(manager: any, name: string, decision: "approved" | "rejected") {
	const current = manager.getEffectiveDefinitionForDecision(name);
	assert.ok(current);
	assert.ok(current.approval.fingerprint);
	return manager.decideApproval({
		projectId: current.origin.projectId,
		sourceId: current.origin.sourceId,
		serverName: name,
		fingerprint: current.approval.fingerprint,
	}, decision);
}

describe("MCP approval lifecycle gate", () => {
	it("never creates a client for pending or rejected project definitions", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node", args: ["server.js"] } });
		const stub = new StubMcpClient("repository");
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;

		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(manager.createCount, 0);
		assert.equal(stub.connectCount, 0);
		assert.deepEqual(manager.getServerStatuses()[0].diagnostics, [{
			code: "MCP_APPROVAL_PENDING",
			message: "Server startup is awaiting approval.",
		}]);

		await decideCurrent(manager, "repository", "rejected");
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(manager.createCount, 0);
		assert.equal(manager.getServerStatuses()[0].approval.state, "rejected");
		assert.equal(manager.getServerStatuses()[0].status, "disconnected");
	});

	it("connects only after approval, disconnects and clears routes on change, and reuses exact approval on revert", async () => {
		const { cwd, stateDir } = temporaryCase();
		const original = { command: "node", args: ["server.js"] };
		writeProjectConfig(cwd, { repository: original });
		const stub = new StubMcpClient("repository");
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;

		await decideCurrent(manager, "repository", "approved");
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(stub.connectCount, 1);
		assert.equal(stub.listToolsCount, 1);
		assert.equal(manager.getServerStatuses()[0].approval.state, "approved");
		assert.equal(manager.getServerStatuses()[0].status, "connected");
		assert.deepEqual(manager.getToolInfos().map((tool: any) => tool.name), ["mcp__repository__inspect"]);

		writeProjectConfig(cwd, { repository: { command: "node", args: ["changed.js"] } });
		const changed = await manager.reloadDiscoveredServers({ timeoutMs: 0 });
		assert.deepEqual(changed.disconnected, ["repository"]);
		assert.equal(stub.disconnectCount, 1);
		assert.equal(manager.getServerStatuses()[0].approval.state, "changed");
		assert.equal(manager.getServerStatuses()[0].status, "disconnected");
		assert.deepEqual(manager.getToolInfos(), []);

		writeProjectConfig(cwd, { repository: original });
		await manager.reloadDiscoveredServers({ timeoutMs: 0 });
		assert.equal(stub.connectCount, 2);
		assert.equal(manager.getServerStatuses()[0].approval.state, "approved");
	});

	it("revalidates the effective definition before a cached tool route can send data", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node", args: ["approved.js"] } });
		const stub = new StubMcpClient("repository");
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;
		await decideCurrent(manager, "repository", "approved");
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.deepEqual(manager.getToolInfos().map((tool: any) => tool.name), ["mcp__repository__inspect"]);

		writeProjectConfig(cwd, { repository: { command: "node", args: ["changed.js"] } });
		await assert.rejects(
			manager.callTool("mcp__repository__inspect", {}),
			/MCP server "repository" is not approved to run/,
		);

		assert.equal(stub.callCount, 0);
		assert.equal(stub.disconnectCount, 1);
		assert.deepEqual(manager.getToolInfos(), []);
		const status = manager.getServerStatuses()[0];
		assert.equal(status.approval.state, "changed");
		assert.equal(status.status, "disconnected");
	});

	it("disconnects and forgets runtime tools when an approved definition is removed", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node" } });
		const stub = new StubMcpClient("repository");
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;
		await decideCurrent(manager, "repository", "approved");
		await manager.reloadDiscoveredServers({ timeoutMs: 0 });
		fs.rmSync(path.join(cwd, ".mcp.json"));

		const removed = await manager.reloadDiscoveredServers({ timeoutMs: 0 });
		assert.deepEqual(removed.disconnected, ["repository"]);
		assert.equal(stub.disconnectCount, 1);
		assert.deepEqual(manager.getServerStatuses(), []);
		assert.deepEqual(manager.getToolInfos(), []);
	});

	it("rejects stale fingerprint and source decisions without changing runtime eligibility", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node", args: ["first.js"] } });
		const manager = new TestMcpManager(cwd, stateDir, new Map(), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;
		const reviewed = manager.getEffectiveDefinitionForDecision("repository");
		assert.ok(reviewed?.approval.fingerprint);
		writeProjectConfig(cwd, { repository: { command: "node", args: ["second.js"] } });

		await assert.rejects(
			manager.decideApproval({
				projectId: "project-1",
				sourceId: reviewed.origin.sourceId,
				serverName: "repository",
				fingerprint: reviewed.approval.fingerprint,
			}, "approved"),
			(error: Error & { code?: string }) => error.code === "MCP_APPROVAL_STALE",
		);
		await assert.rejects(
			manager.decideApproval({
				projectId: "project-1",
				sourceId: "different-source",
				serverName: "repository",
				fingerprint: manager.getEffectiveDefinitionForDecision("repository").approval.fingerprint,
			}, "approved"),
			(error: Error & { code?: string }) => error.code === "MCP_APPROVAL_STALE",
		);
		assert.equal(manager.getEffectiveDefinitionForDecision("repository").approval.state, "pending");
		assert.equal(manager.createCount, 0);
	});

	it("does not let connectServer or restartDiscoveredServer bypass pending approval", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node" } });
		const stub = new StubMcpClient("repository");
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;
		manager.discoverConnectionGroups();

		await manager.connectServer("repository", { command: "attacker-supplied-fallback" });
		await manager.restartDiscoveredServer("repository");
		assert.equal(manager.createCount, 0);
		assert.equal(stub.connectCount, 0);
		assert.equal(manager.getServerStatuses()[0].approval.state, "pending");
	});

	it("never creates clients for invalid winners and refuses decisions for them", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { invalid: { command: "node", url: "https://example.test/mcp" } });
		const manager = new TestMcpManager(cwd, stateDir, new Map(), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;

		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(manager.createCount, 0);
		const status = manager.getServerStatuses()[0];
		assert.equal(status.status, "disconnected");
		assert.equal(status.approval.state, "pending");
		assert.equal(status.approval.fingerprint, undefined);
		assert.equal(status.diagnostics[0].code, "MCP_CONFIG_INVALID");
		await assert.rejects(
			manager.decideApproval({
				projectId: "project-1",
				sourceId: status.source.sourceId,
				serverName: "invalid",
				fingerprint: "not-valid",
			}, "approved"),
			(error: Error & { code?: string }) => error.code === "MCP_CONFIG_INVALID",
		);
	});

	it("connects pretrusted Marketplace definitions without a second approval", async () => {
		const { cwd, stateDir } = temporaryCase();
		const stub = new StubMcpClient("installed");
		const manager = new TestMcpManager(cwd, stateDir, new Map([["installed", stub]]), {
			projectId: "project-1",
			marketplaceResolver: () => [{
				listName: "installed",
				serverName: "installed",
				config: { command: "installed" },
				origin: { scope: "project", packId: "pack-1" },
			}],
		}) as any;

		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(manager.createCount, 1);
		assert.equal(stub.connectCount, 1);
		assert.equal(manager.getServerStatuses()[0].approval.state, "trusted");
		assert.equal(manager.getServerStatuses()[0].approval.required, false);
	});

	it("rediscovers after initialize so a changed definition cannot list or publish tools", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node", args: ["approved.js"] } });
		let releaseConnect!: () => void;
		const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
		const stub = new StubMcpClient("repository", { connectGate });
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;
		await decideCurrent(manager, "repository", "approved");

		const activeReload = manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(stub.connectCount, 1);
		writeProjectConfig(cwd, { repository: { command: "node", args: ["changed.js"] } });
		releaseConnect();
		await activeReload;

		assert.equal(stub.disconnectCount, 1);
		assert.equal(stub.listToolsCount, 0);
		assert.deepEqual(manager.getToolInfos(), []);
		const status = manager.getServerStatuses()[0];
		assert.equal(status.approval.state, "changed");
		assert.equal(status.status, "disconnected");
	});

	it("rediscovers before publication so a definition changed during tools/list cannot publish routes", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node", args: ["approved.js"] } });
		let releaseListTools!: () => void;
		const listToolsGate = new Promise<void>((resolve) => { releaseListTools = resolve; });
		const stub = new StubMcpClient("repository", { listToolsGate });
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;
		await decideCurrent(manager, "repository", "approved");

		const activeReload = manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		while (stub.listToolsCount === 0) await new Promise((resolve) => setTimeout(resolve, 0));
		writeProjectConfig(cwd, { repository: { command: "node", args: ["changed.js"] } });
		releaseListTools();
		await activeReload;

		assert.equal(stub.disconnectCount, 1);
		assert.equal(stub.listToolsCount, 1);
		assert.deepEqual(manager.getToolInfos(), []);
		assert.equal(manager.getServerStatuses()[0].approval.state, "changed");
	});

	it("rediscovers after initialize so a removed definition cannot list or publish tools", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node" } });
		let releaseConnect!: () => void;
		const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
		const stub = new StubMcpClient("repository", { connectGate });
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;
		await decideCurrent(manager, "repository", "approved");

		const activeReload = manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(stub.connectCount, 1);
		fs.rmSync(path.join(cwd, ".mcp.json"));
		releaseConnect();
		await activeReload;

		assert.equal(stub.disconnectCount, 1);
		assert.equal(stub.listToolsCount, 0);
		assert.deepEqual(manager.getToolInfos(), []);
		assert.deepEqual(manager.getServerStatuses(), []);
	});

	it("rechecks approval after initialize and a queued reload cannot publish tools rejected concurrently", async () => {
		const { cwd, stateDir } = temporaryCase();
		writeProjectConfig(cwd, { repository: { command: "node" } });
		let releaseConnect!: () => void;
		const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
		const stub = new StubMcpClient("repository", { connectGate });
		const manager = new TestMcpManager(cwd, stateDir, new Map([["repository", stub]]), {
			projectId: "project-1",
			approvalStore: new McpApprovalStore(stateDir),
		}) as any;
		await decideCurrent(manager, "repository", "approved");

		const activeReload = manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(stub.connectCount, 1);
		await decideCurrent(manager, "repository", "rejected");
		const queuedReload = manager.reloadDiscoveredServers({ force: true, queueIfInFlight: true, timeoutMs: 0 });
		releaseConnect();
		await Promise.all([activeReload, queuedReload]);

		assert.equal(stub.disconnectCount, 1);
		assert.equal(stub.listToolsCount, 0);
		assert.deepEqual(manager.getToolInfos(), []);
		const status = manager.getServerStatuses()[0];
		assert.equal(status.approval.state, "rejected");
		assert.equal(status.status, "disconnected");
	});
});
