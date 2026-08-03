// Declarative ownership for shipped inputs that are consumed through filesystem
// discovery rather than JavaScript/TypeScript imports. Graph construction turns
// each rule into ordinary dependency edges (owner/canary -> input), so selection
// and per-test cache hashing share exactly the same dependency model.

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const posix = (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, "");
const frozen = (values) => Object.freeze(values);

/**
 * Stable, data-first shipped-input rules. Every owner is the production module
 * that discovers/loads the input; canaries directly validate the shipped bytes,
 * loader contract, prompt budget, or cascade behavior.
 */
export const IMPACT_RULES = Object.freeze([
	{
		id: "builtin-roles",
		matches: (path) => /^defaults\/roles\/.*\.ya?ml$/i.test(path),
		owners: frozen([
			"src/server/agent/assistant-registry.ts",
			"src/server/agent/builtin-config.ts",
			"src/server/agent/pack-resolver.ts",
			"src/server/agent/config-cascade.ts",
		]),
		canaries: frozen([
			"tests2/core/default-role-policy.test.ts",
			"tests2/core/role-prompt.test.ts",
			"tests2/core/role-bobbit-tools-policy.test.ts",
			"tests2/core/local-only-role-prompts.test.ts",
		]),
	},
	{
		id: "builtin-tools",
		matches: (path) => path === "defaults/tool-group-policies.yaml" || path.startsWith("defaults/tools/"),
		owners: frozen([
			"src/server/agent/builtin-config.ts",
			"src/server/agent/pack-resolver.ts",
			"src/server/agent/tool-manager.ts",
			"src/server/agent/config-cascade.ts",
		]),
		canaries: frozen([
			"tests2/core/market-tool-runtime.test.ts",
			"tests2/core/marketplace-activation-tool-catalogue.test.ts",
			"tests2/core/tool-description-budget.test.ts",
			"tests2/core/tool-docs-prompt.test.ts",
			"tests2/core/tool-policy-resolution.test.ts",
		]),
	},
	{
		id: "shipped-skills",
		matches: (path) => path.startsWith("defaults/skills/") || path.startsWith(".claude/skills/"),
		owners: frozen([
			"src/server/skills/slash-skills.ts",
			"src/server/agent/pack-resolver.ts",
			"src/server/agent/pack-list.ts",
		]),
		canaries: frozen([
			"tests2/core/pack-marketplace.test.ts",
			"tests2/core/skill-manifest.test.ts",
			"tests2/core/slash-skills-activation.test.ts",
			"tests2/core/system-prompt-skills-budget.test.ts",
			"tests2/core/validate-skill-discovery.test.ts",
		]),
	},
	{
		id: "prompt-and-authoring-inputs",
		matches: (path) => path === "AGENTS.md"
			|| path === "defaults/system-prompt.md"
			|| path === "defaults/workflow-authoring-guide.md"
			|| path.startsWith("defaults/docs/"),
		owners: frozen([
			"src/server/agent/system-prompt.ts",
			"src/server/agent/project-assistant.ts",
		]),
		canaries: frozen([
			"tests2/core/agents-md-budget.test.ts",
			"tests2/core/comparative-design-prompts.test.ts",
			"tests2/core/project-assistant-prompt.test.ts",
			"tests2/core/system-prompt-merged-branch.test.ts",
			"tests2/core/system-prompt-skills-budget.test.ts",
			"tests2/core/system-prompt.test.ts",
		]),
	},
	{
		id: "market-packs",
		matches: (path) => path.startsWith("market-packs/"),
		owners: frozen([
			"src/server/agent/builtin-packs.ts",
			"src/server/agent/pack-list.ts",
			"src/server/agent/pack-manifest.ts",
			"src/server/agent/pack-resolver.ts",
			"src/server/agent/pack-contributions.ts",
		]),
		canaries: frozen([
			"tests2/core/builtin-packs.test.ts",
			"tests2/core/pack-contributions.test.ts",
			"tests2/core/pack-marketplace.test.ts",
			"tests2/core/pack-pi-extensions-loader.test.ts",
			"tests2/core/pack-providers-loader.test.ts",
			"tests2/core/reviewer-diff-scope-prompts.test.ts",
			"tests2/core/tool-description-budget.test.ts",
		]),
	},
	{
		id: "workflow-templates",
		matches: (path) => /^workflows\/.*\.ya?ml$/i.test(path),
		owners: frozen([
			"src/server/agent/workflow-store.ts",
			"src/server/agent/workflow-validator.ts",
			"src/server/state-migration/seed-default-workflows.ts",
		]),
		canaries: frozen([
			"tests2/core/seed-default-workflows.test.ts",
			"tests2/core/workflow-store.test.ts",
			"tests2/core/workflow-validator.test.ts",
		]),
	},
	{
		id: "committed-config-cascade",
		matches: (path) => path.startsWith(".bobbit/config/"),
		owners: frozen([
			"src/server/agent/project-config-store.ts",
			"src/server/agent/config-cascade.ts",
			"src/server/agent/workflow-store.ts",
		]),
		canaries: frozen([
			"tests2/core/comparative-design-prompts.test.ts",
			"tests2/core/config-cascade.test.ts",
			"tests2/core/project-config-store-native-yaml.test.ts",
			"tests2/core/seed-default-workflows.test.ts",
		]),
	},
	{
		// Scripts and publication metadata do not alter the dependency/runtime
		// projection, but these tests read the manifest bytes directly.
		id: "package-metadata",
		matches: (path) => path === "package.json",
		owners: frozen([]),
		canaries: frozen([
			"tests2/core/aigw-headers.test.ts",
			"tests2/core/aigw-startup-refresh.test.ts",
			"tests2/core/aigw-user-agent.test.ts",
			"tests2/core/node-modules-ring-fence.test.ts",
			"tests2/core/package-files.test.ts",
			"tests2/core/pi-published-shrinkwrap-security.test.ts",
			"tests2/core/release-skill-preflight-order.test.ts",
			"tests2/core/support-packaging.test.ts",
			"tests2/core/unit-file-budget-reporter.test.ts",
			"tests2/core/unit-lanes-scheduling.test.ts",
			"tests2/integration/aigw-configure.test.ts",
			"tests2/integration/aigw-title-generator.test.ts",
			"tests2/integration/app-info-api.test.ts",
		]),
	},
]);

