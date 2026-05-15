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
	stripCanonicalLspRule,
	dedupeCanonicalLspRule,
	getPromptSections,
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
// 4b. De-duplication when role/goal content also includes the canonical header
// ---------------------------------------------------------------------------

describe("assembleSystemPrompt — de-duplicates canonical LSP section across base + role + goal", () => {
	const CANONICAL_ROLE_BLOB =
		"You are a **Coder** agent.\n\n" +
		"## Your Role\nImplement features.\n\n" +
		CANONICAL_HEADER + "\n\n" +
		"Role-supplied copy of the rule that mentions lsp_definition and rg.\n\n" +
		"## Footer Section\nStill here.\n";

	it("rolePrompt containing the canonical header does not produce a duplicate", () => {
		const basePath = writeCustomPrompt(
			"dedupe-role-base",
			"# Acme Project Assistant\n\nBe terse.\n",
		);
		const content = assembleWithBase("dedupe-role", basePath, {
			roleName: "coder",
			rolePrompt: CANONICAL_ROLE_BLOB,
		});
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"final prompt must contain exactly one canonical LSP section even when rolePrompt also includes it",
		);
	});

	it("rolePrompt with canonical header preserves non-LSP role wording", () => {
		const basePath = writeCustomPrompt(
			"dedupe-role-preserve",
			"# Acme\n\nBe terse.\n",
		);
		const content = assembleWithBase("dedupe-role-preserve", basePath, {
			roleName: "coder",
			rolePrompt: CANONICAL_ROLE_BLOB,
		});
		assert.ok(content.includes("You are a **Coder** agent."), "role intro must survive");
		assert.ok(content.includes("Implement features."), "role body must survive");
		assert.ok(content.includes("## Footer Section"), "trailing role section must survive");
		assert.ok(content.includes("Still here."), "trailing role section body must survive");
	});

	it("both base prompt and rolePrompt with canonical header still yields exactly one section", () => {
		const basePath = writeCustomPrompt(
			"dedupe-both",
			"# Acme\n\n" + CANONICAL_HEADER + "\n\nBase project copy of the rule.\n\n## Other\nbody\n",
		);
		const content = assembleWithBase("dedupe-both", basePath, {
			roleName: "coder",
			rolePrompt: CANONICAL_ROLE_BLOB,
		});
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
		assert.ok(content.includes("Base project copy of the rule."), "base bespoke wording must survive");
		assert.ok(content.includes("You are a **Coder** agent."), "role intro must survive");
	});

	it("goalSpec containing the canonical header does not produce a duplicate", () => {
		const basePath = writeCustomPrompt(
			"dedupe-goal-base",
			"# Acme\n\nBe terse.\n",
		);
		const promptPath = assembleSystemPrompt("dedupe-goal", {
			baseSystemPromptPath: basePath,
			cwd: tmpDir,
			goalTitle: "Dedupe Goal",
			goalState: "active",
			goalSpec:
				"# Original goal\n\nDo the thing.\n\n" +
				CANONICAL_HEADER + "\n\n" +
				"Goal-supplied LSP wording.\n",
			allowedTools: ["read", "bash", "grep"],
		});
		assert.ok(promptPath);
		const content = fs.readFileSync(promptPath!, "utf-8");
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
		assert.ok(content.includes("Do the thing."), "non-LSP goal-spec content must survive");
	});

	it("getPromptSections() output across all sections contains exactly one canonical header", () => {
		const basePath = writeCustomPrompt(
			"dedupe-sections",
			"# Acme\n\nBe terse.\n",
		);
		const sections = getPromptSections({
			baseSystemPromptPath: basePath,
			cwd: tmpDir,
			goalTitle: "Dedupe",
			goalSpec:
				"Do the thing.\n\n" + CANONICAL_HEADER + "\n\nGoal copy of rule.\n",
			roleName: "coder",
			rolePrompt: CANONICAL_ROLE_BLOB,
		});
		const joined = sections.map(s => s.content).join("\n\n");
		assert.strictEqual(
			count(joined, CANONICAL_HEADER),
			1,
			"getPromptSections() final output must contain exactly one canonical LSP section across base + goal + role",
		);
	});
});

// ---------------------------------------------------------------------------
// 4c. stripCanonicalLspRule() helper unit tests
// ---------------------------------------------------------------------------

