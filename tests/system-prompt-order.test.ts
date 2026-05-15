/**
 * Regression tests pinning the **stable prompt prefix** order.
 *
 * The system prompt is assembled with stable sections (tool docs, skills
 * catalog) BEFORE volatile sections (goal, role, task, workflow context)
 * so the prefix is reusable by provider-side prompt caches across team
 * spawns and turn-to-turn changes within the same project.
 *
 * If you find yourself flipping these assertions back to the old order
 * (tool docs after goal), STOP — you are reintroducing the regression
 * fixed by the "Stable Prompt Prefix" goal. The whole point is that
 * volatile content sits AFTER stable content.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "system-prompt-order-"));
const stateDir = path.join(tmpRoot, "state");
const promptsDir = path.join(stateDir, "session-prompts");
fs.mkdirSync(promptsDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const {
	assembleSystemPrompt,
	getPromptSections,
	initPromptDirs,
} = await import("../src/server/agent/system-prompt.ts");

initPromptDirs(stateDir);

let cwdDir: string;

function setup() {
	cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-order-cwd-"));
}

function cleanup() {
	try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Common parts that exercise every optional section. */
function fullParts(overrides: Record<string, unknown> = {}) {
	return {
		cwd: cwdDir,
		goalTitle: "My Goal",
		goalState: "in-progress",
		goalSpec: "Build the thing.",
		rolePrompt: "You are a Test Engineer.",
		roleName: "test-engineer",
		taskTitle: "Pin order",
		taskType: "testing",
		taskSpec: "Add regression tests.",
		toolDocs: "# Tools\n\n## Shell\n- bash — Run commands.",
		skillsCatalog: [
			{ name: "commit", description: "Stage and commit changes." },
			{ name: "html", description: "Build an HTML preview." },
		],
		workflowContext: "# Upstream Gates\n\nDesign doc says reorder.",
		...overrides,
	} as Parameters<typeof assembleSystemPrompt>[1];
}

describe("assembleSystemPrompt — stable prefix ordering", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("tool docs appear BEFORE the goal section", () => {
		const p = assembleSystemPrompt("order-tools-before-goal", fullParts());
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		const toolsIdx = content.indexOf("# Tools");
		const goalIdx = content.indexOf("# Goal");
		assert.ok(toolsIdx >= 0, "expected `# Tools` to be present");
		assert.ok(goalIdx >= 0, "expected `# Goal` to be present");
		assert.ok(
			toolsIdx < goalIdx,
			`Tool docs must precede the Goal section so the stable prefix is cache-reusable.\n` +
			`Got toolsIdx=${toolsIdx}, goalIdx=${goalIdx}.\n--- prompt ---\n${content}`,
		);
	});

	it("Available Skills appears BEFORE the goal section", () => {
		const p = assembleSystemPrompt("order-skills-before-goal", fullParts());
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		const skillsIdx = content.indexOf("## Available Skills");
		const goalIdx = content.indexOf("# Goal");
		assert.ok(skillsIdx >= 0, "expected `## Available Skills` to be present");
		assert.ok(goalIdx >= 0, "expected `# Goal` to be present");
		assert.ok(
			skillsIdx < goalIdx,
			`Available Skills must precede the Goal section so the stable prefix is cache-reusable.\n` +
			`Got skillsIdx=${skillsIdx}, goalIdx=${goalIdx}.\n--- prompt ---\n${content}`,
		);
	});

	it("Working Directory appears before tool docs (stable infra header)", () => {
		const p = assembleSystemPrompt("order-cwd-before-tools", fullParts());
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		const cwdIdx = content.indexOf("# Working Directory");
		const toolsIdx = content.indexOf("# Tools");
		assert.ok(cwdIdx >= 0 && toolsIdx >= 0);
		assert.ok(cwdIdx < toolsIdx, "Working Directory should precede Tools");
	});

	it("Current Task appears AFTER the goal section (volatile tail)", () => {
		const p = assembleSystemPrompt("order-task-after-goal", fullParts());
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		const goalIdx = content.indexOf("# Goal");
		const taskIdx = content.indexOf("# Current Task");
		assert.ok(goalIdx >= 0 && taskIdx >= 0);
		assert.ok(goalIdx < taskIdx, "Goal should precede Current Task");
	});

	it("Workflow Context appears AFTER goal and task (most volatile tail)", () => {
		const p = assembleSystemPrompt("order-workflow-last", fullParts());
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		const goalIdx = content.indexOf("# Goal");
		const taskIdx = content.indexOf("# Current Task");
		const wfIdx = content.indexOf("# Upstream Gates");
		assert.ok(goalIdx >= 0 && taskIdx >= 0 && wfIdx >= 0);
		assert.ok(goalIdx < wfIdx, "Goal should precede Upstream Gates");
		assert.ok(taskIdx < wfIdx, "Task should precede Upstream Gates");
	});

	it("full stable→volatile order: cwd < tools < skills < goal < task < workflow", () => {
		const p = assembleSystemPrompt("order-full", fullParts());
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		const positions: [string, number][] = [
			["# Working Directory", content.indexOf("# Working Directory")],
			["# Tools", content.indexOf("# Tools")],
			["## Available Skills", content.indexOf("## Available Skills")],
			["# Goal", content.indexOf("# Goal")],
			["# Current Task", content.indexOf("# Current Task")],
			["# Upstream Gates", content.indexOf("# Upstream Gates")],
		];
		for (const [label, idx] of positions) {
			assert.ok(idx >= 0, `section ${label} missing from assembled prompt`);
		}
		for (let i = 1; i < positions.length; i++) {
			const [prev, prevIdx] = positions[i - 1];
			const [cur, curIdx] = positions[i];
			assert.ok(
				prevIdx < curIdx,
				`Order violation: '${prev}' (@${prevIdx}) must precede '${cur}' (@${curIdx}). Full order:\n${
					positions.map(([l, i]) => `  ${i.toString().padStart(6)}  ${l}`).join("\n")
				}`,
			);
		}
	});

	it("tool docs still precede goal when skills catalog is absent", () => {
		const parts = fullParts({ skillsCatalog: undefined });
		const p = assembleSystemPrompt("order-no-skills", parts);
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		assert.ok(content.indexOf("# Tools") < content.indexOf("# Goal"));
		assert.ok(!content.includes("## Available Skills"));
	});

	it("skills catalog still precedes goal when tool docs are absent", () => {
		const parts = fullParts({ toolDocs: undefined });
		const p = assembleSystemPrompt("order-no-tools", parts);
		assert.ok(p);
		const content = fs.readFileSync(p, "utf-8");
		assert.ok(content.indexOf("## Available Skills") < content.indexOf("# Goal"));
		assert.ok(!content.includes("# Tools"));
	});
});

