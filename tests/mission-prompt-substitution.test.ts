/**
 * Unit tests for mission-aware prompt substitutions.
 *
 * Bug regression: restoreSession's role-prompt rebuild only substituted
 * {{GOAL_BRANCH}}, {{AGENT_ID}}, {{AVAILABLE_ROLES}}. Mission Commanders
 * came back from a server restart with literal `{{MISSION_TITLE}}` text in
 * their resolved system prompt.
 *
 * applyMissionPromptSubstitutions centralises the five mission placeholders
 * so the initial-spawn site (server.ts) and restart sites (session-manager.ts)
 * never drift.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyMissionPromptSubstitutions } from "../src/server/agent/mission-prompt.js";
import type { PersistedMission } from "../src/server/agent/mission-store.js";

function makeMission(overrides: Partial<PersistedMission> = {}): PersistedMission {
	return {
		id: "mission-9767b934",
		projectId: "proj-1",
		projects: ["proj-1"],
		title: "Unified Memory v1",
		spec: "spec body",
		state: "in-progress",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		workflowId: "mission",
		divergencePolicy: "strict",
		maxConcurrentGoals: 3,
		integrationBranch: "mission/unified-memory-v1-9767b934",
		...overrides,
	};
}

describe("applyMissionPromptSubstitutions", () => {
	it("returns the template unchanged when mission is undefined", () => {
		const tpl = "Hello {{MISSION_TITLE}} and {{INTEGRATION_BRANCH}}";
		const out = applyMissionPromptSubstitutions(tpl, undefined);
		assert.equal(out, tpl);
	});

	it("substitutes all five mission placeholders", () => {
		const tpl = [
			"Mission: {{MISSION_TITLE}}",
			"Branch: {{INTEGRATION_BRANCH}}",
			"Concurrency: {{MAX_CONCURRENT_GOALS}}",
			"Id: {{MISSION_ID}}",
			"Review:{{REVIEW_CONTEXT}}END",
		].join("\n");
		const out = applyMissionPromptSubstitutions(tpl, makeMission());
		assert.equal(out, [
			"Mission: Unified Memory v1",
			"Branch: mission/unified-memory-v1-9767b934",
			"Concurrency: 3",
			"Id: mission-9767b934",
			"Review:END",
		].join("\n"));
		// And no literal placeholder survives.
		assert.ok(!/\{\{MISSION_TITLE\}\}/.test(out));
		assert.ok(!/\{\{INTEGRATION_BRANCH\}\}/.test(out));
		assert.ok(!/\{\{MAX_CONCURRENT_GOALS\}\}/.test(out));
		assert.ok(!/\{\{MISSION_ID\}\}/.test(out));
		assert.ok(!/\{\{REVIEW_CONTEXT\}\}/.test(out));
	});

	it("replaces every occurrence (global), not just the first", () => {
		const tpl = "{{MISSION_TITLE}} and again {{MISSION_TITLE}}";
		const out = applyMissionPromptSubstitutions(tpl, makeMission({ title: "Spec X" }));
		assert.equal(out, "Spec X and again Spec X");
	});

	it("substitutes empty integrationBranch as empty string (not undefined)", () => {
		const tpl = "Branch=[{{INTEGRATION_BRANCH}}]";
		const out = applyMissionPromptSubstitutions(tpl, makeMission({ integrationBranch: undefined }));
		assert.equal(out, "Branch=[]");
	});

	it("does not touch other placeholders ({{AGENT_ID}}, {{GOAL_BRANCH}}, {{AVAILABLE_ROLES}})", () => {
		const tpl = "{{AGENT_ID}} {{GOAL_BRANCH}} {{AVAILABLE_ROLES}} {{MISSION_TITLE}}";
		const out = applyMissionPromptSubstitutions(tpl, makeMission({ title: "T" }));
		assert.equal(out, "{{AGENT_ID}} {{GOAL_BRANCH}} {{AVAILABLE_ROLES}} T");
	});

	it("handles a real Commander template with all placeholders", () => {
		const tpl = [
			"You are the **Commander** (id: {{AGENT_ID}}) running mission \"{{MISSION_TITLE}}\".",
			"",
			"Integration branch: `{{INTEGRATION_BRANCH}}`",
			"Max concurrent goals: {{MAX_CONCURRENT_GOALS}}",
			"Mission id: {{MISSION_ID}}",
			"",
			"{{REVIEW_CONTEXT}}",
		].join("\n");
		const out = applyMissionPromptSubstitutions(tpl, makeMission());
		// Mission placeholders resolved.
		assert.ok(out.includes("Unified Memory v1"));
		assert.ok(out.includes("mission/unified-memory-v1-9767b934"));
		assert.ok(out.includes("Max concurrent goals: 3"));
		assert.ok(out.includes("Mission id: mission-9767b934"));
		// Generic placeholder preserved for the caller.
		assert.ok(out.includes("{{AGENT_ID}}"));
		// REVIEW_CONTEXT becomes empty string (line still there but blank).
		assert.ok(!/\{\{REVIEW_CONTEXT\}\}/.test(out));
		// No mission placeholders remain.
		const missionPlaceholderRe = /\{\{(MISSION_TITLE|INTEGRATION_BRANCH|MAX_CONCURRENT_GOALS|MISSION_ID|REVIEW_CONTEXT)\}\}/;
		assert.ok(!missionPlaceholderRe.test(out), `unresolved placeholder remains in: ${out}`);
	});
});
