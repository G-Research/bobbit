/**
 * Pinning tests for the **protected** canonical LSP-before-text-search rule.
 *
 * The companion file `tests/lsp-canonical-base-prompt.test.ts` pins that the
 * shipped `defaults/system-prompt.md` carries the canonical section. This file
 * pins the stronger guarantee from goal "LSP rule survives system prompt
 * override" (goal/lsp-rule-s-fba47841):
 *
 *   No matter which file the `baseSystemPromptPath` points at — the shipped
 *   default, a project's `.bobbit/config/system-prompt.md` override, or any
 *   other configured base prompt — every final assembled prompt MUST contain
 *   exactly one `## Tool selection — LSP before text search` section, mention
 *   the LSP tool family (`lsp_workspace_symbol`, `lsp_definition`, …) and
 *   text-search fallbacks (`grep`, `rg`, `ripgrep`, `git grep`, `ag`, `ack`),
 *   and reference the `[lsp-hint]` marker.
 *
 * Why this matters: prior to this protection, a project that supplied its own
 * `system-prompt.md` (e.g. via `bobbitConfigDir()/system-prompt.md`) could
 * silently suppress the canonical rule by omission. Tests below prove the
 * runtime now injects the rule when the selected base prompt does not include
 * it, and never duplicates it when it already does.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	initPromptDirs,
	assembleSystemPrompt,
	ensureCanonicalLspRule,
	LSP_CANONICAL_TOOL_SELECTION_HEADER,
	LSP_CANONICAL_TOOL_SELECTION_RULE,
} from "../src/server/agent/system-prompt.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultsSystemPrompt = path.resolve(repoRoot, "defaults/system-prompt.md");

const CANONICAL_HEADER = "## Tool selection — LSP before text search";

let tmpDir: string;
let customPromptsDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-protected-injection-"));
	customPromptsDir = path.join(tmpDir, "custom-prompts");
	fs.mkdirSync(customPromptsDir, { recursive: true });
	initPromptDirs(tmpDir);
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

/** Write a custom base system prompt file and return its absolute path. */
function writeCustomPrompt(name: string, body: string): string {
	const p = path.join(customPromptsDir, `${name}.md`);
	fs.writeFileSync(p, body, "utf-8");
	return p;
}

