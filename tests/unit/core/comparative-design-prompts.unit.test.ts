import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
	buildDefaultWorkflows,
	DESIGN_REVIEW_PROMPT,
	GAP_ANALYSIS_DESIGN_PROMPT,
} from "../../../src/server/state-migration/seed-default-workflows.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function read(relativePath: string): string {
	return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function rolePrompt(relativePath: string): string {
	const role = YAML.parse(read(relativePath)) as { promptTemplate?: string };
	return role.promptTemplate ?? "";
}

function architectPromptFromProjectWorkflow(workflowId: "general" | "feature"): string {
	const project = YAML.parse(read(".bobbit/config/project.yaml")) as {
		workflows: Record<string, { gates: Array<{ id: string; verify?: Array<{ role?: string; prompt?: string }> }> }>;
	};
	const gate = project.workflows[workflowId].gates.find((candidate) => candidate.id === "design-doc");
	const review = gate?.verify?.find((candidate) => candidate.role === "architect");
	return review?.prompt ?? "";
}

describe("comparative design prompt contracts", () => {
	it("instructs every coding agent to prefer simple composition of well-tested code", () => {
		const agents = read("AGENTS.md");
		const coder = rolePrompt("defaults/roles/coder.yaml");

		for (const prompt of [agents, coder]) {
			expect(prompt).toMatch(/defect surface/i);
			expect(prompt).toMatch(/well-tested/i);
			expect(prompt).toMatch(/contracts?.*ownership.*lifecycle/is);
			expect(prompt).toMatch(/do not force reuse|not.*mechanical.*DRY/i);
		}
	});

	it("gives the team lead and coder a bounded, independent exploration protocol", () => {
		const lead = rolePrompt("defaults/roles/team-lead.yaml");
		const coder = rolePrompt("defaults/roles/coder.yaml");

		expect(lead).toMatch(/two independent design explorations/i);
		expect(lead).toMatch(/same (?:goal )?scope/i);
		expect(lead).toMatch(/smallest robust solution/i);
		expect(lead).toMatch(/quick[- ]fix(?:es)?/i);
		expect(coder).toMatch(/design exploration mode/i);
		expect(coder).toMatch(/do not (?:write|edit|modify) production/i);
		expect(coder).toMatch(/exact.*(?:symbols|implementations)/is);
		expect(coder).toMatch(/protecting tests/i);
	});

	it("makes architecture and spec reviewers enforce comparison without expanding scope", () => {
		const architect = rolePrompt("defaults/roles/architect.yaml");
		const auditors = [
			rolePrompt("defaults/roles/spec-auditor.yaml"),
			rolePrompt(".bobbit/config/roles/spec-auditor.yaml"),
		];

		expect(architect).toMatch(/two materially different approaches/i);
		expect(architect).toMatch(/branches?.*state.*transformations?.*APIs/is);
		expect(architect).toMatch(/smallest robust solution/i);
		expect(architect).toMatch(/do not (?:demand|force).*reuse/i);
		for (const auditor of auditors) {
			expect(auditor).toMatch(/same acceptance criteria/i);
			expect(auditor).toMatch(/future reuse.*current scope/i);
		}
	});

	it("pins comparative design in canonical and current project workflows", () => {
		for (const prompt of [
			DESIGN_REVIEW_PROMPT,
			architectPromptFromProjectWorkflow("general"),
			architectPromptFromProjectWorkflow("feature"),
		]) {
			expect(prompt).toMatch(/two materially different approaches/i);
			expect(prompt).toMatch(/well-tested existing (?:code|logic)/i);
			expect(prompt).toMatch(/smallest robust solution/i);
			expect(prompt).toMatch(/do not force reuse/i);
		}
		expect(GAP_ANALYSIS_DESIGN_PROMPT).toMatch(/same acceptance criteria/i);
		expect(GAP_ANALYSIS_DESIGN_PROMPT).toMatch(/scope expansion/i);

		const seeded = buildDefaultWorkflows("app");
		for (const workflowId of ["general", "feature"] as const) {
			const gate = seeded[workflowId].gates.find((candidate) => candidate.id === "design-doc");
			const review = gate?.verify?.find((candidate) => candidate.role === "architect");
			expect(review?.prompt).toBe(DESIGN_REVIEW_PROMPT);
		}
	});

	it("documents comparative design as the authoring default rather than a project-only exception", () => {
		const guide = read("defaults/workflow-authoring-guide.md");
		expect(guide).toMatch(/comparative design gates/i);
		expect(guide).toMatch(/two independent approaches/i);
		expect(guide).toMatch(/defect surface/i);
		expect(guide).toMatch(/quick-fix/i);
	});
});
