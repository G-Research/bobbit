import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

interface Cache {
	prime(gatewayGeneration: number): void;
	restoreIfNeeded(gatewayGeneration: number): Promise<boolean>;
}

type CacheConstructor = new (fingerprint: () => string, restore: () => Promise<void>) => Cache;
type DefaultProjectFingerprint = (gateway: unknown) => string;

/**
 * Load the small, side-effect-free cache seam from the browser E2E harness.
 * Importing that harness would install process-wide run isolation and construct
 * Playwright fixtures, so this unit evaluates only the exact declarations under
 * test while also pinning that the class remains exported.
 */
function loadHarnessSeams(): {
	DefaultProjectFixtureCache: CacheConstructor;
	defaultProjectFingerprint: DefaultProjectFingerprint;
} {
	const file = resolve(import.meta.dirname, "..", "..", "e2e", "gateway-harness.ts");
	const source = readFileSync(file, "utf8");
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declarations = new Map<string, ts.FunctionDeclaration | ts.ClassDeclaration>();
	for (const statement of ast.statements) {
		if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
			declarations.set(statement.name.text, statement);
		}
	}

	const stableStringify = declarations.get("stableStringify");
	const fingerprint = declarations.get("defaultProjectFingerprint");
	const uncertain = declarations.get("fingerprintUncertain");
	const cache = declarations.get("DefaultProjectFixtureCache");
	assert.ok(stableStringify && ts.isFunctionDeclaration(stableStringify));
	assert.ok(fingerprint && ts.isFunctionDeclaration(fingerprint));
	assert.ok(uncertain && ts.isFunctionDeclaration(uncertain));
	assert.ok(cache && ts.isClassDeclaration(cache));
	assert.ok(cache.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
		"DefaultProjectFixtureCache must remain an exported test seam");

	const cacheSource = cache.getText(ast).replace(/^export\s+/, "");
	const javascript = ts.transpileModule([
		stableStringify.getText(ast),
		fingerprint.getText(ast),
		uncertain.getText(ast),
		cacheSource,
	].join("\n"), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
	}).outputText;
	return new Function(`${javascript}\nreturn { DefaultProjectFixtureCache, defaultProjectFingerprint };`)() as {
		DefaultProjectFixtureCache: CacheConstructor;
		defaultProjectFingerprint: DefaultProjectFingerprint;
	};
}

const { DefaultProjectFixtureCache, defaultProjectFingerprint } = loadHarnessSeams();

interface FixtureState {
	project: { id: string; name: string; hidden: boolean; rootPath: string };
	config: Record<string, unknown>;
	components: Array<Record<string, unknown>>;
	workflows: Record<string, unknown>;
}

function baselineState(): FixtureState {
	return {
		project: { id: "project-1", name: "default", hidden: false, rootPath: "/fixture/default" },
		config: { buildCommand: "npm run build", sandbox: "none" },
		components: [{ name: "app", repo: ".", commands: { check: "npm run check" } }],
		workflows: { release: { name: "Release", gates: [{ id: "verify", type: "review" }] } },
	};
}

function cloneState(state: FixtureState): FixtureState {
	return structuredClone(state);
}

function gatewayFor(state: FixtureState): unknown {
	return {
		projectContextManager: {
			visible: () => [{
				project: state.project,
				projectConfigStore: {
					getAll: () => state.config,
					getComponents: () => state.components,
					getWorkflows: () => state.workflows,
				},
			}],
		},
	};
}

