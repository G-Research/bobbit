import { describe, it } from "node:test";
import assert from "node:assert/strict";

import extensionModule from "../market-packs/pr-walkthrough/tools/pr-walkthrough/extension.ts";
import * as prWalkthroughExtension from "../market-packs/pr-walkthrough/tools/pr-walkthrough/extension.ts";

const extension = extensionModule as any;
const compactApi = prWalkthroughExtension as any;
const HARD_COMPACT_FILE_BUDGET_BYTES = 64 * 1024;

type RegisteredTool = { name: string; execute: (...args: any[]) => Promise<any>; parameters?: any };

function formatCompact(data: unknown, args?: { mode?: unknown; path?: unknown; index?: unknown }): string {
	assert.equal(typeof compactApi.formatCompactPrWalkthroughBundleRead, "function", "extension.ts must export formatCompactPrWalkthroughBundleRead");
	return compactApi.formatCompactPrWalkthroughBundleRead(data, args);
}

function compactChunkResult(data: unknown): unknown {
	assert.equal(typeof compactApi.compactPrWalkthroughChunkResult, "function", "extension.ts must export compactPrWalkthroughChunkResult");
	return compactApi.compactPrWalkthroughChunkResult(data);
}

function bundleHeader() {
	return {
		schema_version: 1,
		kind: "pr-walkthrough-analysis-bundle",
		generated_at: "2026-06-21T00:00:00.000Z",
		job_id: "job-compact-1",
		target: { provider: "github", owner: "SuuBro", repo: "bobbit", number: 837, url: "https://github.com/SuuBro/bobbit/pull/837" },
	};
}

function changeset() {
	return {
		baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		filesChanged: 2,
		additions: 9,
		deletions: 3,
	};
}

function limits() {
	return { maxFiles: 200, maxLinesPerFile: 2000, maxBytes: 51200 };
}

function addedFile() {
	return {
		path: "src/added.ts",
		old_path: undefined,
		status: "added",
		additions: 3,
		deletions: 0,
		is_binary: false,
		is_generated: false,
		is_truncated: false,
		hunks: [
			{
				id: "block-added:h0",
				header: "@@ -0,0 +1,3 @@",
				old_start: 0,
				old_lines: 0,
				new_start: 1,
				new_lines: 3,
				lines: [
					{ id: "block-added:h0:l0", kind: "add", side: "new", new_line: 1, text: "export const added = 1;" },
					{ id: "block-added:h0:l1", kind: "add", side: "new", new_line: 2, text: "export const kept = true;" },
					{ id: "block-added:h0:l2", kind: "add", side: "new", new_line: 3, text: "" },
				],
			},
		],
	};
}

function modifiedFile() {
	return {
		path: "src/modified.ts",
		old_path: "src/old-modified.ts",
		status: "modified",
		additions: 4,
		deletions: 2,
		is_binary: false,
		is_generated: false,
		is_truncated: true,
		truncated: true,
		hunks: [
			{
				id: "block-modified:h0",
				header: "@@ -10,4 +10,5 @@ function first()",
				old_start: 10,
				old_lines: 4,
				new_start: 10,
				new_lines: 5,
				lines: [
					{ id: "block-modified:h0:l0", kind: "context", side: "context", old_line: 10, new_line: 10, text: "const before = true;" },
					{ id: "block-modified:h0:l1", kind: "del", side: "old", old_line: 11, text: "return oldValue;" },
					{ id: "block-modified:h0:l2", kind: "add", side: "new", new_line: 11, text: "return newValue;" },
					{ id: "block-modified:h0:l3", kind: "add", side: "new", new_line: 12, text: "// trailing addition" },
				],
			},
			{
				id: "block-modified:h1",
				header: "@@ -30,3 +31,3 @@ function second()",
				old_start: 30,
				old_lines: 3,
				new_start: 31,
				new_lines: 3,
				lines: [
					{ id: "block-modified:h1:l0", kind: "context", side: "context", old_line: 30, new_line: 31, text: "let value = compute();" },
					{ id: "block-modified:h1:l1", kind: "del", side: "old", old_line: 31, text: "value -= 1;" },
					{ id: "block-modified:h1:l2", kind: "add", side: "new", new_line: 32, text: "value += 1;" },
					{ id: "block-modified:h1:l3", kind: "context", side: "context", old_line: 32, new_line: 33, text: "return value;" },
				],
			},
		],
	};
}

