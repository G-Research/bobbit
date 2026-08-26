// Test entry for the REAL <message-editor> caret-row geometry regression
// (tests/browser/fixtures/message-editor-arrows-real.fixture.spec.ts).
//
// Why a NEW fixture pair instead of reusing message-editor-ime.html:
//  - the IME/size-guard fixture never renders history and never fixes the
//    textarea's box, so wrapping there is non-deterministic;
//  - these scenarios need a working `getAppStorage().commandHistory`, because
//    the goal-spec repro must build history through the PRODUCTION send path
//    (handleSend -> addToHistory), not by poking `_history`.
//
// The component is bundled from source, so `_isCursorOnVisualTopRow` /
// `_isCursorOnVisualBottomRow` are exercised against a real Chromium layout
// engine. happy-dom cannot host these assertions (offsetHeight is always 0).
import "../../../../src/ui/components/MessageEditor.js";
import { MessageEditor } from "../../../../src/ui/components/MessageEditor.js";
import { AppStorage, setAppStorage } from "../../../../src/ui/storage/app-storage.js";
import { CommandHistoryStore } from "../../../../src/ui/storage/stores/command-history-store.js";
import { CustomProvidersStore } from "../../../../src/ui/storage/stores/custom-providers-store.js";
import { PromptDraftAttachmentsStore } from "../../../../src/ui/storage/stores/prompt-draft-attachments-store.js";
import { ProviderKeysStore } from "../../../../src/ui/storage/stores/provider-keys-store.js";
import { SessionsStore } from "../../../../src/ui/storage/stores/sessions-store.js";
import { SettingsStore } from "../../../../src/ui/storage/stores/settings-store.js";
import { ShortcutBindingsStore } from "../../../../src/ui/storage/stores/shortcut-bindings-store.js";
import type { StorageBackend, StorageTransaction } from "../../../../src/ui/storage/types.js";

// ---------------------------------------------------------------------------
// In-memory StorageBackend. IndexedDB is unreliable on the opaque file:// origin
// Chromium gives us, and the real backend is not what we're testing — we only
// need `commandHistory.addEntry`/`getHistory` to round-trip, INCLUDING its
// `text.trim()` (that trim is exactly why trailing-newline geometry cases are
// unreachable through the send path and must be asserted at predicate level).
// ---------------------------------------------------------------------------
class MemoryBackend implements StorageBackend {
	private data = new Map<string, Map<string, unknown>>();

	private store(name: string): Map<string, unknown> {
		let s = this.data.get(name);
		if (!s) { s = new Map(); this.data.set(name, s); }
		return s;
	}

	async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
		const v = this.store(storeName).get(key);
		return v === undefined ? null : (v as T);
	}
	async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
		this.store(storeName).set(key, value);
	}
	async delete(storeName: string, key: string): Promise<void> {
		this.store(storeName).delete(key);
	}
	async keys(storeName: string, prefix?: string): Promise<string[]> {
		const all = [...this.store(storeName).keys()];
		return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
	}
	async getAllFromIndex<T = unknown>(storeName: string, _indexName: string, _direction?: "asc" | "desc"): Promise<T[]> {
		return [...this.store(storeName).values()] as T[];
	}
	async clear(storeName: string): Promise<void> {
		this.store(storeName).clear();
	}
	async has(storeName: string, key: string): Promise<boolean> {
		return this.store(storeName).has(key);
	}
	async transaction<T>(
		_storeNames: string[],
		_mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T> {
		return operation({
			get: (s, k) => this.get(s, k),
			set: (s, k, v) => this.set(s, k, v),
			delete: (s, k) => this.delete(s, k),
		});
	}
	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return { usage: 0, quota: 1, percent: 0 };
	}
	async requestPersistence(): Promise<boolean> {
		return true;
	}
	reset(): void {
		this.data.clear();
	}
}

