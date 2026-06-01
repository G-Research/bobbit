/**
 * S9 / WP5 — _pendingEvents overflow must re-baseline the seq gate.
 *
 * Drives the REAL RemoteAgent.handleServerMessage (bundled) — NOT the
 * hand-copied HTML fixture that omitted the overflow branch entirely
 * (02-analysis.md §4 P0). On master the overflow branch set _highestSeq=0 while
 * leaving _seqInitialized=true, so every later large-seq frame re-buffered as a
 * gap → the buffer refilled to the cap → overflow fired forever and live
 * streaming stalled until reload. The fix also clears _seqInitialized so the
 * next frame re-baselines. RED on master.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/remote-agent-seq.html");
const BUNDLE = path.resolve("tests/fixtures/remote-agent-seq-bundle.js");
const ENTRY = path.resolve("tests/fixtures/remote-agent-seq-entry.ts");
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
const ev = (seq: number) => ({
	type: "event",
	seq,
	ts: 0,
	data: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
});

test("overflow clears _seqInitialized and the next live frame re-baselines (no permanent stall)", async ({ page }) => {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });

	const result = await page.evaluate(async (frames) => {
		const w = window as any;
		const ra = w.__makeAgent();
		// Baseline on seq 1.
		await w.__feed(ra, frames.first);
		// 501 out-of-order frames (gap at seq 2) → overflow the 500-cap buffer.
		for (const f of frames.gap) await w.__feed(ra, f);
		const afterOverflow = w.__seqState(ra);
		// A fresh live frame at a large seq AFTER the overflow.
		await w.__feed(ra, frames.next);
		const afterNext = w.__seqState(ra);
		return { afterOverflow, afterNext };
	}, {
		first: ev(1),
		gap: Array.from({ length: 501 }, (_, i) => ev(i + 3)), // seqs 3..503
		next: ev(504),
	});

	// After overflow: re-baseline armed, snapshot requested.
	expect(result.afterOverflow.highestSeq).toBe(0);
	expect(result.afterOverflow.seqInitialized).toBe(false); // the S9 fix (true on master)
	expect(result.afterOverflow.getMessagesSent).toBeGreaterThan(0);

	// After the next frame: re-baselined to seq-1 and DISPATCHED (highestSeq=504),
	// not re-gap-buffered (which on master leaves highestSeq=0, pending>0).
	expect(result.afterNext.highestSeq).toBe(504);
	expect(result.afterNext.pending).toBe(0);
});
