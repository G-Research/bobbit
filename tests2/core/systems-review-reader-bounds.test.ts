import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import type { CommandRunner, ExecFileResult } from "../../src/server/gateway-deps.js";
import {
	SYSTEMS_REVIEW_MAX_PAGE_BYTES,
	SYSTEMS_REVIEW_MAX_PAGE_RECORDS,
	SystemsReviewDiffReader,
	SystemsReviewReaderError,
} from "../../src/server/agent/systems-review-reader.js";
import type { SystemsReviewReadPage, SystemsReviewSnapshot } from "../../src/server/agent/systems-review-types.js";

const SECRET = Buffer.alloc(32, 7);
const TREE_OID = "1".repeat(40);
const COMMIT_OID = "2".repeat(40);
const BLOB_OID_PREFIX = "3".repeat(36);
let reader: SystemsReviewDiffReader;
let expectedTreePaths: string[] = [];
let runner: FixtureGitRunner;

interface FixtureEntry {
	path: string;
	oid: string;
	content: Buffer;
}

class FixtureGitRunner implements CommandRunner {
	readonly entries: FixtureEntry[];
	streamedBytes = 0;
	kills = 0;

	constructor(entries: FixtureEntry[]) {
		this.entries = entries;
	}

	async execFile(file: string, args: readonly string[]): Promise<ExecFileResult> {
		if (file !== "git") throw new Error(`unexpected executable ${file}`);
		if (args[0] === "cat-file" && args[1] === "-s") {
			const entry = this.entries.find(candidate => candidate.oid === args[2]);
			if (!entry) throw new Error(`unknown blob ${args[2]}`);
			return { stdout: Buffer.from(`${entry.content.byteLength}\n`), stderr: Buffer.alloc(0) };
		}
		if (args.includes("ls-tree") && !args.includes("-r")) {
			const literal = args.find(value => value.startsWith(":(literal)"));
			const candidatePath = literal?.slice(10);
			const entry = this.entries.find(candidate => candidate.path === candidatePath);
			return {
				stdout: entry ? Buffer.from(`100644 blob ${entry.oid}\t${entry.path}\0`) : Buffer.alloc(0),
				stderr: Buffer.alloc(0),
			};
		}
		throw new Error(`unexpected git command: ${args.join(" ")}`);
	}

