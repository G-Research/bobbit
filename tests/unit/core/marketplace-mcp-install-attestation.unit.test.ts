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

function makeWritable(root: string): void {
	if (!fs.existsSync(root)) return;
	const pending = [root];
	while (pending.length > 0) {
		const candidate = pending.pop()!;
		try {
			const stat = fs.lstatSync(candidate);
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				fs.chmodSync(candidate, 0o700);
				for (const name of fs.readdirSync(candidate)) pending.push(path.join(candidate, name));
			} else if (stat.isFile() && !stat.isSymbolicLink()) {
				fs.chmodSync(candidate, 0o600);
			}
		} catch { /* best-effort test cleanup */ }
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		makeWritable(root);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function temporaryRoot(label = "marketplace-mcp-attestation-"): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
	roots.push(root);
	return root;
}

const stdioConfig: McpServerConfig = {
	command: "node",
	args: ["server.mjs", "--token", "stdio-raw-secret"],
	env: { API_TOKEN: "stdio-raw-secret", MODE: "read-only" },
};
const httpConfig: McpServerConfig = {
	url: "https://mcp.example.test/api?tenant=docs",
	headers: { Authorization: "Bearer http-raw-secret", "X-Tenant": "docs" },
};

function makePack(root = temporaryRoot(), options: { mcp?: boolean; version?: string } = {}): string {
	const packRoot = path.join(root, "trusted-pack");
	const mcp = options.mcp ?? true;
	const version = options.version ?? "1.0.0";
	fs.mkdirSync(path.join(packRoot, "mcp"), { recursive: true });
	fs.writeFileSync(path.join(packRoot, "pack.yaml"), [
		"schema: 2",
		"name: trusted-pack",
		"description: immutable snapshot fixture",
		`version: ${version}`,
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		`  mcp: ${mcp ? "[local, remote]" : "[]"}`,
		"",
	].join("\n"));
	fs.writeFileSync(path.join(packRoot, ".pack-meta.yaml"), [
		"sourceId: approved-source",
		"sourceUrl: https://source.example.test/packs.git",
		"sourceRef: main",
		"commit: private-path-and-secret-must-not-enter-ledger",
		"packName: trusted-pack",
		`version: ${version}`,
		"installedAt: 2026-01-01T00:00:00.000Z",
		"updatedAt: 2026-01-01T00:00:00.000Z",
		"scope: project",
		"",
	].join("\n"));
	fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'one';\n");
	if (mcp) {
		fs.writeFileSync(path.join(packRoot, "mcp", "local.yaml"), [
			"server: local-runtime",
			"transport:",
			"  type: stdio",
			"  command: node",
			"  args: [server.mjs, --token, stdio-raw-secret]",
			"  env:",
			"    API_TOKEN: stdio-raw-secret",
			"    MODE: read-only",
			"",
		].join("\n"));
		fs.writeFileSync(path.join(packRoot, "mcp", "remote.yaml"), [
			"server: remote-runtime",
			"transport:",
			"  type: http",
			"  url: https://mcp.example.test/api?tenant=docs",
			"  headers:",
			"    Authorization: Bearer http-raw-secret",
			"    X-Tenant: docs",
			"",
		].join("\n"));
	}
	return packRoot;
}

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

function attest(store: MarketplaceMcpInstallAttestationStore, packRoot: string): string {
	return store.replacePack("project-a", "approved-source", "trusted-pack", packRoot);
}

function ledger(store: MarketplaceMcpInstallAttestationStore): any {
	return JSON.parse(fs.readFileSync(store.ledgerPath, "utf8"));
}

function snapshotIds(store: MarketplaceMcpInstallAttestationStore): string[] {
	try {
		return fs.readdirSync(store.snapshotsRoot).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort();
	} catch {
		return [];
	}
}

function writableSnapshot(store: MarketplaceMcpInstallAttestationStore): string {
	const [snapshotId] = snapshotIds(store);
	expect(snapshotId).toBeTruthy();
	const snapshot = path.join(store.snapshotsRoot, snapshotId!);
	makeWritable(snapshot);
	return snapshot;
}

