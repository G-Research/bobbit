/**
 * Unit tests for the prompt-template conditional processor
 * (`applyPromptConditionals` in src/server/agent/prompt-conditionals.ts) plus a
 * validity scan over the shipped role/assistant templates.
 *
 * Syntax: `{if:NAME} … {endif:NAME}` — symmetric named tags so mismatches and
 * nesting are validatable. A block is kept iff `flags[NAME]` is truthy and all
 * enclosing blocks are kept; unknown flags fail closed (body removed); a
 * malformed template throws.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { applyPromptConditionals } from "../src/server/agent/prompt-conditionals.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

describe("applyPromptConditionals", () => {
	it("returns text unchanged when there are no conditional tags", () => {
		const t = "plain prompt with {{AGENT_ID}} but no conditionals";
		assert.equal(applyPromptConditionals(t, { subGoalsEnabled: false }), t);
	});

	it("keeps a block when its flag is true", () => {
		const t = "A {if:subGoalsEnabled}B{endif:subGoalsEnabled} C";
		assert.equal(applyPromptConditionals(t, { subGoalsEnabled: true }), "A B C");
	});

	it("drops a block (and its tags) when its flag is false", () => {
		const t = "A {if:subGoalsEnabled}B{endif:subGoalsEnabled} C";
		assert.equal(applyPromptConditionals(t, { subGoalsEnabled: false }), "A  C");
	});

	it("treats an unknown flag as false (fails closed)", () => {
		const t = "A {if:unknownFlag}secret{endif:unknownFlag} C";
		assert.equal(applyPromptConditionals(t, {}), "A  C");
	});

	it("handles nested blocks — inner kept only when outer is kept", () => {
		const t = "[{if:outer}o1 {if:inner}i{endif:inner} o2{endif:outer}]";
		assert.equal(applyPromptConditionals(t, { outer: true, inner: true }), "[o1 i o2]");
		assert.equal(applyPromptConditionals(t, { outer: true, inner: false }), "[o1  o2]");
		// Outer false → whole block (incl. inner) dropped regardless of inner.
		assert.equal(applyPromptConditionals(t, { outer: false, inner: true }), "[]");
	});

	it("throws on an unmatched endif", () => {
		assert.throws(() => applyPromptConditionals("x {endif:foo} y", {}), /unmatched \{endif:foo\}/);
	});

	it("throws on a name mismatch between if and endif", () => {
		assert.throws(
			() => applyPromptConditionals("{if:foo}x{endif:bar}", { foo: true, bar: true }),
			/\{if:foo\} closed by \{endif:bar\}/,
		);
	});

	it("throws on an unclosed if", () => {
		assert.throws(() => applyPromptConditionals("{if:foo}x", { foo: true }), /unclosed \{if:foo\}/);
	});
});

/** All conditional flag names the runtime knows how to resolve. */
const KNOWN_FLAGS = new Set(["subGoalsEnabled"]);

/** Gather the prompt text from a role/assistant YAML (promptTemplate or prompt). */
function promptOf(file: string): string {
	const doc = yamlParse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
	return (typeof doc.promptTemplate === "string" ? doc.promptTemplate : "")
		+ "\n" + (typeof doc.prompt === "string" ? doc.prompt : "");
}

function listYaml(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...listYaml(p));
		else if (e.name.endsWith(".yaml")) out.push(p);
	}
	return out;
}

describe("shipped prompt templates — conditional validity", () => {
	const files = [
		...listYaml(path.join(REPO, "defaults", "roles")),
	];

	it("found role/assistant templates to scan", () => {
		assert.ok(files.length > 0, "expected at least one role YAML under defaults/roles");
	});

	for (const file of files) {
		const rel = path.relative(REPO, file);
		it(`${rel}: conditionals are balanced and use known flags only`, () => {
			const text = promptOf(file);
			// Balanced/well-formed under both flag states (throws on malformed).
			assert.doesNotThrow(() => applyPromptConditionals(text, { subGoalsEnabled: true }));
			assert.doesNotThrow(() => applyPromptConditionals(text, { subGoalsEnabled: false }));
			// No leftover markers after processing with the real flag set.
			for (const v of [true, false]) {
				const out = applyPromptConditionals(text, { subGoalsEnabled: v });
				assert.ok(!out.includes("{if:"), `${rel}: leftover {if:} marker (flag=${v})`);
				assert.ok(!out.includes("{endif:"), `${rel}: leftover {endif:} marker (flag=${v})`);
			}
			// Every referenced flag name must be one the runtime resolves.
			const names = new Set<string>();
			for (const m of text.matchAll(/\{(?:if|endif):([A-Za-z0-9_]+)\}/g)) names.add(m[1]);
			for (const n of names) {
				assert.ok(KNOWN_FLAGS.has(n), `${rel}: unknown conditional flag {if:${n}} — add it to KNOWN_FLAGS and wire a value`);
			}
		});
	}
});
