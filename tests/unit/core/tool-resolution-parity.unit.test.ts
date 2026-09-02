import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BuiltinConfigProvider } from "../../../src/server/agent/builtin-config.js";
import { ConfigCascade } from "../../../src/server/agent/config-cascade.js";
import type { PackEntry, PackScope, ResolvedEntity } from "../../../src/server/agent/pack-types.js";
import type { DisabledRefs } from "../../../src/server/agent/project-config-store.js";
import {
	computeEffectiveAllowedTools,
	computeToolActivationArgs,
	computeToolPolicies,
	resolveGrantPolicy,
} from "../../../src/server/agent/tool-activation.js";
import { generateToolGuardExtension } from "../../../src/server/agent/tool-guard-extension.js";
import { ToolManager, __resetToolScanCache, type ToolInfo } from "../../../src/server/agent/tool-manager.js";
import { resolvePackIdentityForTool } from "../../../src/server/extension-host/pack-identity.js";

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
	defaultDisabled?: boolean;
	/** Definitions with the same key intentionally occupy one physical pack root. */
	physicalRootKey?: string;
}

interface FixtureOptions {
	builtin?: ToolDefinition;
	server?: ToolDefinition;
	globalUser?: ToolDefinition;
	project?: ToolDefinition;
	builtinPacks?: Array<{ packName: string; tool: ToolDefinition; defaultDisabled?: boolean }>;
	market?: MarketDefinition[];
	disabled?: Record<string, string[]>;
	activation?: Record<string, DisabledRefs>;
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
	serverManager: ToolManager;
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

function writePackManifest(packRoot: string, packName: string, defaultDisabled = false): void {
	writeFile(path.join(packRoot, "pack.yaml"), [
		`name: ${packName}`,
		"description: Tool resolution parity fixture",
		"version: 1.0.0",
		...(defaultDisabled ? ["defaultDisabled: true"] : []),
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
		writePackManifest(packRoot, definition.packName, definition.defaultDisabled);
		writeTool(packRoot, definition.tool);
	}

	const marketEntries: PackEntry[] = [];
	const physicalRoots = new Map<string, string>();
	for (const definition of options.market ?? []) {
		const physicalKey = definition.physicalRootKey ?? `${definition.scope}:${definition.packName}`;
		let packRoot = physicalRoots.get(physicalKey);
		if (!packRoot) {
			packRoot = path.join(root, "installed", definition.scope, "market-packs", definition.packName);
			physicalRoots.set(physicalKey, packRoot);
			writePackManifest(packRoot, definition.packName, definition.defaultDisabled);
			writeTool(packRoot, definition.tool);
		}
		const entry = marketEntry(packRoot, definition.scope, definition.packName);
		if (definition.defaultDisabled) entry.manifest!.defaultDisabled = true;
		marketEntries.push(entry);
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
			const key = `${scope}:${packName}`;
			return options.activation?.[key] ?? { tools: options.disabled?.[key] ?? [] };
		},
	});

	// The method is introduced by the authoritative-catalogue implementation.
	// Keeping this guarded makes the reproducer fail on semantic disagreement,
	// rather than failing early because the pre-fix branch lacks the new seam.
	const projectSetProvider = (projectManager as ToolManager & {
		setResolvedToolEntriesProvider?: (provider: () => ResolvedEntity<ToolInfo>[]) => void;
	}).setResolvedToolEntriesProvider;
	if (projectSetProvider) projectSetProvider.call(projectManager, () => cascade.resolveToolsEntries("normal-project"));
	const serverSetProvider = (serverManager as ToolManager & {
		setResolvedToolEntriesProvider?: (provider: () => ResolvedEntity<ToolInfo>[]) => void;
	}).setResolvedToolEntriesProvider;
	if (serverSetProvider) serverSetProvider.call(serverManager, () => cascade.resolveToolsEntries("headquarters"));

	return {
		root,
		builtinConfigDir,
		serverConfigDir,
		projectConfigDir,
		globalUserBase,
		builtinPacksDir,
		cascade,
		serverManager,
		projectManager,
		marketEntries,
	};
}

