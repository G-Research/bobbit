#!/usr/bin/env node
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baselineMetricsDir, copyMetricToBaseline, ensureDir, listJsonFiles, metricFile, npmCommand, npmRunArgs, projectRoot, requiredMetricNames, runSyncStep, writeJson } from "./lib.mjs";

const optionalMetricsToCopy = ["e2e-api-realpush"];
const metricsToCopy = [...requiredMetricNames, ...optionalMetricsToCopy];

const commands = [
	"metrics:coverage",
	"metrics:unit:node",
	"metrics:unit:browser",
	"metrics:e2e:all",
	"metrics:slice:renderer",
	"metrics:slice:scroll",
	"metrics:slice:sidebar",
];

for (const script of commands) {
	runSyncStep(script, npmCommand(), npmRunArgs(script), { shell: process.platform === "win32" });
}

const missingRequired = requiredMetricNames.filter((metric) => !existsSync(metricFile(metric)));
if (missingRequired.length > 0) {
	throw new Error(`metrics:baseline missing required current metric file(s): ${missingRequired.map((metric) => metricFile(metric).replace(projectRoot, ".")).join(", ")}`);
}

ensureDir(baselineMetricsDir);
for (const metric of metricsToCopy) {
	const obsoleteUnprefixedBaseline = metricFile(metric, baselineMetricsDir);
	if (existsSync(obsoleteUnprefixedBaseline)) rmSync(obsoleteUnprefixedBaseline, { force: true });
	if (existsSync(metricFile(metric))) copyMetricToBaseline(metric);
}

const thresholdsPath = join(baselineMetricsDir, "thresholds.json");
if (!existsSync(thresholdsPath)) {
	writeJson(thresholdsPath, {
		coverageMinDeltaPct: -0.10,
		runtimeMaxIncreaseRatio: 1.50,
		runtimeMaxIncreaseMs: 60000,
		cpuMaxIncreaseRatio: 1.75,
		cpuMaxIncreaseMs: 120000,
		memoryMaxIncreaseRatio: 1.75,
		memoryMaxIncreaseBytes: 536870912,
		browserImprovement: {
			enabled: false,
			targetRuntimeDropPct: 40,
			targetCpuDropPct: 40,
		},
	});
}

