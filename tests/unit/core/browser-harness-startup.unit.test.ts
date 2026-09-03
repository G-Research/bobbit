import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, it, vi } from "vitest";
import { discoverTests } from "../../../scripts/testing-v2/test-discovery.mjs";
import { withDistServerImportWarmup } from "../../support/harnesses/browser/dist-import-warmup.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const HARNESSES = [
	"tests/e2e/gateway-harness.ts",
	"tests/e2e/in-process-harness.ts",
	"tests/e2e/in-process-harness-realpush.ts",
] as const;
const temporaryRoots: string[] = [];
const originalBundleSetting = process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE;
const IN_PROCESS_B = [
	"api-goal-workflow-edit", "api-goals-spawn-child-route", "archive-dormant-cascade", "base-ref-pin",
	"continue-archived-multi-repo", "continue-archived-worktree-pool",
	"continue-archived-worktree-stale-source", "continue-archived-worktree", "gate-active-verification-snapshot",
	"gate-verification-resume", "goal-metadata-hierarchy", "host-agents", "marketplace-conflicts", "marketplace-mcp",
	"marketplace-pi-extension", "multi-repo-pool", "pack-local-data-runtime", "per-project-worktree-pool",
	"pool-claim-restart-resume", "pool-flow", "pr-walkthrough-host-agents", "propose-goal-tool-result-iserror",
	"provider-hook-effective-goal", "provider-session-setup", "provider-turn-hooks", "sandbox-recovery",
	"session-git-status-multi-repo", "session-prompt", "staff-cwd-parity", "unborn-worktree-session",
	"verification-timeout", "worktree-root-override",
].map(name => `tests/e2e/api/${name}.api-e2e.spec.ts`).sort();
const GATEWAY_B = [
	"anthropic-oauth-restart-sandbox-lock", "host-notifications", "mcp-integration", "mcp-tool-permission",
	"message-author-prefix-restart", "port-auto-increment", "remove-boot-respawn-restart", "session-loading-performance",
	"session-pin-archive-restart",
].map(name => `tests/e2e/api/${name}.api-e2e.spec.ts`).sort();
const CUSTOM_BOOT_B = [
	"aigw-startup-refresh", "cost-backfill-on-boot", "goal-task-sqlite-upgrade-restart", "qa-seed", "session-recovery",
].map(name => `tests/e2e/api/${name}.api-e2e.spec.ts`).sort();
const REALPUSH_B = "tests/e2e/api/goal-archive-branch-cleanup.api-e2e.spec.ts";

function temporaryStateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "bobbit-import-warmup-unit-"));
	temporaryRoots.push(root);
	return join(root, "barrier", "dist-server");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
	return { promise, resolve: resolvePromise };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("condition was not reached");
		await new Promise(resolveDelay => setTimeout(resolveDelay, 2));
	}
}

function startupImportBlock(file: string): string {
	const source = readFileSync(resolve(PROJECT_ROOT, file), "utf8");
	const start = source.indexOf("// Playwright workers share one transform cache");
	const end = source.indexOf("// Register the in-process mock bridge factory", start);
	assert.ok(start >= 0 && end > start, `${file} must retain the documented server startup boundary`);
	return source.slice(start, end);
}

function importSpecifiers(file: string): string[] {
	const source = readFileSync(resolve(PROJECT_ROOT, file), "utf8");
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const imports: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
		ts.forEachChild(node, visit);
	};
	visit(ast);
	return imports;
}

function executableServerImports(file: string): Array<{ specifier: string; routed: boolean }> {
	const source = readFileSync(resolve(PROJECT_ROOT, file), "utf8");
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const imports: Array<{ specifier: string; routed: boolean }> = [];
	const isProductionServer = (specifier: string) => /(?:^|\/)\b(?:dist|src)\/server\//.test(specifier.replace(/\\/g, "/"));
	const isInsideRawLoader = (node: ts.Node): boolean => {
		for (let current = node.parent; current; current = current.parent) {
			if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
				&& ts.isCallExpression(current.parent)
				&& current.parent.arguments[0] === current
				&& ts.isIdentifier(current.parent.expression)
				&& current.parent.expression.text === "loadE2EDistServerRuntime") return true;
		}
		return false;
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.importClause;
			const allNamedTypeOnly = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
				&& clause.namedBindings.elements.length > 0
				&& clause.namedBindings.elements.every(element => element.isTypeOnly);
			if (!clause?.isTypeOnly && !allNamedTypeOnly && isProductionServer(node.moduleSpecifier.text)) {
				imports.push({ specifier: node.moduleSpecifier.text, routed: false });
			}
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
			&& node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
			&& isProductionServer(node.arguments[0].text)) {
			imports.push({ specifier: node.arguments[0].text, routed: isInsideRawLoader(node) });
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	return imports;
}

function classifyHarness(file: string): "in-process" | "gateway" | "realpush" | "custom" {
	const imports = importSpecifiers(file);
	if (imports.some(specifier => specifier.endsWith("/in-process-harness-realpush.js"))) return "realpush";
	if (imports.some(specifier => specifier.endsWith("/gateway-harness.js"))) return "gateway";
	if (imports.some(specifier => specifier.endsWith("/in-process-harness.js"))) return "in-process";
	return "custom";
}

