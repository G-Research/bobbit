import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateToolResultFilterExtension } from "../../src/server/agent/tool-result-filter-extension.js";

const require = createRequire(import.meta.url);
const packageName = "@earendil-works/pi-coding-agent";
const packagePatches = [
	fileURLToPath(new URL("../../patches/@earendil-works+pi-agent-core+0.84.1.patch", import.meta.url)),
	fileURLToPath(new URL("../../patches/@earendil-works+pi-coding-agent+0.84.1.patch", import.meta.url)),
];
const scenarioFile = fileURLToPath(new URL("./tool-result-filter-pi-gate-scenario.mjs", import.meta.url));
const scenarioSuccess = "PI_RESULT_GATE_SCENARIO_PASSED\n";
// Node 26 emits these exact upstream warning frames while loading Pi's
// published ESM. Remove complete, known frames only: unexpected child stderr
// remains a test failure rather than being hidden by broad normalization.
// The line-start assertion must be zero-width: global matching otherwise consumes
// the separator newline and prevents an adjacent complete frame from matching.
const NODE_26_DEP0205 = /(?<![^\n])\(node:\d+\) \[DEP0205\] DeprecationWarning: (?:Automatic \.js syntax detection is deprecated and may change in the future\.|`module\.register\(\)` is deprecated\. Use `module\.registerHooks\(\)` instead\.)\n\(Use `node --trace-deprecation \.\.\.` to show where the warning was created\)(?=\n|$)\n?/g;

function withoutKnownNode26Dep0205(stderr: string): string {
	return stderr.replace(NODE_26_DEP0205, "");
}

type Hunk = { oldStart: number; newStart: number; lines: string[] };
type PatchFile = { path: string; hunks: Hunk[] };
type ChildScenarioResult = { stdout: string; stderr: string; exitCode: number | null; signal: string | null };
type ChildScenarioOutcome = ChildScenarioResult | { error: string };

function parsePatch(patchFile: string): PatchFile[] {
	const files: PatchFile[] = [];
	let current: PatchFile | undefined;
	let hunk: Hunk | undefined;
	for (const line of readFileSync(patchFile, "utf8").split("\n")) {
		if (line.startsWith("+++ b/")) {
			current = { path: line.slice(6), hunks: [] };
			files.push(current);
			hunk = undefined;
			continue;
		}
		if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("index ")) {
			hunk = undefined;
			continue;
		}
		const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (match && current) {
			hunk = { oldStart: Number(match[1]), newStart: Number(match[2]), lines: [] };
			current.hunks.push(hunk);
			continue;
		}
		if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) hunk.lines.push(line);
	}
	return files;
}

/** Applies the shipped unified patch entirely in the temporary copied package. */
function applyPatch(root: string, patchFile: string, reverse = false): void {
	for (const file of parsePatch(patchFile)) {
		if (!file.path.startsWith("node_modules/")) throw new Error(`Unexpected patch target: ${file.path}`);
		const target = join(root, file.path);
		const source = readFileSync(target, "utf8");
		const hasTrailingNewline = source.endsWith("\n");
		const lines = source.split("\n");
		if (hasTrailingNewline) lines.pop();
		let offset = 0;
		for (const hunk of file.hunks) {
			const start = (reverse ? hunk.newStart : hunk.oldStart) - 1 + offset;
			const before = hunk.lines.filter(line => line[0] === " " || line[0] === (reverse ? "+" : "-")).map(line => line.slice(1));
			const after = hunk.lines.filter(line => line[0] === " " || line[0] === (reverse ? "-" : "+")).map(line => line.slice(1));
			if (before.some((line, index) => lines[start + index] !== line)) throw new Error(`Patch context did not match ${file.path}`);
			lines.splice(start, before.length, ...after);
			offset += after.length - before.length;
		}
		writeFileSync(target, `${lines.join("\n")}${hasTrailingNewline ? "\n" : ""}`);
	}
}

function runChildScenario(root: string): Promise<ChildScenarioResult> {
	return new Promise((resolve, reject) => {
		// Tier-1 intentionally fences direct child_process use. This minimal worker
		// owns no Pi imports and brokers the real child Node process, keeping its
		// temporary module cache outside the Vitest process.
		const worker = new Worker(pathToFileURL(scenarioFile), { workerData: root });
		let outcome: ChildScenarioOutcome | undefined;
		worker.once("message", message => { outcome = message as ChildScenarioOutcome; });
		worker.once("error", reject);
		worker.once("exit", code => {
			if (code !== 0) return reject(new Error(`Pi scenario broker exited with code ${code}`));
			if (!outcome) return reject(new Error("Pi scenario broker exited without a result"));
			if ("error" in outcome) return reject(new Error(`Pi scenario child failed: ${outcome.error}`));
			resolve(outcome);
		});
	});
}

