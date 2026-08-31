/**
 * Browser E2E (Tier 2.5) — accepted/no-echo steer ambiguity across Stop.
 *
 * The real Claude bridge can acknowledge a steer before its correlated Pi user
 * row is durable. If Stop then terminates the active tool turn, acknowledgement
 * alone cannot prove either delivery or non-delivery. Bobbit must keep each
 * accepted occurrence visible as non-retryable uncertainty instead of replaying
 * it and risking duplicate model side effects.
 *
 * MOCK_ABORT_AS_ERROR=1 supplies the real-agent abort shape: an assistant
 * `message_end` with `stopReason:"error"` before terminal `agent_end`.
 * MOCK_STEER_QUEUE_DROP=always accepts both steer RPCs but suppresses their Pi
 * user echoes, leaving the durable intent/attempt tuples as the only authority.
 *
 * Run with capture on:
 *   RECORDSCREEN=1 npm run test:e2e -- steer-during-bash-tool.browser-e2e.spec.ts
 */
import { test, expect } from "../ui/fixtures.js";
import {
	connectWs,
	createSession,
	queueLenPredicate,
	statusPredicate,
	toolStartPredicate,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "../ui/ui-helpers.js";
import {
	intentId,
	intentRows,
	reliableMockCore,
	userMessageEnds,
} from "../../../tests2/integration/helpers/reliable-turn-barriers.js";

const STEER_TEXTS = ["Steer1", "Steer2"] as const;

interface DispatchIdentity {
	id: string;
	text: typeof STEER_TEXTS[number];
	attemptId: string;
	dispatchEpoch: number;
}

async function clickAllSteerButtons(page: any): Promise<void> {
	const buttons = page.locator(".queue-pill .steer-btn");
	let remaining = await buttons.count();
	while (remaining > 0) {
		// Under full-suite load, a queued row can drain between the count above
		// and the click. Query synchronously in the page so a vanished button is
		// treated as already drained instead of waiting for a selector that
		// should not reappear.
		const clicked = await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>(".queue-pill .steer-btn");
			if (!button) return false;
			button.click();
			return true;
		});

		if (clicked) {
			await expect.poll(async () => buttons.count(), { timeout: 5_000 }).toBeLessThan(remaining);
		}

		remaining = await buttons.count();
	}
}

async function clickStopIfPresent(page: any): Promise<void> {
	const stop = page.getByRole("button", { name: "Stop current turn" }).first();
	if (await stop.count() === 0) return;
	await stop.evaluate((el: HTMLElement) => el.click()).catch(() => { /* already settled */ });
}

function hasExactSteerProjection(frame: any, deliveryState: "dispatching" | "uncertain"): boolean {
	if (frame?.type !== "queue_update" && frame?.type !== "delivery_outbox") return false;
	const rows = intentRows(frame);
	return rows.length === STEER_TEXTS.length
		&& STEER_TEXTS.every((text) =>
			rows.filter((row) => row.text === text && row.deliveryState === deliveryState).length === 1,
		);
}

async function expectUncertainPills(page: any, identities: readonly DispatchIdentity[]): Promise<void> {
	await expect(page.locator(".queue-pill")).toHaveCount(identities.length, { timeout: 5_000 });
	await expect(page.locator(
		'.queue-pill[data-intent-kind="steer"][data-target-turn="continuation"][data-delivery-state="uncertain"]',
	)).toHaveCount(identities.length, { timeout: 5_000 });

	for (const identity of identities) {
		const row = page.locator(`.queue-pill[data-intent-id="${identity.id}"]`);
		await expect(row).toHaveCount(1);
		await expect(row.locator(".pill-text")).toHaveText(identity.text);
		await expect(row.getByTestId("intent-status")).toHaveText("Awaiting delivery confirmation");
		await expect(row.getByRole("button", { name: "Dismiss unconfirmed delivery" })).toBeVisible();
		await expect(row.getByRole("button", { name: "Retry" })).toHaveCount(0);
		await expect(row.locator(".steer-btn")).toHaveCount(0);
	}
}

async function expectNoSteerTranscript(page: any, identities: readonly DispatchIdentity[]): Promise<void> {
	for (const identity of identities) {
		await expect(page.locator(`user-message[data-intent-id="${identity.id}"]`)).toHaveCount(0);
		await expect(page.locator("user-message").filter({ hasText: identity.text })).toHaveCount(0);
	}
}

