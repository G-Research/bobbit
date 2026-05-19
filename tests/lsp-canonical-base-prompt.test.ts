/**
 * Pinning tests for the canonical LSP-before-text-search rule in the **base**
 * system prompt (`defaults/system-prompt.md`).
 *
 * Replaces the role-yaml-only injection: every agent prompt — regardless of
 * role, team-lead status, or project role override — must carry exactly one
 * `## Tool selection — LSP before text search` section by virtue of the base
 * prompt always being included.
 *
 * See goal: "LSP rule in system prompt" (goal/lsp-rule-i-9801e4f2).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { initPromptDirs, assembleSystemPrompt } from "../src/server/agent/system-prompt.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rolesDir = path.resolve(__dirname, "../defaults/roles");
const defaultsSystemPrompt = path.resolve(__dirname, "../defaults/system-prompt.md");

const CANONICAL_HEADER = "## Tool selection — LSP before text search";

let tmpDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-canonical-prompt-"));
	initPromptDirs(tmpDir);
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Read role yaml and return its promptTemplate (or empty string). */
function loadRoleTemplate(roleName: string): string {
	const file = path.join(rolesDir, `${roleName}.yaml`);
	if (!fs.existsSync(file)) return "";
	const doc = YAML.parse(fs.readFileSync(file, "utf-8")) as { promptTemplate?: string };
	return doc?.promptTemplate ?? "";
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
	let n = 0;
	let from = 0;
	while (true) {
		const i = haystack.indexOf(needle, from);
		if (i < 0) return n;
		n++;
		from = i + needle.length;
	}
}

