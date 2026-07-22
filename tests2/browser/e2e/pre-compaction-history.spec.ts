/**
 * Browser E2E: pre-compaction history affordance and persistence.
 *
 * Covers seeded transcript behavior, the authoritative live AUTO_COMPACT:3
 * journey through reload, manual compaction, and transient count-probe recovery.
 *
 * See docs/design/persist-compaction-history.md \u00a76.3.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	deleteSession,
	waitForSessionStatus,
	readE2EToken,
} from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage } from "./ui-helpers.js";
import fs from "node:fs";
import path from "node:path";

const HISTORY_TEXTS = ["pre-msg-0", "pre-msg-1", "pre-msg-2"];
const RETAINED_TAIL = "Resuming work after the summary.";

const cardSelector = "[data-testid='compaction-summary-card']";
const historySelector = "[data-testid='pre-compaction-history']";
const rowsSelector = "[data-testid='pre-compaction-rows']";
const toggleSelector = "[data-testid='pre-compaction-toggle']";

async function refreshHistoryCount(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const history = document.querySelector(
			"bobbit-pre-compaction-history",
		) as any;
		if (!history || typeof history.refreshCount !== "function") {
			throw new Error("pre-compaction history refresh hook is unavailable");
		}
		await history.refreshCount();
	});
}

async function expectCollapsedSummaryBeforeTail(page: Page): Promise<void> {
	const cards = page.locator(cardSelector);
	const history = page.locator(historySelector);
	const tail = page
		.locator("assistant-message")
		.filter({ hasText: RETAINED_TAIL });

	await expect(cards).toHaveCount(1, { timeout: 20_000 });
	await expect(cards.first()).toHaveAttribute("data-state", "complete", {
		timeout: 20_000,
	});
	await expect(cards.first().locator("[data-test='verdict']")).toHaveAttribute(
		"data-verdict",
		"ok",
		{ timeout: 15_000 },
	);
	await expect(history).toHaveCount(1, { timeout: 20_000 });
	await refreshHistoryCount(page);
	await expect(history).toHaveAttribute("data-state", "collapsed", {
		timeout: 20_000,
	});
	await expect(page.locator(toggleSelector)).toHaveText(
		/Show 3 messages before compaction/,
		{ timeout: 15_000 },
	);
	await expect(tail).toHaveCount(1, { timeout: 15_000 });

	const order = await page.evaluate(
		({ cardSelector, historySelector, retainedTail }) => {
			const card = document.querySelector(cardSelector);
			const history = document.querySelector(historySelector);
			const tail =
				Array.from(document.querySelectorAll("assistant-message")).find(
					(element) => element.textContent?.includes(retainedTail),
				) ?? null;
			const comesBefore = (first: Element | null, second: Element | null) =>
				!!first &&
				!!second &&
				(first.compareDocumentPosition(second) &
					Node.DOCUMENT_POSITION_FOLLOWING) !==
					0;
			return {
				historyBeforeCard: comesBefore(history, card),
				cardBeforeTail: comesBefore(card, tail),
			};
		},
		{ cardSelector, historySelector, retainedTail: RETAINED_TAIL },
	);

	expect(
		order,
		"collapsed history, summary, and retained tail must stay in transcript order",
	).toEqual({
		historyBeforeCard: true,
		cardBeforeTail: true,
	});
}

async function expandAndExpectHistoricalRows(page: Page): Promise<void> {
	const history = page.locator(historySelector);
	await page.locator(toggleSelector).click();
	await expect(history).toHaveAttribute("data-state", "expanded", {
		timeout: 15_000,
	});

	const container = page.locator(rowsSelector);
	const rows = container.locator(":scope :is(user-message, assistant-message)");
	await expect(rows).toHaveCount(HISTORY_TEXTS.length, { timeout: 15_000 });
	await expect
		.poll(
			async () => (await rows.allTextContents()).map((text) => text.trim()),
			{
				message:
					"historical rows should retain their original content and order",
			},
		)
		.toEqual(HISTORY_TEXTS);

	const presentation = await container.evaluate((element) => {
		const list = element.querySelector("message-list") as any;
		const rowElements = Array.from(
			element.querySelectorAll("user-message, assistant-message"),
		) as any[];
		return {
			opacity: Number.parseFloat(getComputedStyle(element).opacity),
			isStreaming: list?.isStreaming,
			hasStreamMessage: list?.hasStreamMessage,
			rowIds: rowElements.map((row) => row.message?.id),
		};
	});
	expect(
		presentation.opacity,
		"historical rows should be visually dimmed",
	).toBeLessThan(1);
	expect(presentation.isStreaming).toBe(false);
	expect(presentation.hasStreamMessage).toBe(false);
	expect(presentation.rowIds).toHaveLength(HISTORY_TEXTS.length);
	expect(
		presentation.rowIds.every(
			(id: unknown) => typeof id === "string" && id.startsWith("orphan:"),
		),
	).toBe(true);

	await expect(container.locator("streaming-message-container")).toHaveCount(0);
	await expect(page.locator("message-editor .queue-pill")).toHaveCount(0);
	const liveTranscriptTexts = await page.evaluate(() => {
		const messages =
			(window as any).__bobbitState?.remoteAgent?.state?.messages ?? [];
		return messages.flatMap((message: any) =>
			Array.isArray(message?.content)
				? message.content
						.filter((part: any) => part?.type === "text")
						.map((part: any) => part.text)
				: [],
		);
	});
	for (const text of HISTORY_TEXTS)
		expect(liveTranscriptTexts).not.toContain(text);
}

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

	// Authoritative full-stack journey: drive real mock-agent auto compaction,
	// assert the live ordering/read-only history, then prove the same persisted
	// transcript survives a reload. This v2 target is selected by e2e:v2 Group C.
	test("@live-compaction-affordance live auto-compaction history persists across reload", async ({ page }) => {
		test.setTimeout(60_000);
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea")).toBeVisible({
				timeout: 15_000,
			});

			await sendMessage(page, "AUTO_COMPACT:3");
			await waitForSessionStatus(sessionId, "idle", 20_000);
			await expectCollapsedSummaryBeforeTail(page);
			await expandAndExpectHistoricalRows(page);

			await page.reload();
			await expect(page.locator("message-editor textarea")).toBeVisible({
				timeout: 20_000,
			});
			await expectCollapsedSummaryBeforeTail(page);
			await expandAndExpectHistoricalRows(page);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	// Manual `/compact` slash-command path (deterministic, mock agent, no LLM).
	//
	// This is the coverage that formerly lived in the real-LLM manual spec
	// `tests/manual-integration/compaction.spec.ts` (removed: its copied
	// auth.json OAuth snapshot expired mid-run). The mock agent's `compact`
	// command emits `compaction_start`/`compaction_end` with reason "manual"
	// exactly like pi 0.74+, exercising the ws-handler manual branch +
	// session-manager manual sidecar path. The summary card must render as a
	// SUCCESSFUL compaction (complete/ok), with the single-card invariant.
	test("@live-compaction-affordance manual /compact surfaces a complete summary card (no reload)", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });

		// Drive the manual /compact slash command. Typing "/" opens the slash
		// autocomplete menu, which captures Enter as a menu selection; press
		// Escape first to close it, then Enter submits the /compact command
		// (AgentInterface intercepts it and calls session.compact()).
		await textarea.fill("/compact");
		await textarea.press("Escape");
		await textarea.press("Enter");

		// The manual compaction resolves to a SUCCESSFUL card.
		const cards = page.locator("[data-testid='compaction-summary-card']");
		await expect(cards.first()).toBeVisible({ timeout: 20_000 });
		await expect(cards.first()).toHaveAttribute("data-state", "complete", { timeout: 20_000 });
		await expect(cards.first().locator("[data-test='verdict']"))
			.toHaveAttribute("data-verdict", "ok", { timeout: 15_000 });

		// Single-card invariant (no duplicate live + spliced-sidecar cards).
		await expect(cards).toHaveCount(1, { timeout: 8_000 });
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