describe("Marketplace MCP install attestations", () => {
	it("publishes, reloads, and removes an immutable snapshot parsed directly from the copied pack", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		const repositoryIntegrity = attest(store, packRoot);

		const persisted = ledger(store);
		expect(persisted).toMatchObject({ schema: 3 });
		expect(persisted.attestations.map((row: any) => [row.contributionId, row.serverName]).sort()).toEqual([
			["local", "local-runtime"],
			["remote", "remote-runtime"],
		]);
		expect(JSON.stringify(persisted)).not.toContain("forged");
		expect(snapshotIds(store)).toHaveLength(1);

		const reloaded = new MarketplaceMcpInstallAttestationStore(secretsDir);
		const resolved = reloaded.resolvePack("project-a", "trusted-pack", repositoryIntegrity);
		expect(resolved.status).toBe("attested");
		if (resolved.status !== "attested") throw new Error("expected attested snapshot");
		expect(resolved.packRoot).toBe(path.join(reloaded.snapshotsRoot, persisted.attestations[0].snapshotId));
		expect(resolved.mcp.map((entry) => [entry.listName, entry.serverName, entry.config])).toEqual([
			["local", "local-runtime", stdioConfig],
			["remote", "remote-runtime", httpConfig],
		]);
		expect(resolved.mcp.every((entry) => entry.sourceFile.startsWith(resolved.packRoot))).toBe(true);

		reloaded.removePack("project-a", "trusted-pack");
		expect(reloaded.resolvePack("project-a", "trusted-pack", repositoryIntegrity)).toEqual({ status: "missing" });
		expect(snapshotIds(reloaded)).toEqual([]);
	});

	it("binds snapshot authority to exact project/source/pack/contribution/server identity and integrity", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		const integrity = attest(store, packRoot);
		expect(store.classify(identity(packRoot))).toBe("attested");
		expect(store.resolvePack("project-a", "trusted-pack", integrity).status).toBe("attested");

		for (const copiedOrForged of [
			identity(packRoot, { projectId: "copied-project" }),
			identity(packRoot, { sourceId: "forged-source" }),
			identity(packRoot, { packName: "copied-pack" }),
			identity(packRoot, { contributionId: "forged-contribution" }),
			identity(packRoot, { serverName: "forged-runtime" }),
		]) {
			expect(store.classify(copiedOrForged)).toBe("missing");
		}
		expect(store.resolvePack("copied-project", "trusted-pack", integrity)).toEqual({ status: "missing" });
		expect(store.resolvePack("project-a", "copied-pack", integrity)).toEqual({ status: "missing" });
		expect(store.resolvePack("project-a", "trusted-pack", "0".repeat(64))).toEqual({
			status: "changed",
			sourceId: "approved-source",
		});
		expect(store.classify(identity(packRoot, { config: { ...stdioConfig, command: "different-node" } }))).toBe("changed");
	});

	it("persists only opaque schema-3 identity/fingerprints and rejects legacy or partially invalid ledgers", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		attest(store, packRoot);

		const persisted = fs.readFileSync(store.ledgerPath, "utf8");
		const integrity = measureMarketplaceMcpPackIntegrity(packRoot);
		for (const forbidden of [
			"stdio-raw-secret",
			"http-raw-secret",
			"Authorization",
			"mcp.example.test",
			"source.example.test",
			"private-path-and-secret",
			packRoot,
			store.snapshotsRoot,
			integrity,
		]) expect(persisted).not.toContain(forbidden);
		expect(JSON.parse(persisted)).toMatchObject({ schema: 3 });

		const old = JSON.parse(persisted);
		fs.writeFileSync(store.ledgerPath, JSON.stringify({ schema: 2, attestations: old.attestations }));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const legacy = new MarketplaceMcpInstallAttestationStore(secretsDir);
		expect(legacy.resolvePack("project-a", "trusted-pack", integrity)).toEqual({ status: "invalid" });
		expect(error).toHaveBeenCalledWith("[mcp] MARKETPLACE_MCP_ATTESTATION_INVALID");

		fs.writeFileSync(store.ledgerPath, JSON.stringify({ schema: 3, attestations: [
			old.attestations[0],
			{ ...old.attestations[1], snapshotId: "../escape" },
		] }));
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).resolvePack("project-a", "trusted-pack", integrity)).toEqual({ status: "invalid" });
	});

	it("rejects missing, corrupt, or escaping snapshot storage without trusting repository definitions", () => {
		const cases = ["missing", "corrupt", "escaping"] as const;
		for (const scenario of cases) {
			const secretsDir = temporaryRoot(`marketplace-snapshot-${scenario}-`);
			const packRoot = makePack(temporaryRoot(`marketplace-pack-${scenario}-`));
			const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
			const integrity = attest(store, packRoot);
			const snapshot = writableSnapshot(store);
			if (scenario === "missing") {
				fs.rmSync(snapshot, { recursive: true, force: true });
			} else if (scenario === "corrupt") {
				fs.writeFileSync(path.join(snapshot, "server.mjs"), "export const generation = 'corrupt';\n");
			} else {
				const outside = temporaryRoot("marketplace-snapshot-outside-");
				fs.cpSync(snapshot, outside, { recursive: true });
				fs.rmSync(snapshot, { recursive: true, force: true });
				try {
					fs.symlinkSync(outside, snapshot, process.platform === "win32" ? "junction" : "dir");
				} catch {
					continue;
				}
			}
			expect(new MarketplaceMcpInstallAttestationStore(secretsDir).resolvePack("project-a", "trusted-pack", integrity)).toEqual({ status: "invalid" });
		}
	});

	it("rolls back a snapshot publication failure and preserves the prior ledger and snapshot", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		attest(store, packRoot);
		const beforeLedger = fs.readFileSync(store.ledgerPath, "utf8");
		const beforeSnapshots = snapshotIds(store);
		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'two';\n");

		const originalRename = fs.renameSync.bind(fs);
		vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
			if (path.dirname(String(to)) === store.snapshotsRoot && /^[a-f0-9]{64}$/.test(path.basename(String(to)))) {
				throw new Error("simulated snapshot publication failure");
			}
			return originalRename(from, to);
		}) as typeof fs.renameSync);
		expect(() => attest(store, packRoot)).toThrow("simulated snapshot publication failure");
		expect(fs.readFileSync(store.ledgerPath, "utf8")).toBe(beforeLedger);
		expect(snapshotIds(store)).toEqual(beforeSnapshots);
		expect(fs.readdirSync(store.snapshotsRoot).some((name) => name.startsWith(".tmp-"))).toBe(false);
	});

	it("fails closed when ledger publication fails and removes the newly published orphan", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		attest(store, packRoot);
		const beforeLedger = fs.readFileSync(store.ledgerPath, "utf8");
		const beforeSnapshots = snapshotIds(store);
		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'two';\n");

		const originalRename = fs.renameSync.bind(fs);
		vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
			if (String(to) === store.ledgerPath) throw new Error("simulated ledger publication failure");
			return originalRename(from, to);
		}) as typeof fs.renameSync);
		try {
			attest(store, packRoot);
			throw new Error("expected ledger publication failure");
		} catch (error) {
			expect((error as Error & { code?: string }).code).toBe("MARKETPLACE_MCP_ATTESTATION_PERSIST_FAILED");
		}
		expect(fs.readFileSync(store.ledgerPath, "utf8")).toBe(beforeLedger);
		expect(snapshotIds(store)).toEqual(beforeSnapshots);
	});

	it("detects source mutation between pre-copy measurement and publication", () => {
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(temporaryRoot());
		const originalCopy = fs.cpSync.bind(fs);
		let raced = false;
		vi.spyOn(fs, "cpSync").mockImplementation(((source: string | URL, destination: string | URL, options?: fs.CopySyncOptions) => {
			originalCopy(source, destination, options);
			if (path.resolve(String(source)) === path.resolve(packRoot)) {
				raced = true;
				fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'raced-after-copy';\n");
			}
		}) as typeof fs.cpSync);

		expect(() => attest(store, packRoot)).toThrow(MarketplaceMcpPackIntegrityError);
		expect(raced).toBe(true);
		expect(fs.existsSync(store.ledgerPath)).toBe(false);
		expect(snapshotIds(store)).toEqual([]);
		expect(fs.readdirSync(store.snapshotsRoot).some((name) => name.startsWith(".tmp-"))).toBe(false);
	});

	it("detects repository file replacement between discovery and opened-file measurement", () => {
		const packRoot = makePack();
		const target = path.join(packRoot, "server.mjs");
		const originalOpen = fs.openSync.bind(fs);
		let raced = false;
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
			if (!raced && path.resolve(String(file)) === path.resolve(target)) {
				raced = true;
				const replacement = `${target}.replacement`;
				fs.writeFileSync(replacement, "export const generation = 'replacement';\n");
				fs.renameSync(replacement, target);
			}
			return originalOpen(file, flags, mode);
		}) as typeof fs.openSync);

		expect(() => measureMarketplaceMcpPackIntegrity(packRoot)).toThrow(MarketplaceMcpPackIntegrityError);
		expect(raced).toBe(true);
	});

	it("fails subsequent resolution after a post-discovery private snapshot mutation", () => {
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(temporaryRoot());
		const integrity = attest(store, packRoot);
		const discovered = store.resolvePack("project-a", "trusted-pack", integrity);
		expect(discovered.status).toBe("attested");
		if (discovered.status !== "attested") throw new Error("expected attested snapshot");
		makeWritable(discovered.packRoot);
		fs.writeFileSync(path.join(discovered.packRoot, "server.mjs"), "export const generation = 'post-discovery-mutation';\n");
		expect(store.resolvePack("project-a", "trusted-pack", integrity)).toEqual({ status: "invalid" });
	});

	it("measures canonical entry types, owner-executable mode, bytes, safe links, and bounded failures", () => {
		const packRoot = makePack();
		const before = measureMarketplaceMcpPackIntegrity(packRoot);
		fs.mkdirSync(path.join(packRoot, "lib"));
		fs.writeFileSync(path.join(packRoot, "lib", "module.mjs"), "export default 1;\n", { mode: 0o644 });
		const withFile = measureMarketplaceMcpPackIntegrity(packRoot);
		expect(withFile).not.toBe(before);
		if (process.platform !== "win32") {
			fs.chmodSync(path.join(packRoot, "lib", "module.mjs"), 0o744);
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
		fs.rmSync(path.join(packRoot, "module-link.mjs"));
		fs.symlinkSync(path.join("..", "outside.mjs"), path.join(packRoot, "escape.mjs"), "file");
		expect(() => measureMarketplaceMcpPackIntegrity(packRoot)).toThrow(MarketplaceMcpPackIntegrityError);
		fs.rmSync(path.join(packRoot, "escape.mjs"));
		expect(() => measureMarketplaceMcpPackIntegrity(packRoot, { maxEntries: 1 })).toThrow(MarketplaceMcpPackIntegrityError);
		expect(() => measureMarketplaceMcpPackIntegrity(packRoot, { maxBytes: 1 })).toThrow(MarketplaceMcpPackIntegrityError);
	});

	it("binds changed pack revisions into distinct opaque approval fingerprints", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const approval = new McpApprovalStore(secretsDir);
		const first = approval.fingerprint(stdioConfig, measureMarketplaceMcpPackIntegrity(packRoot));
		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'two';\n");
		const second = approval.fingerprint(stdioConfig, measureMarketplaceMcpPackIntegrity(packRoot));
		fs.writeFileSync(path.join(packRoot, "server.mjs"), "export const generation = 'three';\n");
		const third = approval.fingerprint(stdioConfig, measureMarketplaceMcpPackIntegrity(packRoot));
		expect(new Set([first, second, third]).size).toBe(3);
	});

	it("recovers a corrupt ledger only through a real replacement and never logs its contents", () => {
		const secretsDir = temporaryRoot();
		const packRoot = makePack();
		const store = new MarketplaceMcpInstallAttestationStore(secretsDir);
		attest(store, packRoot);
		fs.writeFileSync(store.ledgerPath, '{"rawSecret":"must-not-be-logged", broken', "utf8");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const recovered = new MarketplaceMcpInstallAttestationStore(secretsDir);
		expect(recovered.resolvePack("project-a", "trusted-pack", measureMarketplaceMcpPackIntegrity(packRoot))).toEqual({ status: "invalid" });
		expect(error).toHaveBeenCalledWith("[mcp] MARKETPLACE_MCP_ATTESTATION_INVALID");
		expect(JSON.stringify(error.mock.calls)).not.toContain("must-not-be-logged");
		attest(recovered, packRoot);
		expect(new MarketplaceMcpInstallAttestationStore(secretsDir).classify(identity(packRoot))).toBe("attested");
	});
});
