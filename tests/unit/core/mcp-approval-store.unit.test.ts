import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig } from "../../../src/server/mcp/mcp-types.ts";
import type { McpApprovalDefinition } from "../../../src/server/mcp/mcp-approval-store.ts";

const {
	McpApprovalStore,
	canonicalMcpServerConfig,
	validateMcpServerConfig,
} = await import("../../../src/server/mcp/mcp-approval-store.ts");

const temporaryRoots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryStateDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-store-"));
	temporaryRoots.push(root);
	return root;
}

function definition(config: McpServerConfig, overrides: Partial<McpApprovalDefinition> = {}): McpApprovalDefinition {
	return {
		projectId: "project-1",
		sourceId: "project-file:.mcp.json",
		serverName: "example",
		trust: "approval-required",
		config,
		...overrides,
	};
}

function identityFor(store: InstanceType<typeof McpApprovalStore>, config: McpServerConfig) {
	const fingerprint = store.fingerprint(config);
	assert.ok(fingerprint);
	return {
		projectId: "project-1",
		sourceId: "project-file:.mcp.json",
		serverName: "example",
		fingerprint,
	};
}

describe("McpApprovalStore canonical fingerprints", () => {
	it("sorts object keys recursively, preserves array order, omits only undefined, and makes defaults explicit", () => {
		const first = {
			command: "node",
			args: ["first", "second"],
			env: { ZED: "z", ALPHA: "a" },
			plugin: { z: 1, a: { y: undefined, x: 2 } },
		} as McpServerConfig;
		const reordered = {
			plugin: { a: { x: 2 }, z: 1 },
			env: { ALPHA: "a", ZED: "z" },
			args: ["first", "second"],
			command: "node",
		} as McpServerConfig;
		const reversedArgs = { ...reordered, args: ["second", "first"] };

		assert.deepEqual(canonicalMcpServerConfig(first), canonicalMcpServerConfig(reordered));
		assert.notDeepEqual(canonicalMcpServerConfig(first), canonicalMcpServerConfig(reversedArgs));
		assert.deepEqual(
			canonicalMcpServerConfig({ command: "node" }),
			canonicalMcpServerConfig({ command: "node", args: [], env: {}, headers: {} }),
		);
	});

	it("invalidates every execution- or connection-relevant field, including unknown fields", () => {
		const store = new McpApprovalStore(temporaryStateDir());
		const base = {
			command: "node",
			args: ["server.js", "--mode", "safe"],
			cwd: "/workspace",
			env: { TOKEN: "alpha" },
			headers: { Authorization: "Bearer alpha" },
			transport: "stdio",
			vendor: { capability: "one" },
		} as McpServerConfig;
		const baseFingerprint = store.fingerprint(base);
		const variants: McpServerConfig[] = [
			{ ...base, command: "bun" },
			{ ...base, args: ["server.js", "--mode", "unsafe"] },
			{ ...base, cwd: "/other" },
			{ ...base, env: { TOKEN: "beta" } },
			{ ...base, env: { RENAMED_TOKEN: "alpha" } },
			{ ...base, headers: { Authorization: "Bearer beta" } },
			{ ...base, headers: { "X-Authorization": "Bearer alpha" } },
			{ ...base, url: "https://example.test/mcp?tenant=one" },
			{ ...base, transport: "custom" } as McpServerConfig,
			{ ...base, vendor: { capability: "two" } } as McpServerConfig,
		];

		for (const variant of variants) assert.notEqual(store.fingerprint(variant), baseFingerprint);
		assert.notEqual(
			store.fingerprint({ url: "https://example.test/mcp?tenant=one" }),
			store.fingerprint({ url: "https://example.test/mcp?tenant=two" }),
		);
	});

	it("fingerprints effective configured environment values but ignores unrelated ambient environment", () => {
		const store = new McpApprovalStore(temporaryStateDir());
		const config = { command: "node", env: { TOKEN: "${MCP_APPROVAL_TEST_SECRET}" } };
		process.env.MCP_APPROVAL_TEST_SECRET = "first-secret";
		const first = store.fingerprint(config);
		process.env.MCP_APPROVAL_UNRELATED = "unrelated-one";
		assert.equal(store.fingerprint(config), first);
		process.env.MCP_APPROVAL_TEST_SECRET = "second-secret";
		assert.notEqual(store.fingerprint(config), first);
	});

	it("uses a Headquarters-local HMAC so identical configuration has unrelated digests under different keys", () => {
		const config = { command: "node", env: { TOKEN: "guessable-secret" } };
		const first = new McpApprovalStore(temporaryStateDir()).fingerprint(config);
		const second = new McpApprovalStore(temporaryStateDir()).fingerprint(config);
		assert.match(first!, /^[a-f0-9]{64}$/);
		assert.match(second!, /^[a-f0-9]{64}$/);
		assert.notEqual(first, second);
		assert.doesNotMatch(first!, /guessable-secret/);
	});
});

