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
 *   3. LIVE RECOMPUTE + PANEL PUBLISH — Load publishes the agent's cards then reads
 *      the live bundle; the real git diff renders and the LLM card (PR title +
 *      suggested comment) shows; a reload re-reads the SAME persisted cards.
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
const JOB_ID = "job-litmus-1";
const SUBMIT_TOOL = "submit_pr_walkthrough_yaml";
const SUBMIT_TOOL_USE_ID = "tu-prw-submit-1";
const GIT_WIDGET_LAUNCHER = "pr-walkthrough.git-widget";
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

/** LLM-enhanced cards the agent would synthesize at submit time — carried in the
 *  submitted YAML (a `cards:` array). The panel's read→publish seam parses them
 *  and persists them to the pack store; `bundle` then serves them. */
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

/** The submitted YAML document. YAML is a superset of JSON, so the pack panel's
 *  `yaml` parser reads this and finds the `cards:` array to publish. */
function submitYaml(): string {
	return JSON.stringify({ schema_version: 1, job: JOB_ID, cards: llmCards() });
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
	const params = new URLSearchParams({ jobId: JOB_ID, baseSha, headSha });
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
		await seedSubmitToolCall(gateway, sid!);

		// Initialise the SESSION WORKTREE as a git repo (the route diffs against the
		// worker's server-derived process.cwd(), never a caller path).
		const ps = gateway.sessionManager?.getPersistedSession(sid!) as { cwd?: string; worktreePath?: string } | undefined;
		const sessionWorktree = ps?.worktreePath ?? ps?.cwd;
		expect(sessionWorktree, "the session must have a resolvable working dir").toBeTruthy();
		setupSessionGitRepo(sessionWorktree!);

		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers());

		// ── Step 2: ENTRYPOINT LAUNCH — the git-widget-button launcher opens the panel. ──
		await page.evaluate((id) => (window as any).__bobbitRunPackLauncher(id), GIT_WIDGET_LAUNCHER);
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
			.toBe(`#/ext/${PACK}?jobId=${JOB_ID}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-testid="prw-load"]').first()).toBeVisible();
		expect(bundlePosts, "panel must NOT auto-invoke callRoute on mount").toHaveLength(0);

		// ── Step 3: LIVE RECOMPUTE + PANEL PUBLISH — navigate the deep-link with base/
		// head, then Load → the panel publishes the agent's cards (read→publish seam)
		// and reads the live bundle; the bundle serves the persisted LLM cards. ──
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

		// Header renders the LIVE changeset (short sha range); the published LLM card
		// surfaces PR_TITLE (proving the panel publish → bundle serve path).
		await expect(page.locator('[data-testid="prw-navrail"]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-title"]').first()).toContainText(baseSha.slice(0, 7));
		await expect(page.locator('[data-testid="prw-card"]').first()).toContainText(PR_TITLE, { timeout: 10_000 });
		// The significant card carries the REAL changed file's diff + its suggested comment.
		await page.locator('[data-testid="prw-nav-card"][data-prw-nav="significant-sync-worker"]').first().click();
		const liveDiff = page.locator('[data-testid="prw-diffblock"]').first();
		await expect(liveDiff).toBeVisible({ timeout: 10_000 });
		await expect(liveDiff).toHaveAttribute("data-prw-file", SYNC_FILE);
		await expect(liveDiff).toContainText("this.withRetry");
		await expect(page.locator('[data-testid="prw-suggested-comment"]').first()).toContainText("jitter", { timeout: 10_000 });
		const persistedAt1 = (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		expect(persistedAt1, "stored cards must carry a persistedAt").toBeTruthy();

		// ── Step 3b: PATH-TRAVERSAL PROBE — a caller-supplied repoDir cannot exfiltrate
		// another repo's diff (the route ignores it; the outside SHAs fail closed). ──
		const attack = await callBundleRoute(sid!, { jobId: JOB_ID, baseSha: outsideBaseSha, headSha: outsideHeadSha, repoDir: outsideRepoDir! });
		expect(attack.text, "the other repo's secret must NEVER leak through repoDir").not.toContain(OUTSIDE_SECRET_MARKER);
		expect(attack.text).not.toContain(OUTSIDE_SECRET_FILE);
		expect(attack.status, `repoDir traversal must NOT return other-repo data (got ${attack.status})`).not.toBe(200);

		// ── reload re-reads the SAME persisted cards (store-rehydration parity). ──
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
			await expect(page.locator('[data-testid="prw-card"]').first()).toContainText(PR_TITLE, { timeout: 10_000 });
			return (await page.locator('[data-testid="prw-persisted-at"]').first().textContent())?.trim();
		};
		const persistedAt2 = await reopenAndLoad();
		expect(persistedAt2, "deep-link must rehydrate the SAME persisted store record").toBe(persistedAt1);

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

		// The deep-link no longer resolves to a registered route → empty state (no panel).
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
		await page.evaluate((h) => { window.location.hash = h; }, liveDeepLink());
		await expect.poll(async () => {
			await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => {});
			return page.locator('[data-testid="prw-panel-root"]').count();
		}, { timeout: 15_000 }).toBe(0);
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
		await page.evaluate((h) => { window.location.hash = h; }, `#/ext/${PACK}?jobId=${JOB_ID}`);
		await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 15_000 });

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
