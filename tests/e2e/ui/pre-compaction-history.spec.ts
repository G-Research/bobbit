/**
 * Browser E2E: pre-compaction history expand affordance.
 *
 * Sidecar plus a hand-crafted `.jsonl` whose entries pre-date the
 * `firstKeptEntryId` boundary. Asserts the "Show N messages before
 * compaction" affordance appears, expanding it reveals dimmed read-only
 * rows, and the affordance still works after a page reload.
 *
 * See docs/design/persist-compaction-history.md \u00a76.3.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, waitForSessionStatus, readE2EToken } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage } from "./ui-helpers.js";
import fs from "node:fs";
import path from "node:path";

function makeJsonl(entries: Array<{
	id: string;
	type?: "message" | "compaction";
	role?: string;
	content?: any;
	firstKeptEntryId?: string;
}>): string {
	const ts = new Date().toISOString();
	return entries.map((e) => {
		if (e.type === "compaction") {
			return JSON.stringify({
				type: "compaction",
				id: e.id,
				parentId: null,
				timestamp: ts,
				summary: "",
				firstKeptEntryId: e.firstKeptEntryId ?? "",
				tokensBefore: 1000,
			});
		}
		return JSON.stringify({
			type: "message",
			id: e.id,
			parentId: null,
			timestamp: ts,
			ts,
			message: { role: e.role ?? "user", content: e.content ?? "" },
		});
	}).join("\n") + "\n";
}

async function seedSidecarAndJsonl(opts: {
	bobbitDir: string;
	sessionId: string;
	agentSessionFile: string;
	compactionId: string;
	preCount: number;
}): Promise<void> {
	// Build entries: preCount orphans, then kept-1, then a compaction
	// marker (for legacy fallback safety), then kept-tail entries.
	const entries: Array<any> = [];
	for (let i = 0; i < opts.preCount; i++) {
		entries.push({
			id: `pre-${i}`,
			role: i % 2 === 0 ? "user" : "assistant",
			content: `pre-msg-${i}`,
		});
	}
	entries.push({ id: "kept-1", role: "user", content: "kept after compaction" });
	const jsonl = makeJsonl(entries);
	fs.mkdirSync(path.dirname(opts.agentSessionFile), { recursive: true });
	fs.writeFileSync(opts.agentSessionFile, jsonl);

	const sidecarDir = path.join(opts.bobbitDir, "state", "compaction-sidecar");
	fs.mkdirSync(sidecarDir, { recursive: true });
	const safe = opts.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
	const sidecarFile = path.join(sidecarDir, `${safe}.jsonl`);
	const now = new Date().toISOString();
	fs.appendFileSync(sidecarFile, JSON.stringify({
		schemaVersion: 1,
		id: opts.compactionId,
		trigger: "manual",
		tokensBefore: 50_000,
		tokensAfter: null,
		durationMs: 1000,
		startedAt: now,
		endedAt: now,
		success: true,
		firstKeptEntryId: "kept-1",
	}) + "\n", "utf-8");
}

test.describe("Pre-compaction history affordance", () => {
	test("expand shows dimmed read-only rows; affordance survives reload", async ({ page, gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		const compactionId = "c_precomp_happy";
		// Sidecar can be seeded eagerly (host-side path, not touched by
		// the agent). The card on the snapshot is driven by this.
		const sidecarDir = path.join(gateway.bobbitDir, "state", "compaction-sidecar");
		fs.mkdirSync(sidecarDir, { recursive: true });
		const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
		const now = new Date().toISOString();
		fs.writeFileSync(path.join(sidecarDir, `${safe}.jsonl`), JSON.stringify({
			schemaVersion: 1,
			id: compactionId,
			trigger: "manual",
			tokensBefore: 50_000,
			tokensAfter: null,
			durationMs: 1000,
			startedAt: now,
			endedAt: now,
			success: true,
			firstKeptEntryId: "kept-1",
		}) + "\n", "utf-8");

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Card from the sidecar splice should appear regardless of jsonl content.
		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveCount(1, { timeout: 15_000 });

		// Now override agentSessionFile to a dedicated path we control, then
		// seed the jsonl. The mock-agent only writes during get_state; once
		// the session is settled we won't see another rewrite, so our seed
		// survives. (If a future get_state fires, the mock would write at
		// the NEW path we've just set — which means it would overwrite our
		// seed, but that path was already written empty by the mock at start.
		// We re-seed after the override.)
		let ps: any;
		await expect.poll(
			() => {
				ps = (gateway.sessionManager as any).getPersistedSession(sessionId);
				return !!ps?.agentSessionFile;
			},
			{ timeout: 15_000, intervals: [250] },
		).toBe(true);
		const dedicatedJsonl = path.join(
			gateway.bobbitDir,
			"state",
			`pre-compaction-test-${sessionId}.jsonl`,
		);
		const store = (gateway.sessionManager as any).getSessionStore(ps.projectId);
		store.update(sessionId, { agentSessionFile: dedicatedJsonl });
		await seedSidecarAndJsonl({
			bobbitDir: gateway.bobbitDir,
			sessionId,
			agentSessionFile: dedicatedJsonl,
			compactionId,
			preCount: 3,
		});

		// Sanity check: the REST endpoint must see our seeded jsonl.
		const probeResp = await page.evaluate(async ({ url, token }) => {
			const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
			return { status: r.status, body: await r.text() };
		}, {
			url: `${gateway.baseURL}/api/sessions/${sessionId}/transcript/before-compaction?compactionId=${compactionId}&limit=1`,
			token: readE2EToken(),
		});
		expect(probeResp.status, `probe body: ${probeResp.body}`).toBe(200);
		const probeJson = JSON.parse(probeResp.body);
		expect(probeJson.total).toBe(3);

		// The widget mounted before our jsonl seed — ask it to refresh.
		await page.evaluate(() => {
			const el = document.querySelector("bobbit-pre-compaction-history") as any;
			el?.refreshCount?.();
		});

		const widget = page.locator("[data-testid='pre-compaction-history']");
		await expect(widget).toHaveCount(1, { timeout: 15_000 });
		// The explicit refreshCount() above deterministically triggers the
		// count fetch, so we do NOT need (and must not) scroll the widget into
		// view: the data-state div is re-created when _total flips
		// null\u2192number, and scrollIntoViewIfNeeded() on a handle resolved just
		// before that re-render detaches mid-action ("Element is not attached
		// to the DOM"). The auto-retrying toHaveAttribute below re-resolves the
		// locator each poll, so it waits for the flip without holding a handle.
		await expect(widget).toHaveAttribute("data-state", "collapsed", { timeout: 15_000 });

		const toggle = page.locator("[data-testid='pre-compaction-toggle']");
		await expect(toggle).toContainText(/Show 3 messages before compaction/);

		await toggle.click();
		await expect(widget).toHaveAttribute("data-state", "expanded", { timeout: 15_000 });
		// Orphan messages now render through <message-list> (identical to the
		// live transcript), so we count user-message + assistant-message rows
		// inside the dedicated container.
		const rows = page.locator(
			"[data-testid='pre-compaction-rows'] :is(user-message, assistant-message)",
		);
		await expect(rows).toHaveCount(3, { timeout: 15_000 });

		// Read-only treatment: container is visually dimmed (no pointer-events
		// lock — rows go through the same interactive components as live, by
		// design, so users can copy / expand tool details).
		const container = page.locator("[data-testid='pre-compaction-rows']");
		const opacity = await container.evaluate((el) => getComputedStyle(el).opacity);
		expect(parseFloat(opacity)).toBeLessThan(1);

		// And the rows must contain the seeded text.
		await expect(rows.first()).toContainText("pre-msg-0");
		await expect(rows.last()).toContainText("pre-msg-2");

		// Reload \u2014 affordance is collapsed by default but works again.
		// Re-apply the agentSessionFile override after reload; the post-reload
		// get_state would otherwise reset it back to the mock's own path.
		await page.reload();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		store.update(sessionId, { agentSessionFile: dedicatedJsonl });
		await seedSidecarAndJsonl({
			bobbitDir: gateway.bobbitDir,
			sessionId,
			agentSessionFile: dedicatedJsonl,
			compactionId,
			preCount: 3,
		});
		await expect(card).toHaveCount(1, { timeout: 20_000 });
		const widget2 = page.locator("[data-testid='pre-compaction-history']");
		await page.evaluate(() => {
			const el = document.querySelector("bobbit-pre-compaction-history") as any;
			el?.refreshCount?.();
		});
		// No scrollIntoViewIfNeeded() here either \u2014 refreshCount() drives the
		// fetch and the auto-retrying assertion re-resolves across the
		// re-render that swaps the data-state div (see first site above).
		await expect(widget2).toHaveAttribute("data-state", "collapsed", { timeout: 20_000 });
		await page.locator("[data-testid='pre-compaction-toggle']").click();
		await expect(widget2).toHaveAttribute("data-state", "expanded", { timeout: 15_000 });
		await expect(
			page.locator("[data-testid='pre-compaction-rows'] :is(user-message, assistant-message)"),
		).toHaveCount(3, { timeout: 15_000 });
	});

	// Live-session repro (no reload): drives a real mock-agent auto compaction
	// via the AUTO_COMPACT trigger and asserts the pre-compaction affordance is
	// present — with exactly ONE compaction summary card — in the same session,
	// before any reload. Pre-fix this fails: the in-flight `compact_active` card
	// carries no compactionId (so it never mounts the affordance), and the
	// server splices a SECOND persisted sidecar card into the post-compaction
	// snapshot — leaving two stacked cards (issue-analysis findings #1, #3).
	test("@live-compaction-affordance live compaction surfaces the affordance with exactly one card (no reload)", async ({ page, gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Drive a live auto/threshold compaction with 3 pre-compaction messages.
		await sendMessage(page, "AUTO_COMPACT:3");

		// The compaction card lifecycle begins; wait for at least one card.
		const cards = page.locator("[data-testid='compaction-summary-card']");
		await expect(cards.first()).toBeVisible({ timeout: 20_000 });

		// The affordance must surface in the live session. Proactively kick the
		// count fetch (headless IntersectionObserver can be flaky) and wait for
		// the resolved collapsed state with the correct count. Reaching this
		// state proves the post-compaction snapshot + sidecar have landed.
		const widget = page.locator("[data-testid='pre-compaction-history']");
		await expect(widget).toHaveCount(1, { timeout: 20_000 });
		await page.evaluate(() => {
			const el = document.querySelector("bobbit-pre-compaction-history") as any;
			el?.refreshCount?.();
		});
		await expect(widget).toHaveAttribute("data-state", "collapsed", { timeout: 20_000 });
		await expect(page.locator("[data-testid='pre-compaction-toggle']"))
			.toContainText(/Show 3 messages before compaction/, { timeout: 15_000 });

		// Single-card invariant: exactly one compaction summary card. Pre-fix
		// there are two (live `compact_active` + spliced sidecar card). This
		// assertion is the primary repro signal.
		await expect(cards).toHaveCount(1, { timeout: 8_000 });

		// DOM-ORDER regression (docs/design/fix-compaction-ordering.md §3.2):
		// in the SAME live session the compaction card + pre-compaction-history
		// affordance must render BEFORE the preserved recent tail message. The
		// mock keeps a single active-branch tail ("Resuming work after the
		// summary."). Pre-fix the live `compact_active` card retains a positive
		// reducer `_order` while the preserved-tail snapshot row gets a negative
		// order, so the card sorts AFTER the tail (the reported bug); only a
		// reload/navigate-away fixes it. We compare DOM document order (robust to
		// scroll/layout) rather than y-coordinates.
		const domOrder = await page.evaluate(() => {
			const card = document.querySelector("[data-testid='compaction-summary-card']");
			const widget = document.querySelector("[data-testid='pre-compaction-history']");
			const tail = Array.from(document.querySelectorAll("assistant-message"))
				.find((el) => (el.textContent || "").includes("Resuming work after the summary")) || null;
			const before = (a: Element | null, b: Element | null): boolean | null => {
				if (!a || !b) return null;
				// DOCUMENT_POSITION_FOLLOWING (4) set => b follows a in document order.
				return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
			};
			return {
				hasCard: !!card,
				hasWidget: !!widget,
				hasTail: !!tail,
				cardBeforeTail: before(card, tail),
				widgetBeforeTail: before(widget, tail),
			};
		});
		expect(
			domOrder.hasCard && domOrder.hasWidget && domOrder.hasTail,
			`card/affordance/tail must all be present in DOM: ${JSON.stringify(domOrder)}`,
		).toBe(true);
		expect(
			domOrder.cardBeforeTail,
			"compaction summary card must appear BEFORE the preserved recent message in DOM order",
		).toBe(true);
		expect(
			domOrder.widgetBeforeTail,
			"pre-compaction-history affordance must appear BEFORE the preserved recent message in DOM order",
		).toBe(true);

		// Expanding reveals the 3 orphaned pre-compaction rows.
		await page.locator("[data-testid='pre-compaction-toggle']").click();
		await expect(widget).toHaveAttribute("data-state", "expanded", { timeout: 15_000 });
		const rows = page.locator(
			"[data-testid='pre-compaction-rows'] :is(user-message, assistant-message)",
		);
		await expect(rows).toHaveCount(3, { timeout: 15_000 });
		await expect(rows.first()).toContainText("pre-msg-0");
		await expect(rows.last()).toContainText("pre-msg-2");
	});

	// Manual-compaction late-sidecar RACE regression (no reload).
	//
	// On a live (esp. manual `/compact`) compaction the affordance widget mounts
	// on the `compaction_end` event a beat BEFORE the server finishes appending
	// the sidecar row (ws/handler.ts appends only after awaiting compact()). The
	// widget's count probe therefore races the sidecar write and can transiently
	// 404 (`compaction_not_found`). The pre-fix component cached that 404 as
	// `_total = 0` permanently — the affordance silently rendered empty even
	// though the orphans were on disk, and only a reload recovered it.
	//
	// The fix (PreCompactionHistory: retry transient 404 / network failures with
	// bounded backoff, never caching empty) is exercised here deterministically:
	// we intercept the `limit=1` count probe and return 404 for the first two
	// calls, then let it through. The affordance must still appear with the
	// correct count IN THE SAME SESSION (no reload). Pre-fix this fails: the
	// first 404 freezes `_total = 0` and the toggle never renders.
	test("@live-compaction-affordance count probe recovers from transient 404 without caching empty (no reload)", async ({ page, gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		const compactionId = "c_precomp_race";
		// Seed the sidecar eagerly so the snapshot splice renders the card.
		const sidecarDir = path.join(gateway.bobbitDir, "state", "compaction-sidecar");
		fs.mkdirSync(sidecarDir, { recursive: true });
		const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
		const now = new Date().toISOString();
		fs.writeFileSync(path.join(sidecarDir, `${safe}.jsonl`), JSON.stringify({
			schemaVersion: 1,
			id: compactionId,
			trigger: "manual",
			tokensBefore: 50_000,
			tokensAfter: null,
			durationMs: 1000,
			startedAt: now,
			endedAt: now,
			success: true,
			firstKeptEntryId: "kept-1",
		}) + "\n", "utf-8");

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveCount(1, { timeout: 15_000 });

		// Point the orphan reader at a dedicated jsonl we control, then seed it
		// with 3 orphans + the kept boundary (mirrors the happy-path test above).
		let ps: any;
		await expect.poll(
			() => {
				ps = (gateway.sessionManager as any).getPersistedSession(sessionId);
				return !!ps?.agentSessionFile;
			},
			{ timeout: 15_000, intervals: [250] },
		).toBe(true);
		const dedicatedJsonl = path.join(
			gateway.bobbitDir,
			"state",
			`pre-compaction-race-${sessionId}.jsonl`,
		);
		const store = (gateway.sessionManager as any).getSessionStore(ps.projectId);
		store.update(sessionId, { agentSessionFile: dedicatedJsonl });
		await seedSidecarAndJsonl({
			bobbitDir: gateway.bobbitDir,
			sessionId,
			agentSessionFile: dedicatedJsonl,
			compactionId,
			preCount: 3,
		});

		// Confirm the fixture is genuinely recoverable BEFORE we inject failures
		// (this direct fetch happens before the route is installed).
		const probeResp = await page.evaluate(async ({ url, token }) => {
			const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
			return { status: r.status, body: await r.text() };
		}, {
			url: `${gateway.baseURL}/api/sessions/${sessionId}/transcript/before-compaction?compactionId=${compactionId}&limit=1`,
			token: readE2EToken(),
		});
		expect(probeResp.status, `probe body: ${probeResp.body}`).toBe(200);
		expect(JSON.parse(probeResp.body).total).toBe(3);

		// Wait for the widget's mount-time count probe to settle before we install
		// the route and call refreshCount(). Otherwise this test-only refresh can
		// race an already in-flight mount probe and return early via the component's
		// in-flight guard instead of exercising the retry path below.
		const widget = page.locator("[data-testid='pre-compaction-history']");
		await expect(widget).toHaveCount(1, { timeout: 15_000 });
		await expect(widget).toHaveAttribute("data-state", /collapsed|empty/, { timeout: 15_000 });

		// Inject the transient-404 race: fail the FIRST TWO count probes
		// (limit=1, non-verbose), then let everything through. Mirrors the
		// sidecar-not-yet-written window on a live compaction. The expand fetch
		// (verbose=1) is never intercepted.
		await page.evaluate(() => {
			(window as any).__preCompactionCount404s = 0;
			const originalFetch = window.fetch.bind(window);
			(window as any).__preCompactionOriginalFetch = originalFetch;
			window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const isBeforeCompaction = url.includes("/transcript/before-compaction");
				const isCountProbe = isBeforeCompaction
					&& /[?&]limit=1(&|$)/.test(url)
					&& !/[?&]verbose=1/.test(url);
				if (isCountProbe && (window as any).__preCompactionCount404s < 2) {
					(window as any).__preCompactionCount404s++;
					return Promise.resolve(new Response(
						JSON.stringify({ error: "compaction_not_found" }),
						{ status: 404, headers: { "Content-Type": "application/json" } },
					));
				}
				if (isCountProbe) {
					return Promise.resolve(new Response(
						JSON.stringify({ total: 3, returned: 1, nextCursor: null, messages: [] }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					));
				}
				if (isBeforeCompaction && /[?&]verbose=1/.test(url)) {
					return Promise.resolve(new Response(JSON.stringify({
						total: 3,
						returned: 3,
						nextCursor: null,
						messages: [
							{ index: 0, role: "user", ts: null, content: "pre-msg-0" },
							{ index: 1, role: "assistant", ts: null, content: "pre-msg-1" },
							{ index: 2, role: "user", ts: null, content: "pre-msg-2" },
						],
					}), { status: 200, headers: { "Content-Type": "application/json" } }));
				}
				return originalFetch(input as any, init);
			}) as typeof window.fetch;
		});

		// Drive the count fetch. The first two probes 404; the bounded-backoff
		// retry then lands a 200 and resolves the count — all without a reload.
		await page.evaluate(async () => {
			const el = document.querySelector("bobbit-pre-compaction-history") as any;
			if (!el || typeof el.refreshCount !== "function") {
				throw new Error("pre-compaction-history refreshCount hook missing");
			}
			await el.refreshCount();
		});

		// The affordance must surface with the correct count despite the 404s —
		// proving the retry recovered instead of caching empty.
		await expect(widget).toHaveAttribute("data-state", "collapsed", { timeout: 15_000 });
		await expect(page.locator("[data-testid='pre-compaction-toggle']"))
			.toContainText(/Show 3 messages before compaction/, { timeout: 15_000 });
		// Sanity: the failures we injected were actually consumed (the test would
		// be vacuous if the route never matched the count probe).
		const count404s = await page.evaluate(() => (window as any).__preCompactionCount404s);
		expect(count404s, "expected the injected count-probe 404s to be consumed").toBe(2);

		// Expansion/rendering of orphan rows is covered by the happy-path test above;
		// this regression focuses on the manual-race count probe not caching empty.
	});
});
