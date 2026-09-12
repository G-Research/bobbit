import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	MarketplaceMcpInstallAttestationStore,
	MarketplaceMcpPackIntegrityError,
	measureMarketplaceMcpPackIntegrity,
	type MarketplaceMcpInstallIdentity,
} from "../../../src/server/mcp/marketplace-mcp-install-attestation.ts";
import { McpApprovalStore } from "../../../src/server/mcp/mcp-approval-store.ts";
import type { McpServerConfig } from "../../../src/server/mcp/mcp-types.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label = "marketplace-mcp-attestation-"): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
	roots.push(root);
	return root;
}

function makePack(root = temporaryRoot()): string {
	const packRoot = path.join(root, "trusted-pack");
	fs.mkdirSync(path.join(packRoot, "mcp"), { recursive: true });
	fs.writeFileSync(path.join(packRoot, "pack.yaml"), "name: trusted-pack\nversion: 1\n");
	fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'one';\n");
	fs.writeFileSync(path.join(packRoot, "mcp", "local.yaml"), "transport:\n  type: stdio\n  command: node\n");
	return packRoot;
}

const stdioConfig: McpServerConfig = {
	command: "node",
	args: ["server.mjs", "--token", "stdio-raw-secret"],
	cwd: "/installed/pack",
	env: { API_TOKEN: "stdio-raw-secret", MODE: "read-only" },
};
const httpConfig: McpServerConfig = {
	url: "https://user:password@mcp.example.test/api?token=http-raw-secret",
	headers: { Authorization: "Bearer http-raw-secret", "X-Tenant": "docs" },
};

function identity(packRoot: string, overrides: Partial<MarketplaceMcpInstallIdentity> = {}): MarketplaceMcpInstallIdentity {
	return {
		projectId: "project-a",
		sourceId: "approved-source",
		packName: "trusted-pack",
		contributionId: "local",
		serverName: "local-runtime",
		config: stdioConfig,
		packIntegrity: measureMarketplaceMcpPackIntegrity(packRoot),
		...overrides,
	};
}

function attest(store: MarketplaceMcpInstallAttestationStore, packRoot: string): void {
	store.replacePack("project-a", "approved-source", "trusted-pack", packRoot, [
		{ contributionId: "local", serverName: "local-runtime", config: stdioConfig },
		{ contributionId: "remote", serverName: "remote-runtime", config: httpConfig },
	]);
}

