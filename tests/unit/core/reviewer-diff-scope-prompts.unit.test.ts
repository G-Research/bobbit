import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const REVIEWER_ROLE_FILES = [
	"defaults/roles/reviewer.yaml",
	"defaults/roles/code-reviewer.yaml",
	"defaults/roles/bug-hunter.yaml",
	"defaults/roles/security-reviewer.yaml",
	"defaults/roles/systems-reviewer.yaml",
	"defaults/roles/architect.yaml",
	"defaults/roles/spec-auditor.yaml",
	"market-packs/pr-walkthrough/roles/pr-reviewer.yaml",
];

function loadPrompt(relativePath: string): string {
	const role = YAML.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as { promptTemplate?: string };
	return role.promptTemplate ?? "";
}

describe("reviewer change-scope prompts", () => {
	for (const roleFile of REVIEWER_ROLE_FILES) {
		it(`${roleFile} limits findings to issues caused or worsened by the reviewed change`, () => {
			const prompt = loadPrompt(roleFile);
			expect(prompt).toMatch(/only raise findings caused by the reviewed change/i);
			expect(prompt).toMatch(/introduces the issue or makes a pre-existing issue materially worse/i);
			expect(prompt).toMatch(/do not report pre-existing issues that are unchanged/i);
			expect(prompt).toMatch(/do not ask this goal or PR to fix them/i);
		});
	}
});