describe("stripCanonicalLspRule()", () => {
	it("is a no-op when the header is absent", () => {
		const input = "# Hello\n\nNo LSP rule here.\n";
		assert.strictEqual(stripCanonicalLspRule(input), input);
	});

	it("removes the section and stops at the next H2 heading", () => {
		const input =
			"# Top\n\nIntro.\n\n" +
			CANONICAL_HEADER + "\n\nbody body body\n\n" +
			"## Next\nkeep me\n";
		const out = stripCanonicalLspRule(input);
		assert.ok(!out.includes(CANONICAL_HEADER));
		assert.ok(!out.includes("body body body"));
		assert.ok(out.includes("Intro."));
		assert.ok(out.includes("## Next"));
		assert.ok(out.includes("keep me"));
	});

	it("removes the section through end-of-string when no following heading", () => {
		const input =
			"# Top\n\nIntro.\n\n" + CANONICAL_HEADER + "\n\nbody body body\n";
		const out = stripCanonicalLspRule(input);
		assert.ok(!out.includes(CANONICAL_HEADER));
		assert.ok(!out.includes("body body body"));
		assert.ok(out.includes("Intro."));
	});

	it("handles empty/undefined input safely", () => {
		assert.strictEqual(stripCanonicalLspRule(""), "");
	});
});

// ---------------------------------------------------------------------------
// 4d. Global de-duplication across ALL late fragments
//     (workflowContext + AGENTS.md + toolDocs + taskSpec)
// ---------------------------------------------------------------------------

describe("dedupeCanonicalLspRule() helper", () => {
	it("is a no-op when zero or one canonical header is present", () => {
		assert.strictEqual(dedupeCanonicalLspRule(""), "");
		assert.strictEqual(dedupeCanonicalLspRule("# Hi\n\nno lsp\n"), "# Hi\n\nno lsp\n");
		const single = `# Top\n\n${CANONICAL_HEADER}\n\nbody\n`;
		assert.strictEqual(dedupeCanonicalLspRule(single), single);
	});

	it("keeps the first canonical section and strips all later duplicates", () => {
		const input =
			`# Base\n\n${CANONICAL_HEADER}\n\nfirst body keep\n\n` +
			`## Other\nother body\n\n` +
			`${CANONICAL_HEADER}\n\nduplicate body drop\n\n` +
			`## After\nafter body keep\n`;
		const out = dedupeCanonicalLspRule(input);
		assert.strictEqual(count(out, CANONICAL_HEADER), 1);
		assert.ok(out.includes("first body keep"));
		assert.ok(out.includes("## Other"));
		assert.ok(out.includes("other body"));
		assert.ok(out.includes("## After"));
		assert.ok(out.includes("after body keep"));
		assert.ok(!out.includes("duplicate body drop"));
	});

	it("handles three+ duplicates", () => {
		const input =
			`# A\n${CANONICAL_HEADER}\nbody1\n\n` +
			`## X\nx1\n${CANONICAL_HEADER}\nbody2\n\n` +
			`## Y\ny1\n${CANONICAL_HEADER}\nbody3\n`;
		const out = dedupeCanonicalLspRule(input);
		assert.strictEqual(count(out, CANONICAL_HEADER), 1);
		assert.ok(out.includes("body1"));
		assert.ok(!out.includes("body2"));
		assert.ok(!out.includes("body3"));
		assert.ok(out.includes("## X"));
		assert.ok(out.includes("## Y"));
	});
});