/** Assemble a prompt for a given role with the real base system prompt included. */
function assembleForRole(
	sessionId: string,
	roleName: string | undefined,
	opts: { allowedTools?: string[]; rolePromptOverride?: string } = {},
): string {
	const rolePrompt =
		opts.rolePromptOverride !== undefined
			? opts.rolePromptOverride
			: roleName
				? loadRoleTemplate(roleName)
				: undefined;
	// Pin against the repo's shipped defaults/system-prompt.md (not any
	// developer's `.bobbit/config/system-prompt.md` overlay that
	// `resolveSystemPromptPath()` would pick up).
	const promptPath = assembleSystemPrompt(sessionId, {
		baseSystemPromptPath: defaultsSystemPrompt,
		cwd: tmpDir,
		goalSpec: "Test goal spec.",
		goalTitle: "Test",
		goalState: "active",
		roleName,
		rolePrompt: rolePrompt || undefined,
		// Avoid the conditional `buildLspSymbolLookupHint()` section (which uses
		// the legacy `## Symbol-lookup hint` heading) — we only want to test the
		// canonical base-prompt rule here. Passing an allowedTools list without
		// any `lsp_*` entries suppresses that hint.
		allowedTools: opts.allowedTools ?? ["read", "bash", "grep", "find", "ls"],
	});
	assert.ok(promptPath, "assembleSystemPrompt must return a path");
	return fs.readFileSync(promptPath, "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Source-of-truth: defaults/system-prompt.md
// ---------------------------------------------------------------------------

describe("defaults/system-prompt.md — canonical LSP rule", () => {
	it("file exists", () => {
		assert.ok(fs.existsSync(defaultsSystemPrompt), `expected ${defaultsSystemPrompt} to exist`);
	});

	it("contains exactly one canonical section heading", () => {
		const raw = fs.readFileSync(defaultsSystemPrompt, "utf-8");
		assert.strictEqual(
			count(raw, CANONICAL_HEADER),
			1,
			`Expected exactly one "${CANONICAL_HEADER}" heading in defaults/system-prompt.md`,
		);
	});

	it("documents lsp_definition with symbolName example", () => {
		const raw = fs.readFileSync(defaultsSystemPrompt, "utf-8");
		assert.ok(
			raw.includes(`lsp_definition({ symbolName: "X" })`),
			'Base prompt must include the literal example `lsp_definition({ symbolName: "X" })`',
		);
	});

	it("covers grep/rg/ripgrep/git grep/ag/ack and shell search", () => {
		const raw = fs.readFileSync(defaultsSystemPrompt, "utf-8");
		// Scope to the canonical section body.
		const start = raw.indexOf(CANONICAL_HEADER);
		assert.ok(start >= 0);
		// Body runs to the next H2 heading or EOF.
		const tail = raw.slice(start + CANONICAL_HEADER.length);
		const nextH2 = tail.search(/\n## /);
		const body = nextH2 < 0 ? tail : tail.slice(0, nextH2);
		for (const token of ["grep", "rg", "ripgrep", "git grep", "ag", "ack"]) {
			assert.ok(
				body.includes(token),
				`Canonical LSP section must mention text-search tool "${token}"\nBody:\n${body}`,
			);
		}
	});

	it("mentions the [lsp-hint] guidance", () => {
		const raw = fs.readFileSync(defaultsSystemPrompt, "utf-8");
		assert.ok(
			raw.includes("[lsp-hint]"),
			"Canonical LSP section should reference the `[lsp-hint]` marker in search results",
		);
	});

	it("places the canonical LSP section before generic read/grep/bash guidance", () => {
		const raw = fs.readFileSync(defaultsSystemPrompt, "utf-8");
		const lsp = raw.indexOf(CANONICAL_HEADER);
		const readGuidance = raw.indexOf("# How to read files and gather information");
		assert.ok(lsp >= 0, "canonical LSP section must exist");
		assert.ok(readGuidance >= 0, "generic read/grep/bash guidance must exist");
		assert.ok(
			lsp < readGuidance,
			"Canonical LSP section should appear before generic read/grep/bash guidance so agents see it first",
		);
	});
});

// ---------------------------------------------------------------------------
// 2. Final-assembled prompt coverage per role
// ---------------------------------------------------------------------------

// (roleName, sessionId-tag) tuples. `null` roleName = plain/general session
// without a role prompt (still receives the base prompt).
const ROLE_CASES: Array<{ tag: string; roleName: string | undefined }> = [
	{ tag: "plain-general", roleName: undefined },
	{ tag: "general-role", roleName: "general" },
	{ tag: "team-lead", roleName: "team-lead" },
	{ tag: "coder", roleName: "coder" },
	{ tag: "reviewer", roleName: "reviewer" },
	{ tag: "code-reviewer", roleName: "code-reviewer" },
	{ tag: "architect", roleName: "architect" },
	{ tag: "spec-auditor", roleName: "spec-auditor" },
	{ tag: "docs-writer", roleName: "docs-writer" },
	{ tag: "qa-tester", roleName: "qa-tester" },
	{ tag: "test-engineer", roleName: "test-engineer" },
];

describe("assembleSystemPrompt — canonical LSP rule reaches every role", () => {
	for (const { tag, roleName } of ROLE_CASES) {
		it(`${tag}: prompt contains exactly one canonical LSP heading`, () => {
			const content = assembleForRole(`canonical-${tag}`, roleName);
			const n = count(content, CANONICAL_HEADER);
			assert.strictEqual(
				n,
				1,
				`Expected exactly one "${CANONICAL_HEADER}" in ${tag} prompt, got ${n}.\n` +
				`Prompt excerpt:\n${content.slice(0, 400)}\n...`,
			);
		});

		it(`${tag}: prompt mentions rg, ripgrep, git grep`, () => {
			const content = assembleForRole(`canonical-tokens-${tag}`, roleName);
			for (const token of ["rg", "ripgrep", "git grep"]) {
				assert.ok(
					content.includes(token),
					`${tag} prompt must mention "${token}"`,
				);
			}
		});

		it(`${tag}: prompt mentions lsp_definition({ symbolName: "X" })`, () => {
			const content = assembleForRole(`canonical-def-${tag}`, roleName);
			assert.ok(
				content.includes(`lsp_definition({ symbolName: "X" })`),
				`${tag} prompt must mention lsp_definition({ symbolName: "X" })`,
			);
		});
	}
});

// ---------------------------------------------------------------------------
// 3. Resilience: project role override that does not mention LSP
// ---------------------------------------------------------------------------

describe("assembleSystemPrompt — role overrides cannot suppress canonical rule", () => {
	it("coder role with an LSP-free promptTemplate still gets exactly one canonical section", () => {
		// Simulate a project `.bobbit/config/roles/coder.yaml` that completely
		// replaces the default template with text that does NOT mention LSP.
		const overriddenCoderPrompt =
			"You are a **Coder** agent (id: test-agent).\n\n" +
			"## Your Role\nImplement features. Use grep to find things.\n";
		const content = assembleForRole("canonical-coder-override", "coder", {
			rolePromptOverride: overriddenCoderPrompt,
		});
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"LSP-free coder override must still inherit the canonical rule from the base prompt",
		);
		assert.ok(content.includes("rg"));
		assert.ok(content.includes("ripgrep"));
		assert.ok(content.includes("git grep"));
		assert.ok(content.includes(`lsp_definition({ symbolName: "X" })`));
	});

	it("empty role override still inherits the canonical rule", () => {
		const content = assembleForRole("canonical-empty-override", "coder", {
			rolePromptOverride: "",
		});
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
	});
});

// ---------------------------------------------------------------------------
// 4. No-duplicate guard across the full assembled prompt
// ---------------------------------------------------------------------------

describe("assembleSystemPrompt — no duplicate canonical heading", () => {
	it("default coder role assembly produces exactly one canonical section (default role yaml must not duplicate the base prompt heading)", () => {
		const content = assembleForRole("canonical-default-coder", "coder");
		const n = count(content, CANONICAL_HEADER);
		assert.strictEqual(
			n,
			1,
			`Final assembled prompt must contain exactly one "${CANONICAL_HEADER}" — found ${n}.\n` +
			`Default role yamls (coder/reviewer/code-reviewer/security-reviewer) must not also include the canonical heading; the base system prompt owns it.`,
		);
	});

	it("default reviewer / code-reviewer / security-reviewer roles each yield exactly one canonical section", () => {
		for (const role of ["reviewer", "code-reviewer", "security-reviewer"]) {
			const content = assembleForRole(`canonical-default-${role}`, role);
			assert.strictEqual(
				count(content, CANONICAL_HEADER),
				1,
				`Default ${role}.yaml must not duplicate the canonical heading; got ${count(content, CANONICAL_HEADER)} occurrences.`,
			);
		}
	});

	it("default role yamls do not contain the canonical header literally (it lives in the base prompt)", () => {
		for (const role of ["coder", "reviewer", "code-reviewer", "security-reviewer", "team-lead", "architect", "spec-auditor"]) {
			const tmpl = loadRoleTemplate(role);
			if (!tmpl) continue;
			assert.ok(
				!tmpl.includes(CANONICAL_HEADER),
				`defaults/roles/${role}.yaml must not contain "${CANONICAL_HEADER}" — the canonical rule belongs in defaults/system-prompt.md only.`,
			);
		}
	});

	it("assembling the same role twice never produces two canonical sections in a single prompt", () => {
		for (const tag of ["dup-check-a", "dup-check-b"]) {
			const content = assembleForRole(tag, "coder");
			assert.strictEqual(count(content, CANONICAL_HEADER), 1, `${tag} must contain exactly one canonical section`);
		}
	});
});
