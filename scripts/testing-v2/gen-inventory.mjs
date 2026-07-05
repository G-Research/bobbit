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
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	census,
	readRepoFile,
	REPO_ROOT,
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
// Precise content-based real-browser detector.
//
// Scan the spec plus explicitly associated file:// fixture assets: sibling
// .html / *-entry.ts files, and any tests/** .html or *-entry.ts path literal
// referenced by the spec. Deliberately DO NOT match bare words like "scroll",
// "canvas", or requestAnimationFrame-only render flushing.
// ---------------------------------------------------------------------------
const GEOMETRY_PATTERNS = [
	["getBoundingClientRect()", /\bgetBoundingClientRect\s*\(/],
	["Playwright boundingBox()", /\.boundingBox\s*\(/],
	["scroll geometry", /(?:\bscroll(?:Top|Left|Height|Width)\b|\.(?:scrollIntoView|scrollBy|scrollTo|scroll)\s*\()/],
	["ResizeObserver", /\bResizeObserver\b/],
	["IntersectionObserver", /\bIntersectionObserver\b/],
	["visualViewport", /\bvisualViewport\b/],
	["matchMedia", /\bmatchMedia\b/],
	["getAnimations()", /\bgetAnimations\s*\(/],
	["canvas element/API", /(?:<canvas\b|\b(?:document\.)?createElement\s*\(\s*["']canvas["']|\bHTMLCanvasElement\b|\bCanvasRenderingContext2D\b|\b(?:getContext|toDataURL|drawImage)\s*\()/i],
	["mouse.wheel()", /\bmouse\.wheel\s*\(/],
	["drag-and-drop/DataTransfer", /(?:\bdataTransfer\b|["'](?:dragstart|dragover|dragend|drop)["'])/],
	["IME composition", /(?:\bIME\b|\bcomposition(?:start|end|update)\b)/],
];

function candidateFixtureFiles(file, content) {
	const candidates = new Set();
	const dir = dirname(file);
	const base = basename(file).replace(/\.(?:spec|test)\.ts$/, "");
	for (const rel of [
		join(dir, `${base}.html`),
		join(dir, `${base}-entry.ts`),
		join("tests", "fixtures", `${base}.html`),
		join("tests", "fixtures", `${base}-entry.ts`),
	]) {
		candidates.add(rel.replace(/\\/g, "/"));
	}
	for (const match of content.matchAll(/["'`](tests\/[^"'`]+?(?:\.html|-entry\.ts))["'`]/g)) {
		candidates.add(match[1].replace(/\\/g, "/"));
	}
	return [...candidates].filter((rel) => existsSync(join(REPO_ROOT, rel)));
}

function geometryEvidence(file) {
	const primary = readRepoFile(file);
	const sources = [[file, primary]];
	for (const rel of candidateFixtureFiles(file, primary)) {
		sources.push([rel, readRepoFile(rel)]);
	}
	for (const [source, content] of sources) {
		const lines = content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			for (const [label, re] of GEOMETRY_PATTERNS) {
				if (re.test(lines[i])) return { label, source, line: i + 1 };
			}
		}
	}
	return null;
}

function browserRationale(evidence, prefix = "Browser fixture") {
	return `${prefix} uses ${evidence.label} at ${evidence.source}:${evidence.line} — needs Chromium real-browser fidelity.`;
}

function override(bucket, method, rationale, replacement = []) {
	return { bucket, method, replacement, rationale };
}

// ---------------------------------------------------------------------------
// Manual classification overrides from the failed gate-1 re-audit.
//
// These are explicit so the generator remains idempotent and the JSON keeps a
// cited rationale for every v2-browser/daily re-audit decision that keyword or
// broad-regex heuristics previously got wrong.
// ---------------------------------------------------------------------------
export const CLASSIFICATION_OVERRIDES = new Map([
	// --- Re-audited v2-browser/adapter candidates with no narrow real-browser need ---
	["tests/bg-process-states.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: dropdown/status fixture uses clicks and text assertions only; no geometry APIs (tests/bg-process-states.spec.ts:207-218).")],
	["tests/bg-wait-timer.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: LiveTimer elapsed-text fixture only; no geometry/interaction API (tests/bg-wait-timer.spec.ts:18-21).")],
	["tests/context-cost-stats.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: getContextTotalCostText is a fixture helper name, not getContext/canvas (tests/context-cost-stats.spec.ts:169-182).")],
	["tests/e2e/ui/git-status-untracked-race.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: requestAnimationFrame is only a flush helper; consolidate git-status race into multi-repo/git journey (tests/e2e/ui/git-status-untracked-race.spec.ts:32).", ["journey-multi-repo"])],
	["tests/e2e/ui/goal-metadata.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: form/tab metadata flow with no geometry API; consolidate into goal-editing journey (tests/e2e/ui/goal-metadata.spec.ts:118-154).", ["journey-goal-editing"])],
	["tests/e2e/ui/goal-proposal-offscreen-return.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: off-screen proposal guard uses app state and rAF flush only; consolidate into proposals journey (tests/e2e/ui/goal-proposal-offscreen-return.spec.ts:122-193).", ["journey-proposals"])],
	["tests/e2e/ui/marketplace-mcp.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: marketplace MCP UI tabs/keyboard only, no real MCP subprocess or geometry (tests/e2e/ui/marketplace-mcp.spec.ts:229-350).", ["journey-marketplace-packs"])],
	["tests/e2e/ui/marketplace.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: marketplace tabs/search/keyboard flows only; no geometry API (tests/e2e/ui/marketplace.spec.ts:374-448).", ["journey-marketplace-packs"])],
	["tests/e2e/ui/mid-session-project-proposal.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: project proposal tab lifecycle with no geometry API; consolidate into proposals journey (tests/e2e/ui/mid-session-project-proposal.spec.ts:80-107).", ["journey-proposals"])],
	["tests/e2e/ui/notification-policy.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: notification policy assertions; rAF is only a flush helper (tests/e2e/ui/notification-policy.spec.ts:44).", ["journey-notification-policy"])],
	["tests/e2e/ui/plan-archived-children.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: archived-child plan tab flow with no geometry API (tests/e2e/ui/plan-archived-children.spec.ts:122-124).", ["journey-team-delegate"])],
	["tests/e2e/ui/replace-bobbit-text.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: asserts canvas element is replaced/restored but never exercises canvas API/drawing; consolidate into debug-tools journey (tests/e2e/ui/replace-bobbit-text.spec.ts:30-94).", ["journey-debug-tools"])],
	["tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: websocket/live-row ordering with rAF flush only; consolidate into crash/restart journey (tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts:134).", ["journey-crash-restart"])],
	["tests/e2e/ui/sidebar-keyboard-nav.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: Ctrl+Arrow navigation smoke with no geometry API; consolidate into sidebar keyboard journey (tests/e2e/ui/sidebar-keyboard-nav.spec.ts:275-291).", ["journey-sidebar-nav-search-keyboard"])],
	["tests/e2e/ui/tail-chat-session-navigate.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: navigation/persistence smoke, no geometry API; consolidate into session-lifecycle journey (tests/e2e/ui/tail-chat-session-navigate.spec.ts:1-57).", ["journey-session-lifecycle"])],
	["tests/e2e/ui/tree-cost-rollup.spec.ts", override("v2-browser", "retire-with-mapping", "Read in re-audit: tree cost rollup data/UI assertions with no geometry API (tests/e2e/ui/tree-cost-rollup.spec.ts:1-443).", ["journey-cost-tracking"])],
	["tests/gate-verification-reconcile.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: verification reconciliation fixture has DOM/state assertions only; no geometry API (tests/gate-verification-reconcile.spec.ts:1-349).")],
	["tests/git-status-interactions.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: dropdown interactions use rAF only for portal flush; no geometry API (tests/git-status-interactions.spec.ts:19-23).")],
	["tests/markdown-dollar-template.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: markdown rendering fixture uses rAF only as render flush; no geometry API (tests/markdown-dollar-template.spec.ts:102).")],
	["tests/render-debounce.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: debounce fixture exercises requestAnimationFrame scheduling only; no real layout API (tests/render-debounce.spec.ts:24-58).")],
	["tests/settings-models-tab-redesign.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: models-tab fixture resets state and asserts text/form UI; no geometry API (tests/settings-models-tab-redesign.spec.ts:132-286).")],
	["tests/streaming-message-container-set-message.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: streaming-message fixture uses rAF only to flush batched updates; no geometry API (tests/streaming-message-container-set-message.spec.ts:65-83).")],
	["tests/ui-fixtures/sidebar-keyboard-nav-fixture.spec.ts", override("v2-dom", "rewrite", "Read in re-audit: lightweight keyboard-nav fixture uses DOM order and Ctrl+Arrow events only; no geometry API (tests/ui-fixtures/sidebar-keyboard-nav-fixture.spec.ts:242-286).")],

	// --- Re-audited v2-browser/adapter candidates that genuinely need Chromium ---
	["tests/e2e/ui/add-project-footer-stability.spec.ts", override("v2-browser", "adapter", "Read in re-audit: measures footer Playwright boundingBox() stability at tests/e2e/ui/add-project-footer-stability.spec.ts:28-32.")],
	["tests/message-editor-ime.spec.ts", override("v2-browser", "adapter", "Read in re-audit: IME composition guard is the test contract (tests/message-editor-ime.spec.ts:2,28).")],
	["tests/mobile-goal-preview.spec.ts", override("v2-browser", "adapter", "Read in re-audit: compares Playwright element boundingBox() positions for mobile header overlap (tests/mobile-goal-preview.spec.ts:16-27).")],
	["tests/sidebar-bobbit-datauri-cache.spec.ts", override("v2-browser", "adapter", "Read in re-audit: spies on HTMLCanvasElement.toDataURL() and canvas-derived image output (tests/sidebar-bobbit-datauri-cache.spec.ts:51-55).")],
	["tests/streaming-bobbit-canvas-ref.spec.ts", override("v2-browser", "adapter", "Read in re-audit: spies on CanvasRenderingContext2D.drawImage and canvas element persistence (tests/streaming-bobbit-canvas-ref.spec.ts:47-55,83-86).")],

	// --- Re-audited filename-keyword daily candidates that are fast integration tests ---
	["tests/e2e/bg-process-sandbox-guard.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: header says Docker-dependent coverage lives in manual integration; this file mutates session flags in the in-process harness only (tests/e2e/bg-process-sandbox-guard.spec.ts:3-8).")],
	["tests/e2e/host-agents-sandbox-inheritance.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: deterministic real gateway + mock agent, explicitly never test:manual (tests/e2e/host-agents-sandbox-inheritance.spec.ts:1-11).")],
	["tests/e2e/sandbox.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: header states this does not require Docker; tests REST/config/status behavior (tests/e2e/sandbox.spec.ts:3-5,32-80).")],
	["tests/e2e/sandbox-archive.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: archived-message path uses mock agent jsonl and host fs; no Docker/container runtime (tests/e2e/sandbox-archive.spec.ts:3-7,48-59).")],
	["tests/e2e/sandbox-branch-reconcile.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: header says tests run without Docker and manual integration covers Docker reconciliation (tests/e2e/sandbox-branch-reconcile.spec.ts:7-14).")],
	["tests/e2e/sandbox-delegate.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: header says these tests do NOT require Docker and use mock-agent REST API coverage (tests/e2e/sandbox-delegate.spec.ts:7-12).")],
	["tests/e2e/sandbox-pentest.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: header says no Docker; verifies docker-arg builder/config structure directly (tests/e2e/sandbox-pentest.spec.ts:6-12).")],
	["tests/e2e/sandbox-persistence.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: persists sandbox metadata and accepts Docker-unavailable failure path; no real container required (tests/e2e/sandbox-persistence.spec.ts:3-7,42-73).")],
	["tests/e2e/sandbox-restore.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: header says no Docker; intercepts applySandboxWiring boundary (tests/e2e/sandbox-restore.spec.ts:3-8,61-67).")],
	["tests/e2e/sandbox-security.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: header says no Docker; registers SandboxTokenStore tokens and makes HTTP requests only (tests/e2e/sandbox-security.spec.ts:3-9).")],
	["tests/e2e/sandbox-token.spec.ts", override("v2-integration", "adapter", "Read in daily re-audit: scoped-token store/guard and health endpoint assertions only; no Docker runtime (tests/e2e/sandbox-token.spec.ts:1-4,34-139).")],
]);

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
	["tests/e2e/sandbox-recovery.spec.ts", "Real Docker sandbox container recovery."],
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
	// 1. Explicit audit overrides win first.
	if (CLASSIFICATION_OVERRIDES.has(file)) {
		return CLASSIFICATION_OVERRIDES.get(file);
	}
	// 2. Curated real-fidelity daily overrides.
	if (DAILY_OVERRIDES.has(file)) {
		return { bucket: "daily", method: "relocate", replacement: [], rationale: DAILY_OVERRIDES.get(file) };
	}
	// 3. manual-integration is already the isolated real-fidelity tier.
	if (file.startsWith("tests/manual-integration/")) {
		return {
			bucket: "daily",
			method: "relocate",
			replacement: [],
			rationale: "Existing real-agent/LLM/Docker manual-integration suite; relocate into the daily tier-3 lane unchanged.",
		};
	}
	// 4. Contract tests.
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
	// 5. Browser E2E journeys under tests/e2e/ui/.
	if (file.startsWith("tests/e2e/ui/")) {
		const evidence = geometryEvidence(file);
		if (evidence) {
			return {
				bucket: "v2-browser",
				method: "adapter",
				replacement: [],
				rationale: browserRationale(evidence, "Browser E2E"),
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
	// 6. Top-level API E2E under tests/e2e/.
	if (file.startsWith("tests/e2e/")) {
		return {
			bucket: "v2-integration",
			method: "adapter",
			replacement: [],
			rationale: "API/integration E2E against a real gateway — gateway-per-worker integration tier.",
		};
	}
	// 7. Node logic suite: top-level tests/*.test.ts (and any other .test.ts).
	if (file.endsWith(".test.ts")) {
		return {
			bucket: "v2-core",
			method: "codemod",
			replacement: [],
			rationale: "node:test logic suite — codemod to vitest (node env, pool=forks).",
		};
	}
	// 8. Browser fixtures: .spec.ts under tests/ (top-level, search/, ui-fixtures/).
	if (file.endsWith(".spec.ts")) {
		const evidence = geometryEvidence(file);
		if (evidence) {
			return {
				bucket: "v2-browser",
				method: "adapter",
				replacement: [],
				rationale: browserRationale(evidence),
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
		note: "DO NOT hand-edit blindly — re-run `node scripts/testing-v2/gen-inventory.mjs`. Curated overrides live in the generator (CLASSIFICATION_OVERRIDES / DAILY_OVERRIDES / CONTRACT_INTEGRATION / JOURNEY_RULES).",
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
