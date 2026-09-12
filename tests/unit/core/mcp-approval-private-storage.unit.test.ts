import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { McpApprovalDefinition } from "../../../src/server/mcp/mcp-approval-store.ts";

const { SessionManager } = await import("../../../src/server/agent/session-manager.ts");
const { mcpApprovalSecretsDir } = await import("../../../src/server/bobbit-dir.ts");
const { McpApprovalStore } = await import("../../../src/server/mcp/mcp-approval-store.ts");

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function approvalDefinition(): McpApprovalDefinition {
	return {
		projectId: "attacker-controlled-project",
		sourceId: "project-file:.mcp.json",
		serverName: "preseeded-server",
		trust: "approval-required",
		config: { command: "node", args: ["repository-server.js"] },
	};
}

function identityFor(store: InstanceType<typeof McpApprovalStore>, definition: McpApprovalDefinition) {
	const fingerprint = store.fingerprint(definition.config);
	assert.ok(fingerprint);
	return {
		projectId: definition.projectId!,
		sourceId: definition.sourceId,
		serverName: definition.serverName,
		fingerprint,
	};
}

describe("private MCP approval storage", () => {
	it("ignores repository-preseeded authority and preserves private decisions across reconstruction", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-private-"));
		roots.push(root);
		const projectRoot = path.join(root, "repository");
		const reachableStateDir = path.join(projectRoot, ".bobbit", "headquarters", "state");
		const privateSecretsRoot = path.join(root, "private-server-secrets");
		process.env.BOBBIT_SECRETS_DIR = privateSecretsRoot;

		// Model an attacker that can write both the historical key and ledger under
		// the repository-reachable Headquarters state directory.
		const attackerStore = new McpApprovalStore(reachableStateDir);
		const definition = approvalDefinition();
		await attackerStore.decide(identityFor(attackerStore, definition), "approved");
		assert.equal(attackerStore.classify(definition).state, "approved");
		const attackerKey = fs.readFileSync(attackerStore.keyPath);
		const attackerLedger = fs.readFileSync(attackerStore.ledgerPath, "utf8");

		const projectContextManager = { all: () => [] };
		const firstManager = new SessionManager({
			stateDir: reachableStateDir,
			projectContextManager: projectContextManager as never,
			mcpReconcileIntervalMs: 0,
		}) as any;
		const privateStore = firstManager.getMcpApprovalStore() as InstanceType<typeof McpApprovalStore>;

		assert.equal(firstManager.getMcpApprovalStore(), privateStore, "one store must be shared for the manager lifetime");
		const firstScopedManager = firstManager.createMcpManager(projectRoot) as any;
		const secondScopedManager = firstManager.createMcpManager(projectRoot) as any;
		assert.equal(firstScopedManager._getApprovalStore(), privateStore);
		assert.equal(secondScopedManager._getApprovalStore(), privateStore, "every MCP manager must receive the shared store");
		assert.equal(privateStore.classify(definition).state, "pending", "reachable approval data must not be imported");
		assert.equal(path.dirname(privateStore.ledgerPath), mcpApprovalSecretsDir());
		assert.equal(path.relative(projectRoot, privateStore.ledgerPath).startsWith(".."), true);
		assert.notDeepEqual(fs.readFileSync(privateStore.keyPath), attackerKey);
		assert.deepEqual(fs.readFileSync(attackerStore.keyPath), attackerKey, "reachable key must not be consumed or changed");
		assert.equal(fs.readFileSync(attackerStore.ledgerPath, "utf8"), attackerLedger, "reachable ledger must not be consumed or changed");

		await privateStore.decide(identityFor(privateStore, definition), "approved");
		assert.equal(privateStore.classify(definition).state, "approved");

		const reconstructedManager = new SessionManager({
			stateDir: reachableStateDir,
			projectContextManager: projectContextManager as never,
			mcpReconcileIntervalMs: 0,
		}) as any;
		const reconstructedStore = reconstructedManager.getMcpApprovalStore() as InstanceType<typeof McpApprovalStore>;
		assert.equal(reconstructedStore.classify(definition).state, "approved", "private approval must survive restart reconstruction");

		if (process.platform !== "win32") {
			assert.equal(fs.statSync(mcpApprovalSecretsDir()).mode & 0o777, 0o700);
			assert.equal(fs.statSync(privateStore.keyPath).mode & 0o777, 0o600);
			assert.equal(fs.statSync(privateStore.ledgerPath).mode & 0o777, 0o600);
		}
	});
});
