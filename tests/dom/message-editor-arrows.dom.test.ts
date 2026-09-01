// Ported from tests/message-editor-arrows.spec.ts (+ message-editor-arrows.html)
// (v2-dom tier).
//
// The legacy spec drove a STANDALONE HTML fixture (tests/message-editor-arrows.html)
// — not the real component. That fixture reproduced MessageEditor's visual-row
// history-recall logic in plain JS and, in a real (Playwright) browser, decided
// "cursor on the visual top/bottom row" by measuring a mirror <div>'s
// offsetHeight against the narrow (100px) wrapping textarea.
//
// happy-dom has no layout engine (offsetHeight is always 0), so — following the
// established v2-dom convention for standalone HTML fixtures (see
// dom/mobile-archived.test.ts) — we reproduce the fixture's exact history state
// machine + keydown handler here and replace ONLY the leaf layout primitive
// (mirror-div height measurement) with a deterministic monospace visual-row
// count. The behavioural assertions (stories 16-20) are byte-identical: they
// verify that wrapped/multi-line cursor-row detection decides history-recall vs
// plain caret movement.
//
// WHAT THIS TIER CAN AND CANNOT PROVE
// -----------------------------------
// The "history recalls one press too early at column 0 of a non-first line" bug
// is a pure CSS-layout fact: a TRAILING newline in `white-space: pre-wrap`
// content generates no extra line box, so the legacy mirror-div measurement
// under-counted the caret's row by one. This model has no such collapse — it is
// MORE correct than the real browser — so the defect is structurally invisible
// here and CANNOT be pinned at this tier. The authoritative regression evidence
// is tests/browser/fixtures/message-editor-arrows-real.fixture.spec.ts, which drives the
// REAL <message-editor> against Chromium's layout engine.
//
// What this file does own: the intended ARITHMETIC. The replica counts the
// visual row containing each caret position, including the otherwise invisible
// row opened by a trailing newline, and compares row identity directly instead
// of differencing heights:
//     topRow    <=> rowsWithCaret(prefix) === 1
//     bottomRow <=> rowsWithCaret(prefix) === rowsWithCaret(value)
// Exact soft-wrap-boundary behaviour stays EXCLUSIVELY in the Chromium spec: the
// char-width approximation below is not an authority on where the browser wraps.
// (It also cannot model caret AFFINITY: at an exact wrap boundary one offset is
// both the end of row n and column 0 of row n+1, and the production predicates
// therefore report NEITHER top nor bottom row there — a rule only assertable
// against a real layout engine. Do not encode wrap boundaries here.)
//
// Distinct from dom/command-history.test.ts (dedup only) and
// dom/message-editor-ctrl-arrow.test.ts (Ctrl+Arrow modifier guard).
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Long string (200 chars, no newlines) that visually wraps in a 100px textarea.
const LONG_TEXT = "abcdefghij".repeat(20);

// --- deterministic monospace visual-row measurement --------------------------
// The number of visual rows a string occupies at the narrow textarea width. The
// fixture textarea is 100px wide; monospace glyphs are ~10px, so ~10 chars/row
// (padding/border are ignored — the ratio is what matters, and it is applied
// identically to every measurement, exactly like the browser's mirror div).
//
// A trailing "\n" contributes the visual row containing the caret after it.
// This is an arithmetic model, not an implementation of the production Range
// geometry; exact soft-wrap boundaries remain Chromium-only coverage.
const FIXTURE_WIDTH_PX = 100;
const CHAR_W = 10;
function rowsWithCaret(text: string, widthPx = FIXTURE_WIDTH_PX): number {
	const charsPerRow = Math.max(1, Math.floor(widthPx / CHAR_W));
	const rows = text
		.split("\n")
		.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerRow)), 0);
	return Math.max(1, rows);
}

// Documents the real-browser line-box collapse the production Range geometry
// must account for: a bare `pre-wrap` mirror omits the row after a trailing
// newline. Kept as executable documentation, never used by the predicates.
function visualRowsCollapsing(text: string, widthPx = FIXTURE_WIDTH_PX): number {
	return rowsWithCaret(text.endsWith("\n") ? text.slice(0, -1) : text, widthPx);
}

// --- fixture state machine (verbatim from message-editor-arrows.html) --------
interface HistoryState {
	history: string[];
	historyIndex: number;
	savedDraft: string;
}

