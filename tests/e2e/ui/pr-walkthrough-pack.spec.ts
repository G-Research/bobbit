/**
 * Browser E2E — Extension Host Phase-2 D2 litmus (the MAXIMAL case; design
 * docs/design/extension-host-phase2.md §11 + §D2.3). Proves END-TO-END behavioral
 * parity for the PR-walkthrough feature re-expressed as a market pack using ALL
 * reserved contribution keys + the durable Host API — panels + routes + stores +
 * entrypoints (launcher + kind:"route" deep-link) + host.session.readToolCall.
 *
 * THE KEY CHANGE FROM THE PRIOR REVISION (design §D2.3): the bundle route now
 * RECOMPUTES the changeset LIVE via `git` in the confined worker (the pack declares
 * `permissions: ["git","fs"]`, so child_process/fs are un-denied and the worker gets
 * a minimal `{ PATH }` env). This test therefore drives a REAL git working dir —
 * but, crucially, the git repo root is the SESSION WORKTREE (server-derived from the
 * bound session), NEVER a caller-supplied path. So the test `git init`s the SESSION's
 * own working dir, makes two commits there, and opens the viewer against that
 * base/head range; the pack's `bundle` route shells out to `git diff` IN THE WORKER
 * against `process.cwd()` (the session worktree) and returns a freshly-computed
 * structural changeset (NOT a hand-seeded fixture), proving the pack can review a PR
 * created AFTER it was installed.
 *
 * SECURITY (HIGH path-traversal fix): the route does NOT accept a caller-controlled
 * `repoDir` as the git cwd — a session scoped to this pack must not be able to point
 * the route at ANOTHER local repo (disclosing other projects' diffs/metadata). This
 * test ALSO sets up a SEPARATE "other" git repo with a secret-marked file and proves
 * that a caller passing `repoDir` + that repo's SHAs gets NO other-repo data (the
 * route ignores `repoDir`, runs in the session worktree where those SHAs don't
 * exist, and fails closed).
 *
 * The SYNTHESIS CREDENTIAL SPLIT (design §D2.3): LLM-enhanced cards are NOT computed
 * in the credential-less worker. They are produced at agent-tool/submit time and
 * PERSISTED via the pack's own `publish` route (keyed by changeset id); the live
 * `bundle` route READS them and prefers them over the deterministic fallback cards.
 * This test exercises BOTH:
 *   • LIVE FALLBACK — open with base/head, no stored cards → the route computes the
 *     real diff + deterministic fallback cards in-worker; the real diff block renders.
 *   • STORED LLM CARDS — publish enhanced cards (the submit-time seam) → re-open →
 *     the route serves the persisted cards (with suggested comments) + a stable
 *     persistedAt across reloads (the store-rehydration parity proof).
 *
 *   1. Install the `pr-walkthrough` pack (local-dir source) at SERVER scope →
 *      /api/tools lists `pr_walkthrough`.
 *   2. A live session is created + its transcript seeded with a
 *      `submit_pr_walkthrough_yaml` tool call (read via host.session.readToolCall).
 *   3. ENTRYPOINT LAUNCH: the `pr-walkthrough.git-widget` git-widget-button launcher
 *      mounts the viewer panel — and NO callRoute POST fires before the user's Load
 *      click (control v1 §5 v: no auto-invoke).
 *   4. LIVE RECOMPUTE: a deep-link carrying baseSha/headSha (NO repoDir) + Load
 *      issues host.callRoute("bundle", …); the route runs `git diff` LIVE in the
 *      worker against the SESSION WORKTREE and returns the REAL changeset; selecting
 *      the significant nav card reveals the real diff block computed from git (NOT a
 *      fixture). 4b: a caller-supplied `repoDir` pointing at another repo is ignored
 *      (fails closed — no other-repo data disclosed).
 *   5. STORED CARDS + DEEP-LINK: publish LLM-enhanced cards via the pack's own
 *      `publish` route; a reload + Load serves the persisted cards (suggested comment
 *      renders) with a stable persistedAt across a second reload.
 *   6. UNINSTALL: the client reconcile drops the pack's panel + deep-link route.
 *
 * Pattern: mirrors tests/e2e/ui/extension-host.spec.ts.
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import { apiFetch, waitForSessionStatus, base, readE2ETokenAsync } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

// Within-file serial: a single end-to-end lifecycle test; be explicit so a failed
// run can never leak a half-installed server-scope pack into a retry.
test.describe.configure({ mode: "serial" });

// Absolute path to the repo-root `market-packs/` local-dir marketplace SOURCE
// (its `pr-walkthrough/` subdir is the pack — a dir is a pack iff it has pack.yaml).
const SOURCE_DIR = fileURLToPath(new URL("../../../market-packs", import.meta.url));

const PACK = "pr-walkthrough";
const TOOL = "pr_walkthrough";
const JOB_ID = "job-litmus-1";
const SUBMIT_TOOL = "submit_pr_walkthrough_yaml";
const SUBMIT_TOOL_USE_ID = "tu-prw-submit-1";
const SUBMIT_YAML = "walkthrough-yaml: v1\njob: job-litmus-1\ncards: 3";
// The git-widget-button launcher this test drives (the maximal launcher surface).
const GIT_WIDGET_LAUNCHER = "pr-walkthrough.git-widget";

// The diff-backed file the LIVE git recompute produces a block for.
const SYNC_FILE = "src/sync/worker.ts";
// The PR title rendered by the published (LLM-enhanced) stored cards.
const PR_TITLE = "Add retry/backoff to the sync worker";

/** The SESSION WORKTREE (server-derived) — the ONLY git repo the route ever diffs.
 *  We `git init` the bound session's own working dir and commit there; afterEach
 *  does NOT remove it (the gateway harness owns + cleans the bobbitDir). */
