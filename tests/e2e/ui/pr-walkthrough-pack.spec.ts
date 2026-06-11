/**
 * Browser E2E — Built-in first-party packs DOGFOOD (design
 * docs/design/built-in-first-party-packs.md §11.2). Proves the PR-walkthrough
 * feature is served END-TO-END by the FIRST-PARTY PACK with NO manual install —
 * it is resolved active-by-default by the built-in resolver band — and that its
 * built-in twin is gone (this spec replaces the deleted built-in viewer specs).
 *
 * The pack re-expresses the whole viewer surface through public contributions +
 * the durable Host API: panels + pack-level routes + an implicit pack-scoped
 * store + entrypoints (launchers + a kind:"route" deep-link) + host.session.
 * readToolCall. The bundle route RECOMPUTES the changeset LIVE via `git` in the
 * confined worker against the SERVER-DERIVED session worktree (never a caller
 * path). LLM-card parity flows through the PANEL's own read→publish seam (no test
 * helper): on Load the panel parses the cards out of the submit_pr_walkthrough_yaml
 * tool call and persists them via the pack's `publish` route; `bundle` then serves
 * them over the structural fallback.
 *
 * Coverage:
 *   1. NO INSTALL — the pack is resolved by the built-in band: it appears in
 *      /api/ext/contributions (panel + entrypoints + routes) + the Installed list
 *      flagged `builtin:true`, and contributes NOTHING to /api/tools (no-tools pack).
 *   2. ENTRYPOINT LAUNCH — the git-widget-button launcher mounts the viewer (no
 *      auto-invoke before the Load click).
 *   3. LIVE RECOMPUTE + PANEL PUBLISH — Load hands the RAW production YAML to the
 *      pack's publish route, which runs the SAME synthesis as the deleted built-in
 *      (validate + map against the live diff) and persists PrWalkthroughCard[]; the
 *      real git diff renders, the SYNTHESIZED cards (orientation/design/review/audit
 *      nav rail) show with the PR title + suggested comment; a reload re-reads them.
 *   3a. RUN — the "Run PR walkthrough" action posts to the current agent (the launch
 *      re-expression, §8.4 step 5).
 *   3b. PATH-TRAVERSAL PROBE — a caller-supplied `repoDir` cannot exfiltrate another
 *      repo's diff (the route ignores it and runs in the session worktree).
 *   4. DISABLE/RE-ENABLE — toggling the pack's entrypoints off in the Market
 *      "Built-in" group removes the launcher + the #/ext/pr-walkthrough deep-link
 *      (the feature is unavailable, the deep-link shows the empty state); toggling
 *      back on restores it; the state survives a reload.
 *   5. NON-REMOVABLE — the built-in source has no Remove control + DELETE → 403; the
 *      built-in pack has no Uninstall control + DELETE /installed → 403.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import { apiFetch, waitForSessionStatus, base, readE2ETokenAsync } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, navigateToHash } from "./ui-helpers.js";

// Within-file serial: a single end-to-end lifecycle test.
test.describe.configure({ mode: "serial" });

const PACK = "pr-walkthrough";
const PANEL_ID = "pr-walkthrough.panel";
const SUBMIT_TOOL = "submit_pr_walkthrough_yaml";
const SUBMIT_TOOL_USE_ID = "tu-prw-submit-1";
const GIT_WIDGET_LAUNCHER = "pr-walkthrough.git-widget";
// The composer-slash launcher navigates to the BARE deep-link (NO autorun) — used
// for the manual-Load entrypoint flow below. Area B made ONLY the git-widget
// launcher carry `autorun: true` (its click is the one-click gesture); the
// open/palette launchers + the bare deep-link stay manual. The git-widget autorun
// is exercised separately in the "Area B autorun + Area D child pane" describe.
const OPEN_LAUNCHER = "pr-walkthrough.open";
// Entrypoint listNames (the basenames of entrypoints/*.yaml) → the activation
// toggle testids in the Market built-in group.
const ENTRYPOINT_LIST_NAMES = [
	"pr-walkthrough-git-widget",
	"pr-walkthrough-open",
	"pr-walkthrough-palette",
	"pr-walkthrough-route",
];

const SYNC_FILE = "src/sync/worker.ts";
const PR_TITLE = "Add retry/backoff to the sync worker";

let repoDir: string | undefined;
let baseSha = "";
let headSha = "";

let outsideRepoDir: string | undefined;
let outsideBaseSha = "";
let outsideHeadSha = "";
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

const HUNK_HEADER = "@@ -2,3 +2,3 @@ export class SyncWorker {";

/** The RAW production walkthrough YAML the agent's submit_pr_walkthrough_yaml emits
 *  (the rich `pr` + `walkthrough.{context,merge_assessment,design_decisions,
 *  review_chunks,omissions_and_followups,audit,display}` schema — NOT a `{cards}`
 *  shortcut). The pack's publish route validates + maps it (against the LIVE git
 *  diff) into PrWalkthroughCard[] via the SAME synthesis the deleted built-in ran.
 *  YAML is a superset of JSON, so the pack/route `yaml` parser reads this.
 *
 *  The `pr.base_sha`/`pr.head_sha` carry the REAL session-worktree SHAs (the
 *  bare-launcher dogfood path supplies NO URL SHA params, so the panel MUST read
 *  these from the submitted YAML to drive the LIVE recompute). Call AFTER
 *  setupSessionGitRepo so the module-level SHAs are populated. */
