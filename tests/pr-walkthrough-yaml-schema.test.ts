import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapYamlToWalkthroughPayload, validatePrWalkthroughYaml } from "../src/server/pr-walkthrough/walkthrough-yaml-schema.ts";
import type { PrWalkthroughDiffBlock } from "../src/shared/pr-walkthrough/types.ts";

describe("PR walkthrough YAML schema", () => {
	it("accepts a minimal valid document", () => {
		const result = validatePrWalkthroughYaml(validYaml(), { target: launchTarget() });

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.document.pr.number, 42);
		assert.equal(result.document.walkthrough.review_chunks[0]?.id, "chunk-api");
	});

	it("rejects syntax errors, multiple documents, and non-object roots with actionable paths", () => {
		const syntax = validatePrWalkthroughYaml("schema_version: [");
		assert.equal(syntax.ok, false);
		if (!syntax.ok) assert.equal(syntax.summary.errors[0]?.path, "$");

		const multiple = validatePrWalkthroughYaml("schema_version: 1\n---\nschema_version: 1\n");
		assert.equal(multiple.ok, false);
		if (!multiple.ok) assert.match(multiple.summary.errors[0]?.message ?? "", /exactly one YAML document/);

		const root = validatePrWalkthroughYaml("- schema_version: 1\n");
		assert.equal(root.ok, false);
		if (!root.ok) assert.equal(root.summary.errors[0]?.path, "$");
	});

	it("rejects missing fields, scalar type mismatches, invalid enums, and bad SHAs", () => {
		const result = validatePrWalkthroughYaml(validYaml()
			.replace("provider: github", "provider: gitlab")
			.replace("head_sha: fedcba9876543210", "head_sha: not-a-sha")
			.replace("recommendation: comment", "recommendation: merge")
			.replace("positive_notes:\n        - Clear resolver split", "positive_notes: no"));

		assert.equal(result.ok, false);
		if (result.ok) return;
		assertError(result.summary.errors, "$.pr.provider", /Expected one of/);
		assertError(result.summary.errors, "$.pr.head_sha", /hexadecimal SHA/);
		assertError(result.summary.errors, "$.walkthrough.merge_assessment.recommendation", /Expected one of/);
		assertError(result.summary.errors, "$.walkthrough.review_chunks[0].positive_notes", /Expected an array/);
	});

	it("enforces launch identity", () => {
		const result = validatePrWalkthroughYaml(validYaml(), {
			target: { provider: "github", owner: "Other", repo: "bobbit", number: 7, prUrl: "https://github.com/SuuBro/bobbit/pull/7" },
		});

		assert.equal(result.ok, false);
		if (result.ok) return;
		assertError(result.summary.errors, "$.pr.owner", /launch target owner/);
		assertError(result.summary.errors, "$.pr.number", /launch target PR number/);
		assertError(result.summary.errors, "$.pr.url", /launch target URL/);
	});

	it("enforces unique review chunk ids", () => {
		const result = validatePrWalkthroughYaml(validYaml()
			.replace("id: chunk-api", "id: duplicate")
			.replace("id: chunk-audit", "id: duplicate"));

		assert.equal(result.ok, false);
		if (result.ok) return;
		assertError(result.summary.errors, "$.walkthrough.review_chunks[1].id", /Duplicate id/);
	});

	it("enforces display chunk references", () => {
		const result = validatePrWalkthroughYaml(validYaml().replace("- chunk-api\n      - chunk-audit", "- missing-chunk"));

		assert.equal(result.ok, false);
		if (result.ok) return;
		assertError(result.summary.errors, "$.walkthrough.display.chunk_order[0]", /Unknown review chunk id/);
	});

	it("enforces configured byte, string, and array limits", () => {
		const bytes = validatePrWalkthroughYaml(validYaml(), { maxYamlBytes: 10 });
		assert.equal(bytes.ok, false);
		if (!bytes.ok) assert.match(bytes.summary.errors[0]?.message ?? "", /limit is 10 bytes/);

		const strings = validatePrWalkthroughYaml(validYaml().replace("Fix confusing walkthrough launch", "x".repeat(30)), { maxStringLength: 20 });
		assert.equal(strings.ok, false);
		if (!strings.ok) assertError(strings.summary.errors, "$.pr.title", /limit is 20/);

		const arrays = validatePrWalkthroughYaml(validYaml(), { maxArrayItems: 1 });
		assert.equal(arrays.ok, false);
		if (!arrays.ok) assertError(arrays.summary.errors, "$.walkthrough.review_chunks", /limit is 1/);
	});

	it("maps YAML into orientation, design, review, other, and audit cards with PR body preserved", () => {
		const validation = validatePrWalkthroughYaml(validYaml());
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks(), warnings: [{ code: "existing", severity: "info", message: "Existing warning" }] });

		assert.equal(payload.changesetId, "github:SuuBro/bobbit#42:fedcba9");
		assert.equal(payload.changeset.prBody, "## Why\nFixes review scope.");
		assert.deepEqual(payload.cards.map(card => card.phaseId), ["orientation", "design", "significant", "other", "audit", "audit"]);
		assert.equal(payload.cards[0]?.title, "PR context");
		assert.match(payload.cards[0]?.summary ?? "", /Why created/);
		assert.match(payload.cards[0]?.rationale ?? "", /Author intent/);

		const design = payload.cards.find(card => card.phaseId === "design");
		assert.ok(design);
		assert.deepEqual(design.diffBlocks.map(block => block.id), ["block-src-a"]);

		const review = payload.cards.find(card => card.id === "significant-chunk-api");
		assert.ok(review);
		assert.deepEqual(review.diffBlocks.map(block => block.id), ["block-src-a", "block-src-b"]);
		assert.equal(review.suggestedComments?.length, 1);
		assert.equal(review.suggestedComments?.[0]?.cardId, review.id);
		assert.equal(review.suggestedComments?.[0]?.lineId, "block-src-a:h0:l1");

		assert.ok(payload.cards.some(card => card.title === "Omissions and follow-ups"));
		assert.ok(payload.cards.some(card => card.title === "Audit and review checklist"));
		assert.ok(payload.warnings.some(warning => warning.code === "existing"));
	});

	it("preserves unmapped hunk and anchor references as warnings and card suggestions", () => {
		const validation = validatePrWalkthroughYaml(validYaml());
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks() });
		const warningCodes = payload.warnings.map(warning => warning.code);
		assert.ok(warningCodes.includes("unmapped_hunk"));
		assert.ok(warningCodes.includes("unmapped_anchor"));

		const design = payload.cards.find(card => card.phaseId === "design");
		assert.ok(design?.cardSuggestions?.some(note => /Unmapped hunk/.test(note)));
		const review = payload.cards.find(card => card.id === "significant-chunk-api");
		assert.ok(review?.cardSuggestions?.some(note => /Unmapped suggested comment anchor/.test(note)));
	});
});