/** Families are independent from the rule matchers so inventory coverage can
 * detect a new qualifying file that no rule claims. */
export const SHIPPED_INPUT_FAMILIES = Object.freeze([
	{ id: "builtin-roles", qualifies: (path) => /^defaults\/roles\/.*\.ya?ml$/i.test(path) },
	{ id: "builtin-tools", qualifies: (path) => path === "defaults/tool-group-policies.yaml" || path.startsWith("defaults/tools/") },
	{ id: "shipped-skills", qualifies: (path) => path.startsWith("defaults/skills/") || path.startsWith(".claude/skills/") },
	{ id: "prompt-and-authoring-inputs", qualifies: (path) => path === "AGENTS.md" || path === "defaults/system-prompt.md" || path === "defaults/workflow-authoring-guide.md" || path.startsWith("defaults/docs/") },
	{ id: "market-packs", qualifies: (path) => path.startsWith("market-packs/") },
	{ id: "workflow-templates", qualifies: (path) => /^workflows\/.*\.ya?ml$/i.test(path) },
	{ id: "committed-config-cascade", qualifies: (path) => path.startsWith(".bobbit/config/") },
]);

const REPOSITORY_EXECUTABLE_RE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/i;

/**
 * Computed repository scans cannot be recovered from a single readFile call.
 * Keep those broad-but-bounded ownership edges data-first and independently
 * enumerable so a newly added file under a declared root cannot be missed.
 */
export const REPOSITORY_SCAN_RULES = Object.freeze([
	{
		id: "client-source-guards",
		roots: frozen(["src/app", "src/ui"]),
		matches: (path) => (path.startsWith("src/app/") || path.startsWith("src/ui/"))
			&& REPOSITORY_EXECUTABLE_RE.test(path),
		consumers: frozen(["tests2/core/base-path-source-guards.test.ts"]),
	},
]);

export function impactRulesForPath(pathValue) {
	const path = posix(pathValue);
	return IMPACT_RULES.filter((rule) => rule.matches(path));
}

export function repositoryScanRulesForPath(pathValue) {
	const path = posix(pathValue);
	return REPOSITORY_SCAN_RULES.filter((rule) => rule.matches(path));
}

