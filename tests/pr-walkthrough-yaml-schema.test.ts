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
		assert.deepEqual(review.diffBlocks.map(block => block.id), ["block-src-a"]);
		assert.equal(review.suggestedComments?.length, 1);
		assert.equal(review.suggestedComments?.[0]?.cardId, review.id);
		assert.equal(review.suggestedComments?.[0]?.lineId, "block-src-a:h0:l1");

		const finalAudit = payload.cards.find(card => card.title === "Audit and review checklist");
		assert.ok(finalAudit?.diffBlocks.some(block => block.id === "block-src-b"));

		assert.ok(payload.cards.some(card => card.title === "Omissions and follow-ups"));
		assert.ok(payload.cards.some(card => card.title === "Audit and review checklist"));
		assert.ok(payload.warnings.some(warning => warning.code === "existing"));
	});

	it("renders the orientation card as the five focused reviewer orientation beats", () => {
		const validation = validatePrWalkthroughYaml(validYaml());
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks() });
		const sections = payload.cards[0]?.sections;
		assert.ok(sections);
		assert.deepEqual(sections.map(section => section.id), [
			"what-changed-and-why",
			"original-pr-description",
			"change-map",
			"risks-and-edge-cases",
			"merge-recommendation",
		]);
		assert.deepEqual(sections.map(section => section.navLabel), [
			"Overview",
			"Original PR",
			"Change map",
			"Risks",
			"Merge",
		]);

		const purpose = sections.find(section => section.id === "what-changed-and-why");
		assert.equal(purpose?.showStats, true);
		assert.equal(purpose?.showOriginalDescription, undefined);
		assert.match(purpose?.body ?? "", /Reviewers need session-hosted context/);
		assert.match(purpose?.body ?? "", /Fix the walkthrough launch flow/);
		assert.match(purpose?.body ?? "", /Move synthesis into the agent/);
		assert.ok(purpose?.diffBreakdown?.some(item => item.label === "Prod executable code changes" && item.additions === 120));

		const original = sections.find(section => section.id === "original-pr-description");
		assert.equal(original?.showOriginalDescription, true);

		const risks = sections.find(section => section.id === "risks-and-edge-cases");
		assert.ok(risks?.concerns?.some(concern => concern.severity === "non_blocking" && /reload persistence/i.test(concern.text)));
		assert.ok(risks?.concerns?.some(concern => concern.severity === "question"));

		assert.equal(sections.some(section => section.id === "validation"), false);

		const merge = sections.find(section => section.id === "merge-recommendation");
		assert.equal(merge?.heading, "Merge recommendation");
		assert.equal(merge?.verdict?.recommendation, "comment");
		assert.equal(merge?.verdict?.confidence, "medium");
		assert.match(merge?.body ?? "", /It makes review safer\./);
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

	it("treats an empty nav_label as omitted and falls back to the derived label", () => {
		const validation = validatePrWalkthroughYaml(validYaml().replace("title: Agent submits YAML", "title: Agent submits YAML\n      nav_label: \"\""));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks() });
		const design = payload.cards.find(card => card.phaseId === "design");
		assert.equal(design?.navLabel, "Agent submits YAML");
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

	it("fails unresolved hunk references with structured retryable details", () => {
		const validation = validatePrWalkthroughYaml(validYaml().replace("placement: secondary\n          primary_card_id: significant-chunk-api\n          why_relevant: Shows the submission path.", "placement: secondary\n          primary_card_id: significant-chunk-api\n          why_relevant: Shows the submission path.\n        - file: src/missing.ts\n          hunk_header: \"@@ -9,1 +9,1 @@\"\n          why_relevant: Intentional unmapped reference."));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const error = captureError(() => mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks() }));
		assert.equal(error.code, "PRW_HUNK_REF_UNRESOLVED");
		assert.equal(error.retryable, true);
		assert.equal(error.details?.supplied?.file, "src/missing.ts");
	});

	it("keeps legacy suggested concern anchors as notes when they cannot be mapped", () => {
		const validation = validatePrWalkthroughYaml(validYaml());
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: diffBlocks() });
		assert.ok(payload.warnings.some(warning => warning.code === "unmapped_anchor"));
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

	it("fails closed when a supplied hunk header misses the only file hunk", () => {
		const staleHeader = "@@ -371,7 +371,8 @@ stale location";
		const validation = validatePrWalkthroughYaml(hunkMappingYaml(staleHeader));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const error = captureError(() => mapYamlToWalkthroughPayload(validation.document, { files: [contextDiffBlock("@@ -10,2 +10,3 @@ function renderExample")] }));
		assert.equal(error.code, "PRW_HUNK_REF_UNRESOLVED");
		assert.equal(error.retryable, true);
		assert.equal(error.details?.supplied?.file, "src/context.ts");
		assert.equal(error.details?.supplied?.hunk_header, staleHeader);
		assert.equal(error.details?.candidateCount, 0);
	});

	it("fails closed when an older header reference is ambiguous across multiple hunks", () => {
		const validation = validatePrWalkthroughYaml(hunkMappingYaml("@@ -11,2 +10,3 @@ function renderExample"));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const error = captureError(() => mapYamlToWalkthroughPayload(validation.document, { files: [multiHunkContextDiffBlock()] }));
		assert.equal(error.code, "PRW_HUNK_REF_UNRESOLVED");
		assert.equal(error.retryable, true);
		assert.equal(error.details?.cardId, "design-context-design");
	});

	it("does not duplicate diff blocks when repeated hunk references overlap", () => {
		const validation = validatePrWalkthroughYaml(hunkMappingYaml("@@ -10,2 +10,3 @@", "@@ -10,2 +10,3 @@", [{ header: "@@ -10,2 +10,3 @@", why: "Intentional repeated reference to the same hunk." }]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [contextDiffBlock("@@ -10,2 +10,3 @@")] });
		const review = payload.cards.find(card => card.id === "significant-context-review");

		assert.deepEqual(review?.diffBlocks.map(block => block.id), ["block-context"]);
		assert.equal(review?.diffBlocks[0]?.hunks.length, 1);
		assertNoUnmappedForFile(payload.warnings, "src/context.ts");
	});

	it("renders same-file logical cards with only their explicit hunk slices", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("first", "First hunk", hunkRefYaml("block-multi:h0")),
			reviewChunkYaml("second", "Second hunk", hunkRefYaml("block-multi:h1")),
		].join("\n"), ["first", "second"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [multiLogicalDiffBlock(2)] });
		const first = payload.cards.find(card => card.id === "significant-first");
		const second = payload.cards.find(card => card.id === "significant-second");
		assert.deepEqual(first?.diffBlocks[0]?.hunks.map(hunk => hunk.id), ["block-multi:h0"]);
		assert.deepEqual(second?.diffBlocks[0]?.hunks.map(hunk => hunk.id), ["block-multi:h1"]);
	});

	it("keeps secondary repeated hunk metadata separate from primary coverage", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("primary", "Primary hunk", hunkRefYaml("block-multi:h0")),
			reviewChunkYaml("repeat", "Repeated hunk", hunkRefYaml("block-multi:h0", "secondary", "significant-primary")),
		].join("\n"), ["primary", "repeat"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [multiLogicalDiffBlock(1)] }, { readReceipts: [{ schemaVersion: 1, id: "receipt-1", mode: "file", hunkIds: ["block-multi:h0"], truncated: false }] });
		const record = payload.coverage?.records?.find(item => item.hunkId === "block-multi:h0");
		assert.equal(record?.primaryState, "primary-reviewed");
		assert.deepEqual(record?.secondaryCardIds, ["significant-repeat"]);
		assert.equal(record?.repeatedReferenceCount, 1);
		const repeated = payload.cards.find(card => card.id === "significant-repeat");
		assert.equal(repeated?.hunkPlacements?.[0]?.placement, "secondary");
		assert.equal(repeated?.hunkPlacements?.[0]?.defaultExpanded, false);
		assert.equal(repeated?.hunkPlacements?.[0]?.primaryCardTitle, "Primary hunk");
	});

	it("rejects duplicate primary hunk ownership", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("one", "One", hunkRefYaml("block-multi:h0")),
			reviewChunkYaml("two", "Two", hunkRefYaml("block-multi:h0")),
		].join("\n"), ["one", "two"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const error = captureError(() => mapYamlToWalkthroughPayload(validation.document, { files: [multiLogicalDiffBlock(1)] }));
		assert.equal(error.code, "PRW_DUPLICATE_PRIMARY_HUNK");
		assert.equal(error.details?.conflicts?.[0]?.hunkId, "block-multi:h0");
	});

	it("rejects secondary hunk references without a primary owner", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("repeat", "Repeated hunk", hunkRefYaml("block-multi:h0", "secondary")),
		].join("\n"), ["repeat"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const error = captureError(() => mapYamlToWalkthroughPayload(validation.document, { files: [multiLogicalDiffBlock(1)] }));
		assert.equal(error.code, "PRW_SECONDARY_WITHOUT_PRIMARY");
	});

	it("rejects skipped hunk references without an explicit skip reason", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("skip", "Skipped hunk", hunkRefYaml("block-multi:h0", "skip")),
		].join("\n"), ["skip"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const error = captureError(() => mapYamlToWalkthroughPayload(validation.document, { files: [multiLogicalDiffBlock(1)] }));
		assert.equal(error.code, "PRW_SKIP_REASON_REQUIRED");
	});

	it("preserves V2 narrative order and resolves narrative anchors", () => {
		const yaml = synthesisYaml(`    - id: narrative
      phase: significant
      title: Narrative chunk
      reviewer_goal: Follow the ordered narrative.
      explanation: The narrative should drive rendering.
      files:
        - src/multi.ts
      relevant_hunks:
        - hunk_id: block-multi:h0
          placement: primary
          why_relevant: Top-level duplicate agrees with the narrative diff.
      narrative:
        - id: setup
          type: text
          body: Start with setup.
        - id: diff-one
          type: diff
          hunks:
            - hunk_id: block-multi:h0
              placement: primary
              why_relevant: Shows the change.
        - id: note-one
          type: note
          anchor:
            hunk_id: block-multi:h0
          body: Note near the diff.
        - id: comment-one
          type: suggested_comment
          severity: question
          intent: inline
          anchor:
            hunk_id: block-multi:h0
            line: 1
          body: Should this be guarded?
        - id: checks
          type: checklist
          items:
            - Check the guard.
      suggested_concerns: []
      positive_notes: []`, ["narrative"]);
		const validation = validatePrWalkthroughYaml(yaml);
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [multiLogicalDiffBlock(1)] });
		const card = payload.cards.find(item => item.id === "significant-narrative");
		assert.deepEqual(card?.narrative?.map(block => block.type), ["text", "diff", "note", "suggested_comment", "checklist"]);
		assert.deepEqual(card?.narrative?.[1], { type: "diff", id: "diff-one", hunkIds: ["block-multi:h0"] });
		assert.equal(card?.narrative?.[3]?.type, "suggested_comment");
	});

	it("treats review chunk files as metadata only", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("metadata", "Metadata only", "        []", "src/multi.ts"),
		].join("\n"), ["metadata"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [multiLogicalDiffBlock(1)] });
		const card = payload.cards.find(item => item.id === "significant-metadata");
		const audit = payload.cards.find(item => item.title === "Audit and review checklist");
		assert.deepEqual(card?.diffBlocks, []);
		assert.deepEqual(audit?.diffBlocks[0]?.hunks.map(hunk => hunk.id), ["block-multi:h0"]);
	});

	it("publishes more than twelve logical cards without truncation", () => {
		const chunks = Array.from({ length: 13 }, (_, index) => reviewChunkYaml(`chunk-${index}`, `Chunk ${index}`, hunkRefYaml(`block-${index}:h0`))).join("\n");
		const validation = validatePrWalkthroughYaml(synthesisYaml(chunks, Array.from({ length: 13 }, (_, index) => `chunk-${index}`)));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: Array.from({ length: 13 }, (_, index) => logicalDiffBlock(`block-${index}`, `src/file-${index}.ts`, 1)) });
		assert.equal(payload.cards.filter(card => card.phaseId === "significant").length, 13);
	});

	it("blocks major remaining hunks from hiding in the completion sweep", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("metadata", "Metadata only", "        []", "src/major.ts"),
		].join("\n"), ["metadata"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const error = captureError(() => mapYamlToWalkthroughPayload(validation.document, { files: [logicalDiffBlock("block-major", "src/major.ts", 8)] }));
		assert.equal(error.code, "PRW_MAJOR_REMAINING_HUNKS");
		assert.equal(error.details?.major_remaining?.[0]?.hunkId, "block-major:h0");
	});

	it("classifies hunkless binary blocks in completion-sweep coverage and audit", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("code", "Code review", hunkRefYaml("block-a:h0"), "src/a.ts"),
		].join("\n"), ["code"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, {
			files: [logicalDiffBlock("block-a", "src/a.ts", 1), binaryDiffBlock("block-bin", "assets/logo.png")],
		});

		const record = payload.coverage?.records?.find(item => item.filePath === "assets/logo.png");
		assert.ok(record, "expected the hunkless binary block to appear in coverage records");
		assert.equal(record?.binary, true);
		assert.equal(record?.primaryState, "completion-sweep-remaining");
		assert.equal(payload.coverage?.majorRemaining?.some(item => item.filePath === "assets/logo.png"), false);

		const audit = payload.cards.find(card => card.title === "Audit and review checklist");
		assert.ok(audit?.diffBlocks.some(block => block.filePath === "assets/logo.png"), "expected the binary block on the audit/completion-sweep card");
	});

	it("lets reviewers explicitly skip a hunkless binary block with a reason", () => {
		const validation = validatePrWalkthroughYaml(synthesisYaml([
			reviewChunkYaml("code", "Code review", hunkRefYaml("block-a:h0"), "src/a.ts"),
			reviewChunkYaml("skips", "Skips", skipRefYaml("assets/logo.png", "binary"), "assets/logo.png"),
		].join("\n"), ["code", "skips"]));
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, {
			files: [logicalDiffBlock("block-a", "src/a.ts", 1), binaryDiffBlock("block-bin", "assets/logo.png")],
		});

		const record = payload.coverage?.records?.find(item => item.filePath === "assets/logo.png");
		assert.equal(record?.primaryState, "skipped");
		assert.equal(record?.skippedReason, "binary");
		const audit = payload.cards.find(card => card.title === "Audit and review checklist");
		assert.match(audit?.rationale ?? "", /assets\/logo\.png \(binary\)/);
	});

	it("keeps top-level relevant_hunks visible in V2 narrative rendering", () => {
		const yaml = synthesisYaml(`    - id: narrative
      phase: significant
      title: Narrative chunk
      reviewer_goal: Follow the ordered narrative.
      explanation: The narrative should drive rendering.
      files:
        - src/multi.ts
      relevant_hunks:
        - hunk_id: block-multi:h1
          placement: primary
          why_relevant: Authored top-level ref not repeated in the narrative diff.
      narrative:
        - id: setup
          type: text
          body: Start with setup.
        - id: diff-one
          type: diff
          hunks:
            - hunk_id: block-multi:h0
              placement: primary
              why_relevant: Shows the change.
      suggested_concerns: []
      positive_notes: []`, ["narrative"]);
		const validation = validatePrWalkthroughYaml(yaml);
		assert.equal(validation.ok, true);
		if (!validation.ok) return;

		const payload = mapYamlToWalkthroughPayload(validation.document, { files: [multiLogicalDiffBlock(2)] });
		const card = payload.cards.find(item => item.id === "significant-narrative");
		const diffEntries = card?.narrative?.filter((block): block is { type: "diff"; id: string; hunkIds: string[] } => block.type === "diff") ?? [];
		const authoredDiff = diffEntries.find(entry => entry.id === "diff-one");
		assert.deepEqual(authoredDiff?.hunkIds, ["block-multi:h0"]);
		assert.ok(diffEntries.some(entry => entry.hunkIds.includes("block-multi:h1")), "expected an appended narrative diff entry for the orphaned top-level ref");
		assert.ok(card?.diffBlocks.some(block => block.hunks.some(hunk => hunk.id === "block-multi:h1")), "orphaned top-level ref should still be present in diffBlocks");
	});
});

