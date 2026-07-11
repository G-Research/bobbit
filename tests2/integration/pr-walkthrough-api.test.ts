import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { awaitableRm } from "../../tests/e2e/test-utils/cleanup.js";

type GitFixture = {
	cwd: string;
	baseSha: string;
	headSha: string;
	cleanup: () => Promise<void>;
};

type GitFixtureRefs = Pick<GitFixture, "cwd" | "baseSha" | "headSha">;

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
	git(cwd, ["config", "core.autocrlf", "false"]);
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

async function resolveLocal(fixture: GitFixtureRefs, overrides: Record<string, unknown> = {}): Promise<any> {
	const resp = await apiFetch("/api/pr-walkthrough/resolve", {
		method: "POST",
		body: JSON.stringify({ cwd: fixture.cwd, baseSha: fixture.baseSha, headSha: fixture.headSha, ...overrides }),
	});
	expect(resp.status).toBe(200);
	return resp.json();
}

async function resolveFixtureWalkthrough(): Promise<any> {
	const resp = await apiFetch("/api/pr-walkthrough/resolve", {
		method: "POST",
		body: JSON.stringify({ fixture: true }),
	});
	expect(resp.status).toBe(200);
	return resp.json();
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
	let sharedLocalFixture: GitFixture;

	function localFixture(): GitFixtureRefs {
		if (!sharedLocalFixture) throw new Error("shared local PR walkthrough fixture was not initialized");
		return sharedLocalFixture;
	}

	test.beforeAll(() => {
		// Reuse one immutable two-commit repo for route tests that only read diffs.
		sharedLocalFixture = makeGitFixture();
	});

	test.afterAll(async () => {
		if (sharedLocalFixture) await sharedLocalFixture.cleanup();
	});

	// NOTE: the legacy `POST /api/pr-walkthrough/launch` test was removed with the
	// WalkthroughAgentManager launcher (host.agents reviewer migration, design
	// Decision F Phase 3). The reviewer is now minted via the pack `run` route +
	// host.agents.spawn; that flow is covered by the host-agents API/browser E2Es.

	test("POST resolve returns real local diff cards", async () => {
		const fixture = localFixture();
		const result = await resolveLocal(fixture);
		expect(result.changesetId).toBe(`${fixture.baseSha.slice(0, 7)}..${fixture.headSha.slice(0, 7)}`);
		expect(result.changeset.provider).toBe("local");
		expect(result.changeset.filesChanged).toBe(2);
		expect(result.cards.length).toBeGreaterThanOrEqual(2);
		expect(result.cards.flatMap((card: any) => card.diffBlocks).some((block: any) => block.filePath === "src/feature.ts")).toBe(true);
	});

	test("export preview maps line comments and submit rejects without explicit confirmation", async () => {
		const result = await resolveFixtureWalkthrough();
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
	});

	// Master #946 dropped the blanket `previewOnly` denial: a with-SHA github target
	// now reports availability from local gh auth. In the v2 fenced gateway the gh
	// probe is blocked (fail-closed CommandRunner), so this deterministically lands on
	// the "no credentials" branch — available:false + an actionable gh-auth reason,
	// previewOnly GONE. The gh-authenticated (available:true) + gh-posting variants are
	// unit-pinned in tests2/core/pr-walkthrough-export-mapper.test.ts (fake gh, no fence).
	test("GitHub PR resolve faked from local SHAs reports gh-auth availability (no previewOnly)", async () => {
		const fixture = localFixture();
		const prUrl = "https://github.com/acme/widgets/pull/42";
		const result = await resolveLocal(fixture, { prUrl });
		expect(result.changesetId).toBe(`github:acme/widgets#42:${fixture.headSha.slice(0, 7)}`);
		expect(result.changeset.provider).toBe("github");
		expect(result.changeset.prUrl).toBe(prUrl);
		expect(result.changeset.externalUrl).toBe(prUrl);
		// No creds (gh fenced) → not available, actionable reason, and previewOnly is GONE.
		expect(result.export.available).toBe(false);
		expect(result.export.reason).toMatch(/gh auth login/);
		expect(result.export.previewOnly).toBeUndefined();

		const submitResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/submit`, {
			method: "POST",
			body: JSON.stringify({ draft: { comments: [] }, confirm: true }),
		});
		expect(submitResp.status).toBe(400);
		expect((await submitResp.json()).code).toBe("EXPORT_UNAVAILABLE");
	});

	// Bearer-gated public /submit-review route — trust + validation gating (design
	// docs/design/pr-walkthrough-gh-posting.md §4b). The gh POST itself is unit-pinned
	// in tests2/core (fake gh); here the fenced gateway proves the route's structural
	// gates fire BEFORE any gh invocation: bad request, unknown job, untrusted host,
	// and confirm-required — none of which reach gh.
	test("bearer-gated public submit-review enforces jobId + trust + confirm before any gh call", async () => {
		const { getPackStore } = await import("../../src/server/extension-host/pack-store.js");
		const PACK_ID = "pr-walkthrough";
		const store = getPackStore();
		const prUrl = "https://github.com/acme/widgets/pull/42";
		const trustedJob = "prw-submit-review-trusted";
		const untrustedJob = "prw-submit-review-untrusted";
		const changeset = {
			baseSha: "aaaaaaa", headSha: "bbbbbbb", provider: "github", prUrl, externalUrl: prUrl,
			prNumber: 42, prTitle: "Post via gh", title: "PR #42: Post via gh",
		};
		const cards = [{ id: "card-1", phaseId: "significant", title: "Card", summary: "s", diffBlocks: [] }];
		await store.put(PACK_ID, `reviews/${trustedJob}/binding/prw-session-sr-1`, {
			jobId: trustedJob, parentSessionId: "owner-sr-1",
			target: { provider: "github", prUrl, owner: "acme", repo: "widgets", number: 42, host: "github.com", canonicalKey: "github:acme/widgets#42" },
		});
		await store.put(PACK_ID, `reviews/${trustedJob}/final/payload`, { changeset, cards });
		await store.put(PACK_ID, `reviews/${untrustedJob}/binding/prw-session-sr-2`, {
			jobId: untrustedJob, parentSessionId: "owner-sr-2",
			target: { provider: "github", prUrl: "https://github.example.com/acme/widgets/pull/42", owner: "acme", repo: "widgets", number: 42, host: "github.example.com", canonicalKey: "github:github.example.com/acme/widgets#42" },
		});
		try {
			// missing jobId → 400
			const missing = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ confirm: true }) });
			expect(missing.status).toBe(400);
			expect((await missing.json()).code).toBe("INVALID_SUBMIT_REVIEW_REQUEST");

			// unknown jobId → 404
			const unknown = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: "prw-nope", confirm: true }) });
			expect(unknown.status).toBe(404);
			expect((await unknown.json()).code).toBe("WALKTHROUGH_NOT_BOUND");

			// untrusted host → 403 (trust gate fires before gh)
			const untrusted = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: untrustedJob, confirm: true, draft: { comments: [] } }) });
			expect(untrusted.status).toBe(403);
			expect((await untrusted.json()).code).toBe("untrusted_github_host");

			// confirm omitted on a trusted host → CONFIRMATION_REQUIRED (still before gh)
			const noConfirm = await apiFetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: trustedJob, draft: { comments: [] } }) });
			expect(noConfirm.status).toBe(400);
			expect((await noConfirm.json()).code).toBe("CONFIRMATION_REQUIRED");
		} finally {
			await store.deletePrefix(PACK_ID, `reviews/${trustedJob}/`);
			await store.deletePrefix(PACK_ID, `reviews/${untrustedJob}/`);
		}
	});

});