let repoDir: string | undefined;
let baseSha = "";
let headSha = "";

/** A SEPARATE "other project" git repo with a secret-marked file. The route must
 *  NEVER serve this repo's data even when a caller passes its path as `repoDir`.
 *  Tracked so afterEach removes it (it is NOT inside the harness bobbitDir). */
let outsideRepoDir: string | undefined;
let outsideBaseSha = "";
let outsideHeadSha = "";
// A distinctive path/content that exists ONLY in the outside repo, so we can assert
// it never leaks into a bundle response.
const OUTSIDE_SECRET_FILE = "secret/other-repo-only.ts";
const OUTSIDE_SECRET_MARKER = "TOP_SECRET_OTHER_REPO";

function gitIn(dir: string, args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function gitConfig(dir: string): void {
	gitIn(dir, ["config", "user.email", "bobbit-ai@bobbit.ai"]);
	gitIn(dir, ["config", "user.name", "bobbit-ai"]);
	gitIn(dir, ["config", "commit.gpgsign", "false"]);
}

/** `git init` the SESSION's own working dir (server-derived) and add two commits:
 *  base adds src/sync/worker.ts; head rewrites the return line to use withRetry().
 *  The pack `bundle` route diffs base..head LIVE in the confined worker against
 *  `process.cwd()` (this exact dir) — never a caller-supplied path. We commit ONLY
 *  the SYNC_FILE so the bobbitDir's harness state is left untracked. */
function setupSessionGitRepo(dir: string): void {
	repoDir = dir;
	if (!fs.existsSync(path.join(dir, ".git"))) gitIn(dir, ["init", "-q"]);
	gitConfig(dir);
	const file = path.join(dir, SYNC_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "export class SyncWorker {\n  async runOnce() {\n    return this.fetchBatch();\n  }\n}\n");
	gitIn(dir, ["add", "--", SYNC_FILE]);
	gitIn(dir, ["commit", "-q", "-m", "base"]);
	baseSha = gitIn(dir, ["rev-parse", "HEAD"]);
	fs.writeFileSync(file, "export class SyncWorker {\n  async runOnce() {\n    return this.withRetry(() => this.fetchBatch());\n  }\n}\n");
	gitIn(dir, ["add", "--", SYNC_FILE]);
	gitIn(dir, ["commit", "-q", "-m", "head: retry/backoff"]);
	headSha = gitIn(dir, ["rev-parse", "HEAD"]);
}

/** A SEPARATE temp git repo (NOT the session worktree) holding a secret file. Its
 *  base..head range is what an attacker would point `repoDir` at to exfiltrate
 *  another project's diff. */
function setupOutsideRepo(): void {
	outsideRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "prw-other-repo-"));
	gitIn(outsideRepoDir, ["init", "-q"]);
	gitConfig(outsideRepoDir);
	const file = path.join(outsideRepoDir, OUTSIDE_SECRET_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `export const token = "${OUTSIDE_SECRET_MARKER}";\n`);
	gitIn(outsideRepoDir, ["add", "."]);
	gitIn(outsideRepoDir, ["commit", "-q", "-m", "other-base"]);
	outsideBaseSha = gitIn(outsideRepoDir, ["rev-parse", "HEAD"]);
	fs.writeFileSync(file, `export const token = "${OUTSIDE_SECRET_MARKER}";\nexport const extra = 1;\n`);
	gitIn(outsideRepoDir, ["add", "."]);
	gitIn(outsideRepoDir, ["commit", "-q", "-m", "other-head"]);
	outsideHeadSha = gitIn(outsideRepoDir, ["rev-parse", "HEAD"]);
}