describe("default project fixture cache", () => {
	it("skips restore for the same known fingerprint and gateway generation", async () => {
		let fingerprint = "ok:clean";
		const restore = vi.fn(async () => { fingerprint = "ok:clean"; });
		const cache = new DefaultProjectFixtureCache(() => fingerprint, restore);

		cache.prime(7);

		await expect(cache.restoreIfNeeded(7)).resolves.toBe(false);
		expect(restore).not.toHaveBeenCalled();
	});

	it("restores an actual project/config mutation exactly once and advances after success", async () => {
		const expected = baselineState();
		let state = cloneState(expected);
		const fingerprint = () => defaultProjectFingerprint(gatewayFor(state));
		const restore = vi.fn(async () => { state = cloneState(expected); });
		const cache = new DefaultProjectFixtureCache(fingerprint, restore);
		cache.prime(3);
		state.project.rootPath = "/mutated/root";
		state.config.buildCommand = "mutated-command";
		state.components[0].repo = "mutated-repo";
		state.workflows.release = { name: "Mutated", gates: [] };

		await expect(cache.restoreIfNeeded(3)).resolves.toBe(true);
		expect(restore).toHaveBeenCalledTimes(1);
		expect(state).toEqual(expected);
		await expect(cache.restoreIfNeeded(3)).resolves.toBe(false);
		expect(restore).toHaveBeenCalledTimes(1);
	});

	it("invalidates the fast path when a gateway restart advances generation", async () => {
		const restore = vi.fn(async () => {});
		const cache = new DefaultProjectFixtureCache(() => "ok:clean", restore);
		cache.prime(1);

		await expect(cache.restoreIfNeeded(2)).resolves.toBe(true);
		await expect(cache.restoreIfNeeded(2)).resolves.toBe(false);
		expect(restore).toHaveBeenCalledTimes(1);
	});

	it.each(["missing", "unknown:store unavailable"])("never caches uncertain state %s", async uncertain => {
		let fingerprint = uncertain;
		const restore = vi.fn(async () => {});
		const cache = new DefaultProjectFixtureCache(() => fingerprint, restore);
		cache.prime(1);

		await expect(cache.restoreIfNeeded(1)).rejects.toThrow(`fingerprint unavailable after restore: ${uncertain}`);
		fingerprint = "ok:restored";
		await expect(cache.restoreIfNeeded(1)).resolves.toBe(true);
		await expect(cache.restoreIfNeeded(1)).resolves.toBe(false);
		expect(restore).toHaveBeenCalledTimes(2);
	});

	it("does not poison the next attempt when restore fails", async () => {
		let fingerprint = "ok:baseline";
		let attempts = 0;
		const cache = new DefaultProjectFixtureCache(
			() => fingerprint,
			async () => {
				attempts++;
				if (attempts === 1) throw new Error("restore failed deliberately");
				fingerprint = "ok:baseline";
			},
		);
		cache.prime(4);
		fingerprint = "ok:mutated";

		await expect(cache.restoreIfNeeded(4)).rejects.toThrow("restore failed deliberately");
		await expect(cache.restoreIfNeeded(4)).resolves.toBe(true);
		await expect(cache.restoreIfNeeded(4)).resolves.toBe(false);
		expect(attempts).toBe(2);
	});

	it("fingerprints every restored project and config field", () => {
		const baseline = baselineState();
		const baselineFingerprint = defaultProjectFingerprint(gatewayFor(baseline));
		const mutations: Array<[string, (state: FixtureState) => void]> = [
			["project.id", state => { state.project.id = "project-2"; }],
			["project.name", state => { state.project.name = "renamed"; }],
			["project.hidden", state => { state.project.hidden = true; }],
			["project.rootPath", state => { state.project.rootPath = "/other/root"; }],
			["config", state => { state.config.sandbox = "docker"; }],
			["components", state => { state.components[0].repo = "packages/app"; }],
			["workflows", state => { state.workflows.release = { name: "Changed", gates: [] }; }],
		];

		for (const [field, mutate] of mutations) {
			const changed = cloneState(baseline);
			mutate(changed);
			expect(defaultProjectFingerprint(gatewayFor(changed)), field).not.toBe(baselineFingerprint);
		}
	});

	it("keeps cache baselines isolated across owners and workers", async () => {
		const ownerAWorker1Restore = vi.fn(async () => {});
		const ownerAWorker1 = new DefaultProjectFixtureCache(() => "ok:shared-value", ownerAWorker1Restore);
		ownerAWorker1.prime(1);
		await expect(ownerAWorker1.restoreIfNeeded(1)).resolves.toBe(false);

		for (const scope of ["owner-b/worker-1", "owner-a/worker-2"]) {
			const restore = vi.fn(async () => {});
			const isolated = new DefaultProjectFixtureCache(() => "ok:shared-value", restore);
			await expect(isolated.restoreIfNeeded(1), scope).resolves.toBe(true);
			expect(restore, scope).toHaveBeenCalledTimes(1);
		}
		expect(ownerAWorker1Restore).not.toHaveBeenCalled();
	});
});