function submitYaml(): string {
	const doc = {
		schema_version: 1,
		pr: {
			provider: "github",
			owner: "SuuBro",
			repo: "bobbit",
			number: 4242,
			title: PR_TITLE,
			url: "https://github.com/SuuBro/bobbit/pull/4242",
			base_sha: baseSha,
			head_sha: headSha,
			original_description: { body: "## Why\nTransient network failures dropped sync jobs.", source: "gh_api", fetched_at: "2026-01-01T00:00:00Z" },
			stats: { files_changed: 1, additions: 1, deletions: 1 },
		},
		walkthrough: {
			context: {
				why_created: "Transient network failures aborted the whole sync pass.",
				problem_solved: "Adds bounded exponential backoff so failures self-heal.",
				why_worth_merging: "It makes the sync worker resilient with no API change.",
				merge_concerns: "Watch for thundering-herd retries without jitter.",
				author_intent: "Make sync robust to flaky networks.",
				reviewer_map: `core: ${SYNC_FILE} — the retry wrapper`,
			},
			merge_assessment: {
				recommendation: "comment",
				confidence: "medium",
				summary: "Sound change; consider jitter before merge.",
				blocking_concerns: [],
				non_blocking_concerns: ["Add jitter to avoid synchronized retries."],
			},
			design_decisions: [
				{
					id: "backoff-strategy",
					title: "Bounded exponential backoff",
					explanation: "Wrap the fetch in a capped retry loop.",
					chosen_approach: "Exponential delay capped at a ceiling.",
					alternatives_considered: [{ option: "Fixed delay", pros: ["simple"], cons: ["slow recovery"] }],
					tradeoffs: ["More latency on persistent failure."],
					suggested_reviewer_concerns: ["Confirm the cap is sensible."],
					relevant_hunks: [{ file: SYNC_FILE, hunk_header: HUNK_HEADER, why_relevant: "introduces the retry wrapper" }],
				},
			],
			review_chunks: [
				{
					id: "sync-worker",
					phase: "significant",
					title: "Retry/backoff in the sync worker",
					reviewer_goal: "Verify the retry wrapper is correct.",
					explanation: "Wrap the fetch in a retry loop with capped exponential delay.",
					files: [SYNC_FILE],
					relevant_hunks: [{ file: SYNC_FILE, hunk_header: HUNK_HEADER, line_range: "3", why_relevant: "the retry call" }],
					suggested_concerns: [
						{
							severity: "non_blocking",
							concern: "No jitter on retries.",
							suggested_comment: "Consider adding jitter to avoid thundering-herd retries.",
							anchors: [{ file: SYNC_FILE, hunk_header: HUNK_HEADER, line: 3 }],
						},
					],
					positive_notes: ["Clear, minimal change."],
				},
			],
			omissions_and_followups: [
				{ category: "tests", expected_artifact: "Unit test for the backoff schedule.", evidence_checked: "No new test file in the diff.", concern: "Backoff timing is untested.", suggested_comment: "Add a unit test for the delay schedule.", severity: "non_blocking" },
			],
			audit: {
				remaining_changed_areas: [SYNC_FILE],
				low_signal_or_mechanical_changes: [],
				generated_or_binary_files: [],
				reviewer_checklist: ["Confirm the retry cap.", "Confirm no behavioral regression."],
			},
			display: {
				phase_order: ["orientation", "design", "significant", "other", "audit"],
				chunk_order: ["sync-worker"],
			},
		},
	};
	return JSON.stringify(doc);
}

async function listToolNames(): Promise<Array<{ name: string }>> {
	const res = await apiFetch("/api/tools");
	expect(res.ok).toBe(true);
	return (await res.json()).tools as Array<{ name: string }>;
}

interface PackContributionsMeta {
	packId: string;
	packName: string;
	panels: { id: string; title?: string }[];
	entrypoints: Array<{ id: string; kind: string; routeId?: string; listName: string }>;
	routeNames: string[];
}

async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs as PackContributionsMeta[];
}

async function listInstalled(): Promise<Array<{ packName: string; scope: string; builtin?: boolean }>> {
	const res = await apiFetch("/api/marketplace/installed");
	expect(res.ok).toBe(true);
	return (await res.json()).installed as Array<{ packName: string; scope: string; builtin?: boolean }>;
}

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
			content: [{ type: "tool_use", id: SUBMIT_TOOL_USE_ID, name: SUBMIT_TOOL, input: { yaml: submitYaml() } }],
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

/** Mint a server-minted pack-bound surface token for the pack's PANEL (no carrier
 *  tool — no-tools pack). Used only by the path-traversal probe below. */