const backend = new MemoryBackend();
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();
const commandHistory = new CommandHistoryStore();
const shortcutBindings = new ShortcutBindingsStore();
const promptDraftAttachments = new PromptDraftAttachmentsStore();
for (const s of [settings, providerKeys, sessions, customProviders, commandHistory, shortcutBindings, promptDraftAttachments]) {
	s.setBackend(backend);
}
setAppStorage(new AppStorage(
	settings, providerKeys, sessions, customProviders, commandHistory, shortcutBindings, promptDraftAttachments, backend,
));

(window as any).MessageEditorClass = MessageEditor;

// ---------------------------------------------------------------------------
// Deterministic textarea box. Production styles the textarea with Tailwind
// classes that are absent from this file:// fixture, and inlines
// `field-sizing: content`, so without pinning the box here the wrap points
// would depend on the viewport. Zero border keeps the production mirror
// (width = textarea.clientWidth, box-sizing copied) content-width-identical to
// the textarea, which the wrap-boundary oracle relies on.
// ---------------------------------------------------------------------------
export interface BoxStyle {
	widthPx: number;
	fontSizePx: number;
	/** Unitless multiplier or a CSS length. `1.35` at 13px => 17.55px rows. */
	lineHeight: string;
	heightPx: number;
	/** Full CSS font stack. The production composer uses a PROPORTIONAL stack, so
	 *  a monospace-only fixture cannot see break-word wrap-point defects. */
	fontFamily: string;
}

const DEFAULT_BOX: BoxStyle = { widthPx: 320, fontSizePx: 16, lineHeight: "20px", heightPx: 400, fontFamily: "monospace" };

function applyBox(el: any, box: BoxStyle) {
	const ta = el.querySelector("textarea") as HTMLTextAreaElement | null;
	if (!ta) throw new Error("textarea not found in message-editor");
	const s = ta.style;
	s.setProperty("width", `${box.widthPx}px`, "important");
	s.setProperty("min-width", `${box.widthPx}px`, "important");
	s.setProperty("max-width", `${box.widthPx}px`, "important");
	s.setProperty("flex", "none", "important");
	s.setProperty("field-sizing", "fixed", "important");
	s.setProperty("box-sizing", "border-box", "important");
	s.setProperty("border", "0", "important");
	s.setProperty("padding", "4px", "important");
	s.setProperty("margin", "0", "important");
	s.setProperty("font-family", box.fontFamily, "important");
	s.setProperty("font-size", `${box.fontSizePx}px`, "important");
	s.setProperty("line-height", box.lineHeight, "important");
	s.setProperty("letter-spacing", "normal", "important");
	s.setProperty("height", `${box.heightPx}px`, "important");
	s.setProperty("min-height", `${box.heightPx}px`, "important");
	s.setProperty("max-height", `${box.heightPx}px`, "important");
	s.setProperty("overflow-y", "scroll", "important");
	return ta;
}

const sendCalls: Array<{ text: string }> = [];
let current: any = null;

function mount(sessionId: string, box?: Partial<BoxStyle>) {
	const container = document.getElementById("container")!;
	container.innerHTML = "";
	sendCalls.length = 0;
	const el = document.createElement("message-editor") as any;
	el.sessionId = sessionId;
	// Production's owner (session-manager) clears the composer on send; the
	// history state machine depends on that, so replicate it faithfully.
	el.onSend = (text: string) => {
		sendCalls.push({ text });
		el.value = "";
		const ta = el.querySelector("textarea") as HTMLTextAreaElement | null;
		if (ta) ta.value = "";
	};
	container.appendChild(el);
	current = el;
	return el.updateComplete.then(() => {
		applyBox(el, { ...DEFAULT_BOX, ...box });
		return el.updateComplete;
	}).then(() => el);
}

(window as any).__mount = (sessionId: string, box?: Partial<BoxStyle>) => mount(sessionId, box);
(window as any).__editor = () => current;
(window as any).__textarea = () => current.querySelector("textarea") as HTMLTextAreaElement;
(window as any).__resetStorage = () => backend.reset();
(window as any).__sendCalls = () => sendCalls.slice();
(window as any).__applyBox = (box: Partial<BoxStyle>) => applyBox(current, { ...DEFAULT_BOX, ...box });

