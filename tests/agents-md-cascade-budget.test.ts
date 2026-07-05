/**
 * F19 — AGENTS.md cascade budget (`BOBBIT_AGENTSMD_BUDGET`).
 *
 * Ground truth (docs/design/agents-md-cascade-budget.md): the Project
 * AGENTS.md cascade is uncapped `@ref` inlining that measured up to ~21K
 * tokens = 56% of a code-reviewer prompt on a real managed project. The
 * bloat is driven by the `@ref` expansion, not the root file's own prose.
 *
 * This suite pins:
 *   - `resolveAgentsMdBudgetTokens`: off by default, env-var fallback,
 *     override precedence, clamping.
 *   - `resolveMarkdownRefs`/`readAllAgentFiles` budget-aware truncation:
 *     nearest file's own text always kept whole; @-refs (and any
 *     additional agents-type entries) capped with an explicit marker;
 *     deterministic line-boundary cut point.
 *   - Flag-off (`budget` / `BOBBIT_AGENTSMD_BUDGET` both unset) byte-identity
 *     with pre-F19 behavior.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-budget-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(path.join(stateDir, "session-prompts"), { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const {
	resolveMarkdownRefs,
	readAgentsMd,
	readAllAgentFiles,
	resolveAgentsMdBudgetTokens,
	createAgentsMdBudget,
	getPromptSections,
	AGENTS_MD_BUDGET_MIN_TOKENS,
	AGENTS_MD_BUDGET_MAX_TOKENS,
	AGENTS_MD_BUDGET_CHARS_PER_TOKEN,
	initPromptDirs,
} = await import("../src/server/agent/system-prompt.ts");

initPromptDirs(stateDir);

let cwdDir: string;

function setup() {
	cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-cwd-"));
}
function cleanup() {
	try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ }
	delete process.env.BOBBIT_AGENTSMD_BUDGET;
}

// ── resolveAgentsMdBudgetTokens ─────────────────────────────────────────────

describe("resolveAgentsMdBudgetTokens", () => {
	afterEach(() => { delete process.env.BOBBIT_AGENTSMD_BUDGET; });

	it("is OFF (undefined) when no override and no env var", () => {
		assert.equal(resolveAgentsMdBudgetTokens(), undefined);
	});

	it("is OFF when env var is unset/empty and no override", () => {
		process.env.BOBBIT_AGENTSMD_BUDGET = "";
		assert.equal(resolveAgentsMdBudgetTokens(), undefined);
	});

	it("is OFF for a non-numeric env var", () => {
		process.env.BOBBIT_AGENTSMD_BUDGET = "not-a-number";
		assert.equal(resolveAgentsMdBudgetTokens(), undefined);
	});

	it("is OFF for a zero or negative value", () => {
		assert.equal(resolveAgentsMdBudgetTokens(0), undefined);
		assert.equal(resolveAgentsMdBudgetTokens(-500), undefined);
	});

	it("reads a valid value from the env var", () => {
		process.env.BOBBIT_AGENTSMD_BUDGET = "8000";
		assert.equal(resolveAgentsMdBudgetTokens(), 8000);
	});

	it("an explicit override wins over the env var", () => {
		process.env.BOBBIT_AGENTSMD_BUDGET = "8000";
		assert.equal(resolveAgentsMdBudgetTokens(4000), 4000);
	});

	it("clamps a too-small value up to MIN", () => {
		assert.equal(resolveAgentsMdBudgetTokens(1), AGENTS_MD_BUDGET_MIN_TOKENS);
	});

	it("clamps a too-large value down to MAX", () => {
		assert.equal(resolveAgentsMdBudgetTokens(50_000_000), AGENTS_MD_BUDGET_MAX_TOKENS);
	});

	it("floors fractional values", () => {
		assert.equal(resolveAgentsMdBudgetTokens(1000.9), 1000);
	});
});

// ── resolveMarkdownRefs with a budget ────────────────────────────────────────

describe("resolveMarkdownRefs — budget-capped @-ref expansion", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("uncapped (no budget arg) is byte-identical to today's behavior", () => {
		fs.writeFileSync(path.join(cwdDir, "big.md"), "x".repeat(5000), "utf-8");
		const withoutBudgetParam = resolveMarkdownRefs("@big.md", cwdDir);
		const withUndefinedBudget = resolveMarkdownRefs("@big.md", cwdDir, undefined, 0, undefined);
		assert.equal(withoutBudgetParam, withUndefinedBudget);
		assert.ok(withoutBudgetParam.includes("x".repeat(5000)));
	});

	it("keeps the base document's own literal text in full regardless of budget", () => {
		const ownText = "OWN TEXT: ".repeat(500); // ~5000 chars, own prose (not a ref)
		const budget = createAgentsMdBudget(10); // tiny — 10 tokens = 40 bytes
		const result = resolveMarkdownRefs(ownText, cwdDir, undefined, 0, budget);
		assert.equal(result, ownText, "the document's own text (no @refs) must never be truncated by the budget");
	});

	it("truncates an @-ref's content once the budget is exhausted, with an explicit marker", () => {
		const refPath = path.join(cwdDir, "huge.md");
		fs.writeFileSync(refPath, "line-A\n".repeat(2000), "utf-8"); // ~14000 chars
		const budget = createAgentsMdBudget(100); // 100 tokens = 400 bytes
		const result = resolveMarkdownRefs("Intro.\n@huge.md\nOutro.", cwdDir, undefined, 0, budget);
		assert.ok(result.includes("Intro."), "own text before the ref is kept");
		assert.ok(result.includes("Outro."), "own text after the ref is kept");
		assert.ok(result.includes("line-A"), "some of the ref content is kept, up to budget");
		assert.ok(!result.includes("line-A\n".repeat(2000)), "the full ref content must NOT all be inlined");
		assert.ok(result.includes("AGENTS.md cascade budget"), "an explicit truncation marker must be present");
		assert.ok(result.includes(refPath), "the marker must name the source path so the agent knows where to read the rest");
	});

	it("cuts at a line boundary — never mid-line", () => {
		const refPath = path.join(cwdDir, "lines.md");
		const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${"z".repeat(20)}`);
		fs.writeFileSync(refPath, lines.join("\n"), "utf-8");
		const budget = createAgentsMdBudget(30); // 30 tokens = 120 bytes — cuts partway through
		const result = resolveMarkdownRefs("@lines.md", cwdDir, undefined, 0, budget);
		// Every full line kept must appear in its entirety (no partial "line-N-zzz..." fragment
		// that doesn't match one of the source lines).
		const keptLines = result.split("\n").filter(l => l.startsWith("line-"));
		for (const l of keptLines) {
			assert.ok(lines.includes(l), `kept line "${l}" must be a complete, unmodified source line`);
		}
	});

	it("omits an @-ref entirely (with a marker) once the budget was already exhausted by an earlier ref", () => {
		fs.writeFileSync(path.join(cwdDir, "first.md"), "F".repeat(200), "utf-8");
		fs.writeFileSync(path.join(cwdDir, "second.md"), "S".repeat(200), "utf-8");
		const budget = createAgentsMdBudget(40); // 40 tokens = 160 bytes — first ref alone exhausts it
		const result = resolveMarkdownRefs("@first.md\n@second.md", cwdDir, undefined, 0, budget);
		assert.ok(result.includes("F"), "first ref gets some content (budget was available)");
		assert.ok(!result.includes("S".repeat(50)), "second ref must be fully omitted once budget is exhausted");
		assert.ok((result.match(/AGENTS\.md cascade budget/g) || []).length >= 2, "both the truncated first ref and the omitted second ref get markers");
	});

	it("a larger budget keeps strictly more ref content than a smaller one", () => {
		fs.writeFileSync(path.join(cwdDir, "doc.md"), "content-".repeat(1000), "utf-8");
		const small = resolveMarkdownRefs("@doc.md", cwdDir, undefined, 0, createAgentsMdBudget(50));
		const large = resolveMarkdownRefs("@doc.md", cwdDir, undefined, 0, createAgentsMdBudget(500));
		assert.ok(large.length > small.length);
	});

	it("a disabled budget (undefined) never truncates, however large the ref", () => {
		fs.writeFileSync(path.join(cwdDir, "doc.md"), "content-".repeat(5000), "utf-8");
		const result = resolveMarkdownRefs("@doc.md", cwdDir);
		assert.ok(!result.includes("AGENTS.md cascade budget"));
		assert.ok(result.includes("content-".repeat(5000)));
	});
});

// ── readAllAgentFiles — multi-entry cascade ─────────────────────────────────

function mockConfigStore(customAgentsPaths: string[]) {
	return {
		get(_k: string) { return undefined; },
		getConfigDirectories() {
			return customAgentsPaths.map(p => ({ path: p, types: ["agents"] }));
		},
	};
}

describe("readAllAgentFiles — cascade budget across multiple agents entries", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("flag off: byte-identical to pre-F19 (no budgetTokens arg)", () => {
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "root guide\n" + "x".repeat(5000), "utf-8");
		const withoutArg = readAllAgentFiles(cwdDir, mockConfigStore([]));
		const withUndefined = readAllAgentFiles(cwdDir, mockConfigStore([]), undefined);
		assert.equal(withoutArg, withUndefined);
	});

	it("keeps the nearest (first/root) AGENTS.md whole; caps a secondary agents-type entry", () => {
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "ROOT: " + "r".repeat(3000), "utf-8");
		const secondaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-secondary-"));
		const secondaryPath = path.join(secondaryDir, "TEAM.md");
		fs.writeFileSync(secondaryPath, "SECONDARY: " + "s".repeat(3000), "utf-8");

		const budgetTokens = 200; // 800 bytes total — smaller than either file alone
		const result = readAllAgentFiles(cwdDir, mockConfigStore([secondaryPath]), budgetTokens);

		assert.ok(result.includes("ROOT: " + "r".repeat(3000)), "nearest/root file kept fully whole");
		assert.ok(!result.includes("SECONDARY: " + "s".repeat(3000)), "secondary entry must be capped, not inlined whole");
		assert.ok(result.includes("AGENTS.md cascade budget"), "capped secondary entry carries a transparency marker");

		fs.rmSync(secondaryDir, { recursive: true, force: true });
	});

	it("omits a secondary entry entirely once the root file's own @-refs already exhausted the budget", () => {
		fs.mkdirSync(path.join(cwdDir, "docs"), { recursive: true });
		fs.writeFileSync(path.join(cwdDir, "docs", "big.md"), "BIGDOC ".repeat(2000), "utf-8");
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "root\n@docs/big.md", "utf-8");
		const secondaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-secondary2-"));
		const secondaryPath = path.join(secondaryDir, "TEAM.md");
		fs.writeFileSync(secondaryPath, "SECONDARY-CONTENT", "utf-8");

		const result = readAllAgentFiles(cwdDir, mockConfigStore([secondaryPath]), 50); // 200 bytes — root's own @ref alone exhausts it

		assert.ok(result.includes("root"), "root file's own literal text always kept");
		assert.ok(!result.includes("SECONDARY-CONTENT"), "secondary entry omitted once budget is exhausted");
		assert.ok(result.includes("omitted"), "an explicit omission marker names the omitted file");

		fs.rmSync(secondaryDir, { recursive: true, force: true });
	});

	it("reproduces a representative deep @-ref cascade blowup and shows the budget bounds it", () => {
		// Simulate the measured real-world scenario: a project's AGENTS.md
		// @-includes a chain of docs (recursive, depth <= 5), each several KB,
		// which uncapped inlines to tens of thousands of characters.
		let prev = "leaf content\n" + "z".repeat(3000);
		fs.writeFileSync(path.join(cwdDir, "leaf.md"), prev, "utf-8");
		for (let i = 4; i >= 1; i--) {
			const content = `doc level ${i}\n` + "y".repeat(3000) + `\n@level${i + 1}.md`;
			fs.writeFileSync(path.join(cwdDir, `level${i}.md`), content, "utf-8");
		}
		fs.renameSync(path.join(cwdDir, "leaf.md"), path.join(cwdDir, "level5.md"));
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "# Project Guide\n@level1.md", "utf-8");

		const uncapped = readAllAgentFiles(cwdDir, mockConfigStore([]));
		const capped = readAllAgentFiles(cwdDir, mockConfigStore([]), 500); // 500 tokens = 2000 bytes

		assert.ok(uncapped.length > 14000, `uncapped cascade should reproduce a large blowup (got ${uncapped.length} chars)`);
		assert.ok(capped.length < uncapped.length / 2, `capped cascade should be substantially smaller (uncapped=${uncapped.length}, capped=${capped.length})`);
		assert.ok(capped.includes("# Project Guide"), "root prose always survives");
		assert.ok(capped.includes("AGENTS.md cascade budget"), "capped output is transparent about the cut");
	});
});

// ── getPromptSections — per-section truncated flag ──────────────────────────

describe("getPromptSections — AGENTS.md budget marks truncated sections", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("marks a section truncated:true when the budget cut it, and omits the flag when off", () => {
		fs.mkdirSync(path.join(cwdDir, "docs"), { recursive: true });
		fs.writeFileSync(path.join(cwdDir, "docs", "big.md"), "BIG ".repeat(3000), "utf-8");
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "root\n@docs/big.md", "utf-8");

		const uncapped = getPromptSections({ cwd: cwdDir, projectConfigStore: mockConfigStore([]) });
		const agentsUncapped = uncapped.find(s => s.label === "Project AGENTS.md");
		assert.ok(agentsUncapped);
		assert.ok(!agentsUncapped.truncated);

		const capped = getPromptSections({ cwd: cwdDir, projectConfigStore: mockConfigStore([]), agentsMdBudgetTokens: 20 });
		const agentsCapped = capped.find(s => s.label === "Project AGENTS.md");
		assert.ok(agentsCapped);
		assert.equal(agentsCapped.truncated, true);
		assert.ok(agentsCapped.tokens < agentsUncapped.tokens, "capped section token estimate should shrink");
	});
});
