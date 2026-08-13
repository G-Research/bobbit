import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeAffectedRun, planAffectedRun } from "../../../scripts/affected/runner.mjs";
import {
	createRunChild,
	removeOwnedRunChild,
} from "../../harness/run-isolation.js";

export const UNIT_FILES = ["tests2/core/a.test.ts", "tests2/core/b.test.ts"];

export type ChangeRecord = {
	path: string;
	oldPath?: string;
	status: string;
	before?: string;
	after?: string;
};

export type AffectedFixture = {
	root: string;
	records: ChangeRecord[];
	invocations: string[][];
	configInputs: Set<string>;
};

const ownedRoots: string[] = [];

export function write(root: string, relativePath: string, content: string): void {
	const target = path.join(root, relativePath);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

export function append(root: string, relativePath: string, content: string): void {
	appendFileSync(path.join(root, relativePath), content);
}

export function remove(root: string, relativePath: string): void {
	rmSync(path.join(root, relativePath), { recursive: true, force: true });
}

export function makeFixture(): AffectedFixture {
	const root = createRunChild("affected-runner-direct");
	ownedRoots.push(root);
	const files: Record<string, string> = {
		"package.json": JSON.stringify({
			type: "module",
			scripts: { test: "fixture" },
			dependencies: { alpha: "1.0.0" },
			devDependencies: { vitest: "4.1.10" },
		}),
		"package-lock.json": "fixture-lock\n",
		"tsconfig.json": "{}\n",
		"vitest.config.ts": [
			'import "./scripts/testing-v2/test-map-execution.mjs";',
			'import "./tests2/harness/unit-file-budget-reporter.js";',
			'import "./tests2/harness/run-isolation.js";',
			"export default {};",
			"",
		].join("\n"),
		"tests2/tests-map.json": "{}\n",
		"tests2/core/a.test.ts": "export const a = 1;\n",
		"tests2/core/b.test.ts": "export const b = 1;\n",
		"tests2/harness/run-isolation.ts": 'import "../../scripts/testing-v2/environment-policy.mjs";\n',
		"tests2/harness/unit-file-budget-reporter.ts": "export default class UnitFileBudgetReporter {}\n",
		"scripts/testing-v2/environment-policy.mjs": "export const policy = true;\n",
		"scripts/testing-v2/test-map-execution.mjs": "export const owner = 'unit';\n",
		"scripts/testing-v2/repo-source-closure.mjs": "export const closure = true;\n",
		"scripts/affected/graph.mjs": "export const graph = true;\n",
		"scripts/affected/impact-rules.mjs": "export const rules = [];\n",
		"scripts/affected/classification.mjs": "export const classification = true;\n",
		"scripts/affected/cache.mjs": "export const cache = true;\n",
		"scripts/affected/runner.mjs": "export const runner = true;\n",
		"scripts/affected/run.mjs": "export const cli = true;\n",
		"src/a.ts": "export const a = 1;\n",
		"src/b.ts": "export const b = 1;\n",
		"src/common.ts": "export const common = 1;\n",
		"src/deleted-tool.ts": "export const deletedTool = 1;\n",
		"defaults/roles/coder.yaml": "name: coder\n",
		"market-packs/example/README.md": "# example pack\n",
		"semantic.json": "baseline-semantic-value\n",
	};
	for (const [file, content] of Object.entries(files)) write(root, file, content);
	return {
		root,
		records: [],
		invocations: [],
		configInputs: new Set([
			"tests2/harness/run-isolation.ts",
			"scripts/testing-v2/environment-policy.mjs",
			"tests2/harness/unit-file-budget-reporter.ts",
		]),
	};
}

export function cleanupFixtures(): void {
	while (ownedRoots.length) removeOwnedRunChild(ownedRoots.pop()!);
}

function graphFor(tombstones: Set<string>) {
	const marketReadme = [...tombstones].find(file => file.toLowerCase() === "market-packs/example/readme.md")
		?? "market-packs/example/README.md";
	const testDeps = new Map<string, Set<string>>([
		[UNIT_FILES[0], new Set([UNIT_FILES[0], "src/a.ts", "src/common.ts", "defaults/roles/coder.yaml", marketReadme])],
		[UNIT_FILES[1], new Set([UNIT_FILES[1], "src/b.ts", "src/common.ts"])],
	]);
	return { testFiles: [...UNIT_FILES], testDeps, meta: { tombstones } };
}

function selectTests(fixture: AffectedFixture, graph: ReturnType<typeof graphFor>, changes: ChangeRecord[]) {
	const paths = changes.flatMap(change => [change.path, change.oldPath].filter((value): value is string => Boolean(value)));
	const removedExecutable = changes.find(change => change.status === "D" && /\.(?:[cm]?[jt]sx?)$/iu.test(change.path));
	if (removedExecutable && graph.meta.tombstones.has(removedExecutable.path)) {
		return selection("run-all", UNIT_FILES, [`unresolved deleted dependency: ${removedExecutable.path}`], [removedExecutable.path]);
	}
	const packageChange = changes.find(change => [change.path, change.oldPath]
		.filter(Boolean).some(file => file!.toLowerCase() === "package.json"));
	if (packageChange) {
		const packagePath = packageChange.path.toLowerCase() === "package.json";
		const oldPackagePath = packageChange.oldPath === undefined
			? packagePath
			: packageChange.oldPath.toLowerCase() === "package.json";
		if (packagePath !== oldPackagePath) {
			return selection("run-all", UNIT_FILES, [
				`root package topology change: ${packageChange.oldPath} -> ${packageChange.path}`,
			]);
		}
	}
	const broad = paths.find(file => file === "unknown.bin"
		|| file === "vitest.config.ts"
		|| file === "package-lock.json"
		|| /^tsconfig(?:\..+)?\.json$/u.test(file)
		|| file.startsWith("scripts/affected/")
		|| fixture.configInputs.has(file));
	if (broad) return selection("run-all", UNIT_FILES, [`broad change: ${broad}`]);
	const affected = new Set<string>();
	const lowerPaths = paths.map(file => file.toLowerCase());
	if (lowerPaths.includes("market-packs/example/readme.md")) affected.add(UNIT_FILES[0]);
	if (paths.some(file => ["src/a.ts", "defaults/roles/coder.yaml", "semantic.json"].includes(file))) affected.add(UNIT_FILES[0]);
	if (paths.includes("src/b.ts")) affected.add(UNIT_FILES[1]);
	if (paths.includes("src/common.ts")) UNIT_FILES.forEach(file => affected.add(file));
	UNIT_FILES.filter(file => paths.includes(file)).forEach(file => affected.add(file));
	const semantic = changes.find(change => change.path === "semantic.json" || change.oldPath === "semantic.json");
	const reasons = semantic
		? [`semantic:${semantic.before?.trim() ?? "undefined"}->${semantic.after?.trim() ?? "undefined"}`]
		: [paths.every(file => file.startsWith("docs/")) ? "docs only" : "static dependency closure"];
	return affected.size === 0
		? selection("skip-all", [], reasons)
		: selection("bounded", [...affected], reasons);
}

function selection(kind: "skip-all" | "bounded" | "run-all", affected: string[], reasons: string[], unmapped: string[] = []) {
	return {
		kind,
		cachePolicy: kind === "run-all" ? "bypass" : "eligible",
		affected: new Set(affected),
		browserAffected: new Set(),
		reasons,
		unmapped,
	};
}

export type RunOptions = {
	all?: boolean;
	noCache?: boolean;
	dry?: boolean;
	platform?: NodeJS.Platform;
	fail?: string[];
	missingReport?: boolean;
	malformedReport?: boolean;
	mutatePath?: string;
	records?: ChangeRecord[];
};

export function run(fixture: AffectedFixture, options: RunOptions = {}) {
	if (options.records) fixture.records = options.records;
	const deps = {
		collectChanges: () => ({ records: fixture.records }),
		buildGraph: ({ tombstones }: { tombstones: Set<string> }) => graphFor(tombstones),
		affectedTests: (graph: ReturnType<typeof graphFor>, records: ChangeRecord[]) => selectTests(fixture, graph, records),
	};
	const plan = planAffectedRun({
		repoRoot: fixture.root,
		all: options.all,
		noCache: options.noCache,
	}, deps);
	const failures = new Set(options.fail ?? []);
	const result = executeAffectedRun(plan, {
		repoRoot: fixture.root,
		dry: options.dry,
		platform: options.platform,
	}, {
		executeTests: ({ files }: { files: string[] }) => {
			fixture.invocations.push([...files]);
			if (options.mutatePath) append(fixture.root, options.mutatePath, "\n// mutated during execution\n");
			if (options.missingReport) return { status: failures.size > 0 ? 1 : 0 };
			if (options.malformedReport) return { status: failures.size > 0 ? 1 : 0, report: "not json" };
			return {
				status: files.some(file => failures.has(file)) ? 1 : 0,
				report: {
					testResults: files.map(file => ({
						name: path.join(fixture.root, file),
						status: failures.has(file) ? "failed" : "passed",
					})),
				},
			};
		},
	});
	return { plan, result, status: result.outcome === "fail" ? 1 : 0 };
}

export function cachedTests(fixture: AffectedFixture): string[] {
	try {
		const cache = JSON.parse(readFileSync(path.join(fixture.root, ".profiles", "test-cache", "results.json"), "utf8"));
		return Object.values(cache).flatMap(bucket => Object.keys(bucket as Record<string, unknown>));
	} catch {
		return [];
	}
}
