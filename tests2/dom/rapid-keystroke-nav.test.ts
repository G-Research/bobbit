import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/rapid-keystroke-nav.spec.ts (v2-dom tier).
// The legacy Playwright fixture reimplemented getActiveNavId in plain JS,
// parameterised buggy/fixed, to reproduce the dropped-keystroke bug
// (docs/perf/sidebar-nav-baseline.md §5.6). Here we drive the REAL
// getActiveNavId from src/app/sidebar-nav.ts inside a faithful keystroke
// scenario harness (higher fidelity — the bug lived in getActiveNavId itself).
//
// The legacy "buggy getActiveNavId drops keystrokes (sanity)" case is OMITTED:
// it validated the fixture's now-removed buggy code path, which has no
// production-code equivalent — the real getActiveNavId only ships the fixed
// behaviour. The fixed-behaviour cases below are pinned against real code, and
// the source-level regression guard (identical to the legacy one) is preserved.
//
// session-manager imported first (TDZ guard: it owns the session-manager⇄
// pack-panels cycle that sidebar-nav's connectToSession import pulls in);
// safe-markdown-block pre-imported so any lazy define resolves during the test.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import "../../src/app/session-manager.js";
import { getActiveNavId, navIdToHash } from "../../src/app/sidebar-nav.js";
import { state } from "../../src/app/state.js";
import "../../src/ui/lazy/safe-markdown-block.js";

const ORDER = ["session:L", "session:A", "session:B", "session:C", "session:D",
	"session:E", "session:F", "session:G", "session:H", "session:I",
	"session:J", "session:K"];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drives the REAL getActiveNavId through the rapid-Ctrl+↓ scenario. Mirrors the
 * production openForNavItem → async connectToSession → setHashRoute path: the
 * override is set synchronously, while the hash + selectedSessionId only catch
 * up after an async attach (L is slow at 200ms, others 5ms). A regression that
 * re-gated the override on `hash === expected` would fall back to the stale
 * selectedSessionId mid-attach and re-report the previous row → dropped
 * keystrokes; the fixed function trusts the override and advances one row/press.
 */
async function runScenario(presses: number, cadenceMs: number) {
	state.keyboardNavActiveId = null;
	state.selectedSessionId = null;
	window.location.hash = "#/";

	const opened: string[] = [];

	function openForNavItem(navId: string) {
		opened.push(navId);
		state.keyboardNavActiveId = navId;
		const id = navId.slice("session:".length);
		const delayMs = id === "L" ? 200 : 5;
		// Mimic async connectToSession → setHashRoute path.
		setTimeout(() => {
			window.location.hash = navIdToHash(navId) ?? "#/";
			state.selectedSessionId = id;
		}, delayMs);
	}

	function navigateDown() {
		const currentId = getActiveNavId();
		const idx = currentId ? ORDER.indexOf(currentId) : -1;
		const next = ORDER[idx < 0 || idx >= ORDER.length - 1 ? 0 : idx + 1];
		openForNavItem(next);
	}

	for (let i = 0; i < presses; i++) {
		navigateDown();
		await sleep(cadenceMs);
	}
	// Wait for any tail attaches to flush.
	await sleep(400);
	const uniqueOpened = [...new Set(opened)];
	return {
		opened,
		uniqueOpened,
		distinctCount: uniqueOpened.length,
		droppedKeystrokes: opened.length - uniqueOpened.length,
	};
}

afterEach(() => {
	state.keyboardNavActiveId = null;
	state.selectedSessionId = null;
	window.location.hash = "#/";
});

describe("rapid Ctrl+↓ keystroke navigation", () => {
	it("fixed getActiveNavId advances one row per keystroke even mid-attach", async () => {
		const result = await runScenario(6, 50);
		// Six presses, six distinct rows opened in order: L is the first
		// (cold-start, top of sidebar) and A…E follow even though L's
		// 200ms attach is still in flight at every subsequent keystroke.
		expect(result.droppedKeystrokes).toBe(0);
		expect(result.distinctCount).toBe(6);
		expect(result.opened).toEqual([
			"session:L", "session:A", "session:B",
			"session:C", "session:D", "session:E",
		]);
	});

	it("fixed getActiveNavId holds up at aggressive cadence and deeper walks", async () => {
		const result = await runScenario(10, 20);
		expect(result.droppedKeystrokes).toBe(0);
		expect(result.distinctCount).toBe(10);
		// First keystroke must land on L (cold-start, top of sidebar), the
		// row whose slow attach used to break navigation entirely.
		expect(result.opened[0]).toBe("session:L");
	});

	it("src/app/sidebar-nav.ts pins the override-trust fix", () => {
		const src = readFileSync(
			path.resolve("src/app/sidebar-nav.ts"),
			"utf8",
		);
		// Pull the body of getActiveNavId — everything up to the next
		// top-level export — and assert it doesn't reinstate the
		// hash-equality gate. A future refactor that reintroduces the
		// buggy guard will fail this test.
		const match = src.match(
			/export function getActiveNavId\(\)[\s\S]*?\n\}\n/,
		);
		expect(match, "getActiveNavId not found in src/app/sidebar-nav.ts").not.toBeNull();
		const body = match![0];
		expect(
			body,
			"getActiveNavId must not gate the override on `window.location.hash === expected` — see docs/perf/sidebar-nav-baseline.md §5.6",
		).not.toMatch(/window\.location\.hash\s*===\s*expected/);
	});
});
