#!/usr/bin/env node
/**
 * gen-inventory.mjs — generate/refresh tests2/tests-map.json for the Test
 * Suite v2 migration.
 *
 * Classifies EVERY legacy `tests/` test file (see lib-census.mjs for the exact
 * census) into one of five v2 buckets with a migration method, applying the
 * rules from the goal spec mechanically and then a small, explicit, curated
 * set of real-fidelity overrides (documented in docs/testing-v2/inventory.md).
 *
 * Output entry shape:
 *   { file, bucket, method, replacement: string[], rationale }
 *
 * Running this must always yield a map that passes check-inventory.mjs.
 * Re-run after adding/removing/renaming a legacy test file, or after editing
 * the override lists below.  The generator is deterministic: same tree in,
 * same JSON out (stable sort by file).
 *
 * Buckets:  v2-core | v2-dom | v2-integration | v2-browser | daily
 * Methods:  codemod | adapter | rewrite | retire-with-mapping | relocate
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	census,
	readRepoFile,
	REPO_ROOT,
	GEOMETRY_REGEX,
} from "./lib-census.mjs";

// ---------------------------------------------------------------------------
// Smoke-journey catalogue. Every retired e2e/ui browser spec is consolidated
// into one of these multi-feature journeys. Keep IDs stable — check-inventory
// and later migration gates reference them.
// ---------------------------------------------------------------------------
export const JOURNEYS = {
	"journey-session-lifecycle": "Session create / actions / status / fork / navigate",
	"journey-crash-restart": "Gateway crash, restart, reconnect, resilience, persistence-across-reload",
	"journey-goal-team-gates-verification": "Goal creation → team → gates → verification dashboard",
	"journey-goal-editing": "Goal edit modal / form / tabs / metadata / role wiring",
	"journey-subgoals": "Subgoal creation, nesting limits, parent picker, experimental toggle",
	"journey-project-onboarding": "Add-project flows, project management, splash, remove-project",
	"journey-project-settings": "Settings cascade, system-prompt, agent-dir, model fallback, maintenance",
	"journey-project-assistant": "Project/role assistant, saved state, reattempt/binding recovery",
	"journey-proposals": "Goal/project proposal panel flows, revisions, dismiss/reload",
	"journey-sidebar-nav-search-keyboard": "Sidebar navigation, filters, search, keyboard nav, resize",
	"journey-marketplace-packs": "Marketplace, pack install/activation, skills, extension host",
	"journey-pr-walkthrough": "PR-walkthrough panel and pack",
	"journey-prompt-interaction": "Prompt send, at-mention, queue, steer/abort, tool/skill policy",
	"journey-preview-artifacts": "Preview panel, artifacts, image attach/model selection",
	"journey-mobile-layout": "Mobile layout smoke, mobile tabs, PWA lifecycle",
	"journey-notification-policy": "Notification policy, unseen activity, auto-retry, error modal",
	"journey-bg-wait-steer": "Background-process wait/steer flows and persistence",
	"journey-compaction": "Compaction, pre-compaction history, persistence",
	"journey-cost-tracking": "Cost popover/cache, tree cost rollup, prompt stats",
	"journey-staff": "Staff sidebar, roles, triggers, inbox, accessories, indicators",
	"journey-workflow-editor": "Workflow editor/page, optional steps, gate status/bypass",
	"journey-stories-registry": "Story-registry driven UI stories smoke",
	"journey-dashboard-fanout": "Goal dashboard fanout, mutation-pending, status widgets, progress",
	"journey-review-commenting": "Review pane, inline comments, mobile review commenting",
	"journey-multi-repo": "Multi-repo flow and per-repo git status",
	"journey-session-sharing": "Copy/open session link, new window/tab, page title, palette",
	"journey-debug-tools": "Debug-mode toggle, instant loader, tool renderers, text replace",
	"journey-dynamic-panels": "Side/dynamic panel tabs, tab wiring",
	"journey-headquarters": "Headquarters view and staff inbox",
	"journey-team-delegate": "Team delegate, child cascade/loading, archived children",
	"journey-app-smoke": "General application smoke (catch-all for cross-cutting UI specs)",
};

/**
 * Ordered keyword → journey rules. First matching rule wins, guaranteeing every
 * retired spec gets exactly one (non-empty) journey. More specific rules come
 * first. Matched against the e2e/ui spec basename (without extension).
 */