	spawn(file: string, args: readonly string[]): ChildProcess {
		if (file !== "git") throw new Error(`unexpected executable ${file}`);
		let chunks: Buffer[];
		if (args.includes("ls-tree") && args.includes("-r")) {
			const literal = args.find(value => value.startsWith(":(literal)"));
			const prefix = literal?.slice(10);
			chunks = this.entries
				.filter(entry => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
				.map(entry => Buffer.from(`100644 blob ${entry.oid}\t${entry.path}\0`));
		} else if (args.includes("ls-tree")) {
			const literal = args.find(value => value.startsWith(":(literal)"));
			const candidatePath = literal?.slice(10);
			const entry = this.entries.find(candidate => candidate.path === candidatePath);
			chunks = entry ? [Buffer.from(`100644 blob ${entry.oid}\t${entry.path}\0`)] : [];
		} else if (args[0] === "cat-file" && args[1] === "-s") {
			const entry = this.entries.find(candidate => candidate.oid === args[2]);
			if (!entry) throw new Error(`unknown blob ${args[2]}`);
			chunks = [Buffer.from(`${entry.content.byteLength}\n`)];
		} else if (args[0] === "cat-file" && args[1] === "blob") {
			const entry = this.entries.find(candidate => candidate.oid === args[2]);
			if (!entry) throw new Error(`unknown blob ${args[2]}`);
			chunks = [];
			for (let offset = 0; offset < entry.content.byteLength; offset += 64 * 1024) chunks.push(entry.content.subarray(offset, offset + 64 * 1024));
		} else {
			throw new Error(`unexpected streaming git command: ${args.join(" ")}`);
		}

		const child = new EventEmitter() as ChildProcess;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		Object.assign(child, { stdout, stderr, stdin: null, stdio: [null, stdout, stderr] });
		let killed = false;
		let closed = false;
		const close = (code: number | null): void => {
			if (closed) return;
			closed = true;
			stdout.end();
			stderr.end();
			queueMicrotask(() => child.emit("close", code));
		};
		child.kill = (() => {
			if (!killed) this.kills++;
			killed = true;
			close(null);
			return true;
		}) as ChildProcess["kill"];
		queueMicrotask(() => {
			for (const chunk of chunks) {
				if (killed) break;
				this.streamedBytes += chunk.byteLength;
				stdout.write(chunk);
			}
			if (!killed) close(0);
		});
		return child;
	}
}

function snapshotForRepo(): SystemsReviewSnapshot {
	return {
		version: 1,
		sessionId: "reader-bounds-session",
		signalId: "reader-bounds-signal",
		createdAt: 1,
		projectRoot: "fixture-root",
		branchContainer: "fixture-root",
		digest: "d".repeat(64),
		derivationSha256: "e".repeat(64),
		repos: [{
			id: "repo",
			root: "fixture-root",
			components: ["app"],
			baseRef: "HEAD",
			baseOid: COMMIT_OID,
			mergeBaseOid: COMMIT_OID,
			mergeBaseTreeOid: TREE_OID,
			headOid: COMMIT_OID,
			headTreeOid: TREE_OID,
		}],
		changes: [],
		coverage: [],
		chunks: [],
	};
}

beforeAll(() => {
	const entries: FixtureEntry[] = [];
	for (let index = 0; index < 600; index++) {
		entries.push({ path: `tree/entry-${String(index).padStart(4, "0")}.txt`, oid: `${BLOB_OID_PREFIX}${String(index).padStart(4, "0")}`, content: Buffer.from(`entry ${index}\n`) });
	}
	const matchLines = Array.from({ length: 350 }, (_, index) => `line ${index}: needle`).join("\n");
	entries.push({ path: "matches.txt", oid: "4".repeat(40), content: Buffer.from(`${matchLines}\n`) });
	entries.push({ path: "dense.txt", oid: "5".repeat(40), content: Buffer.alloc(10 * 1024 * 1024, 0x61) });
	entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
	expectedTreePaths = entries.map(entry => entry.path);
	runner = new FixtureGitRunner(entries);
	reader = new SystemsReviewDiffReader({ snapshot: snapshotForRepo(), secret: SECRET, commandRunner: runner });
});

describe("bounded Systems review list/search traversal", () => {
	it("resumes a large tree without duplicates, omissions, or false completeness", async () => {
		const paths: string[] = [];
		let cursor: string | undefined;
		let expectedStart = 0;
		do {
			const page = await reader.read({ operation: "list", repoId: "repo", side: "head", cursor, limit: 37 });
			expect(page.range.start).toBe(expectedStart);
			expect(page.data).toHaveLength(Math.min(37, expectedTreePaths.length - expectedStart));
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SYSTEMS_REVIEW_MAX_PAGE_BYTES);
			paths.push(...(page.data as Array<{ path: string }>).map(record => record.path));
			expectedStart = page.range.end;
			cursor = page.nextCursor;
			if (cursor) expect(page.range.complete).toBe(false);
			else expect(page.range.complete).toBe(true);
		} while (cursor);
		expect(paths).toEqual(expectedTreePaths);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("early-stops a 10 MiB common-query search with a resumable bounded page", async () => {
		const bytesBefore = runner.streamedBytes;
		const killsBefore = runner.kills;
		const page = await reader.read({ operation: "search", repoId: "repo", side: "head", paths: ["dense.txt"], query: "a", limit: SYSTEMS_REVIEW_MAX_PAGE_RECORDS });
		expect(page.range.complete).toBe(false);
		expect(page.nextCursor).toBeTruthy();
		expect(page.range.end).toBeGreaterThan(0);
		expect(page.range.end).toBeLessThanOrEqual(SYSTEMS_REVIEW_MAX_PAGE_RECORDS);
		expect((page.data as unknown[]).length).toBe(page.range.end);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SYSTEMS_REVIEW_MAX_PAGE_BYTES);
		expect(runner.streamedBytes - bytesBefore).toBeLessThan(10 * 1024 * 1024);
		expect(runner.kills).toBeGreaterThan(killsBefore);

		const tampered = `${page.nextCursor!.slice(0, -1)}${page.nextCursor!.endsWith("a") ? "b" : "a"}`;
		await expect(reader.read({ operation: "search", repoId: "repo", side: "head", paths: ["dense.txt"], query: "a", cursor: tampered })).rejects.toBeInstanceOf(SystemsReviewReaderError);
	});

	it("exhaustively resumes literal matches at exact line and match positions", async () => {
		const matches: Array<{ line: number; column: number; text: string }> = [];
		let cursor: string | undefined;
		let expectedStart = 0;
		do {
			const page: SystemsReviewReadPage = await reader.read({ operation: "search", repoId: "repo", side: "head", paths: ["matches.txt"], query: "needle", cursor, limit: 37 });
			expect(page.range.start).toBe(expectedStart);
			matches.push(...page.data as Array<{ line: number; column: number; text: string }>);
			expectedStart = page.range.end;
			cursor = page.nextCursor;
		} while (cursor);
		expect(matches).toHaveLength(350);
		expect(matches.map(match => match.line)).toEqual(Array.from({ length: 350 }, (_, index) => index + 1));
		for (const match of matches) expect(match.column).toBe(match.text.indexOf("needle") + 1);
	});
});
