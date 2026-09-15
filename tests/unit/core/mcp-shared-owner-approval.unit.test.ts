import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import { afterAll, afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	MarketplaceMcpResolver,
	ResolvedMcpContribution,
} from "../../../src/server/mcp/mcp-manager.ts";
import type {
	McpServerConfig,
	McpToolDef,
	McpToolResult,
} from "../../../src/server/mcp/mcp-types.ts";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shared-owner-approval-home-"));
process.env.HOME = path.join(fixtureRoot, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.BOBBIT_DIR = path.join(fixtureRoot, "headquarters");
fs.mkdirSync(process.env.HOME, { recursive: true });

const { McpManager } = await import("../../../src/server/mcp/mcp-manager.ts");
const { McpApprovalStore } = await import("../../../src/server/mcp/mcp-approval-store.ts");

const temporaryRoots: string[] = [];
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

class RecordingClient {
	connected = false;
	connectCount = 0;
	disconnectCount = 0;
	listToolsCount = 0;
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
		this.listToolsCount += 1;
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
		private readonly client: RecordingClient,
		resolver: MarketplaceMcpResolver,
	) {
		super(cwd, undefined, stateDir, {
			marketplaceResolver: resolver,
			approvalStore: new McpApprovalStore(stateDir),
		});
	}

	protected _createClient(): any {
		this.createCount += 1;
		return this.client;
	}
}

function temporaryCase() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shared-owner-approval-"));
	temporaryRoots.push(root);
	const cwd = path.join(root, "project");
	const stateDir = path.join(root, "state");
	fs.mkdirSync(cwd, { recursive: true });
	return { cwd, stateDir };
}

const sharedConfig: McpServerConfig = { url: "https://mcp.example.test/shared" };

function trustedOwner(): ResolvedMcpContribution {
	return {
		listName: "trusted",
		serverName: "trusted",
		runtimeServerKey: "shared-runtime",
		config: sharedConfig,
		origin: {
			scope: "server",
			authority: "marketplace",
			trust: "pretrusted",
			sourceId: "marketplace:trusted",
			file: "Trusted pack/mcp/trusted.yaml",
		},
	};
}

function projectOwner(projectId: string, sourceId = `project-pack:${projectId}`): ResolvedMcpContribution {
	return {
		listName: `project-${projectId}`,
		serverName: `project-${projectId}`,
		runtimeServerKey: "shared-runtime",
		config: sharedConfig,
		origin: {
			scope: "project",
			authority: "project",
			trust: "approval-required",
			projectId,
			sourceId,
			file: `.bobbit/config/packs/${projectId}/mcp/shared.yaml`,
		},
	};
}

async function approveCurrent(manager: any): Promise<any> {
	const current = manager.getEffectiveDefinitionForDecision("shared-runtime");
	assert.ok(current?.approval.fingerprint);
	return manager.decideApproval({
		projectId: current.origin.projectId,
		sourceId: current.origin.sourceId,
		serverName: current.name,
		fingerprint: current.approval.fingerprint,
	}, "approved");
}

describe("shared MCP runtime owner approvals", () => {
	it("keeps a trusted shared runtime inert until its project owner is approved", async () => {
		const { cwd, stateDir } = temporaryCase();
		const owners = [trustedOwner(), projectOwner("project-a")];
		const client = new RecordingClient();
		const manager = new TestMcpManager(cwd, stateDir, client, () => owners) as any;

		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });

		assert.equal(manager.createCount, 0);
		assert.equal(client.connectCount, 0);
		assert.equal(client.listToolsCount, 0);
		assert.deepEqual(manager.getToolInfos(), []);
		const pending = manager.getServerStatuses()[0];
		assert.equal(pending.approval.state, "pending");
		assert.equal(pending.origin.sourceId, "project-pack:project-a");
		assert.equal(pending.source.projectId, "project-a");

		await approveCurrent(manager);
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });

		assert.equal(manager.createCount, 1);
		assert.equal(client.connectCount, 1);
		assert.equal(client.listToolsCount, 1);
		assert.deepEqual(manager.getToolInfos().map((tool: any) => tool.name).sort(), [
			"mcp__project-project-a__inspect",
			"mcp__trusted__inspect",
		]);
	});

	it("invalidates a live group when an owner is added, changed, or removed", async () => {
		const { cwd, stateDir } = temporaryCase();
		let owners = [trustedOwner()];
		const client = new RecordingClient();
		const manager = new TestMcpManager(cwd, stateDir, client, () => owners) as any;
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.deepEqual(manager.getToolInfos().map((tool: any) => tool.name), ["mcp__trusted__inspect"]);

		owners = [trustedOwner(), projectOwner("project-a")];
		await assert.rejects(
			manager.callTool("mcp__trusted__inspect", {}),
			/MCP server "shared-runtime" is not approved to run/,
		);
		assert.equal(client.callCount, 0);
		assert.equal(client.disconnectCount, 1);
		assert.deepEqual(manager.getToolInfos(), []);

		await approveCurrent(manager);
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		owners = [trustedOwner(), projectOwner("project-a", "project-pack:replacement")];
		await assert.rejects(
			manager.callTool("mcp__trusted__inspect", {}),
			/MCP server "shared-runtime" is not approved to run/,
		);
		assert.equal(client.callCount, 0);
		assert.equal(client.disconnectCount, 2);
		assert.equal(manager.getServerStatuses()[0].origin.sourceId, "project-pack:replacement");

		await approveCurrent(manager);
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		owners = [trustedOwner()];
		await assert.rejects(
			manager.callTool("mcp__trusted__inspect", {}),
			/MCP server "shared-runtime" is not approved to run/,
		);
		assert.equal(client.callCount, 0);
		assert.equal(client.disconnectCount, 3);
		assert.deepEqual(manager.getToolInfos(), []);
	});

	it("requires separate decisions for each pending owner", async () => {
		const { cwd, stateDir } = temporaryCase();
		const owners = [projectOwner("project-a"), projectOwner("project-b")];
		const client = new RecordingClient();
		const manager = new TestMcpManager(cwd, stateDir, client, () => owners) as any;

		assert.equal(manager.getEffectiveDefinitionForDecision("shared-runtime").origin.projectId, "project-a");
		const next = await approveCurrent(manager);
		assert.equal(next.origin.projectId, "project-b");
		assert.equal(next.approval.state, "pending");
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(manager.createCount, 0);

		await approveCurrent(manager);
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
		assert.equal(manager.createCount, 1);
		assert.equal(client.listToolsCount, 1);
		assert.deepEqual(manager.getToolInfos().map((tool: any) => tool.name).sort(), [
			"mcp__project-project-a__inspect",
			"mcp__project-project-b__inspect",
		]);
	});
});