const JOURNEY_RULES = [
	[/^pr-walkthrough/, "journey-pr-walkthrough"],
	[/^(marketplace|market-activation|skills?-|skill-|terminal-pack|artifacts-pack|extension-host)/, "journey-marketplace-packs"],
	[/^stories-/, "journey-stories-registry"],
	[/^staff/, "journey-staff"],
	[/^bg-(wait|process)/, "journey-bg-wait-steer"],
	[/(^|-)compact/, "journey-compaction"],
	[/^(cost|tree-cost|prompt-stats)/, "journey-cost-tracking"],
	[/^(workflow|optional-steps|gate-)/, "journey-workflow-editor"],
	[/(review-pane|review-commenting|inline-comments)/, "journey-review-commenting"],
	[/^(add-project|project-management|project-drag|remove-first-project|splash|single-project-sidebar|per-project-native)/, "journey-project-onboarding"],
	[/^(settings|system-prompt|per-project-native-yaml)/, "journey-project-settings"],
	[/(project-assistant|role-assistant|goal-accept-failure|goal-reattempt)/, "journey-project-assistant"],
	[/^(proposal|goal-proposal|failed-goal-proposal|mid-session-project-proposal)/, "journey-proposals"],
	[/^subgoal/, "journey-subgoals"],
	[/^sidebar|(^search)|search-result|jump-to-last-prompt|single-project/, "journey-sidebar-nav-search-keyboard"],
	[/^(mobile|pwa-lifecycle)/, "journey-mobile-layout"],
	[/(notification-policy|unseen-activity|auto-retry-banner|api-error-modal)/, "journey-notification-policy"],
	[/(preview|image-attach|image-model|artifacts)/, "journey-preview-artifacts"],
	[/(at-mention|queue-ui|steer-during|escape-aborts|ask-user-choices|^tool-|^skill|prompt-stats-e2e|session-prompt|session-interactions)/, "journey-prompt-interaction"],
	[/^(multi-repo|session-git-status-multi-repo|git-status-untracked-race)/, "journey-multi-repo"],
	[/(copy-session-link|open-session-new-window|new-tab-no-duplicate|page-title|palette-session)/, "journey-session-sharing"],
	[/(debug-mode-toggle|instant-loader|replace-bobbit-text|children-tool-renderers)/, "journey-debug-tools"],
	[/(side-panel-tabs|dynamic-chat-tabs|goal-tabs-wiring|goal-role-tabs)/, "journey-dynamic-panels"],
	[/^headquarters/, "journey-headquarters"],
	[/(team-delegate|archive-child-cascade|plan-archived-children|plan-tab-archived|sidebar-child-loading)/, "journey-team-delegate"],
	[/(dashboard|mutation-pending|goal-status-widget|verification-progress)/, "journey-dashboard-fanout"],
	[/(restart|reconnect|resilience|recovery|status-recovery|preparing-ux|pre-compaction|persistence|dormant-revive|session-created-push-sync|session-status)/, "journey-crash-restart"],
	[/^(goal-creation|goal-empty-workflows|goal-metadata|goal-archive|goal-form|goal-edit|goal-tabs|goal-role|goal-dashboard)/, "journey-goal-editing"],
	[/(goal|gate|verification|team)/, "journey-goal-team-gates-verification"],
	[/(session|fork-session)/, "journey-session-lifecycle"],
];

function journeyFor(basename) {
	for (const [re, id] of JOURNEY_RULES) {
		if (re.test(basename)) return id;
	}
	return "journey-app-smoke";
}

