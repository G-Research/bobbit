/**
 * Unit tests for `defaults/tools/shell/bash-lsp-hint.ts`.
 *
 * The module exposes `lspHintForBashCommand(command, result)` which returns
 * a one-line hint string when a bash command's primary invocation is a
 * grep-like tool (`grep`, `rg`, `ripgrep`, `ag`, `ack`) searching for a
 * symbol-shaped pattern against TS/JS source AND the command produced
 * non-empty output. Otherwise returns `null`.
 *
 * The heuristic and hint shape are shared with the grep-tool hint in
 * `defaults/tools/_builtins/grep-lsp-hint.ts` — see
 * `tests/grep-lsp-hint.test.ts` for the symbol-shape policy. These tests
 * focus on bash-command tokenisation and target-path detection.
 *
 * Pure module — these tests use synthetic result objects and never spawn
 * a shell.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { lspHintForBashCommand } from "../defaults/tools/shell/bash-lsp-hint.ts";

function bashResult(text: string) {
	return { content: [{ type: "text", text }] };
}
function emptyResult() {
	return { content: [{ type: "text", text: "" }] };
}

const SAMPLE_HIT =
	"src/app/goals.ts:42:export function archiveGoal(id: string) {";

function assertHintShape(hint: string) {
	assert.ok(hint.startsWith("[lsp-hint]"), `hint must be prefixed: ${hint}`);
	assert.ok(!hint.includes("\n"), `hint must be one line: ${hint}`);
	assert.ok(
		hint.length <= 200,
		`hint must be ≤200 chars, got ${hint.length}: ${hint}`,
	);
}

describe("lspHintForBashCommand — emits for symbol-shaped grep-like bash commands", () => {
	it("`grep -n \"archiveGoal|deleteGoal\" src/app/` -> hint mentions lsp_workspace_symbol", () => {
		const hint = lspHintForBashCommand(
			'grep -n "archiveGoal|deleteGoal" src/app/',
			bashResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint");
		assertHintShape(hint!);
		assert.ok(
			hint!.includes("lsp_workspace_symbol"),
			`expected lsp_workspace_symbol in hint: ${hint}`,
		);
		assert.ok(
			hint!.includes("archiveGoal"),
			`expected first identifier in hint: ${hint}`,
		);
	});

	it("`grep -rn \"function foo\" src/server/` -> hint emitted (declaration prefix stripped)", () => {
		const hint = lspHintForBashCommand(
			'grep -rn "function foo" src/server/',
			bashResult("src/server/a.ts:1:function foo() {}"),
		);
		assert.ok(hint, "expected a hint for declaration form");
		assertHintShape(hint!);
		assert.ok(
			hint!.includes("foo"),
			`expected identifier 'foo' in hint: ${hint}`,
		);
	});

	it("`grep -rn \"TODO\" src/` -> hint emitted (shared false-positive policy with grep tool)", () => {
		const hint = lspHintForBashCommand(
			'grep -rn "TODO" src/',
			bashResult("src/a.ts:1:// TODO: thing"),
		);
		// TODO is identifier-shaped; the shared heuristic accepts it as a
		// known false positive (same policy as grep-tool hint).
		assert.ok(hint, "expected a hint (acceptable false positive — matches grep-tool policy)");
		assertHintShape(hint!);
	});

	it("`rg \"createSession\\(\" src/` -> hint suggests lsp_references for call-site form", () => {
		const hint = lspHintForBashCommand(
			'rg "createSession\\(" src/',
			bashResult("src/server/agent/manager.ts:88:  createSession(opts);"),
		);
		assert.ok(hint, "expected a hint for ripgrep call-site");
		assertHintShape(hint!);
		assert.ok(
			hint!.includes("lsp_references"),
			`expected lsp_references suggestion: ${hint}`,
		);
		assert.ok(
			hint!.includes("createSession"),
			`expected identifier name in hint: ${hint}`,
		);
	});

	it("`ripgrep` long form is treated the same as `rg`", () => {
		const hint = lspHintForBashCommand(
			'ripgrep "archiveGoal" src/',
			bashResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint for `ripgrep` invocation");
		assertHintShape(hint!);
	});

	it("no path/glob args defaults to TS/JS territory (cwd search)", () => {
		const hint = lspHintForBashCommand(
			'grep -rn "archiveGoal"',
			bashResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint when no path arg — defaults to source territory");
		assertHintShape(hint!);
	});

	it("`--include='*.ts'` flag is recognised as TS/JS target", () => {
		const hint = lspHintForBashCommand(
			"grep -rn --include='*.ts' \"archiveGoal\" .",
			bashResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint when --include targets *.ts");
		assertHintShape(hint!);
	});

	it("`--glob='**/*.ts'` ripgrep flag is recognised as TS/JS target", () => {
		const hint = lspHintForBashCommand(
			"rg --glob='**/*.ts' \"archiveGoal\" .",
			bashResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint when --glob targets **/*.ts");
		assertHintShape(hint!);
	});

	it("`--regexp='archiveGoal'` provides the pattern via long flag", () => {
		const hint = lspHintForBashCommand(
			"grep -rn --regexp='archiveGoal' src/",
			bashResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint when pattern comes from --regexp= flag");
		assertHintShape(hint!);
		assert.ok(
			hint!.includes("archiveGoal"),
			`expected identifier from --regexp= in hint: ${hint}`,
		);
	});

	it("`--include=\"*.ts\"` (double-quoted) is also recognised", () => {
		const hint = lspHintForBashCommand(
			'grep -rn --include="*.ts" "archiveGoal" .',
			bashResult(SAMPLE_HIT),
		);
		assert.ok(hint, "expected a hint when --include is double-quoted");
		assertHintShape(hint!);
	});
});

describe("lspHintForBashCommand — suppresses hint for non-source or non-grep cases", () => {
	it("`grep \"Error initializing\" *.log` -> no hint (log files, not source)", () => {
		const hint = lspHintForBashCommand(
			'grep "Error initializing" *.log',
			bashResult("server.log:1:Error initializing module"),
		);
		assert.equal(hint, null);
	});

	it("`cat file | grep foo` -> no hint (grep is downstream of a pipe; primary cmd is cat)", () => {
		const hint = lspHintForBashCommand(
			"cat file | grep foo",
			bashResult("foo something"),
		);
		assert.equal(hint, null);
	});

	it("`ls -la | grep '.ts'` -> no hint (primary cmd is ls; also non-symbol pattern)", () => {
		const hint = lspHintForBashCommand(
			"ls -la | grep '.ts'",
			bashResult("foo.ts"),
		);
		assert.equal(hint, null);
	});

	it("empty bash output -> no hint, even for a symbol-shaped grep command", () => {
		const hint = lspHintForBashCommand(
			'grep -n "archiveGoal" src/app/',
			emptyResult(),
		);
		assert.equal(hint, null);
	});

	it("no content array -> no hint", () => {
		const hint = lspHintForBashCommand(
			'grep -n "archiveGoal" src/app/',
			{ content: [] },
		);
		assert.equal(hint, null);
	});

	it("non-grep command -> no hint", () => {
		const hint = lspHintForBashCommand(
			"npm run check",
			bashResult("some output"),
		);
		assert.equal(hint, null);
	});

	it("non-symbol free-text grep with space -> no hint", () => {
		const hint = lspHintForBashCommand(
			'grep -rn "hello world" src/',
			bashResult("src/a.ts:1:hello world"),
		);
		assert.equal(hint, null);
	});

	it("grep over *.md target -> no hint (non-source)", () => {
		const hint = lspHintForBashCommand(
			'grep -rn "archiveGoal" docs/*.md',
			bashResult("docs/x.md:1:archiveGoal"),
		);
		assert.equal(hint, null);
	});

	it("grep failure output (`No such file or directory`) -> no hint", () => {
		const hint = lspHintForBashCommand(
			'grep -rn "archiveGoal" missing.ts',
			bashResult("Exit code: 2\ngrep: missing.ts: No such file or directory"),
		);
		assert.equal(hint, null);
	});

	it("ripgrep failure-only output -> no hint", () => {
		const hint = lspHintForBashCommand(
			'rg "archiveGoal" missing.ts',
			bashResult("Exit code: 2\nrg: missing.ts: No such file or directory (os error 2)"),
		);
		assert.equal(hint, null);
	});

	it("mixed grep error + a real match -> hint emitted (real output present)", () => {
		const hint = lspHintForBashCommand(
			'grep -rn "archiveGoal" missing.ts src/app/',
			bashResult(
				"Exit code: 2\ngrep: missing.ts: No such file or directory\nsrc/app/goals.ts:42:archiveGoal",
			),
		);
		assert.ok(hint, "expected hint when at least one line is a real match");
		assertHintShape(hint!);
	});
});

describe("lspHintForBashCommand — env opt-out", () => {
	let prev: string | undefined;
	before(() => {
		prev = process.env.BOBBIT_GREP_LSP_HINT;
		process.env.BOBBIT_GREP_LSP_HINT = "0";
	});
	after(() => {
		if (prev === undefined) delete process.env.BOBBIT_GREP_LSP_HINT;
		else process.env.BOBBIT_GREP_LSP_HINT = prev;
	});

	it("BOBBIT_GREP_LSP_HINT=0 disables bash-grep hint generation", () => {
		const hint = lspHintForBashCommand(
			'grep -n "archiveGoal|deleteGoal" src/app/',
			bashResult(SAMPLE_HIT),
		);
		assert.equal(hint, null);
	});
});
