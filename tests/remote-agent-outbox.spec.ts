/**
 * S2 — send outbox: prompts/steers/retries issued while the WS is reconnecting
 * are queued (shown as pending pills), not silently dropped, and flushed on
 * auth_ok. Drives the REAL RemoteAgent.send()/getQueue()/_flushOutbox() with a
 * fake WebSocket. On master, send() console.warn'd and dropped the frame while
 * the composer cleared + an optimistic bubble rendered — the prompt was lost.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/remote-agent-outbox.html");
const BUNDLE = path.resolve("tests/fixtures/remote-agent-outbox-bundle.js");
const ENTRY = path.resolve("tests/fixtures/remote-agent-outbox-entry.ts");
const SRC = path.resolve("src/app/remote-agent.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(SRC).mtimeMs);
	const stale = fs.existsSync(BUNDLE) && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!fs.existsSync(BUNDLE) || stale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;
async function ready(page: any) {
	// `waitUntil: "load"` guarantees the synchronous bundle <script> has executed
	// (so `__ready` is already set) before we poll. The generous timeout absorbs
	// CPU-saturation spikes during the concurrent full unit run, where a fixed 10s
	// budget was occasionally exceeded on loaded machines (macOS/CI) even though the
	// flag is set effectively immediately — see the flake fixed alongside G1.2.
	await page.goto(PAGE, { waitUntil: "load" });
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 30_000 });
}

test.describe("RemoteAgent live preference sync", () => {
	test("preferences_changed keeps Headquarters visibility state in sync", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			const ra = w.__makeAgent(w.__OPEN);

			w.__setHeadquartersVisibleState(true);
			w.__resetRenderCount();
			await w.__serverMessage(ra, {
				type: "preferences_changed",
				preferences: { showHeadquartersInProjectLists: false },
			});
			await w.__nextRenderFrame();
			const hidden = {
				visible: w.__getHeadquartersVisibleState(),
				renders: w.__renderCount(),
			};

			w.__resetRenderCount();
			await w.__serverMessage(ra, {
				type: "preferences_changed",
				preferences: {},
			});
			await w.__nextRenderFrame();
			const defaultVisible = {
				visible: w.__getHeadquartersVisibleState(),
				renders: w.__renderCount(),
			};

			return { hidden, defaultVisible };
		});

		expect(r.hidden.visible).toBe(false);
		expect(r.hidden.renders).toBeGreaterThan(0);
		expect(r.defaultVisible.visible).toBe(true);
		expect(r.defaultVisible.renders).toBeGreaterThan(0);
	});
});

test.describe("RemoteAgent provider auth recovery", () => {
	test("stores a redacted provider_auth_required event and clears it on retry, new prompt, model switch, and agent_start", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			const makeEvent = () => ({
				type: "provider_auth_required",
				provider: "openrouter",
				source: "direct prompt",
				reason: "missing-api-key",
				message: "OpenRouter API key is missing. Add or fix the API key in Settings, switch provider, then retry.",
				error: "No API key found for openrouter: sk-or-secret-never-render",
				actions: [
					{ type: "open_settings", label: "Fix API key in Settings" },
					{ type: "retry", label: "Retry after fixing credentials" },
					{ type: "switch_provider", label: "Switch provider" },
					{ type: "abort_respawn", label: "Abort/respawn agent" },
				],
			});

			const retryAgent = w.__makeAgent(w.__OPEN);
			w.__event(retryAgent, makeEvent());
			const stored = w.__snapshot(retryAgent).providerAuthRequired;
			retryAgent.retry();
			const afterRetry = w.__snapshot(retryAgent);

			const promptAgent = w.__makeAgent(w.__OPEN);
			w.__event(promptAgent, makeEvent());
			await promptAgent.prompt("after key fix");
			const afterPrompt = w.__snapshot(promptAgent);

			const modelAgent = w.__makeAgent(w.__OPEN);
			w.__event(modelAgent, makeEvent());
			modelAgent.setModel({ provider: "anthropic", id: "claude-test", contextWindow: 1 });
			const afterModel = w.__snapshot(modelAgent);

			const startAgent = w.__makeAgent(w.__OPEN);
			w.__event(startAgent, makeEvent());
			w.__event(startAgent, { type: "agent_start" });
			const afterStart = w.__snapshot(startAgent);

			return { stored, afterRetry, afterPrompt, afterModel, afterStart };
		});

		expect(r.stored).toMatchObject({
			provider: "openrouter",
			source: "direct prompt",
			reason: "missing-api-key",
		});
		expect(JSON.stringify(r.stored)).not.toContain("sk-or-secret-never-render");
		expect(r.afterRetry.providerAuthRequired).toBeNull();
		expect(r.afterRetry.sent.at(-1)).toMatchObject({ type: "retry" });
		expect(r.afterPrompt.providerAuthRequired).toBeNull();
		expect(r.afterPrompt.sent.at(-1)).toMatchObject({ type: "prompt", text: "after key fix" });
		expect(r.afterModel.providerAuthRequired).toBeNull();
		expect(r.afterModel.sent.at(-1)).toMatchObject({ type: "set_model", provider: "anthropic", modelId: "claude-test" });
		expect(r.afterStart.providerAuthRequired).toBeNull();
	});
});

test.describe("RemoteAgent send outbox (S2)", () => {
	test("offline prompt is queued as a pending pill (no drop, no false 'sent' bubble) and flushes on reconnect", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			const ra = w.__makeAgent(w.__CLOSED);
			await ra.prompt("lost-xyz");
			const offline = w.__snapshot(ra);
			// Reconnect: socket opens, auth_ok would call _flushOutbox.
			w.__setReadyState(ra, w.__OPEN);
			w.__flush(ra);
			const afterFlush = w.__snapshot(ra);
			return { offline, afterFlush };
		});
		// While offline: queued, not sent; surfaced as an unsent pill; no transcript bubble.
		expect(r.offline.sent).toHaveLength(0);
		expect(r.offline.outboxLen).toBe(1);
		expect(r.offline.messages).toBe(0);
		expect(r.offline.queue).toHaveLength(1);
		expect(r.offline.queue[0].text).toBe("lost-xyz");
		expect(r.offline.queue[0].unsent).toBe(true);
		expect(r.offline.queueUpdateCount).toBeGreaterThan(0);
		// After reconnect flush: delivered exactly once, outbox cleared.
		expect(r.afterFlush.outboxLen).toBe(0);
		expect(r.afterFlush.sent).toHaveLength(1);
		expect(r.afterFlush.sent[0]).toMatchObject({ type: "prompt", text: "lost-xyz" });
	});

	test("only prompt/steer/retry are buffered; control frames are dropped", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			const ra = w.__makeAgent(w.__CLOSED);
			await ra.prompt("p1");
			ra.steer("s1");
			ra.retry();
			(ra as any).send({ type: "get_state" }); // control frame — must NOT queue
			(ra as any).send({ type: "ping" });
			return w.__snapshot(ra);
		});
		// prompt + steer + retry queued (3); get_state/ping dropped.
		expect(r.outboxLen).toBe(3);
		// Only prompt + steer have pill rows (retry has no text).
		expect(r.queue).toHaveLength(2);
		expect(r.queue.map((q: any) => q.text).sort()).toEqual(["p1", "s1"]);
		expect(r.queue.find((q: any) => q.text === "s1").isSteered).toBe(true);
	});

	test("outbox is bounded at OUTBOX_MAX (oldest dropped)", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			const ra = w.__makeAgent(w.__CLOSED);
			for (let i = 0; i < 60; i++) (ra as any).send({ type: "prompt", text: `m${i}` });
			const snap = w.__snapshot(ra);
			return { outboxLen: snap.outboxLen, firstText: snap.queue[0]?.text, lastText: snap.queue[snap.queue.length - 1]?.text };
		});
		expect(r.outboxLen).toBe(50); // OUTBOX_MAX
		expect(r.firstText).toBe("m10"); // m0..m9 evicted
		expect(r.lastText).toBe("m59");
	});

	test("removeQueued drops a pending-unsent row locally", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			const ra = w.__makeAgent(w.__CLOSED);
			await ra.prompt("droppable");
			const id = w.__snapshot(ra).queue[0].id;
			ra.removeQueued(id);
			return w.__snapshot(ra);
		});
		expect(r.outboxLen).toBe(0);
		expect(r.queue).toHaveLength(0);
		expect(r.sent).toHaveLength(0); // no remove_queued sent to server for a never-sent row
	});
});
