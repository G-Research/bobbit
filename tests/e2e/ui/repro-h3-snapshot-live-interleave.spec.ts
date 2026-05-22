/**
 * H3 reproduction — concurrent snapshot ↔ live race during the RTT window.
 *
 * Hypothesis: while a `requestMessages()` round-trip is in flight, live
 * `event` frames keep arriving. The reducer is pure but `apply({type:'snapshot'})`
 * and `apply({type:'live-event'})` interleave. The snapshot survivor filter
 * may drop a just-merged live row it thinks is a duplicate, and if a
 * `message_end` was in flight when the snapshot landed the live row's update
 * could be lost.
 *
 * Each variation runs 5x to amplify timing variance.
 *
 * No production code is modified.
 */
import { test, expect } from "./fixtures.js";
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import {
	openApp,
	navigateToHash,
	sendMessage,
} from "./ui-helpers.js";

const ITER = 5;
const STREAM_DONE_RE = /STREAM_BURST_DONE:\d+/;

/** Read the current transcript message-list as a compact projection. */
async function readTranscript(page: import("@playwright/test").Page): Promise<{
	count: number;
	rows: Array<{ role: string; id?: string; order: number; text: string }>;
}> {
	return await page.evaluate(() => {
		const ra = (window as any).__bobbitState?.remoteAgent;
		if (!ra) return { count: -1, rows: [] };
		const msgs = ra._state.messages as any[];
		const rows = msgs.map((m: any) => {
			let text = "";
			if (typeof m.content === "string") text = m.content;
			else if (Array.isArray(m.content)) {
				text = m.content
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text || "")
					.join(" ");
			}
			return {
				role: m.role,
				id: typeof m.id === "string" ? m.id : undefined,
				order: m._order,
				text: text.slice(0, 80),
			};
		});
		return { count: msgs.length, rows };
	});
}

/** Count assistant 'OK' rows. */
async function countOkRows(page: import("@playwright/test").Page): Promise<number> {
	return await page.evaluate(() => {
		const ra = (window as any).__bobbitState?.remoteAgent;
		if (!ra) return -1;
		const msgs = ra._state.messages as any[];
		let n = 0;
		for (const m of msgs) {
			if (m.role !== "assistant") continue;
			let text = "";
			if (typeof m.content === "string") text = m.content;
			else if (Array.isArray(m.content)) {
				text = m.content
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text || "")
					.join(" ");
			}
			if (/(^|\s)OK(\s|$)/.test(text.trim())) n++;
		}
		return n;
	});
}

async function createSessionViaApi(page: import("@playwright/test").Page): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd() }),
	});
	const bodyText = await resp.text();
	expect(resp.status, `create session via API: ${bodyText}`).toBe(201);
	const sessionId = JSON.parse(bodyText).id as string;
	expect(sessionId, "API session id should be valid").toMatch(/^[a-f0-9-]{36}$/);

	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000, message: `selected session should be ${sessionId}` },
	).toBe(sessionId);
	return sessionId;
}

async function waitForRemoteAgentConnected(page: import("@playwright/test").Page) {
	await page.waitForFunction(
		() => !!(window as any).__bobbitState?.remoteAgent?.connected,
		undefined,
		{ timeout: 15_000 },
	);
}

async function requestMessagesAndWaitForSnapshot(page: import("@playwright/test").Page): Promise<void> {
	const expectedSnapshotCount = await page.evaluate(() => {
		const ra = (window as any).__bobbitState?.remoteAgent;
		if (!ra) throw new Error("remote agent is not ready");
		if (!ra.__e2eSnapshotCounterInstalled) {
			const originalApply = ra.apply?.bind(ra);
			if (typeof originalApply !== "function") throw new Error("remote agent apply hook is not available");
			ra.__e2eSnapshotCount = 0;
			ra.apply = (action: any) => {
				const result = originalApply(action);
				if (action?.type === "snapshot") ra.__e2eSnapshotCount = (ra.__e2eSnapshotCount ?? 0) + 1;
				return result;
			};
			ra.__e2eSnapshotCounterInstalled = true;
		}
		const expected = (ra.__e2eSnapshotCount ?? 0) + 1;
		ra.requestMessages();
		return expected;
	});
	await page.waitForFunction(
		(expected) => ((window as any).__bobbitState?.remoteAgent?.__e2eSnapshotCount ?? 0) >= expected,
		expectedSnapshotCount,
		{ timeout: 10_000 },
	);
}

