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
		assert.equal(payload.cards[0]?.navLabel, "Orientation");
		assert.equal(payload.cards[0]?.summary, "Good direction with follow-up checks.");
		assert.match(payload.cards[0]?.rationale ?? "", /Author intent/);

		const design = payload.cards.find(card => card.phaseId === "design");
		assert.ok(design);
		assert.equal(design.navLabel, "Agent submits YAML");
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

	it("renders the orientation card as six guided beats with the reframed merge heading", () => {
		const validation = validatePrWalkthroughYaml(validYaml());
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks() });
		const sections = payload.cards[0]?.sections;
		assert.ok(sections);
		assert.deepEqual(sections.map(section => section.id), [
			"at-a-glance",
			"why-it-exists",
			"what-it-changes",
			"should-merge",
			"what-to-watch",
			"where-to-look",
		]);
		assert.deepEqual(sections.map(section => section.navLabel), [
			"At a glance",
			"Why it exists",
			"What it changes",
			"Should we merge",
			"What to watch",
			"Where to look",
		]);

		const atAGlance = sections.find(section => section.id === "at-a-glance");
		assert.equal(atAGlance?.showStats, true);
		assert.equal(atAGlance?.verdict?.recommendation, "comment");
		assert.equal(atAGlance?.verdict?.confidence, "medium");

		const merge = sections.find(section => section.id === "should-merge");
		assert.equal(merge?.heading, "Should it be merged?");
		assert.match(merge?.body ?? "", /^Maybe — comment, medium confidence\./);
		assert.match(merge?.body ?? "", /It makes review safer\./);

		const watch = sections.find(section => section.id === "what-to-watch");
		assert.ok(watch?.concerns?.some(concern => concern.severity === "non_blocking" && /reload persistence/i.test(concern.text)));
		assert.ok(watch?.concerns?.some(concern => concern.severity === "question"));

		const whereToLook = sections.find(section => section.id === "where-to-look");
		assert.equal(whereToLook?.showOriginalDescription, true);
		assert.match(whereToLook?.body ?? "", /Start with API chunk/);
	});

	it("derives a nav_label fallback from the title and carries an explicit nav_label through", () => {
		const validation = validatePrWalkthroughYaml(validYaml().replace("title: API submission flow", "title: API submission flow\n      nav_label: API flow"));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks() });
		const review = payload.cards.find(card => card.id === "significant-chunk-api");
		assert.equal(review?.navLabel, "API flow");

		const design = payload.cards.find(card => card.phaseId === "design");
		assert.equal(design?.navLabel, "Agent submits YAML");
	});

	it("rejects nav_label values that exceed the word or character cap", () => {
		const tooManyWords = validatePrWalkthroughYaml(validYaml().replace("title: Agent submits YAML", "title: Agent submits YAML\n      nav_label: one two three four"));
		assert.equal(tooManyWords.ok, false);
		if (!tooManyWords.ok) assertError(tooManyWords.summary.errors, "$.walkthrough.design_decisions[0].nav_label", /3 words/);

		const tooLong = validatePrWalkthroughYaml(validYaml().replace("title: API submission flow", "title: API submission flow\n      nav_label: abcdefghijklmnopqrstuvwxyz"));
		assert.equal(tooLong.ok, false);
		if (!tooLong.ok) assertError(tooLong.summary.errors, "$.walkthrough.review_chunks[0].nav_label", /24 characters/);
	});

	it("preserves authoritative resolved changeset SHAs over YAML SHAs", () => {
		const validation = validatePrWalkthroughYaml(validYaml());
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, {
			changeset: {
				baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			},
			files: diffBlocks(),
		});

		assert.equal(payload.changeset.baseSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		assert.equal(payload.changeset.headSha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
	});

	it("preserves truly unmapped hunk references as warnings and file-fallback anchors as card suggestions", () => {
		const validation = validatePrWalkthroughYaml(validYaml());
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks() });
		const warningCodes = payload.warnings.map(warning => warning.code);
		assert.ok(warningCodes.includes("unmapped_hunk"));
		assert.equal(warningCodes.includes("unmapped_anchor"), false);

		const design = payload.cards.find(card => card.phaseId === "design");
		assert.ok(design?.cardSuggestions?.some(note => /Unmapped hunk/.test(note)));
		const review = payload.cards.find(card => card.id === "significant-chunk-api");
		assert.ok(review?.cardSuggestions?.some(note => /Unmapped suggested comment anchor/.test(note)));
	});

	it("maps relevant hunks and anchors by numeric range when YAML omits trailing hunk context", () => {
		const validation = validatePrWalkthroughYaml(hunkMappingYaml("@@ -10,2 +10,3 @@"));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [contextDiffBlock("@@ -10,2 +10,3 @@ function renderExample")] });

		assertNoUnmappedForFile(payload.warnings, "src/context.ts");
		const design = payload.cards.find(card => card.id === "design-context-design");
		assert.deepEqual(design?.diffBlocks.map(block => block.id), ["block-context"]);
		const review = payload.cards.find(card => card.id === "significant-context-review");
		assert.equal(review?.suggestedComments?.length, 1);
		assert.equal(review?.suggestedComments?.[0]?.lineId, "block-context:h0:l1");
	});

	it("maps relevant hunks and anchors by numeric range when YAML includes stale trailing hunk context", () => {
		const validation = validatePrWalkthroughYaml(hunkMappingYaml("@@ -10,2 +10,3 @@ staleRenderName"));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [contextDiffBlock("@@ -10,2 +10,3 @@ actualRenderName")] });

		assertNoUnmappedForFile(payload.warnings, "src/context.ts");
		const review = payload.cards.find(card => card.id === "significant-context-review");
		assert.equal(review?.suggestedComments?.length, 1);
		assert.equal(review?.suggestedComments?.[0]?.lineId, "block-context:h0:l1");
	});

	it("maps relevant hunks and anchors by numeric range when parsed diff omits trailing hunk context", () => {
		const validation = validatePrWalkthroughYaml(hunkMappingYaml("@@ -10,2 +10,3 @@ renderExample"));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [contextDiffBlock("@@ -10,2 +10,3 @@")] });

		assertNoUnmappedForFile(payload.warnings, "src/context.ts");
		const review = payload.cards.find(card => card.id === "significant-context-review");
		assert.equal(review?.suggestedComments?.length, 1);
		assert.equal(review?.suggestedComments?.[0]?.lineId, "block-context:h0:l1");
	});

	it("falls back to the only file hunk when YAML line coordinates are stale", () => {
		const validation = validatePrWalkthroughYaml(hunkMappingYaml("@@ -371,7 +371,8 @@ stale location"));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [contextDiffBlock("@@ -10,2 +10,3 @@ function renderExample")] });

		assertNoUnmappedForFile(payload.warnings, "src/context.ts");
		const review = payload.cards.find(card => card.id === "significant-context-review");
		assert.equal(review?.suggestedComments?.length, 1);
		assert.equal(review?.suggestedComments?.[0]?.lineId, "block-context:h0:l1");
	});

	it("uses file-level fallback without global warnings when hunk numeric ranges do not match", () => {
		const validation = validatePrWalkthroughYaml(hunkMappingYaml("@@ -11,2 +10,3 @@ function renderExample"));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [multiHunkContextDiffBlock()] });

		assertNoUnmappedForFile(payload.warnings, "src/context.ts");
		const review = payload.cards.find(card => card.id === "significant-context-review");
		assert.deepEqual(review?.diffBlocks.map(block => block.id), ["block-context"]);
		assert.equal(review?.suggestedComments?.length ?? 0, 0);
	});

	it("does not duplicate diff blocks when mapped hunks and file fallback overlap", () => {
		const validation = validatePrWalkthroughYaml(hunkMappingYaml("@@ -10,2 +10,3 @@", "@@ -10,2 +10,3 @@", [{ header: "@@ -99,1 +99,1 @@", why: "Intentional fallback to the same file." }]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [contextDiffBlock("@@ -10,2 +10,3 @@")] });
		const review = payload.cards.find(card => card.id === "significant-context-review");

		assert.deepEqual(review?.diffBlocks.map(block => block.id), ["block-context"]);
		assertNoUnmappedForFile(payload.warnings, "src/context.ts");
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

function contextDiffBlock(header: string): PrWalkthroughDiffBlock {
	return {
		id: "block-context",
		filePath: "src/context.ts",
		status: "modified",
		hunks: [{
			id: "block-context:h0",
			header,
			lines: [
				{ id: "block-context:h0:l0", side: "context", oldLine: 10, newLine: 10, text: "function renderExample() {", kind: "context" },
				{ id: "block-context:h0:l1", side: "new", newLine: 11, text: "  return <Example />;", kind: "add" },
			],
		}],
	};
}

function multiHunkContextDiffBlock(): PrWalkthroughDiffBlock {
	const block = contextDiffBlock("@@ -10,2 +10,3 @@ function renderExample");
	return {
		...block,
		hunks: [
			...block.hunks,
			{
				id: "block-context:h1",
				header: "@@ -30,1 +31,2 @@ anotherChange",
				lines: [{ id: "block-context:h1:l0", side: "new", newLine: 31, text: "another", kind: "add" }],
			},
		],
	};
}

function assertNoUnmappedForFile(warnings: Array<{ code: string; filePath?: string }>, filePath: string): void {
	const matching = warnings.filter(warning => (warning.code === "unmapped_hunk" || warning.code === "unmapped_anchor") && warning.filePath === filePath);
	assert.deepEqual(matching, []);
}

function hunkMappingYaml(hunkHeader: string, anchorHeader = hunkHeader, extraRelevantHunks: Array<{ header: string; why: string }> = []): string {
	const relevantHunks = [
		{ header: hunkHeader, why: "Primary mapped context change." },
		...extraRelevantHunks,
	].map(item => `        - file: src/context.ts
          hunk_header: "${yamlDoubleQuoted(item.header)}"
          why_relevant: ${item.why}`).join("\n");

	return `schema_version: 1
pr:
  provider: github
  owner: SuuBro
  repo: bobbit
  number: 42
  title: Fix hunk mapping
  url: https://github.com/SuuBro/bobbit/pull/42
  base_sha: abcdef1234567890
  head_sha: fedcba9876543210
  original_description:
    body: Test hunk mapping.
    source: gh_api
    fetched_at: "2026-05-30T00:00:00.000Z"
  stats:
    files_changed: 1
    additions: 2
    deletions: 1
walkthrough:
  context:
    why_created: Fix noisy hunk mapping warnings.
    problem_solved: Numeric hunk ranges should be authoritative.
    why_worth_merging: It keeps walkthrough output actionable.
    merge_concerns: Keep true misses visible.
    author_intent: Match hunks despite unstable context labels.
    reviewer_map: Review the context hunk.
  merge_assessment:
    recommendation: comment
    confidence: high
    summary: Hunk mapping should be stable.
    blocking_concerns: []
    non_blocking_concerns: []
  design_decisions:
    - id: context-design
      title: Context mapping
      explanation: Map a hunk reference to the parsed diff.
      chosen_approach: Match file and numeric hunk coordinates.
      alternatives_considered: []
      tradeoffs: []
      suggested_reviewer_concerns: []
      relevant_hunks:
${relevantHunks}
  review_chunks:
    - id: context-review
      phase: significant
      title: Context review
      reviewer_goal: Check hunk references map without noisy warnings.
      explanation: Suggested comments should anchor to the same hunk.
      files:
        - src/context.ts
      relevant_hunks:
${relevantHunks}
      suggested_concerns:
        - severity: question
          concern: Is the hunk anchor stable?
          suggested_comment: Please verify this anchor maps by numeric range.
          anchors:
            - file: src/context.ts
              hunk_header: "${yamlDoubleQuoted(anchorHeader)}"
              line: 11
      positive_notes: []
  omissions_and_followups: []
  audit:
    remaining_changed_areas: []
    low_signal_or_mechanical_changes: []
    generated_or_binary_files: []
    reviewer_checklist:
      - Confirm hunk mapping warnings are meaningful.
  display:
    phase_order:
      - orientation
      - design
      - significant
      - audit
    chunk_order:
      - context-review
`;
}

function yamlDoubleQuoted(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
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
