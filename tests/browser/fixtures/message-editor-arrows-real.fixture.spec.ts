/**
 * Composer caret-row geometry — REPRODUCING regression coverage for the
 * "ArrowUp recalls history one press too early" bug.
 *
 * WHY THIS TIER: the defect is a pure CSS-layout fact — a trailing newline in
 * `white-space: pre-wrap` content generates no extra line box, so a mirror
 * <div>'s offsetHeight under-counts the caret's row by one whenever the caret
 * sits at column 0 of a line that is not the first. happy-dom has NO layout
 * engine (offsetHeight is always 0), and tests2/dom/message-editor-arrows.test.ts
 * substitutes a row model that is MORE correct than the real browser — so the
 * bug is structurally invisible below Chromium. This spec bundles the REAL
 * src/ui/components/MessageEditor.ts and drives it in Chromium.
 *
 * TWO DEFECTS ARE COVERED:
 *   D1 trailing-newline collapse — affects both predicates.
 *   D2 the bottom-row inequality leaks the mirror's padding, so a row delta of
 *      1 (the penultimate row) also satisfies it.
 *
 * MECHANICS THAT ARE LOAD-BEARING (do not "simplify" these):
 *   - Every end-to-end scenario uses Playwright key presses. A synthetic
 *     `dispatchEvent(new KeyboardEvent(...))` is untrusted: Shift+Enter would
 *     insert no newline and ArrowUp would not move the caret, so the repro
 *     cannot be driven that way.
 *   - History is built through the PRODUCTION send path (Enter -> handleSend ->
 *     addToHistory) and then awaited: addToHistory is async and fire-and-forget.
 *   - `CommandHistoryStore.addEntry` persists `text.trim()`, so history entries
 *     can never carry leading/trailing newlines. The trailing-newline geometry
 *     cases are therefore asserted at PREDICATE level, not via the send path.
 *
 * EXPECTED-VALUE AUTHORITY: a caret at offset `p` is on visual row
 * `1 + (hard/soft breaks before p)`; "top row" is true iff that row is row 1 and
 * "bottom row" iff it is the last row. NOTE: the issue-analysis truth table
 * prints `top row? = no` for `"Hello\n\n"@5`, `"Hello\n\n"@6`... and `"Hello\n"@5`
 * in its *top* column; for the @5 entries that contradicts both the same table's
 * own "caret row = 1 / 3" column and the stated fix
 * (`|caretTop - firstTop| < rowHeight/2`). Row 1 => top row is TRUE. We assert
 * the semantics, which is what the fix implements.
 *
 * Every assertion message is prefixed `CARET-ROW REGRESSION:` so the gate's
 * error_pattern can match this spec's failures and nothing else.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "../../support/helpers/browser/fixtures/fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/message-editor-arrows-real.html");
const BUNDLE = path.resolve("tests/fixtures/message-editor-arrows-real-bundle.js");
const ENTRY = path.resolve("tests/fixtures/message-editor-arrows-real-entry.ts");
const SRC = path.resolve("src/ui/components/MessageEditor.ts");
const PAGE = `file://${FIXTURE}`;

const TAG = "CARET-ROW REGRESSION:";

interface BoxOverride {
	widthPx?: number;
	fontSizePx?: number;
	lineHeight?: string;
	heightPx?: number;
	fontFamily?: string;
}

interface EditorState {
	value: string;
	textareaValue: string;
	selectionStart: number;
	historyIndex: number;
	history: string[];
	liveDraft: string;
}

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, SRC] });
});

async function mount(page: Page, sessionId: string, box?: BoxOverride) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 15_000 });
	await page.evaluate(
		([s, b]) => (window as any).__mount(s, b),
		[sessionId, box ?? null] as [string, BoxOverride | null],
	);
	return page.locator("message-editor textarea");
}

const state = (page: Page): Promise<EditorState> => page.evaluate(() => (window as any).__state());
/** Flush Lit so `live(this.value)` has re-synced the textarea before the next key. */
const settle = (page: Page): Promise<void> => page.evaluate(() => (window as any).__settle());
const setValueAndCaret = (page: Page, value: string, pos: number) =>
	page.evaluate(([v, p]) => (window as any).__setValueAndCaret(v, p), [value, pos] as [string, number]);
const setCaret = (page: Page, pos: number): Promise<number> =>
	page.evaluate((p) => (window as any).__setCaret(p), pos);
const predicates = (page: Page, value: string, pos: number): Promise<{ top: boolean; bottom: boolean }> =>
	page.evaluate(([v, p]) => (window as any).__predicates(v, p), [value, pos] as [string, number]);

/** Type `text` with real keystrokes, using Shift+Enter for embedded newlines. */
async function typeMultiline(page: Page, ta: ReturnType<Page["locator"]>, text: string) {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) {
			await ta.press("Shift+Enter");
			await settle(page);
		}
		if (lines[i]) await ta.pressSequentially(lines[i]);
	}
	await settle(page);
}