/** The changeset id the route computes for base..head (short(base)..short(head)) —
 *  the key LLM cards are persisted under, so a recompute finds them. */
function changesetId(): string {
	return `${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`;
}

/** LLM-enhanced cards produced at submit time (the agent's git/diff/synthesis work,
 *  NOT the credential-less worker). Mirrors the rich-card shape PrWalkthroughPanel
 *  renders: orientation + significant (with a diff block + suggested comment) + audit. */
function llmCards() {
	return [
		{
			id: "orientation-summary",
			phaseId: "orientation",
			title: PR_TITLE,
			navLabel: "Orientation",
			summary: "Adds bounded exponential backoff to the background sync worker so transient network failures self-heal instead of dropping jobs.",
			rationale: "Previously a single failed fetch aborted the whole sync pass.",
			diffBlocks: [],
			checklist: ["Testing: added unit coverage for the backoff schedule."],
		},
		{
			id: "significant-sync-worker",
			phaseId: "significant",
			title: "Retry/backoff in the sync worker",
			navLabel: "Retry logic",
			summary: "Wrap the fetch in a retry loop with capped exponential delay.",
			diffBlocks: [
				{
					id: "block-1-sync-worker",
					filePath: SYNC_FILE,
					status: "modified",
					hunks: [
						{
							id: "block-1-sync-worker-h1",
							header: "@@ -2,3 +2,3 @@ export class SyncWorker {",
							lines: [
								{ id: "block-1-sync-worker:h0:l0", side: "old", oldLine: 3, kind: "del", text: "    return this.fetchBatch();" },
								{ id: "block-1-sync-worker:h0:l1", side: "new", newLine: 3, kind: "add", text: "    return this.withRetry(() => this.fetchBatch());" },
							],
						},
					],
				},
			],
			suggestedComments: [
				{ id: "sc-1", cardId: "significant-sync-worker", diffBlockId: "block-1-sync-worker", lineId: "block-1-sync-worker:h0:l1", body: "Consider adding jitter to avoid thundering-herd retries." },
			],
		},
		{
			id: "audit-coverage",
			phaseId: "audit",
			title: "Audit remaining coverage",
			navLabel: "Audit",
			summary: "Final pass over the resolved diff.",
			diffBlocks: [],
		},
	];
}

/** Register the local-dir source and install the pack at SERVER scope. */
async function installPack(): Promise<void> {
	const addRes = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const addBody = await addRes.text();
	expect(addRes.status, addBody).toBe(201);
	const sourceId = (JSON.parse(addBody) as { source: { id: string } }).source.id;

	const instRes = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK, scope: "server" }),
	});
	const instBody = await instRes.text();
	expect(instRes.status, instBody).toBe(201);
}

