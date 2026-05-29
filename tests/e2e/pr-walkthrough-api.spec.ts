import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

type GitFixture = {
	cwd: string;
	baseSha: string;
	headSha: string;
	cleanup: () => void;
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
	return { cwd, baseSha, headSha, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

async function resolveLocal(fixture: GitFixture): Promise<any> {
	const resp = await apiFetch("/api/pr-walkthrough/resolve", {
		method: "POST",
		body: JSON.stringify({ cwd: fixture.cwd, baseSha: fixture.baseSha, headSha: fixture.headSha }),
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
	test("POST resolve returns real local diff cards and GET returns persisted state", async () => {
		const fixture = makeGitFixture();
		try {
			const result = await resolveLocal(fixture);
			expect(result.changesetId).toBe(`${fixture.baseSha.slice(0, 7)}..${fixture.headSha.slice(0, 7)}`);
			expect(result.changeset.provider).toBe("local");
			expect(result.changeset.filesChanged).toBe(2);
			expect(result.cards.length).toBeGreaterThanOrEqual(2);
			expect(result.cards.flatMap((card: any) => card.diffBlocks).some((block: any) => block.filePath === "src/feature.ts")).toBe(true);

			const getResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}`);
			expect(getResp.status).toBe(200);
			const persisted = await getResp.json();
			expect(persisted.changesetId).toBe(result.changesetId);
			expect(persisted.schemaVersion).toBe(1);
			expect(persisted.cards.length).toBe(result.cards.length);
		} finally {
			fixture.cleanup();
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
			fixture.cleanup();
		}
	});

	test("invalid refs and missing persisted walkthroughs return structured errors", async () => {
		const fixture = makeGitFixture();
		try {
			const invalidResp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, baseSha: "not-a-sha", headSha: fixture.headSha }),
			});
			expect(invalidResp.status).toBe(400);
			expect((await invalidResp.json()).error).toContain("Invalid baseSha");

			const missingResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent("missing..walkthrough")}`);
			expect(missingResp.status).toBe(404);
			expect((await missingResp.json()).error).toContain("Walkthrough not found");
		} finally {
			fixture.cleanup();
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
			fixture.cleanup();
		}
	});

	test("GitHub PR resolve can be faked from local SHAs and remains preview-only without credentials", async () => {
		const fixture = makeGitFixture();
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
			expect(result.export.previewOnly).toBe(true);

			const submitResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/submit`, {
				method: "POST",
				body: JSON.stringify({ draft: { comments: [] }, confirm: true }),
			});
			expect(submitResp.status).toBe(400);
			expect((await submitResp.json()).code).toBe("EXPORT_UNAVAILABLE");
		} finally {
			fixture.cleanup();
		}
	});
});