function catalogueEntry(
	fixture: Fixture,
	name = "session_prompt",
	projectId = "normal-project",
): ResolvedEntity<ToolInfo> {
	const matches = fixture.cascade.resolveToolsEntries(projectId)
		.filter((entry) => entry.name.toLowerCase() === name.toLowerCase());
	assert.equal(matches.length, 1, `catalogue must contain one case-insensitive ${name} winner`);
	return matches[0];
}

function expectedToolsBase(entry: ResolvedEntity<ToolInfo>): string {
	assert.notEqual(entry.origin.path, "", `winning ${entry.origin.id} provenance must retain its physical root`);
	return path.join(entry.origin.path, "tools");
}

interface RuntimeWinnerOptions {
	projectId?: string;
	manager?: ToolManager;
	expectedSummary?: string;
}

function assertRuntimeWinner(
	fixture: Fixture,
	lookupName: string,
	message: string,
	options: RuntimeWinnerOptions = {},
): void {
	const projectId = options.projectId ?? "normal-project";
	const manager = options.manager ?? fixture.projectManager;
	const catalogue = catalogueEntry(fixture, lookupName, projectId);
	const runtime = manager.getToolByName(lookupName);
	const runtimeEntry = manager.getResolvedToolEntry(lookupName);
	const location = manager.resolveToolLocation(lookupName);
	const provider = manager.getToolProvider(lookupName);
	const providerRow = [...manager.getToolProviders().entries()]
		.find(([name]) => name.toLowerCase() === lookupName.toLowerCase());

	assert.ok(runtime, `${message}: runtime must resolve the catalogue winner`);
	assert.ok(runtimeEntry, `${message}: runtime must retain winner provenance`);
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
			providerRow: providerRow && {
				name: providerRow[0],
				type: providerRow[1].type,
				extension: providerRow[1].extension,
				baseDir: path.resolve(providerRow[1].baseDir),
				groupDir: providerRow[1].groupDir,
			},
			baseDir: path.resolve(location.baseDir),
			groupDir: location.groupDir,
			rendererFile: location.rendererFile,
			rendererKind: location.rendererKind,
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
			providerRow: {
				name: catalogue.item.name,
				type: "bobbit-extension",
				extension: `${catalogue.item.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}-extension.ts`,
				baseDir: path.resolve(expectedToolsBase(catalogue)),
				groupDir: "agent",
			},
			baseDir: path.resolve(expectedToolsBase(catalogue)),
			groupDir: "agent",
			rendererFile: "SessionPromptRenderer.js",
			rendererKind: catalogue.origin.kind === "market" ? "pack" : "builtin",
			actionsModule: "actions.mjs",
			actionNames: ["send"],
		},
		message,
	);

	assert.deepEqual(
		{
			origin: {
				id: runtimeEntry.origin.id,
				scope: runtimeEntry.origin.scope,
				kind: runtimeEntry.origin.kind,
				path: path.resolve(runtimeEntry.origin.path),
				pack: runtimeEntry.origin.manifest?.name,
			},
			source: runtimeEntry.source && {
				baseDir: path.resolve(runtimeEntry.source.baseDir),
				filePath: runtimeEntry.source.filePath && path.resolve(runtimeEntry.source.filePath),
			},
		},
		{
			origin: {
				id: catalogue.origin.id,
				scope: catalogue.origin.scope,
				kind: catalogue.origin.kind,
				path: path.resolve(catalogue.origin.path),
				pack: catalogue.origin.manifest?.name,
			},
			source: catalogue.source && {
				baseDir: path.resolve(catalogue.source.baseDir),
				filePath: catalogue.source.filePath && path.resolve(catalogue.source.filePath),
			},
		},
		`${message}: catalogue and runtime provenance must be identical`,
	);
	assert.equal(path.resolve(catalogue.source!.baseDir), path.resolve(expectedToolsBase(catalogue)));
	assert.equal(
		path.resolve(catalogue.source!.filePath!),
		path.resolve(expectedToolsBase(catalogue), "agent", "session_prompt.yaml"),
		`${message}: provenance must identify the exact winning YAML file`,
	);

	const promptDocs = manager.getToolDocsForPrompt([lookupName]);
	assert.match(promptDocs, new RegExp(`\\b${catalogue.item.name}\\b`, "i"));
	if (options.expectedSummary) assert.ok(promptDocs.includes(options.expectedSummary), `${message}: prompt docs must use the winner summary`);

	const activation = computeToolActivationArgs([{ kind: "yaml", name: lookupName }], manager);
	const extensionPath = path.resolve(expectedToolsBase(catalogue), "agent", `${catalogue.item.name.toLowerCase()}-extension.ts`);
	assert.ok(
		activation.args.some((arg) => path.resolve(arg) === extensionPath),
		`${message}: activation must load the winner extension`,
	);

	assert.deepEqual(
		resolvePackIdentityForTool(manager, catalogue.item.name),
		{
			packId: catalogue.origin.kind === "market" ? path.basename(catalogue.origin.path) : "",
			contributionId: `agent/${catalogue.item.name}`,
			isPack: catalogue.origin.kind === "market",
		},
		`${message}: surface identity must follow the winner location`,
	);
}

