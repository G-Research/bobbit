import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	MarketplaceMcpInstallAttestationStore,
	marketplaceMcpBehaviorFingerprint,
	type MarketplaceMcpInstallIdentity,
} from "../../../src/server/mcp/marketplace-mcp-install-attestation.ts";
import type { McpServerConfig } from "../../../src/server/mcp/mcp-types.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporarySecretsDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-mcp-attestation-"));
	roots.push(root);
	return root;
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

function identity(overrides: Partial<MarketplaceMcpInstallIdentity> = {}): MarketplaceMcpInstallIdentity {
	return {
		projectId: "project-a",
		sourceId: "approved-source",
		packName: "trusted-pack",
		contributionId: "local",
		serverName: "local-runtime",
		config: stdioConfig,
		...overrides,
	};
}

function attest(store: MarketplaceMcpInstallAttestationStore): void {
	store.replacePack("project-a", "approved-source", "trusted-pack", [
		{ contributionId: "local", serverName: "local-runtime", config: stdioConfig },
		{ contributionId: "remote", serverName: "remote-runtime", config: httpConfig },
	]);
}

describe("Marketplace MCP install attestations", () => {
	it("binds pretrust to the exact server-private project/source/pack/contribution tuple", () => {
		const secretsDir = temporarySecretsDir();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		expect(store.classify(identity())).toBe("missing");

		attest(store);
		const reloaded = new MarketplaceMcpInstallAttestationStore(secretsDir);
		expect(reloaded.classify(identity())).toBe("attested");

		for (const copiedOrForged of [
			identity({ projectId: "copied-project" }),
			identity({ sourceId: "forged-source" }),
			identity({ packName: "copied-pack" }),
			identity({ contributionId: "forged-contribution" }),
			identity({ serverName: "forged-runtime" }),
		]) {
			expect(reloaded.classify(copiedOrForged)).toBe("missing");
		}
	});

	it("invalidates every execution- and connection-relevant behavior change", () => {
		const store = new MarketplaceMcpInstallAttestationStore(temporarySecretsDir());
		attest(store);

		const stdioMutations: McpServerConfig[] = [
			{ ...stdioConfig, command: "different-node" },
			{ ...stdioConfig, args: [...(stdioConfig.args ?? []), "--write"] },
			{ ...stdioConfig, cwd: "/different/pack" },
			{ ...stdioConfig, env: { ...stdioConfig.env, API_TOKEN: "changed-secret" } },
		];
		for (const config of stdioMutations) {
			expect(store.classify(identity({ config }))).toBe("changed");
		}

		const remoteIdentity = identity({ contributionId: "remote", serverName: "remote-runtime", config: httpConfig });
		expect(store.classify(remoteIdentity)).toBe("attested");
		expect(store.classify({ ...remoteIdentity, config: { ...httpConfig, url: "https://other.example.test/mcp" } })).toBe("changed");
		expect(store.classify({ ...remoteIdentity, config: { ...httpConfig, headers: { ...httpConfig.headers, Authorization: "Bearer changed-secret" } } })).toBe("changed");
	});

	it("persists only fingerprints, survives restart, and removes attestations on uninstall", () => {
		const secretsDir = temporarySecretsDir();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		attest(store);

		const persisted = fs.readFileSync(store.ledgerPath, "utf8");
		expect(persisted).not.toContain("stdio-raw-secret");
		expect(persisted).not.toContain("http-raw-secret");
		expect(persisted).not.toContain("Authorization");
		expect(persisted).not.toContain("mcp.example.test");
		expect(JSON.parse(persisted).attestations).toEqual(expect.arrayContaining([
			expect.objectContaining({
				projectId: "project-a",
				sourceId: "approved-source",
				packName: "trusted-pack",
				fingerprint: marketplaceMcpBehaviorFingerprint(stdioConfig),
			}),
		]));
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).classify(identity())).toBe("attested");

		store.removePack("project-a", "trusted-pack");
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).classify(identity())).toBe("missing");
		expect(JSON.parse(fs.readFileSync(store.ledgerPath, "utf8")).attestations).toEqual([]);
	});

	it("fails closed on a corrupt ledger without logging its contents and recovers only through a real replace", () => {
		const secretsDir = temporarySecretsDir();
		const ledgerPath = path.join(secretsDir, "marketplace-mcp-install-attestations.json");
		fs.writeFileSync(ledgerPath, '{"rawSecret":"must-not-be-logged", broken', "utf8");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		expect(store.classify(identity())).toBe("missing");
		expect(error).toHaveBeenCalledWith("[mcp] MARKETPLACE_MCP_ATTESTATION_INVALID");
		expect(JSON.stringify(error.mock.calls)).not.toContain("must-not-be-logged");

		attest(store);
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).classify(identity())).toBe("attested");
	});
});
