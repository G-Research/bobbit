import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { MarketplaceError, MarketplaceInstaller } from "../../src/server/agent/marketplace-install.ts";
import { MarketplaceSourceStore } from "../../src/server/agent/marketplace-source-store.ts";
import type { McpGatewayParseResult } from "../../src/server/agent/mcp-gateway-source.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-decisions-"));
	roots.push(root);
	return root;
}

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function writeMinimalPack(root: string): void {
	write(
		path.join(root, "decision-pack", "pack.yaml"),
		"name: decision-pack\ndescription: seam fixture\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: []\n  skills: []\n",
	);
}

function memoryPackOrder() {
	const order: string[] = [];
	return {
		getPackOrder: () => [...order],
		setPackOrder: (_scope: string, next: string[]) => order.splice(0, order.length, ...next),
		_order: order,
	};
}

function installer(root: string, sourceStore: MarketplaceSourceStore, seams: {
	gitRunner?: (args: string[], cwd: string) => string;
	mcpGatewayFetch?: (source: any) => Promise<McpGatewayParseResult>;
} = {}) {
	return new MarketplaceInstaller({
		sourceStore,
		cacheRoot: path.join(root, "cache"),
		serverBase: root,
		globalUserBase: root,
		...seams,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MarketplaceInstaller injected-runner decisions", () => {
	it("installs a git source through gitRunner without invoking gateway discovery", async () => {
		const root = tempRoot();
		const sourceStore = new MarketplaceSourceStore(path.join(root, "config"));
		const source = sourceStore.add({ url: "https://example.invalid/packs.git", ref: "stable" });
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const gitRunner = vi.fn((args: string[], cwd: string) => {
			calls.push({ args: [...args], cwd });
			if (args[0] === "clone") {
				writeMinimalPack(args.at(-1)!);
				write(path.join(args.at(-1)!, ".git", "HEAD"), "ref: refs/heads/stable\n");
				return "";
			}
			if (args[0] === "rev-parse") return "abc1234567890\n";
			throw new Error(`unexpected git command: ${args.join(" ")}`);
		});
		const mcpGatewayFetch = vi.fn(async (): Promise<McpGatewayParseResult> => {
			throw new Error("gateway discovery must not run for git sources");
		});
		const order = memoryPackOrder();
		const subject = installer(root, sourceStore, { gitRunner, mcpGatewayFetch });

		const installed = await subject.installMarketplacePack({
			sourceId: source.id,
			dirName: "decision-pack",
			scope: "server",
			packOrderStore: order,
		});

		assert.equal(installed.packName, "decision-pack");
		assert.equal(installed.meta.commit, "abc1234567890");
		assert.deepEqual(order._order, ["decision-pack"]);
		assert.equal(mcpGatewayFetch.mock.calls.length, 0);
		assert.deepEqual(calls[0]!.args.slice(0, 5), ["clone", "--depth", "1", "--branch", "stable"]);
		assert.equal(calls[0]!.args.at(-2), source.url);
		assert.deepEqual(calls.at(-1)!.args, ["rev-parse", "HEAD"]);
		assert.equal(sourceStore.get(source.id)!.lastCommit, "abc1234567890");
	});

	it("installs an MCP gateway provider through mcpGatewayFetch without invoking git", async () => {
		const root = tempRoot();
		const sourceStore = new MarketplaceSourceStore(path.join(root, "config"));
		const source = sourceStore.add({
			url: "https://gateway.example.invalid/readonly/mcp",
			type: "mcp-gateway",
		});
		const parsed: McpGatewayParseResult = {
			providers: [{
				id: "jira",
				label: "Jira",
				description: "Issue decisions",
				version: "2.0.0",
				read: { server: "gr", url: source.url },
				operations: [{ name: "jira_search", description: "Search issues", inputSchema: { type: "object" } }],
				fingerprint: "gateway-fingerprint-v2",
			}],
			skipped: [],
		};
		const mcpGatewayFetch = vi.fn(async () => parsed);
		const gitRunner = vi.fn(() => {
			throw new Error("git must not run for MCP gateway sources");
		});
		const order = memoryPackOrder();
		const subject = installer(root, sourceStore, { gitRunner, mcpGatewayFetch });

		const browsed = await subject.browseSourcePacks(source.id);
		const installed = await subject.installMarketplacePack({
			sourceId: source.id,
			dirName: browsed[0]!.dirName,
			scope: "server",
			packOrderStore: order,
		});

		assert.equal(mcpGatewayFetch.mock.calls.length, 2);
		assert.equal(gitRunner.mock.calls.length, 0);
		assert.match(installed.packName, /^mcp-jira-/);
		assert.deepEqual(installed.manifest.contents.mcp, ["jira"]);
		assert.equal(installed.meta.commit, "gateway-fingerprint-v2");
		assert.deepEqual(order._order, [installed.packName]);
		assert.equal(sourceStore.get(source.id)!.lastCommit, "gateway-fingerprint-v2");
	});

	it("surfaces the injected gateway diagnostic when the requested provider was skipped", async () => {
		const root = tempRoot();
		const sourceStore = new MarketplaceSourceStore(path.join(root, "config"));
		const source = sourceStore.add({
			url: "https://gateway.example.invalid/readonly/mcp",
			type: "mcp-gateway",
		});
		const subject = installer(root, sourceStore, {
			mcpGatewayFetch: async () => ({
				providers: [],
				skipped: [{ id: "unsafe-id", name: "Unsafe Provider", reason: "unsafe gateway provider id" }],
			}),
			gitRunner: () => {
				throw new Error("git must not run for MCP gateway sources");
			},
		});

		await assert.rejects(
			() => subject.installMarketplacePack({ sourceId: source.id, dirName: "unsafe-id", scope: "server" }),
			(error: unknown) => error instanceof MarketplaceError
				&& error.code === "unknown_pack"
				&& /unsafe gateway provider id/.test(error.message),
		);
	});
});
