import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const DEFAULT_TEST_MAP_PATH = join(REPO_ROOT, "tests2", "tests-map.json");

export const APPROVED_E2E_VITEST_PATHS = Object.freeze([
	"tests2/core/file-mentions-authenticated-boundary.test.ts",
	"tests2/core/git-lifecycle-no-publication-real-git.test.ts",
	"tests2/core/marketplace-install.test.ts",
	"tests2/core/orphan-tool-result-rehydration-boundaries.test.ts",
	"tests2/core/team-manager.test.ts",
]);

export const ISOLATED_VITEST_FILES = Object.freeze({
	"tests2/core/bobbit-dir-agent-dir.test.ts": "Reads BOBBIT_DIR and the agent directory through module-level singleton state.",
	"tests2/core/container-path-translation.test.ts": "Reads HOME and container path state during module initialization.",
	"tests2/core/extension-host-action-dispatcher.test.ts": "Extension-host worker registration mutates NODE_OPTIONS and module-global dispatcher state.",
	"tests2/core/extension-host-channel-registry.test.ts": "Extension-host worker registration mutates NODE_OPTIONS and module-global channel state.",
	"tests2/core/extension-host-isolation-config-invariant.test.ts": "Extension-host isolation configuration is evaluated from process state at module load.",
	"tests2/core/extension-host-module-isolation.test.ts": "Spawns extension-host worker threads with module-scoped loader state.",
	"tests2/core/extension-host-route-dispatcher.test.ts": "Extension-host worker registration mutates NODE_OPTIONS and module-global route state.",
	"tests2/core/extension-host-session-event-bus.test.ts": "Exercises a module-global EventTarget that must not retain sibling listeners.",
	"tests2/core/goal-metadata-edges.test.ts": "Reads BOBBIT_DIR-backed goal metadata state during module initialization.",
	"tests2/core/lifecycle-hub.test.ts": "Exercises module-global lifecycle listeners that must not leak across files.",
});

const UNIT_PROJECTS = new Set(["core", "dom", "integration", "isolated"]);
const ALL_VITEST_PROJECTS = new Set([...UNIT_PROJECTS, "e2e"]);

export function toPosixPath(value) {
	return String(value).replace(/\\/g, "/");
}

export function executionForMaterializedPath(pathValue) {
	const path = toPosixPath(pathValue);
	if (APPROVED_E2E_VITEST_PATHS.includes(path)) {
		return { runner: "vitest", tier: "e2e", project: "e2e" };
	}
	const isolatedReason = ISOLATED_VITEST_FILES[path];
	if (isolatedReason) {
		return { runner: "vitest", tier: "unit", project: "isolated", reason: isolatedReason };
	}
	if (/^tests2\/core\/.*\.test\.ts$/.test(path)) {
		return { runner: "vitest", tier: "unit", project: "core" };
	}
	if (/^tests2\/dom\/.*\.test\.ts$/.test(path)) {
		return { runner: "vitest", tier: "unit", project: "dom" };
	}
	if (/^tests2\/integration\/.*\.test\.ts$/.test(path)) {
		return { runner: "vitest", tier: "unit", project: "integration" };
	}
	if (/^tests2\/browser\/.*\.spec\.ts$/.test(path)) {
		return { runner: "playwright", tier: "browser", project: "browser" };
	}
	throw new Error(`No execution classification for materialized test path: ${path}`);
}

function collectVitestFiles(repoRoot) {
	const files = [];
	for (const area of ["core", "dom", "integration"]) {
		const root = join(repoRoot, "tests2", area);
		const visit = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const file = join(dir, entry.name);
				if (entry.isDirectory()) visit(file);
				else if (entry.name.endsWith(".test.ts")) files.push(toPosixPath(relative(repoRoot, file)));
			}
		};
		visit(root);
	}
	return files.sort();
}

function materializedRecords(map) {
	return [
		...(map.entries ?? []).filter((entry) => entry.v2Path).map((entry) => ({
			path: entry.v2Path,
			execution: entry.execution,
			record: entry.file,
		})),
		...(map.v2Native ?? []).map((entry) => ({
			path: entry.path,
			execution: entry.execution,
			record: entry.path,
		})),
	];
}

export function loadVitestExecutionMap({
	mapPath = DEFAULT_TEST_MAP_PATH,
	repoRoot = REPO_ROOT,
} = {}) {
	const map = JSON.parse(readFileSync(mapPath, "utf8"));
	const projects = { core: [], dom: [], integration: [], isolated: [], e2e: [] };
	const materializedOwnership = new Map();
	const vitestOwnership = new Map();
	const errors = [];

	for (const item of materializedRecords(map)) {
		const path = toPosixPath(item.path);
		const materializedOwners = materializedOwnership.get(path) ?? [];
		materializedOwners.push(item.record);
		materializedOwnership.set(path, materializedOwners);
		const absolute = resolve(repoRoot, path);
		if (!existsSync(absolute)) errors.push(`${item.record}: materialized test path does not exist: ${path}`);
		if (!item.execution || typeof item.execution !== "object") {
			errors.push(`${item.record}: missing execution metadata for ${path}`);
			continue;
		}
		let expected;
		try {
			expected = executionForMaterializedPath(path);
		} catch (error) {
			errors.push(`${item.record}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const expectedHasReason = Object.hasOwn(expected, "reason");
		const actualHasReason = Object.hasOwn(item.execution, "reason");
		const executionMatches = item.execution.runner === expected.runner
			&& item.execution.tier === expected.tier
			&& item.execution.project === expected.project
			&& actualHasReason === expectedHasReason
			&& (!expectedHasReason || item.execution.reason === expected.reason);
		if (!executionMatches) {
			errors.push(`${item.record}: execution metadata for ${path} must match ${JSON.stringify(expected)}, got ${JSON.stringify(item.execution)}`);
			continue;
		}
		if (expected.runner !== "vitest") continue;
		const { project } = expected;
		if (!ALL_VITEST_PROJECTS.has(project)) {
			errors.push(`${item.record}: unknown Vitest execution project ${JSON.stringify(project)}`);
			continue;
		}
		vitestOwnership.set(path, item.record);
		projects[project].push(path);
	}

	for (const [path, owners] of materializedOwnership) {
		if (owners.length > 1) errors.push(`${path}: duplicate materialized execution ownership (${owners.join(", ")})`);
	}
	if (projects.isolated.length > 10) errors.push(`isolated execution has ${projects.isolated.length} files; maximum is 10`);

	const physicalVitest = collectVitestFiles(repoRoot);
	for (const path of physicalVitest) {
		if (!vitestOwnership.has(path)) errors.push(`${path}: unit/e2e Vitest file has no execution owner`);
	}
	for (const path of vitestOwnership.keys()) {
		if (!physicalVitest.includes(path)) errors.push(`${path}: execution owner is not a core/dom/integration .test.ts file`);
	}

	const actualE2e = [...projects.e2e].sort();
	const approvedE2e = [...APPROVED_E2E_VITEST_PATHS].sort();
	if (JSON.stringify(actualE2e) !== JSON.stringify(approvedE2e)) {
		errors.push(`Vitest E2E owners must be exactly [${approvedE2e.join(", ")}], got [${actualE2e.join(", ")}]`);
	}

	for (const paths of Object.values(projects)) paths.sort();
	if (errors.length) throw new Error(`Invalid tests2 execution map:\n- ${errors.join("\n- ")}`);
	return Object.freeze({
		...projects,
		unit: Object.freeze([...projects.core, ...projects.dom, ...projects.integration, ...projects.isolated].sort()),
		all: Object.freeze([...physicalVitest]),
	});
}
