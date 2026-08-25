/**
 * BeatRecorder — explicit, labeled UX-moment screenshot capture for Tier 2.5
 * browser E2E tests.
 *
 * Each `capture(label)` call writes one PNG (4-digit zero-padded so ffmpeg's
 * `%04d.png` glob works) to `<testInfo.outputDir>/beats/`, and appends a
 * `BeatRecord` to an in-memory list. `flush()` writes the list as JSONL to
 * `<testInfo.outputDir>/beats.jsonl` — this is the artifact the
 * `tier-2-5-reporter.ts` reporter walks at end-of-run to encode videos and
 * thumbnails.
 *
 * Off-switch: when `process.env.RECORDSCREEN !== "1"`, every method returns
 * immediately with **zero** filesystem activity. This is the "zero cost
 * when off" guarantee — tests that import the fixture but run without
 * `RECORDSCREEN=1` see no perf or artifact difference vs current master.
 *
 * Ported from `tests/prototype/scenario-runner.spec.ts::class BeatRecorder`,
 * with the `Scenario` coupling stripped (testInfo.outputDir is the new
 * namespace key) and the report-builder methods moved to the reporter.
 */
import type { Page, TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BeatRecord {
	idx: number;
	label: string;
	/** Date.now() at capture. */
	ts: number;
	/** Absolute path to the PNG on disk. */
	png: string;
	/** ms since the BeatRecorder was constructed. */
	ms: number;
}

const RECORDSCREEN_ON = process.env.RECORDSCREEN === "1";

export class BeatRecorder {
	private readonly page: Page;
	private readonly testInfo: TestInfo;
	private readonly beatsDir: string;
	private readonly start: number;
	private readonly beats: BeatRecord[] = [];
	private dirEnsured = false;

	constructor(page: Page, testInfo: TestInfo) {
		this.page = page;
		this.testInfo = testInfo;
		this.beatsDir = join(testInfo.outputDir, "beats");
		this.start = Date.now();
	}

	/**
	 * Capture one labeled beat — viewport screenshot, no fullPage. Wrapped in
	 * try/catch (page may be navigating mid-test); silently skips on error,
	 * mirroring the prototype's behaviour.
	 *
	 * No-op when RECORDSCREEN !== "1".
	 */
	async capture(label: string): Promise<void> {
		if (!RECORDSCREEN_ON) return;
		const idx = this.beats.length;
		const stem = String(idx).padStart(4, "0");
		const png = join(this.beatsDir, `${stem}.png`);
		try {
			if (!this.dirEnsured) {
				mkdirSync(this.beatsDir, { recursive: true });
				this.dirEnsured = true;
			}
			await this.page.screenshot({ path: png, fullPage: false });
		} catch {
			// Page navigating / closed / detached — skip this beat silently.
			return;
		}
		this.beats.push({
			idx,
			label,
			ts: Date.now(),
			png,
			ms: Date.now() - this.start,
		});
	}

	/**
	 * Write the in-memory beat list as JSONL to
	 * `<testInfo.outputDir>/beats.jsonl`. Auto-called by the fixture teardown
	 * in `fixtures.ts`.
	 *
	 * No-op when RECORDSCREEN !== "1" or when no beats were captured.
	 */
	async flush(): Promise<void> {
		if (!RECORDSCREEN_ON) return;
		if (this.beats.length === 0) return;
		const jsonlPath = join(this.testInfo.outputDir, "beats.jsonl");
		const body = this.beats.map((b) => JSON.stringify(b)).join("\n") + "\n";
		try {
			writeFileSync(jsonlPath, body, "utf-8");
		} catch (err) {
			// Don't fail the test for an artifact-write error; just log.
			// eslint-disable-next-line no-console
			console.warn(`[tier-2-5] BeatRecorder.flush failed: ${(err as Error).message}`);
		}
	}

	/** Test-only accessor — mainly useful for unit-level introspection. */
	get count(): number {
		return this.beats.length;
	}
}
