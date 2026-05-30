import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildGithubReviewPreview,
	createGithubReviewPayload,
	submitGithubReview,
	type PrWalkthroughCard,
	type PrWalkthroughReviewDraft,
} from "../src/server/pr-walkthrough/export-mapper.ts";
import {
	GithubPrAdapterError,
	parseGithubPrReference,
	parseGithubRemoteUrl,
	resolveGithubPr,
} from "../src/server/pr-walkthrough/github-adapter.ts";
import { submitExportForTesting } from "../src/server/pr-walkthrough/routes.ts";

const cards: PrWalkthroughCard[] = [
	{
		id: "card-1",
		phaseId: "significant",
		title: "Review exported comments",
		summary: "Maps walkthrough line comments to GitHub review rows.",
		diffBlocks: [
			{
				id: "block-1",
				filePath: "src/example.ts",
				hunks: [
					{
						id: "hunk-1",
						header: "@@ -10,2 +10,3 @@",
						lines: [
							{ id: "line-old", side: "old", oldLine: 10, text: "old value", kind: "del" },
							{ id: "line-new", side: "new", newLine: 11, text: "new value", kind: "add" },
							{ id: "line-context", side: "context", oldLine: 12, newLine: 12, text: "context", kind: "context" },
						],
					},
				],
			},
			{
				id: "block-binary",
				filePath: "assets/logo.png",
				status: "binary",
				hunks: [
					{
						id: "binary-hunk",
						header: "Binary files differ",
						lines: [{ id: "binary-line", side: "new", text: "binary", kind: "add" }],
					},
				],
			},
		],
	},
];