function mountFixture() {
	document.body.innerHTML = `<textarea id="textarea" rows="5"></textarea>`;
	const textarea = document.getElementById("textarea") as HTMLTextAreaElement;
	const state: HistoryState = { history: [], historyIndex: -1, savedDraft: "" };

	// Corrected predicates: direct visual-row IDENTITY, not height arithmetic.
	// The legacy `cursorHeight <= singleRowHeight` /
	// `(fullHeight - cursorHeight) <= singleRowHeight` forms were doubly wrong —
	// they collapsed trailing newlines AND (for the bottom form) leaked the
	// mirror's padding into the inequality, so a row delta of 1 also passed.
	function isCursorOnVisualTopRow(ta: HTMLTextAreaElement): boolean {
		const pos = ta.selectionStart;
		if (pos === 0) return true;
		return rowsWithCaret(ta.value.substring(0, pos)) === 1;
	}
	function isCursorOnVisualBottomRow(ta: HTMLTextAreaElement): boolean {
		const pos = ta.selectionStart;
		if (pos >= ta.value.length) return true;
		return rowsWithCaret(ta.value.substring(0, pos)) === rowsWithCaret(ta.value);
	}

	textarea.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "ArrowUp" && state.history.length > 0 && isCursorOnVisualTopRow(textarea)) {
			if (state.historyIndex === -1) {
				state.savedDraft = textarea.value;
				state.historyIndex = state.history.length - 1;
			} else if (state.historyIndex > 0) {
				state.historyIndex--;
			} else {
				return; // At oldest, let default through.
			}
			e.preventDefault();
			textarea.value = state.history[state.historyIndex];
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		} else if (e.key === "ArrowDown" && state.historyIndex !== -1 && isCursorOnVisualBottomRow(textarea)) {
			e.preventDefault();
			if (state.historyIndex < state.history.length - 1) {
				state.historyIndex++;
				textarea.value = state.history[state.historyIndex];
			} else {
				state.historyIndex = -1;
				textarea.value = state.savedDraft;
			}
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		}
	});

	return {
		textarea,
		state,
		setHistory(h: string[]) { state.history = h; state.historyIndex = -1; state.savedDraft = ""; },
		checkCursorOnVisualTopRow() { return isCursorOnVisualTopRow(textarea); },
		checkCursorOnVisualBottomRow() { return isCursorOnVisualBottomRow(textarea); },
		/** Set buffer + caret in one step (mirrors the browser spec's helper). */
		at(value: string, pos: number) {
			textarea.value = value;
			textarea.setSelectionRange(pos, pos);
			return {
				top: isCursorOnVisualTopRow(textarea),
				bottom: isCursorOnVisualBottomRow(textarea),
			};
		},
	};
}

