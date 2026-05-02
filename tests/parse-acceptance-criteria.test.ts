/**
 * Tests for src/shared/parse-acceptance-criteria.ts — pure helper for
 * extracting "## Acceptance criteria" list items from spec markdown.
 *
 * Used by GoalManager.createGoal to auto-populate
 * PersistedGoal.acceptanceCriteria, and by the plan-mutation classifier
 * (Phase 4) to gate criteria-drop mutations.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseAcceptanceCriteria } from "../src/shared/parse-acceptance-criteria.ts";

describe("parseAcceptanceCriteria — basic shapes", () => {
	it("parses a simple bullet list under '## Acceptance criteria'", () => {
		const md = `# Spec

Some intro paragraph.

## Acceptance criteria

- The user can sign in
- The user can sign out
- The session is persisted

## Implementation notes

Whatever.
`;
		assert.deepEqual(parseAcceptanceCriteria(md), [
			"The user can sign in",
			"The user can sign out",
			"The session is persisted",
		]);
	});

	it("matches case-insensitively across heading depths H1, H2, H3", () => {
		assert.deepEqual(
			parseAcceptanceCriteria("# Acceptance criteria\n- foo\n- bar\n"),
			["foo", "bar"],
		);
		assert.deepEqual(
			parseAcceptanceCriteria("## acceptance criteria\n- baz\n"),
			["baz"],
		);
		assert.deepEqual(
			parseAcceptanceCriteria("### Acceptance Criteria\n- qux\n"),
			["qux"],
		);
	});

	it("supports mixed bullet styles in the same list (-, *, 1., 1))", () => {
		const md = `## Acceptance criteria
- dash
* asterisk
1. numbered with period
2) numbered with paren
`;
		assert.deepEqual(parseAcceptanceCriteria(md), [
			"dash",
			"asterisk",
			"numbered with period",
			"numbered with paren",
		]);
	});

	it("parses a numbered list 1.,2.,3.", () => {
		const md = `## Acceptance criteria
1. foo
2. bar
3. baz
`;
		assert.deepEqual(parseAcceptanceCriteria(md), ["foo", "bar", "baz"]);
	});
});

describe("parseAcceptanceCriteria — section boundaries", () => {
	it("section ends at the next heading of equal depth", () => {
		const md = `## Acceptance criteria
- one
- two

## Other

- three
- four
`;
		// "three" / "four" are NOT acceptance criteria — they belong to "Other".
		assert.deepEqual(parseAcceptanceCriteria(md), ["one", "two"]);
	});

	it("section ends at a shallower heading even if inside H3 acceptance section", () => {
		const md = `### Acceptance criteria
- one
- two

## Top

- three
`;
		assert.deepEqual(parseAcceptanceCriteria(md), ["one", "two"]);
	});

	it("section ends at end of file when no following heading", () => {
		const md = `## Acceptance criteria
- only
- items
`;
		assert.deepEqual(parseAcceptanceCriteria(md), ["only", "items"]);
	});

	it("deeper headings inside the section terminate the in-flight item but the section continues", () => {
		const md = `## Acceptance criteria
- foo

### Sub-section that's still part of the section

- bar
- baz
`;
		assert.deepEqual(parseAcceptanceCriteria(md), ["foo", "bar", "baz"]);
	});
});

describe("parseAcceptanceCriteria — multi-paragraph / continuation handling", () => {
	it("flattens an indented continuation line into the prior item with a single space", () => {
		const md = `## Acceptance criteria
- The user can sign in
  and stays signed in across reloads
- The user can sign out
`;
		assert.deepEqual(parseAcceptanceCriteria(md), [
			"The user can sign in and stays signed in across reloads",
			"The user can sign out",
		]);
	});

	it("blank line between continuation and next bullet starts a fresh item", () => {
		const md = `## Acceptance criteria
- first item

- second item
`;
		assert.deepEqual(parseAcceptanceCriteria(md), ["first item", "second item"]);
	});
});

describe("parseAcceptanceCriteria — code fence handling", () => {
	it("does not parse bullets that live inside a fenced code block in the section", () => {
		const md = `## Acceptance criteria
- real one
\`\`\`
- not an item (inside fence)
* also not
\`\`\`
- real two
`;
		assert.deepEqual(parseAcceptanceCriteria(md), ["real one", "real two"]);
	});

	it("does not match the heading itself when buried inside a fence higher in the doc", () => {
		const md = `# Spec

Some text.

\`\`\`
## Acceptance criteria
- fake
\`\`\`

Real content with no acceptance section.
`;
		assert.deepEqual(parseAcceptanceCriteria(md), []);
	});

	it("supports tilde fences (~~~) as well as backtick fences", () => {
		const md = `## Acceptance criteria
- alpha
~~~
- inside tilde fence
~~~
- beta
`;
		assert.deepEqual(parseAcceptanceCriteria(md), ["alpha", "beta"]);
	});
});

describe("parseAcceptanceCriteria — empty / missing", () => {
	it("returns [] for missing section", () => {
		const md = `# Spec

Some intro.

## Other

- foo
`;
		assert.deepEqual(parseAcceptanceCriteria(md), []);
	});

	it("returns [] for an empty section", () => {
		const md = `## Acceptance criteria

## Next section
`;
		assert.deepEqual(parseAcceptanceCriteria(md), []);
	});

	it("returns [] for empty input", () => {
		assert.deepEqual(parseAcceptanceCriteria(""), []);
	});

	it("returns [] for null-ish input shapes", () => {
		// JS callers may pass undefined-ish content; behaviour should be []
		assert.deepEqual(parseAcceptanceCriteria(undefined as unknown as string), []);
		assert.deepEqual(parseAcceptanceCriteria(null as unknown as string), []);
	});
});

describe("parseAcceptanceCriteria — whitespace handling", () => {
	it("trims leading and trailing whitespace from items but preserves internal whitespace", () => {
		const md = `## Acceptance criteria
-    foo bar    baz
- ok
`;
		const items = parseAcceptanceCriteria(md);
		// Leading/trailing trimmed, internal collapse NOT performed at this
		// layer (the criteria-coverage check normalises internally later).
		assert.equal(items.length, 2);
		assert.equal(items[0], "foo bar    baz");
		assert.equal(items[1], "ok");
	});

	it("ignores items that are pure whitespace", () => {
		const md = `## Acceptance criteria
- real
-
- also real
`;
		assert.deepEqual(parseAcceptanceCriteria(md), ["real", "also real"]);
	});
});
