import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	activeBuiltinFirstPartyPackEntries,
	builtinFirstPartyPackEntries,
} from "../../src/server/agent/builtin-packs.ts";
import { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../..");
const MARKET_PACKS = path.join(REPO_ROOT, "market-packs");
const PACK_ROOT = path.join(MARKET_PACKS, "file-explorer");

function source(relativePath: string): string {
	return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("built-in file explorer pack shipping", () => {
	it("ships as a default-active, read-only first-party pack with bounded routes and both launchers", () => {
		const entry = builtinFirstPartyPackEntries(MARKET_PACKS)
			.find((candidate) => candidate.manifest?.name === "file-explorer");
		expect(entry).toBeDefined();
		if (!entry?.manifest) throw new Error("file-explorer manifest was not loaded");

		expect(entry).toMatchObject({
			id: "builtin-pack:file-explorer",
			kind: "market",
			scope: "server",
			readOnly: true,
			layout: "defaults-tree",
		});
		expect(entry.manifest).toMatchObject({
			name: "file-explorer",
			schema: 2,
			contents: {
				roles: [],
				tools: [],
				skills: [],
				entrypoints: ["file-explorer-session-menu", "file-explorer-slash"],
			},
			routes: {
				module: "lib/explorer-routes.mjs",
				names: ["list", "read", "diff"],
			},
		});
		expect(entry.manifest.defaultDisabled).not.toBe(true);
		expect(activeBuiltinFirstPartyPackEntries(MARKET_PACKS, () => undefined)
			.some((candidate) => candidate.manifest?.name === "file-explorer")).toBe(true);
	});

	it("loads singleton panel and native launch contributions that can be disabled and restored", () => {
		const entry = builtinFirstPartyPackEntries(MARKET_PACKS)
			.find((candidate) => candidate.manifest?.name === "file-explorer");
		if (!entry) throw new Error("file-explorer pack missing");
		const enabled = new PackContributionRegistry(() => [entry]);

		expect(enabled.getPanel(undefined, "file-explorer", "file-explorer.panel")).toMatchObject({
			id: "file-explorer.panel",
			title: "Explorer",
			instanceMode: "singleton",
		});
		expect(enabled.getEntrypoint(undefined, "file-explorer", "file-explorer.session-menu")).toMatchObject({
			kind: "session-menu",
			label: "Open File Explorer",
			icon: "folder-tree",
			target: { panelId: "file-explorer.panel" },
		});
		expect(enabled.getEntrypoint(undefined, "file-explorer", "files")).toMatchObject({
			kind: "composer-slash",
			label: "/files",
			icon: "folder-tree",
			target: { panelId: "file-explorer.panel" },
		});
		expect(enabled.hasRoute(undefined, "file-explorer", "list")).toBe(true);
		expect(enabled.hasRoute(undefined, "file-explorer", "read")).toBe(true);
		expect(enabled.hasRoute(undefined, "file-explorer", "diff")).toBe(true);
		expect(enabled.hasRoute(undefined, "file-explorer", "write")).toBe(false);

		const disabled = new PackContributionRegistry(
			() => [entry],
			() => ["file-explorer-session-menu", "file-explorer-slash"],
		);
		expect(disabled.getPack(undefined, "file-explorer")?.entrypoints).toEqual([]);
		expect(disabled.getPanel(undefined, "file-explorer", "file-explorer.panel")).toBeDefined();
		expect(disabled.hasRoute(undefined, "file-explorer", "list")).toBe(true);
		expect(enabled.getPack(undefined, "file-explorer")?.entrypoints).toHaveLength(2);
	});

	it("is present in build/copy/harness allowlists with committed server and browser bundles", () => {
		expect(source("scripts/build-market-packs.mjs")).toContain('pack: "file-explorer"');
		expect(source("scripts/build-market-packs.mjs")).toContain('{ in: "explorer-routes.ts", out: "lib/explorer-routes.mjs", platform: "node" }');
		expect(source("scripts/build-market-packs.mjs")).toContain('{ in: "file-explorer-panel.ts", out: "lib/file-explorer-panel.js" }');
		expect(source("scripts/copy-builtin-packs.mjs")).toMatch(/FIRST_PARTY_PACKS\s*=\s*\[[^\]]*"file-explorer"/);
		expect(source("tests2/harness/gateway.ts")).toMatch(/FIRST_PARTY_PACKS\s*=\s*\[[^\]]*"file-explorer"/);
		expect(source("market-packs/file-explorer/lib/explorer-routes.mjs").length).toBeGreaterThan(1_000);
		expect(source("market-packs/file-explorer/lib/file-explorer-panel.js").length).toBeGreaterThan(1_000);
	});

	it("keeps the trusted pack bundle mediated and free of app, UI, server or defaults imports", () => {
		const files = ["explorer-model.ts", "explorer-routes.ts", "file-explorer-panel.ts"];
		for (const file of files) {
			const text = readFileSync(path.join(PACK_ROOT, "src", file), "utf8");
			expect(text, file).not.toMatch(/from\s+["'][^"']*(?:src\/(?:app|ui|server)|defaults\/)/);
		}
		const panel = source("market-packs/file-explorer/src/file-explorer-panel.ts");
		expect(panel).toContain('from "../../../src/shared/git-diff/unified.ts"');
		expect(panel).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|FileSystemHandle)\b/);
		expect(panel).toMatch(/host\.callRoute\(route,/);
		expect(panel).toContain('callValue(state, "list"');
		expect(panel).toContain('callValue(state, "read"');
		expect(panel).toContain('callValue(state, "diff"');
	});
});