describe("Marketplace MCP install attestations", () => {
	it("binds pretrust to the exact server-private project/source/pack/contribution tuple and complete pack", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		expect(store.classify(identity(packRoot))).toBe("missing");

		attest(store, packRoot);
		const reloaded = new MarketplaceMcpInstallAttestationStore(secretsDir);
		expect(reloaded.classify(identity(packRoot))).toBe("attested");

		for (const copiedOrForged of [
			identity(packRoot, { projectId: "copied-project" }),
			identity(packRoot, { sourceId: "forged-source" }),
			identity(packRoot, { packName: "copied-pack" }),
			identity(packRoot, { contributionId: "forged-contribution" }),
			identity(packRoot, { serverName: "forged-runtime" }),
		]) {
			expect(reloaded.classify(copiedOrForged)).toBe("missing");
		}

		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'two';\n");
		expect(reloaded.classify(identity(packRoot))).toBe("changed");
	});

	it("invalidates every execution- and connection-relevant behavior change", () => {
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(temporaryRoot());
		attest(store, packRoot);

		const stdioMutations: McpServerConfig[] = [
			{ ...stdioConfig, command: "different-node" },
			{ ...stdioConfig, args: [...(stdioConfig.args ?? []), "--write"] },
			{ ...stdioConfig, cwd: "/different/pack" },
			{ ...stdioConfig, env: { ...stdioConfig.env, API_TOKEN: "changed-secret" } },
		];
		for (const config of stdioMutations) expect(store.classify(identity(packRoot, { config }))).toBe("changed");

		const remoteIdentity = identity(packRoot, { contributionId: "remote", serverName: "remote-runtime", config: httpConfig });
		expect(store.classify(remoteIdentity)).toBe("attested");
		expect(store.classify({ ...remoteIdentity, config: { ...httpConfig, url: "https://other.example.test/mcp" } })).toBe("changed");
		expect(store.classify({ ...remoteIdentity, config: { ...httpConfig, headers: { ...httpConfig.headers, Authorization: "Bearer changed-secret" } } })).toBe("changed");
	});

	it("persists only keyed opaque fingerprints and rejects legacy config-only schema", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		attest(store, packRoot);

		const persisted = fs.readFileSync(store.ledgerPath, "utf8");
		const integrity = measureMarketplaceMcpPackIntegrity(packRoot);
		expect(persisted).not.toContain("stdio-raw-secret");
		expect(persisted).not.toContain("http-raw-secret");
		expect(persisted).not.toContain("Authorization");
		expect(persisted).not.toContain("mcp.example.test");
		expect(persisted).not.toContain(packRoot);
		expect(persisted).not.toContain(integrity);
		expect(JSON.parse(persisted)).toMatchObject({ schema: 2 });
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).classify(identity(packRoot))).toBe("attested");

		fs.writeFileSync(store.ledgerPath, JSON.stringify({ schema: 1, attestations: JSON.parse(persisted).attestations }));
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).classify(identity(packRoot))).toBe("missing");
	});

	it("measures canonical entry types, executable mode, bytes, and safe internal link targets", () => {
		const packRoot = makePack();
		const before = measureMarketplaceMcpPackIntegrity(packRoot);
		fs.mkdirSync(path.join(packRoot, "lib"));
		fs.writeFileSync(path.join(packRoot, "lib", "module.mjs"), "export default 1;\n", { mode: 0o644 });
		const withFile = measureMarketplaceMcpPackIntegrity(packRoot);
		expect(withFile).not.toBe(before);

		if (process.platform !== "win32") {
			fs.chmodSync(path.join(packRoot, "lib", "module.mjs"), 0o755);
			expect(measureMarketplaceMcpPackIntegrity(packRoot)).not.toBe(withFile);
		}

		try {
			fs.symlinkSync(path.join("lib", "module.mjs"), path.join(packRoot, "module-link.mjs"), "file");
		} catch {
			return;
		}
		const withLink = measureMarketplaceMcpPackIntegrity(packRoot);
		fs.rmSync(path.join(packRoot, "module-link.mjs"));
		fs.symlinkSync(path.join("mcp", "local.yaml"), path.join(packRoot, "module-link.mjs"), "file");
		expect(measureMarketplaceMcpPackIntegrity(packRoot)).not.toBe(withLink);
	});

	it("fails closed for escaping/cyclic links and bounded incomplete measurements", () => {
		const packRoot = makePack();
		try {
			fs.symlinkSync(path.join("..", "outside.mjs"), path.join(packRoot, "escape.mjs"), "file");
		} catch {
			return;
		}
		expect(() => measureMarketplaceMcpPackIntegrity(packRoot)).toThrow(MarketplaceMcpPackIntegrityError);
		fs.rmSync(path.join(packRoot, "escape.mjs"));
		fs.symlinkSync("b", path.join(packRoot, "a"));
		fs.symlinkSync("a", path.join(packRoot, "b"));
		expect(() => measureMarketplaceMcpPackIntegrity(packRoot)).toThrow(MarketplaceMcpPackIntegrityError);
		fs.rmSync(path.join(packRoot, "a"));
		fs.rmSync(path.join(packRoot, "b"));
		expect(() => measureMarketplaceMcpPackIntegrity(packRoot, { maxEntries: 1 })).toThrow(MarketplaceMcpPackIntegrityError);
		expect(() => measureMarketplaceMcpPackIntegrity(packRoot, { maxBytes: 1 })).toThrow(MarketplaceMcpPackIntegrityError);
	});

	it("does not replace a prior attestation when the published tree differs from the staged measurement", () => {
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(temporaryRoot());
		attest(store, packRoot);
		const stagedIntegrity = measureMarketplaceMcpPackIntegrity(packRoot);
		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'raced';\n");
		expect(() => store.replacePack("project-a", "approved-source", "trusted-pack", packRoot, [
			{ contributionId: "local", serverName: "local-runtime", config: stdioConfig },
		], stagedIntegrity)).toThrow(MarketplaceMcpPackIntegrityError);
		expect(store.classify(identity(packRoot))).toBe("changed");
		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'one';\n");
		expect(store.classify(identity(packRoot))).toBe("attested");
	});

	it("binds each changed pack revision into a new opaque approval fingerprint", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const approval = new McpApprovalStore(secretsDir);
		const firstIntegrity = measureMarketplaceMcpPackIntegrity(packRoot);
		const first = approval.fingerprint(stdioConfig, firstIntegrity);
		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'two';\n");
		const secondIntegrity = measureMarketplaceMcpPackIntegrity(packRoot);
		const second = approval.fingerprint(stdioConfig, secondIntegrity);
		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'three';\n");
		const third = approval.fingerprint(stdioConfig, measureMarketplaceMcpPackIntegrity(packRoot));
		expect(new Set([first, second, third]).size).toBe(3);
	});

	it("removes attestations and recovers from corrupt storage only through a real replace", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		attest(store, packRoot);
		store.removePack("project-a", "trusted-pack");
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).classify(identity(packRoot))).toBe("missing");

		fs.writeFileSync(store.ledgerPath, '{"rawSecret":"must-not-be-logged", broken', "utf8");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const recovered = new MarketplaceMcpInstallAttestationStore(secretsDir);
		expect(recovered.classify(identity(packRoot))).toBe("missing");
		expect(error).toHaveBeenCalledWith("[mcp] MARKETPLACE_MCP_ATTESTATION_INVALID");
		expect(JSON.stringify(error.mock.calls)).not.toContain("must-not-be-logged");
		attest(recovered, packRoot);
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).classify(identity(packRoot))).toBe("attested");
	});
});