describe("McpApprovalStore decisions", () => {
	it("classifies pretrusted definitions without producing approval identity", () => {
		const store = new McpApprovalStore(temporaryStateDir());
		assert.deepEqual(store.classify(definition({ command: "node" }, { trust: "pretrusted" })), {
			required: false,
			state: "trusted",
		});
	});

	it("persists exact approval, reports behavioral changes, reuses reverted definitions, and makes rejection reversible", async () => {
		const stateDir = temporaryStateDir();
		const store = new McpApprovalStore(stateDir);
		const original = { command: "node", args: ["server.js"] };
		const changed = { command: "node", args: ["changed.js"] };
		const identity = identityFor(store, original);

		assert.equal(store.classify(definition(original)).state, "pending");
		await store.decide(identity, "approved");
		assert.equal(store.classify(definition(original)).state, "approved");
		assert.equal(store.classify(definition(changed)).state, "changed");
		assert.equal(store.classify(definition(original)).state, "approved");

		await store.decide(identity, "rejected");
		assert.equal(store.classify(definition(original)).state, "rejected");
		await store.decide(identity, "approved");
		assert.equal(new McpApprovalStore(stateDir).classify(definition(original)).state, "approved");
	});

	it("serializes concurrent decisions without losing distinct rows", async () => {
		const stateDir = temporaryStateDir();
		const store = new McpApprovalStore(stateDir);
		const firstConfig = { command: "first" };
		const secondConfig = { command: "second" };
		const firstIdentity = identityFor(store, firstConfig);
		const secondIdentity = {
			...identityFor(store, secondConfig),
			serverName: "second",
		};

		await Promise.all([
			store.decide(firstIdentity, "approved"),
			store.decide(secondIdentity, "rejected"),
		]);
		const reloaded = new McpApprovalStore(stateDir);
		assert.equal(reloaded.classify(definition(firstConfig)).state, "approved");
		assert.equal(reloaded.classify(definition(secondConfig, { serverName: "second" })).state, "rejected");
	});

	it("persists only opaque identity metadata and never raw configuration or secret values", async () => {
		const stateDir = temporaryStateDir();
		const store = new McpApprovalStore(stateDir);
		const config = {
			command: "secret-command-value",
			args: ["--token", "secret-argument-value"],
			env: { TOKEN: "secret-environment-value" },
			headers: { Authorization: "secret-header-value" },
		};
		await store.decide(identityFor(store, config), "approved");
		const ledger = fs.readFileSync(store.ledgerPath, "utf8");
		for (const secret of ["secret-command-value", "secret-argument-value", "secret-environment-value", "secret-header-value"]) {
			assert.doesNotMatch(ledger, new RegExp(secret));
		}
		assert.deepEqual(Object.keys(JSON.parse(ledger).decisions[0]).sort(), [
			"decidedAt", "decision", "fingerprint", "projectId", "serverName", "sourceId",
		]);
	});

	it("leaves memory and disk unchanged when the atomic rename fails", async () => {
		const stateDir = temporaryStateDir();
		const store = new McpApprovalStore(stateDir);
		const config = { command: "node" };
		const identity = identityFor(store, config);
		await store.decide(identity, "approved");
		const before = fs.readFileSync(store.ledgerPath, "utf8");
		vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("rename denied"), { code: "EACCES" }));

		await assert.rejects(
			store.decide(identity, "rejected"),
			(error: Error & { code?: string }) => error.code === "MCP_APPROVAL_PERSIST_FAILED",
		);
		assert.equal(store.classify(definition(config)).state, "approved");
		assert.equal(fs.readFileSync(store.ledgerPath, "utf8"), before);
		assert.deepEqual(fs.readdirSync(stateDir).filter((name) => name.endsWith(".tmp")), []);
	});

	it("fails closed durably to pending when an existing ledger loses its HMAC key", async () => {
		const stateDir = temporaryStateDir();
		const original = new McpApprovalStore(stateDir);
		const config = { command: "node" };
		const oldFingerprint = identityFor(original, config).fingerprint;
		await original.decide(identityFor(original, config), "approved");
		fs.rmSync(original.keyPath);

		const recovered = new McpApprovalStore(stateDir);
		const classification = recovered.classify(definition(config));
		assert.equal(classification.state, "pending");
		assert.notEqual(classification.fingerprint, oldFingerprint);
		assert.equal(new McpApprovalStore(stateDir).classify(definition(config)).state, "pending");
	});

	it("replaces a corrupt HMAC key and fails closed durably to pending", async () => {
		const stateDir = temporaryStateDir();
		const original = new McpApprovalStore(stateDir);
		const config = { command: "node" };
		const oldFingerprint = identityFor(original, config).fingerprint;
		await original.decide(identityFor(original, config), "approved");
		fs.writeFileSync(original.keyPath, "corrupt");

		const recovered = new McpApprovalStore(stateDir);
		const classification = recovered.classify(definition(config));
		assert.equal(classification.state, "pending");
		assert.notEqual(classification.fingerprint, oldFingerprint);
		assert.equal(fs.readFileSync(recovered.keyPath).length, 32);
		assert.equal(new McpApprovalStore(stateDir).classify(definition(config)).state, "pending");
	});
});

describe("validateMcpServerConfig", () => {
	it("accepts exactly one supported transport and rejects malformed behavior fields", () => {
		assert.equal(validateMcpServerConfig({ command: "node", args: [], env: {}, headers: {} }), undefined);
		assert.equal(validateMcpServerConfig({ url: "https://example.test/mcp" }), undefined);
		for (const invalid of [
			{},
			{ command: "node", url: "https://example.test/mcp" },
			{ command: " " },
			{ url: "file:///tmp/server" },
			{ command: "node", args: [1] },
			{ command: "node", cwd: 1 },
			{ command: "node", env: { A: 1 } },
			{ command: "node", headers: [] },
		]) assert.ok(validateMcpServerConfig(invalid));
	});
});