function draft(): PrWalkthroughReviewDraft {
	return {
		changeset: {
			baseSha: "aaaaaaa",
			headSha: "bbbbbbb",
			provider: "github",
			prUrl: "https://github.com/SuuBro/bobbit/pull/42",
			externalUrl: "https://github.com/SuuBro/bobbit/pull/42",
			prNumber: 42,
			prTitle: "Complete review export",
			title: "PR #42: Complete review export",
		},
		decisions: {
			"card-1": { cardId: "card-1", value: "disliked", commentIds: ["c1"], updatedAt: "2026-01-01T00:00:00.000Z" },
		},
		comments: [
			{ id: "c1", cardId: "card-1", diffBlockId: "block-1", lineId: "line-new", body: "Please tighten this new branch.", source: "custom", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "c2", cardId: "card-1", diffBlockId: "block-1", lineId: "line-old", body: "Deleted line note.", source: "custom", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "c3", cardId: "card-1", body: "Card-level concern stays in the review body.", source: "custom", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "c4", cardId: "card-1", diffBlockId: "block-1", lineId: "missing", body: "Missing anchor remains visible.", source: "custom", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "c5", cardId: "card-1", diffBlockId: "block-binary", lineId: "binary-line", body: "Binary cannot be reviewed inline.", source: "custom", createdAt: "2026-01-01T00:00:00.000Z" },
		],
		completedCardIds: ["card-1"],
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("PR walkthrough GitHub export mapper", () => {
	it("maps line comments to GitHub preview rows and card comments to the review body", () => {
		const preview = buildGithubReviewPreview(draft(), cards);

		assert.deepEqual(preview.target, {
			provider: "github",
			owner: "SuuBro",
			repo: "bobbit",
			prNumber: 42,
			prUrl: "https://github.com/SuuBro/bobbit/pull/42",
			headSha: "bbbbbbb",
		});
		assert.equal(preview.validCommentCount, 2);
		assert.equal(preview.unmappableCommentCount, 2);
		assert.match(preview.body, /Card-level concern stays in the review body/);
		assert.match(preview.body, /Missing anchor remains visible/);

		const newRow = preview.rows.find(row => row.commentId === "c1");
		assert.ok(newRow);
		assert.equal(newRow.valid, true);
		assert.equal(newRow.path, "src/example.ts");
		assert.equal(newRow.side, "RIGHT");
		assert.equal(newRow.line, 11);

		const oldRow = preview.rows.find(row => row.commentId === "c2");
		assert.ok(oldRow);
		assert.equal(oldRow.valid, true);
		assert.equal(oldRow.side, "LEFT");
		assert.equal(oldRow.line, 10);

		const missingRow = preview.rows.find(row => row.commentId === "c4");
		assert.ok(missingRow);
		assert.equal(missingRow.valid, false);
		assert.match(missingRow.reason ?? "", /anchor was not found/);

		const binaryRow = preview.rows.find(row => row.commentId === "c5");
		assert.ok(binaryRow);
		assert.equal(binaryRow.valid, false);
		assert.match(binaryRow.reason ?? "", /no GitHub-reviewable text diff/);
	});

	it("builds a GitHub review payload from only valid preview rows", () => {
		const preview = buildGithubReviewPreview(draft(), cards);
		const payload = createGithubReviewPayload(preview, "REQUEST_CHANGES");

		assert.equal(payload.event, "REQUEST_CHANGES");
		assert.equal(payload.commit_id, "bbbbbbb");
		const comments = payload.comments as Array<{ path: string; side: string; line: number; body: string }>;
		assert.equal(comments.length, 2);
		assert.deepEqual(comments.map(comment => [comment.path, comment.side, comment.line]), [
			["src/example.ts", "RIGHT", 11],
			["src/example.ts", "LEFT", 10],
		]);
	});

	it("never submits without explicit confirmation", async () => {
		const preview = buildGithubReviewPreview(draft(), cards);
		let calls = 0;
		const result = await submitGithubReview(preview, { confirm: false, token: "token" }, {
			fetch: async () => {
				calls += 1;
				throw new Error("fetch must not be called");
			},
		});

		assert.equal(result.ok, false);
		assert.equal(result.status, 400);
		assert.equal(result.submitted, false);
		assert.equal(calls, 0);
	});

	it("submits only after confirm=true with credentials", async () => {
		const preview = buildGithubReviewPreview(draft(), cards);
		let requestedUrl = "";
		let requestedBody = "";
		const result = await submitGithubReview(preview, { confirm: true, token: "token", event: "COMMENT" }, {
			apiBaseUrl: "https://api.github.test",
			fetch: async (url, init) => {
				requestedUrl = url;
				requestedBody = init?.body ?? "";
				return response(200, { html_url: "https://github.com/SuuBro/bobbit/pull/42#pullrequestreview-1" });
			},
		});

		assert.equal(result.ok, true);
		assert.equal(result.submitted, true);
		assert.equal(result.reviewUrl, "https://github.com/SuuBro/bobbit/pull/42#pullrequestreview-1");
		assert.equal(requestedUrl, "https://api.github.test/repos/SuuBro/bobbit/pulls/42/reviews");
		const body = JSON.parse(requestedBody) as { comments: unknown[]; event: string };
		assert.equal(body.event, "COMMENT");
		assert.equal(body.comments.length, 2);
	});

	it("route submit builds a preview before mocked GitHub submission", async () => {
		const server = await startMockGithubReviewServer();
		const previousToken = process.env.GITHUB_TOKEN;
		const previousApiBase = process.env.BOBBIT_GITHUB_API_BASE_URL;
		process.env.GITHUB_TOKEN = "route-token";
		process.env.BOBBIT_GITHUB_API_BASE_URL = server.baseUrl;
		try {
			const result = await submitExportForTesting("github:SuuBro/bobbit#42:bbbbbbb", {
				changesetId: "github:SuuBro/bobbit#42:bbbbbbb",
				changeset: draft().changeset,
				cards,
				warnings: [],
				export: { provider: "github", available: true },
			}, { draft: draft(), event: "REQUEST_CHANGES" });

			assert.equal(result.ok, true);
			assert.equal(result.submitted, true);
			assert.equal(server.requests.length, 1);
			assert.equal(server.requests[0]?.url, "/repos/SuuBro/bobbit/pulls/42/reviews");
			assert.equal(server.requests[0]?.authorization, "Bearer route-token");
			assert.equal(server.requests[0]?.body.event, "REQUEST_CHANGES");
			assert.equal(server.requests[0]?.body.comments.length, 2);
		} finally {
			await server.close();
			if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previousToken;
			if (previousApiBase === undefined) delete process.env.BOBBIT_GITHUB_API_BASE_URL;
			else process.env.BOBBIT_GITHUB_API_BASE_URL = previousApiBase;
		}
	});
});

describe("PR walkthrough GitHub adapter", () => {
	it("rejects untrusted PR URL hosts before adding credentials or fetching", async () => {
		assert.throws(
			() => parseGithubPrReference({ prUrl: "https://evil.example/SuuBro/bobbit/pull/1842" }),
			(error: unknown) => error instanceof GithubPrAdapterError && error.status === 400 && error.code === "untrusted_github_host",
		);

		let calls = 0;
		await assert.rejects(
			resolveGithubPr({
				prUrl: "https://evil.example/SuuBro/bobbit/pull/1842",
				token: "secret-token",
				fetch: async () => {
					calls += 1;
					throw new Error("fetch must not be called for untrusted hosts");
				},
			}),
			(error: unknown) => error instanceof GithubPrAdapterError && error.code === "untrusted_github_host",
		);
		assert.equal(calls, 0);
	});

	it("parses GitHub PR URLs and origin remotes", () => {
		assert.deepEqual(parseGithubPrReference({ prUrl: "https://github.com/SuuBro/bobbit/pull/1842" }), {
			owner: "SuuBro",
			repo: "bobbit",
			number: 1842,
			host: "github.com",
			url: "https://github.com/SuuBro/bobbit/pull/1842",
		});
		assert.deepEqual(parseGithubRemoteUrl("git@github.com:SuuBro/bobbit.git"), {
			host: "github.com",
			owner: "SuuBro",
			repo: "bobbit",
		});
	});

	it("uses gh auth token when environment tokens are not configured", async () => {
		await withGithubAuthEnv(fakeGhBin("gh-cli-token"), async () => {
			let authorization: string | undefined;
			const resolved = await resolveGithubPr({
				prUrl: "https://github.com/SuuBro/bobbit/pull/42",
				apiBaseUrl: "https://api.github.test",
				fetch: async (_url, init) => {
					authorization = init?.headers?.Authorization;
					return githubPrOrFilesResponse(_url);
				},
			});

			assert.equal(authorization, "Bearer gh-cli-token");
			assert.equal(resolved.export.available, true);
			assert.equal(resolved.warnings.some(warning => warning.code === "github_unauthenticated"), false);
		});
	});

	it("uses unauthenticated GitHub API silently when no env or gh token is available", async () => {
		await withGithubAuthEnv(fakeGhBin(undefined, 1), async () => {
			let authorization: string | undefined;
			const resolved = await resolveGithubPr({
				prUrl: "https://github.com/SuuBro/bobbit/pull/42",
				apiBaseUrl: "https://api.github.test",
				fetch: async (_url, init) => {
					authorization = init?.headers?.Authorization;
					return githubPrOrFilesResponse(_url);
				},
			});

			assert.equal(authorization, undefined);
			assert.equal(resolved.export.available, false);
			assert.equal(resolved.warnings.some(warning => warning.code === "github_unauthenticated"), false);
		});
	});

	it("resolves PR metadata and file patches through the GitHub API adapter", async () => {
		const calls: string[] = [];
		const resolved = await resolveGithubPr({
			prUrl: "https://github.com/SuuBro/bobbit/pull/42",
			token: "token",
			apiBaseUrl: "https://api.github.test",
			fetch: async (url) => {
				calls.push(url);
				if (url.endsWith("/pulls/42")) {
					return response(200, {
						number: 42,
						title: "Complete review export",
						body: "## Why\nExport reviews back to GitHub.\n\n## Testing\nRun mapper tests.",
						html_url: "https://github.com/SuuBro/bobbit/pull/42",
						base: { sha: "aaaaaaaaaaaa" },
						head: { sha: "bbbbbbbbbbbb" },
						changed_files: 1,
						additions: 1,
						deletions: 0,
					});
				}
				return response(200, [
					{
						filename: "src/example.ts",
						status: "modified",
						additions: 1,
						deletions: 0,
						changes: 1,
						blob_url: "https://github.com/SuuBro/bobbit/blob/bbbbbbbbbbbb/src/example.ts",
						patch: "@@ -1,1 +1,2 @@\n context\n+added",
					},
				]);
			},
		});

		assert.deepEqual(calls, [
			"https://api.github.test/repos/SuuBro/bobbit/pulls/42",
			"https://api.github.test/repos/SuuBro/bobbit/pulls/42/files?per_page=100&page=1",
		]);
		assert.equal(resolved.changesetId, "github:SuuBro/bobbit#42:bbbbbbb");
		assert.equal(resolved.changeset.prTitle, "Complete review export");
		assert.match(resolved.changeset.prBody ?? "", /Export reviews back to GitHub/);
		assert.equal(resolved.export.available, true);
		assert.equal(resolved.files[0].filePath, "src/example.ts");
		assert.equal(resolved.files[0].diffBlocks[0].hunks[0].lines[1].newLine, 2);
		assert.equal(resolved.files[0].diffBlocks[0].externalUrl, "https://github.com/SuuBro/bobbit/blob/bbbbbbbbbbbb/src/example.ts");
	});

	it("marks generated and truncated GitHub patches with warnings and block status", async () => {
		const longPatch = ["@@ -1,1 +1,10 @@", " context", ...Array.from({ length: 10 }, (_, index) => `+generated ${index}`)].join("\n");
		const resolved = await resolveGithubPr({
			prUrl: "https://github.com/SuuBro/bobbit/pull/42",
			token: "token",
			apiBaseUrl: "https://api.github.test",
			maxLinesPerFile: 3,
			fetch: async (url) => {
				if (url.endsWith("/pulls/42")) {
					return response(200, {
						number: 42,
						title: "Generated bundle",
						html_url: "https://github.com/SuuBro/bobbit/pull/42",
						base: { sha: "aaaaaaaaaaaa" },
						head: { sha: "bbbbbbbbbbbb" },
						changed_files: 1,
					});
				}
				return response(200, [{
					filename: "dist/generated.bundle.js",
					status: "added",
					additions: 10,
					deletions: 0,
					changes: 10,
					patch: longPatch,
				}]);
			},
		});

		const file = resolved.files[0];
		assert.equal(file.isGenerated, true);
		assert.equal(file.isTruncated, true);
		assert.equal(file.status, "added");
		assert.equal(file.diffBlocks[0].status, "added");
		assert.equal(file.diffBlocks[0].isGenerated, true);
		assert.ok(resolved.warnings.some(warning => warning.code === "github_generated_file" && warning.filePath === "dist/generated.bundle.js"));
		assert.ok(resolved.warnings.some(warning => /truncated/i.test(warning.code) && warning.filePath === "dist/generated.bundle.js"));
	});

	it("warns when GitHub changed-file pagination lands exactly on the max-files boundary", async () => {
		const resolved = await resolveGithubPr({
			prUrl: "https://github.com/SuuBro/bobbit/pull/42",
			token: "token",
			apiBaseUrl: "https://api.github.test",
			maxFiles: 100,
			fetch: async (url) => {
				if (url.endsWith("/pulls/42")) {
					return response(200, {
						number: 42,
						title: "Many files",
						html_url: "https://github.com/SuuBro/bobbit/pull/42",
						base: { sha: "aaaaaaaaaaaa" },
						head: { sha: "bbbbbbbbbbbb" },
						changed_files: 101,
					});
				}
				return response(200, Array.from({ length: 100 }, (_, index) => ({
					filename: `src/file-${index}.ts`,
					status: "modified",
					patch: "@@ -1,1 +1,2 @@\n context\n+added",
				})));
			},
		});

		assert.equal(resolved.files.length, 100);
		assert.ok(resolved.warnings.some(warning => warning.code === "github_files_truncated"));
	});
});

async function startMockGithubReviewServer(): Promise<{ baseUrl: string; requests: Array<{ url?: string; authorization?: string; body: any }>; close: () => Promise<void> }> {
	const requests: Array<{ url?: string; authorization?: string; body: any }> = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", chunk => chunks.push(Buffer.from(chunk)));
		req.on("end", () => {
			requests.push({
				url: req.url,
				authorization: req.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"),
			});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ html_url: "https://github.com/SuuBro/bobbit/pull/42#pullrequestreview-route" }));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
	};
}