async function freshDistRuntime() {
	vi.resetModules();
	return import("../../support/harnesses/e2e/dist-server-runtime.js");
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
	}
	if (originalBundleSetting === undefined) delete process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE;
	else process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE = originalBundleSetting;
	vi.resetModules();
});

describe("browser harness startup", () => {
	it("warms once, then releases all waiting workers to import concurrently", async () => {
		const stateDir = temporaryStateDir();
		const warmupStarted = deferred();
		const finishWarmup = deferred();
		const finishFollowers = deferred();
		let followerStarts = 0;
		let activeFollowers = 0;
		let maxActiveFollowers = 0;

		const first = withDistServerImportWarmup(async () => {
			warmupStarted.resolve();
			await finishWarmup.promise;
			return "first";
		}, { stateDir, waitMs: 1 });
		await warmupStarted.promise;

		const follower = (value: string) => withDistServerImportWarmup(async () => {
			followerStarts++;
			activeFollowers++;
			maxActiveFollowers = Math.max(maxActiveFollowers, activeFollowers);
			await finishFollowers.promise;
			activeFollowers--;
			return value;
		}, { stateDir, waitMs: 1 });
		const second = follower("second");
		const third = follower("third");

		await new Promise(resolveDelay => setTimeout(resolveDelay, 15));
		assert.equal(followerStarts, 0, "followers must not import against a partially populated cache");
		finishWarmup.resolve();
		await waitUntil(() => followerStarts === 2);
		assert.equal(maxActiveFollowers, 2, "ready followers must not serialize behind the warmup lock");
		finishFollowers.resolve();

		assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
		assert.equal(existsSync(`${stateDir}.ready`), true);
		assert.equal(existsSync(`${stateDir}.lock`), false);
	});

	it("lets another worker become the warmer after the first worker fails", async () => {
		const stateDir = temporaryStateDir();
		const firstStarted = deferred();
		const failFirst = deferred();
		let replacementStarted = false;

		const first = withDistServerImportWarmup(async () => {
			firstStarted.resolve();
			await failFirst.promise;
			throw new Error("warmup import failed");
		}, { stateDir, waitMs: 1 });
		await firstStarted.promise;
		const replacement = withDistServerImportWarmup(async () => {
			replacementStarted = true;
			return "recovered";
		}, { stateDir, waitMs: 1 });

		failFirst.resolve();
		await assert.rejects(first, /warmup import failed/);
		assert.equal(await replacement, "recovered");
		assert.equal(replacementStarted, true);
		assert.equal(existsSync(`${stateDir}.ready`), true);
		assert.equal(existsSync(`${stateDir}.lock`), false);
	});

	it("atomically recovers an abandoned stale lock", async () => {
		const stateDir = temporaryStateDir();
		const lockPath = `${stateDir}.lock`;
		mkdirSync(lockPath, { recursive: true });
		const staleDate = new Date(Date.now() - 10_000);
		utimesSync(lockPath, staleDate, staleDate);

		const result = await withDistServerImportWarmup(async () => "recovered", {
			stateDir,
			staleMs: 5,
			waitMs: 1,
			timeoutMs: 500,
		});

		assert.equal(result, "recovered");
		assert.equal(existsSync(`${stateDir}.ready`), true);
		assert.equal(existsSync(lockPath), false);
		assert.equal(
			readFileSync(`${stateDir}.ready`, "utf8"),
			"dist-server-imports-ready-v1\n",
		);
	});

	it("keeps each harness import graph ordered behind the warmup barrier", () => {
		for (const file of HARNESSES) {
			const block = startupImportBlock(file);
			assert.match(block, /withDistServerImportWarmup/, `${file} must use the first-writer barrier`);
			const imports = [
				"dist/server/bobbit-dir.js",
				"dist/server/scaffold.js",
				"dist/server/auth/token.js",
				"dist/server/server.js",
				"dist/server/agent/rpc-bridge.js",
			];
			let previous = -1;
			for (const imported of imports) {
				const position = block.indexOf(imported);
				assert.ok(position > previous, `${file} must import ${imported} in canonical order`);
				previous = position;
			}
			assert.doesNotMatch(block, /Promise\.all/, `${file} must keep shared-graph roots ordered`);
		}
	});

	it("routes every Group B executable server import through exactly one runtime mode", () => {
		const groupB = [...discoverTests().e2eGroups.B];
		assert.deepEqual(groupB.filter(file => classifyHarness(file) === "in-process").sort(), IN_PROCESS_B);
		assert.deepEqual(groupB.filter(file => classifyHarness(file) === "gateway").sort(), GATEWAY_B);
		assert.deepEqual(groupB.filter(file => classifyHarness(file) === "custom").sort(), CUSTOM_BOOT_B);
		assert.deepEqual(groupB.filter(file => classifyHarness(file) === "realpush"), [REALPUSH_B]);

		for (const file of [...groupB, "tests/e2e/in-process-harness.ts", "tests/e2e/gateway-harness.ts"]) {
			for (const imported of executableServerImports(file)) {
				assert.equal(imported.routed, true, `${file}: executable ${imported.specifier} must be inside the raw callback`);
			}
		}
		const realpushImports = executableServerImports("tests/e2e/in-process-harness-realpush.ts");
		assert.ok(realpushImports.length > 0, "the forced-realpush sentinel must retain real server imports");
		assert.equal(realpushImports.every(imported => !imported.routed), true);
		assert.equal(importSpecifiers("tests/e2e/in-process-harness-realpush.ts").some(value => value.includes("dist-server-runtime")), false);
	});

	it("sets isolated roots before eligible loads while focused, realpush, and Group C remain raw", () => {
		for (const file of ["tests/e2e/in-process-harness.ts", "tests/e2e/gateway-harness.ts"]) {
			const source = readFileSync(resolve(PROJECT_ROOT, file), "utf8");
			assert.ok(source.indexOf("installRunIsolation();") < source.indexOf("loadE2EDistServerRuntime(async"), file);
		}
		for (const file of CUSTOM_BOOT_B) {
			const source = readFileSync(resolve(PROJECT_ROOT, file), "utf8");
			assert.ok(source.indexOf("process.env.BOBBIT_DIR") < source.indexOf("loadE2EDistServerRuntime(async"), `${file} must set env before load`);
		}
		const runner = readFileSync(resolve(PROJECT_ROOT, "scripts/testing-v2/run-e2e-v2.mjs"), "utf8");
		const focusedBranch = runner.match(/if \(only\) \{[\s\S]*?\n\t\} else \{/)?.[0] ?? "";
		assert.doesNotMatch(focusedBranch, /prepareE2EDistServerPrebundle|BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE/);
		const removeAt = runner.indexOf('deleteEnvironmentValue(sharedPlaywrightEnv, "BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE")');
		const cAt = runner.indexOf("await runSerialGroupC(C, sharedPlaywrightEnv");
		assert.ok(removeAt > 0 && cAt > removeAt, "the bundle setting must be removed before C starts");
		for (const file of [
			"tests/e2e/browser/stories-resilience.browser-e2e.spec.ts",
			"tests/e2e/browser/pr-walkthrough-pack.browser-e2e.spec.ts",
			"tests/e2e/browser/packaged-inline-html-theme.browser-e2e.spec.ts",
			"tests/e2e/browser/source-vite-inline-html-theme.browser-e2e.spec.ts",
		]) {
			assert.equal(executableServerImports(file).every(imported => !imported.routed), true, `${file} remains raw`);
		}
	});

	it("uses the focused raw callback when no runner setting exists", async () => {
		delete process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE;
		const runtime = await freshDistRuntime();
		let calls = 0;
		const first = await runtime.loadE2EDistServerRuntime(async () => ({ mode: "raw", call: ++calls }));
		const second = await runtime.loadE2EDistServerRuntime(async () => ({ mode: "raw", call: ++calls }));
		assert.deepEqual([first, second], [{ mode: "raw", call: 1 }, { mode: "raw", call: 2 }]);
		assert.equal(runtime.e2eDistServerRuntimeMode(), "raw");
	});

	it("rejects missing or failed selected bundles without invoking the raw callback", async () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-e2e-dist-loader-"));
		temporaryRoots.push(root);
		let rawCalls = 0;
		process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE = join(root, "missing.mjs");
		let runtime = await freshDistRuntime();
		await assert.rejects(runtime.loadE2EDistServerRuntime(async () => { rawCalls++; return {}; }), /configured prebundle does not exist/);
		assert.equal(rawCalls, 0, "missing pre-spawn selection must fail rather than mix modes");

		const broken = join(root, "broken.mjs");
		writeFileSync(broken, 'throw new Error("selected bundle evaluation failed");\n');
		process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE = broken;
		runtime = await freshDistRuntime();
		await assert.rejects(runtime.loadE2EDistServerRuntime(async () => { rawCalls++; return {}; }), /selected bundle evaluation failed/);
		await assert.rejects(runtime.loadE2EDistServerRuntime(async () => { rawCalls++; return {}; }), /selected bundle evaluation failed/);
		assert.equal(rawCalls, 0, "post-selection evaluation failures must remain fatal and memoized");
	});

	it("rejects synthetic mixed-mode workers before loading their second graph", async () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-e2e-dist-mixed-"));
		temporaryRoots.push(root);
		const bundle = join(root, "bundle.mjs");
		writeFileSync(bundle, "export const mode = 'bundle';\n");

		delete process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE;
		let runtime = await freshDistRuntime();
		await runtime.loadE2EDistServerRuntime(async () => ({ mode: "raw" }));
		process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE = bundle;
		await assert.rejects(runtime.loadE2EDistServerRuntime(async () => ({ mode: "second-raw" })), /mode changed from raw to bundle/);

		process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE = bundle;
		runtime = await freshDistRuntime();
		await runtime.loadE2EDistServerRuntime(async () => ({ mode: "raw" }));
		delete process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE;
		await assert.rejects(runtime.loadE2EDistServerRuntime(async () => ({ mode: "raw" })), /mode changed from bundle to raw/);
	});
});