async function mintSurfaceToken(sid: string): Promise<string> {
	const res = await apiFetch("/api/ext/surface-token", {
		method: "POST",
		headers: { "x-bobbit-session-id": sid },
		body: JSON.stringify({ sessionId: sid, packId: PACK, contributionKind: "panel", contributionId: PANEL_ID }),
	});
	const body = await res.text();
	expect(res.status, `surface-token mint failed: ${body}`).toBe(200);
	return JSON.parse(body).token as string;
}

async function callBundleRoute(sid: string, query: Record<string, string>): Promise<{ status: number; text: string }> {
	const surfaceToken = await mintSurfaceToken(sid);
	const res = await apiFetch("/api/ext/route/bundle", {
		method: "POST",
		headers: { "x-bobbit-session-id": sid },
		body: JSON.stringify({ sessionId: sid, surfaceToken, init: { query } }),
	});
	return { status: res.status, text: await res.text() };
}

function liveDeepLink(): string {
	// No jobId — the launchers dropped it; the panel resolves the real job from the
	// session's submitted doc. baseSha/headSha drive the LIVE recompute.
	const params = new URLSearchParams({ baseSha, headSha });
	return `#/ext/${PACK}?${params.toString()}`;
}

test.afterEach(async () => {
	// Best-effort: re-enable all entrypoints so a failed run never leaves the
	// shipped feature disabled for the next test (server-scope activation persists).
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK, disabled: { entrypoints: [] } }),
	}).catch(() => {});
	repoDir = undefined;
	if (outsideRepoDir) {
		try { fs.rmSync(outsideRepoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		outsideRepoDir = undefined;
	}
});

