import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import { afterAll, afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectConfigReader } from "../../../src/server/agent/config-directories.ts";
import type { MarketplaceMcpResolver, McpServerStatus } from "../../../src/server/mcp/mcp-manager.ts";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-project-provenance-"));
const fixtureHome = path.join(fixtureRoot, "home");
const fixtureHeadquarters = path.join(fixtureRoot, "headquarters");

// Windows resolves os.homedir() while loading the discovery module graph, so
// establish the isolated roots before importing it rather than only in beforeEach.
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.BOBBIT_DIR = fixtureHeadquarters;
fs.mkdirSync(fixtureHome, { recursive: true });
fs.mkdirSync(fixtureHeadquarters, { recursive: true });

const {
	McpManager,
	canonicalCustomDirLocator,
	redactMcpServerConfig,
	redactRecord,
	redactUrl,
} = await import("../../../src/server/mcp/mcp-manager.ts");
const { McpApprovalStore } = await import("../../../src/server/mcp/mcp-approval-store.ts");

const temporaryRoots: string[] = [];
beforeEach(() => {
	// v2-core reuses module workers with isolation disabled, so another test file
	// may have changed these process-wide discovery roots after this module loaded.
	process.env.HOME = fixtureHome;
	process.env.USERPROFILE = fixtureHome;
	process.env.BOBBIT_DIR = fixtureHeadquarters;
	fs.mkdirSync(fixtureHome, { recursive: true });
	fs.mkdirSync(fixtureHeadquarters, { recursive: true });
});
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const entry of fs.readdirSync(fixtureHome)) fs.rmSync(path.join(fixtureHome, entry), { recursive: true, force: true });
	for (const entry of fs.readdirSync(fixtureHeadquarters)) fs.rmSync(path.join(fixtureHeadquarters, entry), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function temporaryRoot(prefix = "mcp-provenance-case-"): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function writeConfig(file: string, servers: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
}

function reader(directories: Array<{ path: string; types: string[] }> = []): ProjectConfigReader {
	return {
		get: () => undefined,
		getConfigDirectories: () => directories,
	};
}

function byName(statuses: McpServerStatus[]): Record<string, McpServerStatus> {
	return Object.fromEntries(statuses.map((status) => [status.name, status]));
}

describe("MCP source provenance", () => {
	it("classifies every built-in source class and attributes primary and additional project files", () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "primary");
		const additionalCwd = path.join(root, "additional");
		const stateDir = path.join(root, "state");
		const primaryCustom = path.join(root, "primary-custom");
		const additionalCustom = path.join(root, "additional-custom");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(additionalCwd, { recursive: true });

		writeConfig(path.join(cwd, ".mcp.json"), { primaryRoot: { command: "primary-root" } });
		writeConfig(path.join(cwd, ".claude", ".mcp.json"), { primaryClaude: { command: "primary-claude" } });
		writeConfig(path.join(cwd, ".bobbit", "config", "mcp.json"), { primaryBobbit: { command: "primary-bobbit" } });
		writeConfig(path.join(primaryCustom, ".mcp.json"), { primaryCustom: { command: "primary-custom" } });
		writeConfig(path.join(additionalCwd, ".mcp.json"), { additionalRoot: { command: "additional-root" } });
		writeConfig(path.join(additionalCwd, ".claude", ".mcp.json"), { additionalClaude: { command: "additional-claude" } });
		writeConfig(path.join(additionalCwd, ".bobbit", "config", "mcp.json"), { additionalBobbit: { command: "additional-bobbit" } });
		writeConfig(path.join(additionalCustom, ".mcp.json"), { additionalCustom: { command: "additional-custom" } });

		fs.writeFileSync(path.join(fixtureHome, ".claude.json"), JSON.stringify({
			mcpServers: { homeClaude: { command: "home-claude" } },
			projects: { [cwd]: { mcpServers: { homeProjectEntry: { command: "home-project" } } } },
		}));
		writeConfig(path.join(fixtureHome, ".claude", ".mcp.json"), { homeClaudeMcp: { command: "home-claude-mcp" } });
		writeConfig(path.join(fixtureHome, ".bobbit", ".mcp.json"), { homeBobbitMcp: { command: "home-bobbit-mcp" } });
		writeConfig(path.join(fixtureHeadquarters, "config", "mcp.json"), { headquarters: { command: "headquarters" } });

		const marketplaceResolver: MarketplaceMcpResolver = () => [{
			listName: "installed",
			serverName: "marketplace",
			config: { command: "marketplace" },
			origin: { scope: "project", packId: "pack-1", packName: "Installed Pack" },
		}];
		const manager = new McpManager(cwd, reader([{ path: primaryCustom, types: ["mcp"] }]), stateDir, {
			projectId: "primary-id",
			projectName: "Primary Project",
			marketplaceResolver,
			approvalStore: new McpApprovalStore(stateDir),
		});
		manager.setAdditionalProjects([{
			projectId: "additional-id",
			projectName: "Additional Project",
			cwd: additionalCwd,
			configStore: reader([{ path: additionalCustom, types: ["mcp"] }]),
		}]);
		manager.discoverConnectionGroups();
		const statuses = byName(manager.getServerStatuses());

		for (const name of ["primaryRoot", "primaryClaude", "primaryBobbit", "primaryCustom"]) {
			assert.equal(statuses[name].source?.authority, "project", name);
			assert.equal(statuses[name].source?.projectId, "primary-id", name);
			assert.equal(statuses[name].source?.projectName, "Primary Project", name);
			assert.equal(statuses[name].approval?.state, "pending", name);
		}
		assert.equal(statuses.primaryRoot.source?.sourceId, "project-file:.mcp.json");
		assert.equal(statuses.primaryClaude.source?.sourceId, "project-file:.claude/.mcp.json");
		assert.equal(statuses.primaryBobbit.source?.sourceId, "project-file:.bobbit/config/mcp.json");
		assert.match(statuses.primaryCustom.source!.sourceId, /^project-custom-dir:v1:[a-f0-9]{64}:.mcp.json$/);

		for (const name of ["additionalRoot", "additionalClaude", "additionalBobbit", "additionalCustom"]) {
			assert.equal(statuses[name].source?.authority, "project", name);
			assert.equal(statuses[name].source?.projectId, "additional-id", name);
			assert.equal(statuses[name].source?.projectName, "Additional Project", name);
			assert.equal(statuses[name].approval?.state, "pending", name);
		}

		for (const name of ["homeClaude", "homeProjectEntry", "homeClaudeMcp", "homeBobbitMcp"]) {
			assert.equal(statuses[name].source?.authority, "user-home", name);
			assert.equal(statuses[name].approval?.state, "trusted", name);
			assert.equal(statuses[name].approval?.required, false, name);
		}
		assert.equal(statuses.headquarters.source?.authority, "headquarters");
		assert.equal(statuses.headquarters.approval?.state, "trusted");
		assert.equal(statuses.marketplace.source?.authority, "marketplace");
		assert.equal(statuses.marketplace.approval?.state, "trusted");
		assert.ok(statuses.primaryCustom.source?.file?.endsWith("/.mcp.json"));
		assert.equal("path" in statuses.primaryCustom.source!, false);
		assert.equal("path" in statuses.primaryCustom.origin!, false);
	});

	it("applies public-name precedence before approval so a pending project winner blocks a trusted Marketplace fallback", () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		writeConfig(path.join(cwd, ".mcp.json"), { collision: { command: "repository-command" } });
		const manager = new McpManager(cwd, reader(), path.join(root, "state"), {
			projectId: "project-id",
			marketplaceResolver: () => [{
				listName: "collision",
				serverName: "collision",
				config: { command: "trusted-command" },
				origin: { scope: "project", packId: "trusted-pack" },
			}],
		});

		const groups = manager.discoverConnectionGroups();
		assert.equal(groups.length, 1);
		assert.equal(groups[0].config.command, "repository-command");
		const status = manager.getServerStatuses()[0];
		assert.equal(status.source?.authority, "project");
		assert.equal(status.approval?.state, "pending");
	});

	it("attributes parse failures safely while preserving valid sibling sources", () => {
		const root = temporaryRoot();
		const cwd = path.join(root, "project");
		fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ secret-invalid-json");
		writeConfig(path.join(cwd, ".claude", ".mcp.json"), { validSibling: { command: "node" } });
		const manager = new McpManager(cwd, reader(), path.join(root, "state"), { projectId: "project-id" });

		const groups = manager.discoverConnectionGroups();
		assert.deepEqual(groups.map((group) => group.serverName), ["validSibling"]);
		assert.deepEqual(manager.getDiscoveryDiagnostics(), [{
			code: "MCP_CONFIG_PARSE_FAILED",
			message: "Could not parse MCP configuration from .mcp.json.",
		}]);
		assert.doesNotMatch(JSON.stringify(manager.getDiscoveryDiagnostics()), /secret-invalid-json/);
	});
});