const baselineFiles = listJsonFiles(baselineMetricsDir).filter((file) => file.startsWith("baseline-"));
const coverageRows = [
	{
		target: "Renderer, panels, status widgets, cost popovers, dynamic tabs",
		current: "`tests/e2e/ui/artifacts-pack.spec.ts`, `ask-user-choices-ui.spec.ts`, `children-tool-renderers.spec.ts`, `cost-popover-cache-hit.spec.ts`, `dynamic-chat-tabs.spec.ts`, `goal-status-widget.spec.ts`, `preview-*.spec.ts`, `proposal-*.spec.ts`, `review-*.spec.ts`, `side-panel-tabs.spec.ts`, and staff/project proposal panel flows.",
		replacement: "Existing fixture coverage in `tests/activate-skill-renderer.spec.ts`, `ask-user-choices-renderer.spec.ts`, `ask-user-choices-widget.spec.ts`, `children-tool-renderers.spec.ts`, `context-cost-stats.spec.ts`, `gate-*-renderer.spec.ts`, `git-status-widget*.spec.ts`, `inbox-renderer.spec.ts`, `lazy-renderer-placeholder.spec.ts`, `notification-renderer.spec.ts`, `preview-renderer.spec.ts`, `proposal-panel-subsection-diff.spec.ts`, `proposal-rehydrate-client.spec.ts`, `review-document-sanitize.spec.ts`, plus API coverage such as `tests/api-goals-tree-cost.test.ts`; later renderer gate should add any missing panel/status fixture cases before deleting browser rows.",
		retained: "Keep one full-stack smoke for renderer registration/panel opening (`children-tool-renderers.spec.ts` `@smoke`), one ask-user-choices lifecycle smoke, one review-pane open/approve smoke, and one cost-popover/session stats smoke.",
		slice: "baseline-slice-renderer.json",
	},
	{
		target: "Scroll, tail-follow, jump-to-last-prompt, viewport geometry",
		current: "`tests/e2e/ui/jump-to-last-prompt.spec.ts`, `tail-chat-real-stream.spec.ts`, `tail-chat-session-navigate.spec.ts`, `tail-chat-user-scroll-up.spec.ts`, `pill-overflow-promotion.spec.ts`, and mobile review geometry in `mobile-review-commenting.spec.ts`.",
		replacement: "Existing deterministic fixtures in `tests/agent-interface-scroll.spec.ts`, `agent-interface-scroll-hardening.spec.ts`, `collapse-scroll-bugs.spec.ts`, `defer-offscreen-render.spec.ts`, `follow-tail.spec.ts`, `mobile-scroll-keyboard.spec.ts`, and `render-debounce.spec.ts`; later scroll gate should extract jump-to-prompt geometry and pill overflow decisions into pure fixture/unit tests.",
		retained: "Keep one real streaming tail-chat smoke, one session-navigation bottom-pin smoke, and one mobile/review viewport smoke; reduce geometric matrix coverage to fixture tests.",
		slice: "baseline-slice-scroll.json",
	},
	{
		target: "Sidebar navigation, archived rows, ordering, selection, persistence",
		current: "`tests/e2e/ui/sidebar-navigation.spec.ts`, `sidebar-keyboard-nav.spec.ts`, `sidebar-search-filter.spec.ts`, `sidebar-filters.spec.ts`, `sidebar-archived-*.spec.ts`, `sidebar-mobile-archived-*.spec.ts`, `sidebar-actions-menu.spec.ts`, `sidebar-session-actions.spec.ts`, `sidebar-spawned-children-dedupe.spec.ts`, `single-project-sidebar.spec.ts`, `stories-sidebar.spec.ts`, and `mobile-staff-sidebar.spec.ts`.",
		replacement: "Existing fixture/API coverage in `tests/sidebar-goal-rendering.spec.ts`, `sidebar-goal-group-filters.spec.ts`, `sidebar-spawned-children.spec.ts`, `mobile-archived.spec.ts`, `rapid-keystroke-nav.spec.ts`, `back-button-goal.spec.ts`, `goal-card-back-nav.spec.ts`, and API coverage in `tests/e2e/sidebar-api.spec.ts`, `sidebar-actions-server.spec.ts`, `archived-delegates-api.spec.ts`, `archived-footer-model.spec.ts`, `archived-session-merge.spec.ts`, `parent-scoped-archive-child.spec.ts`, `stories-sessions-api.spec.ts`; later sidebar gate should add a fixture matrix for row order, focus cycling, show-archived state, selection, and persistence before deleting browser rows.",
		retained: "Keep one keyboard navigation journey, one show-archived persistence journey, one session/goal navigation smoke, and one actions-menu smoke; move combinatorial row/focus/order cases to fixtures/API.",
		slice: "baseline-slice-sidebar.json",
	},
];
const coverageMapRows = coverageRows.map((row) => `| ${row.target} | ${row.current} | ${row.replacement} | ${row.retained} | \`${row.slice}\` |`).join("\n");
const coverageMap = `# Split UI E2E coverage map\n\nGenerated by \`npm run metrics:baseline\`. Update this file whenever browser E2E coverage is migrated to cheaper layers. Baseline metric files are committed as \`docs/testing-metrics/baseline-<name>.json\`; current runtime metrics remain unprefixed under \`.profiles/metrics/<name>.json\`.\n\n| Target behavior | Current full-browser E2E coverage | Replacement unit/fixture/API coverage | Retained full-stack smoke coverage | Baseline metric slice |\n|---|---|---|---|---|\n${coverageMapRows}\n\n## Baseline metric files\n\n${baselineFiles.map((file) => `- \`${file}\``).join("\n")}\n\nThresholds: \`thresholds.json\`.\n`;
writeFileSync(join(baselineMetricsDir, "coverage-map.md"), coverageMap);
console.log(`[metrics:baseline] wrote baselines to ${baselineMetricsDir.replace(projectRoot, ".")}`);
