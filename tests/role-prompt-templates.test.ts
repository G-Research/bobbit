/**
 * Pinning test for the LSP "Tool selection — symbol queries" section in
 * coding/reviewing role prompts.
 *
 * Soft signals (AGENTS.md nudge, system-prompt Symbol-lookup hint, tool
 * descriptions) have failed to drive LSP-over-grep adoption. The role
 * prompts themselves now carry a hard MUST rule for symbol queries.
 *
 * This test pins the section header into the four roles that perform
 * symbol-level code work: `coder`, `reviewer`, `code-reviewer`,
 * `security-reviewer`. Accidental removal will fail the suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rolesDir = path.resolve(__dirname, "../defaults/roles");

const SECTION_HEADER = "## Tool selection — symbol queries";

const CODING_ROLES = ["coder", "reviewer", "code-reviewer", "security-reviewer"];

for (const role of CODING_ROLES) {
	test(`${role}.yaml promptTemplate contains "${SECTION_HEADER}"`, () => {
		const file = path.join(rolesDir, `${role}.yaml`);
		const raw = fs.readFileSync(file, "utf-8");
		const doc = YAML.parse(raw) as { promptTemplate?: string };
		assert.ok(
			typeof doc.promptTemplate === "string" && doc.promptTemplate.length > 0,
			`${role}.yaml must define a promptTemplate`,
		);
		assert.ok(
			doc.promptTemplate!.includes(SECTION_HEADER),
			`${role}.yaml promptTemplate must contain the literal "${SECTION_HEADER}" section header`,
		);
	});
}

test("reviewer.yaml + code-reviewer.yaml mention lsp_references for blast-radius tracing", () => {
	for (const role of ["reviewer", "code-reviewer"]) {
		const raw = fs.readFileSync(path.join(rolesDir, `${role}.yaml`), "utf-8");
		assert.match(
			raw,
			/lsp_references[^\n]*callers/,
			`${role}.yaml must instruct the agent to use lsp_references for caller lookups`,
		);
	}
});

test("security-reviewer.yaml mentions lsp_references for sink-caller enumeration", () => {
	const raw = fs.readFileSync(path.join(rolesDir, "security-reviewer.yaml"), "utf-8");
	assert.match(
		raw,
		/lsp_references[^\n]*sink/,
		"security-reviewer.yaml must instruct the agent to use lsp_references for sink callers",
	);
});