describe("assembleSystemPrompt — global de-duplication across late fragments", () => {
	it("workflowContext containing the canonical header does not duplicate", () => {
		const basePath = writeCustomPrompt(
			"dedupe-workflow-base",
			"# Acme\n\nBe terse.\n",
		);
		const promptPath = assembleSystemPrompt("dedupe-workflow", {
			baseSystemPromptPath: basePath,
			cwd: tmpDir,
			goalTitle: "WF Dedupe",
			goalState: "active",
			goalSpec: "Implement the thing.\n",
			workflowContext:
				"# Upstream Gates\n\n## Gate: Design Document (passed)\n\n" +
				"Design content quoted from goal spec.\n\n" +
				CANONICAL_HEADER + "\n\nUpstream-supplied LSP copy.\n",
			allowedTools: ["read", "bash", "grep"],
		});
		assert.ok(promptPath);
		const content = fs.readFileSync(promptPath!, "utf-8");
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"final prompt must contain exactly one canonical section when workflowContext includes it",
		);
		assert.ok(content.includes("Design content quoted from goal spec."), "non-LSP workflow content must survive");
		assert.ok(content.includes("## Gate: Design Document (passed)"), "workflow gate heading must survive");
	});

	it("taskSpec containing the canonical header does not duplicate", () => {
		const basePath = writeCustomPrompt(
			"dedupe-task-base",
			"# Acme\n\nBe terse.\n",
		);
		const promptPath = assembleSystemPrompt("dedupe-task", {
			baseSystemPromptPath: basePath,
			cwd: tmpDir,
			taskTitle: "Fix dedupe bug",
			taskType: "bug-fix",
			taskSpec:
				"Steps:\n1. Reproduce.\n2. Fix.\n\n" +
				CANONICAL_HEADER + "\n\nTask-spec copy of LSP rule.\n",
			allowedTools: ["read", "bash", "grep"],
		});
		assert.ok(promptPath);
		const content = fs.readFileSync(promptPath!, "utf-8");
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
		assert.ok(content.includes("1. Reproduce."), "task-spec body must survive");
		assert.ok(content.includes("2. Fix."), "task-spec body must survive");
	});

	it("toolDocs containing the canonical header does not duplicate", () => {
		const basePath = writeCustomPrompt(
			"dedupe-tools-base",
			"# Acme\n\nBe terse.\n",
		);
		const promptPath = assembleSystemPrompt("dedupe-tools", {
			baseSystemPromptPath: basePath,
			cwd: tmpDir,
			toolDocs:
				"# Tools\n\n- read(path) — read a file.\n\n" +
				CANONICAL_HEADER + "\n\nTool-doc inlined LSP rule.\n",
			allowedTools: ["read", "bash", "grep"],
		});
		assert.ok(promptPath);
		const content = fs.readFileSync(promptPath!, "utf-8");
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
		assert.ok(content.includes("- read(path) — read a file."), "tool-doc body must survive");
	});

	it("workflowContext + taskSpec + role + goal all containing the header still yield exactly one section", () => {
		const basePath = writeCustomPrompt(
			"dedupe-many-base",
			"# Acme\n\nBe terse.\n",
		);
		const rolePrompt =
			"You are a **Coder** agent.\n\n" +
			"## Your Role\nImplement.\n\n" +
			CANONICAL_HEADER + "\n\nRole copy.\n";
		const goalSpec =
			"Do the thing.\n\n" + CANONICAL_HEADER + "\n\nGoal copy.\n";
		const workflowContext =
			"# Upstream Gates\n\n## Gate: Design (passed)\n\n" +
			"Designed.\n\n" + CANONICAL_HEADER + "\n\nWorkflow copy.\n";
		const taskSpec =
			"Step 1.\n\n" + CANONICAL_HEADER + "\n\nTask copy.\n";
		const toolDocs =
			"# Tools\n\n- read.\n\n" + CANONICAL_HEADER + "\n\nTool copy.\n";

		const promptPath = assembleSystemPrompt("dedupe-many", {
			baseSystemPromptPath: basePath,
			cwd: tmpDir,
			goalTitle: "Many",
			goalState: "active",
			goalSpec,
			roleName: "coder",
			rolePrompt,
			taskTitle: "Multi",
			taskType: "bug-fix",
			taskSpec,
			toolDocs,
			workflowContext,
			allowedTools: ["read", "bash", "grep"],
		});
		assert.ok(promptPath);
		const content = fs.readFileSync(promptPath!, "utf-8");
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"final prompt must have exactly one canonical section across every late fragment",
		);
		// Non-LSP content from every fragment must survive.
		assert.ok(content.includes("Do the thing."));
		assert.ok(content.includes("You are a **Coder** agent."));
		assert.ok(content.includes("Implement."));
		assert.ok(content.includes("Step 1."));
		assert.ok(content.includes("- read."));
		assert.ok(content.includes("Designed."));
		assert.ok(content.includes("## Gate: Design (passed)"));
	});

	it("getPromptSections() joined output is single-canonical when workflowContext + role contain the header", () => {
		const basePath = writeCustomPrompt(
			"dedupe-sections-many",
			"# Acme\n\nBe terse.\n",
		);
		const sections = getPromptSections({
			baseSystemPromptPath: basePath,
			cwd: tmpDir,
			goalTitle: "Many",
			roleName: "coder",
			rolePrompt:
				"You are a **Coder** agent.\n\n" + CANONICAL_HEADER + "\n\nRole copy.\n",
			taskTitle: "T",
			taskType: "bug-fix",
			taskSpec: "Steps.\n\n" + CANONICAL_HEADER + "\n\nTask copy.\n",
			toolDocs: "# Tools\n\n- read.\n\n" + CANONICAL_HEADER + "\n\nTool copy.\n",
			workflowContext:
				"# Upstream Gates\n\n" + CANONICAL_HEADER + "\n\nWorkflow copy.\n",
		});
		const joined = sections.map(s => s.content).join("\n\n");
		assert.strictEqual(
			count(joined, CANONICAL_HEADER),
			1,
			"getPromptSections() joined output must contain exactly one canonical header across every fragment",
		);
	});
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
