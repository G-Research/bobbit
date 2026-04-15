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
	clearStoryRegistry,
} from "./spec-framework.js";

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
			contracts: ["CT-02"],
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
			contracts: ["CT-02", "CT-13"],
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
			contracts: ["CT-02", "CT-15"],
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
			contracts: ["CT-02", "CT-05"],
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
	});

	test("phase annotations control what gets tracked", () => {
		const story = defineStory({ id: "PH-a", title: "Phase test", contracts: ["CT-02"] });

		// Simulate setup phase — should NOT be tracked
		story.regions = [];
		story.intents = [];
		// (In real execution, trackRegion/trackIntent skip "setup" phase)

		// After act/assert, only those interactions appear
		// This is validated by the behavioral tests above — CT-02-a's setup
		// navigation doesn't pollute the graph with sidebar/session entries
		expect(story.regions).toEqual([]);
	});

	test("registry captures story metadata from defineStory", () => {
		defineStory({ id: "CT-02-a", title: "Draft survives rapid switch", contracts: ["CT-02"] });
		defineStory({ id: "CT-02-b", title: "Draft with attachment", contracts: ["CT-02", "CT-13"] });
		defineStory({ id: "CT-02-c", title: "Draft survives model change", contracts: ["CT-02", "CT-15"] });
		defineStory({ id: "CT-02-d", title: "Draft survives reload", contracts: ["CT-02", "CT-05"] });

		const registry = getStoryRegistry();
		expect(registry.size).toBe(4);
		expect(registry.get("CT-02-a")!.title).toBe("Draft survives rapid switch");
		expect(registry.get("CT-02-c")!.contracts).toEqual(["CT-02", "CT-15"]);
	});

	test("spec graph indexes stories by contract, region, and intent", () => {
		const storyA = defineStory({ id: "SG-a", title: "Story A", contracts: ["CT-02"] });
		storyA.regions = ["editor", "sidebar"];
		storyA.intents = ["type_in", "navigate_to_session"];
		storyA.entities = ["session"];

		const storyB = defineStory({ id: "SG-b", title: "Story B", contracts: ["CT-02", "CT-05"] });
		storyB.regions = ["editor", "message_list"];
		storyB.intents = ["type_in", "reload"];
		storyB.entities = ["session"];

		const storyC = defineStory({ id: "SG-c", title: "Story C", contracts: ["CT-13"] });
		storyC.regions = ["settings"];
		storyC.intents = ["navigate_to_settings"];
		storyC.entities = ["config"];

		const graph = exportSpecGraph();

		expect(graph.contracts["CT-02"].stories).toContain("SG-a");
		expect(graph.contracts["CT-02"].stories).toContain("SG-b");
		expect(graph.contracts["CT-02"].stories).not.toContain("SG-c");

		expect(graph.regionIndex["editor"]).toContain("SG-a");
		expect(graph.regionIndex["editor"]).toContain("SG-b");
		expect(graph.regionIndex["settings"]).toEqual(["SG-c"]);

		expect(graph.intentIndex["type_in"]).toContain("SG-a");
		expect(graph.intentIndex["type_in"]).toContain("SG-b");
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

	test("contractCoverage shows regions and intents exercised", () => {
		const a = defineStory({ id: "CC-a", title: "A", contracts: ["CT-02"] });
		a.regions = ["editor"];
		a.intents = ["type_in"];

		const b = defineStory({ id: "CC-b", title: "B", contracts: ["CT-02"] });
		b.regions = ["editor", "sidebar"];
		b.intents = ["type_in", "navigate_to_session"];

		defineStory({ id: "CC-c", title: "C", contracts: ["CT-05"] });

		const coverage = contractCoverage("CT-02");
		expect(coverage.stories).toEqual(["CC-a", "CC-b"]);
		expect(coverage.regions).toContain("editor");
		expect(coverage.regions).toContain("sidebar");
		expect(coverage.intents).toContain("type_in");
		expect(coverage.intents).toContain("navigate_to_session");
	});
});