test.describe("steer subsystem — errored Stop preserves acknowledged/no-echo ambiguity", () => {
	test.setTimeout(90_000);

	test.beforeAll(async () => {
		// Switch the in-process mock bridge to real-agent-shape abort: the
		// abort handler emits a `message_end` with `stopReason:"error"` before
		// `agent_end`, mirroring what the real Claude bridge does.
		process.env.MOCK_ABORT_AS_ERROR = "1";
		// Accept each steer RPC without emitting its correlated Pi user row. The
		// resulting post-write ambiguity must remain durable and must not replay.
		process.env.MOCK_STEER_QUEUE_DROP = "always";
		await waitForHealth();
	});

	test.afterAll(() => {
		delete process.env.MOCK_ABORT_AS_ERROR;
		delete process.env.MOCK_STEER_QUEUE_DROP;
	});

	test("acknowledged steers remain durable, uncertain, and unreplayed after Stop", async ({ page, rec, gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const conn = await connectWs(sessionId);
		const core = reliableMockCore(gateway, sessionId);
		let restoredConn: Awaited<ReturnType<typeof connectWs>> | undefined;

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await page.waitForFunction((id) => {
				return window.location.hash.includes(`/session/${id}`)
					&& (window as any).bobbitState?.selectedSessionId === id;
			}, sessionId, { timeout: 15_000 });
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await rec.capture("Empty composer ready");

			// 1. Long busy bash. Wait for the server-side tool start, not just
			//    the early UI streaming state, so queued rows cannot race a turn
			//    that has not actually entered the abortable bash body yet.
			await sendMessage(page, "STAY_BUSY:10000 working");
			await conn.waitFor(toolStartPredicate("Bash"), 15_000);
			await expect(page.getByRole("button", { name: "Stop current turn" })).toBeVisible({ timeout: 10_000 });
			await rec.capture("Agent busy — bash tool running");

			// 2. Queue two messages. Confirm both the visible pills and the
			//    authoritative server queue so later assertions are not racing a
			//    client-only render delay.
			const textarea = page.locator("textarea").first();
			let cursor = conn.messageCount();
			await textarea.fill("Steer1");
			await textarea.press("Enter");
			await conn.waitForFrom(cursor, queueLenPredicate(1), 10_000);
			await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
			cursor = conn.messageCount();
			await textarea.fill("Steer2");
			await textarea.press("Enter");
			await conn.waitForFrom(cursor, queueLenPredicate(2), 10_000);
			await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });
			await rec.capture("Two messages queued");

			// 3. Promote both rows and capture their authoritative dispatch tuples.
			const steerCursor = conn.messageCount();
			await clickAllSteerButtons(page);
			const dispatchProjection = await conn.waitForFrom(
				steerCursor,
				(frame) => hasExactSteerProjection(frame, "dispatching"),
				10_000,
			);
			const dispatchRows = intentRows(dispatchProjection);
			await expect(page.locator(
				'.queue-pill[data-intent-kind="steer"][data-delivery-state="dispatching"]',
			)).toHaveCount(2, { timeout: 5_000 });
			await expect(page.locator(".queue-pill .steer-btn")).toHaveCount(0);

			for (const row of dispatchRows) {
				expect({ ...row, unsent: row.unsent ?? false }).toMatchObject({
					kind: "steer",
					targetTurn: "continuation",
					deliveryState: "dispatching",
					unsent: false,
				});
				expect(typeof intentId(row) === "string" && intentId(row)!.length > 0).toBe(true);
				expect(typeof row.attemptId === "string" && row.attemptId.length > 0).toBe(true);
				expect(Number.isFinite(row.dispatchEpoch)).toBe(true);
			}
			expect(new Set(dispatchRows.map(intentId)).size).toBe(STEER_TEXTS.length);
			expect(new Set(dispatchRows.map((row) => row.attemptId)).size).toBe(STEER_TEXTS.length);
			expect(new Set(dispatchRows.map((row) => row.dispatchEpoch)).size).toBe(STEER_TEXTS.length);

			const identities = dispatchRows.map((row) => ({
				id: intentId(row)!,
				text: row.text as DispatchIdentity["text"],
				attemptId: row.attemptId as string,
				dispatchEpoch: row.dispatchEpoch as number,
			})).sort((left, right) => left.text.localeCompare(right.text));
			expect(identities.map((identity) => identity.text)).toEqual([...STEER_TEXTS]);
			await rec.capture("Both pills steered and dispatched");

			// 4. Stop from a fresh WS cursor, then join canonical idle and the full
			//    authoritative uncertainty projection produced by that Stop.
			const stopCursor = conn.messageCount();
			await clickStopIfPresent(page);
			await conn.waitForFrom(stopCursor, statusPredicate("idle"), 15_000);
			const uncertainProjection = await conn.waitForFrom(
				stopCursor,
				(frame) => hasExactSteerProjection(frame, "uncertain"),
				15_000,
			);
			const uncertainRows = intentRows(uncertainProjection);
			expect(uncertainRows).toHaveLength(identities.length);
			for (const identity of identities) {
				const matching = uncertainRows.filter((row) => intentId(row) === identity.id);
				expect(matching).toHaveLength(1);
				expect({ ...matching[0], unsent: matching[0].unsent ?? false }).toMatchObject({
					text: identity.text,
					kind: "steer",
					targetTurn: "continuation",
					deliveryState: "uncertain",
					retryable: false,
					unsent: false,
					attemptId: identity.attemptId,
					dispatchEpoch: identity.dispatchEpoch,
				});
			}
			await rec.capture("Stop settled both acknowledged steers as uncertain");

			// 5. The exact accepted identities remain visible once each and are
			//    dismiss-only. No correlated Pi user end or transcript carrier may be
			//    invented for an acknowledged handoff whose actual echo was suppressed.
			for (const identity of identities) {
				expect(userMessageEnds(conn.messages.slice(steerCursor), identity.text)).toHaveLength(0);
			}
			await expectUncertainPills(page, identities);
			await expectNoSteerTranscript(page, identities);

			const steerJournalAfterStop = core.commandJournal
				.filter((entry) => entry.kind === "steer")
				.map((entry) => ({ ...entry }));
			expect(steerJournalAfterStop.map((entry) => entry.text).sort()).toEqual([...STEER_TEXTS].sort());

			// 6. One hard reload must reconstruct the same durable outbox identities
			//    without turning either recovery carrier into hidden transcript content
			//    or dispatching either accepted occurrence again.
			const reloadCursor = conn.messageCount();
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.waitForFunction((id) => {
				return window.location.hash.includes(`/session/${id}`)
					&& (window as any).bobbitState?.selectedSessionId === id;
			}, sessionId, { timeout: 15_000 });
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await expectUncertainPills(page, identities);
			await expectNoSteerTranscript(page, identities);

			// A fresh attachment supplies the authoritative restored projection and
			// fences the original observer's cursor scan without an arbitrary wait.
			restoredConn = await connectWs(sessionId);
			const restoredProjection = await restoredConn.waitFor((frame) => {
				if (frame.type !== "queue_update" && frame.type !== "delivery_outbox") return false;
				const rows = intentRows(frame);
				return rows.length === identities.length && identities.every((identity) =>
					rows.filter((row) => intentId(row) === identity.id && row.deliveryState === "uncertain").length === 1,
				);
			});
			const restoredRows = intentRows(restoredProjection);
			for (const identity of identities) {
				const matching = restoredRows.filter((row) => intentId(row) === identity.id);
				expect(matching).toHaveLength(1);
				expect({ ...matching[0], unsent: matching[0].unsent ?? false }).toMatchObject({
					text: identity.text,
					kind: "steer",
					targetTurn: "continuation",
					deliveryState: "uncertain",
					retryable: false,
					unsent: false,
					attemptId: identity.attemptId,
					dispatchEpoch: identity.dispatchEpoch,
				});
			}

			const identityIds = new Set(identities.map((identity) => identity.id));
			const replayedDispatches = conn.messages.slice(reloadCursor).filter((frame) =>
				intentRows(frame).some((row) =>
					identityIds.has(intentId(row) ?? "") && row.deliveryState === "dispatching",
				),
			);
			expect(replayedDispatches).toEqual([]);

			const steerJournalAfterReload = core.commandJournal
				.filter((entry) => entry.kind === "steer")
				.map((entry) => ({ ...entry }));
			expect(steerJournalAfterReload.map((entry) => entry.text).sort()).toEqual([...STEER_TEXTS].sort());
			expect(steerJournalAfterReload).toEqual(steerJournalAfterStop);
			for (const identity of identities) {
				expect(userMessageEnds(conn.messages.slice(steerCursor), identity.text)).toHaveLength(0);
			}
		} finally {
			restoredConn?.close();
			conn.close();
		}
	});
});
