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
});