function assertError(errors: Array<{ path: string; message: string }>, path: string, message: RegExp): void {
	const error = errors.find(item => item.path === path);
	assert.ok(error, `Expected error at ${path}; got ${errors.map(item => item.path).join(", ")}`);
	assert.match(error.message, message);
}

function launchTarget() {
	return { provider: "github" as const, owner: "SuuBro", repo: "bobbit", number: 42, prUrl: "https://github.com/SuuBro/bobbit/pull/42", baseSha: "abcdef1234567890", headSha: "fedcba9876543210" };
}

function diffBlocks(): PrWalkthroughDiffBlock[] {
	return [
		{
			id: "block-src-a",
			filePath: "src/a.ts",
			status: "modified",
			hunks: [{
				id: "block-src-a:h0",
				header: "@@ -1,2 +1,3 @@",
				lines: [
					{ id: "block-src-a:h0:l0", side: "context", oldLine: 1, newLine: 1, text: "const a = 1;", kind: "context" },
					{ id: "block-src-a:h0:l1", side: "new", newLine: 2, text: "const b = 2;", kind: "add" },
				],
			}],
		},
		{
			id: "block-src-b",
			filePath: "src/b.ts",
			status: "modified",
			hunks: [{ id: "block-src-b:h0", header: "@@ -5,1 +5,2 @@", lines: [{ id: "block-src-b:h0:l0", side: "new", newLine: 5, text: "change", kind: "add" }] }],
		},
	];
}