// ---------------------------------------------------------------------------
// Curated real-fidelity overrides -> tier-3 daily lane.
//
// These genuinely require real subprocess/container/OS fidelity that CANNOT be
// faked in tier-1/tier-2 (verified by reading each file — see inventory.md
// "manual overrides"). Everything NOT listed here is classified purely by the
// mechanical rules below; in particular, files whose NAMES mention sandbox/
// docker/worktree/spawn but which use mocks, injected git probes, canned
// command output, or pure functions stay in the fast tiers.
// ---------------------------------------------------------------------------
export const DAILY_OVERRIDES = new Map([
	// --- real git worktree pool / lifecycle (unit) ---
	["tests/worktree-pool.test.ts", "Real git init + WorktreePool worktree add/remove lifecycle."],
	["tests/worktree-pool-base-ref.test.ts", "Real git init/worktree against a real bare repo."],
	["tests/worktree-pool-multi.test.ts", "Real multi-repo git init + worktree pool lifecycle."],
	["tests/worktree-pool-nested-rootpath.test.ts", "Real git worktree pool with nested rootPath."],
	["tests/worktree-sweeper.test.ts", "Real git worktree add/remove then sweep of orphans."],
	["tests/worktree-idempotent.test.ts", "Real git worktree create idempotency against a real repo."],
	["tests/worktree-set-polyrepo.test.ts", "Real git worktree set across a real poly-repo layout."],
	["tests/unborn-head-worktree.test.ts", "Real git repo with unborn HEAD worktree behavior."],
	["tests/system-project-pool-leak.test.ts", "Real git init + multiple WorktreePools; pool-leak fidelity."],
	// --- real spawned OS process trees ---
	["tests/spawn-tree-shutdown-survival.test.ts", "Spawns real OS child-process trees; kill/survival fidelity."],
	// --- real docker/sandbox mount fidelity (unit) ---
	["tests/sandbox-mount-root.test.ts", "Real git init to compute real sandbox mount roots."],

	// --- real git worktree pool / continue-archived cluster (e2e) ---
	["tests/e2e/continue-archived-worktree.spec.ts", "Real worktree-pool continue-archived lifecycle."],
	["tests/e2e/continue-archived-worktree-invalid-base.spec.ts", "Real worktree continue-archived with invalid base ref."],
	["tests/e2e/continue-archived-worktree-pool.spec.ts", "Real worktree-pool reuse on continue-archived."],
	["tests/e2e/continue-archived-worktree-stale-source.spec.ts", "Real worktree continue-archived with stale source."],
	["tests/e2e/continue-archived-multi-repo.spec.ts", "Real multi-repo git continue-archived."],
	["tests/e2e/per-project-worktree-pool.spec.ts", "Real per-project worktree pool provisioning."],
	["tests/e2e/pool-flow.spec.ts", "Real worktree pool (enableWorktreePool) + real git."],
	["tests/e2e/pool-claim-restart-resume.spec.ts", "Real worktree pool claim survives real restart."],
	["tests/e2e/multi-repo-pool.spec.ts", "Real multi-repo worktree pool."],
	["tests/e2e/unborn-worktree-session.spec.ts", "Real git unborn-HEAD worktree session."],
	["tests/e2e/worktree-root-override.spec.ts", "Real worktree-root override on disk."],
	["tests/e2e/goal-archive-branch-cleanup.spec.ts", "Real bare-repo branch cleanup (realpush) fidelity."],
	["tests/e2e/port-auto-increment.spec.ts", "Real port-binding race / auto-increment."],
	["tests/e2e/remove-boot-respawn-restart.spec.ts", "Real boot-respawn across a real gateway restart."],
	// --- real docker container runtime (e2e) ---
	["tests/e2e/sandbox.spec.ts", "Sets sandbox=docker; real Docker container runtime."],
	["tests/e2e/sandbox-archive.spec.ts", "Real Docker sandbox archive lifecycle."],
	["tests/e2e/sandbox-branch-reconcile.spec.ts", "Real Docker sandbox branch reconcile."],
	["tests/e2e/sandbox-delegate.spec.ts", "Real Docker sandbox delegate."],
	["tests/e2e/sandbox-pentest.spec.ts", "Real Docker sandbox escape/pen-test."],
	["tests/e2e/sandbox-persistence.spec.ts", "Real Docker sandbox persistence across restart."],
	["tests/e2e/sandbox-recovery.spec.ts", "Real Docker sandbox container recovery."],
	["tests/e2e/sandbox-restore.spec.ts", "Real Docker sandbox restore."],
	["tests/e2e/sandbox-security.spec.ts", "Real Docker sandbox security boundaries."],
	["tests/e2e/sandbox-token.spec.ts", "Real Docker sandbox scoped-token exec."],
	["tests/e2e/host-agents-sandbox-inheritance.spec.ts", "Real Docker sandbox inheritance for host agents."],
	["tests/e2e/bg-process-sandbox-guard.spec.ts", "Real Docker sandbox bg-process guard."],
	// --- real MCP subprocess (e2e) ---
	["tests/e2e/mcp-integration.spec.ts", "Spawns a real MCP server subprocess (process.execPath)."],
	["tests/e2e/marketplace-mcp.spec.ts", "Spawns a real MCP server subprocess for marketplace MCP."],
	["tests/e2e/mcp-tool-permission.spec.ts", "Spawns a real MCP subprocess to exercise tool permissions."],
]);

// Contract tests that boot a real gateway -> integration; others -> core.
const CONTRACT_INTEGRATION = new Set([
	"tests/contract/gate-verification.test.ts", // createTestGateway() boots a gateway
]);

