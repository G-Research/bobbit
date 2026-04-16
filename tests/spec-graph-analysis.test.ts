/**
 * Spec graph analysis — pure-logic unit tests.
 *
 * Extracted from E2E stories-*.spec.ts files. These tests exercise
 * defineStory, defineContract, contractCompleteness, exportSpecGraph,
 * and findRelatedStories — all pure in-memory logic, no browser needed.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
	defineStory,
	defineContract,
	exportSpecGraph,
	findRelatedStories,
	contractCompleteness,
	clearStoryRegistry,
	clearContractRegistry,
} from "./e2e/ui/spec-framework.ts";
import { CT_03, CT_04, CT_13 } from "./e2e/ui/spec-contracts.ts";

// ── From stories-drafts.spec.ts ──

describe("Spec graph analysis (CT-02 drafts)", () => {

	beforeEach(() => {
		clearStoryRegistry();
		clearContractRegistry();
	});

	it("defineStory accepts ContractDef objects and normalizes to IDs", () => {
		const ct = defineContract({
			id: "CT-TEST",
			guarantee: "Test guarantee",
			survives: ["variation-a", "variation-b"],
			regions: ["editor"],
			depends_on: [],
		});

		const story = defineStory({
			id: "T-01",
			title: "Test story",
			contracts: [ct],
			covers: ["variation-a"],
		});

		assert.deepEqual(story.contracts, ["CT-TEST"]);
		assert.deepEqual(story.covers, ["variation-a"]);
	});

	it("contractCompleteness shows covered and uncovered variations", () => {
		const ct = defineContract({
			id: "CT-TEST",
			guarantee: "Test guarantee",
			survives: ["var-a", "var-b", "var-c"],
			regions: ["editor"],
			depends_on: [],
		});

		defineStory({ id: "S-1", title: "Covers A", contracts: [ct], covers: ["var-a"] });
		defineStory({ id: "S-2", title: "Covers B", contracts: [ct], covers: ["var-b"] });

		const results = contractCompleteness();
		assert.equal(results.length, 1);

		const report = results[0];
		assert.equal(report.contractId, "CT-TEST");
		assert.deepEqual(report.variations, [
			{ name: "var-a", coveredBy: "S-1" },
			{ name: "var-b", coveredBy: "S-2" },
			{ name: "var-c", coveredBy: null },
		]);
		assert.ok(Math.abs(report.coverage - 2 / 3) < 0.01);
	});

	it("contractCompleteness with real CT-02 contract", () => {
		const ct02 = defineContract({
			id: "CT-02",
			guarantee: "Session switch preserves drafts and context",
			survives: [
				"rapid-session-switch", "settings-detour", "model-change",
				"page-reload", "goal-dashboard-detour", "attachment-added",
				"personality-change", "reconnect-after-disconnect",
			],
			regions: ["editor", "context_bar"],
			depends_on: ["CT-05"],
		});

		defineStory({ id: "CT-02-a", title: "Rapid switch", contracts: [ct02], covers: ["rapid-session-switch"] });
		defineStory({ id: "CT-02-b", title: "Settings detour", contracts: [ct02], covers: ["settings-detour", "attachment-added"] });
		defineStory({ id: "CT-02-c", title: "Model change", contracts: [ct02], covers: ["model-change"] });
		defineStory({ id: "CT-02-d", title: "Reload", contracts: [ct02], covers: ["page-reload"] });

		const results = contractCompleteness();
		const ct02Report = results.find(r => r.contractId === "CT-02")!;

		// 5 variations covered (settings-detour + attachment-added from same story)
		const covered = ct02Report.variations.filter(v => v.coveredBy !== null);
		assert.equal(covered.length, 5);

		// 3 gaps
		const gaps = ct02Report.variations.filter(v => v.coveredBy === null);
		assert.deepEqual(gaps.map(g => g.name).sort(), [
			"goal-dashboard-detour",
			"personality-change",
			"reconnect-after-disconnect",
		]);
	});

	it("spec graph includes contract definitions", () => {
		defineContract({
			id: "CT-A",
			guarantee: "Test A",
			survives: ["var-1"],
			regions: ["editor"],
			depends_on: [],
		});

		const graph = exportSpecGraph();
		assert.ok(graph.contractDefs["CT-A"]);
		assert.equal(graph.contractDefs["CT-A"].guarantee, "Test A");
	});

	it("findRelatedStories ranks by overlap", () => {
		const a = defineStory({ id: "REL-a", title: "A", contracts: ["CT-02"] });
		a.regions = ["editor", "sidebar"];
		a.intents = ["type_in", "navigate_to_session"];

		const b = defineStory({ id: "REL-b", title: "B", contracts: ["CT-02"] });
		b.regions = ["editor", "sidebar"];
		b.intents = ["type_in", "navigate_to_session"];

		const c = defineStory({ id: "REL-c", title: "C", contracts: ["CT-02"] });
		c.regions = ["editor"];
		c.intents = ["reload"];

		const d = defineStory({ id: "REL-d", title: "D", contracts: ["CT-13"] });
		d.regions = ["settings"];
		d.intents = ["navigate_to_settings"];

		const related = findRelatedStories("REL-a");

		assert.equal(related[0].id, "REL-b");
		assert.ok(related[0].overlap > (related[1]?.overlap || 0));
		assert.ok(related.some(r => r.id === "REL-c"));
		assert.ok(!related.some(r => r.id === "REL-d"));
	});
});

// ── From stories-sidebar.spec.ts ──

describe("Spec graph analysis (sidebar)", () => {

	beforeEach(() => {
		clearStoryRegistry();
		clearContractRegistry();
		defineContract(CT_03);
		defineContract(CT_04);
	});

	it("spec graph dump for sidebar stories", () => {
		defineStory({ id: "SB-01", title: "Project sections collapse persistence", contracts: [CT_03], covers: ["page-reload"] });
		defineStory({ id: "SB-02", title: "Goal team nesting expand/collapse", contracts: [CT_03], covers: ["collapsed-tree-expansion"] });
		defineStory({ id: "SB-03", title: "Auto-expand parent on deep link", contracts: [CT_03], covers: ["deep-link-navigation", "collapsed-tree-expansion"] });
		defineStory({ id: "SB-06", title: "Idle time display on session rows", contracts: [CT_04], covers: ["page-reload"] });
		defineStory({ id: "SB-09", title: "Goal gate progress badge", contracts: [CT_04], covers: ["page-reload"] });
		defineStory({ id: "SB-12", title: "Completed goal rendering", contracts: [CT_04], covers: ["page-reload"] });
		defineStory({ id: "SB-24", title: "Filter sidebar by typing", contracts: [CT_03], covers: ["page-reload"] });
		defineStory({ id: "SB-27", title: "Show archived toggle", contracts: [CT_03, CT_04], covers: ["page-reload"] });
		defineStory({ id: "SB-32", title: "Collapsed sidebar icon-only mode", contracts: [CT_03], covers: ["page-reload"] });
		defineStory({ id: "SB-34", title: "Sidebar keyboard shortcuts", contracts: [CT_03], covers: ["deep-link-navigation"] });
		defineStory({ id: "CT-03-sidebar-highlight", title: "Session highlight follows navigation", contracts: [CT_03], covers: ["deep-link-navigation", "back-forward-navigation"] });
		defineStory({ id: "SB-concurrent-agents", title: "Sidebar reflects multiple concurrent sessions", contracts: [CT_04], covers: ["concurrent-agents"] });

		const graph = exportSpecGraph();

		// CT-03 should have stories
		assert.ok(graph.contracts["CT-03"]);
		assert.ok(graph.contracts["CT-03"].stories.length >= 7);

		// CT-04 should have stories
		assert.ok(graph.contracts["CT-04"]);
		assert.ok(graph.contracts["CT-04"].stories.length >= 4);

		// Check coverage completeness
		const completeness = contractCompleteness();

		const ct03 = completeness.find(c => c.contractId === "CT-03");
		assert.ok(ct03);
		// CT-03 variations: deep-link-navigation, back-forward-navigation, page-reload, collapsed-tree-expansion
		assert.equal(ct03!.coverage, 1);

		const ct04 = completeness.find(c => c.contractId === "CT-04");
		assert.ok(ct04);
		// CT-04 variations: page-reload, concurrent-agents covered; agent-crash-restart not covered
		const ct04Covered = ct04!.variations.filter(v => v.coveredBy !== null);
		assert.ok(ct04Covered.length >= 2);
	});
});

// ── From stories-navigation.spec.ts ──

describe("Spec graph analysis (navigation CT-13)", () => {

	beforeEach(() => {
		clearStoryRegistry();
		clearContractRegistry();
		defineContract(CT_13);
	});

	it("CT-13 coverage from navigation stories", () => {
		const ct13 = CT_13;

		defineStory({ id: "N-01", title: "Sidebar session selection", contracts: [ct13], covers: ["view-transitions", "page-reload"] });
		defineStory({ id: "N-02", title: "Goal dashboard nav and back", contracts: [ct13], covers: ["back-forward-navigation"] });
		defineStory({ id: "N-03", title: "Deep links to all view types", contracts: [ct13], covers: ["bookmarks"] });
		defineStory({ id: "N-04", title: "Browser back and forward", contracts: [ct13], covers: ["back-forward-navigation"] });
		defineStory({ id: "N-06", title: "Sidebar collapse persistence", contracts: [ct13], covers: ["page-reload"] });
		defineStory({ id: "N-07", title: "Page title", contracts: [ct13], covers: ["page-reload"] });
		defineStory({ id: "N-08", title: "Keyboard shortcuts", contracts: [ct13], covers: ["view-transitions"] });
		defineStory({ id: "N-09", title: "Cross-feature journey", contracts: [ct13], covers: ["view-transitions", "back-forward-navigation"] });
		defineStory({ id: "N-10", title: "Settings sub-navigation", contracts: [ct13], covers: ["view-transitions", "bookmarks"] });

		const results = contractCompleteness();
		const ct13Report = results.find(r => r.contractId === "CT-13")!;

		assert.ok(ct13Report);

		// All 4 CT-13 variations should be covered
		const covered = ct13Report.variations.filter(v => v.coveredBy !== null);
		assert.equal(covered.length, 4);

		// 100% coverage
		assert.equal(ct13Report.coverage, 1);

		const graph = exportSpecGraph();
		assert.equal(Object.keys(graph.stories).length, 9);
		assert.equal(graph.contracts["CT-13"].stories.length, 9);
	});
});