/** Snapshot of everything the assertions care about, read synchronously. */
(window as any).__state = () => {
	const el = current;
	const ta = el.querySelector("textarea") as HTMLTextAreaElement;
	return {
		value: el.value as string,
		textareaValue: ta.value,
		selectionStart: ta.selectionStart,
		historyIndex: el["_historyIndex"] as number,
		history: (el["_history"] as string[]).slice(),
		liveDraft: (el["_historyEditBuffer"] as Map<number, string>).get(-1) ?? "",
	};
};

/** Let Lit flush so `live(this.value)` has re-synced the textarea. */
(window as any).__settle = async () => {
	await current.updateComplete;
	await new Promise((r) => requestAnimationFrame(() => r(null)));
	await current.updateComplete;
};

/** Direct history injection — permitted ONLY for synthetic geometry cases that
 *  the trimming store makes unreachable through the real send path. */
(window as any).__injectHistory = (entries: string[]) => {
	current["_history"] = entries.slice();
	current["_historyIndex"] = -1;
	(current["_historyEditBuffer"] as Map<number, string>).clear();
};

/** Set the composer buffer + caret without going through keystrokes. Used for
 *  predicate-level assertions and for repositioning the caret inside a value
 *  that WAS produced by real keystrokes. */
(window as any).__setValueAndCaret = async (value: string, pos: number) => {
	const el = current;
	el.value = value;
	await el.updateComplete;
	const ta = el.querySelector("textarea") as HTMLTextAreaElement;
	ta.value = value;
	ta.focus();
	ta.setSelectionRange(pos, pos);
	return { value: ta.value, selectionStart: ta.selectionStart };
};

(window as any).__setCaret = (pos: number) => {
	const ta = current.querySelector("textarea") as HTMLTextAreaElement;
	ta.focus();
	ta.setSelectionRange(pos, pos);
	return ta.selectionStart;
};

/** Invoke the PRODUCTION geometry predicates for `value` @ `pos`. Bracket
 *  access reaches the private methods on the real component instance. */
(window as any).__predicates = async (value: string, pos: number) => {
	await (window as any).__setValueAndCaret(value, pos);
	const el = current;
	return {
		top: el["_isCursorOnVisualTopRow"]() as boolean,
		bottom: el["_isCursorOnVisualBottomRow"]() as boolean,
	};
};

// ---------------------------------------------------------------------------
// Independent wrap oracle. Deliberately does NOT use any component code: a
// plain <div> styled from the textarea's COMPUTED style, holding `value` as one
// UNSPLIT text node, measured with Range.getClientRects(). This is what proves
// a marker-based fix has not shifted the browser's own wrap points.
// ---------------------------------------------------------------------------
function oracleDiv(ta: HTMLTextAreaElement, value: string) {
	const cs = getComputedStyle(ta);
	const div = document.createElement("div");
	div.style.cssText = [
		"position:absolute",
		"top:-10000px",
		"left:0",
		"visibility:hidden",
		"white-space:pre-wrap",
		"word-wrap:break-word",
		"overflow-wrap:break-word",
		`width:${ta.clientWidth}px`,
		`font-family:${cs.fontFamily}`,
		`font-size:${cs.fontSize}`,
		`font-weight:${cs.fontWeight}`,
		`line-height:${cs.lineHeight}`,
		`letter-spacing:${cs.letterSpacing}`,
		`padding:${cs.padding}`,
		`border:${cs.border || "0"}`,
		`box-sizing:${cs.boxSizing}`,
		"margin:0",
	].join(";");
	const text = document.createTextNode(value);
	div.appendChild(text);
	document.body.appendChild(div);
	return { div, text };
}

/** `top` of the line box each offset's following character sits on, for every
 *  offset in [0, value.length). */
function offsetTops(ta: HTMLTextAreaElement, value: string): number[] {
	const { div, text } = oracleDiv(ta, value);
	const tops: number[] = [];
	try {
		for (let i = 0; i < value.length; i++) {
			const r = document.createRange();
			r.setStart(text, i);
			r.setEnd(text, i + 1);
			const rects = r.getClientRects();
			// A newline character produces no rect in some engines; fall back to
			// the collapsed caret rect at that offset.
			if (rects.length > 0) {
				tops.push(rects[0].top);
			} else {
				const c = document.createRange();
				c.setStart(text, i);
				c.collapse(true);
				tops.push(c.getBoundingClientRect().top);
			}
		}
	} finally {
		document.body.removeChild(div);
	}
	return tops;
}