/** Assemble a prompt against a custom base prompt path. */
function assembleWithBase(
	sessionId: string,
	baseSystemPromptPath: string,
	opts: { roleName?: string; rolePrompt?: string; allowedTools?: string[] } = {},
): string {
	const promptPath = assembleSystemPrompt(sessionId, {
		baseSystemPromptPath,
		cwd: tmpDir,
		goalSpec: "Protected canonical LSP rule test.",
		goalTitle: "Protected LSP Rule",
		goalState: "active",
		roleName: opts.roleName,
		rolePrompt: opts.rolePrompt,
		// Suppress conditional `[lsp-hint]` line from `buildLspSymbolLookupHint`
		// — we want to assert the protected base-prompt section only.
		allowedTools: opts.allowedTools ?? ["read", "bash", "grep", "find", "ls"],
	});
	assert.ok(promptPath, "assembleSystemPrompt must return a path");
	return fs.readFileSync(promptPath, "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Pure-helper unit tests for ensureCanonicalLspRule()
// ---------------------------------------------------------------------------

describe("ensureCanonicalLspRule()", () => {
	it("appends the canonical section when missing", () => {
		const base = "# Custom project prompt\n\nUse the tools wisely.";
		const out = ensureCanonicalLspRule(base);
		assert.strictEqual(count(out, CANONICAL_HEADER), 1);
		assert.ok(out.startsWith("# Custom project prompt"), "must preserve original content");
		assert.ok(out.includes("Use the tools wisely."), "must preserve original content");
	});

	it("is a no-op when the canonical header already present (no duplicates)", () => {
		const base =
			"# Custom\n\n" +
			LSP_CANONICAL_TOOL_SELECTION_HEADER +
			"\n\nBespoke wording that mentions lsp_definition.\n";
		const out = ensureCanonicalLspRule(base);
		assert.strictEqual(
			count(out, CANONICAL_HEADER),
			1,
			"ensureCanonicalLspRule must not duplicate the canonical header when present",
		);
		// When already present we expect the function to leave content alone.
		assert.strictEqual(out, base, "ensureCanonicalLspRule should be a no-op when header present");
	});

	it("appended rule references the full LSP tool family", () => {
		const out = ensureCanonicalLspRule("# Minimal\n");
		for (const token of [
			"lsp_workspace_symbol",
			"lsp_definition",
			"lsp_references",
			"lsp_hover",
			"lsp_diagnostics",
			"lsp_document_symbols",
		]) {
			assert.ok(out.includes(token), `canonical rule must mention "${token}"`);
		}
	});

	it("appended rule lists text-search fallbacks", () => {
		const out = ensureCanonicalLspRule("# Minimal\n");
		for (const token of ["grep", "rg", "ripgrep", "git grep", "ag", "ack"]) {
			assert.ok(out.includes(token), `canonical rule must mention text-search tool "${token}"`);
		}
	});

	it("appended rule shows the literal lsp_definition symbolName example", () => {
		const out = ensureCanonicalLspRule("# Minimal\n");
		assert.ok(
			out.includes(`lsp_definition({ symbolName: "X" })`),
			`canonical rule must include the literal example lsp_definition({ symbolName: "X" })`,
		);
	});

	it("appended rule references the [lsp-hint] marker", () => {
		const out = ensureCanonicalLspRule("# Minimal\n");
		assert.ok(out.includes("[lsp-hint]"), "canonical rule must reference the [lsp-hint] marker");
	});

	it("LSP_CANONICAL_TOOL_SELECTION_RULE constant itself contains the canonical header", () => {
		assert.ok(
			LSP_CANONICAL_TOOL_SELECTION_RULE.includes(LSP_CANONICAL_TOOL_SELECTION_HEADER),
			"the exported rule constant must contain its own header",
		);
		assert.strictEqual(LSP_CANONICAL_TOOL_SELECTION_HEADER, CANONICAL_HEADER);
	});
});

// ---------------------------------------------------------------------------
// 2. assembleSystemPrompt with a custom base prompt path
// ---------------------------------------------------------------------------

describe("assembleSystemPrompt — custom base prompt without canonical header", () => {
	it("injects exactly one canonical section when the base prompt omits it", () => {
		const basePath = writeCustomPrompt(
			"custom-no-lsp",
			"# Acme Project Assistant\n\nBe helpful. Use the tools.\n",
		);
		const content = assembleWithBase("custom-base-no-header", basePath);
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"final prompt must contain exactly one canonical LSP section even when the base prompt omits it",
		);
	});

	it("injected section contains required search tokens", () => {
		const basePath = writeCustomPrompt(
			"custom-no-lsp-tokens",
			"# Acme Project Assistant\n\nBe helpful.\n",
		);
		const content = assembleWithBase("custom-base-tokens", basePath);
		for (const token of ["rg", "ripgrep", "git grep"]) {
			assert.ok(
				content.includes(token),
				`injected canonical section must mention "${token}"`,
			);
		}
		assert.ok(
			content.includes(`lsp_definition({ symbolName: "X" })`),
			`injected canonical section must include lsp_definition({ symbolName: "X" })`,
		);
	});

	it("preserves the original custom base prompt content", () => {
		const basePath = writeCustomPrompt(
			"custom-preserved",
			"# Acme Project Assistant\n\nFollow project conventions.\n",
		);
		const content = assembleWithBase("custom-base-preserved", basePath);
		assert.ok(content.includes("# Acme Project Assistant"));
		assert.ok(content.includes("Follow project conventions."));
	});
});

describe("assembleSystemPrompt — custom base prompt with canonical header", () => {
	it("does not duplicate the canonical section when the base prompt already has it", () => {
		const basePath = writeCustomPrompt(
			"custom-with-lsp",
			"# Acme Project Assistant\n\n" +
				CANONICAL_HEADER +
				"\n\nBespoke project-specific wording referencing lsp_definition and rg.\n",
		);
		const content = assembleWithBase("custom-base-has-header", basePath);
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"final prompt must contain exactly one canonical LSP section when the base prompt already has it",
		);
	});

	it("project's bespoke wording inside the section survives (no replacement)", () => {
		const basePath = writeCustomPrompt(
			"custom-with-lsp-keeps-body",
			"# Custom\n\n" +
				CANONICAL_HEADER +
				"\n\nProject says: PREFER_LSP_FIRST_MARKER.\n",
		);
		const content = assembleWithBase("custom-base-bespoke", basePath);
		assert.ok(
			content.includes("PREFER_LSP_FIRST_MARKER"),
			"project-supplied wording inside an existing canonical section must be preserved",
		);
	});
});

