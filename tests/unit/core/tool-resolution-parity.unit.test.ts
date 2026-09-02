import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BuiltinConfigProvider } from "../../../src/server/agent/builtin-config.js";
import { ConfigCascade } from "../../../src/server/agent/config-cascade.js";
import type { PackEntry, PackScope, ResolvedEntity } from "../../../src/server/agent/pack-types.js";
import { resolveGrantPolicy } from "../../../src/server/agent/tool-activation.js";
import { ToolManager, __resetToolScanCache, type ToolInfo } from "../../../src/server/agent/tool-manager.js";

const cleanupRoots: string[] = [];

interface ToolDefinition {
	policy: "allow" | "ask" | "never";
	description: string;
	declaredName?: string;
	group?: string;
	groupDir?: string;
	summary?: string;
	providerExtension?: string;
}

interface MarketDefinition {
	scope: "server" | "global-user" | "project";
	packName: string;
	tool: ToolDefinition;
}

interface FixtureOptions {
	builtin?: ToolDefinition;
	server?: ToolDefinition;
	globalUser?: ToolDefinition;
	project?: ToolDefinition;
	builtinPacks?: Array<{ packName: string; tool: ToolDefinition }>;
	market?: MarketDefinition[];
	disabled?: Record<string, string[]>;
	builtinSibling?: boolean;
}

interface Fixture {
	root: string;
	builtinConfigDir: string;
	serverConfigDir: string;
	projectConfigDir: string;
	globalUserBase: string;
	builtinPacksDir: string;
	cascade: ConfigCascade;
	projectManager: ToolManager;
	marketEntries: PackEntry[];
}

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	__resetToolScanCache();
});

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function writeTool(packRoot: string, definition: ToolDefinition, fileStem = "session_prompt"): void {
	const groupDir = definition.groupDir ?? "agent";
	const declaredName = definition.declaredName ?? "session_prompt";
	const extension = definition.providerExtension ?? `${fileStem}-extension.ts`;
	const toolDir = path.join(packRoot, "tools", groupDir);
	writeFile(path.join(toolDir, `${fileStem}.yaml`), [
		`name: ${declaredName}`,
		`description: ${JSON.stringify(definition.description)}`,
		`summary: ${JSON.stringify(definition.summary ?? `${definition.description} summary`)}`,
		`group: ${JSON.stringify(definition.group ?? "Agent")}`,
		"docs: Short winner documentation.",
		"detail_docs: Full winner documentation.",
		"params: [session_id, message, mode?]",
		"provider:",
		"  type: bobbit-extension",
		`  extension: ${extension}`,
		"renderer: SessionPromptRenderer.js",
		"actions:",
		"  module: actions.mjs",
		"  names: [send]",
		`grantPolicy: ${definition.policy}`,
		"",
	].join("\n"));
	writeFile(path.join(toolDir, extension), "export default function extension() { return {}; }\n");
	writeFile(path.join(toolDir, "SessionPromptRenderer.js"), "export default {};\n");
	writeFile(path.join(toolDir, "actions.mjs"), "export const actions = { send: () => undefined };\n");
}

function writePackManifest(packRoot: string, packName: string): void {
	writeFile(path.join(packRoot, "pack.yaml"), [
		`name: ${packName}`,
		"description: Tool resolution parity fixture",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: [agent]",
		"  skills: []",
		"  entrypoints: []",
		"",
	].join("\n"));
}

function marketEntry(packRoot: string, scope: MarketDefinition["scope"], packName: string): PackEntry {
	return {
		id: `market:${scope}:${packName}`,
		kind: "market",
		scope,
		path: packRoot,
		readOnly: true,
		layout: "defaults-tree",
		manifest: {
			name: packName,
			description: "Tool resolution parity fixture",
			version: "1.0.0",
			contents: { roles: [], tools: ["agent"], skills: [], entrypoints: [] },
		},
	};
}

