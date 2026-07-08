import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { test, expect } from "./in-process-harness.js";
import { apiFetch, deleteSession } from "./e2e-setup.js";
import { awaitableRm } from "./test-utils/cleanup.js";

type GitFixture = {
	cwd: string;
	baseSha: string;
	headSha: string;
	cleanup: () => Promise<void>;
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function cleanupGitFixture(cwd: string): Promise<void> {
	await awaitableRm(cwd, {
		maxAttempts: 8,
		backoffMs: 100,
		onFinalFailure: (err) => {
			const msg = (err as Error)?.message ?? String(err);
			console.warn(`[pr-walkthrough-api] cleanup deferred for ${cwd}: ${msg}`);
		},
	});
}

function makeGitFixture(): GitFixture {
	const cwd = mkdtempSync(join(tmpdir(), "bobbit-pr-walkthrough-"));
	git(cwd, ["init"]);
	git(cwd, ["config", "user.name", "Bobbit E2E"]);
	git(cwd, ["config", "user.email", "bobbit-e2e@example.test"]);
	writeFileSync(join(cwd, "README.md"), "# Demo\n\nFirst line\n", "utf-8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "base"]);
	const baseSha = git(cwd, ["rev-parse", "HEAD"]);
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, "README.md"), "# Demo\n\nFirst line\nSecond line\n", "utf-8");
	writeFileSync(join(cwd, "src", "feature.ts"), "export const answer = 42;\n", "utf-8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "head"]);
	const headSha = git(cwd, ["rev-parse", "HEAD"]);
	return { cwd, baseSha, headSha, cleanup: () => cleanupGitFixture(cwd) };
}

async function resolveLocal(fixture: GitFixture): Promise<any> {
	const resp = await apiFetch("/api/pr-walkthrough/resolve", {
		method: "POST",
		body: JSON.stringify({ cwd: fixture.cwd, baseSha: fixture.baseSha, headSha: fixture.headSha }),
	});
	expect(resp.status).toBe(200);
	return resp.json();
}

async function startMockGithubApi(status: number, body: unknown, headers: Record<string, string> = {}): Promise<{ baseUrl: string; requests: Array<{ url?: string; authorization?: string }>; close: () => Promise<void> }> {
	const requests: Array<{ url?: string; authorization?: string }> = [];
	const server = createServer((req, res) => {
		requests.push({ url: req.url, authorization: req.headers.authorization });
		res.writeHead(status, { "Content-Type": "application/json", ...headers });
		res.end(JSON.stringify(body));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address !== "object") throw new Error("mock GitHub API did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
	};
}

function firstLineAnchor(result: any): { cardId: string; diffBlockId: string; lineId: string } {
	for (const card of result.cards ?? []) {
		for (const block of card.diffBlocks ?? []) {
			for (const hunk of block.hunks ?? []) {
				const line = (hunk.lines ?? []).find((item: any) => item.newLine || item.oldLine);
				if (line) return { cardId: card.id, diffBlockId: block.id, lineId: line.id };
			}
		}
	}
	throw new Error("resolved walkthrough had no line anchors");
}

test.describe("PR walkthrough REST API", () => {
	// Sessions this spec mints server-side (parent launchers + their
	// `prw-session-*` walkthrough children). These MUST be deleted: a leaked
	// `prw-session-*` survives on the shared in-process API worker, and when
	// project-delete-last.spec.ts later drains every project the orphaned child
	// can no longer resolve its store — the server then throws
	// "Cannot resolve store for session prw-session-...: not found in any project".
	const createdSessionIds: string[] = [];

	async function cleanupCreatedSessions(): Promise<void> {
		// Delete in reverse creation order so children are removed before their
		// parent launcher session.
		while (createdSessionIds.length) {
			const id = createdSessionIds.pop()!;
			await deleteSession(id);
		}
	}

	test.afterEach(cleanupCreatedSessions);

	test.afterAll(async () => {
		await cleanupCreatedSessions();
		// Safety-net sweep: delete any walkthrough child session this spec may
		// have minted that escaped the per-test tracking, so no `prw-session-*`
		// orphan outlives the spec.
		try {
			const res = await apiFetch("/api/sessions");
			if (res.ok) {
				const body = await res.json();
				const list: Array<{ id?: string }> = Array.isArray(body) ? body : (body.sessions ?? []);
				for (const s of list) {
					if (s.id && s.id.startsWith("prw-session-")) await deleteSession(s.id);
				}
			}
		} catch { /* best-effort */ }
	});

	// NOTE: the legacy `POST /api/pr-walkthrough/launch` test was removed with the
	// WalkthroughAgentManager launcher (host.agents reviewer migration, design
	// Decision F Phase 3). The reviewer is now minted via the pack `run` route +
	// host.agents.spawn; that flow is covered by the host-agents API/browser E2Es.

	test("POST resolve returns real local diff cards", async () => {
		const fixture = makeGitFixture();
		try {
			const result = await resolveLocal(fixture);
			expect(result.changesetId).toBe(`${fixture.baseSha.slice(0, 7)}..${fixture.headSha.slice(0, 7)}`);
			expect(result.changeset.provider).toBe("local");
			expect(result.changeset.filesChanged).toBe(2);
			expect(result.cards.length).toBeGreaterThanOrEqual(2);
			expect(result.cards.flatMap((card: any) => card.diffBlocks).some((block: any) => block.filePath === "src/feature.ts")).toBe(true);
		} finally {
			await fixture.cleanup();
		}
	});

	test("export preview maps line comments and submit rejects without explicit confirmation", async () => {
		const fixture = makeGitFixture();
		try {
			const result = await resolveLocal(fixture);
			const anchor = firstLineAnchor(result);
			const draft = {
				changeset: result.changeset,
				decisions: {},
				completedCardIds: [anchor.cardId],
				updatedAt: new Date().toISOString(),
				comments: [
					{ id: "line-1", ...anchor, body: "Please double-check this line.", source: "custom", createdAt: new Date().toISOString() },
					{ id: "card-1", cardId: anchor.cardId, body: "Card-level concern", source: "custom", createdAt: new Date().toISOString() },
				],
			};

			const previewResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/preview`, {
				method: "POST",
				body: JSON.stringify(draft),
			});
			expect(previewResp.status).toBe(200);
			const preview = await previewResp.json();
			expect(preview.rows.some((row: any) => row.commentId === "line-1" && row.valid && row.path)).toBe(true);
			expect(preview.body).toContain("Card-level concern");

			const submitResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/submit`, {
				method: "POST",
				body: JSON.stringify({ draft }),
			});
			expect(submitResp.status).toBe(400);
			const submitBody = await submitResp.json();
			expect(submitBody.code).toBe("CONFIRMATION_REQUIRED");
		} finally {
			await fixture.cleanup();
		}
	});

	test("invalid refs return structured errors", async () => {
		const fixture = makeGitFixture();
		try {
			const invalidResp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, baseSha: "not-a-sha", headSha: fixture.headSha }),
			});
			expect(invalidResp.status).toBe(400);
			expect((await invalidResp.json()).error).toContain("Invalid baseSha");
		} finally {
			await fixture.cleanup();
		}
	});

	test("large local diffs return truncation warnings instead of maxBuffer failures", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "bobbit-pr-walkthrough-large-"));
		try {
			git(cwd, ["init"]);
			git(cwd, ["config", "user.name", "Bobbit E2E"]);
			git(cwd, ["config", "user.email", "bobbit-e2e@example.test"]);
			writeFileSync(join(cwd, "large.txt"), "base\n", "utf-8");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "base"]);
			const baseSha = git(cwd, ["rev-parse", "HEAD"]);
			writeFileSync(join(cwd, "large.txt"), Array.from({ length: 220_000 }, (_, index) => `line ${index} ${"x".repeat(16)}`).join("\n"), "utf-8");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "large"]);
			const headSha = git(cwd, ["rev-parse", "HEAD"]);

			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd, baseSha, headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.warnings.some((warning: any) => warning.code === "diff-truncated")).toBe(true);
		} finally {
			await cleanupGitFixture(cwd);
		}
	});

	test("empty local diffs resolve to an orientation-only walkthrough instead of a broken response", async () => {
		const fixture = makeGitFixture();
		try {
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, baseSha: fixture.headSha, headSha: fixture.headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.changeset.filesChanged).toBe(0);
			expect(result.cards).toHaveLength(1);
			expect(result.cards[0].phaseId).toBe("orientation");
		} finally {
			await fixture.cleanup();
		}
	});

	test("GitHub PR resolve rejects untrusted hosts with typed errors", async () => {
		const previousToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = "must-not-leak";
		try {
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ prUrl: "https://evil.example/acme/widgets/pull/42" }),
			});
			expect(resp.status).toBe(400);
			const body = await resp.json();
			expect(body.code).toBe("untrusted_github_host");
			expect(body.error).toContain("Untrusted GitHub PR host");
		} finally {
			if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("GitHub adapter auth and permission errors preserve status, code, and warnings", async () => {
		const mock = await startMockGithubApi(403, { message: "Forbidden" }, { "x-ratelimit-remaining": "5" });
		const previousApiBase = process.env.BOBBIT_GITHUB_API_BASE_URL;
		const previousToken = process.env.GITHUB_TOKEN;
		process.env.BOBBIT_GITHUB_API_BASE_URL = mock.baseUrl;
		process.env.GITHUB_TOKEN = "mock-token";
		try {
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ prUrl: "https://github.com/acme/widgets/pull/42" }),
			});
			expect(resp.status).toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("github_permission_denied");
			expect(body.warnings.some((warning: any) => warning.code === "github_permission_denied")).toBe(true);
			expect(mock.requests[0]?.authorization).toBe("Bearer mock-token");
		} finally {
			await mock.close();
			if (previousApiBase === undefined) delete process.env.BOBBIT_GITHUB_API_BASE_URL;
			else process.env.BOBBIT_GITHUB_API_BASE_URL = previousApiBase;
			if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("GitHub PR resolve faked from local SHAs reports gh-auth availability (no previewOnly)", async () => {
		const fixture = makeGitFixture();
		const restore = stubGithubAuthEnv(fakeGhBin(undefined, 1)); // no env token, gh fails
		try {
			const prUrl = "https://github.com/acme/widgets/pull/42";
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, prUrl, baseSha: fixture.baseSha, headSha: fixture.headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.changesetId).toBe(`github:acme/widgets#42:${fixture.headSha.slice(0, 7)}`);
			expect(result.changeset.provider).toBe("github");
			expect(result.changeset.prUrl).toBe(prUrl);
			expect(result.changeset.externalUrl).toBe(prUrl);
			// No creds → not available, actionable reason, and previewOnly is GONE.
			expect(result.export.available).toBe(false);
			expect(result.export.reason).toMatch(/gh auth login/);
			expect(result.export.previewOnly).toBeUndefined();

			const submitResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/submit`, {
				method: "POST",
				body: JSON.stringify({ draft: { comments: [] }, confirm: true }),
			});
			expect(submitResp.status).toBe(400);
			expect((await submitResp.json()).code).toBe("EXPORT_UNAVAILABLE");
		} finally {
			restore();
			await fixture.cleanup();
		}
	});

	test("GitHub PR resolve reports export.available when gh is authenticated", async () => {
		const fixture = makeGitFixture();
		const restore = stubGithubAuthEnv(fakeGhBin("gh-token")); // gh auth token succeeds
		try {
			const prUrl = "https://github.com/acme/widgets/pull/42";
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, prUrl, baseSha: fixture.baseSha, headSha: fixture.headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.export.available).toBe(true);
			expect(result.export.previewOnly).toBeUndefined();
			expect(result.export.reason).toBeUndefined();
		} finally {
			restore();
			await fixture.cleanup();
		}
	});

	test("bearer-gated public submit-review posts via gh, gated by trust + confirm + jobId", async () => {
		const { getPackStore } = await import("../../dist/server/extension-host/pack-store.js");
		const PACK_ID = "pr-walkthrough";
		const store = getPackStore();
		const changeset = {
			baseSha: "aaaaaaa",
			headSha: "bbbbbbb",
			provider: "github",
			prUrl: "https://github.com/acme/widgets/pull/42",
			externalUrl: "https://github.com/acme/widgets/pull/42",
			prNumber: 42,
			prTitle: "Post via gh",
			title: "PR #42: Post via gh",
		};
		const cards = [{ id: "card-1", phaseId: "significant", title: "Card", summary: "s", diffBlocks: [] }];
		const trustedJob = "prw-submit-review-trusted";
		const untrustedJob = "prw-submit-review-untrusted";
		// Trusted github.com binding + finalized payload (avoids needing a git cwd).
		await store.put(PACK_ID, `reviews/${trustedJob}/binding/prw-session-sr-1`, {
			jobId: trustedJob,
			parentSessionId: "owner-sr-1",
			target: { provider: "github", prUrl: changeset.prUrl, owner: "acme", repo: "widgets", number: 42, host: "github.com", canonicalKey: "github:acme/widgets#42" },
		});
		await store.put(PACK_ID, `reviews/${trustedJob}/final/payload`, { changeset, cards });
		// Untrusted enterprise binding.
		await store.put(PACK_ID, `reviews/${untrustedJob}/binding/prw-session-sr-2`, {
			jobId: untrustedJob,
			parentSessionId: "owner-sr-2",
			target: { provider: "github", prUrl: "https://github.example.com/acme/widgets/pull/42", owner: "acme", repo: "widgets", number: 42, host: "github.example.com", canonicalKey: "github:github.example.com/acme/widgets#42" },
		});

		const review = fakeGhCombinedBin();
		const restore = stubGithubAuthEnv(review.dir, review.command);
		try {
			// missing jobId → 400
			const missing = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ confirm: true }) });
			expect(missing.status).toBe(400);
			expect((await missing.json()).code).toBe("INVALID_SUBMIT_REVIEW_REQUEST");

			// unknown jobId → 404
			const unknown = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: "prw-nope", confirm: true }) });
			expect(unknown.status).toBe(404);
			expect((await unknown.json()).code).toBe("WALKTHROUGH_NOT_BOUND");

			// untrusted host → 403
			const untrusted = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: untrustedJob, confirm: true, draft: { comments: [] } }) });
			expect(untrusted.status).toBe(403);
			expect((await untrusted.json()).code).toBe("untrusted_github_host");

			// confirm omitted → CONFIRMATION_REQUIRED
			const noConfirm = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: trustedJob, draft: { comments: [] } }) });
			expect(noConfirm.status).toBe(400);
			expect((await noConfirm.json()).code).toBe("CONFIRMATION_REQUIRED");

			// probe on a trusted host → { available, reason? }
			const probe = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: trustedJob, probe: true }) });
			expect(probe.status).toBe(200);
			expect((await probe.json()).available).toBe(true);

			// trusted host + confirm + stubbed gh → submitted:true and gh recorded the POST
			const draft = {
				changeset,
				decisions: {},
				completedCardIds: [],
				updatedAt: new Date().toISOString(),
				comments: [{ id: "card-1", cardId: "card-1", body: "Overall looks good.", source: "custom", createdAt: new Date().toISOString() }],
			};
			const submit = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: trustedJob, confirm: true, draft, event: "COMMENT" }) });
			expect(submit.status).toBe(200);
			const submitBody = await submit.json();
			expect(submitBody.submitted).toBe(true);
			const args = review.readArgs();
			expect(args.includes("repos/acme/widgets/pulls/42/reviews")).toBe(true);
			expect(args.includes("POST")).toBe(true);
			expect(args.includes("--input")).toBe(true);
			// The recorded --input payload is the review body built server-side.
			const payload = review.readInput() as { event?: string };
			expect(payload.event).toBe("COMMENT");
		} finally {
			restore();
			await store.deletePrefix(PACK_ID, `reviews/${trustedJob}/`);
			await store.deletePrefix(PACK_ID, `reviews/${untrustedJob}/`);
		}
	});

	test("local SHA plus unsafe PR metadata does not persist clickable external URLs", async () => {
		const fixture = makeGitFixture();
		try {
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, prUrl: "javascript:alert(1)", prNumber: 42, baseSha: fixture.baseSha, headSha: fixture.headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.changeset.provider).toBe("github");
			expect(result.changeset.prUrl).toBeUndefined();
			expect(result.changeset.externalUrl).toBeUndefined();
		} finally {
			await fixture.cleanup();
		}
	});
});

/** A fake `gh` whose `gh auth token` succeeds (prints `token`) or fails (exit>0). */
function fakeGhBin(token: string | undefined, exitCode = 0): string {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-fake-gh-"));
	const posix = exitCode === 0
		? `#!/bin/sh\nprintf '%s\\n' '${token ?? ""}'\n`
		: `#!/bin/sh\necho 'not logged in' >&2\nexit ${exitCode}\n`;
	writeFileSync(join(dir, "gh"), posix, "utf8");
	chmodSync(join(dir, "gh"), 0o755);
	const cmd = exitCode === 0
		? `@echo off\r\necho ${token ?? ""}\r\n`
		: `@echo off\r\necho not logged in 1>&2\r\nexit /b ${exitCode}\r\n`;
	writeFileSync(join(dir, "gh.cmd"), cmd, "utf8");
	return dir;
}

/**
 * A fake `gh` that (a) answers `gh auth token` with a token and (b) records the
 * `gh api …/reviews --method POST --input <file>` invocation (args + payload).
 */
function fakeGhCombinedBin(): { dir: string; command: string; readArgs: () => string[]; readInput: () => unknown } {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-fake-gh-combined-"));
	const rec = mkdtempSync(join(tmpdir(), "bobbit-gh-rec-"));
	const recPosix = rec.replace(/\\/g, "/");
	const okBody = '{"html_url":"https://github.com/acme/widgets/pull/42#pullrequestreview-gh"}';
	const posix =
		`#!/bin/sh\n` +
		`echo "$@" >> "${recPosix}/args.txt"\n` +
		`if [ "$1" = "auth" ] && [ "$2" = "token" ]; then printf '%s\\n' 'gh-token'; exit 0; fi\n` +
		`prev=""\n` +
		`for a in "$@"; do\n` +
		`  if [ "$prev" = "--input" ]; then cp "$a" "${recPosix}/input.json"; fi\n` +
		`  prev="$a"\n` +
		`done\n` +
		`printf '%s\\n' '${okBody}'\n`;
	writeFileSync(join(dir, "gh"), posix, "utf8");
	chmodSync(join(dir, "gh"), 0o755);
	const recWin = rec.replace(/\//g, "\\");
	const cmd =
		`@echo off\r\n` +
		`echo %* >> "${recWin}\\args.txt"\r\n` +
		`if "%~1"=="auth" if "%~2"=="token" (echo gh-token& exit /b 0)\r\n` +
		`:loop\r\n` +
		`if "%~1"=="--input" copy /y "%~2" "${recWin}\\input.json" >nul\r\n` +
		`shift\r\n` +
		`if not "%~1"=="" goto loop\r\n` +
		`echo ${okBody}\r\n`;
	writeFileSync(join(dir, "gh.cmd"), cmd, "utf8");
	return {
		dir,
		command: join(dir, process.platform === "win32" ? "gh.cmd" : "gh"),
		readArgs: () => readFileSync(join(rec, "args.txt"), "utf8").trim().split(/\s+/).filter(Boolean),
		readInput: () => JSON.parse(readFileSync(join(rec, "input.json"), "utf8")),
	};
}

/**
 * Point the in-process server at the fake `gh` (BOBBIT_GH_COMMAND + PATH) and clear
 * env tokens so availability + posting route through gh deterministically. Returns
 * a restore function.
 */
function stubGithubAuthEnv(fakeGhDir: string, command?: string): () => void {
	const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH";
	const previous = {
		GITHUB_TOKEN: process.env.GITHUB_TOKEN,
		GH_TOKEN: process.env.GH_TOKEN,
		BOBBIT_GH_COMMAND: process.env.BOBBIT_GH_COMMAND,
		PATH: process.env[pathKey],
	};
	delete process.env.GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	process.env.BOBBIT_GH_COMMAND = command ?? join(fakeGhDir, process.platform === "win32" ? "gh.cmd" : "gh");
	process.env[pathKey] = `${fakeGhDir}${delimiter}${previous.PATH ?? ""}`;
	return () => {
		if (previous.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
		else process.env.GITHUB_TOKEN = previous.GITHUB_TOKEN;
		if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = previous.GH_TOKEN;
		if (previous.BOBBIT_GH_COMMAND === undefined) delete process.env.BOBBIT_GH_COMMAND;
		else process.env.BOBBIT_GH_COMMAND = previous.BOBBIT_GH_COMMAND;
		if (previous.PATH === undefined) delete process.env[pathKey];
		else process.env[pathKey] = previous.PATH;
	};
}