test.describe("Built-in first-party pack — pr-walkthrough served by the built-in band", () => {
	test("no-install dogfood: launcher → live recompute + panel publish → disable/re-enable → non-removable", async ({ page, gateway }) => {
		setupOutsideRepo();

		// ── Step 1: NO INSTALL. The built-in band resolves the pack active-by-default. ──
		const tools = await listToolNames();
		expect(tools.find((t) => t.name === "pr_walkthrough"), "a no-tools pack contributes NOTHING to /api/tools").toBeFalsy();
		const packMeta = (await listContributions()).find((p) => p.packId === PACK);
		expect(packMeta, "the built-in pr-walkthrough pack must be resolved with NO install").toBeTruthy();
		expect(packMeta?.panels?.some((p) => p.id === PANEL_ID)).toBe(true);
		expect(packMeta?.routeNames).toEqual(expect.arrayContaining(["bundle", "publish"]));
		expect(packMeta?.entrypoints?.some((e) => e.id === GIT_WIDGET_LAUNCHER)).toBe(true);
		const builtinRow = (await listInstalled()).find((p) => p.packName === PACK && p.builtin);
		expect(builtinRow, "the built-in pack must appear in the Installed list flagged builtin").toBeTruthy();
		expect(builtinRow?.scope).toBe("server");

		const bundlePosts: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && /\/api\/ext\/route\/bundle\b/.test(r.url())) bundlePosts.push(r.url());
		});

		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "hello");
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });

		// Initialise the SESSION WORKTREE as a git repo FIRST (the route diffs against
		// the worker's server-derived process.cwd(), never a caller path). This sets
		// the REAL baseSha/headSha that the submitted YAML's pr.base_sha/head_sha must
		// carry — the bare-launcher dogfood path has no URL SHA params, so the panel
		// reads them from the YAML to drive the LIVE recompute.
		const ps = gateway.sessionManager?.getPersistedSession(sid!) as { cwd?: string; worktreePath?: string } | undefined;
		const sessionWorktree = ps?.worktreePath ?? ps?.cwd;
		expect(sessionWorktree, "the session must have a resolvable working dir").toBeTruthy();
		setupSessionGitRepo(sessionWorktree!);

		// Seed the submit_pr_walkthrough_yaml tool call AFTER the repo exists so the
		// YAML's pr.base_sha/head_sha are the REAL session-worktree SHAs.
		await seedSubmitToolCall(gateway, sid!);

		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());

		// ── Step 2: ENTRYPOINT LAUNCH — a NON-autorun launcher (the composer-slash
		// "open") mounts the viewer with NO auto-invoke, so the manual-Load flow below
		// is deterministic. (The git-widget launcher now carries `autorun: true` and
		// auto-fires `run` on mount — covered by the Area B describe, not here.) ──
		await page.evaluate((id) => (window as any).__bobbitRunPackLauncher(id), OPEN_LAUNCHER);
		// The open launcher carries no jobId and no autorun → it navigates to the bare deep-link.
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
			.toBe(`#/ext/${PACK}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-testid="prw-load"]').first()).toBeVisible();
		expect(bundlePosts, "panel must NOT auto-invoke callRoute on mount").toHaveLength(0);

		// ── Step 3: LIVE RECOMPUTE + PANEL PUBLISH via the BARE LAUNCHER (no URL SHA
		// params — the real dogfood). The panel is already mounted at the bare
		// #/ext/pr-walkthrough from the launcher; Load reads the submitted YAML, extracts
		// pr.base_sha/head_sha from it, publishes the agent's cards (read→publish seam)
		// and reads the live bundle; the bundle serves the persisted LLM cards. ──
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(`#/ext/${PACK}`);
		const load1 = page.locator('[data-testid="prw-load"]').first();
		await expect(load1).toBeVisible({ timeout: 15_000 });
		const liveResp = page.waitForResponse(
			(r) => /\/api\/ext\/route\/bundle\b/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 20_000 },
		);
		await load1.click();
		const resp1 = await liveResp;
		expect(resp1.status(), `live bundle callRoute failed: ${await resp1.text().catch(() => "")}`).toBe(200);

		// The header renders the PRODUCTION PR title (synthesized changeset, persisted by
		// publish); the sha-range sibling shows the LIVE recomputed changeset. The nav
		// rail shows the SYNTHESIZED phases — orientation / design / significant / audit —
		// proving the pack ran the SAME YAML→cards synthesis as the deleted built-in.
		await expect(page.locator('[data-testid="prw-navrail"]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(PR_TITLE, { timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-bundle"]').first()).toContainText(baseSha.slice(0, 7));
		await expect(page.locator('[data-testid="prw-nav-card"][data-prw-nav="orientation-summary"]').first()).toBeVisible();
		await expect(page.locator('[data-testid="prw-nav-card"][data-prw-nav="design-backoff-strategy"]').first()).toBeVisible();
		await expect(page.locator('[data-testid="prw-nav-card"][data-prw-nav="audit-checklist"]').first()).toBeVisible();
		// The first (orientation) card renders its synthesized guided sections.
		await expect(page.locator('[data-testid="prw-card"]').first()).toContainText("PR context");
		// The significant review card carries the REAL changed file's diff + its mapped
		// suggested comment (DiffReferenceMapper resolved the anchor against the live diff).
		await page.locator('[data-testid="prw-nav-card"][data-prw-nav="significant-sync-worker"]').first().click();
		const liveDiff = page.locator('[data-testid="prw-diffblock"]').first();
		await expect(liveDiff).toBeVisible({ timeout: 10_000 });
		await expect(liveDiff).toHaveAttribute("data-prw-file", SYNC_FILE);
		await expect(liveDiff).toContainText("this.withRetry");
		await expect(page.locator('[data-testid="prw-suggested-comment"]').first()).toContainText("jitter", { timeout: 10_000 });
		const persistedAt1 = (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		expect(persistedAt1, "stored cards must carry a persistedAt").toBeTruthy();

		// ── Step 3-leak (Bug 2): PER-SESSION ISOLATION. Within the SAME page load (no
		// reload), open the panel in a SECOND session. The module-level panel state is
		// keyed by the BOUND session id, so session B must NOT see session A's rendered
		// bundle and MUST offer Load/Run for its own (absent) submission. ──
		await createSessionViaUI(page);
		const sidB = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sidB, "a second session must be selected").toBeTruthy();
		expect(sidB).not.toBe(sid);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		// No leaked bundle: session A's rendered walkthrough must NOT appear here.
		await expect(page.locator('[data-testid="prw-bundle"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="prw-title"]')).toHaveCount(0);
		// Session B is offered Load/Run for its OWN submission.
		await expect(page.locator('[data-testid="prw-load"]').first()).toBeVisible({ timeout: 10_000 });

		// ── Step 3b: PATH-TRAVERSAL PROBE — a caller-supplied repoDir cannot exfiltrate
		// another repo's diff (the route ignores it; the outside SHAs fail closed). ──
		const attack = await callBundleRoute(sid!, { baseSha: outsideBaseSha, headSha: outsideHeadSha, repoDir: outsideRepoDir! });
		expect(attack.text, "the other repo's secret must NEVER leak through repoDir").not.toContain(OUTSIDE_SECRET_MARKER);
		expect(attack.text).not.toContain(OUTSIDE_SECRET_FILE);
		expect(attack.status, `repoDir traversal must NOT return other-repo data (got ${attack.status})`).not.toBe(200);

		// ── FINDING 1: RELOAD RECOVERY via the NEW `recover` route. After the
		// isolated-reviewer Run flow the submit_pr_walkthrough_yaml tool call lives in
		// the (dismissed) reviewer child, NOT this owner session — so on a browser
		// reload the legacy owner-transcript scan recovers NOTHING. The owner-scoped
		// `last/<sessionId>` pointer + the persisted `submitted/<jobId>` YAML (written
		// server-side by submit-yaml) let the "Load walkthrough" gesture re-render the
		// persisted cards via the `recover` route. Seed both store keys directly (the
		// gateway runs in-process, sharing the pack-store singleton), DELIBERATELY do
		// NOT re-seed the owner transcript, then assert Load recovers via `recover`
		// (NOT an owner-session submit tool call) and re-renders the SAME cards. ──
		const token = await readE2ETokenAsync();
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		const recoverJobId = "prw-recover-finding1";
		await getPackStore().put(PACK, `submitted/${recoverJobId}`, { yaml: submitYaml(), baseSha, headSha, submittedAt: Date.now() });
		await getPackStore().put(PACK, `last/${sid}`, { jobId: recoverJobId, baseSha, headSha, submittedAt: Date.now() });

		const reopenAndRecover = async (): Promise<string | undefined> => {
			await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
			// NOTE: the owner transcript is intentionally NOT re-seeded — recovery must
			// come from the `recover` route (pack store), not an owner-session tool call.
			await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(`#/ext/${PACK}`);
			await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 20_000 });
			const loadBtn = page.locator('[data-testid="prw-load"]').first();
			await expect(loadBtn).toBeVisible({ timeout: 20_000 });
			const recoverResp = page.waitForResponse(
				(r) => /\/api\/ext\/route\/recover\b/.test(r.url()) && r.request().method() === "POST",
				{ timeout: 20_000 },
			);
			await loadBtn.click();
			const resp = await recoverResp;
			expect(resp.status(), `recover callRoute failed: ${await resp.text().catch(() => "")}`).toBe(200);
			const recovered = await resp.json().catch(() => ({}));
			expect(recovered.found, "the recover route must return the owner's last completed walkthrough").toBe(true);
			await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(PR_TITLE, { timeout: 10_000 });
			return (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		};
		const persistedAt2 = await reopenAndRecover();
		expect(persistedAt2, "recover must rehydrate the SAME persisted store record").toBe(persistedAt1);

		// ── Step 4: DISABLE via the Market built-in group → launcher + deep-link gone. ──
		await navigateToHash(page, "#/market");
		const builtinGroup = page.locator('[data-testid="market-builtin-group"]');
		await expect(builtinGroup, "the Market Installed tab must show a Built-in group").toBeVisible({ timeout: 15_000 });
		const gitWidgetToggle = builtinGroup.locator('[data-testid="market-toggle-entrypoint-pr-walkthrough-git-widget"]');
		await expect(gitWidgetToggle, "the built-in pack's entrypoint toggles must render").toBeVisible({ timeout: 15_000 });
		for (const listName of ENTRYPOINT_LIST_NAMES) {
			const toggle = builtinGroup.locator(`[data-testid="market-toggle-entrypoint-${listName}"]`);
			if (await toggle.isChecked()) {
				const put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
				await toggle.click();
				await put;
			}
		}

		// The deep-link no longer resolves to a registered route → "feature
		// unavailable" empty state (no panel, no crash, no blank — §7.3).
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		await page.evaluate((h) => { window.location.hash = h; }, liveDeepLink());
		await expect.poll(async () => {
			await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
			return page.locator('[data-testid="prw-panel-root"]').count();
		}, { timeout: 15_000 }).toBe(0);
		// The disabled deep-link surfaces the dismissible empty state instead of nothing.
		const unavailable = page.locator('[data-testid="ext-route-unavailable"]');
		await expect(unavailable).toBeVisible({ timeout: 10_000 });
		await expect(unavailable).toContainText("unavailable");
		await page.locator('[data-testid="ext-route-unavailable-dismiss"]').click();
		await expect(unavailable).toHaveCount(0);
		// The entrypoints are dropped from the contribution registry.
		await expect.poll(async () => {
			const meta = (await listContributions()).find((p) => p.packId === PACK);
			return meta?.entrypoints?.length ?? 0;
		}, { timeout: 10_000 }).toBe(0);

		// Disabled state survives a reload: the server-scope activation override is
		// persisted, so after a full reload the Market toggle is still OFF and the
		// entrypoints stay absent from /api/ext/contributions.
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/market`);
		const group2 = page.locator('[data-testid="market-builtin-group"]');
		await expect(group2).toBeVisible({ timeout: 20_000 });
		const gitToggleAfterReload = group2.locator('[data-testid="market-toggle-entrypoint-pr-walkthrough-git-widget"]');
		await expect(gitToggleAfterReload).toBeVisible({ timeout: 15_000 });
		await expect(gitToggleAfterReload, "disable must survive reload (toggle stays off)").not.toBeChecked();
		await expect.poll(async () => {
			const meta = (await listContributions()).find((p) => p.packId === PACK);
			return meta?.entrypoints?.length ?? 0;
		}, { timeout: 10_000 }).toBe(0);

		// ── Re-enable → the launcher + deep-link are restored. ──
		for (const listName of ENTRYPOINT_LIST_NAMES) {
			const toggle = group2.locator(`[data-testid="market-toggle-entrypoint-${listName}"]`);
			await expect(toggle).toBeVisible({ timeout: 10_000 });
			if (!(await toggle.isChecked())) {
				const put = page.waitForResponse((r) => r.url().includes("/api/marketplace/pack-activation") && r.request().method() === "PUT");
				await toggle.click();
				await put;
			}
		}
		await expect.poll(async () => {
			const meta = (await listContributions()).find((p) => p.packId === PACK);
			return meta?.entrypoints?.some((e) => e.id === GIT_WIDGET_LAUNCHER) ? "ok" : "no";
		}, { timeout: 10_000 }).toBe("ok");
		// The deep-link resolves again from a CLEAN context (open a fresh session, then
		// navigate the deep-link → the panel mounts via the re-registered route).
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });

		// ── Step 3a: RUN PR WALKTHROUGH — the NO-target launch contract (migration
		// Decision D). The gesture-gated Run NO LONGER drives the user's OWN agent via
		// host.session.postMessage; it calls the pack `run` route → host.agents.spawn.
		// This harness has NO real `gh`/PR and the walkthrough is GitHub-PR-only (a local
		// SHA-only target is now rejected up front with LOCAL_UNSUPPORTED — see
		// tests/e2e/pr-walkthrough-host-agents.spec.ts), so a reviewer CANNOT be spawned
		// through the panel here. Re-open the panel on the BARE launcher hash (no SHA
		// params) so Run posts an empty body: the route resolves the current branch's
		// open GitHub PR, finds none, and returns code:"NO_PR". We assert that contract —
		// the route is called and the panel surfaces the "No open GitHub PR" message via
		// prw-error, with NO reviewer child minted. (The reviewer-spawn + `review`
		// accessory + exactly-three-tools assertions live in the API spec, which uses an
		// explicit github target; YAML→cards parity is covered by Step 3's Load path.) ──
		await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toContain(`#/ext/${PACK}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		const runBtn = page.locator('[data-testid="prw-run"]').first();
		await expect(runBtn, "Run is offered when a session surface is present").toBeVisible({ timeout: 10_000 });
		const runRoutePost = page.waitForResponse(
			(r) => /\/api\/ext\/route\/run\b/.test(r.url()) && r.request().method() === "POST",
			{ timeout: 20_000 },
		);
		await runBtn.click();
		const runRouteResp = await runRoutePost;
		expect(runRouteResp.status(), `run route failed: ${await runRouteResp.text().catch(() => "")}`).toBe(200);
		// No open GitHub PR for the current branch ⇒ the panel surfaces the NO_PR error.
		const prwError = page.locator('[data-testid="prw-error"]').first();
		await expect(prwError).toBeVisible({ timeout: 10_000 });
		await expect(prwError).toContainText(/No open GitHub PR/i);
		// The user's OWN session agent was NOT driven (anti-postMessage), and NO reviewer
		// child was minted (the run was rejected before any spawn).
		const reviewerSpawned = (gateway.sessionManager?.getAllSessionsRaw?.() ?? []).some((s: any) => {
			const cps = gateway.sessionManager?.getPersistedSession?.(s.id);
			return cps?.parentSessionId === sid && cps?.childKind === "host-agents";
		});
		expect(reviewerSpawned, "a NO_PR launch must not mint a reviewer child").toBe(false);
		const ownerKickoffSeen = await (async () => {
			const rpc = gateway.sessionManager?.getSession?.(sid!)?.rpcClient;
			if (!rpc?.getMessages) return false;
			try {
				const res = await rpc.getMessages();
				const msgs = res?.data?.messages ?? res?.data ?? [];
				return Array.isArray(msgs) && msgs.some((m: any) => JSON.stringify(m).includes("Review target"));
			} catch { return false; }
		})();
		expect(ownerKickoffSeen, "the user's own agent must NOT receive the reviewer kickoff").toBe(false);

		// ── Step 5: NON-REMOVABLE — built-in source + pack cannot be removed/uninstalled. ──
		// Built-in pack card has no Uninstall control.
		await navigateToHash(page, "#/market");
		const builtinCard = page.locator('[data-testid="market-installed-pack"][data-builtin="true"]').filter({ hasText: PACK }).first();
		await expect(builtinCard).toBeVisible({ timeout: 15_000 });
		await expect(builtinCard.locator('[data-testid="market-uninstall-pack"]')).toHaveCount(0);
		// Built-in source row has no Remove control.
		await page.locator('[data-testid="market-tab-sources"]').click();
		const builtinSource = page.locator('[data-testid="market-source-row"][data-builtin="true"]').first();
		await expect(builtinSource).toBeVisible({ timeout: 15_000 });
		await expect(builtinSource.locator('[data-testid="market-remove-source"]')).toHaveCount(0);
		// The server rejects both mutations.
		const delSource = await apiFetch("/api/marketplace/sources/builtin", { method: "DELETE" });
		expect(delSource.status, "the built-in source must not be removable").toBe(403);
		const delPack = await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK }),
		});
		expect(delPack.status, "the built-in pack must not be uninstallable").toBe(403);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Area B (one-click autorun) + Area D (the pane lives with the reviewer child)