function createFixture(options: FixtureOptions = {}): Fixture {
	__resetToolScanCache();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-resolution-parity-"));
	cleanupRoots.push(root);

	const builtinConfigDir = path.join(root, "defaults");
	const serverConfigDir = path.join(root, "server", ".bobbit", "config");
	const projectConfigDir = path.join(root, "project", ".bobbit", "config");
	const globalUserBase = path.join(root, "home");
	const globalUserConfigDir = path.join(globalUserBase, ".bobbit", "config");
	const builtinPacksDir = path.join(root, "builtin-packs", "market-packs");
	for (const dir of [builtinConfigDir, serverConfigDir, projectConfigDir, globalUserConfigDir, builtinPacksDir]) {
		fs.mkdirSync(dir, { recursive: true });
	}

	writeTool(builtinConfigDir, options.builtin ?? {
		policy: "never",
		description: "builtin session prompt",
		providerExtension: "builtin-extension.ts",
	});
	if (options.builtinSibling) {
		writeTool(builtinConfigDir, {
			policy: "allow",
			description: "builtin sibling",
			declaredName: "session_status",
			summary: "Inspect session status",
			providerExtension: "status-extension.ts",
		}, "session_status");
	}
	if (options.server) writeTool(serverConfigDir, options.server);
	if (options.globalUser) writeTool(globalUserConfigDir, options.globalUser);
	if (options.project) writeTool(projectConfigDir, options.project);

	for (const definition of options.builtinPacks ?? []) {
		const packRoot = path.join(builtinPacksDir, definition.packName);
		writePackManifest(packRoot, definition.packName);
		writeTool(packRoot, definition.tool);
	}

	const marketEntries: PackEntry[] = [];
	for (const definition of options.market ?? []) {
		const packRoot = path.join(root, "installed", definition.scope, "market-packs", definition.packName);
		writePackManifest(packRoot, definition.packName);
		writeTool(packRoot, definition.tool);
		marketEntries.push(marketEntry(packRoot, definition.scope, definition.packName));
	}

	const builtinToolsDir = path.join(builtinConfigDir, "tools");
	const serverManager = new ToolManager(serverConfigDir, builtinToolsDir);
	const projectManager = new ToolManager(projectConfigDir, builtinToolsDir);
	const builtins = new BuiltinConfigProvider(builtinConfigDir);
	const serverStores = {
		getRoles: () => [],
		getTools: () => serverManager.getLocalTools(),
		getToolGroupPolicies: () => ({}),
		// Source-root accessors are intentionally included in this structural fixture:
		// authoritative entries must retain a physical root for runtime hydration.
		getConfigDir: () => serverConfigDir,
		getToolsDir: () => path.join(serverConfigDir, "tools"),
		toolManager: serverManager,
	};
	const projectContextManager = {
		getOrCreate: (projectId: string) => projectId === "normal-project"
			? { toolManager: projectManager }
			: undefined,
	} as never;
	const cascade = new ConfigCascade(
		builtins,
		serverStores,
		projectContextManager,
		undefined,
		{
			marketEntries(scope) {
				return marketEntries.filter((entry) => entry.scope === scope);
			},
		},
		globalUserBase,
		builtinPacksDir,
	);
	cascade.setPackActivationProvider({
		disabled(scope, _projectId, packName) {
			return { tools: options.disabled?.[`${scope}:${packName}`] ?? [] };
		},
	});

	// The method is introduced by the authoritative-catalogue implementation.
	// Keeping this guarded makes the reproducer fail on semantic disagreement,
	// rather than failing early because the pre-fix branch lacks the new seam.
	const setProvider = (projectManager as ToolManager & {
		setResolvedToolEntriesProvider?: (provider: () => ResolvedEntity<ToolInfo>[]) => void;
	}).setResolvedToolEntriesProvider;
	if (setProvider) setProvider.call(projectManager, () => cascade.resolveToolsEntries("normal-project"));

	return {
		root,
		builtinConfigDir,
		serverConfigDir,
		projectConfigDir,
		globalUserBase,
		builtinPacksDir,
		cascade,
		projectManager,
		marketEntries,
	};
}

function catalogueEntry(fixture: Fixture, name = "session_prompt"): ResolvedEntity<ToolInfo> {
	const matches = fixture.cascade.resolveToolsEntries("normal-project")
		.filter((entry) => entry.name.toLowerCase() === name.toLowerCase());
	assert.equal(matches.length, 1, `catalogue must contain one case-insensitive ${name} winner`);
	return matches[0];
}

function expectedToolsBase(entry: ResolvedEntity<ToolInfo>): string {
	assert.notEqual(entry.origin.path, "", `winning ${entry.origin.id} provenance must retain its physical root`);
	return path.join(entry.origin.path, "tools");
}

