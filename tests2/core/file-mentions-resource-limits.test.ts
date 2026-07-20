/**
 * Resource, admission, concurrency, and non-regular-target regressions for
 * resolveFileMentions. Kept separate from semantic resolution coverage so
 * both tier-1 files remain within the per-file wall budget under contention.
 */
import { describe, it, beforeAll, afterAll, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { marked } from "marked";

const NOTES_CONTENT = "hello world\nline two";
let cwdDir: string;

beforeAll(() => {
	cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-mentions-resource-test-"));
	fs.writeFileSync(path.join(cwdDir, "notes.txt"), NOTES_CONTENT, "utf-8");
});

afterAll(() => {
	try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const resolverModule = await import("../../src/server/skills/resolve-file-mentions.ts");
const { resolveFileMentions, buildFileReferenceBlock, MAX_MENTIONS_PER_SEND } = resolverModule;
const MAX_FILE_MENTION_RAW_CANDIDATES = Reflect.get(resolverModule, "MAX_FILE_MENTION_RAW_CANDIDATES") as number;
const MAX_FILE_MENTION_UNIQUE_PROBES = Reflect.get(resolverModule, "MAX_FILE_MENTION_UNIQUE_PROBES") as number;
const FileMentionBudgetError = Reflect.get(resolverModule, "FileMentionBudgetError") as unknown;
const EXPECTED_RAW_CANDIDATE_LIMIT = 8_192;
const EXPECTED_UNIQUE_PROBE_LIMIT = 4_096;
const FILE_MENTION_RESOLUTION_CONCURRENCY = (
	Reflect.get(resolverModule, "FILE_MENTION_RESOLUTION_CONCURRENCY")
		?? Reflect.get(resolverModule, "FILE_MENTION_RESOLVER_CONCURRENCY")
) as number;
const EXPECTED_LSTAT_CONCURRENCY = 8;

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function drainMicrotasksUntil(predicate: () => boolean, label: string): Promise<void> {
	for (let turn = 0; turn < 1_000; turn++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	assert.fail(`microtask condition not reached: ${label}`);
}

function missingPathError(): NodeJS.ErrnoException {
	return Object.assign(new Error("missing fixture"), { code: "ENOENT" });
}

async function drainRejectedProbeGates(
	resolutions: Array<Promise<unknown>>,
	gates: Array<Deferred<fs.Stats>>,
	label: string,
): Promise<void> {
	let settled = false;
	const completion = Promise.allSettled(resolutions).then(() => { settled = true; });
	for (let turn = 0; turn < 10_000 && !settled; turn++) {
		for (const gate of gates.splice(0)) gate.reject(missingPathError());
		await Promise.resolve();
		await Promise.resolve();
	}
	assert.equal(settled, true, `deferred resolutions did not settle: ${label}`);
	await completion;
}

function requestedReadLength(call: unknown[]): number {
	const buffer = call[1];
	assert.ok(Buffer.isBuffer(buffer), "descriptor read must receive a caller-owned buffer");
	if (typeof call[2] === "object" && call[2] !== null) {
		const length = (call[2] as { length?: number }).length;
		return length ?? buffer.length;
	}
	assert.equal(typeof call[3], "number", "descriptor read must carry an explicit byte length");
	return call[3] as number;
}

describe("resolveFileMentions resource limits", () => {
	it("exports the documented admission cap constants", async () => {
		assert.equal(MAX_FILE_MENTION_RAW_CANDIDATES, EXPECTED_RAW_CANDIDATE_LIMIT);
		assert.equal(MAX_FILE_MENTION_UNIQUE_PROBES, EXPECTED_UNIQUE_PROBE_LIMIT);
		assert.equal(typeof FileMentionBudgetError, "function");
	});

	it("resolves a valid file in more than 256 KiB of ordinary prose without invoking Marked", async () => {
		const text = `${"x".repeat(256 * 1024 + 1)} @notes.txt`;
		const markdownLexer = vi.spyOn(marked, "lexer");
		try {
			const r = await resolveFileMentions(text, cwdDir);
			assert.equal(markdownLexer.mock.calls.length, 0, "delimiter-free prose must use the direct token scan");
			assert.equal(r.originalText, text);
			assert.deepEqual(
				r.mentions.map((mention) => ({ kind: mention.kind, path: mention.path, range: mention.range })),
				[{ kind: "text", path: "notes.txt", range: [text.indexOf("@notes.txt"), text.length] }],
			);
			assert.equal(
				r.modelText,
				text.slice(0, -"@notes.txt".length) + buildFileReferenceBlock("notes.txt", NOTES_CONTENT),
			);
			assert.deepEqual(r.warnings, []);
		} finally {
			markdownLexer.mockRestore();
		}
	});

	it("excludes 600 code-contained candidates from the post-Markdown raw budget and keeps them literal", async () => {
		const fencedCandidates = Array.from(
			{ length: 300 },
			(_, index) => `@fenced-candidate-${index}.txt`,
		).join(" ");
		const inlineCandidates = Array.from(
			{ length: 300 },
			(_, index) => `@inline-candidate-${index}.txt`,
		).join(" ");
		const proseCandidates = Array.from(
			{ length: EXPECTED_RAW_CANDIDATE_LIMIT },
			() => "@budget-edge-missing.txt",
		).join(" ");
		const text = [
			"```text",
			fencedCandidates,
			"x".repeat(1024 * 1024),
			"```",
			`inline \`${inlineCandidates}\``,
			proseCandidates,
		].join("\n");
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockRejectedValue(missingPathError());
		const promiseOpenSpy = vi.spyOn(fs.promises, "open");
		const openSpy = vi.spyOn(fs, "openSync");

		try {
			assert.ok(text.length > 1024 * 1024, "fixture must exercise large raw Markdown");
			assert.equal(text.match(/@(?:fenced|inline)-candidate-/g)?.length, 600);
			const result = await resolveFileMentions(text, cwdDir);
			assert.equal(result.originalText, text);
			assert.equal(result.modelText, text);
			assert.deepEqual(result.mentions, []);
			assert.deepEqual(result.warnings, []);
			assert.equal(lstatSpy.mock.calls.length, 1, "only the repeated prose target may reach lstat");
			assert.match(String(lstatSpy.mock.calls[0][0]), /budget-edge-missing\.txt$/);
			assert.equal(promiseOpenSpy.mock.calls.length, 0, "missing candidates must not reach promises.open");
			assert.equal(openSpy.mock.calls.length, 0, "missing candidates must not reach openSync");
		} finally {
			openSpy.mockRestore();
			promiseOpenSpy.mockRestore();
			lstatSpy.mockRestore();
		}
	});

	it("excludes indented code beyond both admission budgets without filesystem work", async () => {
		const candidates = [
			"@notes.txt",
			"@variableName",
			"@missing/path-like.ts",
			...Array.from(
				{ length: EXPECTED_RAW_CANDIDATE_LIMIT - 2 },
				(_, index) => `@indented-budget-${index}.txt`,
			),
		];
		const splitAt = Math.ceil(candidates.length / 2);
		const text = [
			...candidates.slice(0, splitAt).map((candidate) => `    ${candidate}`),
			"",
			...candidates.slice(splitAt).map((candidate) => `\t${candidate}`),
		].join("\n");
		const lstatSpy = vi.spyOn(fs.promises, "lstat");
		const promiseOpenSpy = vi.spyOn(fs.promises, "open");
		const realpathSpy = vi.spyOn(fs.realpathSync, "native");
		const statSpy = vi.spyOn(fs, "statSync");
		const openSpy = vi.spyOn(fs, "openSync");
		const readSpy = vi.spyOn(fs, "readSync");

		try {
			assert.equal(candidates.length, EXPECTED_RAW_CANDIDATE_LIMIT + 1);
			assert.ok(candidates.length > EXPECTED_UNIQUE_PROBE_LIMIT);
			const result = await resolveFileMentions(text, cwdDir);
			assert.equal(result.originalText, text);
			assert.equal(result.modelText, text, "all indented code bytes must remain literal");
			assert.deepEqual(result.mentions, []);
			assert.deepEqual(result.warnings, []);
			assert.equal(lstatSpy.mock.calls.length, 0, "indented candidates must not reach lstat");
			assert.equal(promiseOpenSpy.mock.calls.length, 0, "indented candidates must not reach promises.open");
			assert.equal(realpathSpy.mock.calls.length, 0, "indented candidates must not reach realpath");
			assert.equal(statSpy.mock.calls.length, 0, "indented candidates must not reach stat");
			assert.equal(openSpy.mock.calls.length, 0, "indented candidates must not reach openSync");
			assert.equal(readSpy.mock.calls.length, 0, "indented candidates must not reach readSync");
		} finally {
			readSpy.mockRestore();
			openSpy.mockRestore();
			statSpy.mockRestore();
			realpathSpy.mockRestore();
			promiseOpenSpy.mockRestore();
			lstatSpy.mockRestore();
		}
	});

	it("excludes nested container indented code beyond both admission budgets without filesystem work", async () => {
		const candidates = [
			"@notes.txt",
			"@missing/nested-path.ts",
			...Array.from(
				{ length: EXPECTED_RAW_CANDIDATE_LIMIT - 1 },
				(_, index) => `@nested-indented-budget-${index}.txt`,
			),
		];
		const text = [
			"- > quoted",
			"  >",
			`  >     ${candidates.join(" ")}`,
		].join("\n");
		const lstatSpy = vi.spyOn(fs.promises, "lstat");
		const promiseOpenSpy = vi.spyOn(fs.promises, "open");
		const realpathSpy = vi.spyOn(fs.realpathSync, "native");
		const statSpy = vi.spyOn(fs, "statSync");
		const openSpy = vi.spyOn(fs, "openSync");
		const readSpy = vi.spyOn(fs, "readSync");

		try {
			assert.equal(candidates.length, EXPECTED_RAW_CANDIDATE_LIMIT + 1);
			assert.ok(candidates.length > EXPECTED_UNIQUE_PROBE_LIMIT);
			assert.match(
				String(marked.parse(text, { async: false })),
				/<pre><code>@notes\.txt/,
				"Marked must recognize the nested list/blockquote fixture as indented code",
			);

			const result = await resolveFileMentions(text, cwdDir);

			assert.equal(result.originalText, text);
			assert.equal(result.modelText, text, "nested container code must remain literal");
			assert.deepEqual(result.mentions, []);
			assert.deepEqual(result.warnings, []);
			assert.equal(lstatSpy.mock.calls.length, 0, "nested code candidates must not reach lstat");
			assert.equal(promiseOpenSpy.mock.calls.length, 0, "nested code candidates must not reach promises.open");
			assert.equal(realpathSpy.mock.calls.length, 0, "nested code candidates must not reach realpath");
			assert.equal(statSpy.mock.calls.length, 0, "nested code candidates must not reach stat");
			assert.equal(openSpy.mock.calls.length, 0, "nested code candidates must not reach openSync");
			assert.equal(readSpy.mock.calls.length, 0, "nested code candidates must not reach readSync");
		} finally {
			readSpy.mockRestore();
			openSpy.mockRestore();
			statSpy.mockRestore();
			realpathSpy.mockRestore();
			promiseOpenSpy.mockRestore();
			lstatSpy.mockRestore();
		}
	});

	it("rejects non-code candidates above the raw budget before filesystem work", async () => {
		const text = Array.from(
			{ length: EXPECTED_RAW_CANDIDATE_LIMIT + 128 },
			() => "@raw-budget-missing.txt",
		).join(" ");
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockRejectedValue(missingPathError());
		const promiseOpenSpy = vi.spyOn(fs.promises, "open");
		const openSpy = vi.spyOn(fs, "openSync");
		const readSpy = vi.spyOn(fs, "readSync");

		try {
			await assert.rejects(
				() => resolveFileMentions(text, cwdDir),
				(error: unknown) => {
					const record = error as { name?: unknown; code?: unknown; message?: unknown };
					assert.equal(record.name, "FileMentionBudgetError");
					assert.equal(record.code, "FILE_MENTION_CANDIDATE_LIMIT");
					assert.match(String(record.message), /8192.*non-code file-mention candidates/i);
					return true;
				},
				"raw budget overflow must reject the whole prompt explicitly",
			);
			assert.equal(lstatSpy.mock.calls.length, 0, "raw overflow must reject before lstat");
			assert.equal(promiseOpenSpy.mock.calls.length, 0, "raw overflow must reject before promises.open");
			assert.equal(openSpy.mock.calls.length, 0, "raw overflow must reject before openSync");
			assert.equal(readSpy.mock.calls.length, 0, "raw overflow must reject before readSync");
		} finally {
			readSpy.mockRestore();
			openSpy.mockRestore();
			promiseOpenSpy.mockRestore();
			lstatSpy.mockRestore();
		}
	});

	it("stops unique-target preparation at the limit-plus-one sentinel and probes nothing", async () => {
		const overflowTail = 128;
		const text = Array.from(
			{ length: EXPECTED_UNIQUE_PROBE_LIMIT + overflowTail },
			(_, index) => `@unique-budget-${index}.txt`,
		).join(" ");
		const resolvedCwd = path.resolve(cwdDir);
		const resolvePathSpy = vi.spyOn(path, "resolve");
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockRejectedValue(missingPathError());
		const promiseOpenSpy = vi.spyOn(fs.promises, "open");
		const openSpy = vi.spyOn(fs, "openSync");
		const readSpy = vi.spyOn(fs, "readSync");

		try {
			await assert.rejects(
				() => resolveFileMentions(text, cwdDir),
				(error: unknown) => {
					const record = error as { name?: unknown; code?: unknown; message?: unknown };
					assert.equal(record.name, "FileMentionBudgetError");
					assert.equal(record.code, "FILE_MENTION_PROBE_LIMIT");
					assert.match(String(record.message), /4096.*distinct file-mention targets/i);
					return true;
				},
				"unique-target overflow must reject the whole prompt explicitly",
			);
			const preparedCandidates = resolvePathSpy.mock.calls.filter(
				(call) => call[0] === resolvedCwd
					&& typeof call[1] === "string"
					&& /^unique-budget-\d+\.txt$/.test(call[1]),
			);
			assert.equal(
				preparedCandidates.length,
				EXPECTED_UNIQUE_PROBE_LIMIT + 1,
				"the resolver must retain only the limit plus one overflow sentinel",
			);
			assert.equal(preparedCandidates.at(-1)?.[1], `unique-budget-${EXPECTED_UNIQUE_PROBE_LIMIT}.txt`);
			assert.ok(
				!preparedCandidates.some((call) => call[1] === `unique-budget-${EXPECTED_UNIQUE_PROBE_LIMIT + 1}.txt`),
				"candidate preparation must stop immediately at the overflow sentinel",
			);
			assert.equal(lstatSpy.mock.calls.length, 0, "unique overflow must reject before lstat");
			assert.equal(promiseOpenSpy.mock.calls.length, 0, "unique overflow must reject before promises.open");
			assert.equal(openSpy.mock.calls.length, 0, "unique overflow must reject before openSync");
			assert.equal(readSpy.mock.calls.length, 0, "unique overflow must reject before readSync");
		} finally {
			readSpy.mockRestore();
			openSpy.mockRestore();
			promiseOpenSpy.mockRestore();
			lstatSpy.mockRestore();
			resolvePathSpy.mockRestore();
		}
	});

	it("keeps more than 512 genuinely missing prose candidates literal under bounded lstat concurrency", async () => {
		const candidateCount = 513;
		const text = Array.from(
			{ length: candidateCount },
			(_, index) => `@missing-prose-${index}.txt`,
		).join(" ");
		let active = 0;
		let maxActive = 0;
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation((async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				await Promise.resolve();
				throw missingPathError();
			} finally {
				active--;
			}
		}) as typeof fs.promises.lstat);
		const openSpy = vi.spyOn(fs, "openSync");

		try {
			const result = await resolveFileMentions(text, cwdDir);
			assert.equal(result.originalText, text);
			assert.equal(result.modelText, text);
			assert.deepEqual(result.mentions, []);
			assert.deepEqual(result.warnings, []);
			assert.equal(lstatSpy.mock.calls.length, candidateCount);
			assert.ok(maxActive > 0);
			assert.ok(maxActive <= EXPECTED_LSTAT_CONCURRENCY, "missing-target probes must remain bounded");
			assert.equal(openSpy.mock.calls.length, 0, "missing targets must never be opened");
		} finally {
			openSpy.mockRestore();
			lstatSpy.mockRestore();
		}
	});

	it("resolves an existing text file after more than 512 missing candidates with an exact UTF-16 splice", async () => {
		const missing = Array.from(
			{ length: 513 },
			(_, index) => `@missing-before-valid-${index}.txt`,
		).join(" ");
		const text = `😀 ${missing} then @notes.txt.`;
		const token = "@notes.txt";
		const start = text.lastIndexOf(token);
		assert.equal(
			[...text.slice(0, start)].length,
			start - 1,
			"the astral prefix must make UTF-16 and code-point offsets differ",
		);
		const originalLstat = fs.promises.lstat.bind(fs.promises);
		const notesPath = path.join(cwdDir, "notes.txt");
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(((target: fs.PathLike) => {
			if (path.resolve(String(target)) === notesPath) return originalLstat(target);
			return Promise.reject(missingPathError());
		}) as typeof fs.promises.lstat);

		try {
			const result = await resolveFileMentions(text, cwdDir);
			assert.equal(result.originalText, text);
			assert.deepEqual(
				result.mentions.map((mention) => ({ kind: mention.kind, path: mention.path, range: mention.range })),
				[{ kind: "text", path: "notes.txt", range: [start, start + token.length] }],
			);
			assert.equal(
				result.modelText,
				text.slice(0, start) + buildFileReferenceBlock("notes.txt", NOTES_CONTENT) + text.slice(start + token.length),
			);
			assert.deepEqual(result.warnings, []);
			assert.equal(lstatSpy.mock.calls.length, 514);
		} finally {
			lstatSpy.mockRestore();
		}
	});

	it("classifies an existing directory as unresolved without opening or reading it", async () => {
		const directory = path.join(cwdDir, "non-regular-directory");
		fs.mkdirSync(directory, { recursive: true });
		const openSpy = vi.spyOn(fs, "openSync").mockImplementation((() => {
			throw new Error("non-regular target reached openSync");
		}) as typeof fs.openSync);
		const readSpy = vi.spyOn(fs, "readSync");

		try {
			const text = "inspect @non-regular-directory";
			const result = await resolveFileMentions(text, cwdDir);
			assert.equal(result.originalText, text);
			assert.equal(result.modelText, text);
			assert.equal(result.mentions.length, 1);
			assert.equal(result.mentions[0].kind, "unresolved");
			assert.equal(result.mentions[0].reason, "unreadable");
			assert.deepEqual(result.warnings, ["@non-regular-directory: unreadable"]);
			assert.equal(openSpy.mock.calls.length, 0, "directory classification must reject before openSync");
			assert.equal(readSpy.mock.calls.length, 0, "directory classification must reject before readSync");
		} finally {
			readSpy.mockRestore();
			openSpy.mockRestore();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("bounds every descriptor read request to the applicable cap plus one overflow byte", async () => {
		const file = path.join(cwdDir, "bounded-read.bin");
		fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 4, 5]));
		const readSpy = vi.spyOn(fs, "readSync");
		const cases = [
			{ maxMentionFileBytes: 32, maxAggregateBytes: 1_024, expectedCap: 32 },
			{ maxMentionFileBytes: 1_024, maxAggregateBytes: 32, expectedCap: 32 },
		];

		try {
			for (const testCase of cases) {
				const firstCall = readSpy.mock.calls.length;
				const r = await resolveFileMentions("@bounded-read.bin", cwdDir, testCase);
				assert.equal(r.mentions[0].kind, "binary");
				const descriptorReads = readSpy.mock.calls.slice(firstCall);
				assert.ok(descriptorReads.length > 0);
				for (const call of descriptorReads) {
					assert.ok(
						requestedReadLength(call) <= testCase.expectedCap + 1,
						"a descriptor read must not request beyond the per-file/aggregate cap sentinel",
					);
				}
			}
		} finally {
			readSpy.mockRestore();
		}
	});

	it("turns simulated post-fstat growth into an unresolved overflow without unbounded allocation", async () => {
		const file = path.join(cwdDir, "growing.bin");
		fs.writeFileSync(file, Buffer.from([0]));
		const maxMentionFileBytes = 64;
		let largestBuffer = 0;
		let largestRequest = 0;
		const closeSpy = vi.spyOn(fs, "closeSync");
		const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
			_fd: number,
			buffer: NodeJS.ArrayBufferView,
			offsetOrOptions: number | { offset?: number; length?: number },
			length?: number,
		) => {
			assert.ok(Buffer.isBuffer(buffer));
			largestBuffer = Math.max(largestBuffer, buffer.length);
			const offset = typeof offsetOrOptions === "object" ? offsetOrOptions.offset ?? 0 : offsetOrOptions;
			const requested = typeof offsetOrOptions === "object"
				? offsetOrOptions.length ?? buffer.length - offset
				: length!;
			largestRequest = Math.max(largestRequest, requested);
			buffer.fill(0x61, offset, offset + requested);
			return requested;
		}) as typeof fs.readSync);

		try {
			const r = await resolveFileMentions("@growing.bin", cwdDir, {
				maxMentionFileBytes,
				maxAggregateBytes: 1_024,
			});
			assert.equal(r.mentions[0].kind, "unresolved");
			assert.equal(r.mentions[0].reason, "too-large");
			assert.equal(r.mentions[0].content, undefined);
			assert.equal(r.mentions[0].data, undefined);
			assert.equal(r.modelText, "@growing.bin");
			assert.ok(largestRequest <= maxMentionFileBytes + 1);
			assert.ok(largestBuffer <= maxMentionFileBytes + 1, "growth must not cause an unbounded buffer allocation");
			assert.ok(closeSpy.mock.calls.length > 0, "growth overflow must still close the descriptor");
		} finally {
			readSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});

	it("resolves an existing file after at least 100 distinct missing candidates", async () => {
		const missing = Array.from(
			{ length: 128 },
			(_, index) => `@complete-scan-missing-${index}.txt`,
		).join(" ");
		const text = `${missing} @notes.txt`;
		const r = await resolveFileMentions(text, cwdDir);

		assert.deepEqual(
			r.mentions.map((mention) => ({ kind: mention.kind, path: mention.path, range: mention.range })),
			[{
				kind: "text",
				path: "notes.txt",
				range: [text.lastIndexOf("@notes.txt"), text.length],
			}],
		);
		assert.equal(
			r.modelText,
			`${missing} ${buildFileReferenceBlock("notes.txt", NOTES_CONTENT)}`,
			"every missing token must remain byte-for-byte literal",
		);
		assert.deepEqual(r.warnings, []);
	});

	it("shares a module-global resolver limit across concurrent resolutions", async () => {
		const expectedConcurrency = Number.isSafeInteger(FILE_MENTION_RESOLUTION_CONCURRENCY)
			? FILE_MENTION_RESOLUTION_CONCURRENCY
			: 4;
		const resolutionCount = expectedConcurrency + 2;
		const gates: Array<Deferred<fs.Stats>> = [];
		let active = 0;
		let maxActive = 0;
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(((_target: fs.PathLike) => {
			active++;
			maxActive = Math.max(maxActive, active);
			const gate = deferred<fs.Stats>();
			const originalReject = gate.reject;
			gate.reject = (error: unknown) => {
				active--;
				originalReject(error);
			};
			gates.push(gate);
			return gate.promise;
		}) as unknown as typeof fs.promises.lstat);
		const resolutions = Array.from(
			{ length: resolutionCount },
			(_, index) => resolveFileMentions(`@resolver-global-${index}.txt`, cwdDir),
		);

		try {
			await drainMicrotasksUntil(() => gates.length >= expectedConcurrency, "global resolver admission");
			assert.equal(gates.length, expectedConcurrency, "excess resolver calls must wait module-globally");
			assert.equal(FILE_MENTION_RESOLUTION_CONCURRENCY, 4);

			while (lstatSpy.mock.calls.length < resolutionCount) {
				const wave = gates.splice(0);
				assert.ok(wave.length > 0);
				for (const gate of wave) gate.reject(missingPathError());
				await drainMicrotasksUntil(
					() => gates.length > 0 || lstatSpy.mock.calls.length === resolutionCount,
					"next resolver admission wave",
				);
				assert.ok(active <= expectedConcurrency);
			}
			for (const gate of gates.splice(0)) gate.reject(missingPathError());
			const results = await Promise.all(resolutions);
			assert.equal(maxActive, expectedConcurrency);
			assert.ok(results.every((result) => result.mentions.length === 0));
		} finally {
			await drainRejectedProbeGates(resolutions, gates, "module-global resolver limit");
			lstatSpy.mockRestore();
		}
	});

	it("shares the lstat concurrency limit across multiple concurrent resolutions", async () => {
		const resolutionCount = 3;
		const candidatesPerResolution = EXPECTED_LSTAT_CONCURRENCY + 2;
		const totalCandidates = resolutionCount * candidatesPerResolution;
		const gates: Array<Deferred<fs.Stats>> = [];
		let active = 0;
		let maxActive = 0;
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(((_target: fs.PathLike) => {
			active++;
			maxActive = Math.max(maxActive, active);
			const gate = deferred<fs.Stats>();
			const originalReject = gate.reject;
			gate.reject = (error: unknown) => {
				active--;
				originalReject(error);
			};
			gates.push(gate);
			return gate.promise;
		}) as unknown as typeof fs.promises.lstat);
		const resolutions = Array.from({ length: resolutionCount }, (_, resolutionIndex) => {
			const text = Array.from(
				{ length: candidatesPerResolution },
				(_, candidateIndex) => `@lstat-global-${resolutionIndex}-${candidateIndex}.txt`,
			).join(" ");
			return resolveFileMentions(text, cwdDir);
		});

		try {
			await drainMicrotasksUntil(
				() => lstatSpy.mock.calls.length >= EXPECTED_LSTAT_CONCURRENCY,
				"global lstat admission",
			);
			assert.equal(
				lstatSpy.mock.calls.length,
				EXPECTED_LSTAT_CONCURRENCY,
				"concurrent resolver calls must share one lstat pool",
			);
			assert.equal(active, EXPECTED_LSTAT_CONCURRENCY);

			while (lstatSpy.mock.calls.length < totalCandidates) {
				const wave = gates.splice(0);
				assert.ok(wave.length > 0);
				for (const gate of wave) gate.reject(missingPathError());
				await drainMicrotasksUntil(
					() => gates.length > 0 || lstatSpy.mock.calls.length === totalCandidates,
					"next global lstat wave",
				);
				assert.ok(active <= EXPECTED_LSTAT_CONCURRENCY);
			}
			for (const gate of gates.splice(0)) gate.reject(missingPathError());
			const results = await Promise.all(resolutions);
			assert.equal(maxActive, EXPECTED_LSTAT_CONCURRENCY);
			assert.ok(results.every((result) => result.mentions.length === 0));
		} finally {
			await drainRejectedProbeGates(resolutions, gates, "module-global lstat limit");
			lstatSpy.mockRestore();
		}
	});

	it("bounds asynchronous lstat work at fixed concurrency and caches repeated lexical paths", async () => {
		const uniqueTokens = Array.from(
			{ length: EXPECTED_LSTAT_CONCURRENCY * 3 },
			(_, index) => `@concurrency-missing-${index}.txt`,
		);
		const text = [...uniqueTokens, ...uniqueTokens].join(" ");
		const calls: string[] = [];
		const gates: Array<Deferred<fs.Stats>> = [];
		let active = 0;
		let maxActive = 0;
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(((target: fs.PathLike) => {
			calls.push(path.resolve(String(target)));
			active++;
			maxActive = Math.max(maxActive, active);
			const gate = deferred<fs.Stats>();
			const originalReject = gate.reject;
			gate.reject = (error: unknown) => {
				active--;
				originalReject(error);
			};
			gates.push(gate);
			return gate.promise;
		}) as typeof fs.promises.lstat);
		const resolution = resolveFileMentions(text, cwdDir);

		try {
			await drainMicrotasksUntil(
				() => calls.length === EXPECTED_LSTAT_CONCURRENCY,
				"initial lstat worker wave",
			);
			assert.equal(active, EXPECTED_LSTAT_CONCURRENCY);
			assert.equal(maxActive, EXPECTED_LSTAT_CONCURRENCY);
			assert.equal(new Set(calls).size, calls.length, "the initial worker wave must contain distinct paths");

			while (calls.length < uniqueTokens.length) {
				const wave = gates.splice(0);
				assert.ok(wave.length > 0);
				for (const gate of wave) gate.reject(missingPathError());
				await drainMicrotasksUntil(() => gates.length > 0, "next lstat worker wave");
				assert.ok(active <= EXPECTED_LSTAT_CONCURRENCY);
				assert.ok(calls.length <= uniqueTokens.length, "duplicate paths must reuse an in-flight classification");
			}

			for (const gate of gates.splice(0)) gate.reject(missingPathError());
			await drainMicrotasksUntil(
				() => active === 0 || calls.length > uniqueTokens.length,
				"final lstat worker drain",
			);
			assert.equal(calls.length, uniqueTokens.length, "each repeated lexical target requires one lstat");
			assert.equal(new Set(calls).size, uniqueTokens.length);
			assert.equal(maxActive, EXPECTED_LSTAT_CONCURRENCY);

			const r = await resolution;
			assert.equal(r.originalText, text);
			assert.equal(r.modelText, text);
			assert.deepEqual(r.mentions, []);
			assert.deepEqual(r.warnings, []);
		} finally {
			for (let turn = 0; turn < uniqueTokens.length * 2 && gates.length > 0; turn++) {
				for (const gate of gates.splice(0)) gate.reject(missingPathError());
				await Promise.resolve();
			}
			lstatSpy.mockRestore();
		}
	});

	it("reuses identical-path existence classification while preserving the existing mention limit", async () => {
		const n = MAX_MENTIONS_PER_SEND + 3;
		const text = Array.from({ length: n }, () => "@notes.txt").join(" ");
		const r = await resolveFileMentions(text, cwdDir);
		assert.equal(r.mentions.length, n);
		assert.ok(
			r.mentions.slice(0, MAX_MENTIONS_PER_SEND).every(
				(mention) => mention.kind === "text" && mention.path === "notes.txt",
			),
		);
		assert.ok(
			r.mentions.slice(MAX_MENTIONS_PER_SEND).every(
				(mention) => mention.kind === "unresolved" && mention.reason === "too-many-mentions",
			),
		);
		assert.equal(r.warnings.length, 3);
	});
});
