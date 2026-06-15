/**
 * Browser E2E — missing-live-messages fix (CS-R2 restore coordinator + lifecycle fencing).
 *
 * Goal acceptance: an already-attached client must receive an assistant turn
 * produced AFTER the session went dormant/hibernated and was revived
 * (dormant-revive / in-place respawn). The reply must render LIVE (no reload)
 * and the session status must return to a correct idle.
 *
 * Root cause (docs/design/comms-stack/missing-live-messages-rootcause.md, finding
 * F2e): `SessionManager.addClient()` fired unguarded concurrent `restoreSession`
 * calls for a `terminated`/dormant session, splitting attached clients across
 * different `SessionInfo` objects so live frames never reached the tab. The fix
 * (src/server/agent/session-manager.ts `_restoreSessionCoalesced` /
 * `_coalesceRestore` / lifecycle generation fencing) coalesces concurrent revives
 * into one restore and attaches every client to the single canonical SessionInfo.
 * The deterministic unit repro is tests/missing-live-messages-repro.test.ts; this
 * spec is the spawned-gateway browser + live-server proof.
 *
 * Two tests:
 *  1. (browser DOM) attach → hibernate → revive-on-reconnect → a turn produced
 *     server-side reaches the attached tab LIVE (assistant bubble renders without
 *     page.reload()) and status returns to idle. This is the user-visible
 *     acceptance: "replies generated server-side must not be silently dropped on
 *     the way to an attached client".
 *  2. (live SessionManager) two CONCURRENT dormant `addClient()` revives must
 *     coalesce into ONE restore so EVERY attached client lands on the canonical
 *     SessionInfo and receives the post-revive assistant frame. This is the
 *     deterministic red->green regression: pre-fix the two synchronous addClient
 *     calls start two independent restores (split-brain) and the loser client is
 *     left on a stale SessionInfo that never receives the dispatched assistant
 *     frame; post-fix both join one restore and both clients receive it.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

/** Count assistant-message custom elements whose visible text contains a bare "OK". */
async function countAssistantOk(page: import("@playwright/test").Page): Promise<number> {
	return await page.evaluate(() => {
		const ai = document.querySelector("agent-interface");
		if (!ai) return -1;
		const msgs = ai.querySelectorAll("assistant-message");
		let n = 0;
		for (const el of Array.from(msgs)) {
			const text = (el.textContent ?? "").trim();
			if (/(^|\s)OK(\s|$)/.test(text)) n++;
		}
		return n;
	});
}

/** Minimal fake WS client mirroring the production WebSocket surface the broadcast
 *  path touches (readyState / send). Collects every frame as parsed JSON. */
type FakeClient = {
	readyState: number;
	bufferedAmount: number;
	sent: any[];
	send(data: string): void;
	close(): void;
};
function makeFakeClient(): FakeClient {
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(data: string) { try { this.sent.push(JSON.parse(data)); } catch { /* non-JSON frame */ } },
		close() { this.readyState = 3; },
	};
}
function sawAssistantFrame(client: FakeClient): boolean {
	return client.sent.some((msg) =>
		msg?.type === "event" &&
		msg?.data?.type === "message_end" &&
		msg?.data?.message?.role === "assistant",
	);
}

/**
 * Force the in-memory session into the production dormant state
 * (`status === "terminated"`, `dormant: true`) — exactly what `addDormantSession`
 * produces on a cold boot / orphan-keep. Returns the live SessionInfo that was
 * evicted so the caller can close its sockets (to drive a browser reconnect).
 */
function hibernateSession(sm: any, sessionId: string): { evicted: any; ps: any } {
	const ps = sm.resolveStoreForId(sessionId)?.get(sessionId);
	if (!ps?.agentSessionFile) {
		throw new Error(`session ${sessionId} has no persisted agentSessionFile; cannot hibernate`);
	}
	const evicted = sm.sessions.get(sessionId);
	sm.sessions.delete(sessionId);
	sm.addDormantSession(ps);
	const dormant = sm.sessions.get(sessionId);
	if (dormant?.status !== "terminated") {
		throw new Error(`expected dormant session to be "terminated", got "${dormant?.status}"`);
	}
	return { evicted, ps };
}

