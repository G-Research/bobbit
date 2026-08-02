import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const REVIEWER_ROLES = [
	"architect",
	"reviewer",
	"code-reviewer",
	"bug-hunter",
	"verifiable-bug-hunter",
	"security-reviewer",
	"spec-auditor",
	"systems-reviewer",
] as const;

type Role = { name?: string; promptTemplate?: string };

function promptFor(roleName: string): string {
	const file = path.join(repoRoot, "defaults", "roles", `${roleName}.yaml`);
	const role = YAML.parse(fs.readFileSync(file, "utf8")) as Role;
	expect(role.name).toBe(roleName);
	expect(role.promptTemplate, `${roleName} must have a role prompt`).toEqual(expect.any(String));
	return role.promptTemplate!;
}

function expectPromptPolicy(prompt: string, roleName: string): void {
	const message = `${roleName} must preserve review-convergence policy`;

	// Scope and decision authority.
	expect(prompt, message).toMatch(/goal spec(?:ification)?(?: and)? explicit user amendments? (?:are|remain) authoritative/i);
	expect(prompt, message).toMatch(/reviewer suggestions?.{0,80}(?:do not|must not|never).{0,80}(?:become|create).{0,80}requirements?/i);
	expect(prompt, message).toMatch(/(?:classify|classification).{0,120}blockers?.{0,120}bounded improvements?.{0,120}(?:out.of.scope|pre.existing)/i);
	expect(prompt, message).toMatch(/fail only.{0,120}(?:explicit(?:ly)? unmet requirements?|concrete regressions?)/i);

	// A failing finding must be implementable, rather than an unbounded critique.
	expect(prompt, message).toMatch(/(?:exact|specific).{0,80}(?:files?|symbols?)/i);
	expect(prompt, message).toMatch(/causal (?:path|chain).{0,80}trigger|trigger.{0,80}causal (?:path|chain)/i);
	expect(prompt, message).toMatch(/minimal.{0,100}(?:control.?flow|data.?flow).{0,100}(?:remediation|fix)/i);
	expect(prompt, message).toMatch(/(?:compatibility|lifecycle).{0,100}(?:constraints?|requirements?)/i);
	expect(prompt, message).toMatch(/focused tests?/i);
	expect(prompt, message).toMatch(/(?:deduplicat|consolidat).{0,100}root causes?/i);

	// Re-reviews should converge instead of repeatedly expanding the goal.
	expect(prompt, message).toMatch(/re.review.{0,160}(?:only|may only).{0,160}(?:unresolved (?:prior )?blockers?|revision.introduced regressions?)/i);
	expect(prompt, message).toMatch(/(?:previously discoverable|new demands?).{0,100}(?:non.blocking|not blocking)/i);
	expect(prompt, message).toMatch(/(?:critical data.loss|exploitable security)/i);
	expect(prompt, message).toMatch(/default to PASS.{0,100}explicit requirements? (?:are|is) met/i);
	expect(prompt, message).toMatch(/(?:at most|maximum|cap).{0,80}(?:three|3).{0,80}root.cause blockers?/i);
	expect(prompt, message).toMatch(/PASS.{0,20}0 blockers?/i);
	expect(prompt, message).toMatch(/FAIL.{0,20}(?:N|number of) blockers?/i);
}

describe("default reviewer role convergence policies", () => {
	for (const roleName of REVIEWER_ROLES) {
		it(`${roleName} keeps solution-ready scope and convergence policy`, () => {
			expectPromptPolicy(promptFor(roleName), roleName);
		});
	}
});

describe("default team-lead review judgment policy", () => {
	it("independently validates and bounds review findings before applying fixes", () => {
		const prompt = promptFor("team-lead");
		const message = "team-lead must independently judge reviewer findings and prevent scope creep";

		expect(prompt, message).toMatch(/goal spec(?:ification)?(?: and)? explicit user amendments? (?:are|remain) authoritative/i);
		expect(prompt, message).toMatch(/independently.{0,100}(?:validat|assess).{0,100}(?:reviewer )?evidence/i);
		expect(prompt, message).toMatch(/(?:accept|reject).{0,100}(?:goal scope|regression evidence)|(?:goal scope|regression evidence).{0,100}(?:accept|reject)/i);
		expect(prompt, message).toMatch(/(?:scope|finding) ledger/i);
		expect(prompt, message).toMatch(/minimal accepted fixes?/i);
		expect(prompt, message).toMatch(/reject.{0,80}scope creep/i);
		expect(prompt, message).toMatch(/(?:reject|avoid).{0,100}documentation.only (?:appeasement|fixes?)/i);
		expect(prompt, message).toMatch(/two consecutive failures?.{0,100}(?:same )?content gate/i);
	});
});