function synthesisYaml(reviewChunks: string, chunkOrder: string[]): string {
	return `schema_version: 1
pr:
  provider: github
  owner: SuuBro
  repo: bobbit
  number: 42
  title: Logical cards
  url: https://github.com/SuuBro/bobbit/pull/42
  base_sha: abcdef1234567890
  head_sha: fedcba9876543210
  original_description:
    body: Test logical cards.
    source: gh_api
    fetched_at: "2026-05-30T00:00:00.000Z"
  stats:
    files_changed: 1
    additions: 2
    deletions: 0
walkthrough:
  context:
    why_created: Test logical card synthesis.
    problem_solved: Cards should map to explicit hunks.
    why_worth_merging: It keeps reviews focused.
    merge_concerns: Keep coverage visible.
    author_intent: Exercise shared synthesis.
    reviewer_map: Review chunks in order.
  merge_assessment:
    recommendation: comment
    confidence: high
    summary: Focused synthesis looks good.
    blocking_concerns: []
    non_blocking_concerns: []
  design_decisions: []
  review_chunks:
${reviewChunks}
  omissions_and_followups: []
  audit:
    remaining_changed_areas: []
    low_signal_or_mechanical_changes: []
    generated_or_binary_files: []
    reviewer_checklist:
      - Confirm hunk coverage.
  display:
    phase_order:
      - orientation
      - design
      - significant
      - other
      - audit
    chunk_order:
${chunkOrder.map(id => `      - ${id}`).join("\n")}
`;
}