function generatedGuardMaps(
	manager: ToolManager,
	role?: { toolPolicies?: Record<string, "allow" | "ask" | "never"> },
): { policies: ReturnType<typeof computeToolPolicies>; ask: Record<string, unknown>; never: Record<string, unknown> } {
	const policies = computeToolPolicies(manager, undefined, role);
	const source = generateToolGuardExtension("parity-session", policies, []);
	const readMap = (name: "ask" | "never"): Record<string, unknown> => {
		const match = source.match(new RegExp(`const ${name}Policies = (.*);`));
		assert.ok(match, `generated guard must serialize ${name}Policies`);
		return JSON.parse(match[1]) as Record<string, unknown>;
	};
	return { policies, ask: readMap("ask"), never: readMap("never") };
}

function assertPolicySurfaces(
	manager: ToolManager,
	name: string,
	expected: "allow" | "ask" | "never",
	role?: { toolPolicies?: Record<string, "allow" | "ask" | "never"> },
): void {
	const tool = manager.getToolByName(name);
	assert.ok(tool);
	assert.equal(resolveGrantPolicy(name, tool.group, role, manager), expected);
	const allowed = computeEffectiveAllowedTools(manager, role)
		.some((entry) => entry.name.toLowerCase() === name.toLowerCase());
	assert.equal(allowed, expected !== "never", `${name} effective allowlist must follow ${expected}`);
	const guard = generatedGuardMaps(manager, role);
	const declaredName = tool.name;
	assert.equal(guard.policies[declaredName]?.policy, expected);
	assert.equal(Object.prototype.hasOwnProperty.call(guard.ask, declaredName), expected === "ask");
	assert.equal(Object.prototype.hasOwnProperty.call(guard.never, declaredName), expected === "never");
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

interface PrecedenceLayer {
	label: string;
	id: string;
	scope: PackScope;
	kind: PackEntry["kind"];
	policy: ToolDefinition["policy"];
	pack?: string;
}

const precedenceLayers: readonly PrecedenceLayer[] = [
	{ label: "monolithic builtin", id: "builtin", scope: "builtin", kind: "builtin", policy: "never" },
	{ label: "first-party", id: "builtin-pack:first-party", scope: "server", kind: "market", policy: "allow", pack: "first-party" },
	{ label: "server-market", id: "market:server:server-pack", scope: "server", kind: "market", policy: "ask", pack: "server-pack" },
	{ label: "server-user", id: "user:server", scope: "server", kind: "user", policy: "allow" },
	{ label: "global-market", id: "market:global-user:global-pack", scope: "global-user", kind: "market", policy: "ask", pack: "global-pack" },
	{ label: "global-user", id: "user:global-user", scope: "global-user", kind: "user", policy: "allow" },
	{ label: "project-market", id: "market:project:project-pack", scope: "project", kind: "market", policy: "ask", pack: "project-pack" },
	{ label: "project-user", id: "user:project", scope: "project", kind: "user", policy: "allow" },
] as const;

function fixtureThroughPrecedenceLayer(winnerIndex: number): FixtureOptions {
	const included = (index: number): boolean => winnerIndex >= index;
	return {
		builtin: layerTool(precedenceLayers[0].label, precedenceLayers[0].policy),
		builtinPacks: included(1)
			? [{ packName: "first-party", tool: layerTool(precedenceLayers[1].label, precedenceLayers[1].policy) }]
			: [],
		market: [
			...(included(2) ? [{ scope: "server" as const, packName: "server-pack", tool: layerTool(precedenceLayers[2].label, precedenceLayers[2].policy) }] : []),
			...(included(4) ? [{ scope: "global-user" as const, packName: "global-pack", tool: layerTool(precedenceLayers[4].label, precedenceLayers[4].policy) }] : []),
			...(included(6) ? [{ scope: "project" as const, packName: "project-pack", tool: layerTool(precedenceLayers[6].label, precedenceLayers[6].policy) }] : []),
		],
		server: included(3) ? layerTool(precedenceLayers[3].label, precedenceLayers[3].policy) : undefined,
		globalUser: included(5) ? layerTool(precedenceLayers[5].label, precedenceLayers[5].policy) : undefined,
		project: included(7) ? layerTool(precedenceLayers[7].label, precedenceLayers[7].policy) : undefined,
	};
}

describe("tool resolution parity", () => {
	for (const [winnerIndex, winner] of precedenceLayers.entries()) {
		it(`uses the ${winner.label} definition as the same catalogue and runtime winner`, () => {
			const fixture = createFixture(fixtureThroughPrecedenceLayer(winnerIndex));
			const catalogue = catalogueEntry(fixture, "SESSION_PROMPT");

			assert.deepEqual(
				{
					name: catalogue.name,
					description: catalogue.item.description,
					policy: catalogue.item.grantPolicy,
					group: catalogue.item.group,
					originId: catalogue.origin.id,
					scope: catalogue.origin.scope,
					kind: catalogue.origin.kind,
					pack: catalogue.origin.manifest?.name,
				},
				{
					name: "session_prompt",
					description: `${winner.label} session prompt`,
					policy: winner.policy,
					group: `${winner.label} Agent`,
					originId: winner.id,
					scope: winner.scope,
					kind: winner.kind,
					pack: winner.pack,
				},
				`${winner.label} must become the actual authoritative winner`,
			);
			assert.deepEqual(
				catalogue.shadows.map((entry) => entry.id),
				precedenceLayers.slice(0, winnerIndex).map((entry) => entry.id),
				`${winner.label} must retain every exact lower-layer provenance record`,
			);
			assertRuntimeWinner(fixture, "SeSsIoN_PrOmPt", `${winner.label} full projection parity`, {
				expectedSummary: `${winner.label} winning summary`,
			});
			assertPolicySurfaces(fixture.projectManager, "SESSION_PROMPT", winner.policy);
		});
	}

	it("hydrates authoritative winners without rereading their source root", () => {
		const fixture = createFixture({ builtinSibling: true });
		const toolsBase = path.resolve(fixture.builtinConfigDir, "tools");
		const entries = fixture.cascade.resolveToolsEntries("normal-project");
		assert.equal(entries.length, 2, "fixture must expose two winners from one source root");
		fixture.projectManager.setResolvedToolEntriesProvider(() => entries);
		__resetToolScanCache();

		const originalReaddirSync = fs.readdirSync.bind(fs);
		const originalReadFileSync = fs.readFileSync.bind(fs);
		let sourceRootReads = 0;
		let sourceYamlReads = 0;
		const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation(((...args: unknown[]) => {
			if (path.resolve(String(args[0])).startsWith(toolsBase)) sourceRootReads++;
			return (originalReaddirSync as (...callArgs: unknown[]) => unknown)(...args);
		}) as typeof fs.readdirSync);
		const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
			const file = path.resolve(String(args[0]));
			if (file.startsWith(toolsBase) && file.endsWith(".yaml")) sourceYamlReads++;
			return (originalReadFileSync as (...callArgs: unknown[]) => unknown)(...args);
		}) as typeof fs.readFileSync);
		try {
			assert.deepEqual(
				fixture.projectManager.getAvailableTools().map((tool) => tool.name).sort(),
				["session_prompt", "session_status"],
			);
			assert.equal(sourceRootReads, 0, "authoritative hydration must not rescan a winner root");
			assert.equal(sourceYamlReads, 0, "authoritative hydration must not reread winner or unrelated root YAMLs");
		} finally {
			readSpy.mockRestore();
			readdirSpy.mockRestore();
		}
	});

	it("reuses one authoritative snapshot only inside a nest-safe synchronous read generation", () => {
		const fixture = createFixture({ server: layerTool("server") });
		let providerCalls = 0;
		const provider = (): ResolvedEntity<ToolInfo>[] => {
			providerCalls++;
			const resolved = fixture.cascade.resolveToolsEntries("normal-project");
			// ConfigCascade binds its normal live provider after resolving. Restore
			// this counting wrapper so the fixture can assert generation boundaries.
			fixture.projectManager.setResolvedToolEntriesProvider(provider);
			return resolved;
		};
		fixture.projectManager.setResolvedToolEntriesProvider(provider);
		__resetToolScanCache();

		fixture.projectManager.withToolReadGenerationSync(() => {
			assert.equal(fixture.projectManager.getToolByName("SESSION_PROMPT")?.grantPolicy, "ask");
			fixture.projectManager.withToolReadGenerationSync(() => {
				assert.equal(fixture.projectManager.getToolProvider("session_prompt")?.type, "bobbit-extension");
				assert.equal(fixture.projectManager.resolveToolLocation("session_prompt")?.groupDir, "agent");
			});
			assert.equal(fixture.projectManager.getResolvedToolEntry("session_prompt")?.origin.id, "user:server");
			assert.match(fixture.projectManager.getToolDocsForPrompt(["session_prompt"]), /server winning summary/);
			assert.equal(fixture.projectManager.getAvailableTools().length, 1);
		});
		assert.equal(providerCalls, 1, "nested synchronous projections must resolve authoritative entries once");

		const yamlPath = path.join(fixture.serverConfigDir, "tools", "agent", "session_prompt.yaml");
		const originalTimes = fs.statSync(yamlPath);
		writeTool(fixture.serverConfigDir, layerTool("server-updated", "allow"));
		fs.utimesSync(yamlPath, originalTimes.atime, originalTimes.mtime);
		fixture.projectManager.withToolReadGenerationSync(() => {
			assert.equal(fixture.projectManager.getToolByName("session_prompt")?.grantPolicy, "allow");
		});
		assert.equal(
			providerCalls,
			2,
			"the next lease must observe changed YAML even when its mtime is restored",
		);

		assert.throws(() => fixture.projectManager.withToolReadGenerationSync(() => {
			fixture.projectManager.getAvailableTools();
			throw new Error("fixture failure");
		}), /fixture failure/);
		fixture.projectManager.withToolReadGenerationSync(() => fixture.projectManager.getAvailableTools());
		assert.equal(providerCalls, 4, "a throwing lease must release its snapshot in finally");
	});

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

	it("normalizes projectId=headquarters to the server catalogue and runtime winner", () => {
		const fixture = createFixture({
			server: layerTool("headquarters-server", "ask"),
			project: layerTool("headquarters-project-loser", "allow"),
			market: [{
				scope: "project",
				packName: "headquarters-project-pack",
				tool: layerTool("headquarters-project-market-loser", "allow"),
			}],
		});
		const catalogue = catalogueEntry(fixture, "SESSION_PROMPT", "headquarters");

		assert.equal(catalogue.origin.id, "user:server");
		assert.equal(catalogue.origin.scope, "server");
		assert.equal(catalogue.item.description, "headquarters-server session prompt");
		assert.deepEqual(catalogue.shadows.map((entry) => entry.id), ["builtin"]);
		assert.ok(
			!catalogue.shadows.some((entry) => entry.scope === "project"),
			"Headquarters normalization must omit the project scope rather than shadowing it",
		);
		assertRuntimeWinner(fixture, "SeSsIoN_PrOmPt", "Headquarters normalized projection parity", {
			projectId: "headquarters",
			manager: fixture.serverManager,
			expectedSummary: "headquarters-server winning summary",
		});
		assertPolicySurfaces(fixture.serverManager, "SESSION_PROMPT", "ask");
	});

	it("attributes an overlapping physical market root once to the lower server scope", () => {
		const fixture = createFixture({
			market: [
				{
					scope: "server",
					packName: "shared-server-pack",
					physicalRootKey: "self-managed-overlap",
					tool: layerTool("server-overlap", "ask"),
				},
				{
					scope: "project",
					packName: "shared-project-alias",
					physicalRootKey: "self-managed-overlap",
					tool: layerTool("project-overlap-loser", "allow"),
				},
			],
		});
		const winners = fixture.cascade.resolveToolsEntries("normal-project")
			.filter((entry) => entry.name.toLowerCase() === "session_prompt");

		assert.equal(winners.length, 1, "one physical pack root must produce one logical winner");
		assert.equal(winners[0].origin.id, "market:server:shared-server-pack");
		assert.equal(winners[0].origin.scope, "server");
		assert.equal(winners[0].origin.manifest?.name, "shared-server-pack");
		assert.deepEqual(winners[0].shadows.map((entry) => entry.id), ["builtin"]);
		assert.ok(
			!winners[0].shadows.some((entry) => entry.id === "market:project:shared-project-alias"),
			"the duplicate project attribution must not conflict with itself",
		);
		assertRuntimeWinner(fixture, "SESSION_PROMPT", "overlapping self-managed root projection parity", {
			expectedSummary: "server-overlap winning summary",
		});
		assertPolicySurfaces(fixture.projectManager, "session_prompt", "ask");
	});

	it("uses one mixed-case YAML winner across external fallback, policy, providers, and activation", () => {
		const fixture = createFixture({
			server: layerTool("server"),
			project: {
				...layerTool("project"),
				declaredName: "Session_Prompt",
				providerExtension: "session_prompt-extension.ts",
			},
		});
		fixture.projectManager.registerExternalTools([
			{
				name: "session_prompt",
				description: "colliding external loser",
				group: "MCP: collision",
				provider: { type: "mcp", server: "collision", mcpTool: "session_prompt" },
			},
			{
				name: "External_Only",
				description: "external fallback control",
				group: "MCP: collision",
				provider: { type: "mcp", server: "collision", mcpTool: "external_only" },
			},
		]);

		const catalogue = catalogueEntry(fixture, "SESSION_PROMPT");
		const runtime = fixture.projectManager.getToolByName("sEsSiOn_PrOmPt");
		const canonicalRows = fixture.projectManager.getAvailableTools()
			.filter((tool) => tool.name.toLowerCase() === "session_prompt");
		const providers = fixture.projectManager.getToolProviders();

		assert.equal(catalogue.name, "Session_Prompt", "winner must retain its declared spelling");
		assert.equal(catalogue.origin.id, "user:project");
		assert.equal(catalogue.origin.scope, "project");
		assert.deepEqual(catalogue.shadows.map((entry) => entry.id), ["builtin", "user:server"]);
		assert.deepEqual(canonicalRows.map((tool) => [tool.name, tool.description]), [["Session_Prompt", "project session prompt"]]);
		assert.equal(runtime?.name, "Session_Prompt");
		assert.equal(fixture.projectManager.getAllToolNames().filter((name) => name.toLowerCase() === "session_prompt").length, 1);
		assert.equal(fixture.projectManager.getToolProvider("SESSION_PROMPT")?.type, "bobbit-extension");
		assert.equal([...providers.keys()].filter((name) => name.toLowerCase() === "session_prompt").length, 1);
		assert.equal(providers.get("Session_Prompt")?.type, "bobbit-extension");
		assertRuntimeWinner(fixture, "SESSION_PROMPT", "mixed-case detail/provider/location lookup must use the project winner");

		assert.equal(resolveGrantPolicy("Session_Prompt", runtime?.group, undefined, fixture.projectManager), "ask");
		assert.equal(resolveGrantPolicy("Session_Prompt", runtime?.group, { toolPolicies: { session_prompt: "allow" } }, fixture.projectManager), "allow");
		assert.equal(resolveGrantPolicy("Session_Prompt", runtime?.group, { toolPolicies: { session_prompt: "never" } }, fixture.projectManager), "never");
		assert.ok(computeEffectiveAllowedTools(
			fixture.projectManager,
			{ toolPolicies: { session_prompt: "allow" } },
		).some((tool) => tool.name === "Session_Prompt"));
		assert.ok(!computeEffectiveAllowedTools(
			fixture.projectManager,
			{ toolPolicies: { session_prompt: "never" } },
		).some((tool) => tool.name.toLowerCase() === "session_prompt"));

		const activation = computeToolActivationArgs(
			[{ kind: "yaml", name: "session_prompt" }],
			fixture.projectManager,
		);
		const expectedExtension = path.resolve(
			fixture.projectConfigDir,
			"tools",
			"agent",
			"session_prompt-extension.ts",
		);
		assert.ok(activation.args.includes(expectedExtension), "lowercase allowlist must activate the mixed-case winner extension");
		assert.equal(activation.args.some((arg) => arg.includes("collision")), false, "external loser must not leak into activation");

		assert.equal(fixture.projectManager.getToolByName("external_only")?.description, "external fallback control");
		assert.equal(fixture.projectManager.getToolProvider("EXTERNAL_ONLY")?.type, "mcp");
		assert.equal(fixture.projectManager.getAvailableTools().filter((tool) => tool.name.toLowerCase() === "external_only").length, 1);
	});

	it("omits an invalid global-user extension before merge and retains bounded lower provenance", () => {
		const invalid = createFixture({
			server: layerTool("server-valid", "ask"),
			globalUser: layerTool("global-invalid", "allow"),
		});
		const invalidExtension = path.join(
			invalid.globalUserBase,
			".bobbit",
			"config",
			"tools",
			"agent",
			"session_prompt-extension.ts",
		);
		writeFile(invalidExtension, "import './missing-global-helper.js';\nexport default function extension() {}\n");
		__resetToolScanCache();

		const winner = catalogueEntry(invalid);
		const diagnostics = invalid.cascade.getToolDiagnostics("normal-project");
		assert.equal(winner.origin.id, "user:server");
		assert.equal(winner.origin.scope, "server");
		assert.deepEqual(winner.shadows.map((entry) => entry.id), ["builtin"]);
		assert.equal(invalid.projectManager.getToolByName("SESSION_PROMPT")?.description, "server-valid session prompt");
		assert.equal(invalid.projectManager.getToolProvider("session_prompt")?.type, "bobbit-extension");
		assert.equal(path.resolve(invalid.projectManager.resolveToolLocation("session_prompt")!.baseDir), path.resolve(path.join(invalid.serverConfigDir, "tools")));
		assert.equal(diagnostics.length, 1, "one invalid global definition must emit one bounded diagnostic");
		assert.equal(diagnostics[0].scope, "global-user");
		assert.equal(diagnostics[0].toolName, "session_prompt");
		assert.match(diagnostics[0].message, /missing-global-helper|session_prompt-extension/i);
		const activation = computeToolActivationArgs([{ kind: "yaml", name: "session_prompt" }], invalid.projectManager);
		assert.ok(activation.args.includes(path.join(invalid.serverConfigDir, "tools", "agent", "session_prompt-extension.ts")));
		assert.equal(activation.args.includes(invalidExtension), false);

		const valid = createFixture({
			server: layerTool("server-valid", "ask"),
			globalUser: layerTool("global-valid", "allow"),
		});
		const validWinner = catalogueEntry(valid);
		assert.equal(validWinner.origin.id, "user:global-user");
		assert.equal(validWinner.origin.scope, "global-user");
		assert.equal(valid.projectManager.getToolByName("session_prompt")?.description, "global-valid session prompt");
		assert.deepEqual(valid.cascade.getToolDiagnostics("normal-project"), []);
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

	it("reveals the lower winner through every consumer when the higher named market tool is disabled", () => {
		const fixture = createFixture({
			market: [
				{ scope: "server", packName: "low-pack", tool: layerTool("low-market", "ask") },
				{ scope: "project", packName: "high-pack", tool: layerTool("high-market", "allow") },
			],
			disabled: { "project:high-pack": ["SeSsIoN_PrOmPt"] },
		});
		const catalogue = catalogueEntry(fixture);
		const highRoot = fixture.marketEntries.find((entry) => entry.id === "market:project:high-pack")!.path;

		assert.equal(catalogue.origin.id, "market:server:low-pack");
		assert.equal(catalogue.origin.scope, "server");
		assert.equal(catalogue.origin.kind, "market");
		assert.equal(catalogue.origin.manifest?.name, "low-pack");
		assert.deepEqual(catalogue.shadows.map((entry) => entry.id), ["builtin"]);
		assertRuntimeWinner(fixture, "SESSION_PROMPT", "disabled high named tool fallback", {
			expectedSummary: "low-market winning summary",
		});
		assert.equal(fixture.projectManager.getToolByName("session_prompt")?.description, "low-market session prompt");
		assertPolicySurfaces(fixture.projectManager, "SESSION_PROMPT", "ask");
		assertPolicySurfaces(
			fixture.projectManager,
			"session_prompt",
			"never",
			{ toolPolicies: { SESSION_PROMPT: "never" } },
		);
		const activation = computeToolActivationArgs(
			[{ kind: "yaml", name: "SESSION_PROMPT" }],
			fixture.projectManager,
		);
		assert.equal(
			activation.args.some((arg) => path.resolve(arg).startsWith(path.resolve(highRoot))),
			false,
			"disabled higher extension must not leak into provider activation",
		);
	});

	it("reveals the lower winner through every consumer when a whole first-party pack ships default-disabled", () => {
		const fixture = createFixture({
			builtin: layerTool("default-low", "ask"),
			builtinPacks: [{
				packName: "default-off-high-pack",
				tool: layerTool("default-off-high", "allow"),
				defaultDisabled: true,
			}],
		});
		const catalogue = catalogueEntry(fixture, "SESSION_PROMPT");
		const highRoot = path.join(fixture.builtinPacksDir, "default-off-high-pack");

		assert.equal(catalogue.origin.id, "builtin");
		assert.equal(catalogue.origin.scope, "builtin");
		assert.equal(catalogue.origin.manifest?.name, undefined);
		assert.deepEqual(catalogue.shadows.map((entry) => entry.id), []);
		assertRuntimeWinner(fixture, "session_prompt", "default-disabled whole-pack fallback", {
			expectedSummary: "default-low winning summary",
		});
		assertPolicySurfaces(fixture.projectManager, "SESSION_PROMPT", "ask");
		assertPolicySurfaces(
			fixture.projectManager,
			"session_prompt",
			"never",
			{ toolPolicies: { session_prompt: "never" } },
		);
		const activation = computeToolActivationArgs(
			[{ kind: "yaml", name: "session_prompt" }],
			fixture.projectManager,
		);
		assert.equal(
			activation.args.some((arg) => path.resolve(arg).startsWith(path.resolve(highRoot))),
			false,
			"default-disabled pack provider must not leak into activation",
		);
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
