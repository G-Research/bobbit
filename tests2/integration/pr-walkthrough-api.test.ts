import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { test, expect } from "./_e2e/in-process-harness.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";
import { apiFetch, createSession, registerProject } from "./_e2e/e2e-setup.js";

type GitFixtureRefs = {
	cwd: string;
	projectId: string;
	sessionId: string;
	baseSha: string;
	headSha: string;
};

type CommandRunnerState = {
	execFile: (...args: any[]) => any;
	spawn: (...args: any[]) => any;
};

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const LOCAL_DIFF = [
	"diff --git a/README.md b/README.md",
	"index 1111111..2222222 100644",
	"--- a/README.md",
	"+++ b/README.md",
	"@@ -1 +1,2 @@",
	" # Demo",
	"+Second line",
	"diff --git a/src/feature.ts b/src/feature.ts",
	"new file mode 100644",
	"index 0000000..3333333",
	"--- /dev/null",
	"+++ b/src/feature.ts",
	"@@ -0,0 +1 @@",
	"+export const answer = 42;",
	"",
].join("\n");

function installFakeGitAndGhProbes(gateway: any): () => void {
	const runner = gateway.sessionManager.commandRunner as CommandRunnerState;
	const original = { execFile: runner.execFile, spawn: runner.spawn };
	runner.execFile = async (command: string, args: readonly string[]) => {
		if (command === "gh") throw new Error("[pr-walkthrough-api] gh unavailable in tier-1");
		if (command !== "git") throw new Error(`[pr-walkthrough-api] ${command} unavailable in tier-1`);
		if (args[0] === "rev-parse" && args.includes("--verify")) {
			const requested = args.join(" ");
			if (requested.includes(BASE_SHA)) return { stdout: `${BASE_SHA}\n`, stderr: "" };
			if (requested.includes(HEAD_SHA)) return { stdout: `${HEAD_SHA}\n`, stderr: "" };
		}
		if (args.includes("--shortstat")) return { stdout: " 2 files changed, 2 insertions(+)\n", stderr: "" };
		if (args.includes("--name-status")) return { stdout: "M\tREADME.md\nA\tsrc/feature.ts\n", stderr: "" };
		if (args[0] === "diff") return { stdout: LOCAL_DIFF, stderr: "" };
		throw new Error(`unexpected fake git command: ${args.join(" ")}`);
	};
	runner.spawn = (command: string, args: readonly string[]) => {
		if (command !== "git" || args[0] !== "diff") throw new Error(`unexpected fake spawn: ${command} ${args.join(" ")}`);
		const child = new EventEmitter() as any;
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => true;
		queueMicrotask(() => {
			child.stdout.end(Buffer.from(LOCAL_DIFF));
			child.stderr.end();
			child.emit("close", 0, null);
		});
		return child;
	};
	return () => {
		runner.execFile = original.execFile;
		runner.spawn = original.spawn;
	};
}

async function createLocalFixture(gateway: any): Promise<GitFixtureRefs> {
	const root = join(gateway.bobbitDir, "pr-walkthrough-api", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(root, "repo");
	mkdirSync(cwd, { recursive: true });
	const project = await registerProject({
		name: `pr-walkthrough-api-${Math.random().toString(36).slice(2)}`,
		rootPath: root,
		seedWorkflows: false,
	});
	const sessionId = await createSession({ cwd, projectId: project.id });
	return { cwd, projectId: project.id, sessionId, baseSha: BASE_SHA, headSha: HEAD_SHA };
}

async function deleteLocalFixture(fixture: GitFixtureRefs | undefined): Promise<void> {
	if (!fixture) return;
	await apiFetch(`/api/sessions/${encodeURIComponent(fixture.sessionId)}?purge=true`, { method: "DELETE" }).catch(() => undefined);
	await apiFetch(`/api/projects/${encodeURIComponent(fixture.projectId)}`, { method: "DELETE" }).catch(() => undefined);
	rmSync(join(fixture.cwd, ".."), { recursive: true, force: true });
}

async function resolveLocal(fixture: GitFixtureRefs, overrides: Record<string, unknown> = {}): Promise<any> {
	const resp = await apiFetch("/api/pr-walkthrough/resolve", {
		method: "POST",
		body: JSON.stringify({ sessionId: fixture.sessionId, baseSha: fixture.baseSha, headSha: fixture.headSha, ...overrides }),
	});
	const body = await resp.json();
	expect(resp.status, JSON.stringify(body)).toBe(200);
	return body;
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
	let fixture: GitFixtureRefs | undefined;
	let restoreCommandRunner: (() => void) | undefined;

	test.beforeEach(async ({ gateway }) => {
		restoreCommandRunner = installFakeGitAndGhProbes(gateway);
		try {
			fixture = await createLocalFixture(gateway);
		} catch (error) {
			restoreCommandRunner();
			restoreCommandRunner = undefined;
			throw error;
		}
	});

	test.afterEach(async () => {
		try {
			await deleteLocalFixture(fixture);
		} finally {
			fixture = undefined;
			restoreCommandRunner?.();
			restoreCommandRunner = undefined;
		}
	});

	// NOTE: the legacy `POST /api/pr-walkthrough/launch` test was removed with the
	// WalkthroughAgentManager launcher (host.agents reviewer migration, design
	// Decision F Phase 3). The reviewer is now minted via the pack `run` route +
	// host.agents.spawn; that flow is covered by the host-agents API/browser E2Es.

	test("POST resolve returns local diff cards from the injected git boundary", async () => {
		const result = await resolveLocal(fixture!);
		expect(result.changesetId).toBe(`${fixture!.baseSha.slice(0, 7)}..${fixture!.headSha.slice(0, 7)}`);
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
		const prUrl = "https://github.com/acme/widgets/pull/42";
		const result = await resolveLocal(fixture!, { prUrl });
		expect(result.changesetId).toBe(`github:acme/widgets#42:${fixture!.headSha.slice(0, 7)}`);
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
		const { getPackStore } = (await loadServerTestRuntime()).packStore;
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