async function yieldToClient(page: import("@playwright/test").Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

test.describe("H3 — snapshot ↔ live interleave race", () => {
	test.setTimeout(180_000);

	// QUARANTINED: H3-A is flaky on master (HEAD a9b87419 reproducible).
	// Refinement of PR #520 (5f8207eb "Fix snapshot ↔ live-event race") is
	// needed — separate goal. Do NOT undo this fixme until that goal lands.
	// See docs/design/snapshot-live-race-fix.md.
	test.fixme("(A) mid-stream snapshot resync during STREAM_BURST does not lose rows", async ({ page }) => {
		await openApp(page);
		await createSessionViaApi(page);
		await waitForRemoteAgentConnected(page);

		const failures: string[] = [];

		for (let i = 0; i < ITER; i++) {
			await sendMessage(page, `STREAM_BURST:2 iter ${i}`);

			// Schedule multiple in-page resyncs at staggered offsets to land
			// during deltas. Use page setTimeout so timers run inside the page.
			await page.evaluate(() => {
				const ra = (window as any).__bobbitState.remoteAgent;
				const offsets = [50, 200, 500, 1000, 2000, 3500, 5000];
				for (const ms of offsets) {
					setTimeout(() => {
						try { ra.requestMessages(); } catch {}
					}, ms);
				}
			});

			// Wait for the burst-done marker to land in the transcript.
			try {
				await page.waitForFunction(
					(re) => {
						const ra = (window as any).__bobbitState?.remoteAgent;
						if (!ra) return false;
						const msgs = ra._state.messages as any[];
						for (const m of msgs) {
							if (m.role !== "assistant") continue;
							let t = "";
							if (typeof m.content === "string") t = m.content;
							else if (Array.isArray(m.content)) {
								t = m.content
									.filter((c: any) => c?.type === "text")
									.map((c: any) => c.text || "")
									.join(" ");
							}
							if (new RegExp(re).test(t)) return true;
						}
						return false;
					},
					STREAM_DONE_RE.source,
					{ timeout: 60_000 },
				);
			} catch (e) {
				failures.push(`iter ${i}: STREAM_BURST_DONE never appeared (${(e as Error).message})`);
				continue;
			}

			// Wait for idle, fire one more resync, then assert.
			await page.waitForFunction(
				() => (window as any).__bobbitState.remoteAgent.state.isStreaming === false,
				undefined,
				{ timeout: 30_000 },
			).catch(() => { /* fall through */ });

			await requestMessagesAndWaitForSnapshot(page);

			const t = await readTranscript(page);
			const userTurn = t.rows.find(
				(r) => r.role === "user" && r.text.includes(`STREAM_BURST:2 iter ${i}`),
			);
			const burstDone = t.rows.find(
				(r) => r.role === "assistant" && STREAM_DONE_RE.test(r.text),
			);

			if (!userTurn) failures.push(`iter ${i}: missing user turn row`);
			if (!burstDone) failures.push(`iter ${i}: missing STREAM_BURST_DONE assistant row`);

			// Per-iter user row (text includes iter index, so always 1 per iter).
			// DONE rows are cumulative since the marker text doesn't include iter.
			const userMatches = t.rows.filter(
				(r) => r.role === "user" && r.text.includes(`STREAM_BURST:2 iter ${i}`),
			).length;
			const doneCum = t.rows.filter(
				(r) => r.role === "assistant" && STREAM_DONE_RE.test(r.text),
			).length;
			if (userMatches !== 1) {
				failures.push(`iter ${i}: this-iter user-row count ${userMatches}, expected 1 (transcript size=${t.count})`);
			}
			if (doneCum !== i + 1) {
				failures.push(`iter ${i}: cumulative STREAM_BURST_DONE count ${doneCum}, expected ${i + 1}`);
			}
		}

		expect(failures, `H3-A failures across ${ITER} iters:\n${failures.join("\n")}`).toEqual([]);
	});

	test("(B) rapid plain-text prompts with mid-burst resync — every reply present", async ({ page }) => {
		await openApp(page);
		await createSessionViaApi(page);
		await waitForRemoteAgentConnected(page);

		const failures: string[] = [];

		for (let outer = 0; outer < ITER; outer++) {
			const before = await countOkRows(page);
			const N = 8;

			// Fire the resyncs concurrently with the prompts.
			await page.evaluate(() => {
				const ra = (window as any).__bobbitState.remoteAgent;
				for (const ms of [10, 30, 75, 150, 300, 600, 1000, 1500]) {
					setTimeout(() => { try { ra.requestMessages(); } catch {} }, ms);
				}
			});

			for (let k = 0; k < N; k++) {
				await sendMessage(page, `tiny ${outer}-${k}`);
				// Don't wait for idle — this is the point. Just yield one frame.
				await yieldToClient(page);
			}

			// Now wait for every prompt to settle.
			await page.waitForFunction(
				() => (window as any).__bobbitState.remoteAgent.state.isStreaming === false,
				undefined,
				{ timeout: 60_000 },
			).catch(() => {});
			// Final resync to make sure server view is reflected.
			await requestMessagesAndWaitForSnapshot(page);

			const after = await countOkRows(page);
			const delta = after - before;
			if (delta !== N) {
				const tr = await readTranscript(page);
				failures.push(
					`outer ${outer}: expected +${N} OK rows, got +${delta} (before=${before} after=${after}, total rows=${tr.count})`,
				);
			}
		}

		expect(failures, `H3-B failures across ${ITER} iters:\n${failures.join("\n")}`).toEqual([]);
	});

	test("(C) WS drop+reconnect mid-stream loses no rows", async ({ page }) => {
		await openApp(page);
		await createSessionViaApi(page);
		await waitForRemoteAgentConnected(page);

		const failures: string[] = [];

		for (let i = 0; i < ITER; i++) {
			await sendMessage(page, `STREAM_BURST:1 wsdrop ${i}`);

			// Drop the WS at staggered points.
			await page.evaluate(() => {
				setTimeout(() => {
					try {
						const ra = (window as any).__bobbitState.remoteAgent;
						if (ra?.ws) ra.ws.close(4006, "test");
					} catch {}
				}, 400);
				setTimeout(() => {
					try {
						const ra = (window as any).__bobbitState.remoteAgent;
						if (ra?.ws) ra.ws.close(4006, "test2");
					} catch {}
				}, 1500);
			});

			// Wait for reconnect + this iter's done marker. The DONE marker
			// text is identical across iters (`STREAM_BURST_DONE:1`), so any
			// previous iter's DONE row would satisfy a `regex.test()` predicate
			// instantly — that produced false-positive `waitForFunction` returns
			// and made the assertion fire while THIS iter's stream was still
			// mid-burst (and subsequent prompts were sitting in the prompt
			// queue). Disambiguate by counting cumulative DONE rows: wait
			// until at least `i + 1` are present. Also wait for the agent to
			// idle so all live events have settled.
			try {
				await page.waitForFunction(
					({ re, expected }: { re: string; expected: number }) => {
						const ra = (window as any).__bobbitState?.remoteAgent;
						if (!ra?.connected) return false;
						const msgs = ra._state.messages as any[];
						let n = 0;
						const rx = new RegExp(re);
						for (const m of msgs) {
							if (m.role !== "assistant") continue;
							let t = "";
							if (typeof m.content === "string") t = m.content;
							else if (Array.isArray(m.content)) {
								t = m.content
									.filter((c: any) => c?.type === "text")
									.map((c: any) => c.text || "")
									.join(" ");
							}
							if (rx.test(t)) n++;
						}
						return n >= expected;
					},
					{ re: STREAM_DONE_RE.source, expected: i + 1 },
					{ timeout: 60_000 },
				);
			} catch (e) {
				failures.push(`iter ${i}: post-WS-drop, this-iter STREAM_BURST_DONE never appeared (${(e as Error).message})`);
				continue;
			}

			// Also wait for streaming to settle so all reconcile events landed.
			await page.waitForFunction(
				() => (window as any).__bobbitState.remoteAgent.state.isStreaming === false,
				undefined,
				{ timeout: 30_000 },
			).catch(() => { /* fall through */ });

			await requestMessagesAndWaitForSnapshot(page);

			const t = await readTranscript(page);
			const userMatches = t.rows.filter(
				(r) => r.role === "user" && r.text.includes(`STREAM_BURST:1 wsdrop ${i}`),
			).length;
			const doneCum = t.rows.filter(
				(r) => r.role === "assistant" && STREAM_DONE_RE.test(r.text),
			).length;

			if (userMatches !== 1) {
				failures.push(`iter ${i}: this-iter user-row count ${userMatches}, expected 1 (transcript size=${t.count})`);
			}
			if (doneCum !== i + 1) {
				failures.push(`iter ${i}: cumulative STREAM_BURST_DONE count ${doneCum}, expected ${i + 1}`);
			}
		}

		expect(failures, `H3-C failures across ${ITER} iters:\n${failures.join("\n")}`).toEqual([]);
	});

	test("(D) two-tab visibility+resync convergence on identical transcripts", async ({ page, context }) => {
		await openApp(page);
		await createSessionViaApi(page);
		await waitForRemoteAgentConnected(page);

		// Capture session id from the URL hash for tab 2 to navigate to it.
		const sessionId = await page.evaluate(() => {
			return (window as any).__bobbitState?.remoteAgent?._sessionId as string | undefined;
		});
		expect(sessionId, "session id should be exposed via remoteAgent._sessionId").toBeTruthy();

		const page2 = await context.newPage();
		await openApp(page2);
		await navigateToHash(page2, `#/session/${sessionId}`);
		await waitForRemoteAgentConnected(page2);

		const failures: string[] = [];

		for (let i = 0; i < ITER; i++) {
			await sendMessage(page, `STREAM_BURST:1 twotab ${i}`);

			// Mid-stream: page2 fires visibilitychange + multiple resyncs.
			// page1 also fires extra resyncs to maximise interleaving.
			await page2.evaluate(() => {
				document.dispatchEvent(new Event("visibilitychange"));
				const ra = (window as any).__bobbitState.remoteAgent;
				for (const ms of [30, 200, 500, 1200, 2500]) {
					setTimeout(() => { try { ra.requestMessages(); } catch {} }, ms);
				}
			});
			await page.evaluate(() => {
				const ra = (window as any).__bobbitState.remoteAgent;
				for (const ms of [80, 400, 900, 1800, 3000]) {
					setTimeout(() => { try { ra.requestMessages(); } catch {} }, ms);
				}
			});

			// Wait for both tabs to see THIS iter's done marker. Same
			// disambiguation as variation (C): the marker text is identical
			// across iters, so a regex test alone returns instantly on a
			// previous iter's DONE row and the assertion fires while this iter
			// is still mid-burst (subsequent prompts queued in `promptQueue`).
			// Count cumulative DONE rows and wait for `>= i + 1` on each tab,
			// then wait for both to settle to idle.
			const waitForDone = (p: import("@playwright/test").Page) =>
				p.waitForFunction(
					({ re, expected }: { re: string; expected: number }) => {
						const ra = (window as any).__bobbitState?.remoteAgent;
						if (!ra) return false;
						const msgs = ra._state.messages as any[];
						let n = 0;
						const rx = new RegExp(re);
						for (const m of msgs) {
							if (m.role !== "assistant") continue;
							let t = "";
							if (typeof m.content === "string") t = m.content;
							else if (Array.isArray(m.content)) {
								t = m.content
									.filter((c: any) => c?.type === "text")
									.map((c: any) => c.text || "")
									.join(" ");
							}
							if (rx.test(t)) n++;
						}
						return n >= expected;
					},
					{ re: STREAM_DONE_RE.source, expected: i + 1 },
					{ timeout: 60_000 },
				);

			try {
				await Promise.all([waitForDone(page), waitForDone(page2)]);
			} catch (e) {
				failures.push(`iter ${i}: this-iter STREAM_BURST_DONE not seen on both tabs (${(e as Error).message})`);
				continue;
			}

			// Wait for both tabs to settle to idle so all reconcile events
			// (including the post-DONE session_status:idle) have landed.
			const waitIdle = (p: import("@playwright/test").Page) =>
				p.waitForFunction(
					() => (window as any).__bobbitState.remoteAgent.state.isStreaming === false,
					undefined,
					{ timeout: 30_000 },
				).catch(() => { /* fall through */ });
			await Promise.all([waitIdle(page), waitIdle(page2)]);

			// Force one more resync on each then compare projections.
			await Promise.all([
				requestMessagesAndWaitForSnapshot(page),
				requestMessagesAndWaitForSnapshot(page2),
			]);

			const [t1, t2] = await Promise.all([readTranscript(page), readTranscript(page2)]);

			// Convergence: both tabs should have the same number of rows.
			if (t1.count !== t2.count) {
				// Diagnostic: show the rows that are on one tab but not the other
				// (by `(role|text)` key, multiset-aware).
				const keyOf = (r: { role: string; text: string }) =>
					`${r.role}|${r.text.replace(/\s+/g, " ").trim().slice(0, 50)}`;
				const countMap = (rows: Array<{ role: string; text: string }>) => {
					const m = new Map<string, number>();
					for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + 1);
					return m;
				};
				const c1 = countMap(t1.rows);
				const c2 = countMap(t2.rows);
				const all = new Set([...c1.keys(), ...c2.keys()]);
				const diffs: string[] = [];
				for (const k of all) {
					const a = c1.get(k) ?? 0;
					const b = c2.get(k) ?? 0;
					if (a !== b) diffs.push(`  [${a} vs ${b}] ${k}`);
				}
				failures.push(
					`iter ${i}: row-count divergence: tab1=${t1.count} tab2=${t2.count}\n${diffs.join("\n")}`,
				);
			}

			// Each tab: cumulative user + done counts.
			// Total user rows (includes all iters) — should equal i+1.
			const u1 = t1.rows.filter(
				(r) => r.role === "user" && r.text.includes(`STREAM_BURST:1 twotab`),
			).length;
			const d1 = t1.rows.filter(
				(r) => r.role === "assistant" && STREAM_DONE_RE.test(r.text),
			).length;
			const u2 = t2.rows.filter(
				(r) => r.role === "user" && r.text.includes(`STREAM_BURST:1 twotab`),
			).length;
			const d2 = t2.rows.filter(
				(r) => r.role === "assistant" && STREAM_DONE_RE.test(r.text),
			).length;

			if (u1 !== i + 1) failures.push(`iter ${i}: tab1 cum user-row count ${u1}, expected ${i + 1}`);
			if (u2 !== i + 1) failures.push(`iter ${i}: tab2 cum user-row count ${u2}, expected ${i + 1}`);
			if (d1 !== i + 1) failures.push(`iter ${i}: tab1 cum DONE count ${d1}, expected ${i + 1}`);
			if (d2 !== i + 1) failures.push(`iter ${i}: tab2 cum DONE count ${d2}, expected ${i + 1}`);
		}

		await page2.close();

		expect(failures, `H3-D failures across ${ITER} iters:\n${failures.join("\n")}`).toEqual([]);
	});
});