type Fixture = ReturnType<typeof mountFixture>;
function press(ta: HTMLTextAreaElement, key: string) {
	ta.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("Arrow keys with visual row detection", () => {
	let fx: Fixture;

	beforeEach(() => {
		fx = mountFixture();
		fx.setHistory(["history-entry-1", "history-entry-2"]);
	});
	afterEach(() => { document.body.innerHTML = ""; });

	it("story 16: wrapped text, cursor mid-text — ArrowUp does NOT trigger history", () => {
		const { textarea } = fx;
		textarea.value = LONG_TEXT;
		const mid = Math.floor(LONG_TEXT.length / 2);
		textarea.setSelectionRange(mid, mid);

		expect(fx.checkCursorOnVisualTopRow()).toBe(false);

		press(textarea, "ArrowUp");
		expect(textarea.value).toBe(LONG_TEXT); // unchanged — history did not activate
	});

	it("story 17: wrapped text, cursor at position 0 — ArrowUp triggers history", () => {
		const { textarea } = fx;
		textarea.value = LONG_TEXT;
		textarea.setSelectionRange(0, 0);

		expect(fx.checkCursorOnVisualTopRow()).toBe(true);

		press(textarea, "ArrowUp");
		expect(textarea.value).toBe("history-entry-2"); // newest history entry
	});

	it("story 18: multi-line text, cursor on line 2 — ArrowUp does NOT trigger history", () => {
		const { textarea } = fx;
		const multiLine = "line1\nline2\nline3";
		textarea.value = multiLine;
		textarea.setSelectionRange(8, 8); // mid "line2"

		expect(fx.checkCursorOnVisualTopRow()).toBe(false);

		press(textarea, "ArrowUp");
		expect(textarea.value).toBe(multiLine); // unchanged — history not triggered
	});

	it("story 19: multi-line text, cursor at position 0 — ArrowUp triggers history, ArrowDown restores", () => {
		const { textarea, state } = fx;
		const multiLine = "line1\nline2";
		textarea.value = multiLine;
		textarea.setSelectionRange(0, 0);

		press(textarea, "ArrowUp");
		expect(textarea.value).toBe("history-entry-2");

		press(textarea, "ArrowDown");
		expect(textarea.value).toBe(multiLine); // restored original multiline draft
		expect(state.historyIndex).toBe(-1);
	});

	it("story 20: ArrowDown only activates history when already in history mode", () => {
		const { textarea, state } = fx;
		const multiLine = "line1\nline2";
		textarea.value = multiLine;
		textarea.setSelectionRange(2, 2); // middle of "line1" — not in history mode

		press(textarea, "ArrowDown");
		expect(textarea.value).toBe(multiLine); // no history replacement
		expect(state.historyIndex).toBe(-1); // not in history mode

		// Enter history mode via ArrowUp from the top.
		textarea.setSelectionRange(0, 0);
		press(textarea, "ArrowUp");
		expect(textarea.value).toBe("history-entry-2");
		expect(state.historyIndex).not.toBe(-1); // in history mode

		// Now ArrowDown cycles history back to the saved draft.
		press(textarea, "ArrowDown");
		expect(textarea.value).toBe(multiLine); // restored draft
	});

	// --- caret-row geometry regression (arithmetic tier) ----------------------
	// Real-layout proof lives in
	// tests/browser/fixtures/message-editor-arrows-real.fixture.spec.ts.

	it("story 21: leading newlines — only offset 0 is the top row (goal-spec repro buffer)", () => {
		const { textarea, state } = fx;
		// "\n\nHello" is 3 visual rows: "", "", "Hello".
		expect(fx.at("\n\nHello", 0)).toEqual({ top: true, bottom: false });
		expect(fx.at("\n\nHello", 1)).toEqual({ top: false, bottom: false });
		expect(fx.at("\n\nHello", 2)).toEqual({ top: false, bottom: true });

		// Behavioural: the press that used to recall history one row early.
		textarea.value = "\n\nHello";
		textarea.setSelectionRange(1, 1);
		press(textarea, "ArrowUp");
		expect(textarea.value).toBe("\n\nHello");
		expect(state.historyIndex).toBe(-1);

		// ...and from offset 0 recall must still fire.
		textarea.setSelectionRange(0, 0);
		press(textarea, "ArrowUp");
		expect(textarea.value).toBe("history-entry-2");
	});

	it("story 22: 'abc\\ndef' with the caret before 'd' is the bottom row, not the top row", () => {
		const { textarea, state } = fx;
		expect(fx.at("abc\ndef", 4)).toEqual({ top: false, bottom: true });

		textarea.value = "abc\ndef";
		textarea.setSelectionRange(4, 4);
		press(textarea, "ArrowUp");
		expect(textarea.value).toBe("abc\ndef"); // no recall
		expect(state.historyIndex).toBe(-1);
	});

	it("story 23: ArrowDown on the penultimate row stays in history browsing", () => {
		const { textarea, state } = fx;
		const entry = "line1\nline2\nline3";
		fx.setHistory([entry]);

		// Offsets 6/8/11 are all on row 2 of 3 — never the bottom row. Offset 6 is
		// the case where the two legacy defects cancelled, so it is asserted too.
		expect(fx.at(entry, 6)).toEqual({ top: false, bottom: false });
		expect(fx.at(entry, 8)).toEqual({ top: false, bottom: false });
		expect(fx.at(entry, 11)).toEqual({ top: false, bottom: false });
		expect(fx.at(entry, 12)).toEqual({ top: false, bottom: true }); // column 0 of the LAST row

		// Behavioural: enter history browsing, then ArrowDown from row 2.
		textarea.value = "";
		textarea.setSelectionRange(0, 0);
		press(textarea, "ArrowUp");
		expect(textarea.value).toBe(entry);
		expect(state.historyIndex).toBe(0);

		for (const pos of [8, 11]) {
			textarea.setSelectionRange(pos, pos);
			press(textarea, "ArrowDown");
			expect(textarea.value).toBe(entry); // draft NOT restored one press early
			expect(state.historyIndex).toBe(0);
		}

		// From the last row ArrowDown must still leave history.
		textarea.setSelectionRange(12, 12);
		press(textarea, "ArrowDown");
		expect(textarea.value).toBe(""); // saved (empty) draft
		expect(state.historyIndex).toBe(-1);
	});

	it("story 24: a trailing newline still counts as its own row (marker vs line-box collapse)", () => {
		// The store trims history entries, so a trailing newline is only reachable as
		// a draft — hence this is asserted at predicate level, exactly as the
		// Chromium spec does.
		expect(fx.at("Hello\n", 5)).toEqual({ top: true, bottom: false }); // row 1 of 2
		expect(fx.at("Hello\n\n", 5)).toEqual({ top: true, bottom: false }); // row 1 of 3
		expect(fx.at("Hello\n\n", 6)).toEqual({ top: false, bottom: false }); // row 2 of 3

		// The caret-row model counts the row after a trailing newline; a bare
		// pre-wrap mirror does not. That one-row gap is the browser regression.
		expect(rowsWithCaret("Hello\n")).toBe(2);
		expect(visualRowsCollapsing("Hello\n")).toBe(1);
		expect(rowsWithCaret("\n")).toBe(2);
		expect(visualRowsCollapsing("\n")).toBe(1);
	});
});