test.describe("missing live messages — dormant revive delivers replies live", () => {
	test("attached client receives a server-produced turn after dormant revive (live, no reload)", async ({ page, gateway }) => {
		const sm: any = gateway.sessionManager;
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		// Attach the browser to the LIVE session (editable, WS attached).
		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("agent-interface").first()).toBeVisible({ timeout: 20_000 });
		await page.waitForFunction(
			(id) => {
				const a = (window as any).__bobbitState?.remoteAgent;
				return !!a?.connected && a?._sessionId === id && a?.state?.status === "idle";
			},
			sessionId,
			{ timeout: 20_000 },
		);
		expect(await countAssistantOk(page), "no assistant reply before the turn").toBe(0);

		// Hibernate the session server-side, then close the browser's socket so the
		// client reconnects — its reconnect attach hits addClient's dormant-revive
		// branch (the fixed `_restoreSessionCoalesced` path), exactly the production
		// "tab reconnects after hibernation, then wakes the session" sequence.
		const { evicted } = hibernateSession(sm, sessionId);
		for (const ws of evicted.clients) { try { ws.close(4001, "hibernate"); } catch { /* best-effort */ } }
		try { await evicted.rpcClient.stop(); } catch { /* already dead */ }

		// The tab reconnects, the dormant session revives, and status returns to idle.
		await page.waitForFunction(
			(id) => {
				const a = (window as any).__bobbitState?.remoteAgent;
				return !!a?.connected && a?._sessionId === id && a?.state?.status === "idle";
			},
			sessionId,
			{ timeout: 30_000 },
		);
		// Server-side: the revive coalesced and the canonical session is live again.
		await expect.poll(() => sm.sessions.get(sessionId)?.status, { timeout: 15_000 }).toBe("idle");

		// Sentinel proves the assertion below is satisfied WITHOUT any reload.
		await page.evaluate(() => { (window as any).__noReloadSentinel = "kept"; });

		// Produce a turn AFTER the revive. This is the exact failure shape from the
		// bug report: a reply generated + persisted server-side. It must reach the
		// attached tab live.
		await sm.enqueuePrompt(sessionId, "post-revive live delivery please");

		// The assistant reply renders LIVE in the attached tab (no reload).
		await expect.poll(
			() => countAssistantOk(page),
			{ timeout: 20_000, intervals: [100, 200, 400] },
		).toBe(1);

		expect(
			await page.evaluate(() => (window as any).__noReloadSentinel),
			"reply must render without any page reload",
		).toBe("kept");

		// Status returns to a correct idle (no stuck streaming / dead Stop).
		await page.waitForFunction(
			() => (window as any).__bobbitState?.remoteAgent?.state?.status === "idle",
			undefined,
			{ timeout: 20_000 },
		);
		await expect.poll(() => sm.sessions.get(sessionId)?.status, { timeout: 15_000 }).toBe("idle");
	});

	test("concurrent dormant addClient revives coalesce so every attached client receives the post-revive frame", async ({ gateway }) => {
		const sm: any = gateway.sessionManager;
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		// Hibernate to the production dormant state.
		const { evicted } = hibernateSession(sm, sessionId);
		try { await evicted.rpcClient.stop(); } catch { /* already dead */ }

		// Two clients attach to the dormant session in the SAME tick. Pre-fix each
		// addClient starts its own restoreSession (two SessionInfo objects, empty
		// client sets); the second restore replaces the map last, leaving the first
		// client stranded on a stale object. Post-fix the second addClient joins the
		// in-flight restore coordinator, so BOTH clients land on the one canonical
		// SessionInfo.
		const clientA = makeFakeClient();
		const clientB = makeFakeClient();
		expect(sm.addClient(sessionId, clientA), "addClient A optimistically accepts the dormant attach").toBe(true);
		expect(sm.addClient(sessionId, clientB), "addClient B optimistically accepts the dormant attach").toBe(true);

		// The coalesced restore settles and BOTH clients are attached to the single
		// canonical SessionInfo. Pre-fix this times out (clientA on a stale object →
		// canonical clients.size stays at 1).
		await expect.poll(
			() => {
				const s = sm.sessions.get(sessionId);
				if (!s || s.status !== "idle") return -1;
				return [...s.clients].filter((c: any) => c === clientA || c === clientB).length;
			},
			{ timeout: 20_000, intervals: [50, 100, 200] },
		).toBe(2);

		// A turn produced after the revive must reach EVERY attached client.
		await sm.enqueuePrompt(sessionId, "post-revive frame for all attached clients");

		await expect.poll(
			() => sawAssistantFrame(clientB),
			{ timeout: 20_000, intervals: [50, 100, 200] },
		).toBe(true);
		expect(
			sawAssistantFrame(clientA),
			"every client attached across the concurrent revive must receive the post-revive assistant frame",
		).toBe(true);

		// Status returns to a correct idle.
		await expect.poll(() => sm.sessions.get(sessionId)?.status, { timeout: 15_000 }).toBe("idle");
	});
});
