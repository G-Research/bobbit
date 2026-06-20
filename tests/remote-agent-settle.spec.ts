/**
 * Stranded-optimistic settle wiring — pins that the REAL RemoteAgent dispatches
 * the turn-end settle on BOTH termination paths (`case "error"` in
 * handleServerMessage and `case "agent_end"` in handleAgentEvent), so an
 * unreconciled optimistic prompt does not stay stranded at the far-future tail
 * sentinel after the turn ends. Drives the bundled production handlers with a
 * stub transport (no real socket).
 *
 * RED before the fix: neither handler re-stamps the optimistic row, so it stays
 * at the sentinel (`order > floor`) and the `toBeLessThan(floor)` assertions
 * fail. GREEN after: both handlers settle it (`order < floor`) while keeping it
 * visible. The assertions are mechanism-agnostic — they pin the observable
 * settle behaviour, not a specific action name.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/remote-agent-settle.html");
const BUNDLE = path.resolve("tests/fixtures/remote-agent-settle-bundle.js");
const ENTRY = path.resolve("tests/fixtures/remote-agent-settle-entry.ts");
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
	await page.goto(PAGE, { waitUntil: "load" });
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 30_000 });
}

test.describe("RemoteAgent settles optimistic rows on turn termination", () => {
	test("error handler settles an unreconciled optimistic prompt out of the tail sentinel", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			const ra = w.__makeAgent();
			w.__seedOptimistic(ra, "optimistic_err", "hello");
			const before = w.__optimisticRows(ra);
			await w.__triggerError(ra);
			const after = w.__optimisticRows(ra);
			return { before, after, floor: w.__SENTINEL_FLOOR };
		});
		// Seeded at the far-future tail sentinel.
		expect(r.before).toHaveLength(1);
		expect(r.before[0].order).toBeGreaterThan(r.floor);
		// After the error turn ends: still present (visible) AND settled below the sentinel.
		expect(r.after).toHaveLength(1);
		expect(r.after[0].id).toBe("optimistic_err");
		expect(r.after[0].order).toBeLessThan(r.floor);
	});

	test("agent_end handler settles an unreconciled optimistic prompt out of the tail sentinel", async ({ page }) => {
		await ready(page);
		const r = await page.evaluate(async () => {
			const w = window as any;
			const ra = w.__makeAgent();
			w.__seedOptimistic(ra, "optimistic_end", "hello");
			const before = w.__optimisticRows(ra);
			w.__triggerAgentEnd(ra);
			const after = w.__optimisticRows(ra);
			return { before, after, floor: w.__SENTINEL_FLOOR };
		});
		expect(r.before).toHaveLength(1);
		expect(r.before[0].order).toBeGreaterThan(r.floor);
		expect(r.after).toHaveLength(1);
		expect(r.after[0].id).toBe("optimistic_end");
		expect(r.after[0].order).toBeLessThan(r.floor);
	});
});
