import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, it } from "vitest";
import reviewExtension from "../../defaults/tools/review/extension.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = {
	name: string;
	parameters: any;
	execute: (toolCallId: string, params: any) => Promise<ToolResult>;
};

let reviewOpen: RegisteredTool;
let fixtureDir: string;

beforeAll(() => {
	fixtureDir = mkdtempSync(path.join(tmpdir(), "bobbit-review-extension-"));
	writeFileSync(path.join(fixtureDir, "architecture.md"), "# Architecture\n", "utf8");
	writeFileSync(path.join(fixtureDir, "notes.md"), "# Notes\n", "utf8");
	writeFileSync(path.join(fixtureDir, "binary.md"), Buffer.from([0x23, 0x20, 0x61, 0x00, 0x62]));
	mkdirSync(path.join(fixtureDir, "folder.md"));
	process.env.BOBBIT_CWD = fixtureDir;

	const tools = new Map<string, RegisteredTool>();
	reviewExtension({
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	} as any);
	const tool = tools.get("review_open");
	assert.ok(tool, "review_open should be registered");
	reviewOpen = tool;
});

afterAll(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

function textOf(result: ToolResult): string {
	const text = result.content?.[0]?.text;
	assert.equal(typeof text, "string", "review_open should return a text result");
	return text;
}

async function execute(params: any): Promise<ToolResult> {
	return reviewOpen.execute("review-open-contract-test", params);
}

async function executeSuccess(params: any): Promise<any> {
	const result = await execute(params);
	const text = textOf(result);
	assert.doesNotMatch(text, /^Error:/, `REVIEW_OPEN_FILES_CONTRACT: expected success, received ${text}`);
	return JSON.parse(text);
}

async function executeError(params: any): Promise<string> {
	const text = textOf(await execute(params));
	assert.match(text, /^Error:/, `REVIEW_OPEN_FILES_CONTRACT: expected a validation error, received ${text}`);
	return text;
}

function assertCanonicalReview(result: any, expected: {
	title: string;
	replace: boolean;
	files: Array<{ title: string; markdown: string }>;
}): void {
	assert.equal(result.action, "review_open");
	assert.equal(typeof result.reviewId, "string");
	assert.ok(result.reviewId.length > 0, "review identity must be non-empty");
	assert.equal(result.title, expected.title);
	assert.equal(result.replace, expected.replace);
	assert.equal(result.markdown, undefined, "canonical grouped output must not retain top-level markdown");
	assert.equal(result.file, undefined, "canonical grouped output must not retain top-level file");
	assert.equal(result.files.length, expected.files.length);
	assert.deepEqual(
		result.files.map((file: any) => ({ title: file.title, markdown: file.markdown })),
		expected.files,
	);
	for (const file of result.files) {
		assert.equal(typeof file.fileId, "string");
		assert.ok(file.fileId.length > 0, "file identity must be non-empty");
	}
	assert.equal(new Set(result.files.map((file: any) => file.fileId)).size, result.files.length,
		"duplicate file titles must still receive distinct identities");
}

describe("review_open multi-file contract", () => {
	it("publishes a closed schema with exactly one top-level Markdown source mode", () => {
		const schema = reviewOpen.parameters;
		const valid = [
			{ markdown: "" },
			{ file: "architecture.md" },
			{ title: "Bundle", replace: false, files: [{ markdown: "one" }] },
			{ files: [{ title: "Inline", markdown: "one" }, { file: "notes.md" }] },
		];
		for (const params of valid) {
			assert.equal(
				Value.Check(schema, params),
				true,
				`REVIEW_OPEN_FILES_CONTRACT: schema should accept ${JSON.stringify(params)}`,
			);
		}

		const invalid = [
			{},
			{ markdown: "inline", file: "architecture.md" },
			{ files: [] },
			{ markdown: "inline", files: [{ markdown: "nested" }] },
			{ file: "architecture.md", files: [{ markdown: "nested" }] },
			{ files: [{}] },
			{ files: [{ markdown: "nested", file: "notes.md" }] },
			{ files: [{ markdown: 42 }] },
			{ markdown: "inline", unexpected: true },
		];
		for (const params of invalid) {
			assert.equal(
				Value.Check(schema, params),
				false,
				`REVIEW_OPEN_FILES_CONTRACT: schema should reject ${JSON.stringify(params)}`,
			);
		}
	});

	it("mirrors exclusivity and non-empty-array validation for direct execute callers", async () => {
		const invalid = [
			{},
			{ markdown: "inline", file: "architecture.md" },
			{ files: [] },
			{ markdown: "inline", files: [{ markdown: "nested" }] },
			{ file: "architecture.md", files: [{ markdown: "nested" }] },
			{ files: [{}] },
			{ files: [{ markdown: "nested", file: "notes.md" }] },
			{ files: [{ markdown: 42 }] },
		];
		for (const params of invalid) {
			const error = await executeError(params);
			assert.match(error, /provided|exactly one|cannot|non-empty|invalid|must/i,
				`runtime validation should explain ${JSON.stringify(params)}`);
		}
	});

	it("loads mixed inline and relative file entries atomically, preserving order and duplicate titles", async () => {
		const result = await executeSuccess({
			title: "System review",
			files: [
				{ title: "Overview", markdown: "Inline overview" },
				{ title: "Repeated", file: "architecture.md" },
				{ title: "Repeated", markdown: "Inline details" },
				{ file: "notes.md" },
			],
		});
		assertCanonicalReview(result, {
			title: "System review",
			replace: true,
			files: [
				{ title: "Overview", markdown: "Inline overview" },
				{ title: "Repeated", markdown: "# Architecture\n" },
				{ title: "Repeated", markdown: "Inline details" },
				{ title: "notes.md", markdown: "# Notes\n" },
			],
		});
	});

	it("assigns deterministic review and file title defaults", async () => {
		const result = await executeSuccess({
			files: [
				{ markdown: "first" },
				{ file: "architecture.md" },
				{ markdown: "third" },
			],
		});
		assertCanonicalReview(result, {
			title: "Review",
			replace: true,
			files: [
				{ title: "File 1", markdown: "first" },
				{ title: "architecture.md", markdown: "# Architecture\n" },
				{ title: "File 3", markdown: "third" },
			],
		});
	});

	it("keeps legacy inline calls backward compatible, including empty Markdown", async () => {
		const defaultReview = await executeSuccess({ markdown: "" });
		assertCanonicalReview(defaultReview, {
			title: "Review",
			replace: true,
			files: [{ title: "Review", markdown: "" }],
		});

		const titledReview = await executeSuccess({ title: "Release notes", markdown: "# Release", replace: false });
		assertCanonicalReview(titledReview, {
			title: "Release notes",
			replace: false,
			files: [{ title: "Release notes", markdown: "# Release" }],
		});
	});

	it("keeps legacy file calls backward compatible with basename and explicit-title defaults", async () => {
		const defaultReview = await executeSuccess({ file: "architecture.md" });
		assertCanonicalReview(defaultReview, {
			title: "architecture.md",
			replace: true,
			files: [{ title: "architecture.md", markdown: "# Architecture\n" }],
		});

		const titledReview = await executeSuccess({ title: "Architecture", file: "architecture.md" });
		assertCanonicalReview(titledReview, {
			title: "Architecture",
			replace: true,
			files: [{ title: "Architecture", markdown: "# Architecture\n" }],
		});
	});

	it("returns no partial review when any file entry cannot be loaded", async () => {
		const error = await executeError({
			files: [
				{ title: "Loaded first", file: "architecture.md" },
				{ title: "Missing second", file: "missing.md" },
			],
		});
		assert.match(error, /missing\.md/);
		assert.doesNotMatch(error, /\"action\"\s*:\s*\"review_open\"/,
			"atomic failure must not emit a partial review payload");
	});

	it("reuses safe file validation for nested entries", async () => {
		assert.match(await executeError({ files: [{ file: "folder.md" }] }), /not a file/i);
		assert.match(await executeError({ files: [{ file: "binary.md" }] }), /binary/i);
	});

	it("emits fresh replay identities and preserves replace:false for duplicate review titles", async () => {
		const params = {
			title: "Duplicate",
			replace: false,
			files: [
				{ title: "Same", markdown: "first" },
				{ title: "Same", markdown: "second" },
			],
		};
		const first = await executeSuccess(params);
		const second = await executeSuccess(params);
		assertCanonicalReview(first, {
			title: "Duplicate",
			replace: false,
			files: [
				{ title: "Same", markdown: "first" },
				{ title: "Same", markdown: "second" },
			],
		});
		assert.notEqual(first.reviewId, second.reviewId,
			"separate tool results need distinct review identities for deterministic replay");
		assert.deepEqual(
			new Set([...first.files, ...second.files].map((file: any) => file.fileId)).size,
			4,
			"file identities must not collide across duplicate-title reviews",
		);
	});
});