function walkFiles(repoRoot, relativeRoot, out) {
	const absoluteRoot = join(repoRoot, ...relativeRoot.split("/"));
	if (!existsSync(absoluteRoot)) return;
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else out.push(posix(relative(repoRoot, absolute)));
		}
	};
	visit(absoluteRoot);
}

/** Enumerate the shipped dynamic-input inventory from the filesystem. */
export function inventoryShippedInputs(repoRoot) {
	const candidates = [];
	for (const root of ["defaults", "market-packs", "workflows", ".claude/skills", ".bobbit/config"]) {
		walkFiles(repoRoot, root, candidates);
	}
	if (existsSync(join(repoRoot, "AGENTS.md"))) candidates.push("AGENTS.md");
	// Deliberately return every file under shipped roots, not only files already
	// matched by a family. That independence makes a newly added family fail the
	// inventory validation instead of silently becoming an affected-test blind spot.
	return [...new Set(candidates)].sort();
}

/** Enumerate every executable input covered by a declared computed scan. */
export function inventoryRepositoryScanInputs(repoRoot) {
	const candidates = [];
	for (const rule of REPOSITORY_SCAN_RULES) {
		for (const root of rule.roots) walkFiles(repoRoot, root, candidates);
	}
	return [...new Set(candidates)]
		.filter((path) => repositoryScanRulesForPath(path).length > 0)
		.sort();
}

/** Validate declared scans independently from static read extraction. */
export function validateRepositoryScanInventory(repoRoot, unitTests) {
	const testSet = unitTests instanceof Set ? unitTests : new Set(unitTests);
	const inputs = inventoryRepositoryScanInputs(repoRoot);
	const issues = [];
	for (const rule of REPOSITORY_SCAN_RULES) {
		const owned = inputs.filter((path) => rule.matches(path));
		if (owned.length === 0) issues.push(`${rule.id}: computed repository scan is empty`);
		for (const root of rule.roots) {
			const rootPrefix = `${posix(root).replace(/\/$/, "")}/`;
			if (!owned.some((path) => path.startsWith(rootPrefix))) {
				issues.push(`${rule.id}: computed repository scan root is empty: ${root}`);
			}
		}
		for (const consumer of rule.consumers) {
			if (!testSet.has(consumer)) issues.push(`${rule.id}: unit consumer is missing or not unit-owned: ${consumer}`);
		}
	}
	return { inputs, issues };
}

/**
 * Return actionable inventory defects. Callers decide whether to throw; keeping
 * this pure makes the rule registry independently testable.
 */
export function validateImpactInventory(repoRoot, unitTests) {
	const testSet = unitTests instanceof Set ? unitTests : new Set(unitTests);
	const inputs = inventoryShippedInputs(repoRoot);
	const issues = [];
	for (const input of inputs) {
		const family = SHIPPED_INPUT_FAMILIES.find((candidate) => candidate.qualifies(input));
		const rules = impactRulesForPath(input);
		if (!family) {
			issues.push(`${input}: shipped input has no declared impact family`);
		} else if (!rules.some((rule) => rule.id === family.id)) {
			issues.push(`${input}: shipped input has no ${family.id} impact rule`);
		}
	}
	for (const family of SHIPPED_INPUT_FAMILIES) {
		const familyInputs = inputs.filter((path) => family.qualifies(path));
		if (familyInputs.length === 0) issues.push(`${family.id}: shipped input family is empty`);
		const rule = IMPACT_RULES.find((candidate) => candidate.id === family.id);
		if (!rule) {
			issues.push(`${family.id}: impact rule is missing`);
			continue;
		}
		const consumers = rule.canaries.filter((path) => testSet.has(path));
		if (consumers.length === 0) issues.push(`${family.id}: no authoritative unit canary exists`);
		for (const owner of rule.owners) {
			if (!existsSync(join(repoRoot, ...owner.split("/")))) issues.push(`${family.id}: production owner is missing: ${owner}`);
		}
		for (const canary of rule.canaries) {
			if (!testSet.has(canary)) issues.push(`${family.id}: unit canary is missing or not unit-owned: ${canary}`);
		}
	}
	return { inputs, issues };
}
