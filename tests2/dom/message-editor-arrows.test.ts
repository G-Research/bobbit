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
// Distinct from dom/command-history.test.ts (dedup only) and
// dom/message-editor-ctrl-arrow.test.ts (Ctrl+Arrow modifier guard).
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Long string (200 chars, no newlines) that visually wraps in a 100px textarea.
const LONG_TEXT = "abcdefghij".repeat(20);

// --- deterministic monospace visual-row measurement --------------------------
// Reproduces what the fixture's mirror-div offsetHeight yields in a real browser:
// the number of visual rows a string occupies at the narrow textarea width. The
// fixture textarea is 100px wide; monospace glyphs are ~10px, so ~10 chars/row
// (padding/border are ignored — the ratio is what matters, and it is applied
// identically to every measurement, exactly like the browser's mirror div).
const FIXTURE_WIDTH_PX = 100;
const CHAR_W = 10;
function visualRows(text: string, widthPx = FIXTURE_WIDTH_PX): number {
	const charsPerRow = Math.max(1, Math.floor(widthPx / CHAR_W));
	const rows = text
		.split("\n")
		.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerRow)), 0);
	return Math.max(1, rows);
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

	function isCursorOnVisualTopRow(ta: HTMLTextAreaElement): boolean {
		const pos = ta.selectionStart;
		if (pos === 0) return true;
		const cursorHeight = visualRows(ta.value.substring(0, pos));
		const singleRowHeight = visualRows("X");
		return cursorHeight <= singleRowHeight;
	}
	function isCursorOnVisualBottomRow(ta: HTMLTextAreaElement): boolean {
		const pos = ta.selectionStart;
		if (pos >= ta.value.length) return true;
		const fullHeight = visualRows(ta.value);
		const cursorHeight = visualRows(ta.value.substring(0, pos));
		const singleRowHeight = visualRows("X");
		return (fullHeight - cursorHeight) <= singleRowHeight;
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
});