function reviewChunkYaml(id: string, title: string, relevantHunks: string, file = "src/multi.ts"): string {
	return `    - id: ${id}
      phase: significant
      title: ${title}
      reviewer_goal: Review ${title}.
      explanation: Explains ${title}.
      files:
        - ${file}
      relevant_hunks:
${relevantHunks}
      suggested_concerns: []
      positive_notes: []`;
}

function hunkRefYaml(hunkId: string, placement = "primary", primaryCardId?: string): string {
	return `        - hunk_id: ${hunkId}
          placement: ${placement}${primaryCardId ? `\n          primary_card_id: ${primaryCardId}` : ""}
          why_relevant: Covers ${hunkId}.`;
}

function multiLogicalDiffBlock(hunkCount: number): PrWalkthroughDiffBlock {
	return {
		id: "block-multi",
		filePath: "src/multi.ts",
		status: "modified",
		hunks: Array.from({ length: hunkCount }, (_, index) => ({
			id: `block-multi:h${index}`,
			header: `@@ -${index + 1},1 +${index + 1},2 @@`,
			lines: [{ id: `block-multi:h${index}:l0`, side: "new", newLine: index + 1, text: `change ${index}`, kind: "add" }],
		})),
	};
}

function logicalDiffBlock(id: string, filePath: string, changedLines: number): PrWalkthroughDiffBlock {
	return {
		id,
		filePath,
		status: "modified",
		hunks: [{
			id: `${id}:h0`,
			header: "@@ -1,1 +1,1 @@",
			lines: Array.from({ length: changedLines }, (_, index) => ({ id: `${id}:h0:l${index}`, side: "new", newLine: index + 1, text: `change ${index}`, kind: "add" })),
		}],
	};
}