describe("safe MCP review metadata", () => {
	it("redacts secret records, URL credentials/query/fragment, credential arguments, and configured secret values", () => {
		process.env.MCP_REDACTION_SECRET = "expanded-secret";
		assert.deepEqual(redactRecord({ ZED: "secret", ALPHA: "secret" }), {
			ALPHA: "[redacted]",
			ZED: "[redacted]",
		});
		assert.equal(redactUrl("https://user:password@example.test/mcp?token=secret#fragment"), "https://example.test/mcp");
		assert.equal(redactUrl("not a url"), "[redacted]");
		assert.deepEqual(redactMcpServerConfig({
			command: "node",
			args: [
				"server.js",
				"--token", "plain-secret",
				"--api-key=inline-secret",
				"${MCP_REDACTION_SECRET}",
				"expanded-secret",
				"--ordinary", "visible",
			],
			cwd: "/safe/workspace",
			env: { TOKEN: "${MCP_REDACTION_SECRET}" },
			headers: { Authorization: "plain-secret" },
		}), {
			transport: "stdio",
			command: "node",
			args: [
				"server.js",
				"--token", "[redacted]",
				"--api-key=[redacted]",
				"[redacted]",
				"[redacted]",
				"--ordinary", "visible",
			],
			cwd: "/safe/workspace",
			env: { TOKEN: "[redacted]" },
			headers: { Authorization: "[redacted]" },
		});
	});

	it("redacts token-delimited key credentials without hiding unrelated names", () => {
		const redacted = redactMcpServerConfig({
			command: "node --private-key unit-command-private-key --access_key=unit-command-access-key --signing-key unit-command-signing-key --monkey command-visible",
			args: [
				"--private-key", "unit-arg-private-key",
				"--access_key=unit-arg-access-key",
				"--signing-key", "unit-arg-signing-key",
				"X-Private-Key: unit-header-private-key",
				"--monkey", "argument-visible",
			],
			headers: { "X-Private-Key": "unit-configured-private-key" },
		});

		assert.equal(redacted.command,
			"node --private-key [redacted] --access_key=[redacted] --signing-key [redacted] --monkey command-visible");
		assert.deepEqual(redacted.args, [
			"--private-key", "[redacted]",
			"--access_key=[redacted]",
			"--signing-key", "[redacted]",
			"X-Private-Key: [redacted]",
			"--monkey", "argument-visible",
		]);
		assert.deepEqual(redacted.headers, { "X-Private-Key": "[redacted]" });
		assert.doesNotMatch(JSON.stringify(redacted), /unit-(?:command|arg|header|configured)-.*-key/);
	});

	it("redacts CLI header forms and secret substrings in argument arrays and command strings", () => {
		const secrets = [
			"unit-command-auth-sentinel",
			"unit-command-cookie-sentinel",
			"unit-command-proxy-sentinel",
			"unit-env-sentinel",
			"unit-header-sentinel",
			"unit-separated-header-sentinel",
			"unit-equals-header-sentinel",
			"unit-short-header-sentinel",
			"unit-short-equals-header-sentinel",
			"unit-attached-header-sentinel",
			"unit-proxy-header-sentinel",
			"unit-proxy-equals-header-sentinel",
			"unit-authorization-sentinel",
			"unit-proxy-authorization-sentinel",
			"unit-cookie-sentinel",
		];
		const redacted = redactMcpServerConfig({
			command: "node relay.js --header \"Authorization: Bearer unit-command-auth-sentinel\" -H'Cookie: unit-command-cookie-sentinel' --proxy-header=unit-command-proxy-sentinel --label prefix-unit-env-sentinel-suffix",
			args: [
				"--header", "Authorization: Bearer unit-separated-header-sentinel",
				"--header=X-Api-Key: unit-equals-header-sentinel",
				"-H", "Cookie: unit-short-header-sentinel",
				"-H=Cookie: unit-short-equals-header-sentinel",
				"-HProxy-Authorization: Basic unit-attached-header-sentinel",
				"--proxy-header", "unit-proxy-header-sentinel",
				"--proxy-header=Proxy-Authorization: Basic unit-proxy-equals-header-sentinel",
				"Authorization: Bearer unit-authorization-sentinel",
				"Proxy-Authorization: Basic unit-proxy-authorization-sentinel",
				"Cookie: session=unit-cookie-sentinel",
				"prefix-unit-env-sentinel-suffix",
				"prefix-unit-header-sentinel-suffix",
			],
			env: { API_TOKEN: "unit-env-sentinel" },
			headers: { "X-Configured-Secret": "unit-header-sentinel" },
		});

		assert.equal(redacted.command,
			"node relay.js --header \"Authorization: [redacted]\" -H'[redacted]' --proxy-header=[redacted] --label prefix-[redacted]-suffix");
		assert.deepEqual(redacted.args, [
			"--header", "Authorization: [redacted]",
			"--header=[redacted]",
			"-H", "Cookie: [redacted]",
			"-H=[redacted]",
			"-H[redacted]",
			"--proxy-header", "[redacted]",
			"--proxy-header=[redacted]",
			"Authorization: [redacted]",
			"Proxy-Authorization: [redacted]",
			"Cookie: [redacted]",
			"prefix-[redacted]-suffix",
			"prefix-[redacted]-suffix",
		]);
		const serialized = JSON.stringify(redacted);
		for (const secret of secrets) assert.doesNotMatch(serialized, new RegExp(secret), secret);
	});

	it("fails closed for malformed CLI argument values without throwing or exposing adjacent secrets", () => {
		const malformed = redactMcpServerConfig({
			command: "node --header malformed-command-secret",
			args: ["--header", 17, "--proxy-header", null, "-H", { secret: "malformed-object-secret" }, "--header"],
			env: { STRING_SECRET: "malformed-command-secret", INVALID_SECRET: 42 },
			headers: { Authorization: "malformed-header-secret", Invalid: false },
		} as any);

		assert.equal(malformed.command, "node --header [redacted]");
		assert.deepEqual(malformed.args, ["--header", "[redacted]", "[redacted]", "[redacted]", "-H", "[redacted]", "[redacted]"]);
		assert.deepEqual(malformed.env, { INVALID_SECRET: "[redacted]", STRING_SECRET: "[redacted]" });
		assert.deepEqual(malformed.headers, { Authorization: "[redacted]", Invalid: "[redacted]" });
		assert.doesNotMatch(JSON.stringify(malformed), /malformed-(?:command|object|header)-secret/);
	});
});

