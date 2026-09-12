import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import { afterAll, afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig } from "../../../src/server/mcp/mcp-types.ts";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-header-home-"));
process.env.HOME = path.join(fixtureRoot, "home");
process.env.USERPROFILE = path.join(fixtureRoot, "home");
process.env.BOBBIT_DIR = path.join(fixtureRoot, "headquarters");
fs.mkdirSync(process.env.HOME, { recursive: true });

const { McpManager } = await import("../../../src/server/mcp/mcp-manager.ts");
const {
	McpApprovalStore,
	validateMcpServerConfig,
} = await import("../../../src/server/mcp/mcp-approval-store.ts");

const temporaryRoots: string[] = [];
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function temporaryCase(): { cwd: string; stateDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-header-"));
	temporaryRoots.push(root);
	const cwd = path.join(root, "project");
	const stateDir = path.join(root, "state");
	fs.mkdirSync(cwd, { recursive: true });
	return { cwd, stateDir };
}

class RecordingMcpManager extends (McpManager as any) {
	createCount = 0;

	constructor(cwd: string, stateDir: string, approvalStore: InstanceType<typeof McpApprovalStore>) {
		super(cwd, undefined, stateDir, { projectId: "project-1", approvalStore });
	}

	protected _createClient(): never {
		this.createCount += 1;
		throw new Error("Invalid MCP configuration must not create a client.");
	}
}

const duplicateHeaderError = "Header names must be unique case-insensitively.";

describe("MCP approval header validation", () => {
	it("rejects case-insensitive duplicate names in both insertion orders without exposing values", () => {
		const variants = [
			{ Authorization: "first-secret", authorization: "second-secret" },
			{ authorization: "second-secret", Authorization: "first-secret" },
		];

		for (const headers of variants) {
			const error = validateMcpServerConfig({ url: "https://example.test/mcp", headers });
			assert.equal(error, duplicateHeaderError);
			assert.doesNotMatch(error!, /first-secret|second-secret/);
		}
		assert.equal(validateMcpServerConfig({ command: "node", headers: variants[0] }), duplicateHeaderError);
	});

	it("accepts distinct header names", () => {
		assert.equal(validateMcpServerConfig({
			url: "https://example.test/mcp",
			headers: {
				Authorization: "first-secret",
				"X-Authorization": "second-secret",
			},
		}), undefined);
	});

	it("keeps a duplicate-header definition ineligible despite a persisted matching approval", async () => {
		const { cwd, stateDir } = temporaryCase();
		const config: McpServerConfig = {
			url: "https://example.test/mcp",
			headers: { Authorization: "first-secret", authorization: "second-secret" },
		};
		const initialStore = new McpApprovalStore(stateDir);
		const fingerprint = initialStore.fingerprint(config);
		assert.ok(fingerprint);
		await initialStore.decide({
			projectId: "project-1",
			sourceId: "project-file:.mcp.json",
			serverName: "repository",
			fingerprint,
		}, "approved");
		fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { repository: config } }));

		const manager = new RecordingMcpManager(cwd, stateDir, new McpApprovalStore(stateDir)) as any;
		await manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });

		assert.equal(manager.createCount, 0);
		const status = manager.getServerStatuses()[0];
		assert.equal(status.status, "disconnected");
		assert.equal(status.approval.state, "pending");
		assert.equal(status.approval.fingerprint, undefined);
		assert.equal(status.diagnostics[0].code, "MCP_CONFIG_INVALID");
		assert.equal(status.diagnostics[0].message, duplicateHeaderError);
		assert.doesNotMatch(status.diagnostics[0].message, /first-secret|second-secret/);
		await assert.rejects(
			manager.decideApproval({
				projectId: "project-1",
				sourceId: status.source.sourceId,
				serverName: "repository",
				fingerprint,
			}, "approved"),
			(error: Error & { code?: string }) => error.code === "MCP_CONFIG_INVALID" && error.message === duplicateHeaderError,
		);
	});
});
