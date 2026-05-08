/**
 * Reproduces the naive YAML frontmatter parser bug in
 * `src/server/skills/slash-skills.ts` (regex-based parseFrontmatter).
 *
 * These tests are expected to FAIL on the current parser and PASS once it
 * is replaced with `YAML.parse`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { parseFrontmatter } = await import("../src/server/skills/slash-skills.ts");

describe("parseFrontmatter", () => {
	it("parses block-list values into string[]", () => {
		const raw = [
			"---",
			"name: pen-test",
			"allowed_tools:",
			"  - bash",
			"  - bash_bg",
			"---",
			"BODY",
		].join("\n");
		const { frontmatter, content } = parseFrontmatter(raw);
		assert.deepEqual((frontmatter as any).allowed_tools, ["bash", "bash_bg"]);
		assert.equal(content, "BODY");
	});

	it("parses folded multi-line description into a single joined string", () => {
		const raw = [
			"---",
			"name: foo",
			"description: >",
			"  line one",
			"  line two",
			"---",
			"BODY",
		].join("\n");
		const { frontmatter } = parseFrontmatter(raw);
		const desc = (frontmatter as any).description;
		assert.equal(typeof desc, "string");
		assert.ok(desc && desc.length > 0, `expected non-empty description, got ${JSON.stringify(desc)}`);
		assert.match(desc, /line one/);
		assert.match(desc, /line two/);
	});

	it("strips surrounding quotes on quoted strings with embedded colon", () => {
		const raw = [
			"---",
			"name: foo",
			'description: "a: b"',
			"---",
			"BODY",
		].join("\n");
		const { frontmatter } = parseFrontmatter(raw);
		assert.equal((frontmatter as any).description, "a: b");
	});

	it("coerces boolean values (existing behavior)", () => {
		const raw = [
			"---",
			"name: foo",
			"disable-model-invocation: true",
			"---",
			"BODY",
		].join("\n");
		const { frontmatter } = parseFrontmatter(raw);
		assert.equal((frontmatter as any)["disable-model-invocation"], true);
	});

	it("returns {frontmatter:{}, content:raw} when no fences present", () => {
		const raw = "no frontmatter here\njust body text";
		const result = parseFrontmatter(raw);
		assert.deepEqual(result.frontmatter, {});
		assert.equal(result.content, raw);
	});
});