function assertRuntimeWinner(
	fixture: Fixture,
	lookupName: string,
	message: string,
): void {
	const catalogue = catalogueEntry(fixture, lookupName);
	const runtime = fixture.projectManager.getToolByName(lookupName);
	const location = fixture.projectManager.resolveToolLocation(lookupName);
	const provider = fixture.projectManager.getToolProvider(lookupName);

	assert.ok(runtime, `${message}: runtime must resolve the catalogue winner`);
	assert.ok(location, `${message}: runtime must resolve the winner's location`);
	assert.deepEqual(
		{
			name: runtime.name,
			policy: runtime.grantPolicy,
			description: runtime.description,
			group: runtime.group,
			docs: runtime.docs,
			detailDocs: runtime.detail_docs,
			params: runtime.params,
			provider,
			baseDir: path.resolve(location.baseDir),
			groupDir: location.groupDir,
			rendererFile: location.rendererFile,
			actionsModule: location.actionsModule,
			actionNames: location.actionNames,
		},
		{
			name: catalogue.item.name,
			policy: catalogue.item.grantPolicy,
			description: catalogue.item.description,
			group: catalogue.item.group,
			docs: catalogue.item.docs,
			detailDocs: catalogue.item.detail_docs,
			params: catalogue.item.params,
			provider: { type: "bobbit-extension", extension: `${catalogue.item.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}-extension.ts` },
			baseDir: path.resolve(expectedToolsBase(catalogue)),
			groupDir: "agent",
			rendererFile: "SessionPromptRenderer.js",
			actionsModule: "actions.mjs",
			actionNames: ["send"],
		},
		message,
	);
}

function layerTool(layer: string, policy: ToolDefinition["policy"] = "ask"): ToolDefinition {
	return {
		policy,
		description: `${layer} session prompt`,
		group: `${layer} Agent`,
		summary: `${layer} winning summary`,
		providerExtension: "session_prompt-extension.ts",
	};
}