function largeSingleLineBundleFile() {
	return {
		path: "market-packs/terminal/lib/terminal-panel.js",
		old_path: undefined,
		status: "modified",
		additions: 1,
		deletions: 0,
		is_binary: false,
		is_generated: false,
		is_truncated: false,
		hunks: [
			{
				id: "block-terminal-panel:h0",
				header: "@@ -1,0 +1,1 @@",
				old_start: 1,
				old_lines: 0,
				new_start: 1,
				new_lines: 1,
				lines: [
					{
						id: "block-terminal-panel:h0:l0",
						kind: "add",
						side: "new",
						new_line: 1,
						text: `(()=>{${"a".repeat(700_000)}})();`,
					},
				],
			},
		],
	};
}

function fileRead(file = modifiedFile(), overrides: Record<string, unknown> = {}) {
	return {
		bundle: bundleHeader(),
		target: bundleHeader().target,
		changeset: changeset(),
		limits: limits(),
		file,
		hunkOffset: 0,
		hunkLimit: 1,
		totalHunks: file.hunks.length,
		truncated: file.hunks.length > 1,
		...overrides,
	};
}

function manifestRead() {
	const files = [addedFile(), modifiedFile()];
	return {
		mode: "manifest",
		bundle: bundleHeader(),
		changeset: changeset(),
		limits: limits(),
		warnings: [{ code: "file-lines-truncated", filePath: "src/modified.ts" }],
		fileOffset: 0,
		fileLimit: 50,
		totalFiles: files.length,
		files: files.map((file) => ({
			path: file.path,
			old_path: file.old_path,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			is_binary: file.is_binary,
			is_generated: file.is_generated,
			is_truncated: file.is_truncated,
			hunks: file.hunks.length,
		})),
		truncated: false,
	};
}

function expectedMarkerLine(line: any): string {
	const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
	return `${marker}${typeof line.text === "string" ? line.text : ""}`;
}

function compactDiffLines(output: string): string[] {
	const lines = output.split("\n");
	const diffLines: string[] = [];
	let inHunk = false;
	for (const line of lines) {
		if (/^formatter_warnings:/i.test(line)) break;
		if (line.startsWith("@@ ")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line === "" || /^[A-Za-z_ -]+:/.test(line)) continue;
		if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) diffLines.push(line);
	}
	return diffLines;
}

function installEnvAndRegisterTools() {
	const previousEnv = { ...process.env };
	process.env.BOBBIT_SESSION_ID = "session-compact";
	process.env.BOBBIT_SESSION_SECRET = "secret-compact";
	process.env.BOBBIT_GATEWAY_URL = "https://gateway.test";
	process.env.BOBBIT_TOKEN = "token-compact";
	const tools = new Map<string, RegisteredTool>();
	extension({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } });
	return { tools, restoreEnv: () => { process.env = previousEnv; } };
}

async function withMockedFetch<T>(handler: (url: string, init?: any) => Response | Promise<Response>, callback: () => Promise<T>): Promise<T> {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = handler as any;
	try {
		return await callback();
	} finally {
		globalThis.fetch = previousFetch;
	}
}

