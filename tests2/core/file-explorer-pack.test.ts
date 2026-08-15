import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	activeBuiltinFirstPartyPackEntries,
	builtinFirstPartyPackEntries,
} from "../../src/server/agent/builtin-packs.ts";
import { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.ts";

const MARKET_PACKS = fileURLToPath(new URL("../../market-packs", import.meta.url));
const BUILD_MARKET_PACKS_SOURCE = readFileSync(new URL("../../scripts/build-market-packs.mjs", import.meta.url), "utf8");
const COPY_BUILTIN_PACKS_SOURCE = readFileSync(new URL("../../scripts/copy-builtin-packs.mjs", import.meta.url), "utf8");
const GATEWAY_HARNESS_SOURCE = readFileSync(new URL("../harness/gateway.ts", import.meta.url), "utf8");
const EXPLORER_ROUTES_BUNDLE = readFileSync(new URL("../../market-packs/file-explorer/lib/explorer-routes.mjs", import.meta.url), "utf8");
const FILE_EXPLORER_PANEL_BUNDLE = readFileSync(new URL("../../market-packs/file-explorer/lib/file-explorer-panel.js", import.meta.url), "utf8");
const EXPLORER_SOURCE_FILES = [
	{
		file: "explorer-model.ts",
		text: readFileSync(new URL("../../market-packs/file-explorer/src/explorer-model.ts", import.meta.url), "utf8"),
	},
	{
		file: "explorer-routes.ts",
		text: readFileSync(new URL("../../market-packs/file-explorer/src/explorer-routes.ts", import.meta.url), "utf8"),
	},
	{
		file: "file-explorer-panel.ts",
		text: readFileSync(new URL("../../market-packs/file-explorer/src/file-explorer-panel.ts", import.meta.url), "utf8"),
	},
] as const;

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
				names: ["list", "resolve", "search", "read", "diff"],
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
			title: "Files",
			instanceMode: "singleton",
		});
		expect(enabled.getEntrypoint(undefined, "file-explorer", "file-explorer.session-menu")).toMatchObject({
			kind: "session-menu",
			label: "Open file explorer",
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
		expect(enabled.hasRoute(undefined, "file-explorer", "resolve")).toBe(true);
		expect(enabled.hasRoute(undefined, "file-explorer", "search")).toBe(true);
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
		expect(BUILD_MARKET_PACKS_SOURCE).toContain('pack: "file-explorer"');
		expect(BUILD_MARKET_PACKS_SOURCE).toContain('{ in: "explorer-routes.ts", out: "lib/explorer-routes.mjs", platform: "node" }');
		expect(BUILD_MARKET_PACKS_SOURCE).toContain('{ in: "file-explorer-panel.ts", out: "lib/file-explorer-panel.js" }');
		expect(COPY_BUILTIN_PACKS_SOURCE).toMatch(/FIRST_PARTY_PACKS\s*=\s*\[[^\]]*"file-explorer"/);
		expect(GATEWAY_HARNESS_SOURCE).toMatch(/FIRST_PARTY_PACKS\s*=\s*\[[^\]]*"file-explorer"/);
		expect(EXPLORER_ROUTES_BUNDLE.length).toBeGreaterThan(1_000);
		expect(FILE_EXPLORER_PANEL_BUNDLE.length).toBeGreaterThan(1_000);
	});

	it("keeps the trusted pack bundle mediated and free of app, UI, server or defaults imports", () => {
		for (const { file, text } of EXPLORER_SOURCE_FILES) {
			expect(text, file).not.toMatch(/from\s+["'][^"']*(?:src\/(?:app|ui|server)|defaults\/)/);
		}
		const panel = EXPLORER_SOURCE_FILES[2].text;
		expect(panel).toContain('from "../../../src/shared/git-diff/unified.ts"');
		expect(panel).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|FileSystemHandle)\b/);
		expect(panel).toMatch(/host\.callRoute\(route,/);
		expect(panel).toContain('callValue(state, "list"');
		expect(panel).toContain('callValue(state, "read"');
		expect(panel).toContain('callValue(state, "diff"');
	});
});
