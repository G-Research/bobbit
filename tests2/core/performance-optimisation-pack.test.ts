import { readFileSync } from "node:fs";
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
const SCANNER_ROLE = readFileSync(new URL("../../market-packs/performance-optimisation/roles/performance-scanner.yaml", import.meta.url), "utf8");
const DIRECTOR_ROLE = readFileSync(new URL("../../market-packs/performance-optimisation/roles/optimisation-director.yaml", import.meta.url), "utf8");
const BUILD_SOURCE = readFileSync(new URL("../../scripts/build-market-packs.mjs", import.meta.url), "utf8");
const COPY_SOURCE = readFileSync(new URL("../../scripts/copy-builtin-packs.mjs", import.meta.url), "utf8");
const HARNESS_SOURCE = readFileSync(new URL("../harness/gateway.ts", import.meta.url), "utf8");

describe("performance optimisation first-party pack", () => {
	it("ships opt-in with two roles, a singleton panel, launchers, and a reload-safe route", () => {
		const entry = builtinFirstPartyPackEntries(MARKET_PACKS)
			.find((candidate) => candidate.manifest?.name === "performance-optimisation");
		expect(entry).toBeDefined();
		if (!entry?.manifest) throw new Error("performance-optimisation manifest missing");
		expect(entry.manifest).toMatchObject({
			name: "performance-optimisation",
			schema: 2,
			defaultDisabled: true,
			contents: {
				roles: ["performance-scanner", "optimisation-director"],
				tools: [],
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
			title: "Performance",
			instanceMode: "singleton",
		});
		expect(registry.getEntrypoint(undefined, "performance-optimisation", "performance-optimisation.route")).toMatchObject({
			kind: "route",
			routeId: "performance-optimisation",
			paramKeys: ["tab", "demo"],
		});
	});

	it("builds the canonical responsive control pane through mediated Host APIs", () => {
		expect(PANEL_SOURCE).toContain('from "../../../src/shared/bobbit-sprite-data.ts"');
		expect(PANEL_SOURCE).toContain('from "../../../src/shared/extension-host/host-api.ts"');
		expect(PANEL_SOURCE).toContain('label: "Flow map"');
		expect(PANEL_SOURCE).toContain('label: "Scan coverage"');
		expect(PANEL_SOURCE).toContain('label: "Hypothesis registry"');
		for (const label of ["Performance Scanner", "Hypothesis Registry", "Optimisation Director", "Goals", "Pull Requests"]) {
			expect(PANEL_SOURCE).toContain(label);
		}
		expect(PANEL_SOURCE).toContain("activeScans");
		expect(PANEL_SOURCE).toContain("completedLast24h");
		expect(PANEL_SOURCE).toMatch(/slice\(0, 50\)/);
		expect(PANEL_SOURCE).toContain("host.ui.navigate({ route: ROUTE_ID");
		expect(PANEL_SOURCE).toContain("host.ui.openPanel({ panelId: PANEL_ID");
		expect(PANEL_SOURCE).toContain("state.host!.project!.snapshot()");
		expect(PANEL_SOURCE).not.toMatch(/\bfetch\s*\(|location\.hash|window\.location|#\/ext\/|\/api\//);
		expect(PANEL_SOURCE).not.toMatch(/position:\s*absolute[^}]*po-connector/s);
		expect(PANEL_BUNDLE.length).toBeGreaterThan(10_000);
	});

	it("pins the scanner/director responsibilities and build/dev shipping paths", () => {
		expect(SCANNER_ROLE).toContain("team_delegate");
		expect(SCANNER_ROLE).toContain("read_only: true");
		expect(SCANNER_ROLE).toContain("search the Hypothesis Registry");
		expect(SCANNER_ROLE).toContain("seal its coverage record");
		expect(DIRECTOR_ROLE).toContain("propose_goal()");
		expect(DIRECTOR_ROLE).toMatch(/"Proposals": allow/);
		expect(BUILD_SOURCE).toContain('pack: "performance-optimisation"');
		expect(BUILD_SOURCE).toContain('{ in: "performance-panel.ts", out: "lib/performance-panel.js" }');
		expect(COPY_SOURCE).toMatch(/FIRST_PARTY_PACKS\s*=\s*\[[^\]]*"performance-optimisation"/);
		expect(HARNESS_SOURCE).toMatch(/FIRST_PARTY_PACKS\s*=\s*\[[^\]]*"performance-optimisation"/);
	});
});
