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

function expectCoderReadyBlockerPacket(prompt: string, roleName: string): void {
	const message = `${roleName} must require a coder-ready packet for every blocker`;
	const policy = normalizedPrompt(prompt);

	// A failure must be anchored to an approved requirement or an introduced regression.
	expect(policy, message).toMatch(/scope link.{0,120}(?:goal (?:requirement|acceptance criterion)|(?:change[- ]introduced )?regression)/i);
	expect(policy, message).toMatch(/evidence.{0,180}(?:files?|symbols?|lines?)/i);
	expect(policy, message).toMatch(/(?:trigger|input|state|timing).{0,160}(?:causal path|causal chain).{0,160}(?:consequence|impact)|(?:causal path|causal chain).{0,160}(?:consequence|impact)/i);

	// The remediation must be executable by a coder, not merely name a symptom.
	expect(policy, message).toMatch(/(?:recommended|minimal) (?:fix|remediation).{0,180}(?:files?|symbols?)/i);
	expect(policy, message).toMatch(/(?:ordered|order).{0,160}(?:control[- ]?flow|data[- ]?flow|state(?:[- ]?machine)?|persistence|API|schema|lifecycle)/i);
	expect(policy, message).toMatch(/(?:invariants?|ordering requirements?)/i);
	expect(policy, message).toMatch(/(?:pseudocode|signatures?).{0,160}(?:materially|ambiguity|needed)|(?:materially|ambiguity|needed).{0,160}(?:pseudocode|signatures?)/i);
	expect(policy, message).toMatch(/constraints?.{0,160}(?:compatibility|migration|concurrency|cleanup|ordering|platform|failure)/i);

	// Verification must tell the coder what to add and what it proves.
	expect(policy, message).toMatch(/verification.{0,200}(?:test layer|test file|focused tests?)/i);
	expect(policy, message).toMatch(/(?:setup|assertions?|regression behavior).{0,220}(?:tests?|verification)|(?:tests?|verification).{0,220}(?:setup|assertions?|regression behavior)/i);
	expect(policy, message).toMatch(/confidence.{0,180}(?:proven|reproduced|inferred)/i);
	expect(policy, message).toMatch(/(?:remaining uncertainty|uncertainty).{0,180}(?:evidence|close)|(?:evidence|close).{0,180}(?:remaining uncertainty|uncertainty)/i);

	// Alternatives are useful only when genuine choices exist, and failure without
	// this complete packet is invalid. The root-cause rule keeps overlap actionable.
	expect(policy, message).toMatch(/(?:when|if).{0,100}(?:credible|multiple).{0,100}alternatives?.{0,180}trade-?offs|alternatives?.{0,180}trade-?offs.{0,180}(?:when|if).{0,100}(?:credible|multiple)/i);
	expect(policy, message).toMatch(/(?:do not|never).{0,100}(?:invent|manufacture).{0,100}(?:inferior|alternatives?)/i);
	expect(policy, message).toMatch(/(?:fail|failure).{0,180}(?:(?:invalid|must not).{0,180}(?:packet|all (?:required )?fields?|complete)|(?:packet|all (?:required )?fields?|complete).{0,180}(?:invalid|must not))/i);
	expect(policy, message).toMatch(/(?:consolidat|deduplicat).{0,100}root causes?|root causes?.{0,100}(?:consolidat|deduplicat)/i);
}

function expectRevisionReadyArtifactPacket(prompt: string, roleName: string): void {
	const message = `${roleName} must require an author-ready revision packet for blocking content findings`;
	const policy = normalizedPrompt(prompt);

	expect(policy, message).toMatch(/(?:revision[- ]ready|author[- ]ready).{0,140}(?:artifact|packet|finding)/i);
	expect(policy, message).toMatch(/(?:exact )?(?:artifact )?(?:section|heading|paragraph|requirement|acceptance criterion|diagram|test plan)/i);
	expect(policy, message).toMatch(/(?:goal[- ]linked|goal (?:requirement|scope)|contradiction|gap).{0,180}(?:implementation|user) consequence/i);
	expect(policy, message).toMatch(/(?:concrete )?(?:replacement|addition|wording|outline|contract|data[- ]?flow|state sequence|acceptance criterion|test[- ]plan case)/i);
	expect(policy, message).toMatch(/(?:cross[- ]section|consistency).{0,160}(?:edit|constraint|reference)/i);
	expect(policy, message).toMatch(/(?:when|if).{0,100}(?:credible|multiple).{0,100}(?:revision )?alternatives?.{0,180}trade-?offs|(?:revision )?alternatives?.{0,180}trade-?offs.{0,180}(?:when|if).{0,100}(?:credible|multiple)/i);
	expect(policy, message).toMatch(/(?:required blocker|blocker).{0,160}(?:optional|bounded improvement)|(?:optional|bounded improvement).{0,160}(?:required blocker|blocker)/i);
}

