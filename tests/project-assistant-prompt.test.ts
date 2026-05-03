import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	PROJECT_ASSISTANT_PROMPT,
	PROJECT_ASSISTANT_SCAFFOLDING_PROMPT,
} from "../src/server/agent/project-assistant.ts";

// Sentinel from defaults/workflow-authoring-guide.md §1.
const GUIDE_SENTINEL = "multi-repo invariant";

describe("project-assistant prompts", () => {
	it("PROJECT_ASSISTANT_PROMPT inlines the workflow authoring guide", () => {
		assert.match(PROJECT_ASSISTANT_PROMPT, new RegExp(GUIDE_SENTINEL));
	});

	it("PROJECT_ASSISTANT_SCAFFOLDING_PROMPT inlines the workflow authoring guide", () => {
		assert.match(PROJECT_ASSISTANT_SCAFFOLDING_PROMPT, new RegExp(GUIDE_SENTINEL));
	});

	it("both prompts include the checklist-flow section", () => {
		for (const p of [PROJECT_ASSISTANT_PROMPT, PROJECT_ASSISTANT_SCAFFOLDING_PROMPT]) {
			assert.ok(p.includes("Proposing workflows: the checklist flow"));
			assert.ok(p.includes("All-components"));
			assert.ok(p.includes("Per-component"));
		}
	});

	it("both prompts include the Ralph-loop framing", () => {
		for (const p of [PROJECT_ASSISTANT_PROMPT, PROJECT_ASSISTANT_SCAFFOLDING_PROMPT]) {
			assert.ok(p.includes("Ralph loop"));
		}
	});

	it("both prompts mention the live-update panel", () => {
		for (const p of [PROJECT_ASSISTANT_PROMPT, PROJECT_ASSISTANT_SCAFFOLDING_PROMPT]) {
			assert.ok(p.includes("proposal panel updates live") || p.includes("immediately re-renders"));
		}
	});

	it("both prompts mandate ending coding workflows with a ready-to-merge / Raise PR gate", () => {
		for (const p of [PROJECT_ASSISTANT_PROMPT, PROJECT_ASSISTANT_SCAFFOLDING_PROMPT]) {
			assert.ok(p.includes("Raise PR") || p.includes("ready-to-merge"),
				"prompt must mention Raise-PR / ready-to-merge gate");
			assert.ok(p.includes("gh pr list"),
				"prompt must include the canonical gh pr verify step");
			assert.ok(p.includes("gh") && (p.includes("detect") || p.includes("Check for")),
				"prompt must instruct the assistant to detect gh during exploration");
		}
	});

	it("PROJECT_ASSISTANT_PROMPT explains edit mode for already-registered projects", () => {
		// New first-message router branch: when opened against a registered
		// project, the assistant reads the existing project.yaml and re-proposes
		// it as-is before asking what to change.
		assert.ok(PROJECT_ASSISTANT_PROMPT.includes("Edit the existing project"),
			"prompt must include the edit-mode opener literal");
		assert.ok(PROJECT_ASSISTANT_PROMPT.includes(".bobbit/config/project.yaml"),
			"prompt must instruct the assistant to read project.yaml");
		assert.ok(PROJECT_ASSISTANT_PROMPT.includes("propose it back as-is") ||
			PROJECT_ASSISTANT_PROMPT.includes("propose_project` immediately with the **current**"),
			"prompt must instruct the assistant to re-propose verbatim before asking for changes");
		assert.ok(/Do not re-run.*discovery|Do not re-run.*exploration/.test(PROJECT_ASSISTANT_PROMPT),
			"prompt must tell the assistant to skip discovery in edit mode");
	});
});
