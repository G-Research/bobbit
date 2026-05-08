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
import {
	openApp,
	createSessionViaUI,
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

async function waitForRemoteAgentConnected(page: import("@playwright/test").Page) {
	await page.waitForFunction(
		() => !!(window as any).__bobbitState?.remoteAgent?.connected,
		undefined,
		{ timeout: 15_000 },
	);
}

test.describe("H3 — snapshot ↔ live interleave race", () => {
	test.setTimeout(180_000);

	test("(A) mid-stream snapshot resync during STREAM_BURST does not lose rows", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
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

			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.requestMessages();
			});
			await page.waitForTimeout(300); // let the snapshot land

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
		await createSessionViaUI(page);
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
				// Don't wait for idle — this is the point. Just yield.
				await page.waitForTimeout(50);
			}

			// Now wait for every prompt to settle.
			await page.waitForFunction(
				() => (window as any).__bobbitState.remoteAgent.state.isStreaming === false,
				undefined,
				{ timeout: 60_000 },
			).catch(() => {});
			// Final resync to make sure server view is reflected.
			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.requestMessages();
			});
			await page.waitForTimeout(500);

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
		await createSessionViaUI(page);
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

			// Wait for reconnect + done marker.
			try {
				await page.waitForFunction(
					(re) => {
						const ra = (window as any).__bobbitState?.remoteAgent;
						if (!ra?.connected) return false;
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
				failures.push(`iter ${i}: post-WS-drop, STREAM_BURST_DONE never appeared (${(e as Error).message})`);
				continue;
			}

			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.requestMessages();
			});
			await page.waitForTimeout(300);

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
		await createSessionViaUI(page);
		await waitForRemoteAgentConnected(page);

		// Capture session id from the URL hash for tab 2 to navigate to it.
		const sessionId = await page.evaluate(() => {
			return (window as any).__bobbitState?.remoteAgent?._sessionId as string | undefined;
		});
		expect(sessionId, "session id should be exposed via remoteAgent._sessionId").toBeTruthy();

		const page2 = await context.newPage();
		await openApp(page2);
		await page2.evaluate((id: string) => { window.location.hash = `#/session/${id}`; }, sessionId!);
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

			// Wait for both tabs to see the done marker.
			const waitForDone = (p: import("@playwright/test").Page) =>
				p.waitForFunction(
					(re) => {
						const ra = (window as any).__bobbitState?.remoteAgent;
						if (!ra) return false;
						const msgs = ra._state.messages as any[];
						return msgs.some((m: any) => {
							if (m.role !== "assistant") return false;
							let t = "";
							if (typeof m.content === "string") t = m.content;
							else if (Array.isArray(m.content)) {
								t = m.content
									.filter((c: any) => c?.type === "text")
									.map((c: any) => c.text || "")
									.join(" ");
							}
							return new RegExp(re).test(t);
						});
					},
					STREAM_DONE_RE.source,
					{ timeout: 60_000 },
				);

			try {
				await Promise.all([waitForDone(page), waitForDone(page2)]);
			} catch (e) {
				failures.push(`iter ${i}: STREAM_BURST_DONE not seen on both tabs (${(e as Error).message})`);
				continue;
			}

			// Force one more resync on each then compare projections.
			await Promise.all([
				page.evaluate(() => (window as any).__bobbitState.remoteAgent.requestMessages()),
				page2.evaluate(() => (window as any).__bobbitState.remoteAgent.requestMessages()),
			]);
			await page.waitForTimeout(500);

			const [t1, t2] = await Promise.all([readTranscript(page), readTranscript(page2)]);

			// Convergence: both tabs should have the same number of rows.
			if (t1.count !== t2.count) {
				failures.push(
					`iter ${i}: row-count divergence: tab1=${t1.count} tab2=${t2.count}`,
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
