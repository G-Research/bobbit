/**
 * Pinning tests for the canonical LSP-before-text-search rule.
 *
 * The hard rule lives ONCE in the base system prompt
 * (`defaults/system-prompt.md`) so every agent gets it regardless of role
 * or project override. Role YAMLs MUST NOT carry a duplicate
 * `## Tool selection — symbol queries` section — earlier role-local
 * copies were removed when the rule was promoted into the base prompt.
 *
 * These tests pin:
 *   1. The canonical section exists in `defaults/system-prompt.md` with
 *      the expected header and covers `grep`, `rg`, `ripgrep`, `git grep`,
 *      `ag`, `ack`, and bash/shell wrappers.
 *   2. None of the coding/reviewing role YAMLs reintroduce a duplicate
 *      LSP section.
 *   3. Reviewer / code-reviewer / security-reviewer still instruct the
 *      agent to use `lsp_references` for their specific tracing tasks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rolesDir = path.resolve(repoRoot, "defaults/roles");
const systemPromptFile = path.resolve(repoRoot, "defaults/system-prompt.md");

const CANONICAL_HEADER = "## Tool selection — LSP before text search";
const LEGACY_HEADER = "## Tool selection — symbol queries";

const CODING_ROLES = ["coder", "reviewer", "code-reviewer", "security-reviewer"];

test(`defaults/system-prompt.md contains the canonical "${CANONICAL_HEADER}" section exactly once`, () => {
	const raw = fs.readFileSync(systemPromptFile, "utf-8");
	const matches = raw.split(CANONICAL_HEADER).length - 1;
	assert.equal(
		matches,
		1,
		`Expected exactly one "${CANONICAL_HEADER}" section in defaults/system-prompt.md, found ${matches}`,
	);
});

test("canonical LSP rule covers grep/rg/ripgrep/git grep/ag/ack/bash and key LSP calls", () => {
	const raw = fs.readFileSync(systemPromptFile, "utf-8");
	const headerIdx = raw.indexOf(CANONICAL_HEADER);
	assert.ok(headerIdx >= 0, "canonical section header missing");
	const rest = raw.slice(headerIdx + CANONICAL_HEADER.length);
	const nextH2 = rest.search(/\n\s*##\s/);
	const body = nextH2 >= 0 ? rest.slice(0, nextH2) : rest;

	for (const token of [
		"grep",
		"rg",
		"ripgrep",
		"git grep",
		"ag",
		"ack",
		"bash",
		"lsp_workspace_symbol",
		'lsp_definition({ symbolName: "X" })',
		"lsp_references",
		"lsp_hover",
		"lsp_diagnostics",
		"lsp_document_symbols",
		"[lsp-hint]",
	]) {
		assert.ok(
			body.includes(token),
			`canonical LSP section must mention \`${token}\``,
		);
	}
});

for (const role of CODING_ROLES) {
	test(`${role}.yaml has a non-empty promptTemplate`, () => {
		const file = path.join(rolesDir, `${role}.yaml`);
		const raw = fs.readFileSync(file, "utf-8");
		const doc = YAML.parse(raw) as { promptTemplate?: string };
		assert.ok(
			typeof doc.promptTemplate === "string" && doc.promptTemplate.length > 0,
			`${role}.yaml must define a promptTemplate`,
		);
	});

	test(`${role}.yaml does NOT reintroduce the legacy "${LEGACY_HEADER}" section`, () => {
		const file = path.join(rolesDir, `${role}.yaml`);
		const raw = fs.readFileSync(file, "utf-8");
		assert.ok(
			!raw.includes(LEGACY_HEADER),
			`${role}.yaml must not duplicate the LSP rule — canonical section now lives in defaults/system-prompt.md`,
		);
	});

	test(`${role}.yaml does NOT reintroduce the canonical "${CANONICAL_HEADER}" section`, () => {
		const file = path.join(rolesDir, `${role}.yaml`);
		const raw = fs.readFileSync(file, "utf-8");
		assert.ok(
			!raw.includes(CANONICAL_HEADER),
			`${role}.yaml must not duplicate the canonical LSP section — it belongs in defaults/system-prompt.md only`,
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