function fakeGhBin(token: string | undefined, exitCode = 0): string {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-fake-gh-"));
	const posixScript = exitCode === 0
		? `#!/bin/sh\nprintf '%s\\n' '${token ?? ""}'\n`
		: `#!/bin/sh\necho 'not logged in' >&2\nexit ${exitCode}\n`;
	writeFileSync(join(dir, "gh"), posixScript, "utf8");
	chmodSync(join(dir, "gh"), 0o755);
	const cmdScript = exitCode === 0
		? `@echo off\r\necho ${token ?? ""}\r\n`
		: `@echo off\r\necho not logged in 1>&2\r\nexit /b ${exitCode}\r\n`;
	writeFileSync(join(dir, "gh.cmd"), cmdScript, "utf8");
	return dir;
}

async function withGithubAuthEnv(fakeGhDir: string, fn: () => Promise<void>): Promise<void> {
	const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH";
	const previous = {
		GITHUB_TOKEN: process.env.GITHUB_TOKEN,
		GH_TOKEN: process.env.GH_TOKEN,
		BOBBIT_GH_COMMAND: process.env.BOBBIT_GH_COMMAND,
		PATH: process.env[pathKey],
	};
	delete process.env.GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	process.env.BOBBIT_GH_COMMAND = join(fakeGhDir, process.platform === "win32" ? "gh.cmd" : "gh");
	process.env[pathKey] = `${fakeGhDir}${delimiter}${previous.PATH ?? ""}`;
	try {
		await fn();
	} finally {
		if (previous.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
		else process.env.GITHUB_TOKEN = previous.GITHUB_TOKEN;
		if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = previous.GH_TOKEN;
		if (previous.BOBBIT_GH_COMMAND === undefined) delete process.env.BOBBIT_GH_COMMAND;
		else process.env.BOBBIT_GH_COMMAND = previous.BOBBIT_GH_COMMAND;
		if (previous.PATH === undefined) delete process.env[pathKey];
		else process.env[pathKey] = previous.PATH;
	}
}

function githubPrOrFilesResponse(url: string) {
	if (url.endsWith("/pulls/42")) {
		return response(200, {
			number: 42,
			title: "Complete review export",
			html_url: "https://github.com/SuuBro/bobbit/pull/42",
			base: { sha: "aaaaaaaaaaaa" },
			head: { sha: "bbbbbbbbbbbb" },
			changed_files: 1,
			additions: 1,
			deletions: 0,
		});
	}
	return response(200, [{
		filename: "src/example.ts",
		status: "modified",
		additions: 1,
		deletions: 0,
		changes: 1,
		patch: "@@ -1,1 +1,2 @@\n context\n+added",
	}]);
}

function response(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status >= 200 && status < 300 ? "OK" : "Error",
		headers: { get: () => null },
		async json() {
			return body;
		},
		async text() {
			return typeof body === "string" ? body : JSON.stringify(body);
		},
	};
}