function classify(file) {
	// 1. Curated real-fidelity daily overrides win first.
	if (DAILY_OVERRIDES.has(file)) {
		return { bucket: "daily", method: "relocate", replacement: [], rationale: DAILY_OVERRIDES.get(file) };
	}
	// 2. manual-integration is already the isolated real-fidelity tier.
	if (file.startsWith("tests/manual-integration/")) {
		return {
			bucket: "daily",
			method: "relocate",
			replacement: [],
			rationale: "Existing real-agent/LLM/Docker manual-integration suite; relocate into the daily tier-3 lane unchanged.",
		};
	}
	// 3. Contract tests.
	if (file.startsWith("tests/contract/")) {
		if (CONTRACT_INTEGRATION.has(file)) {
			return {
				bucket: "v2-integration",
				method: "codemod",
				replacement: [],
				rationale: "Contract test boots a real gateway (createTestGateway) — gateway-per-worker integration tier.",
			};
		}
		return {
			bucket: "v2-core",
			method: "codemod",
			replacement: [],
			rationale: "Contract test of pure helpers (no gateway boot) — node logic tier.",
		};
	}
	// 4. Browser E2E journeys under tests/e2e/ui/.
	if (file.startsWith("tests/e2e/ui/")) {
		const content = readRepoFile(file);
		if (GEOMETRY_REGEX.test(content)) {
			return {
				bucket: "v2-browser",
				method: "adapter",
				replacement: [],
				rationale: "Browser E2E using geometry/interaction APIs — stays in Chromium (v2-browser smoke).",
			};
		}
		const base = file.slice("tests/e2e/ui/".length).replace(/\.spec\.ts$/, "");
		const journey = journeyFor(base);
		return {
			bucket: "v2-browser",
			method: "retire-with-mapping",
			replacement: [journey],
			rationale: `Non-geometry browser E2E — consolidate into ${journey}.`,
		};
	}
	// 5. Top-level API E2E under tests/e2e/.
	if (file.startsWith("tests/e2e/")) {
		return {
			bucket: "v2-integration",
			method: "adapter",
			replacement: [],
			rationale: "API/integration E2E against a real gateway — gateway-per-worker integration tier.",
		};
	}
	// 6. Node logic suite: top-level tests/*.test.ts (and any other .test.ts).
	if (file.endsWith(".test.ts")) {
		return {
			bucket: "v2-core",
			method: "codemod",
			replacement: [],
			rationale: "node:test logic suite — codemod to vitest (node env, pool=forks).",
		};
	}
	// 7. Browser fixtures: .spec.ts under tests/ (top-level, search/, ui-fixtures/).
	if (file.endsWith(".spec.ts")) {
		const content = readRepoFile(file);
		if (GEOMETRY_REGEX.test(content)) {
			return {
				bucket: "v2-browser",
				method: "adapter",
				replacement: [],
				rationale: "Browser fixture using geometry/interaction APIs — needs a real layout engine (Chromium).",
			};
		}
		return {
			bucket: "v2-dom",
			method: "rewrite",
			replacement: [],
			rationale: "Non-geometry browser fixture — rewrite to render under happy-dom (vitest dom project).",
		};
	}
	throw new Error(`Unclassifiable file (unexpected extension): ${file}`);
}

function main() {
	const files = census();
	const entries = files.map((file) => ({ file, ...classify(file) }));

	const out = {
		$schema: "./tests-map.schema (informal): { generatedBy, censusTotal, buckets, journeys, entries[] }",
		generatedBy: "scripts/testing-v2/gen-inventory.mjs",
		note: "DO NOT hand-edit blindly — re-run `node scripts/testing-v2/gen-inventory.mjs`. Curated overrides live in the generator (DAILY_OVERRIDES / CONTRACT_INTEGRATION / JOURNEY_RULES).",
		censusTotal: entries.length,
		buckets: countBy(entries, "bucket"),
		methods: countBy(entries, "method"),
		journeys: JOURNEYS,
		entries,
	};

	const outDir = join(REPO_ROOT, "tests2");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "tests-map.json"), JSON.stringify(out, null, "\t") + "\n", "utf8");

	console.log(`Wrote tests2/tests-map.json — ${entries.length} entries`);
	for (const [k, v] of Object.entries(out.buckets)) console.log(`  ${k}: ${v}`);
}

function countBy(entries, key) {
	const m = {};
	for (const e of entries) m[e[key]] = (m[e[key]] ?? 0) + 1;
	return Object.fromEntries(Object.entries(m).sort());
}

main();