describe("tool resolution parity", () => {
	it("uses an ordinary server user override as the project catalogue and runtime winner", () => {
		const fixture = createFixture({ server: layerTool("server") });
		const builtin = new ToolManager(path.join(fixture.root, "empty"), path.join(fixture.builtinConfigDir, "tools"))
			.getToolByName("session_prompt");
		const catalogue = catalogueEntry(fixture);
		const runtime = fixture.projectManager.getToolByName("session_prompt");

		assert.equal(builtin?.grantPolicy, "never", "fixture must preserve the shipped default policy");
		assert.equal(catalogue.origin.id, "user:server");
		assert.equal(catalogue.origin.scope, "server");
		assert.equal(catalogue.item.grantPolicy, "ask");
		assert.ok(runtime);
		assert.deepEqual(
			{
				grantPolicy: runtime.grantPolicy,
				description: runtime.description,
				effectivePolicy: resolveGrantPolicy(runtime.name, runtime.group, undefined, fixture.projectManager),
			},
			{
				grantPolicy: catalogue.item.grantPolicy,
				description: catalogue.item.description,
				effectivePolicy: catalogue.item.grantPolicy,
			},
			"TOOL_RESOLUTION_PARITY_SERVER_OVERRIDE: project runtime must use the catalogue's server winner",
		);
		assertRuntimeWinner(fixture, "session_prompt", "server policy/provider/docs/location must come from one winner");
		assert.match(fixture.projectManager.getToolDocsForPrompt(["session_prompt"]), /server winning summary/);
	});

	it("uses the project winner for mixed-case lookup while role policy remains authoritative", () => {
		const fixture = createFixture({
			server: layerTool("server"),
			project: {
				...layerTool("project"),
				declaredName: "Session_Prompt",
				providerExtension: "session_prompt-extension.ts",
			},
		});
		const catalogue = catalogueEntry(fixture, "SESSION_PROMPT");
		const runtime = fixture.projectManager.getToolByName("sEsSiOn_PrOmPt");

		assert.equal(catalogue.name, "Session_Prompt", "winner must retain its declared spelling");
		assert.equal(catalogue.origin.id, "user:project");
		assert.equal(catalogue.origin.scope, "project");
		assert.deepEqual(catalogue.shadows.map((entry) => entry.id), ["builtin", "user:server"]);
		assert.equal(runtime?.name, "Session_Prompt");
		assert.equal(fixture.projectManager.getAllToolNames().filter((name) => name.toLowerCase() === "session_prompt").length, 1);
		assertRuntimeWinner(fixture, "SESSION_PROMPT", "mixed-case detail/provider/location lookup must use the project winner");

		assert.equal(resolveGrantPolicy("Session_Prompt", runtime?.group, undefined, fixture.projectManager), "ask");
		assert.equal(resolveGrantPolicy("Session_Prompt", runtime?.group, { toolPolicies: { Session_Prompt: "allow" } }, fixture.projectManager), "allow");
		assert.equal(resolveGrantPolicy("Session_Prompt", runtime?.group, { toolPolicies: { Session_Prompt: "never" } }, fixture.projectManager), "never");
	});

	it("keeps unrelated builtin siblings when a higher layer only overrides one tool in the group", () => {
		const fixture = createFixture({
			project: layerTool("project"),
			builtinSibling: true,
		});
		const prompt = catalogueEntry(fixture);
		const siblingCatalogue = catalogueEntry(fixture, "session_status");
		const siblingRuntime = fixture.projectManager.getToolByName("SESSION_STATUS");
		const siblingLocation = fixture.projectManager.resolveToolLocation("session_status");

		assert.equal(prompt.origin.id, "user:project");
		assert.equal(siblingCatalogue.origin.id, "builtin");
		assert.equal(siblingRuntime?.description, "builtin sibling");
		assert.ok(siblingLocation);
		assert.equal(path.resolve(siblingLocation.baseDir), path.resolve(path.join(fixture.builtinConfigDir, "tools")));
		assert.deepEqual(
			new Set(fixture.projectManager.getAvailableTools().map((tool) => tool.name.toLowerCase())),
			new Set(["session_prompt", "session_status"]),
			"partial group overrides must not suppress unrelated lower-priority tools",
		);
	});

	it("reveals the same lower market winner when the higher market definition is disabled", () => {
		const fixture = createFixture({
			market: [
				{ scope: "server", packName: "low-pack", tool: layerTool("low-market") },
				{ scope: "project", packName: "high-pack", tool: layerTool("high-market", "allow") },
			],
			disabled: { "project:high-pack": ["session_prompt"] },
		});
		const catalogue = catalogueEntry(fixture);

		assert.equal(catalogue.origin.id, "market:server:low-pack");
		assert.equal(catalogue.origin.scope, "server");
		assert.equal(catalogue.origin.kind, "market");
		assert.equal(catalogue.origin.manifest?.name, "low-pack");
		assert.deepEqual(catalogue.shadows.map((entry) => entry.id), ["builtin"]);
		assertRuntimeWinner(fixture, "SESSION_PROMPT", "disabled high market tool must reveal the same lower winner");
		assert.equal(fixture.projectManager.getToolByName("session_prompt")?.description, "low-market session prompt");
	});

	it("orders every feasible built-in, market, user, global-user, and project layer once", () => {
		const fixture = createFixture({
			builtin: layerTool("builtin", "never"),
			builtinPacks: [{ packName: "first-party", tool: layerTool("first-party") }],
			market: [
				{ scope: "server", packName: "server-pack", tool: layerTool("server-market") },
				{ scope: "global-user", packName: "global-pack", tool: layerTool("global-market") },
				{ scope: "project", packName: "project-pack", tool: layerTool("project-market") },
			],
			server: layerTool("server-user"),
			globalUser: layerTool("global-user"),
			project: layerTool("project-user", "allow"),
		});
		const catalogue = catalogueEntry(fixture);

		assert.equal(catalogue.origin.id, "user:project");
		assert.equal(catalogue.item.description, "project-user session prompt");
		assert.deepEqual(
			catalogue.shadows.map((entry) => [entry.id, entry.scope, entry.kind] as [string, PackScope, string]),
			[
				["builtin", "builtin", "builtin"],
				["builtin-pack:first-party", "server", "market"],
				["market:server:server-pack", "server", "market"],
				["user:server", "server", "user"],
				["market:global-user:global-pack", "global-user", "market"],
				["user:global-user", "global-user", "user"],
				["market:project:project-pack", "project", "market"],
			],
			"one authoritative precedence order must retain every shadow's provenance",
		);
		assertRuntimeWinner(fixture, "session_prompt", "runtime must hydrate the final winner from the complete precedence matrix");
	});
});
