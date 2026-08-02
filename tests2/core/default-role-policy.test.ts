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

function normalizedPrompt(prompt: string): string {
	// Role prose is Markdown and may wrap a single policy across several lines.
	// Assert the policy clauses, not a particular sentence layout or inflection.
	return prompt.replace(/\s+/g, " ");
}

function expectPromptPolicy(prompt: string, roleName: string): void {
	const message = `${roleName} must preserve review-convergence policy`;
	const policy = normalizedPrompt(prompt);

	// Scope and decision authority.
	expect(policy, message).toMatch(/(?:effective )?goal spec(?:ification)?.{0,100}explicit user amendments?.{0,100}authoritative/i);
	expect(policy, message).toMatch(/(?:reviewer(?: or design)?|design) suggestions?.{0,100}(?:not requirements?|do not.{0,80}requirements?|become requirements?)/i);
	expect(policy, message).toMatch(/classif.{0,120}blockers?/i);
	expect(policy, message).toMatch(/bounded improvements?/i);
	expect(policy, message).toMatch(/(?:out[- ]of[- ]scope|pre[- ]existing)/i);
	expect(policy, message).toMatch(/(?:fail only|(?:failing )?blocker must).{0,140}(?:explicit(?:ly)? (?:unmet )?(?:goal )?requirements?|concrete regressions?)/i);

	// A failing finding must be implementable, rather than an unbounded critique.
	expect(policy, message).toMatch(/(?:exact|specific).{0,80}(?:files?|symbols?)/i);
	expect(policy, message).toMatch(/causal (?:path|chain).{0,80}trigger|trigger.{0,80}causal (?:path|chain)/i);
	expect(policy, message).toMatch(/minimal.{0,160}(?:control[- ]?flow|data[- ]?flow)|(?:control[- ]?flow|data[- ]?flow).{0,160}minimal/i);
	expect(policy, message).toMatch(/(?:remediation|fix)/i);
	expect(policy, message).toMatch(/(?:compatibility|lifecycle).{0,100}(?:constraints?|requirements?)/i);
	expect(policy, message).toMatch(/focused (?:integration\/browser )?(?:abuse\/regression |regression )?tests?/i);
	expect(policy, message).toMatch(/(?:deduplicat|consolidat).{0,100}root causes?|root causes?.{0,100}(?:deduplicat|consolidat)/i);

	// Re-reviews should converge instead of repeatedly expanding the goal.
	expect(policy, message).toMatch(/re[- ]?review.{0,180}(?:fail only|may fail only).{0,180}(?:unresolved (?:previously |prior )?(?:reported )?blockers?|regressions? introduced by (?:the )?revision)/i);
	expect(policy, message).toMatch(/(?:(?:previously|prior).{0,100}discoverable|new(?:ly)? (?:discovered )?(?:blockers?|demands?).{0,100}discoverable).{0,140}(?:non[- ]?blocking|not blocking)/i);
	expect(policy, message).toMatch(/(?:critical data[- ]loss|exploitable[- ]security)/i);
	expect(policy, message).toMatch(/default to pass.{0,120}(?:explicit (?:goal )?requirements?.{0,80}met|satisf(?:y|ies).{0,80}explicit (?:goal )?requirements?)/i);
	expect(policy, message).toMatch(/(?:at most|maximum|cap|never exceeds).{0,80}(?:three|3).{0,80}(?:blocker )?root causes?/i);
	expect(policy, message).toMatch(/PASS\s*[—-]\s*0 blockers?/i);
	expect(policy, message).toMatch(/FAIL\s*[—-]\s*(?:N|number of) blockers?/i);
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
		const policy = normalizedPrompt(promptFor("team-lead"));
		const message = "team-lead must independently judge reviewer findings and prevent scope creep";

		// The approved goal is the boundary; reviewers cannot expand it.
		expect(policy, message).toMatch(/user[- ]approved goal.{0,100}(?:scope boundary|boundary)/i);
		expect(policy, message).toMatch(/reviewer suggestions?.{0,100}(?:not requirements?|do not.{0,80}requirements?|into requirements?)/i);
		expect(policy, message).toMatch(/only.{0,80}explicit user amendment.{0,80}changes? goal scope/i);

		// Reviewer output is evidence to independently validate and then accept or reject.
		expect(policy, message).toMatch(/reviewer output.{0,100}evidence.{0,100}(?:not an order|advice)/i);
		expect(policy, message).toMatch(/verify.{0,100}(?:evidence|reproduction path).{0,100}credible/i);
		expect(policy, message).toMatch(/(?:decide|classif).{0,140}(?:caused by this change|blocks a stated goal requirement)/i);
		expect(policy, message).toMatch(/(?:accept|reject|defer).{0,160}(?:blocker|finding|demands?)/i);
		expect(policy, message).toMatch(/(?:scope|finding) ledger/i);
		expect(policy, message).toMatch(/(?:accepted blocker fixes?.{0,100}smallest complete fix|smallest complete fix)/i);

		// The lead converges rather than accepting verifier-driven scope creep.
		expect(policy, message).toMatch(/do not silently amend the goal spec.{0,100}(?:add acceptance criteria|reviewer suggestions? into requirements?)/i);
		expect(policy, message).toMatch(/(?:never merge|do not.{0,80}(?:merge|revise)).{0,100}documentation[- ]only.{0,100}(?:appease|appeasement)/i);
		expect(policy, message).toMatch(/two consecutive failures?.{0,100}(?:same )?content gate.{0,100}(?:stop|do not create another rewrite task)/i);
	});
});