// ────────────────────────────────────────────────────────────────────────────
// Restore-PR-Walkthrough-UX design rows B1/B2/B3 + the Area D child-session pane.
//
// ENVIRONMENT NOTE (read before extending): the panel's `run` route, on the
// git-widget's bare autorun deep-link, resolves the CURRENT BRANCH's open GitHub
// PR via the ambient `gh` in the confined worker (the only target a bare deep-link
// can carry — paramKeys gates out prUrl/owner/repo, and a baseSha+headSha pair is
// rejected as LOCAL_UNSUPPORTED). This harness has no real `gh` PR (and a mock `gh`
// cannot be injected: `execFile("gh")` resolves the real binary), so a PANEL-driven
// autorun deterministically returns NO_PR and mints no reviewer. Therefore the
// reviewer-SPAWN assertions (a `review`-accessory child, status/recover routing,
// the dismissed-but-viewable child) are pinned in the API spec
// tests/e2e/pr-walkthrough-host-agents.spec.ts (rows A2/D2/D5), which uses an
// EXPLICIT github target (no `gh`) + the canned mock agent. Here we faithfully pin
// the BROWSER-only seams: the autorun ONE-SHOT trigger (B1/B2/B3) and the
// child-session pane's recover→render + reload persistence (Area D), the latter by
// seeding the child binding the run flow would have written.
test.describe("PR walkthrough — Area B autorun + Area D child-session pane", () => {
	/** Open the app, create + select a session, reconcile pack renderers. Returns sid. */
	async function freshSessionWithPanel(page: import("@playwright/test").Page): Promise<string> {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "hello");
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());
		return sid!;
	}

	// ── B1: the git-widget launcher carries autorun → the panel auto-fires `run`
	//    EXACTLY ONCE on mount, with NO Run-button click. ──
	test("B1 — git-widget launcher autorun fires `run` exactly once on mount (no Run click)", async ({ page }) => {
		const runPosts: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && /\/api\/ext\/route\/run\b/.test(r.url())) runPosts.push(r.url());
		});
		await freshSessionWithPanel(page);

		// Run the REAL git-widget launcher — its selection IS the one-click gesture.
		await page.evaluate((id) => (window as any).__bobbitRunPackLauncher(id), GIT_WIDGET_LAUNCHER);
		// Area B: ONLY this launcher's target carries autorun:true, so the deep-link
		// hash carries it (paramKeys includes `autorun`).
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
			.toBe(`#/ext/${PACK}?autorun=true`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });

		// The panel auto-invokes `run` ONCE on mount — no Run-button click. (This harness
		// has no real GitHub PR, so run resolves NO_PR and mints no reviewer; the
		// reviewer spawn + `review` accessory are pinned by the API spec.)
		await expect.poll(() => runPosts.length, { timeout: 15_000 }).toBe(1);
		const prwError = page.locator('[data-testid="prw-error"]').first();
		await expect(prwError).toBeVisible({ timeout: 10_000 });
		await expect(prwError).toContainText(/No open GitHub PR/i);
		// The run completed (error surfaced) — still EXACTLY one fire, no Run-button click.
		expect(runPosts, "autorun must fire `run` exactly once, with no Run-button click").toHaveLength(1);
	});

	// ── B2: autorun is strictly one-shot — the consumed flag prevents a re-fire on
	//    re-render / remount within the page (the run-route reviewerKey idempotency
	//    is the RELOAD backstop, pinned in the API spec). ──
	test("B2 — autorun is one-shot: a remount does not re-fire `run` (autorunConsumed)", async ({ page }) => {
		const runPosts: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && /\/api\/ext\/route\/run\b/.test(r.url())) runPosts.push(r.url());
		});
		const sid = await freshSessionWithPanel(page);

		await page.evaluate((id) => (window as any).__bobbitRunPackLauncher(id), GIT_WIDGET_LAUNCHER);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		await expect.poll(() => runPosts.length, { timeout: 15_000 }).toBe(1);

		// The first autorun completed (NO_PR surfaced).
		await expect(page.locator('[data-testid="prw-error"]').first()).toBeVisible({ timeout: 10_000 });

		// Re-navigate AWAY from the panel and back to the SAME autorun deep-link (re-
		// rendering the panel). The module-level byJob entry (status:error +
		// autorunConsumed) persists within the page, so autorun does NOT re-fire `run`.
		await page.evaluate((h) => { window.location.hash = h; }, `#/session/${sid}`);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toContain("#/session/");
		await page.evaluate((id) => (window as any).__bobbitRunPackLauncher(id), GIT_WIDGET_LAUNCHER);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(`#/ext/${PACK}?autorun=true`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		// The re-rendered pane shows the FIRST run's persisted error (deterministic
		// post-re-navigation signal) — and autorun did NOT re-fire.
		await expect(page.locator('[data-testid="prw-error"]').first()).toBeVisible({ timeout: 10_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		expect(runPosts, "autorun must stay one-shot across re-navigation (status!=idle + autorunConsumed)").toHaveLength(1);
	});

	// ── B3: a NON-autorun launch (the composer-slash `open` launcher / bare deep-link)
	//    shows the manual Run affordance and auto-invokes NOTHING on mount. ──
	test("B3 — a non-autorun launch shows manual Run and auto-fires nothing", async ({ page }) => {
		const runPosts: string[] = [];
		const bundlePosts: string[] = [];
		page.on("request", (r) => {
			if (r.method() !== "POST") return;
			if (/\/api\/ext\/route\/run\b/.test(r.url())) runPosts.push(r.url());
			if (/\/api\/ext\/route\/bundle\b/.test(r.url())) bundlePosts.push(r.url());
		});
		await freshSessionWithPanel(page);

		await page.evaluate((id) => (window as any).__bobbitRunPackLauncher(id), OPEN_LAUNCHER);
		// The open launcher carries NO autorun → the bare deep-link.
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(`#/ext/${PACK}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		// The manual Run + Load affordances are offered…
		await expect(page.locator('[data-testid="prw-run"]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-load"]').first()).toBeVisible();
		// …and NOTHING auto-invokes on mount (no autorun on this launcher). The panel is
		// fully mounted (Run/Load visible) and shows NO "reviewing" run-status, proving
		// no run was triggered — mirrors the existing step-2 no-auto-invoke assertion.
		await expect(page.locator('[data-testid="prw-run-status"]')).toHaveCount(0);
		expect(runPosts, "a non-autorun launch must NOT auto-fire `run`").toHaveLength(0);
		expect(bundlePosts, "the panel must NOT auto-invoke callRoute on mount").toHaveLength(0);
	});

	// ── Area D: the walkthrough pane lives WITH the reviewer-child session. When the
	//    child pane re-renders after a reload, its Load gesture recovers the READY
	//    cards from its OWN binding/<child> (the routes.mjs child self-recover branch),
	//    and a reload re-renders the SAME persisted cards. We seed the binding the run
	//    flow would have written (no `gh`, no reviewer spawn needed) and drive the
	//    panel as the bound (child) session. ──
	test("D — the pane recovers READY cards from binding/<child> in the child session, and a reload re-renders them", async ({ page, gateway }) => {
		const sid = await freshSessionWithPanel(page);
		// The bound session's worktree must be a real git repo so publish/bundle
		// recompute the LIVE diff (the same path the dogfood Load uses). This sets the
		// module-level baseSha/headSha that submitYaml()'s pr.base_sha/head_sha carry.
		const ps = gateway.sessionManager?.getPersistedSession(sid) as { cwd?: string; worktreePath?: string } | undefined;
		const sessionWorktree = ps?.worktreePath ?? ps?.cwd;
		expect(sessionWorktree, "the bound session must have a resolvable working dir").toBeTruthy();
		setupSessionGitRepo(sessionWorktree!);

		// Seed the pack store so THIS session is a bound reviewer child whose pane
		// recovers from its OWN binding/<child>. We seed binding/<sid> (the CHILD key)
		// and DELIBERATELY NOT last/<sid> (the owner pointer), so a successful recover
		// proves the Area D child self-recover branch (binding/<me> → submitted) fired —
		// not the legacy owner branch.
		const { getPackStore } = await import("../../../dist/server/extension-host/pack-store.js");
		const childJobId = "prw-area-d-child-recover";
		await getPackStore().put(PACK, `submitted/${childJobId}`, { yaml: submitYaml(), baseSha, headSha, submittedAt: Date.now() });
		await getPackStore().put(PACK, `binding/${sid}`, {
			jobId: childJobId,
			parentSessionId: "prw-area-d-owner-session",
			baseSha, headSha,
			status: "submitted",
			target: {
				provider: "github", owner: "SuuBro", repo: "bobbit", number: 4242, host: "github.com",
				prUrl: "https://github.com/SuuBro/bobbit/pull/4242", baseSha, headSha,
				canonicalKey: "github:SuuBro/bobbit#4242",
			},
		});

		const recoverAndAssertCards = async (): Promise<string | undefined> => {
			await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}`);
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(`#/ext/${PACK}`);
			await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 20_000 });
			const loadBtn = page.locator('[data-testid="prw-load"]').first();
			await expect(loadBtn).toBeVisible({ timeout: 20_000 });
			const recoverResp = page.waitForResponse(
				(r) => /\/api\/ext\/route\/recover\b/.test(r.url()) && r.request().method() === "POST",
				{ timeout: 20_000 },
			);
			await loadBtn.click();
			const resp = await recoverResp;
			expect(resp.status(), `recover callRoute failed: ${await resp.text().catch(() => "")}`).toBe(200);
			const recovered = await resp.json().catch(() => ({}));
			expect(recovered.found, "the child pane must self-resolve binding/<child> → submitted YAML").toBe(true);
			expect(recovered.jobId).toBe(childJobId);
			// The READY cards render in THIS (child) session's pane.
			await expect(page.locator('[data-testid="prw-navrail"]').first()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(PR_TITLE, { timeout: 10_000 });
			await expect(page.locator('[data-testid="prw-nav-card"][data-prw-nav="orientation-summary"]').first()).toBeVisible();
			return (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		};

		const persistedAt1 = await recoverAndAssertCards();
		expect(persistedAt1, "stored cards must carry a persistedAt").toBeTruthy();

		// RELOAD persistence: a full reload clears the in-memory byJob; the child pane
		// re-renders the SAME cards via the recover route (child self-resolve again).
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sid}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		const persistedAt2 = await recoverAndAssertCards();
		expect(persistedAt2, "reload must rehydrate the SAME persisted store record via recover").toBe(persistedAt1);
	});
});
