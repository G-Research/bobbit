import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageName = "@earendil-works/pi-coding-agent";
const packagePatches = [
	fileURLToPath(new URL("../../patches/@earendil-works+pi-agent-core+0.82.1.patch", import.meta.url)),
	fileURLToPath(new URL("../../patches/@earendil-works+pi-coding-agent+0.82.1.patch", import.meta.url)),
];
const scenarioFile = fileURLToPath(new URL("./tool-result-filter-pi-gate-scenario.mjs", import.meta.url));
const harnessRoots: string[] = [];

type Hunk = { oldStart: number; newStart: number; lines: string[] };
type PatchFile = { path: string; hunks: Hunk[] };

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

function applyShippedPatch(root: string, patchFile: string): void {
	// postinstall may already have patched the copied source. Normalize it to
	// the published base and then apply the same shipped patch in either case.
	try {
		applyPatch(root, patchFile, true);
	} catch {
		// An unpatched copy cannot match a reverse hunk; forward application below
		// is the authoritative validation of its exact published source.
	}
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
	expect(version).toBe("0.82.1");

	const root = mkdtempSync(join(tmpdir(), "bobbit-pi-result-gate-"));
	harnessRoots.push(root);
	const targetPackage = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	const sourceAgentCore = join(sourceNodeModules, "@earendil-works", "pi-agent-core");
	const targetAgentCore = join(root, "node_modules", "@earendil-works", "pi-agent-core");
	cpSync(sourcePackage, targetPackage, { recursive: true });
	cpSync(sourceAgentCore, targetAgentCore, { recursive: true });
	// The copied Pi packages are the only code we modify. Agent-core's
	// dependencies remain read-only references to the runner's tree; the coding
	// package keeps its private dependency layout because it owns pi-tui.
	rmSync(join(targetAgentCore, "node_modules"), { recursive: true, force: true });
	symlinkSync(sourceNodeModules, join(targetAgentCore, "node_modules"), "dir");
	symlinkSync(join(sourceNodeModules, "@earendil-works", "pi-ai"), join(root, "node_modules", "@earendil-works", "pi-ai"), "dir");
	for (const patch of packagePatches) applyShippedPatch(root, patch);
	return root;
}

afterEach(() => {
	for (const root of harnessRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("patched Pi result gate", () => {
	it("executes the shipped patch in an isolated package and makes its safe result authoritative before all fan-out", async () => {
		const root = createPatchedPiHarness();
		const [{ Agent }, { createAssistantMessageEventStream }, { AgentSession }, { runPatchedPiGateScenario }] = await Promise.all([
			import(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js")).href),
			import(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href),
			import(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href),
			import(pathToFileURL(scenarioFile).href),
		]);
		await runPatchedPiGateScenario({ Agent, createAssistantMessageEventStream, AgentSession });
	});
});