function applyShippedPatch(root: string, patchFile: string): void {
	// postinstall may already have patched the copied source. Normalize to the
	// published base first, then prove the shipped offsets apply pristine-forward,
	// patched-reverse, and forward again without fuzzy context matching.
	try {
		applyPatch(root, patchFile, true);
	} catch {
		// A pristine copy has no reverse hunk to apply.
	}
	applyPatch(root, patchFile);
	applyPatch(root, patchFile, true);
	applyPatch(root, patchFile);
}

/**
 * Runs an exact copy of the installed Pi packages under a private node_modules
 * root. A stale checkout can therefore prove the patch without changing the
 * checkout's dependency tree, while a freshly postinstalled checkout is
 * normalized back to its package base before the same patch is applied.
 */
function createPatchedPiHarness(): string {
	const sourcePackage = (require.resolve.paths(packageName) ?? [])
		.map(nodeModules => join(nodeModules, packageName))
		.find(candidate => existsSync(join(candidate, "package.json")));
	if (!sourcePackage) throw new Error(`Cannot find ${packageName} package root`);
	const sourcePackageJson = join(sourcePackage, "package.json");
	const sourceNodeModules = dirname(dirname(sourcePackage));
	const version = JSON.parse(readFileSync(sourcePackageJson, "utf8")).version;
	expect(version).toBe("0.84.1");

	const root = mkdtempSync(join(tmpdir(), "bobbit-pi-result-gate-"));
	const targetPackage = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	const sourceAgentCore = join(sourceNodeModules, "@earendil-works", "pi-agent-core");
	const targetAgentCore = join(root, "node_modules", "@earendil-works", "pi-agent-core");
	// Both Pi packages contain large private dependency trees which the shipped
	// patches never touch. Copy only the package source under test, then retain
	// the exact private layouts as read-only links to the installed packages.
	// This removes the 157 MiB copy/delete fixture cycle that Defender serializes
	// on Windows while preserving Node's package-resolution behavior (including
	// coding-agent's private pi-tui and nested Pi dependencies).
	const withoutPrivateNodeModules = (source: string) => source !== join(sourcePackage, "node_modules")
		&& source !== join(sourceAgentCore, "node_modules");
	cpSync(sourcePackage, targetPackage, { recursive: true, filter: withoutPrivateNodeModules });
	cpSync(sourceAgentCore, targetAgentCore, { recursive: true, filter: withoutPrivateNodeModules });
	// The copied Pi package sources are the only code we modify. Their dependencies
	// remain read-only references to the runner's tree, matching the prior copied
	// module layout without the Windows-heavy duplicate filesystem work.
	symlinkSync(join(sourcePackage, "node_modules"), join(targetPackage, "node_modules"), "dir");
	symlinkSync(sourceNodeModules, join(targetAgentCore, "node_modules"), "dir");
	symlinkSync(join(sourceNodeModules, "@earendil-works", "pi-ai"), join(root, "node_modules", "@earendil-works", "pi-ai"), "dir");
	for (const patch of packagePatches) applyShippedPatch(root, patch);
	// The Pi harness imports this exact production gate, not a hand-written
	// compatible return value, before asserting Pi's pre-fan-out behavior.
	writeFileSync(join(root, "generated-tool-result-gate.mjs"), generateToolResultFilterExtension("pi-gate-scenario"), "utf8");
	return root;
}

describe("patched Pi result gate", () => {
	it("normalizes only complete exact Node 26 DEP0205 child warnings", () => {
		const automaticSyntaxDetection = "(node:123) [DEP0205] DeprecationWarning: Automatic .js syntax detection is deprecated and may change in the future.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n";
		const registerHooks = "(node:456) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n";

		expect(withoutKnownNode26Dep0205(automaticSyntaxDetection)).toBe("");
		expect(withoutKnownNode26Dep0205(registerHooks)).toBe("");
		expect(withoutKnownNode26Dep0205(`${automaticSyntaxDetection}${registerHooks}`)).toBe("");
		expect(withoutKnownNode26Dep0205(`${registerHooks}unexpected child stderr\n`)).toBe("unexpected child stderr\n");
	});

	it("keeps incomplete, altered, and unknown stderr frames", () => {
		const incompleteRegisterHooks = "(node:456) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n";
		const alteredRegisterHooks = "(node:456) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use module.registerHooks() instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n";
		const unknown = "(node:123) [DEP9999] DeprecationWarning: unexpected\n";

		expect(withoutKnownNode26Dep0205(incompleteRegisterHooks)).toBe(incompleteRegisterHooks);
		expect(withoutKnownNode26Dep0205(alteredRegisterHooks)).toBe(alteredRegisterHooks);
		expect(withoutKnownNode26Dep0205(unknown)).toBe(unknown);
	});

	it("executes the shipped patch in a child process and makes its safe result authoritative before all fan-out", async () => {
		const root = createPatchedPiHarness();
		try {
			const result = await runChildScenario(root);
			expect(result.exitCode, `Pi child stderr:\n${result.stderr}\nPi child stdout:\n${result.stdout}`).toBe(0);
			expect(result.signal).toBeNull();
			expect(withoutKnownNode26Dep0205(result.stderr)).toBe("");
			expect(result.stdout).toBe(scenarioSuccess);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
