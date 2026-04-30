/**
 * Unit tests for the acceptance-criteria parser.
 *
 * See `docs/design/nested-goals.md` §1.3 and `src/server/agent/acceptance-criteria.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseAcceptanceCriteria } from "../src/server/agent/acceptance-criteria.ts";
import { parseAcceptanceCriteria as parseAcceptanceCriteriaShared } from "../src/shared/acceptance-criteria.ts";

describe("parseAcceptanceCriteria", () => {
	it("server re-export and shared module are the same function", () => {
		assert.equal(parseAcceptanceCriteria, parseAcceptanceCriteriaShared);
	});

	it("returns [] when there is no acceptance-criteria heading", () => {
		const spec = "# Title\n\nSome prose with no list of criteria at all.";
		assert.deepEqual(parseAcceptanceCriteria(spec), []);
	});

	it("returns [] for an empty input string", () => {
		assert.deepEqual(parseAcceptanceCriteria(""), []);
		assert.deepEqual(parseAcceptanceCriteria(undefined as unknown as string), []);
	});

	it("returns [] when the section is present but empty", () => {
		const spec = "## Acceptance criteria\n\n## Out of scope\n- nothing";
		assert.deepEqual(parseAcceptanceCriteria(spec), []);
	});

	it("parses a flat bulleted list", () => {
		const spec = `## Acceptance criteria

- A user can create a goal.
- A user can archive a goal.
- The dashboard shows live status.`;
		assert.deepEqual(parseAcceptanceCriteria(spec), [
			"A user can create a goal.",
			"A user can archive a goal.",
			"The dashboard shows live status.",
		]);
	});

	it("parses a numbered list (`1.`)", () => {
		const spec = `## Acceptance criteria

1. First criterion.
2. Second criterion.
3. Third criterion.`;
		assert.deepEqual(parseAcceptanceCriteria(spec), [
			"First criterion.",
			"Second criterion.",
			"Third criterion.",
		]);
	});

	it("parses a numbered list with `1)` style", () => {
		const spec = `## Acceptance criteria

1) Alpha
2) Beta`;
		assert.deepEqual(parseAcceptanceCriteria(spec), ["Alpha", "Beta"]);
	});

	it("recognises asterisk and plus list markers", () => {
		const spec = `## Acceptance criteria

* Star item
+ Plus item`;
		assert.deepEqual(parseAcceptanceCriteria(spec), ["Star item", "Plus item"]);
	});

	it("matches the heading case-insensitively and tolerates trailing colon", () => {
		const spec1 = "## acceptance criteria\n- One";
		const spec2 = "## ACCEPTANCE CRITERIA\n- Two";
		const spec3 = "## Acceptance Criteria:\n- Three";
		assert.deepEqual(parseAcceptanceCriteria(spec1), ["One"]);
		assert.deepEqual(parseAcceptanceCriteria(spec2), ["Two"]);
		assert.deepEqual(parseAcceptanceCriteria(spec3), ["Three"]);
	});

	it("stops at the next heading", () => {
		const spec = `## Acceptance criteria

- Inside one
- Inside two

## Out of scope

- Should not appear`;
		assert.deepEqual(parseAcceptanceCriteria(spec), ["Inside one", "Inside two"]);
	});

	it("stops at a deeper sub-heading inside the section", () => {
		const spec = `## Acceptance criteria

- Top level item

### Nested heading

- This must NOT be picked up`;
		assert.deepEqual(parseAcceptanceCriteria(spec), ["Top level item"]);
	});

	it("flattens sub-bullets into the parent item with newline separators", () => {
		const spec = `## Acceptance criteria

- Parent item
  - First sub
  - Second sub
- Another parent`;
		const out = parseAcceptanceCriteria(spec);
		assert.equal(out.length, 2);
		assert.match(out[0], /Parent item/);
		assert.match(out[0], /First sub/);
		assert.match(out[0], /Second sub/);
		assert.equal(out[1], "Another parent");
	});

	it("handles multi-line continuation paragraphs as part of the parent item", () => {
		const spec = `## Acceptance criteria

- The system supports multi-line items
  with continuation text spread across multiple lines
- Next item`;
		const out = parseAcceptanceCriteria(spec);
		assert.equal(out.length, 2);
		assert.match(out[0], /multi-line items/);
		assert.match(out[0], /continuation text/);
		assert.equal(out[1], "Next item");
	});

	it("collapses runs of internal whitespace within an item", () => {
		const spec = "## Acceptance criteria\n- A   word    with   gaps";
		assert.deepEqual(parseAcceptanceCriteria(spec), ["A word with gaps"]);
	});

	it("ignores non-list paragraph lines inside the section", () => {
		const spec = `## Acceptance criteria

This is some prose, ignored.

- Real criterion 1
- Real criterion 2

More prose, ignored.`;
		assert.deepEqual(parseAcceptanceCriteria(spec), [
			"Real criterion 1",
			"Real criterion 2",
		]);
	});

	it("handles CRLF line endings", () => {
		const spec = "## Acceptance criteria\r\n\r\n- A\r\n- B\r\n";
		assert.deepEqual(parseAcceptanceCriteria(spec), ["A", "B"]);
	});

	it("only consumes the first matching section", () => {
		const spec = `## Acceptance criteria

- Real one

## Acceptance criteria

- Duplicate section, must NOT bleed in`;
		// after the first section ends at the next ## heading, the duplicate
		// section is treated as a fresh "## Acceptance criteria" but our parser
		// only looks for the first occurrence — so the duplicate is ignored.
		assert.deepEqual(parseAcceptanceCriteria(spec), ["Real one"]);
	});

	it("preserves embedded punctuation and markdown inline formatting verbatim", () => {
		const spec = "## Acceptance criteria\n- The `goal-store` module exports `GoalStore`.\n- A user can do **bold** things.";
		assert.deepEqual(parseAcceptanceCriteria(spec), [
			"The `goal-store` module exports `GoalStore`.",
			"A user can do **bold** things.",
		]);
	});

	it("reaches end of file without a terminating heading", () => {
		const spec = `## Acceptance criteria
- only item`;
		assert.deepEqual(parseAcceptanceCriteria(spec), ["only item"]);
	});

	it("drops empty list items", () => {
		const spec = `## Acceptance criteria

-
- real
-   `;
		assert.deepEqual(parseAcceptanceCriteria(spec), ["real"]);
	});
});