/** Zero-based visual row index of every offset in [0, value.length), derived
 *  purely from measured line-box tops. */
(window as any).__oracleRowIndexes = (value: string) => {
	const ta = current.querySelector("textarea") as HTMLTextAreaElement;
	const tops = offsetTops(ta, value);
	const uniq: number[] = [];
	for (const t of tops) {
		if (!uniq.some((u) => Math.abs(u - t) <= 0.5)) uniq.push(t);
	}
	uniq.sort((a, b) => a - b);
	return tops.map((t) => uniq.findIndex((u) => Math.abs(u - t) <= 0.5));
};

/** Smallest offset > 0 whose character renders on a lower line box than
 *  offset 0's — i.e. the first soft-wrap boundary of a newline-free value. */
(window as any).__oracleFirstWrapOffset = (value: string) => {
	const rows = (window as any).__oracleRowIndexes(value) as number[];
	for (let i = 1; i < rows.length; i++) {
		if (rows[i] > rows[0]) return i;
	}
	return -1;
};

/** Zero-based visual row of the CARET at `pos`, per the independent oracle.
 *  Valid for 0 < pos < value.length. At an exact soft-wrap boundary one offset
 *  maps to two caret positions, so the production rule deliberately reports
 *  NEITHER top nor bottom there — see `__sweepTopRow`. */
function oracleCaretRow(rows: number[], pos: number): number {
	return rows[pos];
}

/** Sweep the production predicates against the independent Range oracle for
 *  every offset in a +/-`radius` window around each visual-row boundary of
 *  `value`, INCLUDING the boundary offsets themselves.
 *
 *  Boundary offsets used to be excluded as un-callable: at an exact soft-wrap
 *  point one offset maps to two caret positions (end of row n / start of row
 *  n+1) and Chromium resolves it by affinity, which the DOM cannot observe. The
 *  production rule removes the ambiguity instead of guessing it — a position only
 *  counts as the top (bottom) row when BOTH readings (the row of the character
 *  before the caret AND the row of the character at the caret) are the first
 *  (last) row — so at a boundary the expected value is deterministic:
 *  top === false AND bottom === false.
 *
 *  Runs entirely in-page: one predicate call per offset with no Lit round-trip,
 *  so a full width x font x content sweep stays fast. Returns every disagreement
 *  so the spec can print them verbatim. */
(window as any).__sweepTopRow = async (value: string, radius = 3) => {
	const el = current;
	el.value = value;
	await el.updateComplete;
	const ta = el.querySelector("textarea") as HTMLTextAreaElement;
	ta.value = value;
	ta.focus();

	const rows = (window as any).__oracleRowIndexes(value) as number[];
	const lastRow = rows.length > 0 ? Math.max(...rows) : 0;
	const boundaries: number[] = [];
	for (let i = 1; i < rows.length; i++) {
		if (rows[i] > rows[i - 1]) boundaries.push(i);
	}
	const isBoundary = new Set(boundaries);

	const offsets = new Set<number>();
	for (const b of boundaries) {
		for (let o = b - radius; o <= b + radius; o++) {
			if (o > 0 && o < value.length) offsets.add(o);
		}
	}

	const mismatches: Array<{ pos: number; which: string; oracleRow: number; got: boolean; expected: boolean }> = [];
	let boundariesChecked = 0;
	for (const pos of [...offsets].sort((a, b) => a - b)) {
		ta.setSelectionRange(pos, pos);
		const gotTop = el["_isCursorOnVisualTopRow"]() as boolean;
		const gotBottom = el["_isCursorOnVisualBottomRow"]() as boolean;
		const atBoundary = isBoundary.has(pos);
		if (atBoundary) boundariesChecked++;
		const expectTop = atBoundary ? false : oracleCaretRow(rows, pos) === 0;
		const expectBottom = atBoundary ? false : oracleCaretRow(rows, pos) === lastRow;
		if (gotTop !== expectTop) {
			mismatches.push({ pos, which: "top", oracleRow: rows[pos], got: gotTop, expected: expectTop });
		}
		if (gotBottom !== expectBottom) {
			mismatches.push({ pos, which: "bottom", oracleRow: rows[pos], got: gotBottom, expected: expectBottom });
		}
	}
	return {
		checked: offsets.size,
		boundariesChecked,
		boundaries,
		rowCount: rows.length > 0 ? Math.max(...rows) + 1 : 0,
		clientWidth: ta.clientWidth,
		fontFamily: getComputedStyle(ta).fontFamily,
		mismatches,
	};
};