// ---------------------------------------------------------------------------
// 3. Source-pin: project override cannot shadow the core rule
// ---------------------------------------------------------------------------

describe("source-pin: project system-prompt override cannot shadow the canonical rule", () => {
	it("a `.bobbit/config/system-prompt.md`-shaped override that omits the header still yields the rule", () => {
		// Simulate the exact path a project override would take: a file under a
		// fake bobbit config dir, with body that *does not* mention LSP at all.
		const fakeBobbitConfigDir = path.join(tmpDir, "fake-bobbit-config");
		fs.mkdirSync(fakeBobbitConfigDir, { recursive: true });
		const overridePath = path.join(fakeBobbitConfigDir, "system-prompt.md");
		fs.writeFileSync(
			overridePath,
			"# Project: Acme\n\nYou are an Acme engineer. Use grep and rg freely.\n",
			"utf-8",
		);

		const content = assembleWithBase("project-override-shape", overridePath);
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"project system-prompt override must not be able to shadow the canonical LSP rule by omission",
		);
		// Sanity: the canonical tools must appear via the injected section, not
		// merely incidental mentions in the override body.
		assert.ok(content.includes(`lsp_definition({ symbolName: "X" })`));
		assert.ok(content.includes("lsp_workspace_symbol"));
		assert.ok(content.includes("[lsp-hint]"));
	});

	it("an empty project override still yields the canonical rule", () => {
		const overridePath = writeCustomPrompt("empty-override", "");
		const content = assembleWithBase("empty-override-shape", overridePath);
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"empty override must not suppress the canonical rule",
		);
	});

	it("an override that only repeats AGENTS-style guidance still yields the canonical rule", () => {
		const overridePath = writeCustomPrompt(
			"agents-style-override",
			"# Project conventions\n\n- Run npm run check before commits.\n- Use file:// fixtures.\n",
		);
		const content = assembleWithBase("agents-override", overridePath);
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
	});
});

// ---------------------------------------------------------------------------
// 4. Representative session shapes still get the canonical rule when running
//    against a *custom* (non-default) base prompt.
// ---------------------------------------------------------------------------

const ROLE_PROMPT_FIXTURES: Array<{ tag: string; roleName?: string; rolePrompt?: string }> = [
	// general/base prompt — no role
	{ tag: "general-no-role" },
	// team-lead-style — minimal LSP-free role body
	{
		tag: "team-lead-style",
		roleName: "team-lead",
		rolePrompt:
			"You are a **Team Lead** agent.\n\n" +
			"## Your Role\nCoordinate sub-agents and merge their branches.\n",
	},
	// coder with project role override — body deliberately omits LSP guidance
	{
		tag: "coder-project-override",
		roleName: "coder",
		rolePrompt:
			"You are a **Coder** agent.\n\n" +
			"## Your Role\nImplement features. Use grep to locate symbols.\n",
	},
	// architect-style
	{
		tag: "architect-style",
		roleName: "architect",
		rolePrompt:
			"You are an **Architect** agent.\n\n" +
			"## Your Role\nProduce design docs before implementation.\n",
	},
	// spec-auditor-style
	{
		tag: "spec-auditor-style",
		roleName: "spec-auditor",
		rolePrompt:
			"You are a **Spec Auditor** agent.\n\n" +
			"## Your Role\nAudit goal specs for testability and completeness.\n",
	},
];