function expectConditionalDocumentationStageScope(prompt: string, roleName: string): void {
	const policy = normalizedPrompt(prompt);
	const message = `${roleName} must respect downstream Documentation-stage scope when the workflow explicitly supplies it`;

	expect(policy, message).toMatch(/(?:when.{0,140}(?:integrated )?implementation review|(?:integrated )?implementation review.{0,140}when).{0,140}(?:explicitly )?(?:runs?|occurs?).{0,100}(?:before|ahead of).{0,100}downstream documentation (?:gate|stage)/i);
	expect(policy, message).toMatch(/documentation[- ]only.{0,160}(?:omissions?|gaps?|issues?).{0,160}(?:out of scope|non[- ]blocking)|(?:out of scope|non[- ]blocking).{0,160}documentation[- ]only/i);
	expect(policy, message).toMatch(/(?:later|downstream).{0,120}(?:documentation )?(?:producer|reviewer|stage|gate)/i);
	expect(policy, message).toMatch(/(?:concrete )?implementation defects?.{0,140}(?:in scope|review|still)|(?:in scope|review|still).{0,140}(?:concrete )?implementation defects?/i);
}

function expectConditionalSecurityDocumentationStageScope(prompt: string): void {
	const policy = normalizedPrompt(prompt);
	const message = "security-reviewer must defer documentation-only findings only when the review runs before a downstream Documentation stage";

	expect(policy, message).toMatch(/(?:when.{0,140}(?:security )?review|(?:security )?review.{0,140}when).{0,140}(?:runs?|occurs?).{0,100}(?:before|ahead of).{0,100}downstream documentation (?:gate|stage)/i);
	expect(policy, message).toMatch(/documentation[- ]only.{0,160}(?:out of scope|non[- ]blocking|(?:must )?not fail)|(?:out of scope|non[- ]blocking|(?:must )?not fail).{0,160}documentation[- ]only/i);
	expect(policy, message).toMatch(/(?:defer|leave).{0,120}(?:later|downstream).{0,120}(?:documentation )?(?:producer|reviewer|stage|gate)/i);
	expect(policy, message).toMatch(/(?:concrete )?(?:security|implementation) defects?.{0,140}(?:in scope|review|still)|(?:in scope|review|still).{0,140}(?:concrete )?(?:security|implementation) defects?/i);
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

describe("conditional implementation-stage review scope", () => {
	it("code-reviewer defers documentation-only findings only when the workflow explicitly has a downstream Documentation stage", () => {
		expectConditionalDocumentationStageScope(promptFor("code-reviewer"), "code-reviewer");
	});

	it("security-reviewer applies the same conditional Documentation-stage boundary without losing concrete security defects", () => {
		expectConditionalSecurityDocumentationStageScope(promptFor("security-reviewer"));
	});
});

describe("default reviewer blocker packets", () => {
	for (const roleName of REVIEWER_ROLES) {
		it(`${roleName} requires a complete implementation-ready blocker packet`, () => {
			expectCoderReadyBlockerPacket(promptFor(roleName), roleName);
		});
	}

	for (const roleName of ["architect", "reviewer", "spec-auditor"] as const) {
		it(`${roleName} makes first-phase and documentation blockers revision-ready`, () => {
			expectRevisionReadyArtifactPacket(promptFor(roleName), roleName);
		});
	}
});

describe("default team-lead review judgment policy", () => {
	it("handles invalid early documentation blockers without gate-order escalation", () => {
		const policy = normalizedPrompt(promptFor("team-lead"));
		const message = "team-lead must reject an early documentation blocker and keep work in the appropriate gate";

		expectConditionalDocumentationStageScope(policy, "team-lead");
		expect(policy, message).toMatch(/(?:reject|rejected).{0,160}documentation.{0,160}(?:blocker|finding)|documentation.{0,160}(?:blocker|finding).{0,160}(?:invalid|reject|rejected)/i);
		expect(policy, message).toMatch(/(?:reject|rejected).{0,180}(?:re[- ]?signal|signal again|re-run).{0,140}(?:stage[- ]scope|documentation|gate)|(?:re[- ]?signal|signal again|re-run).{0,180}(?:stage[- ]scope|documentation|gate).{0,140}(?:reject|rejected)/i);
		expect(policy, message).toMatch(/(?:not|rather than).{0,100}(?:work|start|spawn|assign).{0,100}(?:it |the finding |documentation )?early/i);
		expect(policy, message).toMatch(/(?:not|rather than).{0,100}escalat.{0,100}(?:to )?(?:the )?user/i);
		expect(policy, message).toMatch(/gate[- ]failure counts?.{0,80}diagnostic only.{0,180}(?:never|do not).{0,120}(?:pause|stop|ask the user)/i);
		expect(policy, message).toMatch(/wrong[- ]stage.{0,160}do not implement.{0,160}(?:scope|stage).{0,120}(?:re[- ]?signal|signal)/i);
	});

	it("rejects artifacts demanded by a later phase or gate without doing them early or escalating scope", () => {
		const policy = normalizedPrompt(promptFor("team-lead"));
		const message = "team-lead must keep every artifact in its owning stage while retaining concrete in-scope defects";

		expect(policy, message).toMatch(/(?:later|downstream).{0,100}(?:phase|gate).{0,180}(?:artifact|demand|requirement|work).{0,180}(?:reject|defer|out of scope)|(?:reject|defer|out of scope).{0,180}(?:artifact|demand|requirement|work).{0,180}(?:later|downstream).{0,100}(?:phase|gate)/i);
		expect(policy, message).toMatch(/(?:do not|rather than).{0,100}(?:work|start|spawn|assign).{0,120}(?:it|the (?:artifact|finding|work)).{0,120}(?:early|before)/i);
		expect(policy, message).toMatch(/(?:do not|rather than).{0,120}escalat.{0,120}(?:to )?(?:the )?user/i);
		expect(policy, message).toMatch(/(?:concrete|valid).{0,100}(?:in[- ]scope )?(?:implementation|security|artifact) defects?.{0,140}(?:remain|still).{0,120}in scope|(?:remain|still).{0,120}in scope.{0,140}(?:concrete|valid).{0,100}(?:implementation|security|artifact) defects?/i);
	});

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

		// Independent evidence is synthesized rather than silently discarded as duplicates.
		expect(policy, message).toMatch(/finding matrix.{0,180}(?:root cause|root[- ]cause)/i);
		expect(policy, message).toMatch(/(?:finding matrix|root cause).{0,220}(?:reporting reviewers?|roles?|evidence|remediation|confidence)/i);
		expect(policy, message).toMatch(/(?:two|2|more).{0,120}(?:reviewers?|roles?).{0,120}(?:corroborat|independent)/i);
		expect(policy, message).toMatch(/(?:compare|evaluate).{0,180}(?:correctness|scope|compatibility|risk|testability).{0,180}(?:fix|revision|option)/i);
		expect(policy, message).toMatch(/(?:disagree|disagreement).{0,180}(?:severity|scope|remediation).{0,180}(?:resolve|goal|evidence)/i);
		expect(policy, message).toMatch(/(?:deduplicat).{0,120}work items?.{0,160}(?:not|without).{0,160}evidence|(?:preserve|retain).{0,120}(?:independent|corroborat).{0,120}evidence/i);
		expect(policy, message).toMatch(/(?:accepted|consolidated).{0,180}(?:packet|repair|revision).{0,220}(?:files?|sections?|ordered|constraints?|tests?|corroborating|alternatives?|rationale)/i);

		// The lead converges rather than accepting verifier-driven scope creep.
		expect(policy, message).toMatch(/do not silently amend the goal spec.{0,100}(?:add acceptance criteria|reviewer suggestions? into requirements?)/i);
		expect(policy, message).toMatch(/(?:never merge|do not.{0,80}(?:merge|revise)).{0,100}documentation[- ]only.{0,100}(?:appease|appeasement)/i);
		expect(policy, message).toMatch(/gate[- ]failure counts?.{0,80}diagnostic only.{0,160}(?:never|do not).{0,100}(?:pause|stop).{0,160}(?:twice|fixed number)/i);
		expect(policy, message).toMatch(/keep going until every required gate passes.{0,180}concrete.{0,180}approved goal.{0,180}safely fixable/i);
		expect(policy, message).toMatch(/ask the user only when.{0,180}(?:scope amendment|product choice|destructive|external action|credential|dependency|no safe in[- ]scope fix)/i);
		expect(policy, message).toMatch(/previously discoverable.{0,100}out[- ]of[- ]scope.{0,100}wrong[- ]stage.{0,160}do not implement/i);
	});
});
