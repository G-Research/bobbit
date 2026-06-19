/**
 * Focused unit tests for the goal-metadata ACTIVATION EDGES owned by the
 * lifecycle/session-setup layer (hierarchical goal metadata goal):
 *
 *   1. tool-activation: `bobbit.disabledTools` drops tools in BOTH the role
 *      allowlist branch AND the unrestricted/all-tools branch, and forces the
 *      guard policy to `never`. Empty/absent ⇒ byte-identical to today.
 *   2. system-prompt: `bobbit.promptSectionOrder` (PromptParts.sectionOrder)
 *      reorders sections stably; absent ⇒ byte-identical default order.
 *   3. LifecycleHub: `bobbit.disabledProviders` filters providers in
 *      `dispatch`, `hasProvidersForHooks`, and `dispatchGoalProvisioned`;
 *      absent resolver ⇒ no filtering.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
	computeToolActivationArgs,
	writeToolGuardExtension,
	type EffectiveTool,
} from "../src/server/agent/tool-activation.ts";
import type { ToolProvider } from "../src/server/agent/tool-manager.ts";
import { reorderLabeledSections, assembleSystemPrompt, getPromptSections, initPromptDirs } from "../src/server/agent/system-prompt.ts";
import { LifecycleHub, type HookCtx } from "../src/server/agent/lifecycle-hub.ts";
import type { ProviderContribution } from "../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import { ModuleHost } from "../src/server/extension-host/module-host-worker.ts";
import { ContextTraceStore } from "../src/server/agent/context-trace-store.ts";

// ── 1. tool-activation: bobbit.disabledTools ────────────────────────────────

type ProviderWithGroup = ToolProvider & { groupDir: string; baseDir: string };
const MOCK_TOOLS_DIR = "/mock/tools";

function mockToolManager(providers: Map<string, ProviderWithGroup>) {
	return {
		getToolProviders: () => providers,
		getExtensionPath: (groupDir: string, filename: string) => path.join(MOCK_TOOLS_DIR, groupDir, filename),
	} as any;
}

function standardProviders(): Map<string, ProviderWithGroup> {
	return new Map<string, ProviderWithGroup>([
		["read", { type: "builtin", tool: "read", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["write", { type: "builtin", tool: "write", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["edit", { type: "builtin", tool: "edit", groupDir: "filesystem", baseDir: MOCK_TOOLS_DIR }],
		["web_search", { type: "bobbit-extension", extension: "extension.ts", groupDir: "web", baseDir: MOCK_TOOLS_DIR }],
		["browser_navigate", { type: "bobbit-extension", extension: "extension.ts", groupDir: "browser", baseDir: MOCK_TOOLS_DIR }],
	]);
}

function yamlTools(...names: string[]): EffectiveTool[] {
	return names.map(name => ({ kind: "yaml" as const, name }));
}

function extPaths(args: string[]): string[] {
	return args.filter((_a, i) => i > 0 && args[i - 1] === "--extension").map(p => p.replace(/\\/g, "/"));
}

describe("computeToolActivationArgs — bobbit.disabledTools", () => {
	it("drops a disabled builtin in the role-allowlist branch", () => {
		const tm = mockToolManager(standardProviders());
		const result = computeToolActivationArgs(yamlTools("read", "write", "edit"), tm, undefined, undefined, new Set(["write"]));
		assert.equal(result.env.BOBBIT_BUILTIN_TOOLS, "edit,read");
	});

	it("drops a disabled extension in the UNRESTRICTED/all-tools branch", () => {
		const tm = mockToolManager(standardProviders());
		// allowedTools undefined → unrestricted; browser_navigate must still be removed.
		const result = computeToolActivationArgs(undefined, tm, undefined, undefined, new Set(["browser_navigate"]));
		assert.ok(!extPaths(result.args).some(p => p.includes("/browser/")), "disabled extension must not load in unrestricted mode");
		assert.ok(extPaths(result.args).some(p => p.includes("/web/")), "non-disabled extension still loads");
	});

	it("lower-cases the candidate tool name before matching the (lower-cased) set", () => {
		const tm = mockToolManager(standardProviders());
		// The set is lower-cased by the caller (session-setup); the builder lower-
		// cases each candidate tool name before lookup, so mixed-case tool names match.
		const result = computeToolActivationArgs(
			[{ kind: "yaml" as const, name: "READ" }, { kind: "yaml" as const, name: "write" }],
			tm, undefined, undefined, new Set(["read"]),
		);
		assert.equal(result.env.BOBBIT_BUILTIN_TOOLS, "write");
	});

	it("empty/absent disabled set is byte-identical to today", () => {
		const tm = mockToolManager(standardProviders());
		const baseline = computeToolActivationArgs(yamlTools("read", "write"), tm);
		const empty = computeToolActivationArgs(yamlTools("read", "write"), tm, undefined, undefined, new Set());
		assert.deepEqual(empty.args, baseline.args);
		assert.deepEqual(empty.env, baseline.env);
	});
});

describe("writeToolGuardExtension — disabled tools forced to never", () => {
	let tmp: string;
	beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-disabled-"))); process.env.BOBBIT_DIR = tmp; });
	afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

	function tm() {
		// Two allow-by-default tools; the guard is normally skipped entirely.
		const getAvailableTools = () => [
			{ name: "read", group: "filesystem", grantPolicy: "allow" },
			{ name: "write", group: "filesystem", grantPolicy: "allow" },
		];
		return {
			getAvailableTools,
			getToolByName: (n: string) => getAvailableTools().find(t => t.name === n),
			getToolProviders: () => new Map(),
		} as any;
	}

	it("emits a guard (hard-block) for a disabled tool even when all else is allow", () => {
		const noDisable = writeToolGuardExtension("g-none", tm(), undefined, undefined, undefined, []);
		assert.equal(noDisable, undefined, "no guard when every tool is allow and nothing disabled");

		const withDisable = writeToolGuardExtension("g-disable", tm(), undefined, undefined, undefined, [], new Set(["write"]));
		assert.ok(withDisable, "guard must be emitted to hard-block the disabled tool");
		const code = fs.readFileSync(withDisable!, "utf-8");
		assert.ok(code.includes("write"), "guard source should reference the disabled tool");
	});
});

// ── 2. system-prompt: section ordering ──────────────────────────────────────

describe("reorderLabeledSections", () => {
	const mk = (...labels: string[]) => labels.map(label => ({ label, content: label }));

	it("returns input unchanged when no order given", () => {
		const s = mk("A", "B", "C");
		assert.equal(reorderLabeledSections(s, undefined), s);
		assert.equal(reorderLabeledSections(s, []), s);
	});

	it("moves listed labels first in the given order, unlisted keep relative order", () => {
		const out = reorderLabeledSections(mk("A", "B", "C", "D"), ["C", "A"]).map(s => s.label);
		assert.deepEqual(out, ["C", "A", "B", "D"]);
	});

	it("ignores unknown labels in the order list", () => {
		const out = reorderLabeledSections(mk("A", "B"), ["Z", "B"]).map(s => s.label);
		assert.deepEqual(out, ["B", "A"]);
	});
});

describe("assembleSystemPrompt — bobbit.promptSectionOrder", () => {
	let stateDir: string;
	let cwdDir: string;
	beforeEach(() => {
		const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sp-order-meta-")));
		stateDir = path.join(tmp, "state");
		fs.mkdirSync(path.join(stateDir, "session-prompts"), { recursive: true });
		process.env.BOBBIT_DIR = tmp;
		initPromptDirs(stateDir);
		cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-order-meta-cwd-"));
	});
	afterEach(() => { try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ } });

	const parts = () => ({
		cwd: cwdDir,
		goalTitle: "G",
		goalState: "in-progress",
		goalSpec: "spec",
		toolDocs: "# Tools\n\n- bash",
	}) as Parameters<typeof assembleSystemPrompt>[1];

	it("reorders Goal before Tools when requested", () => {
		const p = assembleSystemPrompt("order-meta", { ...parts(), sectionOrder: ["Goal", "Tools"] });
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		assert.ok(content.indexOf("# Goal") < content.indexOf("# Tools"), "Goal must precede Tools when ordered");
	});

	it("absent order keeps the stable default (Tools before Goal)", () => {
		const p = assembleSystemPrompt("order-meta-default", parts());
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		assert.ok(content.indexOf("# Tools") < content.indexOf("# Goal"), "default keeps Tools before Goal");
	});

	it("getPromptSections honors the same ordering", () => {
		const sections = getPromptSections({ ...parts(), sectionOrder: ["Goal", "Tools"] });
		const labels = sections.map(s => s.label);
		assert.ok(labels.indexOf("Goal") < labels.indexOf("Tools"));
	});
});

// ── 3. LifecycleHub: bobbit.disabledProviders ───────────────────────────────

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-meta-hub-")));
}

let seq = 0;
function fixtureProvider(tmp: string, id: string, body: string, hooks: string[] = ["sessionSetup"]): ProviderContribution {
	const file = path.join(tmp, `${id}-${seq++}.mjs`);
	fs.writeFileSync(file, body);
	return {
		id,
		kind: "memory",
		module: path.basename(file),
		hooks,
		budget: { maxTokens: 400, timeoutMs: 2_000 },
		config: { enabled: true },
		listName: id,
		sourceFile: path.join(tmp, "pack.yaml"),
		packRoot: tmp,
	};
}

function registry(providers: ProviderContribution[]): PackContributionRegistry {
	return { listProviders: () => providers } as unknown as PackContributionRegistry;
}

function hub(tmp: string, providers: ProviderContribution[], moduleHost: ModuleHost, resolver?: (goalId: string | undefined) => Record<string, unknown>): LifecycleHub {
	return new LifecycleHub({
		registry: registry(providers),
		moduleHost,
		trace: new ContextTraceStore(path.join(tmp, "state")),
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "tok" }),
		...(resolver ? { goalMetadataResolver: (goalId: string | undefined) => resolver(goalId) } : {}),
	});
}

function base(tmp: string, goalId?: string): Omit<HookCtx, "budget" | "config" | "gateway"> {
	return { sessionId: "s1", projectId: "p1", scope: "project", cwd: tmp, goalId };
}

describe("LifecycleHub — bobbit.disabledProviders", () => {
	it("filters disabled providers in dispatch by effective goal metadata", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const keep = fixtureProvider(tmp, "keep", `export default { async sessionSetup() { return { blocks: [{ id: "k", title: "K", authority: "memory", content: "keep", reason: "r", priority: 1 }] }; } };`);
			const drop = fixtureProvider(tmp, "drop", `export default { async sessionSetup() { return { blocks: [{ id: "d", title: "D", authority: "memory", content: "drop", reason: "r", priority: 1 }] }; } };`);
			const resolver = (goalId: string | undefined) => goalId === "g-treat" ? { "bobbit.disabledProviders": ["drop"] } : {};
			const h = hub(tmp, [keep, drop], moduleHost, resolver);

			const treated = await h.dispatch("sessionSetup", base(tmp, "g-treat"));
			assert.deepEqual(treated.blocks.map(b => b.providerId), ["keep"], "disabled provider must be filtered");

			const control = await h.dispatch("sessionSetup", base(tmp, "g-control"));
			assert.deepEqual(control.blocks.map(b => b.providerId).sort(), ["drop", "keep"], "sibling goal unaffected");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("hasProvidersForHooks excludes disabled providers for the goal", () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const p = fixtureProvider(tmp, "memory", `export default {};`, ["beforePrompt"]);
			const resolver = (goalId: string | undefined) => goalId === "g-off" ? { "bobbit.disabledProviders": ["memory"] } : {};
			const h = hub(tmp, [p], moduleHost, resolver);
			assert.equal(h.hasProvidersForHooks("p1", ["beforePrompt"], "g-on"), true);
			assert.equal(h.hasProvidersForHooks("p1", ["beforePrompt"], "g-off"), false);
			// No resolver wired ⇒ never filtered.
			const h2 = hub(tmp, [p], moduleHost);
			assert.equal(h2.hasProvidersForHooks("p1", ["beforePrompt"], "g-off"), true);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("dispatchGoalProvisioned invokes only enabled providers declaring the hook", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const markerKeep = path.join(tmp, "keep.marker");
			const markerDrop = path.join(tmp, "drop.marker");
			const keep = fixtureProvider(tmp, "keep", `import fs from "node:fs"; export default { async goalProvisioned(ctx) { fs.writeFileSync(${JSON.stringify(markerKeep)}, String(ctx.goalId)); } };`, ["goalProvisioned"]);
			const drop = fixtureProvider(tmp, "drop", `import fs from "node:fs"; export default { async goalProvisioned(ctx) { fs.writeFileSync(${JSON.stringify(markerDrop)}, String(ctx.goalId)); } };`, ["goalProvisioned"]);
			const resolver = (_goalId: string | undefined) => ({ "bobbit.disabledProviders": ["drop"] });
			const h = hub(tmp, [keep, drop], moduleHost, resolver);

			await h.dispatchGoalProvisioned({ goalId: "g1", projectId: "p1", worktreePath: tmp, cwd: tmp, metadata: { "bobbit.disabledProviders": ["drop"] } });

			assert.ok(fs.existsSync(markerKeep), "enabled provider's goalProvisioned must run");
			assert.ok(!fs.existsSync(markerDrop), "disabled provider's goalProvisioned must NOT run");
			assert.equal(fs.readFileSync(markerKeep, "utf-8"), "g1");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