describe("assembleSystemPrompt — representative session shapes against a custom base prompt", () => {
	for (const fx of ROLE_PROMPT_FIXTURES) {
		it(`${fx.tag}: prompt contains exactly one canonical LSP section`, () => {
			const basePath = writeCustomPrompt(
				`custom-${fx.tag}`,
				"# Acme Project Assistant\n\nProject conventions: be terse. Use grep.\n",
			);
			const content = assembleWithBase(`shape-${fx.tag}`, basePath, {
				roleName: fx.roleName,
				rolePrompt: fx.rolePrompt,
			});
			const n = count(content, CANONICAL_HEADER);
			assert.strictEqual(
				n,
				1,
				`Expected exactly one "${CANONICAL_HEADER}" in ${fx.tag} prompt; got ${n}.`,
			);
		});

		it(`${fx.tag}: prompt mentions rg, ripgrep, git grep`, () => {
			const basePath = writeCustomPrompt(
				`custom-tokens-${fx.tag}`,
				"# Acme\n\nBe terse.\n",
			);
			const content = assembleWithBase(`tokens-${fx.tag}`, basePath, {
				roleName: fx.roleName,
				rolePrompt: fx.rolePrompt,
			});
			for (const token of ["rg", "ripgrep", "git grep"]) {
				assert.ok(content.includes(token), `${fx.tag} prompt must mention "${token}"`);
			}
		});

		it(`${fx.tag}: prompt mentions lsp_definition({ symbolName: "X" })`, () => {
			const basePath = writeCustomPrompt(
				`custom-def-${fx.tag}`,
				"# Acme\n\nBe terse.\n",
			);
			const content = assembleWithBase(`def-${fx.tag}`, basePath, {
				roleName: fx.roleName,
				rolePrompt: fx.rolePrompt,
			});
			assert.ok(
				content.includes(`lsp_definition({ symbolName: "X" })`),
				`${fx.tag} prompt must mention lsp_definition({ symbolName: "X" })`,
			);
		});
	}
});

// ---------------------------------------------------------------------------
// 5. Existing default-prompt behavior still holds (regression guard)
// ---------------------------------------------------------------------------

describe("assembleSystemPrompt — shipped defaults/system-prompt.md still produces exactly one section", () => {
	it("default base prompt yields exactly one canonical section (no double-inject)", () => {
		const content = assembleWithBase("default-no-double", defaultsSystemPrompt);
		const n = count(content, CANONICAL_HEADER);
		assert.strictEqual(
			n,
			1,
			`Default base prompt already contains the canonical header; protected injection must NOT add a second one. Got ${n}.`,
		);
	});

	it("default base prompt result still includes the LSP tool family and fallbacks", () => {
		const content = assembleWithBase("default-tokens", defaultsSystemPrompt);
		for (const token of [
			"lsp_workspace_symbol",
			"lsp_definition",
			"lsp_references",
			"lsp_hover",
			"lsp_diagnostics",
			"lsp_document_symbols",
			"rg",
			"ripgrep",
			"git grep",
			"ag",
			"ack",
			"[lsp-hint]",
		]) {
			assert.ok(content.includes(token), `default prompt assembly must mention "${token}"`);
		}
		assert.ok(content.includes(`lsp_definition({ symbolName: "X" })`));
	});
});