describe("getPromptSections — inspector label ordering", () => {
	beforeEach(setup);
	afterEach(cleanup);

	function indexOfLabel(sections: { label: string }[], label: string): number {
		return sections.findIndex(s => s.label === label);
	}

	it("Tools and Available Skills appear before Goal", () => {
		const sections = getPromptSections(fullParts());
		const toolsIdx = indexOfLabel(sections, "Tools");
		const skillsIdx = indexOfLabel(sections, "Available Skills");
		const goalIdx = indexOfLabel(sections, "Goal");
		assert.ok(toolsIdx >= 0, "Tools section missing");
		assert.ok(skillsIdx >= 0, "Available Skills section missing");
		assert.ok(goalIdx >= 0, "Goal section missing");
		assert.ok(
			toolsIdx < goalIdx,
			`Tools (@${toolsIdx}) must precede Goal (@${goalIdx}). Labels: ${sections.map(s => s.label).join(" | ")}`,
		);
		assert.ok(
			skillsIdx < goalIdx,
			`Available Skills (@${skillsIdx}) must precede Goal (@${goalIdx}). Labels: ${sections.map(s => s.label).join(" | ")}`,
		);
	});

	it("Tools and Available Skills appear before Role", () => {
		const sections = getPromptSections(fullParts());
		const toolsIdx = indexOfLabel(sections, "Tools");
		const skillsIdx = indexOfLabel(sections, "Available Skills");
		const roleIdx = indexOfLabel(sections, "Role");
		assert.ok(roleIdx >= 0, "Role section missing");
		assert.ok(toolsIdx < roleIdx, "Tools must precede Role");
		assert.ok(skillsIdx < roleIdx, "Available Skills must precede Role");
	});

	it("Working Directory precedes Tools (stable infra header)", () => {
		const sections = getPromptSections(fullParts());
		const cwdIdx = indexOfLabel(sections, "Working Directory");
		const toolsIdx = indexOfLabel(sections, "Tools");
		assert.ok(cwdIdx >= 0, "Working Directory missing");
		assert.ok(cwdIdx < toolsIdx, "Working Directory should precede Tools");
	});

	it("Goal precedes Task and Workflow Context", () => {
		const sections = getPromptSections(fullParts());
		const goalIdx = indexOfLabel(sections, "Goal");
		const taskIdx = indexOfLabel(sections, "Task");
		const wfIdx = indexOfLabel(sections, "Workflow Context");
		assert.ok(taskIdx >= 0, "Task section missing");
		assert.ok(wfIdx >= 0, "Workflow Context section missing");
		assert.ok(goalIdx < taskIdx, "Goal should precede Task");
		assert.ok(goalIdx < wfIdx, "Goal should precede Workflow Context");
		assert.ok(taskIdx < wfIdx, "Task should precede Workflow Context");
	});

	it("full inspector order: Working Directory < Tools < Available Skills < Goal < Role < Task < Workflow Context", () => {
		const sections = getPromptSections(fullParts());
		const labels = ["Working Directory", "Tools", "Available Skills", "Goal", "Role", "Task", "Workflow Context"];
		const positions = labels.map(l => [l, indexOfLabel(sections, l)] as [string, number]);
		for (const [label, idx] of positions) {
			assert.ok(idx >= 0, `inspector section '${label}' missing. Actual labels: ${sections.map(s => s.label).join(" | ")}`);
		}
		for (let i = 1; i < positions.length; i++) {
			const [prev, prevIdx] = positions[i - 1];
			const [cur, curIdx] = positions[i];
			assert.ok(
				prevIdx < curIdx,
				`Order violation: '${prev}' (@${prevIdx}) must precede '${cur}' (@${curIdx}). Actual labels in order:\n  ${sections.map(s => s.label).join("\n  ")}`,
			);
		}
	});
});