function binaryDiffBlock(id: string, filePath: string): PrWalkthroughDiffBlock {
	return { id, filePath, status: "binary", isBinary: true, hunks: [] };
}

function skipRefYaml(file: string, reason: string): string {
	return `        - file: ${file}
          placement: skip
          skip_reason: ${reason}
          why_relevant: ${reason} change with no textual diff.`;
}

function captureError(fn: () => unknown): Error & { code?: string; retryable?: boolean; details?: any } {
	let caught: unknown;
	try {
		fn();
	} catch (error) {
		caught = error;
	}
	assert.ok(caught, "Expected function to throw.");
	return caught as Error & { code?: string; retryable?: boolean; details?: any };
}

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
	const hunkItems = [
		{ header: hunkHeader, why: "Primary mapped context change." },
		...extraRelevantHunks,
	];
	const designRelevantHunks = hunkItems.map(item => `        - file: src/context.ts
          hunk_header: "${yamlDoubleQuoted(item.header)}"
          placement: secondary
          primary_card_id: significant-context-review
          why_relevant: ${item.why}`).join("\n");
	const reviewRelevantHunks = hunkItems.map(item => `        - file: src/context.ts
          hunk_header: "${yamlDoubleQuoted(item.header)}"
          placement: primary
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
${designRelevantHunks}
  review_chunks:
    - id: context-review
      phase: significant
      title: Context review
      reviewer_goal: Check hunk references map without noisy warnings.
      explanation: Suggested comments should anchor to the same hunk.
      files:
        - src/context.ts
      relevant_hunks:
${reviewRelevantHunks}
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
    diff_breakdown:
      prod_executable_code:
        files: 2
        additions: 120
        deletions: 12
        note: Runtime and API path changes only.
      test_code:
        files: 1
        additions: 44
        deletions: 4
        note: Unit fixture coverage.
      code_and_comments:
        files: 3
        additions: 180
        deletions: 18
        note: Includes comments and docstrings in code files.
      docs_only:
        files: 1
        additions: 9
        deletions: 0
        note: Reviewer-facing instructions.
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
          placement: secondary
          primary_card_id: significant-chunk-api
          why_relevant: Shows the submission path.
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
            - file: src/missing.ts
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
      - Confirm browser coverage before merge.
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
