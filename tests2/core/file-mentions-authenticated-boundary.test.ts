import { afterAll, beforeAll, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTHENTICATED_PROMPT_BYTES = 8 * 1024 * 1024;
const RESOLUTION_DEADLINE_MS = 10_000;
const TEST_TIMEOUT_MS = 12_000;
const NOTES_CONTENT = "hello world\nline two";
const SOURCE_CONTENT = "export const x = 1;";
const OUTSIDE_MISSING = "@authenticated-boundary-missing.txt";
const OUTSIDE_VALID = "@notes.txt";
const SUFFIX = `\n\n😀 missing ${OUTSIDE_MISSING} valid ${OUTSIDE_VALID}.`;
let cwdDir: string;

beforeAll(() => {
	cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-mentions-boundary-test-"));
	fs.mkdirSync(path.join(cwdDir, "src"), { recursive: true });
	fs.writeFileSync(path.join(cwdDir, "notes.txt"), NOTES_CONTENT, "utf-8");
	fs.writeFileSync(path.join(cwdDir, "src", "a.ts"), SOURCE_CONTENT, "utf-8");
});

afterAll(() => {
	try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const {
	resolveFileMentions,
	buildFileReferenceBlock,
} = await import("../../src/server/skills/resolve-file-mentions.ts");

function exactBoundaryPrompt(unit: string, prefix = ""): { text: string; repetitions: number } {
	const unitBytes = Buffer.byteLength(unit, "utf8");
	const prefixBytes = Buffer.byteLength(prefix, "utf8");
	const suffixBytes = Buffer.byteLength(SUFFIX, "utf8");
	const repetitions = Math.floor((AUTHENTICATED_PROMPT_BYTES - prefixBytes - suffixBytes) / unitBytes);
	const paddingBytes = AUTHENTICATED_PROMPT_BYTES
		- prefixBytes
		- suffixBytes
		- repetitions * unitBytes;
	const text = prefix + unit.repeat(repetitions) + "x".repeat(paddingBytes) + SUFFIX;
	assert.equal(Buffer.byteLength(text, "utf8"), AUTHENTICATED_PROMPT_BYTES);
	return { text, repetitions };
}

function exactDeepListPrompt(codeTokens: string[]): string {
	const terminal = `\`${codeTokens.join(" ")}\``;
	const fixedBytes = Buffer.byteLength(terminal + SUFFIX, "utf8");
	const markerCount = Math.floor((AUTHENTICATED_PROMPT_BYTES - fixedBytes) / 2);
	const paddingBytes = AUTHENTICATED_PROMPT_BYTES - fixedBytes - markerCount * 2;
	const text = "- ".repeat(markerCount) + " ".repeat(paddingBytes) + terminal + SUFFIX;
	assert.equal(Buffer.byteLength(text, "utf8"), AUTHENTICATED_PROMPT_BYTES);
	return text;
}

async function settleWithin<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	const controller = new AbortController();
	const timeoutError = new Error(`${label} exceeded ${timeoutMs}ms`);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(timeoutError);
	}, timeoutMs);

	try {
		const result = await operation(controller.signal);
		if (timedOut) throw timeoutError;
		return result;
	} catch (error) {
		if (timedOut) throw timeoutError;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function assertExactBoundaryResolution(
	text: string,
	excludedCandidateCount: number,
	label: string,
): Promise<void> {
	const tokenStart = text.lastIndexOf(OUTSIDE_VALID);
	const tokenEnd = tokenStart + OUTSIDE_VALID.length;
	const outsideMissingPath = path.join(cwdDir, OUTSIDE_MISSING.slice(1));
	const notesPath = path.join(cwdDir, OUTSIDE_VALID.slice(1));
	const codeOnlyExistingPath = path.join(cwdDir, "src", "a.ts");
	const lstatSpy = vi.spyOn(fs.promises, "lstat");
	const promiseOpenSpy = vi.spyOn(fs.promises, "open");
	const openSpy = vi.spyOn(fs, "openSync");
	const readSpy = vi.spyOn(fs, "readSync");
	const started = Date.now();

	try {
		assert.ok(
			excludedCandidateCount > 8_192,
			`${label} must contain more code-only candidates than the prose admission budget`,
		);
		assert.equal(
			Buffer.byteLength(text.slice(0, tokenStart), "utf8"),
			tokenStart + 2,
			"the astral suffix must distinguish UTF-8 bytes from UTF-16 mention offsets",
		);

		const result = await settleWithin(
			(signal) => resolveFileMentions(text, cwdDir, { signal }),
			RESOLUTION_DEADLINE_MS,
			`${label} exact authenticated-boundary resolution`,
		);
		const elapsedMs = Date.now() - started;

		assert.equal(result.originalText, text, "all authenticated source bytes must remain stable");
		assert.deepEqual(
			result.mentions.map((mention) => ({
				kind: mention.kind,
				path: mention.path,
				range: mention.range,
			})),
			[{ kind: "text", path: "notes.txt", range: [tokenStart, tokenEnd] }],
			"only the existing prose target may become a mention",
		);
		assert.equal(
			result.modelText,
			text.slice(0, tokenStart)
				+ buildFileReferenceBlock("notes.txt", NOTES_CONTENT)
				+ text.slice(tokenEnd),
			"code-contained and missing prose tokens must remain byte-for-byte literal",
		);
		assert.deepEqual(result.warnings, []);
		assert.ok(
			elapsedMs < RESOLUTION_DEADLINE_MS,
			`${label} must complete within the bounded scan deadline`,
		);

		const lstatTargets = lstatSpy.mock.calls.map((call) => path.resolve(String(call[0])));
		assert.deepEqual(
			lstatTargets.slice().sort(),
			[outsideMissingPath, notesPath].sort(),
			"only the missing and existing prose targets may reach existence classification",
		);
		assert.ok(!lstatTargets.includes(codeOnlyExistingPath), "an existing target used only in code must not reach lstat");
		assert.equal(promiseOpenSpy.mock.calls.length, 0);
		assert.equal(openSpy.mock.calls.length, 1, "the missing and code-only targets must never be opened");
		assert.equal(path.resolve(String(openSpy.mock.calls[0][0])), notesPath);
		assert.ok(readSpy.mock.calls.length > 0, "the one valid prose target must retain snapshot behavior");
	} finally {
		readSpy.mockRestore();
		openSpy.mockRestore();
		promiseOpenSpy.mockRestore();
		lstatSpy.mockRestore();
	}
}

describe("file mention exact authenticated prompt boundary", () => {
	it("exhaustively resolves an exact 8 MiB code-dense prompt without probing code-contained targets", async () => {
		const codeBlock = [
			"```text\r\n",
			"@src/a.ts @code-dense-only-missing.txt @variableName\r\n",
			"```\r\n",
		].join("");
		const codeBlockRepetitions = 3_000;
		const prefix = codeBlock.repeat(codeBlockRepetitions);
		// Every unmatched delimiter occupies its own Markdown paragraph. A full
		// Marked AST would retain well over one million block/inline tokens.
		const { text } = exactBoundaryPrompt("`\r\n\r\n", prefix);

		await assertExactBoundaryResolution(
			text,
			codeBlockRepetitions * 3,
			"code-dense prompt",
		);
	}, TEST_TIMEOUT_MS);

	it("recovers exact ranges in an exact 8 MiB ultra-deep list without degrading code exclusion", async () => {
		const codeTokens = Array.from(
			{ length: 8_193 },
			(_, index) => index % 2 === 0 ? "@src/a.ts" : `@deep-code-only-${index % 8}.txt`,
		);
		const text = exactDeepListPrompt(codeTokens);

		await assertExactBoundaryResolution(text, codeTokens.length, "ultra-deep-list prompt");
	}, TEST_TIMEOUT_MS);
});
