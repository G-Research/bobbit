/**
 * Draft Preservation stories — CT-02
 *
 * These stories ARE the specification. Each test reads as a behavioral
 * requirement and runs as a Playwright E2E test.
 *
 * Phase annotations control what gets tracked in the spec graph:
 *   setup  → preconditions, incidental navigation (not tracked)
 *   act    → the user actions under test (tracked)
 *   assert → the expected outcomes (tracked)
 *   cleanup → teardown (not tracked)
 */
import { test, expect } from "../gateway-harness.js";
import { waitForHealth } from "../e2e-setup.js";
import {
	SpecContext,
	defineStory,
	getStoryRegistry,
	exportSpecGraph,
	findRelatedStories,
	contractCoverage,
	contractCompleteness,
	clearStoryRegistry,
	clearContractRegistry,
	defineContract,
} from "./spec-framework.js";
import { CT_02, CT_05, CT_13, CT_15 } from "./spec-contracts.js";

test.describe("CT-02: Draft preservation", () => {
	let s: SpecContext;

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page }) => {
		s = new SpecContext(page);
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.open();
	});

	test.afterEach(async () => {
		await s.cleanup();
	});

	// ---------------------------------------------------------------
	// Stories
	// ---------------------------------------------------------------

	test("CT-02-a: Draft survives rapid session switching", async () => {
		s.begin(defineStory({
			id: "CT-02-a",
			title: "Draft survives rapid session switching",
			contracts: [CT_02],
			covers: ["rapid-session-switch"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.type_in(s.editor, "my work in progress");
		await s.wait_for_draft_saved("A", "my work in progress");
		await s.navigate_to("session", "B");
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.contains_text("my work in progress");
		await s.editor.is_focused();
	});

	test.skip("CT-02-b: Draft with attachment survives settings detour", async () => {
		s.begin(defineStory({
			id: "CT-02-b",
			title: "Draft with attachment survives settings detour",
			contracts: [CT_02, CT_13],
			covers: ["settings-detour", "attachment-added"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.attach_file("report.pdf", "file");
		await s.page.waitForTimeout(500);
		await s.type_in(s.editor, "see attached");
		await s.wait_for_draft_saved("A", "see attached");
		await s.navigate_to("settings");
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.contains_text("see attached");
	});

	test("CT-02-c: Draft survives model change", async () => {
		s.begin(defineStory({
			id: "CT-02-c",
			title: "Draft survives model change",
			contracts: [CT_02, CT_15],
			covers: ["model-change"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.type_in(s.editor, "important thought");
		await s.change_setting("model", "claude-opus");

		// assert
		s.assert();
		await s.editor.contains_text("important thought");
	});

	test("CT-02-d: Draft survives page reload", async () => {
		s.begin(defineStory({
			id: "CT-02-d",
			title: "Draft survives page reload",
			contracts: [CT_02, CT_05],
			covers: ["page-reload"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.type_in(s.editor, "unsent draft");
		await s.wait_for_draft_saved("A", "unsent draft");
		await s.reload();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.contains_text("unsent draft");
	});
});

// ---------------------------------------------------------------
// Spec graph analysis
// ---------------------------------------------------------------

test.describe("Spec graph analysis", () => {

	test.beforeEach(() => {
		clearStoryRegistry();
		clearContractRegistry();
	});

	test("defineStory accepts ContractDef objects and normalizes to IDs", () => {
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

		expect(story.contracts).toEqual(["CT-TEST"]);
		expect(story.covers).toEqual(["variation-a"]);
	});

	test("contractCompleteness shows covered and uncovered variations", () => {
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
		expect(results).toHaveLength(1);

		const report = results[0];
		expect(report.contractId).toBe("CT-TEST");
		expect(report.variations).toEqual([
			{ name: "var-a", coveredBy: "S-1" },
			{ name: "var-b", coveredBy: "S-2" },
			{ name: "var-c", coveredBy: null },
		]);
		expect(report.coverage).toBeCloseTo(2 / 3);
	});

	test("contractCompleteness with real CT-02 contract", () => {
		// Import real contract definition
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
		expect(covered).toHaveLength(5);

		// 3 gaps
		const gaps = ct02Report.variations.filter(v => v.coveredBy === null);
		expect(gaps.map(g => g.name).sort()).toEqual([
			"goal-dashboard-detour",
			"personality-change",
			"reconnect-after-disconnect",
		]);
	});

	test("spec graph includes contract definitions", () => {
		defineContract({
			id: "CT-A",
			guarantee: "Test A",
			survives: ["var-1"],
			regions: ["editor"],
			depends_on: [],
		});

		const graph = exportSpecGraph();
		expect(graph.contractDefs["CT-A"]).toBeTruthy();
		expect(graph.contractDefs["CT-A"].guarantee).toBe("Test A");
	});

	test("findRelatedStories ranks by overlap", () => {
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

		expect(related[0].id).toBe("REL-b");
		expect(related[0].overlap).toBeGreaterThan(related[1]?.overlap || 0);
		expect(related.some(r => r.id === "REL-c")).toBe(true);
		expect(related.some(r => r.id === "REL-d")).toBe(false);
	});
});
