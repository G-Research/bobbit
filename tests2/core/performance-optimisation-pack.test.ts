import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	activeBuiltinFirstPartyPackEntries,
	builtinFirstPartyPackEntries,
} from "../../src/server/agent/builtin-packs.ts";
import { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.ts";

const MARKET_PACKS = fileURLToPath(new URL("../../market-packs", import.meta.url));
const PANEL_SOURCE = readFileSync(new URL("../../market-packs/performance-optimisation/src/performance-panel.ts", import.meta.url), "utf8");
const PANEL_BUNDLE = readFileSync(new URL("../../market-packs/performance-optimisation/lib/performance-panel.js", import.meta.url), "utf8");
const DATABASE_SOURCE = readFileSync(new URL("../../market-packs/performance-optimisation/src/performance-database.ts", import.meta.url), "utf8");
const ROUTES_ENTRY_SOURCE = readFileSync(new URL("../../market-packs/performance-optimisation/src/performance-routes-entry.ts", import.meta.url), "utf8");
const TOOL_ENTRY_SOURCE = readFileSync(new URL("../../market-packs/performance-optimisation/src/performance-tool-extension-entry.ts", import.meta.url), "utf8");
const BUILD_METADATA = JSON.parse(readFileSync(new URL("../../market-packs/performance-optimisation/pack.build.json", import.meta.url), "utf8"));
const NATIVE_FAMILY = new URL("../../market-packs/performance-optimisation/lib/native/database-driver/", import.meta.url);
const NATIVE_MANIFEST = JSON.parse(readFileSync(new URL("manifest.json", NATIVE_FAMILY), "utf8"));
const SCANNER_ROLE = readFileSync(new URL("../../market-packs/performance-optimisation/roles/performance-scanner.yaml", import.meta.url), "utf8");
const DIRECTOR_ROLE = readFileSync(new URL("../../market-packs/performance-optimisation/roles/optimisation-director.yaml", import.meta.url), "utf8");
const INSTALL_SKILL = readFileSync(new URL("../../market-packs/performance-optimisation/skills/install-performance-optimisation/SKILL.md", import.meta.url), "utf8");
const BUILD_SOURCE = readFileSync(new URL("../../scripts/build-market-packs.mjs", import.meta.url), "utf8");
const COPY_SOURCE = readFileSync(new URL("../../scripts/copy-builtin-packs.mjs", import.meta.url), "utf8");
const HARNESS_SOURCE = readFileSync(new URL("../harness/gateway.ts", import.meta.url), "utf8");

describe("performance optimisation first-party pack", () => {
	it("ships opt-in with three roles, local data, tools, installation skill, a singleton panel, and mediated routes", () => {
		const entry = builtinFirstPartyPackEntries(MARKET_PACKS)
			.find((candidate) => candidate.manifest?.name === "performance-optimisation");
		expect(entry).toBeDefined();
		if (!entry?.manifest) throw new Error("performance-optimisation manifest missing");
		expect(entry.manifest).toMatchObject({
			name: "performance-optimisation",
			schema: 2,
			defaultDisabled: true,
			localData: {
				scope: "project",
				directory: ".performance-optimisation",
				access: "read-write",
				preserveOnUninstall: true,
			},
			contents: {
				roles: ["performance-scanner", "performance-ideator", "optimisation-director"],
				tools: ["performance-optimisation"],
				skills: ["install-performance-optimisation"],
				entrypoints: [
					"performance-optimisation-open",
					"performance-optimisation-session-menu",
					"performance-optimisation-route",
				],
			},
		});
		expect(activeBuiltinFirstPartyPackEntries(MARKET_PACKS, () => undefined)
			.some((candidate) => candidate.manifest?.name === "performance-optimisation")).toBe(false);

		const registry = new PackContributionRegistry(() => [entry]);
		expect(registry.getPanel(undefined, "performance-optimisation", "performance-optimisation.panel")).toMatchObject({
			title: "Perf Optimisation",
			instanceMode: "singleton",
		});
		expect(registry.getEntrypoint(undefined, "performance-optimisation", "performance-optimisation.route")).toMatchObject({
			kind: "route",
			routeId: "performance-optimisation",
			paramKeys: ["tab", "demo"],
		});
	});

	it("builds the canonical responsive control pane through mediated Host APIs", () => {
		expect(PANEL_SOURCE).toContain('from "../../../src/shared/extension-host/host-api.ts"');
		expect(PANEL_SOURCE).toContain('label: "Flow map"');
		expect(PANEL_SOURCE).toContain('label: "Scan coverage"');
		expect(PANEL_SOURCE).toContain('label: "Hypothesis registry"');
		expect(PANEL_SOURCE).toContain('label: "Benchmark store"');
		for (const label of ["Optimisation Scanner", "Hypotheses", "Optimisation Director", "Goal teams", "Benchmarks"]) {
			expect(PANEL_SOURCE).toContain(label);
		}
		expect(PANEL_SOURCE).toContain("activeScans");
		expect(PANEL_SOURCE).toContain("completedLast24h");
		expect(PANEL_SOURCE).toMatch(/slice\(0, 50\)/);
		expect(PANEL_SOURCE).toContain("host.ui.navigate({ route: ROUTE_ID");
		expect(PANEL_SOURCE).toContain("host.ui.openPanel({ panelId: PANEL_ID");
		expect(PANEL_SOURCE).toContain('host?.capabilities?.projectReads === true');
		expect(PANEL_SOURCE).toContain('host?.capabilities?.has?.("projectReads") === true');
		for (const method of ["readStaff", "readSessions", "readGoals", "readGoalTasks", "readGoalGates", "readGoalPullRequest"]) {
			expect(PANEL_SOURCE).toContain(`host.project.${method}`);
		}
		expect(PANEL_SOURCE).toContain("const routeRead = canReadRoute");
		expect(PANEL_SOURCE).toContain("await readRelatedProjectRecords(host!, state.routeSnapshot)");
		expect(PANEL_SOURCE).toContain("mode: \"ids\", ids");
		expect(PANEL_SOURCE).toContain("MAX_PROJECT_PAGES");
		expect(PANEL_SOURCE).toContain("outcome.status !== \"found\"");
		expect(PANEL_SOURCE).toContain('host!.callRoute<unknown>(SNAPSHOT_ROUTE');
		expect(PANEL_SOURCE).toContain("host.project.notifications.subscribe");
		expect(PANEL_SOURCE).toContain("host.ui.createBobbitSprite");
		for (const edge of [
			'{ id: "refresh-coverage", from: "scanner", to: "coverage", tool: "perf_coverage_refresh"',
			'{ id: "select-coverage", from: "coverage", to: "scanner", tool: "perf_coverage_get_modules_to_scan"',
			'{ id: "delegate-ideator", from: "scanner", to: "ideators", tool: "team_delegate"',
			'{ id: "seal-coverage", from: "ideators", to: "coverage", tool: "perf_coverage_mark_module_as"',
			'{ id: "publish-hypothesis", from: "ideators", to: "hypotheses", tool: "perf_hypothesis_create"',
			'{ id: "rank-hypothesis", from: "hypotheses", to: "director", tool: "perf_hypothesis_get_highest_priority"',
			'{ id: "create-goal", from: "director", to: "goals", tool: "bobbit_orchestrate.create_goal"',
			'{ id: "select-benchmark", from: "benchmarks", to: "goals", tool: "perf_benchmark_list"',
			'{ id: "record-run", from: "goals", to: "benchmarks", tool: "perf_benchmark_record_run"',
			'{ id: "record-outcome", from: "goals", to: "hypotheses", tool: "perf_hypothesis_record_outcome"',
		]) expect(PANEL_SOURCE).toContain(edge);
		expect(PANEL_SOURCE).toContain('return staffId ? { kind: "staff"');
		expect(PANEL_SOURCE).not.toContain("bobbit-sprite-data");
		expect(PANEL_SOURCE).not.toContain("BOBBIT_HUE_ROTATIONS");
		expect(PANEL_SOURCE).not.toContain("ACCESSORIES");
		expect(PANEL_SOURCE).not.toContain(".po-pixel");
		expect(PANEL_SOURCE).not.toMatch(/from\s+["'][^"']*elk|vendor\/elk|new\s+ELK\b|org\.eclipse\.elk/i);
		expect(PANEL_SOURCE).toContain("semantic-grid");
		expect(PANEL_SOURCE).toContain("SEMANTIC_SPLINE");
		expect(PANEL_SOURCE).toContain("port-aware-curved");
		for (const mode of ["STORE_ROW", "STORE_COLUMN", "SINGLE_COLUMN"]) expect(PANEL_SOURCE).toContain(mode);
		expect(PANEL_SOURCE).toMatch(/const\s+\w*BREAKPOINT\w*\s*=\s*900;/);
		expect(PANEL_SOURCE).toMatch(/const\s+\w*BREAKPOINT\w*\s*=\s*520;/);
		expect(PANEL_SOURCE).toMatch(/grid-template-areas:\s*"scanner ideators director goals"\s*"coverage hypotheses hypotheses benchmarks"/);
		expect(PANEL_SOURCE).toMatch(/grid-template-areas:\s*"scanner coverage"\s*"ideators hypotheses"\s*"director \."\s*"goals benchmarks"/);
		expect(PANEL_SOURCE).toMatch(/grid-template-areas:\s*"scanner"\s*"coverage"\s*"ideators"\s*"hypotheses"\s*"director"\s*"goals"\s*"benchmarks"/);
		expect(PANEL_SOURCE).toMatch(/outer.?gutter/i);
		expect(PANEL_SOURCE).toContain("function buildRoutingGraph");
		expect(PANEL_SOURCE).toContain("function shortestChannelRoute");
		const routingScheduler = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf("function scheduleFlowRouting"), PANEL_SOURCE.indexOf("function programmeHeadline"));
		expect(routingScheduler).toContain("routeFlowEdges(canvas)");
		expect(routingScheduler).not.toContain("requestAnimationFrame");
		const refreshFunctionStart = PANEL_SOURCE.indexOf("async function refreshSnapshot");
		const refreshLoadingStart = PANEL_SOURCE.indexOf("const generation", refreshFunctionStart);
		const refreshLoadingPhase = PANEL_SOURCE.slice(refreshLoadingStart, PANEL_SOURCE.indexOf("try {", refreshLoadingStart));
		expect(refreshLoadingPhase).not.toContain("renderPane(state)");
		expect(PANEL_SOURCE).toContain("function crossingCost");
		expect(PANEL_SOURCE).toContain("function roundedChannelPath");
		expect(PANEL_SOURCE).toContain("ROUTE_NODE_HALO");
		expect(PANEL_SOURCE).toContain("ROUTE_BEND_PENALTY");
		expect(PANEL_SOURCE).toContain("ROUTE_CROSSING_PENALTY");
		expect(PANEL_SOURCE).toContain('group.dataset.obstacleSafe = "visibility-channel"');
		expect(PANEL_SOURCE).toContain("function allocateRoutePorts");
		expect(PANEL_SOURCE).toContain("(index + 1) / (endpoints.length + 1)");
		expect(PANEL_SOURCE).toContain("function preferredPortAlignedRoute");
		expect(PANEL_SOURCE).toContain("function terminalLeadLength");
		expect(PANEL_SOURCE).toContain("ROUTE_MIN_TERMINAL_GAP");
		expect(PANEL_SOURCE).toContain('if (route.id === "rank-hypothesis") return { from: "EAST", to: "SOUTH" }');
		expect(PANEL_SOURCE).toContain('group.dataset.bendAlignment = portAlignedPoints ? "port-axis" : "visibility-search"');
		expect(PANEL_SOURCE).toContain("function renderFlowTooltips");
		expect(PANEL_SOURCE).toContain("z-index: 100");
		expect(PANEL_SOURCE).toContain(".po-edge-tip.is-visible");
		expect(PANEL_SOURCE).toContain("const STORE_CONTENT_INSETS");
		expect(PANEL_SOURCE).toContain("top: 46");
		expect(PANEL_SOURCE).toContain(".po-map-node.is-store { width: 162px; min-height: 162px; border: 0; border-radius: 0; background: transparent; box-shadow: none;");
		expect(PANEL_SOURCE).toContain('article.dataset.contentInset');
		expect(PANEL_SOURCE).toContain('svg.classList.add("po-cylinder")');
		expect(PANEL_SOURCE).toContain('bottom.setAttribute("rx", "48")');
		expect(PANEL_SOURCE).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
		expect(PANEL_SOURCE).toContain("gap: .2em");
		expect(PANEL_SOURCE).toContain("padding: 4px 6px");
		expect(PANEL_SOURCE).toContain("border-radius: 4px");
		expect(PANEL_SOURCE).toContain("font-size: 1.1667em");
		expect(PANEL_SOURCE).toContain("gap: min(.25em, .375rem)");
		expect(PANEL_SOURCE).toContain("color-mix(in oklch, var(--primary) 10%, transparent)");
		expect(PANEL_SOURCE).toContain('from "lucide"');
		expect(PANEL_SOURCE).not.toContain('tool: "read_session"');
		expect(PANEL_SOURCE.match(/tool: "[^"]+"/g)?.length).toBe(new Set(PANEL_SOURCE.match(/tool: "[^"]+"/g)).size);
		expect(PANEL_SOURCE).not.toContain('button(state.loading ? "Refreshing…" : "Refresh"');
		expect(PANEL_SOURCE).not.toContain('node("section", "po-panel")');
		expect(PANEL_SOURCE).not.toContain("readStoredValue<unknown>(state, SNAPSHOT_KEY)");
		expect(PANEL_SOURCE).not.toMatch(/\bfetch\s*\(|location\.hash|window\.location|#\/ext\/|\/api\//);
		expect(PANEL_SOURCE).not.toMatch(/position:\s*absolute[^}]*po-connector/s);
		expect(Buffer.byteLength(PANEL_BUNDLE, "utf8")).toBeLessThan(500 * 1024);
	});

	it("pins the scanner/director responsibilities and build/dev shipping paths", () => {
		expect(SCANNER_ROLE).toContain("team_delegate");
		expect(SCANNER_ROLE).toContain("read_only: true");
		expect(SCANNER_ROLE).toContain("search the Hypothesis Registry");
		expect(SCANNER_ROLE).toContain("seal its coverage record");
		expect(SCANNER_ROLE).toContain("no strict lease timeout");
		expect(DIRECTOR_ROLE).toContain("bobbit_orchestrate(operation: \"create_goal\")");
		expect(DIRECTOR_ROLE).toContain("perf_hypothesis_get_goal_payload");
		expect(DIRECTOR_ROLE).toContain("perf_hypothesis_mark_goal_creation");
		expect(DIRECTOR_ROLE).toMatch(/"Proposals": never/);
		expect(DIRECTOR_ROLE).toContain("team_delegate: never");
		expect(DIRECTOR_ROLE).toContain("autoStartTeam: true");
		expect(INSTALL_SKILL).toContain("perf_coverage_refresh");
		expect(INSTALL_SKILL).toContain("perf_benchmark_sync");
		expect(INSTALL_SKILL).toContain("perf_programme_get_session_context");
		expect(INSTALL_SKILL).not.toContain('bobbit_read(operation: "connection_info")');
		expect(INSTALL_SKILL).toContain("Omit `body.cwd`");
		expect(INSTALL_SKILL).toContain("must not create, edit, or execute benchmark commands");
		expect(INSTALL_SKILL).toContain("Never guess measurement semantics");
		expect(INSTALL_SKILL).toContain("commandName` is the script key");
		expect(INSTALL_SKILL).toContain("Manual only (manual)");
		expect(INSTALL_SKILL).toContain("Manual-only staff receive `triggers: []`");
		expect(BUILD_SOURCE).toContain('pack: "performance-optimisation"');
		expect(BUILD_SOURCE).toContain('{ in: "performance-panel.ts", out: "lib/performance-panel.js" }');
		expect(BUILD_SOURCE).toContain('{ in: "performance-routes-entry.ts", out: "lib/performance-routes.mjs", platform: "node" }');
		expect(BUILD_SOURCE).toContain('{ in: "performance-tool-extension-entry.ts", out: "tools/performance-optimisation/extension.js", platform: "node" }');
		expect(BUILD_METADATA).toMatchObject({ schema: 1, nativeAssets: [{ id: "database-driver", package: "better-sqlite3" }] });
		const nativeTargets = [
			"darwin-arm64", "darwin-x64",
			"linux-glibc-arm64", "linux-glibc-x64",
			"linux-musl-arm64", "linux-musl-x64",
			"win32-arm64", "win32-x64",
		];
		expect(Object.keys(BUILD_METADATA.nativeAssets[0].targets).sort()).toEqual([...nativeTargets].sort());
		expect(BUILD_METADATA.nativeAssets[0].targets).toMatchObject({
			"linux-glibc-arm64": "prebuilds/linux-arm64.node",
			"linux-glibc-x64": "prebuilds/linux-x64.node",
			"linux-musl-arm64": "prebuilds/linuxmusl-arm64.node",
			"linux-musl-x64": "prebuilds/linuxmusl-x64.node",
		});
		expect(NATIVE_MANIFEST).toMatchObject({ schema: 1, package: "better-sqlite3", version: "13.0.3" });
		expect(Object.keys(NATIVE_MANIFEST.targets).sort()).toEqual([...nativeTargets].sort());
		for (const target of nativeTargets) {
			expect(NATIVE_MANIFEST.targets[target]).toMatchObject({ file: `${target}.node` });
			expect(existsSync(new URL(`${target}.node`, NATIVE_FAMILY))).toBe(true);
		}
		expect(ROUTES_ENTRY_SOURCE).toContain('from "bobbit:pack-native-assets"');
		expect(ROUTES_ENTRY_SOURCE).toContain('new URL("./native/database-driver/", import.meta.url)');
		expect(TOOL_ENTRY_SOURCE).toContain('from "bobbit:pack-native-assets"');
		expect(TOOL_ENTRY_SOURCE).toContain('new URL("../../lib/native/database-driver/", import.meta.url)');
		expect(DATABASE_SOURCE).not.toContain("nativeBindingTarget");
		expect(DATABASE_SOURCE).not.toContain("bundledNativeBinding");
		expect(DATABASE_SOURCE).not.toContain('"./better_sqlite3.node"');
		expect(COPY_SOURCE).toMatch(/FIRST_PARTY_PACKS\s*=\s*\[[^\]]*"performance-optimisation"/);
		expect(HARNESS_SOURCE).toMatch(/FIRST_PARTY_PACKS\s*=\s*\[[^\]]*"performance-optimisation"/);
		expect(HARNESS_SOURCE).toContain('BUILTIN_PACK_SKIP_RELATIVE_DIRS = new Set(["lib/native"])');
	});
});