/** Wall time (ms) of ONE call to each production predicate for `value` @ `pos`.
 *  Nothing but the predicate calls are inside the timing windows: the buffer and
 *  caret are installed, Lit is flushed, AND the page's own pending layout is
 *  forced first. That last step matters — installing a 500 KB textarea value
 *  leaves the document's layout dirty, and whichever code touches geometry next
 *  pays for it (~105 ms here) whether or not it is the caret measurement; the
 *  browser pays it before the next paint regardless. `flushMs` reports it so the
 *  spec can log both numbers. No warm-up of the predicates themselves is done —
 *  the FIRST keypress is exactly what used to freeze the main thread. */
(window as any).__timePredicates = async (value: string, pos: number) => {
	await (window as any).__setValueAndCaret(value, pos);
	const el = current;
	const f0 = performance.now();
	void (el.querySelector("textarea") as HTMLTextAreaElement).getBoundingClientRect().height;
	void document.body.offsetHeight;
	const flushMs = performance.now() - f0;
	const t0 = performance.now();
	const top = el["_isCursorOnVisualTopRow"]() as boolean;
	const t1 = performance.now();
	const bottom = el["_isCursorOnVisualBottomRow"]() as boolean;
	const t2 = performance.now();
	return { top, bottom, topMs: t1 - t0, bottomMs: t2 - t1, totalMs: t2 - t0, flushMs, length: value.length };
};

/** Everything the reviewer's repro reports, in one synchronous snapshot.
 *  `caretRowsBelowFirst` / `caretTopEqualsFirstTop` describe the BEFORE reading
 *  (row of the character preceding the caret); `afterRowsBelowFirst` is the AFTER
 *  reading (row of the character at the caret). They differ only at an exact
 *  soft-wrap boundary, which is precisely why both are reported. */
(window as any).__caretRowDiagnostic = async (value: string, pos: number) => {
	const el = current;
	const ta = el.querySelector("textarea") as HTMLTextAreaElement;
	await (window as any).__setValueAndCaret(value, pos);
	const rows = (window as any).__oracleRowIndexes(value) as number[];
	const geo = el["_measureCaretRowGeometry"]() as
		| { beforeTop: number; afterTop: number; firstTop: number; lastTop: number; rowHeight: number }
		| null;
	return {
		clientWidth: ta.clientWidth,
		fontFamily: getComputedStyle(ta).fontFamily,
		selectionStart: ta.selectionStart,
		firstWrapBoundary: (window as any).__oracleFirstWrapOffset(value) as number,
		oracleRowBefore: rows[pos - 1],
		oracleRowAt: rows[pos],
		caretTopEqualsFirstTop: geo ? Math.abs(geo.beforeTop - geo.firstTop) < geo.rowHeight / 2 : null,
		caretRowsBelowFirst: geo ? Math.round((geo.beforeTop - geo.firstTop) / geo.rowHeight) : null,
		afterRowsBelowFirst: geo ? Math.round((geo.afterTop - geo.firstTop) / geo.rowHeight) : null,
		rowsAboveLast: geo ? Math.round((geo.lastTop - geo.beforeTop) / geo.rowHeight) : null,
		top: el["_isCursorOnVisualTopRow"]() as boolean,
		bottom: el["_isCursorOnVisualBottomRow"]() as boolean,
	};
};

(window as any).__ready = true;