describe("worktree-stable project MCP identity", () => {
	it("normalizes custom directory locators lexically without injecting a checkout root", () => {
		assert.equal(canonicalCustomDirLocator(" ./mcp/../mcp "), "mcp");
		assert.equal(canonicalCustomDirLocator(".\\mcp"), "mcp");
		assert.equal(canonicalCustomDirLocator("~/team/../mcp"), "~/mcp");
		assert.equal(canonicalCustomDirLocator("relative/mcp"), "relative/mcp");
		assert.equal(path.isAbsolute(canonicalCustomDirLocator("relative/mcp")), false);
	});

	it("reuses approvals for identical standard definitions across worktree roots and requires review for changed content", async () => {
		const root = temporaryRoot();
		const firstRoot = path.join(root, "root-checkout");
		const secondRoot = path.join(root, "worktree-checkout");
		const stateDir = path.join(root, "state");
		writeConfig(path.join(firstRoot, ".mcp.json"), { same: { command: "node", args: ["same.js"] } });
		writeConfig(path.join(secondRoot, ".mcp.json"), { same: { command: "node", args: ["same.js"] } });
		const store = new McpApprovalStore(stateDir);
		const first = new McpManager(firstRoot, reader(), stateDir, { projectId: "stable-project", approvalStore: store });
		const pending = first.getEffectiveDefinitionForDecision("same")!;
		await first.decideApproval({
			projectId: "stable-project",
			sourceId: pending.origin.sourceId!,
			serverName: "same",
			fingerprint: pending.approval.fingerprint!,
		}, "approved");

		const second = new McpManager(secondRoot, reader(), stateDir, { projectId: "stable-project", approvalStore: store });
		assert.equal(second.getEffectiveDefinitionForDecision("same")?.approval.state, "approved");
		writeConfig(path.join(secondRoot, ".mcp.json"), { same: { command: "node", args: ["changed.js"] } });
		assert.equal(second.getEffectiveDefinitionForDecision("same")?.approval.state, "changed");
	});

	it("uses the canonical custom declaration rather than runtime or worktree paths for source identity", async () => {
		const root = temporaryRoot();
		const firstRoot = path.join(root, "root-checkout");
		const secondRoot = path.join(root, "worktree-checkout");
		const customDir = path.join(root, "shared-custom");
		const otherCustomDir = path.join(root, "other-custom");
		const stateDir = path.join(root, "state");
		fs.mkdirSync(firstRoot, { recursive: true });
		fs.mkdirSync(secondRoot, { recursive: true });
		writeConfig(path.join(customDir, ".mcp.json"), { custom: { command: "node", args: ["same.js"] } });
		writeConfig(path.join(otherCustomDir, ".mcp.json"), { custom: { command: "node", args: ["same.js"] } });
		const declared = path.relative(process.cwd(), customDir).replace(/\\/g, "/");
		const store = new McpApprovalStore(stateDir);
		const first = new McpManager(firstRoot, reader([{ path: declared, types: ["mcp"] }]), stateDir, {
			projectId: "stable-project",
			approvalStore: store,
		});
		const pending = first.getEffectiveDefinitionForDecision("custom")!;
		await first.decideApproval({
			projectId: "stable-project",
			sourceId: pending.origin.sourceId!,
			serverName: "custom",
			fingerprint: pending.approval.fingerprint!,
		}, "approved");

		// path.relative() returns an absolute path when the temp and checkout roots
		// are on different Windows drives; only relative declarations accept `./`.
		const equivalentDeclared = path.isAbsolute(declared) ? declared : `./${declared}`;
		const equivalent = new McpManager(secondRoot, reader([{ path: equivalentDeclared, types: ["mcp"] }]), stateDir, {
			projectId: "stable-project",
			approvalStore: store,
		});
		const equivalentDefinition = equivalent.getEffectiveDefinitionForDecision("custom")!;
		assert.equal(equivalentDefinition.origin.sourceId, pending.origin.sourceId);
		assert.equal(equivalentDefinition.approval.state, "approved");

		writeConfig(path.join(customDir, ".mcp.json"), { custom: { command: "node", args: ["changed.js"] } });
		assert.equal(equivalent.getEffectiveDefinitionForDecision("custom")?.approval.state, "changed");

		const otherDeclared = path.relative(process.cwd(), otherCustomDir).replace(/\\/g, "/");
		const different = new McpManager(secondRoot, reader([{ path: otherDeclared, types: ["mcp"] }]), stateDir, {
			projectId: "stable-project",
			approvalStore: store,
		});
		const differentDefinition = different.getEffectiveDefinitionForDecision("custom")!;
		assert.notEqual(differentDefinition.origin.sourceId, pending.origin.sourceId);
		assert.equal(differentDefinition.approval.state, "pending");
	});
});