/** Uninstall the pack + clear every registered source (afterEach hygiene). */
async function cleanup(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	}).catch(() => {});
	try {
		const res = await apiFetch("/api/marketplace/sources");
		for (const s of ((await res.json()).sources ?? []) as Array<{ id: string }>) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* ignore */ }
	// Do NOT remove `repoDir` — it is the harness-owned session worktree (bobbitDir).
	repoDir = undefined;
	if (outsideRepoDir) {
		try { fs.rmSync(outsideRepoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		outsideRepoDir = undefined;
	}
}

/** Fetch the server-scope tool list (no projectId → server ToolManager). */
async function listToolNames(): Promise<Array<{ name: string; rendererKind?: string }>> {
	const res = await apiFetch("/api/tools");
	expect(res.ok).toBe(true);
	return (await res.json()).tools as Array<{ name: string; rendererKind?: string }>;
}

/**
 * Append a `submit_pr_walkthrough_yaml` tool_use (+ matching tool_result) to the
 * session's persisted transcript so host.session.readToolCall(toolUseId) returns
 * the submitted YAML (mirrors extension-host.spec.ts::seedTranscriptToolUse).
 */
async function seedSubmitToolCall(gateway: GatewayInfo, sid: string): Promise<void> {
	let file: string | undefined;
	await expect
		.poll(() => {
			file = gateway.sessionManager?.getPersistedSession(sid)?.agentSessionFile as string | undefined;
			return file ?? null;
		}, { timeout: 10_000 })
		.not.toBeNull();
	const useLine = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "tool_use", id: SUBMIT_TOOL_USE_ID, name: SUBMIT_TOOL, input: { yaml: SUBMIT_YAML } }],
		},
	});
	const resultLine = JSON.stringify({
		type: "message",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: SUBMIT_TOOL_USE_ID, content: "published", is_error: false }],
		},
	});
	const seedBlock = `\n${useLine}\n${resultLine}\n`;
	// The LIVE agent OWNS this jsonl and rewrites it until the turn's final flush
	// lands; a single append races that flush. Append then poll-verify the seed
	// SURVIVES several CONSECUTIVE reads (proving the agent's write already happened),
	// re-appending whenever a rewrite clobbered it.
	let stable = 0;
	await expect
		.poll(() => {
			const cur = fs.readFileSync(file!, "utf8");
			if (cur.includes(SUBMIT_TOOL_USE_ID)) {
				stable += 1;
			} else {
				stable = 0;
				fs.appendFileSync(file!, seedBlock);
			}
			return stable;
		}, { timeout: 20_000, intervals: [150, 250, 400] })
		.toBeGreaterThanOrEqual(4);
}

/** Mint a SERVER-MINTED surface token for the pack tool — the same token the real
 *  host API mints (in its closure) before any scoped call. Direct route callers must
 *  now carry it: the server DERIVES {packId, tool} from the validated token and
 *  IGNORES any body `tool`, so identity can no longer be forged by naming a tool. */
async function mintSurfaceToken(sid: string): Promise<string> {
	const res = await apiFetch("/api/ext/surface-token", {
		method: "POST",
		headers: { "x-bobbit-session-id": sid },
		body: JSON.stringify({ sessionId: sid, tool: TOOL }),
	});
	const body = await res.text();
	expect(res.status, `surface-token mint failed: ${body}`).toBe(200);
	return JSON.parse(body).token as string;
}

/**
 * Persist LLM-enhanced cards through the pack's OWN `publish` route — the
 * submit-time persistence seam (the agent's synthesis work, NOT the worker). Drives
 * the SAME /api/ext/route/:name endpoint host.callRoute uses: header-canonical
 * session + body===header + a SERVER-MINTED surface token (the server derives the
 * trusted packId from it and pack-scopes the store). Keyed by the changeset id the
 * LIVE recompute computes, so `bundle` reads it back.
 */
async function publishCards(sid: string): Promise<void> {
	const surfaceToken = await mintSurfaceToken(sid);
	const res = await apiFetch("/api/ext/route/publish", {
		method: "POST",
		headers: { "x-bobbit-session-id": sid },
		// NO repoDir — the git working dir is server-derived (the session worktree).
		body: JSON.stringify({
			sessionId: sid,
			surfaceToken,
			init: { body: { jobId: JOB_ID, baseSha, headSha, cards: llmCards() } },
		}),
	});
	const body = await res.text();
	expect(res.status, `publish failed: ${body}`).toBe(200);
	const parsed = JSON.parse(body);
	expect(parsed.ok, "publish must persist the cards").toBe(true);
	expect(parsed.changesetId, "publish must compute the same changeset id").toBe(changesetId());
}

/** Build the deep-link hash carrying the live-recompute coordinates. NO repoDir:
 *  the git repo root is server-derived (the session worktree), not a deep-link
 *  param a caller could redirect. */
function liveDeepLink(): string {
	const params = new URLSearchParams({ jobId: JOB_ID, baseSha, headSha });
	return `#/ext/${PACK}?${params.toString()}`;
}

/** Drive the pack's `bundle` route directly (same endpoint host.callRoute uses) with
 *  an arbitrary query — used to PROVE a caller-supplied `repoDir` cannot exfiltrate
 *  another repo's diff. Returns the raw response. */
async function callBundleRoute(sid: string, query: Record<string, string>): Promise<{ status: number; text: string }> {
	const surfaceToken = await mintSurfaceToken(sid);
	const res = await apiFetch("/api/ext/route/bundle", {
		method: "POST",
		headers: { "x-bobbit-session-id": sid },
		body: JSON.stringify({ sessionId: sid, surfaceToken, init: { query } }),
	});
	return { status: res.status, text: await res.text() };
}