describe("PR walkthrough compact bundle formatting", () => {
	it("formats an added file as compact diff text with file status and additions", () => {
		const output = formatCompact(fileRead(addedFile()), { mode: "file", path: "src/added.ts" });

		assert.match(output, /PR walkthrough bundle file \(compact\)/i);
		assert.match(output, /bundle:\s*job-compact-1/i);
		assert.match(output, /file:\s*src\/added\.ts/);
		assert.match(output, /status:\s*added/i);
		assert.match(output, /\+3\/-0|\+3\/0/);
		assert.match(output, /@@ -0,0 \+1,3 @@/);
		assert.match(output, /^\+export const added = 1;$/m);
		assert.match(output, /^\+export const kept = true;$/m);
		assert.match(output, /format=legacy.*exact line ids.*old_line.*new_line/i);
	});

	it("formats modified files with multiple hunks and preserves context, add, and remove markers", () => {
		const file = modifiedFile();
		const output = formatCompact(fileRead(file, { hunkLimit: 2, truncated: false }), { mode: "file", path: file.path });

		assert.match(output, /file:\s*src\/modified\.ts/);
		assert.match(output, /previous|old_path|renamed from/i);
		assert.match(output, /src\/old-modified\.ts/);
		assert.match(output, /status:\s*modified/i);
		assert.match(output, /\+4\/-2/);
		assert.match(output, /@@ -10,4 \+10,5 @@ function first\(\)/);
		assert.match(output, /^ const before = true;$/m);
		assert.match(output, /^-return oldValue;$/m);
		assert.match(output, /^\+return newValue;$/m);
		assert.match(output, /@@ -30,3 \+31,3 @@ function second\(\)/);
		assert.match(output, /^ let value = compute\(\);$/m);
		assert.match(output, /^-value -= 1;$/m);
		assert.match(output, /^\+value \+= 1;$/m);
	});

	it("includes file-level and response-level truncation metadata", () => {
		const pagedFile = { ...modifiedFile(), hunks: [modifiedFile().hunks[1]] };
		const output = formatCompact(fileRead(pagedFile, { hunkOffset: 1, hunkLimit: 1, totalHunks: 2, truncated: true }), { mode: "file", path: "src/modified.ts" });

		assert.match(output, /flags:.*truncated=true/i);
		assert.match(output, /binary=false/i);
		assert.match(output, /generated=false/i);
		assert.match(output, /hunks:.*1.*1.*of 2/i);
		assert.match(output, /hunks:.*truncated=true/i);
	});

	it("preserves invalid or missing line fields with neutral markers and formatter warnings outside hunk bodies", () => {
		const file = {
			...modifiedFile(),
			hunks: [{
				id: "block-weird:h0",
				header: "@@ -1,2 +1,2 @@",
				lines: [
					{ id: "block-weird:h0:l0", kind: "context", text: "kept line" },
					{ id: "block-weird:h0:l1", kind: "mystery", text: "unknown kind survives" },
					{ id: "block-weird:h0:l2", text: "missing kind survives" },
				],
			}],
		};
		const output = formatCompact(fileRead(file as any, { totalHunks: 1, truncated: false }), { mode: "file", path: file.path });

		assert.match(output, /^ kept line$/m);
		assert.match(output, /^ unknown kind survives$/m);
		assert.match(output, /^ missing kind survives$/m);
		assert.match(output, /formatter_warnings:/i);
		assert.match(output, /unknown|missing|invalid/i);
		const warningIndex = output.search(/formatter_warnings:/i);
		assert.ok(warningIndex > output.indexOf(" missing kind survives"), "warnings must be emitted after hunk bodies, not inline with diff content");
	});

	it("reconstructs compact diff marker/text lines without losing legacy line content", () => {
		const file = modifiedFile();
		const output = formatCompact(fileRead(file, { hunkLimit: 2, truncated: false }), { mode: "file", path: file.path });
		const expected = file.hunks.flatMap((hunk) => hunk.lines.map(expectedMarkerLine));

		assert.deepEqual(compactDiffLines(output), expected);
	});

	it("is substantially smaller than legacy JSON for a representative hunk", () => {
		const lineCount = 80;
		const file = {
			...modifiedFile(),
			additions: lineCount,
			deletions: 0,
			hunks: [{
				id: "block-large:h0",
				header: `@@ -1,0 +1,${lineCount} @@`,
				lines: Array.from({ length: lineCount }, (_, index) => ({
					id: `block-large:src__server__long_path__file_ts:h0:l${index}`,
					kind: "add",
					side: "new",
					new_line: index + 1,
					text: `const value${index} = ${index};`,
				})),
			}],
		};
		const legacy = fileRead(file as any, { totalHunks: 1, truncated: false });
		const compact = formatCompact(legacy, { mode: "file", path: file.path });
		const legacyJson = JSON.stringify(legacy, null, 2);

		assert.ok(compact.length < legacyJson.length * 0.55, `compact output (${compact.length}) should be much smaller than legacy JSON (${legacyJson.length})`);
		assert.doesNotMatch(compact, /"new_line"|"old_line"|"side"|"id"/);
	});

	it("keeps manifest as the compact read carrying the authoritative envelope", () => {
		const output = formatCompact(manifestRead(), { mode: "manifest" });

		assert.match(output, /PR walkthrough bundle manifest \(compact\)/i);
		assert.match(output, /SuuBro\/bobbit#837|github.*SuuBro.*bobbit.*837/i);
		assert.match(output, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
		assert.match(output, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
		assert.match(output, /limits/i);
		assert.match(output, /src\/added\.ts/);
		assert.match(output, /src\/modified\.ts/);
	});

	it("suppresses repeated full envelopes for compact summary, files, and file follow-up reads", () => {
		const summary = formatCompact({ ...manifestRead(), mode: "summary" }, { mode: "summary" });
		const files = formatCompact({ ...manifestRead(), mode: "files" }, { mode: "files" });
		const file = formatCompact(fileRead(), { mode: "file", path: "src/modified.ts" });

		for (const [name, output] of Object.entries({ summary, files, file })) {
			assert.match(output, /bundle:\s*job-compact-1/i, `${name} should retain a short bundle reference`);
			assert.doesNotMatch(output, /"changeset"|"limits"|"target"/, `${name} should not render repeated JSON envelope objects`);
			assert.doesNotMatch(output, /baseSha|headSha|maxFiles|maxLinesPerFile|https:\/\/github\.com\/SuuBro\/bobbit\/pull\/837/, `${name} should suppress full changeset/limits/target details`);
		}
	});

	it("compacts successful chunk-save route payloads and preserves failure payloads", () => {
		const success = compactChunkResult({
			ok: true,
			saved: true,
			sectionId: "chunk:api",
			chunkSummary: {
				missing: ["audit"],
				nextRequired: "audit",
				chunks: [{ id: "metadata" }, { id: "chunk:api" }],
			},
		});
		assert.deepEqual(success, { saved: true, section_id: "chunk:api", nextRequired: "audit", missing: ["audit"] });

		const failure = { ok: false, code: "PRW_BAD_CHUNK", error: "Invalid chunk", chunkSummary: { missing: ["metadata"] } };
		assert.equal(compactChunkResult(failure), failure, "ok:false route failures must remain unchanged for error rendering");
	});
});

describe("PR walkthrough compact bundle tool integration", () => {
	it("returns legacy gateway output by default and for format=legacy", async () => {
		const { tools, restoreEnv } = installEnvAndRegisterTools();
		const bundleTool = tools.get("read_pr_walkthrough_bundle");
		assert.ok(bundleTool, "expected read_pr_walkthrough_bundle to be registered");
		const responses = [manifestRead(), manifestRead()];
		await withMockedFetch(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }), async () => {
			try {
				const omitted = await bundleTool.execute("call-default", { mode: "manifest" });
				const legacy = await bundleTool.execute("call-legacy", { mode: "manifest", format: "legacy" });

				assert.match(omitted.content[0].text, /"changeset"/);
				assert.match(omitted.content[0].text, /"limits"/);
				assert.deepEqual((omitted.details as any).changeset, changeset());
				assert.deepEqual((omitted.details as any).limits, limits());
				assert.match(legacy.content[0].text, /"changeset"/);
				assert.match(legacy.content[0].text, /"limits"/);
				assert.deepEqual((legacy.details as any).changeset, changeset());
				assert.deepEqual((legacy.details as any).limits, limits());
			} finally {
				restoreEnv();
			}
		});
	});

	it("accepts format=compact without forwarding format to the internal bundle route", async () => {
		const { tools, restoreEnv } = installEnvAndRegisterTools();
		const bundleTool = tools.get("read_pr_walkthrough_bundle");
		assert.ok(bundleTool, "expected read_pr_walkthrough_bundle to be registered");
		let postedBody: any;
		let postedHeaders: any;
		await withMockedFetch(async (_url, init) => {
			postedBody = JSON.parse(String(init?.body ?? "{}"));
			postedHeaders = init?.headers ?? {};
			return new Response(JSON.stringify(fileRead()), { status: 200 });
		}, async () => {
			try {
				const result = await bundleTool.execute("call-compact", { mode: "file", path: "src/modified.ts", index: 3, offset: 4, limit: 5, hunkOffset: 6, hunkLimit: 7, format: "compact" });

				assert.deepEqual(postedBody, {
					mode: "file",
					path: "src/modified.ts",
					index: 3,
					offset: 4,
					limit: 5,
					hunkOffset: 6,
					hunkLimit: 7,
				});
				assert.equal(postedHeaders["X-Bobbit-Session-Secret"], "secret-compact");
				assert.match(result.content[0].text, /PR walkthrough bundle file \(compact\)/i);
				const serialized = JSON.stringify(result);
				assert.doesNotMatch(serialized, /"old_line"|"new_line"|"side"|"lines"/);
				assert.doesNotMatch(serialized, /"changeset"|"limits"|baseSha|headSha|maxFiles|maxLinesPerFile/);
			} finally {
				restoreEnv();
			}
		});
	});

	it("bounds compact file reads for a 700k single-line hunk with truncation/window markers", async () => {
		const { tools, restoreEnv } = installEnvAndRegisterTools();
		const bundleTool = tools.get("read_pr_walkthrough_bundle");
		assert.ok(bundleTool, "expected read_pr_walkthrough_bundle to be registered");
		const file = largeSingleLineBundleFile();
		await withMockedFetch(async () => new Response(JSON.stringify(fileRead(file as any, { totalHunks: 1, hunkLimit: 1, truncated: false })), { status: 200 }), async () => {
			try {
				const result = await bundleTool.execute("call-large-compact", { mode: "file", path: file.path, hunkLimit: 1, format: "compact" });
				const output = String(result.content[0].text);
				const outputBytes = Buffer.byteLength(output, "utf8");
				const hasTruncationOrWindowMarker = /truncated=true|window(?:ed|ing)|omitted|bytes? omitted|request .*slice/i.test(output);

				assert.ok(
					outputBytes <= HARD_COMPACT_FILE_BUDGET_BYTES && hasTruncationOrWindowMarker,
					`compact output must stay below hard budget and include truncation/window markers (bytes=${outputBytes}, budget=${HARD_COMPACT_FILE_BUDGET_BYTES}, hasMarker=${hasTruncationOrWindowMarker})`,
				);
			} finally {
				restoreEnv();
			}
		});
	});

	it("renders compact submit_chunk output while submission_status remains full", async () => {
		const { tools, restoreEnv } = installEnvAndRegisterTools();
		const submitTool = tools.get("submit_pr_walkthrough_chunk");
		const statusTool = tools.get("read_pr_walkthrough_submission_status");
		assert.ok(submitTool, "expected submit_pr_walkthrough_chunk to be registered");
		assert.ok(statusTool, "expected read_pr_walkthrough_submission_status to be registered");
		const requests: any[] = [];
		await withMockedFetch(async (url, init) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			requests.push({ url, body });
			if (url.endsWith("/api/ext/surface-token")) return new Response(JSON.stringify({ token: `surface-${requests.length}` }), { status: 200 });
			const op = body?.init?.body?.op;
			if (op === "submitChunk") {
				return new Response(JSON.stringify({
					ok: true,
					saved: true,
					section_id: "chunk:api",
					chunkSummary: { missing: ["audit"], nextRequired: ["audit"], chunks: [{ id: "metadata" }, { id: "chunk:api" }] },
				}), { status: 200 });
			}
			if (op === "submissionStatus") {
				return new Response(JSON.stringify({
					ok: true,
					chunkSummary: { missing: ["audit"], nextRequired: ["audit"], chunks: [{ id: "metadata" }, { id: "chunk:api" }] },
					finalized: false,
				}), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: false, error: `unexpected op ${op}` }), { status: 200 });
		}, async () => {
			try {
				const saved = await submitTool.execute("call-submit", { section_id: "chunk:api", yaml: "title: API" });
				const status = await statusTool.execute("call-status", {});

				assert.match(saved.content[0].text, /"saved": true/);
				assert.match(saved.content[0].text, /"section_id": "chunk:api"/);
				assert.match(saved.content[0].text, /"missing": \[/);
				assert.doesNotMatch(saved.content[0].text, /chunkSummary|"chunks"/);
				assert.doesNotMatch(JSON.stringify(saved.details), /chunkSummary|"chunks"/);

				assert.match(status.content[0].text, /chunkSummary/);
				assert.match(status.content[0].text, /"chunks"/);
				assert.deepEqual(status.details, {
					ok: true,
					chunkSummary: { missing: ["audit"], nextRequired: ["audit"], chunks: [{ id: "metadata" }, { id: "chunk:api" }] },
					finalized: false,
				});
			} finally {
				restoreEnv();
			}
		});
	});
});