/** Send `text` through the real send path and wait for addToHistory to land. */
async function sendThroughRealPath(page: Page, ta: ReturnType<Page["locator"]>, text: string) {
	await ta.click();
	await typeMultiline(page, ta, text);
	await ta.press("Enter");
	await page.waitForFunction(
		(t) => ((window as any).__state().history as string[]).includes(t),
		text,
		{ timeout: 10_000 },
	);
	await settle(page);
}

async function press(page: Page, ta: ReturnType<Page["locator"]>, key: string) {
	await ta.press(key);
	await settle(page);
}

// ---------------------------------------------------------------------------

test.describe("MessageEditor caret-row geometry (composer history recall)", () => {
	// -- Scenario 1 ---------------------------------------------------------
	test("S1: ArrowUp at column 0 of line 2 moves the caret instead of recalling history", async ({ page }) => {
		const ta = await mount(page, "s1");
		await sendThroughRealPath(page, ta, "seed message");

		await ta.click();
		await ta.pressSequentially("Hello");
		await settle(page);
		await press(page, ta, "Home");
		await press(page, ta, "Shift+Enter");
		await press(page, ta, "Shift+Enter");

		const built = await state(page);
		expect(built.value, `${TAG} fixture precondition — Shift+Enter must build the repro buffer`).toBe("\n\nHello");
		expect(built.selectionStart, `${TAG} fixture precondition — caret must sit at offset 2`).toBe(2);
		expect(built.historyIndex).toBe(-1);

		// Press 1: offset 2 (row 3, col 0) -> offset 1 (row 2, col 0). Correct today.
		await press(page, ta, "ArrowUp");
		const after1 = await state(page);
		expect(after1.value, `${TAG} first ArrowUp must move the caret, not recall history`).toBe("\n\nHello");
		expect(after1.selectionStart, `${TAG} first ArrowUp must land on the blank line 2 (offset 1)`).toBe(1);
		expect(after1.historyIndex).toBe(-1);

		// Press 2: offset 1 (row 2, col 0) -> offset 0. THE BUG: the prefix "\n"
		// collapses to one line box, so the caret is misread as being on the top row.
		await press(page, ta, "ArrowUp");
		const after2 = await state(page);
		expect(after2.value, `${TAG} ArrowUp at column 0 of line 2 must move the caret, not recall history`).toBe("\n\nHello");
		expect(after2.historyIndex, `${TAG} ArrowUp at column 0 of line 2 must not enter history browsing`).toBe(-1);
		expect(after2.selectionStart, `${TAG} second ArrowUp must land on the blank line 1 (offset 0)`).toBe(0);
	});

	// -- Scenario 2 ---------------------------------------------------------
	test("S2: history recall still works — third ArrowUp from offset 0 recalls, ArrowDown restores the draft", async ({ page }) => {
		const ta = await mount(page, "s2");
		await sendThroughRealPath(page, ta, "seed message");

		await ta.click();
		await ta.pressSequentially("Hello");
		await settle(page);
		await press(page, ta, "Home");
		await press(page, ta, "Shift+Enter");
		await press(page, ta, "Shift+Enter");
		await press(page, ta, "ArrowUp");
		await press(page, ta, "ArrowUp");
		// Caret is now at offset 0 (post-fix) — force it there so this test is a
		// pure feature check and cannot be a second copy of S1's failure.
		await setCaret(page, 0);

		await press(page, ta, "ArrowUp");
		const recalled = await state(page);
		expect(recalled.value, `${TAG} ArrowUp from offset 0 must recall the newest history entry`).toBe("seed message");
		expect(recalled.historyIndex, `${TAG} ArrowUp from offset 0 must enter history browsing`).toBe(0);
		expect(recalled.liveDraft, `${TAG} entering history must retain the live draft`).toBe("\n\nHello");

		await setCaret(page, recalled.textareaValue.length);
		await press(page, ta, "ArrowDown");
		const restored = await state(page);
		expect(restored.value, `${TAG} ArrowDown past the newest entry must restore the draft`).toBe("\n\nHello");
		expect(restored.historyIndex, `${TAG} restoring the draft must leave history browsing`).toBe(-1);
	});

	// -- Scenario 3 ---------------------------------------------------------
	test("S3: 'abc\\ndef' with the caret before 'd' — ArrowUp moves the caret, no recall", async ({ page }) => {
		const ta = await mount(page, "s3");
		await sendThroughRealPath(page, ta, "seed message");

		await setValueAndCaret(page, "abc\ndef", 4);
		await press(page, ta, "ArrowUp");
		const after = await state(page);
		expect(after.value, `${TAG} ArrowUp at column 0 of line 2 of "abc\\ndef" must not recall history`).toBe("abc\ndef");
		expect(after.historyIndex, `${TAG} ArrowUp at column 0 of line 2 of "abc\\ndef" must not enter history browsing`).toBe(-1);
		expect(after.selectionStart, `${TAG} ArrowUp from offset 4 must move to line 1`).toBe(0);
	});

	// -- Scenario 4 (D2) ----------------------------------------------------
	// User-reachable ArrowDown repro: the branch only runs while a history entry
	// is displayed, and the store trims, so the entry must carry INTERIOR
	// newlines. Offset 6 is deliberately NOT used: there D1 and D2 cancel and the
	// legacy code is accidentally right.
	for (const offset of [8, 11]) {
		test(`S4: ArrowDown on the penultimate row (offset ${offset}) moves the caret instead of leaving history`, async ({ page }) => {
			const ta = await mount(page, `s4-${offset}`);
			await sendThroughRealPath(page, ta, "line1\nline2\nline3");

			const before = await state(page);
			expect(before.value, `${TAG} fixture precondition — composer must be cleared by send`).toBe("");
			expect(before.history, `${TAG} fixture precondition — the multi-line entry must reach history verbatim`)
				.toEqual(["line1\nline2\nline3"]);

			await ta.click();
			await press(page, ta, "ArrowUp");
			const displayed = await state(page);
			expect(displayed.value, `${TAG} ArrowUp from an empty composer must display the history entry`).toBe("line1\nline2\nline3");
			expect(displayed.historyIndex).toBe(0);

			await setCaret(page, offset);
			await press(page, ta, "ArrowDown");
			const after = await state(page);
			expect(after.value, `${TAG} ArrowDown on the penultimate row must move the caret, not leave history`).toBe("line1\nline2\nline3");
			expect(after.historyIndex, `${TAG} ArrowDown on the penultimate row must stay in history browsing`).toBe(0);
			expect(after.selectionStart, `${TAG} ArrowDown on the penultimate row must move the caret onto line 3`).toBeGreaterThan(11);
		});
	}

	test("S4b: ArrowDown from the last row still leaves history and restores the draft", async ({ page }) => {
		const ta = await mount(page, "s4b");
		await sendThroughRealPath(page, ta, "line1\nline2\nline3");
		await ta.click();
		await press(page, ta, "ArrowUp");
		await setCaret(page, 12); // column 0 of the LAST row
		await press(page, ta, "ArrowDown");
		const after = await state(page);
		expect(after.value, `${TAG} ArrowDown at column 0 of the last row must restore the draft`).toBe("");
		expect(after.historyIndex, `${TAG} ArrowDown at column 0 of the last row must leave history browsing`).toBe(-1);
	});

	// -- Scenario 5 ---------------------------------------------------------
	// Predicate-level truth table. Trailing-newline values are unreachable through
	// the trimming store, so these exercise the production predicates directly.
	test("S5: production top/bottom row predicates match the visual-row truth table", async ({ page }) => {
		await mount(page, "s5");

		const table: Array<[value: string, pos: number, top: boolean, bottom: boolean]> = [
			// leading newlines — D1
			["\n\nHello", 0, true, false],
			["\n\nHello", 1, false, false],
			["\n\nHello", 2, false, true],
			["\n\nHello", 7, false, true],
			// trailing newlines — D1 on fullHeight (unreachable via the send path)
			["Hello\n\n", 5, true, false],
			["Hello\n\n", 6, false, false],
			["Hello\n\n", 7, false, true],
			["Hello\n", 5, true, false],
			["Hello\n", 6, false, true],
			// interior newline
			["abc\ndef", 4, false, true],
			// penultimate row — D2
			["line1\nline2\nline3", 6, false, false],
			["line1\nline2\nline3", 8, false, false],
			["line1\nline2\nline3", 11, false, false],
			["line1\nline2\nline3", 12, false, true],
		];

		const actual: string[] = [];
		const expected: string[] = [];
		for (const [value, pos, top, bottom] of table) {
			const got = await predicates(page, value, pos);
			const label = `${JSON.stringify(value)} @${pos}`;
			actual.push(`${label} top=${got.top} bottom=${got.bottom}`);
			expected.push(`${label} top=${top} bottom=${bottom}`);
		}
		expect(actual, `${TAG} visual-row predicate truth table mismatch`).toEqual(expected);
	});

	// -- Scenario 6 ---------------------------------------------------------
	// Soft-wrap boundary, decided by an INDEPENDENT oracle (Range.getClientRects
	// over one unsplit text node in a separately-styled plain div) and
	// cross-checked against the browser's own caret movement. This is the check
	// that a marker/sentinel-based fix has not shifted wrap points.
	//
	// Offset === boundary IS asserted (it used to be skipped as affinity-dependent):
	// at an exact soft-wrap point one offset maps to two caret positions and
	// Chromium resolves it by an affinity the DOM cannot observe, so the production
	// rule refuses to guess — a position counts as the top (bottom) row only when
	// BOTH readings agree, which at a boundary they never do. Expected value there is
	// therefore deterministic: top === false AND bottom === false, i.e. the key moves
	// the caret and never mutates history.
	test("S6: soft-wrap boundary — first wrap segment is the top row, later segments are not", async ({ page }) => {
		const ta = await mount(page, "s6");
		const long = "abcdefghij".repeat(20);

		const boundary: number = await page.evaluate((v) => (window as any).__oracleFirstWrapOffset(v), long);
		expect(boundary, `${TAG} oracle must find a soft-wrap boundary in the fixed-width textarea`).toBeGreaterThan(1);
		expect(boundary, `${TAG} oracle wrap boundary must be inside the value`).toBeLessThan(long.length - 2);

		// Independent cross-check #1: native caret movement, history EMPTY so the
		// predicate cannot fire and only the browser decides.
		await setValueAndCaret(page, long, boundary - 1);
		await press(page, ta, "ArrowUp");
		let nat = await state(page);
		expect(nat.value, `${TAG} sanity — no history, so ArrowUp must never change the value`).toBe(long);
		expect(nat.selectionStart, `${TAG} native ArrowUp from inside the first wrap segment must go to offset 0`).toBe(0);

		await setValueAndCaret(page, long, boundary + 1);
		await press(page, ta, "ArrowUp");
		nat = await state(page);
		expect(nat.selectionStart, `${TAG} native ArrowUp from the second wrap segment must stay inside the first row`)
			.toBeGreaterThan(0);
		expect(nat.selectionStart, `${TAG} native ArrowUp from the second wrap segment must stay inside the first row`)
			.toBeLessThan(boundary);

		// Diagnostic only (see the affinity note above): End from `boundary` lands on
		// the end of whichever row Chromium put the caret on.
		await setValueAndCaret(page, long, boundary);
		await press(page, ta, "End");
		const affinity = (await state(page)).selectionStart;
		console.log(`[S6] wrap boundary = ${boundary}; End from @${boundary} -> ${affinity} (row ${affinity === boundary ? 1 : 2} affinity)`);

		// Production predicate either side of the boundary.
		const beforeBoundary = await predicates(page, long, boundary - 1);
		expect(beforeBoundary.top, `${TAG} caret inside the first wrap segment must count as the top row`).toBe(true);
		const afterBoundary = await predicates(page, long, boundary + 1);
		expect(afterBoundary.top, `${TAG} caret in the second wrap segment must NOT count as the top row`).toBe(false);

		// AT the boundary: ambiguous, so neither predicate may fire.
		const atBoundary = await predicates(page, long, boundary);
		expect(atBoundary.top, `${TAG} at an exact soft-wrap boundary the top-row predicate must not fire`).toBe(false);
		expect(atBoundary.bottom, `${TAG} at an exact soft-wrap boundary the bottom-row predicate must not fire`).toBe(false);

		// Same rule at the FINAL wrap boundary (the ArrowDown mirror).
		const rowIdx: number[] = await page.evaluate((v) => (window as any).__oracleRowIndexes(v), long);
		const lastRow = Math.max(...rowIdx);
		const lastBoundary = rowIdx.indexOf(lastRow);
		expect(lastBoundary, `${TAG} oracle must find the final wrap boundary`).toBeGreaterThan(boundary);
		const atLastBoundary = await predicates(page, long, lastBoundary);
		expect(atLastBoundary.bottom, `${TAG} at the final soft-wrap boundary the bottom-row predicate must not fire`).toBe(false);
		expect(atLastBoundary.top, `${TAG} the final soft-wrap boundary is not the top row`).toBe(false);
		const insideLastRow = await predicates(page, long, lastBoundary + 1);
		expect(insideLastRow.bottom, `${TAG} caret inside the last wrap segment must count as the bottom row`).toBe(true);

		// Behavioural mirror of the same two points, with history present.
		await setValueAndCaret(page, "", 0);
		await sendThroughRealPath(page, ta, "wrap seed");
		await setValueAndCaret(page, long, boundary + 1);
		await press(page, ta, "ArrowUp");
		const later = await state(page);
		expect(later.value, `${TAG} ArrowUp from the second wrap segment must not recall history`).toBe(long);
		expect(later.historyIndex, `${TAG} ArrowUp from the second wrap segment must not enter history browsing`).toBe(-1);

		await setValueAndCaret(page, long, boundary - 1);
		await press(page, ta, "ArrowUp");
		const first = await state(page);
		expect(first.value, `${TAG} ArrowUp from inside the first wrap segment must still recall history`).toBe("wrap seed");
	});

	// -- Scenario 7 ---------------------------------------------------------
	// Long value (hard newlines + soft wraps, >= 10 rows) at a FRACTIONAL line
	// height (13px * 1.35 = 17.55px). Pins that row identification does not drift
	// on long content and does not depend on integer offsetHeight arithmetic.
	test("S7: long mixed value at a fractional line height — top row only on row 1, bottom row only on the last", async ({ page }) => {
		await mount(page, "s7", { widthPx: 320, fontSizePx: 13, lineHeight: "1.35", heightPx: 700 });

		const lineHeight = await page.evaluate(() => getComputedStyle((window as any).__textarea()).lineHeight);
		expect(lineHeight, `${TAG} fixture precondition — line height must be fractional`).toBe("17.55px");

		const value = [
			"abcdefghij".repeat(9), // soft-wraps several times
			"short",
			"",
			"klmnopqrst".repeat(6), // soft-wraps
			"another short line",
			"",
			"uvwxyzabcd".repeat(4),
		].join("\n");

		const rowIdx: number[] = await page.evaluate((v) => (window as any).__oracleRowIndexes(v), value);
		const lastRow = Math.max(...rowIdx);
		expect(lastRow + 1, `${TAG} fixture precondition — scenario 7 needs >= 10 visual rows`).toBeGreaterThanOrEqual(10);

		// Skip exact soft-wrap boundaries: ambiguous caret affinity (see S6).
		const softBoundary = new Set<number>();
		for (let i = 1; i < rowIdx.length; i++) {
			if (rowIdx[i] > rowIdx[i - 1] && value[i - 1] !== "\n") softBoundary.add(i);
		}

		// Sample: the first offset of every row plus a mid-row offset, so every row
		// is represented including the column-0-after-a-newline cases.
		const sample: number[] = [];
		for (let i = 0; i < rowIdx.length; i++) {
			const isRowStart = i === 0 || rowIdx[i] > rowIdx[i - 1];
			if ((isRowStart || i % 11 === 0) && !softBoundary.has(i)) sample.push(i);
		}
		sample.push(value.length); // end of buffer — must be the bottom row
		expect(sample.length).toBeGreaterThan(10);

		const actual: string[] = [];
		const expected: string[] = [];
		for (const pos of sample) {
			const row = pos >= rowIdx.length ? lastRow : rowIdx[pos];
			const got = await predicates(page, value, pos);
			actual.push(`@${pos}(row ${row}) top=${got.top} bottom=${got.bottom}`);
			expected.push(`@${pos}(row ${row}) top=${row === 0} bottom=${row === lastRow}`);
		}
		expect(actual, `${TAG} long fractional-line-height row identification drifted`).toEqual(expected);
	});

	// -- Scenario 8 ---------------------------------------------------------
	// WIDTH x FONT x CONTENT SWEEP against the independent oracle.
	//
	// WHY THIS EXISTS: S6 pins exactly one 320px monospace layout, and a
	// caret-row implementation that inserts a marker INTO the measured text splits
	// the text node, which can move a `break-word` soft-wrap point. That made the
	// caret marker lay out at the end of the PREVIOUS row and
	// `_isCursorOnVisualTopRow()` return true one row too early — the original
	// user-visible bug, for wrapped content — at many widths (the reviewer saw it at
	// 257/266/276/286/296/306/316/326px) while S6's single width stayed green.
	// Therefore: sweep widths, both a PROPORTIONAL production font stack and a
	// monospace one, and both unbroken break-word text and space-wrapped prose.
	//
	// Oracle: Range.getClientRects() over ONE UNSPLIT text node in a plain div
	// styled from the textarea's computed style (no component code). Exact soft-wrap
	// boundary offsets ARE included: the production rule makes them deterministic
	// (neither top nor bottom fires when the caret's two row readings disagree), so
	// the sweep asserts top === false && bottom === false at every boundary and the
	// oracle's row identity everywhere else. Both predicates are swept.
	const SWEEP_FONTS: Array<[label: string, stack: string]> = [
		["production proportional", "ui-sans-serif, system-ui, sans-serif"],
		["monospace", "ui-monospace, SFMono-Regular, Menlo, monospace"],
	];
	const SWEEP_CONTENTS: Array<[label: string, value: string]> = [
		// No break opportunity anywhere: every wrap is a `break-word` mid-"word" break,
		// which is exactly where splitting the measured text shifts the wrap point.
		["break-word AV x100", "AV".repeat(100)],
		// Wraps at spaces instead, so the two wrap mechanisms are both covered.
		["space-separated prose", Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")],
	];
	// Every pixel in 240..340: the defect only shows at widths where splitting the
	// measured text happens to move the break, so a coarse grid can miss it entirely
	// (a 5px grid misses the reviewer's 257/266/276/286/296/306/316/326px).
	const SWEEP_WIDTHS = Array.from({ length: 101 }, (_, i) => 240 + i);

	for (const [fontLabel, fontFamily] of SWEEP_FONTS) {
		test(`S8: top-row predicate agrees with the wrap oracle at every width 240-340px (${fontLabel})`, async ({ page }) => {
			await mount(page, `s8-${fontLabel.replace(/\s+/g, "-")}`, { fontFamily });

			const failures: string[] = [];
			let totalChecked = 0;
			let totalBoundaries = 0;
			const boundarySets = new Set<string>();

			for (const widthPx of SWEEP_WIDTHS) {
				await page.evaluate(
					([w, f]) => (window as any).__applyBox({ widthPx: w, fontFamily: f }),
					[widthPx, fontFamily] as [number, string],
				);
				for (const [contentLabel, value] of SWEEP_CONTENTS) {
					const res = await page.evaluate(
						(v) => (window as any).__sweepTopRow(v, 3),
						value,
					);
					const where = `${widthPx}px / ${fontLabel} / ${contentLabel}`;
					expect(res.clientWidth, `${TAG} sweep precondition — textarea width must be pinned at ${widthPx}px`).toBe(widthPx);
					expect(res.rowCount, `${TAG} sweep precondition — ${where} must wrap onto several rows`).toBeGreaterThanOrEqual(3);
					expect(res.checked, `${TAG} sweep precondition — ${where} must probe some offsets`).toBeGreaterThan(0);
					totalChecked += res.checked;
					totalBoundaries += res.boundariesChecked;
					boundarySets.add(`${contentLabel}:${res.boundaries.join(",")}`);
					for (const m of res.mismatches) {
						failures.push(
							`${where} @${m.pos} [${m.which}]: oracle row ${m.oracleRow} => should be ${m.expected}, predicate said ${m.got}` +
							` (row boundaries ${res.boundaries.join(",")})`,
						);
					}
				}
			}

			// The sweep is only meaningful if the widths actually moved the wrap points.
			expect(boundarySets.size, `${TAG} sweep precondition — widths must produce distinct wrap layouts`).toBeGreaterThan(SWEEP_CONTENTS.length * 5);
			expect(totalChecked, `${TAG} sweep precondition — too few offsets probed to be meaningful`).toBeGreaterThan(2000);
			expect(totalBoundaries, `${TAG} sweep precondition — exact wrap boundaries must be probed, not skipped`).toBeGreaterThan(500);
			expect(failures, `${TAG} top-row predicate disagreed with the wrap oracle`).toEqual([]);
		});
	}

	// -- Scenario 9 ---------------------------------------------------------
	// The reviewer's verified repro: 316px, the production proportional stack,
	// "AV".repeat(100), one character past the oracle's first wrap boundary. This
	// is NOT the ambiguous exact-boundary offset: both adjacent characters are on
	// the second visual row, and native ArrowUp with an empty history proves the
	// caret was not on the first row. The exact boundary is platform/font dependent
	// (for example, Windows Chromium and Linux Chromium choose different offsets),
	// so derive the repro position from the independent unsplit-Range oracle.
	test("S9: reviewer repro — 316px production font, AVx100, one character past the first wrap is NOT the top row", async ({ page }) => {
		const ta = await mount(page, "s9", { widthPx: 316, fontFamily: "ui-sans-serif, system-ui, sans-serif" });
		const value = "AV".repeat(100);
		const boundary: number = await page.evaluate((v) => (window as any).__oracleFirstWrapOffset(v), value);
		expect(boundary, `${TAG} S9 precondition — unsplit-Range oracle must find an interior first wrap boundary`)
			.toBeGreaterThan(1);
		expect(boundary, `${TAG} S9 precondition — unsplit-Range oracle must leave a character after the first wrap`)
			.toBeLessThan(value.length - 1);
		const POS = boundary + 1;

		const diag = await page.evaluate(
			([v, p]) => (window as any).__caretRowDiagnostic(v, p),
			[value, POS] as [string, number],
		);
		console.log(`[S9] reviewer repro diagnostic: ${JSON.stringify(diag)}`);

		expect(diag.clientWidth, `${TAG} S9 precondition — textarea client width must be 316px`).toBe(316);
		expect(diag.fontFamily, `${TAG} S9 precondition — must use the production proportional stack`)
			.toBe("ui-sans-serif, system-ui, sans-serif");
		expect(diag.firstWrapBoundary, `${TAG} S9 precondition — diagnostic must use the unsplit-Range first wrap boundary`)
			.toBe(boundary);
		expect(diag.oracleRowBefore, `${TAG} S9 precondition — character before offset ${POS} must be on the second visual row`).toBe(1);
		expect(diag.oracleRowAt, `${TAG} S9 precondition — character at offset ${POS} must be on the second visual row`).toBe(1);

		// Independent oracle: history EMPTY, so the predicate cannot fire and only
		// Chromium decides. Caret on row 1 => ArrowUp would land on offset 0.
		await setValueAndCaret(page, value, POS);
		await press(page, ta, "ArrowUp");
		const nat = await state(page);
		expect(nat.value, `${TAG} sanity — no history, so ArrowUp must never change the value`).toBe(value);
		expect(nat.selectionStart, `${TAG} native ArrowUp from offset ${POS} must stay inside the first row, proving the caret was on row 2`)
			.toBeGreaterThan(0);

		// The predicate must agree with the browser.
		expect(diag.caretRowsBelowFirst, `${TAG} reviewer repro — measured caret row must be one row below the first`).toBe(1);
		expect(diag.caretTopEqualsFirstTop, `${TAG} reviewer repro — caretTop must NOT equal firstTop at offset ${POS}`).toBe(false);
		expect(diag.top, `${TAG} reviewer repro — _isCursorOnVisualTopRow() must be false at 316px offset ${POS}`).toBe(false);

		// Behavioural mirror: with history present, ArrowUp must not replace the draft.
		await setValueAndCaret(page, "", 0);
		await sendThroughRealPath(page, ta, "reviewer seed");
		await setValueAndCaret(page, value, POS);
		await press(page, ta, "ArrowUp");
		const after = await state(page);
		expect(after.value, `${TAG} reviewer repro — ArrowUp at offset ${POS} must not recall history`).toBe(value);
		expect(after.historyIndex, `${TAG} reviewer repro — ArrowUp at offset ${POS} must not enter history browsing`).toBe(-1);
	});

	// -- Scenario 10 --------------------------------------------------------
	// THE REVIEWERS' `Home`-AT-A-WRAP-BOUNDARY REPRO, with real keys.
	//
	// `Home` is how a user actually reaches an exact soft-wrap boundary: Chromium
	// puts the caret at the boundary offset with DOWNSTREAM affinity, i.e. visually
	// at column 0 of the SECOND wrapped row. A predicate that reads only the
	// character BEFORE the caret sees row 1 and reports "top row", so ArrowUp
	// replaced a 200-character draft with a history entry — destructive and
	// unrecoverable. The two-reading rule must classify the boundary as neither row.
	test("S10: Home at the first wrap boundary — ArrowUp must not destroy the draft", async ({ page }) => {
		const ta = await mount(page, "s10");
		const long = "abcdefghij".repeat(20);

		const boundary: number = await page.evaluate((v) => (window as any).__oracleFirstWrapOffset(v), long);
		expect(boundary, `${TAG} S10 precondition — unsplit-Range oracle must find an interior first wrap boundary`)
			.toBeGreaterThan(1);
		expect(boundary, `${TAG} S10 precondition — unsplit-Range oracle must leave content after the first wrap`)
			.toBeLessThan(long.length - 2);

		await sendThroughRealPath(page, ta, "seed");
		const seeded = await state(page);
		expect(seeded.history, `${TAG} S10 precondition — history must be seeded through the real send path`).toEqual(["seed"]);

		// Caret just past the boundary, then REAL Home — Chromium lands exactly on the
		// boundary offset, visually column 0 of wrapped row 2.
		await setValueAndCaret(page, long, boundary + 1);
		await press(page, ta, "Home");
		const homed = await state(page);
		expect(homed.selectionStart, `${TAG} S10 precondition — real Home must put the caret at the wrap boundary`).toBe(boundary);
		expect(homed.value, `${TAG} S10 precondition — Home must not change the draft`).toBe(long);

		await press(page, ta, "ArrowUp");
		const after = await state(page);
		expect(after.value, `${TAG} ArrowUp after Home at a wrap boundary must not destroy the draft`).toBe(long);
		expect(after.historyIndex, `${TAG} ArrowUp after Home at a wrap boundary must not enter history browsing`).toBe(-1);
		expect(after.liveDraft, `${TAG} ArrowUp after Home at a wrap boundary must not retain a live draft`).toBe("");
		expect(after.selectionStart, `${TAG} ArrowUp after Home at a wrap boundary must move the caret up instead`)
			.toBeLessThan(boundary);
	});

	// -- Scenario 11 --------------------------------------------------------
	// The ArrowDown mirror of S10, at the FINAL wrap boundary: `Home` there puts the
	// caret at column 0 of the last visual row, where a before-only reading reports
	// "not the bottom row" (and an after-only reading would report "bottom row" and
	// swap the displayed history entry). Two readings disagree => the caret moves and
	// the browsed entry is left alone.
	test("S11: Home at the final wrap boundary — ArrowDown must not swap the browsed history entry", async ({ page }) => {
		const ta = await mount(page, "s11");
		const long = "abcdefghij".repeat(20);

		await sendThroughRealPath(page, ta, "older entry");
		await sendThroughRealPath(page, ta, long);
		const seeded = await state(page);
		expect(seeded.history, `${TAG} S11 precondition — both entries must reach history via the real send path`)
			.toEqual(["older entry", long]);

		const rowIdx: number[] = await page.evaluate((v) => (window as any).__oracleRowIndexes(v), long);
		const lastBoundary = rowIdx.indexOf(Math.max(...rowIdx));
		expect(lastBoundary, `${TAG} S11 precondition — unsplit-Range oracle must find an interior final wrap boundary`)
			.toBeGreaterThan(1);
		expect(lastBoundary, `${TAG} S11 precondition — unsplit-Range oracle must leave a character after the final wrap`)
			.toBeLessThan(long.length - 1);

		// Browse into history: the newest entry is the wrapped 200-char value.
		await ta.click();
		await press(page, ta, "ArrowUp");
		const displayed = await state(page);
		expect(displayed.value, `${TAG} S11 precondition — ArrowUp must display the newest entry`).toBe(long);
		expect(displayed.historyIndex).toBe(1);

		// Caret just past the final boundary, then REAL Home -> column 0 of the last row.
		await setCaret(page, lastBoundary + 1);
		await press(page, ta, "Home");
		const homed = await state(page);
		expect(homed.selectionStart, `${TAG} S11 precondition — real Home must put the caret at the final wrap boundary`)
			.toBe(lastBoundary);

		await press(page, ta, "ArrowDown");
		const after = await state(page);
		expect(after.value, `${TAG} ArrowDown after Home at the final wrap boundary must not swap the browsed entry`).toBe(long);
		expect(after.historyIndex, `${TAG} ArrowDown after Home at the final wrap boundary must stay in history browsing`).toBe(1);
		expect(after.selectionStart, `${TAG} ArrowDown after Home at the final wrap boundary must move the caret instead`)
			.toBeGreaterThan(lastBoundary);
	});

	// -- Scenario 12 --------------------------------------------------------
	// PERFORMANCE BOUND. The predicates run SYNCHRONOUSLY inside the ArrowUp/
	// ArrowDown keydown handler, and a large text-only draft is valid (the send-size
	// guard only runs when attachments exist). The superseded implementation
	// collected a rect for every visual row and de-duplicated them with a growing
	// linear scan — O(rows^2) — and additionally re-scanned the whole value up to
	// three times per call. Measured on this fixture: 200 KB of short lines took
	// ~405 ms and a 500 KB wrapped line ~1.9 s per keypress (the reviewers measured
	// up to ~6 s), i.e. a hard main-thread freeze.
	//
	// The bound is deliberately generous (100 ms) — orders of magnitude above the
	// current cost and far below the regression — and is paired with a scaling
	// assertion so a merely-faster-but-still-superlinear implementation fails too.
	test("S12: caret-row predicates stay fast on very large drafts (no quadratic row scan)", async ({ page }) => {
		await mount(page, "s12");
		const BUDGET_MS = 100;

		const timeAt = (value: string, pos: number) =>
			page.evaluate(
				([v, p]) => (window as any).__timePredicates(v, p),
				[value, pos] as [string, number],
			) as Promise<{ top: boolean; bottom: boolean; topMs: number; bottomMs: number; totalMs: number; flushMs: number; length: number }>;

		// ~200 KB of many short lines: 100 K visual rows.
		const manyLines = "x\n".repeat(100_000);
		const lines = await timeAt(manyLines, Math.floor(manyLines.length / 2));
		console.log(`[S12] ${lines.length} chars / 100K short lines: top ${lines.topMs.toFixed(1)} ms, bottom ${lines.bottomMs.toFixed(1)} ms (page layout flush ${lines.flushMs.toFixed(1)} ms)`);
		expect(lines.top, `${TAG} S12 sanity — a caret in the middle of a 100K-line draft is not on the top row`).toBe(false);
		expect(lines.bottom, `${TAG} S12 sanity — a caret in the middle of a 100K-line draft is not on the bottom row`).toBe(false);
		expect(lines.totalMs, `${TAG} caret-row measurement must not freeze the keydown handler on a 200 KB many-line draft`)
			.toBeLessThan(BUDGET_MS);

		// ~50 KB and ~500 KB single wrapped lines: same shape, 10x the rows.
		const small = "abcdefghij".repeat(5_000);
		const huge = "abcdefghij".repeat(50_000);
		const smallTimed = await timeAt(small, Math.floor(small.length / 2));
		const hugeTimed = await timeAt(huge, Math.floor(huge.length / 2));
		console.log(
			`[S12] wrapped single line: 50 KB total ${smallTimed.totalMs.toFixed(1)} ms ` +
			`(top ${smallTimed.topMs.toFixed(1)}, bottom ${smallTimed.bottomMs.toFixed(1)}, flush ${smallTimed.flushMs.toFixed(1)}); ` +
			`500 KB total ${hugeTimed.totalMs.toFixed(1)} ms ` +
			`(top ${hugeTimed.topMs.toFixed(1)}, bottom ${hugeTimed.bottomMs.toFixed(1)}, flush ${hugeTimed.flushMs.toFixed(1)})`,
		);
		expect(hugeTimed.top, `${TAG} S12 sanity — a caret mid-way through a 500 KB wrapped line is not on the top row`).toBe(false);
		expect(hugeTimed.bottom, `${TAG} S12 sanity — a caret mid-way through a 500 KB wrapped line is not on the bottom row`).toBe(false);
		expect(hugeTimed.totalMs, `${TAG} caret-row measurement must not freeze the keydown handler on a 500 KB wrapped draft`)
			.toBeLessThan(BUDGET_MS);

		// Non-quadratic scaling: 10x the rows must not cost anywhere near 10x. The
		// floor keeps sub-millisecond baselines from making the ratio pure noise.
		const scalingCeiling = Math.max(smallTimed.totalMs * 5, 15);
		expect(hugeTimed.totalMs, `${TAG} caret-row measurement must scale sub-linearly in visual rows (50 KB took ${smallTimed.totalMs.toFixed(1)} ms)`)
			.toBeLessThan(scalingCeiling);
	});
});
