/**
 * Pinning test: every real-agent prompt-assembly call site in
 * `src/server/agent/session-setup.ts` and `src/server/agent/session-manager.ts`
 * must pass a `baseSystemPromptPath` so the canonical
 * `## Tool selection — LSP before text search` rule (from
 * `defaults/system-prompt.md`) reaches the agent.
 *
 * Historically the assistant / delegate / restore / respawn branches passed
 * `baseSystemPromptPath: undefined`, which silently dropped the global base
 * prompt for those sessions. We pin against that regression here with a
 * source-level grep, plus an assembly-level test that confirms the canonical
 * heading propagates through `assembleSystemPrompt` for assistant- and
 * delegate-shaped inputs (no rolePrompt, no goalSpec from a goal record).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initPromptDirs, assembleSystemPrompt } from "../src/server/agent/system-prompt.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultsSystemPrompt = path.resolve(repoRoot, "defaults/system-prompt.md");
const CANONICAL_HEADER = "## Tool selection — LSP before text search";

let tmpDir: string;
before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-delegate-base-"));
	initPromptDirs(tmpDir);
});
after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Source-level pin: no `baseSystemPromptPath: undefined` in the real agent
//    prompt-assembly paths.
// ---------------------------------------------------------------------------

describe("session-setup / session-manager — base prompt always passed", () => {
	const FILES = [
		"src/server/agent/session-setup.ts",
		"src/server/agent/session-manager.ts",
	];

	for (const rel of FILES) {
		it(`${rel} does not pass baseSystemPromptPath: undefined to assemblePrompt`, () => {
			const file = path.resolve(repoRoot, rel);
			const text = fs.readFileSync(file, "utf-8");
			// Match the literal field set to undefined. Whitespace tolerant.
			const re = /baseSystemPromptPath\s*:\s*undefined/g;
			const matches = text.match(re) || [];
			assert.strictEqual(
				matches.length,
				0,
				`${rel} contains ${matches.length} \`baseSystemPromptPath: undefined\` assignment(s); ` +
				`every real-agent prompt assembly must pass the global base prompt path so the ` +
				`canonical "${CANONICAL_HEADER}" rule reaches the agent.`,
			);
		});
	}
});

// ---------------------------------------------------------------------------
// 2. Assembly-level pin: assistant-shaped and delegate-shaped inputs (no
//    rolePrompt, no goal record) still surface the canonical heading when the
//    base prompt path is passed.
// ---------------------------------------------------------------------------

function assemble(sessionId: string, goalSpec: string, goalTitle: string): string {
	const p = assembleSystemPrompt(sessionId, {
		baseSystemPromptPath: defaultsSystemPrompt,
		cwd: tmpDir,
		goalSpec,
		goalTitle,
		goalState: "active",
		// No rolePrompt — assistant/delegate sessions don't set one.
		// Suppress the conditional `## Symbol-lookup hint` by passing an
		// allowedTools list without `lsp_*` entries; we want to assert the
		// canonical base-prompt section reaches the prompt on its own.
		allowedTools: ["read", "bash", "grep", "find", "ls"],
	});
	assert.ok(p, "assembleSystemPrompt must return a path");
	return fs.readFileSync(p, "utf-8");
}

describe("assistant / delegate prompt assembly carries the canonical rule", () => {
	it("assistant-shaped prompt contains the canonical LSP heading exactly once", () => {
		const content = assemble(
			"assistant-shape",
			"You are the goal assistant. Help the user shape a goal.",
			"Goal Assistant",
		);
		const occurrences = content.split(CANONICAL_HEADER).length - 1;
		assert.strictEqual(
			occurrences,
			1,
			`Expected exactly one "${CANONICAL_HEADER}" in assistant prompt; got ${occurrences}`,
		);
		assert.ok(content.includes("rg"));
		assert.ok(content.includes("ripgrep"));
		assert.ok(content.includes("git grep"));
		assert.ok(content.includes(`lsp_definition({ symbolName: "X" })`));
	});

	it("delegate-shaped prompt contains the canonical LSP heading exactly once", () => {
		const content = assemble(
			"delegate-shape",
			"Investigate and summarize the failing test.",
			"Delegate Task",
		);
		const occurrences = content.split(CANONICAL_HEADER).length - 1;
		assert.strictEqual(
			occurrences,
			1,
			`Expected exactly one "${CANONICAL_HEADER}" in delegate prompt; got ${occurrences}`,
		);
		assert.ok(content.includes(`lsp_definition({ symbolName: "X" })`));
	});
});