function validYaml(): string {
	return `schema_version: 1
pr:
  provider: github
  owner: SuuBro
  repo: bobbit
  number: 42
  title: Fix confusing walkthrough launch
  url: https://github.com/SuuBro/bobbit/pull/42
  base_sha: abcdef1234567890
  head_sha: fedcba9876543210
  original_description:
    body: |-
      ## Why
      Fixes review scope.
    source: gh_api
    fetched_at: "2026-05-30T00:00:00.000Z"
  stats:
    files_changed: 2
    additions: 10
    deletions: 3
walkthrough:
  context:
    why_created: Fix the walkthrough launch flow.
    problem_solved: Reviewers need session-hosted context.
    why_worth_merging: It makes review safer.
    merge_concerns: Validate session wiring separately.
    author_intent: Move synthesis into the agent.
    reviewer_map: Start with API chunk, then audit.
  merge_assessment:
    recommendation: comment
    confidence: medium
    summary: Good direction with follow-up checks.
    blocking_concerns: []
    non_blocking_concerns:
      - Confirm reload persistence.
  design_decisions:
    - id: design-agent-yaml
      title: Agent submits YAML
      explanation: A dedicated tool gates panel population.
      chosen_approach: Validate and map submitted YAML server-side.
      alternatives_considered:
        - option: Scrape final chat
          pros:
            - Simple to prototype
          cons:
            - Not deterministic
      tradeoffs:
        - Requires a schema mapper.
      suggested_reviewer_concerns:
        - Does invalid YAML stay retryable?
      relevant_hunks:
        - file: src/a.ts
          hunk_header: "@@ -1,2 +1,3 @@"
          why_relevant: Shows the submission path.
        - file: src/missing.ts
          hunk_header: "@@ -9,1 +9,1 @@"
          why_relevant: Intentional unmapped reference.
  review_chunks:
    - id: chunk-api
      phase: significant
      title: API submission flow
      reviewer_goal: Decide whether validation blocks bad payloads.
      explanation: The API accepts only validated YAML before cards render.
      files:
        - src/b.ts
      relevant_hunks:
        - file: src/a.ts
          hunk_header: "@@ -1,2 +1,3 @@"
          line_range: "2-2"
          why_relevant: Primary mapped change.
      suggested_concerns:
        - severity: question
          concern: Is retry feedback specific enough?
          suggested_comment: Please include the schema path in this error.
          anchors:
            - file: src/a.ts
              hunk_header: "@@ -1,2 +1,3 @@"
              line: 2
        - severity: nit
          concern: Missing anchor should become a card note.
          suggested_comment: This should not disappear.
          anchors:
            - file: src/a.ts
              hunk_header: "@@ -50,1 +50,1 @@"
      positive_notes:
        - Clear resolver split
    - id: chunk-audit
      phase: audit
      title: Audit leftovers
      reviewer_goal: Check no files were skipped.
      explanation: Audit remaining generated or mechanical changes.
      files: []
      relevant_hunks: []
      suggested_concerns: []
      positive_notes: []
  omissions_and_followups:
    - category: tests
      expected_artifact: Unit coverage for schema validation.
      evidence_checked: Existing tests were inspected.
      concern: Browser coverage lands in another task.
      suggested_comment: Please confirm browser coverage before merge.
      severity: question
  audit:
    remaining_changed_areas:
      - Session metadata integration.
    low_signal_or_mechanical_changes:
      - Snapshot-only churn.
    generated_or_binary_files: []
    reviewer_checklist:
      - Confirm no tests were run by the analyser.
  display:
    phase_order:
      - orientation
      - design
      - significant
      - other
      - audit
    chunk_order:
      - chunk-api
      - chunk-audit
`;
}