test.afterEach(async () => {
	await cleanup();
});

test.describe("Extension Host Phase 2 — D2 pr-walkthrough-as-pack (live git recompute)", () => {
	test("install → launcher mounts panel → LIVE git recompute renders real diff → stored LLM cards persist across reload → uninstall", async ({ page, gateway }) => {
		// The OUTSIDE repo is created up front so the path-traversal probe (step 4b)
		// has another project's diff to (fail to) point the route at. The SESSION's own
		// git repo is initialised below, once the session (and thus its server-derived
		// working dir) exists.
		setupOutsideRepo();

		// ── Step 1: install at server scope BEFORE opening the app so the cold-load
		// reconcile sees the pack. ──
		await installPack();
		const tools = await listToolNames();
		expect(tools.find((t) => t.name === TOOL), "pr_walkthrough must be listed after install").toBeTruthy();

		// Count POSTs to the bundle route so we can prove control v1 §5 v (no
		// auto-invoke on mount — only on a user click).
		const bundlePosts: string[] = [];
		const isBundlePost = (r: { url(): string; method(): string }) =>
			r.method() === "POST" && /\/api\/ext\/route\/bundle\b/.test(r.url());
		page.on("request", (r) => { if (isBundlePost(r)) bundlePosts.push(r.url()); });

		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "hello");
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });
		await seedSubmitToolCall(gateway, sid!);

		// ── Step 2b: initialise the SESSION WORKTREE as a git repo. The route diffs
		// against the worker's `process.cwd()` (server-derived from this session), NOT a
		// caller path — so the LIVE recompute MUST run against the session's own dir. ──
		const ps = gateway.sessionManager?.getPersistedSession(sid!) as { cwd?: string; worktreePath?: string } | undefined;
		const sessionWorktree = ps?.worktreePath ?? ps?.cwd;
		expect(sessionWorktree, "the session must have a resolvable working dir").toBeTruthy();
		setupSessionGitRepo(sessionWorktree!);

		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());

		// ── Step 3: ENTRYPOINT LAUNCH — the git-widget-button launcher navigates to
		// the kind:"route" deep-link, opening the viewer panel. ──
		await page.evaluate((id) => (window as any).__bobbitRunPackLauncher(id), GIT_WIDGET_LAUNCHER);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
			.toBe(`#/ext/${PACK}?jobId=${JOB_ID}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-testid="prw-load"]').first()).toBeVisible();
		expect(bundlePosts, "panel must NOT auto-invoke callRoute on mount").toHaveLength(0);

		// ── Step 4: LIVE RECOMPUTE — navigate the deep-link with base/head (NO repoDir:
		// the git repo root is server-derived). Load → host.callRoute("bundle") → the
		// route runs `git diff` LIVE in the confined worker against the session worktree
		// and returns the REAL changeset. ──
		await page.evaluate((h) => { window.location.hash = h; }, liveDeepLink());
		await expect.poll(async () => (await page.evaluate(() => window.location.hash)).startsWith(`#/ext/${PACK}?`), { timeout: 10_000 }).toBe(true);
		const load1 = page.locator('[data-testid="prw-load"]').first();
		await expect(load1).toBeVisible({ timeout: 15_000 });
		const liveResp = page.waitForResponse(
			(r) => /\/api\/ext\/route\/bundle\b/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 20_000 },
		);
		await load1.click();
		const resp1 = await liveResp;
		expect(resp1.status(), `live bundle callRoute failed: ${await resp1.text().catch(() => "")}`).toBe(200);

		// The header renders the LIVE changeset (provider:local, short sha range);
		// the nav rail groups the deterministic fallback cards.
		await expect(page.locator('[data-testid="prw-navrail"]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(baseSha.slice(0, 7));
		// readToolCall surfaced the submitted YAML (own-session, no owned toolUseId).
		await expect(page.locator('[data-testid="prw-toolcall"]').first()).toContainText("walkthrough-yaml");
		// Select the fallback "Changed files" significant card → the REAL git-computed
		// diff block for the changed file renders (NOT a hand-seeded fixture).
		await page.locator('[data-testid="prw-nav-card"][data-prw-nav="significant-files"]').first().click();
		const liveDiff = page.locator('[data-testid="prw-diffblock"]').first();
		await expect(liveDiff).toBeVisible({ timeout: 10_000 });
		await expect(liveDiff).toHaveAttribute("data-prw-file", SYNC_FILE);
		await expect(liveDiff).toContainText("this.withRetry");

		// ── Step 4b: PATH-TRAVERSAL PROBE (the HIGH finding) — a caller points `repoDir`
		// at ANOTHER local repo (+ that repo's SHAs). The route MUST ignore `repoDir` and
		// run in the session worktree, where those SHAs don't exist → it fails closed and
		// NEVER discloses the other repo's secret file. ──
		const attack = await callBundleRoute(sid!, {
			jobId: JOB_ID,
			baseSha: outsideBaseSha,
			headSha: outsideHeadSha,
			repoDir: outsideRepoDir!,
		});
		expect(attack.text, "the other repo's secret must NEVER leak through repoDir").not.toContain(OUTSIDE_SECRET_MARKER);
		expect(attack.text, "the other repo's file path must NEVER leak through repoDir").not.toContain(OUTSIDE_SECRET_FILE);
		// Fails closed: the outside SHAs are not resolvable in the session worktree, so
		// the route errors rather than returning another project's changeset.
		expect(attack.status, `repoDir traversal must NOT return other-repo data (got ${attack.status}: ${attack.text})`).not.toBe(200);

		// Sanity: the SAME caller WITHOUT a repoDir, using the session worktree's real
		// SHAs, still succeeds (the worktree, not the attacker's path, is the repo root).
		const ok = await callBundleRoute(sid!, { jobId: JOB_ID, baseSha, headSha });
		expect(ok.status, `session-worktree recompute must succeed: ${ok.text}`).toBe(200);
		expect(ok.text).toContain(SYNC_FILE);

		// ── Step 5: STORED LLM CARDS — publish the enhanced cards (submit-time seam)
		// keyed by the computed changeset id, then RELOAD + Load → the route now serves
		// the persisted cards (suggested comment renders) with a stable persistedAt. ──
		await publishCards(sid!);

		const token = await readE2ETokenAsync();
		const reopenAndLoad = async (): Promise<string | undefined> => {
			await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
			await page.evaluate((h) => { window.location.hash = h; }, liveDeepLink());
			await expect.poll(async () => (await page.evaluate(() => window.location.hash)).startsWith(`#/ext/${PACK}?`), { timeout: 10_000 }).toBe(true);
			await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 20_000 });
			const loadBtn = page.locator('[data-testid="prw-load"]').first();
			await expect(loadBtn).toBeVisible({ timeout: 20_000 });
			await loadBtn.click();
			// The changeset header is still the LIVE git range; the stored LLM cards
			// surface PR_TITLE in the active (orientation) card body — that PROVES the
			// route served the persisted cards over the fallback ones.
			await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(baseSha.slice(0, 7), { timeout: 10_000 });
			await expect(page.locator('[data-testid="prw-card"]').first()).toContainText(PR_TITLE, { timeout: 10_000 });
			return (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		};

		const persistedAt1 = await reopenAndLoad();
		expect(persistedAt1, "stored cards must carry a persistedAt").toBeTruthy();
		// The published significant card surfaces its suggested comment (parity).
		await page.locator('[data-testid="prw-nav-card"][data-prw-nav="significant-sync-worker"]').first().click();
		await expect(page.locator('[data-testid="prw-suggested-comment"]').first()).toContainText("jitter", { timeout: 10_000 });

		// Reload again → SAME persisted record (store-rehydration parity proof).
		const persistedAt2 = await reopenAndLoad();
		expect(persistedAt2, "deep-link must rehydrate the SAME persisted store record").toBe(persistedAt1);

		// ── Step 6: UNINSTALL → /api/tools drops pr_walkthrough; the client reconcile
		// tears the panel + deep-link route out of the LIVE UI without a reload. ──
		const delRes = await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK }),
		});
		expect(delRes.status).toBe(204);

		const afterTools = await listToolNames();
		expect(afterTools.find((t) => t.name === TOOL), "pr_walkthrough must be gone after uninstall").toBeFalsy();

		await expect
			.poll(async () => {
				await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => { /* navigation race */ });
				return page.locator('[data-testid="prw-panel-root"]').count();
			}, { timeout: 15_000 })
			.toBe(0);

		// The deep-link no longer resolves (owning pack uninstalled).
		await page.evaluate((h) => { window.location.hash = h; }, liveDeepLink());
		await expect(page.locator('[data-testid="prw-panel-root"]')).toHaveCount(0);
	});
});
