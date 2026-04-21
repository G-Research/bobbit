/**
 * Interactive widget rendered inline in the chat for the `ask_user_choices` tool.
 *
 * - Tabs across the top (one per question). Tab titles use
 *   `${letter(idx)}. ${tab_label}` (A., B., …) for multi-question asks.
 * - Options render as radio/checkbox cards prefixed with a numeric badge
 *   (`1.`, `2.`, …) so the number-key shortcut is discoverable.
 * - Single-select: selecting a non-"Other" option auto-advances to the next tab.
 * - Multi-select (`multi: true`): checkboxes; no auto-advance.
 * - "Other" (when enabled) reveals a text input; does NOT auto-advance.
 * - On multi-question asks, the primary button reads **Next** on every tab
 *   except the last, where it reads **Submit** (existing behaviour).
 * - Submit is disabled until every question has a valid selection (respecting
 *   min/max for multi-select).
 * - Once submitted (or `answers` prop is populated), the widget is read-only.
 *
 * ## Keyboard navigation
 *
 * A single keydown listener on the `.ask-widget` root handles:
 *   - Arrow Up/Down      — move focus between options (wraps).
 *   - Arrow Left/Right   — (on tab buttons) move across tabs.
 *   - Enter              — click the primary button (Next/Submit), or on a
 *                          single-question single-select ask pick the focused
 *                          option and auto-submit.
 *   - Escape             — clear the current question's selection and any
 *                          "Other" text. Does not submit.
 *   - 1–9                — pick the option by 1-based index on the active
 *                          question. Single-select auto-submits (single-q) or
 *                          auto-advances (multi-q). Multi-select toggles.
 *   - A–Z (a–z)          — jump to the corresponding tab (multi-question only).
 *
 * While focus is inside the `.ask-other-input` text field, only Enter and
 * Escape are intercepted; letters/numbers go to the input as normal.
 */
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

/**
 * Resolve the gateway auth token. Tries both storage keys used by the app
 * ("gateway.token" set by main.ts on connect, and "auth-token" used by the
 * legacy auth-token util).
 */
function resolveAuthToken(): string {
	return localStorage.getItem("gateway.token")
		?? localStorage.getItem("auth-token")
		?? "";
}

/** Sentinel value for the "Other" option — distinct from any real option text. */
export const OTHER_SENTINEL = "__OTHER__";

export interface AskQuestion {
	question: string;
	options: string[];
	/** Short topical tab label (2–4 words, ≤24 chars). Required for multi-question asks. */
	tab_label?: string;
	allow_other?: boolean;
	multi?: boolean;
	min?: number;
	max?: number;
}

export interface AskAnswer {
	question: string;
	/** string for single-select; string[] for multi-select. */
	selected: string | string[];
	other_text: string | null;
}

interface DraftEntry {
	/** null (none), a single option (single-select), or an array (multi-select). */
	selected: string | string[] | null;
	other_text: string;
}

function tabLetter(idx: number): string {
	return String.fromCharCode(65 + idx);
}

@customElement("ask-user-choices-widget")
export class AskUserChoicesWidget extends LitElement {
	@property({ attribute: false }) questions: AskQuestion[] = [];
	/** When non-null, widget is read-only (final answers). */
	@property({ attribute: false }) answers: AskAnswer[] | null = null;
	@property({ type: String }) sessionId = "";
	@property({ type: String }) toolUseId = "";
	@property({ type: Boolean }) errored = false;
	@property({ type: String }) errorText = "";

	@state() private _activeTab = 0;
	@state() private _focusedOption = 0;
	@state() private _draft: DraftEntry[] = [];
	@state() private _submitting = false;
	@state() private _submitError = "";

	// Use light DOM for CSS consistency with tool-card styling.
	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this._ensureDraft();
	}

	override willUpdate(changed: Map<string, unknown>): void {
		if (changed.has("questions")) {
			this._ensureDraft();
		}
	}

	private _ensureDraft(): void {
		if (!Array.isArray(this.questions)) return;
		if (this._draft.length !== this.questions.length) {
			this._draft = this.questions.map((q) => ({
				selected: q.multi ? [] : null,
				other_text: "",
			}));
			this._activeTab = Math.min(this._activeTab, Math.max(0, this.questions.length - 1));
			this._focusedOption = 0;
		}
	}

	private _optionCount(qIdx: number): number {
		const q = this.questions[qIdx];
		if (!q) return 0;
		return q.options.length + (q.allow_other ? 1 : 0);
	}

	/** Return the option value (including OTHER_SENTINEL) at 0-based index. */
	private _optionValueAt(qIdx: number, optIdx: number): string | null {
		const q = this.questions[qIdx];
		if (!q) return null;
		if (optIdx < 0) return null;
		if (optIdx < q.options.length) return q.options[optIdx];
		if (q.allow_other && optIdx === q.options.length) return OTHER_SENTINEL;
		return null;
	}

	private _selectTab(idx: number): void {
		if (idx < 0 || idx >= this.questions.length) return;
		if (this._activeTab !== idx) {
			this._activeTab = idx;
			this._focusedOption = 0;
		}
	}

	private _isQuestionValid(qIdx: number): boolean {
		const q = this.questions[qIdx];
		const d = this._draft[qIdx];
		if (!q || !d) return false;
		if (q.multi) {
			const arr = Array.isArray(d.selected) ? d.selected : [];
			const maxOptionCount = q.options.length + (q.allow_other ? 1 : 0);
			const min = q.min ?? 1;
			const max = q.max ?? maxOptionCount;
			if (arr.length < min || arr.length > max) return false;
			if (arr.includes(OTHER_SENTINEL) && !d.other_text.trim()) return false;
			return true;
		}
		if (!d.selected || Array.isArray(d.selected)) return false;
		if (d.selected === OTHER_SENTINEL && !d.other_text.trim()) return false;
		return true;
	}

	private _selectOption(qIdx: number, option: string): void {
		if (this._isReadOnly()) return;
		const q = this.questions[qIdx];
		if (q?.multi) {
			this._draft = this._draft.map((d, i) => {
				if (i !== qIdx) return d;
				const cur = Array.isArray(d.selected) ? d.selected : [];
				const next = cur.includes(option)
					? cur.filter(x => x !== option)
					: [...cur, option];
				return { ...d, selected: next };
			});
			// No auto-advance for multi-select.
			return;
		}
		this._draft = this._draft.map((d, i) => i === qIdx ? { ...d, selected: option } : d);
		// Single-question, non-Other: auto-submit (no Submit button rendered).
		if (option !== OTHER_SENTINEL && this.questions.length === 1) {
			setTimeout(() => { void this._submit(); }, 50);
			return;
		}
		// Auto-advance unless "Other" was selected or this is the last question.
		// Defer one tick so the current touch/click gesture settles on the Q1
		// label before Q2 mounts — otherwise mobile browsers can deliver the
		// synthetic click to the freshly-rendered Q2 option at the same
		// coordinates ("ghost click") and either pre-select or swallow the
		// user's intended first real tap on Q2.
		if (option !== OTHER_SENTINEL && qIdx < this.questions.length - 1) {
			const nextIdx = qIdx + 1;
			setTimeout(() => {
				if (this._activeTab === qIdx) {
					this._activeTab = nextIdx;
					this._focusedOption = 0;
				}
			}, 250);
		}
	}

	/**
	 * For a single-question ask, suppress the Submit button when the pending
	 * selection would auto-submit on pick (single-select, non-Other). We still
	 * show Submit for multi-select (needs confirmation) and for "Other"
	 * (needs text entry + confirmation).
	 */
	private _shouldHideSubmit(): boolean {
		if (this.questions.length !== 1) return false;
		const q = this.questions[0];
		if (q?.multi) return false;
		const d = this._draft[0];
		if (d && d.selected === OTHER_SENTINEL) return false;
		// If a previous auto-submit failed, re-show Submit so the user can retry.
		if (this._submitError) return false;
		return true;
	}

	private _setOtherText(qIdx: number, text: string): void {
		if (this._isReadOnly()) return;
		this._draft = this._draft.map((d, i) => i === qIdx ? { ...d, other_text: text } : d);
	}

	private _canSubmit(): boolean {
		if (this._draft.length !== this.questions.length) return false;
		return this._draft.every((_d, i) => this._isQuestionValid(i));
	}

	private _isReadOnly(): boolean {
		return Array.isArray(this.answers) || this.errored;
	}

	private _isLastTab(): boolean {
		return this._activeTab === this.questions.length - 1;
	}

	/** Next button is shown when there are multiple questions and the active tab is not the last. */
	private _showNext(): boolean {
		return this.questions.length > 1 && !this._isLastTab();
	}

	private _clickPrimary(): void {
		if (this._isReadOnly()) return;
		if (this._showNext()) {
			if (this._isQuestionValid(this._activeTab)) {
				this._activeTab = this._activeTab + 1;
				this._focusedOption = 0;
			}
			return;
		}
		void this._submit();
	}

	private _clearActive(): void {
		if (this._isReadOnly()) return;
		const qIdx = this._activeTab;
		const q = this.questions[qIdx];
		if (!q) return;
		this._draft = this._draft.map((d, i) =>
			i === qIdx
				? { selected: q.multi ? [] : null, other_text: "" }
				: d,
		);
		this._submitError = "";
	}

	private async _submit(): Promise<void> {
		if (!this._canSubmit() || this._submitting) return;
		this._submitting = true;
		this._submitError = "";
		const answers: AskAnswer[] = this.questions.map((q, i) => {
			const d = this._draft[i];
			if (q.multi) {
				const arr = (Array.isArray(d.selected) ? d.selected : []).map(v => v === OTHER_SENTINEL ? "Other" : v);
				const hasOther = arr.includes("Other");
				return {
					question: q.question,
					selected: arr,
					other_text: hasOther ? d.other_text.trim() : null,
				};
			}
			const isOther = d.selected === OTHER_SENTINEL;
			return {
				question: q.question,
				selected: isOther ? "Other" : (typeof d.selected === "string" ? d.selected : ""),
				other_text: isOther ? d.other_text.trim() : null,
			};
		});
		try {
			const token = resolveAuthToken();
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (token) headers["Authorization"] = `Bearer ${token}`;
			const resp = await fetch("/api/internal/user-question/submit", {
				method: "POST",
				headers,
				body: JSON.stringify({ sessionId: this.sessionId, toolUseId: this.toolUseId, answers }),
			});
			if (!resp.ok) {
				let msg = `HTTP ${resp.status}`;
				try { const e = await resp.json(); if (e?.error) msg = e.error; } catch { /* ignore */ }
				throw new Error(msg);
			}
			// Flip to read-only optimistically. The tool result will also arrive via the stream.
			this.answers = answers;
		} catch (e: any) {
			this._submitError = e?.message || String(e);
		} finally {
			this._submitting = false;
		}
	}

	// ── Keyboard handling ──────────────────────────────────────────────

	private _isTextInputFocused(): boolean {
		const el = document.activeElement as HTMLElement | null;
		if (!el) return false;
		if (el.tagName === "TEXTAREA") return true;
		if (el.tagName === "INPUT") {
			const t = (el as HTMLInputElement).type?.toLowerCase() || "text";
			// Radios/checkboxes are sr-only but never focused for typing; treat them as non-text.
			return !(t === "radio" || t === "checkbox" || t === "button" || t === "submit");
		}
		return false;
	}

	private _onKeydown = (e: KeyboardEvent): void => {
		if (this._isReadOnly()) return;
		const key = e.key;
		const textFocused = this._isTextInputFocused();

		// Inside the Other text input only Enter (submit/advance) and Escape
		// (clear) intercept — everything else goes to the browser default.
		if (textFocused) {
			if (key === "Escape") {
				e.preventDefault();
				this._clearActive();
				return;
			}
			if (key === "Enter") {
				if (this._isQuestionValid(this._activeTab)) {
					e.preventDefault();
					this._clickPrimary();
				}
				return;
			}
			return;
		}

		const target = e.target as HTMLElement | null;
		const onTab = !!target?.closest?.('[role="tab"]');

		if (key === "ArrowLeft" || key === "ArrowRight") {
			if (onTab && this.questions.length > 1) {
				e.preventDefault();
				const dir = key === "ArrowRight" ? 1 : -1;
				const next = (this._activeTab + dir + this.questions.length) % this.questions.length;
				this._selectTab(next);
				// Move focus to the newly active tab button (roving tabindex).
				setTimeout(() => {
					const btn = this.querySelector(
						`[role="tab"][data-tab-index="${next}"]`,
					) as HTMLButtonElement | null;
					btn?.focus();
				}, 0);
			}
			return;
		}

		const count = this._optionCount(this._activeTab);

		if (key === "ArrowDown") {
			if (count > 0) {
				e.preventDefault();
				this._focusedOption = (this._focusedOption + 1) % count;
			}
			return;
		}
		if (key === "ArrowUp") {
			if (count > 0) {
				e.preventDefault();
				this._focusedOption = (this._focusedOption - 1 + count) % count;
			}
			return;
		}

		if (key === "Escape") {
			e.preventDefault();
			this._clearActive();
			return;
		}

		if (key === "Enter") {
			// If focus is on the primary (Next/Submit) button, let the native
			// click handler do the work — don't preventDefault or double-fire.
			if (target?.closest?.(".ask-submit")) return;

			// Single-question single-select: Enter picks the focused option and
			// auto-submits (the option pick schedules the submit).
			const q = this.questions[this._activeTab];
			if (q && !q.multi && this.questions.length === 1) {
				const value = this._optionValueAt(this._activeTab, this._focusedOption);
				if (value !== null) {
					e.preventDefault();
					this._selectOption(this._activeTab, value);
					return;
				}
			}

			// Otherwise, act like the primary button if it would be enabled.
			const canAct = this._showNext()
				? this._isQuestionValid(this._activeTab)
				: (this._canSubmit() && !this._submitting);
			if (canAct) {
				e.preventDefault();
				this._clickPrimary();
			}
			return;
		}

		// Number keys 1–9 pick by index on the active question.
		if (/^[1-9]$/.test(key)) {
			const idx = parseInt(key, 10) - 1;
			const value = this._optionValueAt(this._activeTab, idx);
			if (value === null) return; // out-of-range → no-op
			e.preventDefault();
			const q = this.questions[this._activeTab];
			this._focusedOption = idx;
			if (q?.multi) {
				// Multi-select: toggle only, never advance/submit.
				this._selectOption(this._activeTab, value);
				return;
			}
			// Single-select: delegate to _selectOption which handles:
			//   - single-question → auto-submit
			//   - multi-question non-last → auto-advance
			//   - multi-question last or Other → stay put
			this._selectOption(this._activeTab, value);
			return;
		}

		// Letter keys A–Z jump tabs on multi-question asks.
		if (this.questions.length > 1 && /^[A-Za-z]$/.test(key)) {
			const idx = key.toUpperCase().charCodeAt(0) - 65;
			if (idx >= 0 && idx < this.questions.length) {
				e.preventDefault();
				this._selectTab(idx);
				setTimeout(() => {
					const btn = this.querySelector(
						`[role="tab"][data-tab-index="${idx}"]`,
					) as HTMLButtonElement | null;
					btn?.focus();
				}, 0);
			}
			return;
		}
	};

	// ── Rendering ──────────────────────────────────────────────────────

	override render(): TemplateResult | typeof nothing {
		if (this.errored) {
			return html`<div class="ask-error text-xs text-destructive">${this.errorText || "ask_user_choices failed."}</div>`;
		}
		if (!Array.isArray(this.questions) || this.questions.length === 0) return nothing;
		const readOnly = this._isReadOnly();
		const showTabs = this.questions.length > 1;
		const hideSubmit = this._shouldHideSubmit();
		const showNext = !readOnly && this._showNext();
		const primaryDisabled = showNext
			? !this._isQuestionValid(this._activeTab)
			: (!this._canSubmit() || this._submitting);
		const primaryLabel = this._submitting
			? "Submitting…"
			: showNext ? "Next" : "Submit";
		return html`
			<div class="ask-widget border border-border rounded p-3 bg-card" @keydown=${this._onKeydown}>
				${showTabs ? html`
				<div role="tablist" class="flex flex-wrap gap-1 border-b border-border mb-3">
					${this.questions.map((_, i) => this._renderTab(i))}
				</div>` : nothing}
				${this._renderActivePanel(readOnly)}
				${!readOnly && !hideSubmit ? html`
					<div class="mt-3 flex items-center gap-2 justify-end">
						${this._submitError
							? html`<span class="ask-submit-error text-xs text-destructive">${this._submitError}</span>`
							: nothing}
						<button
							type="button"
							class="ask-submit px-3 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-opacity"
							?disabled=${primaryDisabled}
							@click=${this._clickPrimary}>
							${primaryLabel}
						</button>
					</div>` : nothing}
			</div>`;
	}

	private _tabAnswered(idx: number, readOnly: boolean): boolean {
		if (readOnly) return Array.isArray(this.answers) && this.answers[idx] != null;
		const d = this._draft[idx];
		if (!d) return false;
		if (Array.isArray(d.selected)) return d.selected.length > 0;
		return !!d.selected;
	}

	private _renderTab(idx: number): TemplateResult {
		const q = this.questions[idx];
		const isActive = idx === this._activeTab;
		const readOnly = this._isReadOnly();
		const answered = this._tabAnswered(idx, readOnly);
		const rawLabel = (q?.tab_label && q.tab_label.trim()) || q?.question || `Q${idx + 1}`;
		const label = rawLabel.slice(0, 40);
		const cls = [
			"ask-tab px-2 py-1 text-xs rounded-t cursor-pointer border border-b-0",
			isActive ? "bg-background border-border font-medium" : "bg-transparent border-transparent text-muted-foreground hover:text-foreground",
		].join(" ");
		return html`
			<button
				type="button"
				role="tab"
				aria-selected=${isActive ? "true" : "false"}
				aria-controls=${`ask-panel-${this.toolUseId}-${idx}`}
				id=${`ask-tab-${this.toolUseId}-${idx}`}
				data-tab-index=${idx}
				tabindex=${isActive ? "0" : "-1"}
				class=${cls}
				@click=${() => this._selectTab(idx)}>
				<span class="ask-tab-letter font-mono">${tabLetter(idx)}.</span>
				<span class="ask-tab-label ml-1">${label}</span>
				${answered ? html`<span class="ask-tab-check ml-1 text-green-600 dark:text-green-400">✓</span>` : nothing}
			</button>`;
	}

	private _isOptionChecked(qIdx: number, value: string, readOnly: boolean): boolean {
		const q = this.questions[qIdx];
		if (readOnly && Array.isArray(this.answers)) {
			const a = this.answers[qIdx];
			if (!a) return false;
			if (Array.isArray(a.selected)) {
				// Multi-select answer: "Other" round-trips as "Other" (not sentinel).
				if (value === OTHER_SENTINEL) return a.selected.includes("Other");
				return a.selected.includes(value);
			}
			const stored = a.selected === "Other" ? OTHER_SENTINEL : a.selected;
			return stored === value;
		}
		const d = this._draft[qIdx];
		if (!d) return false;
		if (q?.multi) {
			return Array.isArray(d.selected) && d.selected.includes(value);
		}
		return d.selected === value;
	}

	private _renderActivePanel(readOnly: boolean): TemplateResult | typeof nothing {
		const idx = this._activeTab;
		const q = this.questions[idx];
		if (!q) return nothing;
		const answer = readOnly && Array.isArray(this.answers) ? this.answers[idx] : null;
		const draft = this._draft[idx] || { selected: null, other_text: "" };
		const otherChecked = this._isOptionChecked(idx, OTHER_SENTINEL, readOnly);
		const otherText = readOnly && answer && otherChecked
			? (answer.other_text || "")
			: draft.other_text;
		const groupRole = q.multi ? "group" : "radiogroup";

		// Key options by `${idx}::${opt}` so Lit rebuilds option DOM when the
		// active tab changes. Without keying, the <label>/<input> nodes are
		// reused across panels, which on mobile leaves stale radio state (the
		// browser treats the "same" radio as already-interacted-with and the
		// next tap may not fire a `change` event).
		const panelId = `ask-panel-${this.toolUseId}-${idx}`;
		const tabId = `ask-tab-${this.toolUseId}-${idx}`;
		return html`
			<div
				role="tabpanel"
				id=${panelId}
				aria-labelledby=${tabId}
				data-panel-index=${idx}
				class="ask-panel">
				<div class="ask-question text-sm font-medium mb-2">${q.question}</div>
				<div
					class="ask-options flex flex-col gap-1.5"
					role=${groupRole}
					aria-label=${q.question}>
					${repeat(
						q.options,
						(opt) => `${idx}::${opt}`,
						(opt, optIdx) => this._renderOption(idx, opt, optIdx, this._isOptionChecked(idx, opt, readOnly), readOnly),
					)}
					${q.allow_other
						? repeat(
							[OTHER_SENTINEL],
							() => `${idx}::__other__`,
							() => this._renderOtherOption(idx, q.options.length, otherChecked, otherText, readOnly),
						)
						: nothing}
				</div>
			</div>`;
	}

	private _renderOption(
		qIdx: number,
		option: string,
		optIdx: number,
		checked: boolean,
		readOnly: boolean,
	): TemplateResult {
		const q = this.questions[qIdx];
		const multi = !!q?.multi;
		const isFocused = !readOnly && qIdx === this._activeTab && this._focusedOption === optIdx;
		const cls = [
			"ask-option flex items-center gap-2 p-2 text-sm rounded border",
			checked ? "border-primary bg-primary/10" : "border-border",
			isFocused ? "ask-option-focused ring-2 ring-primary/50" : "",
			readOnly ? "cursor-default opacity-90" : "cursor-pointer hover:bg-muted",
		].filter(Boolean).join(" ");
		const role = multi ? "checkbox" : "radio";
		const ariaChecked = checked ? "true" : "false";
		const rovingTabindex = isFocused ? "0" : "-1";
		const inputAttrs = multi
			? html`<input
					type="checkbox"
					class="sr-only"
					value=${option}
					.checked=${checked}
					?disabled=${readOnly}
					@change=${() => this._selectOption(qIdx, option)}>`
			: html`<input
					type="radio"
					class="sr-only"
					name=${`ask-q-${qIdx}-${this.toolUseId}`}
					value=${option}
					.checked=${checked}
					?disabled=${readOnly}
					@change=${() => this._selectOption(qIdx, option)}>`;
		return html`
			<label
				class=${cls}
				role=${role}
				aria-checked=${ariaChecked}
				tabindex=${readOnly ? "-1" : rovingTabindex}
				data-option-index=${optIdx}
				@focus=${() => { if (!readOnly) this._focusedOption = optIdx; }}>
				${inputAttrs}
				<span class="ask-option-index font-mono text-xs text-muted-foreground w-4 text-right select-none" aria-hidden="true">${optIdx + 1}.</span>
				<span class="ask-option-check inline-flex items-center justify-center w-4 h-4 rounded-full border pointer-events-none ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent"}" aria-hidden="true">
					${checked ? html`<span class="ask-check-glyph text-[10px] leading-none">✓</span>` : nothing}
				</span>
				<span class="ask-option-text">${option}</span>
			</label>`;
	}

	private _renderOtherOption(
		qIdx: number,
		optIdx: number,
		checked: boolean,
		otherText: string,
		readOnly: boolean,
	): TemplateResult {
		const q = this.questions[qIdx];
		const multi = !!q?.multi;
		const isFocused = !readOnly && qIdx === this._activeTab && this._focusedOption === optIdx;
		const cls = [
			"ask-option ask-option-other flex items-center gap-2 p-2 text-sm rounded border",
			checked ? "border-primary bg-primary/10" : "border-border",
			isFocused ? "ask-option-focused ring-2 ring-primary/50" : "",
			readOnly ? "cursor-default opacity-90" : "cursor-pointer hover:bg-muted",
		].filter(Boolean).join(" ");
		const role = multi ? "checkbox" : "radio";
		const ariaChecked = checked ? "true" : "false";
		const rovingTabindex = isFocused ? "0" : "-1";
		const inputEl = multi
			? html`<input
					type="checkbox"
					class="sr-only"
					value=${OTHER_SENTINEL}
					.checked=${checked}
					?disabled=${readOnly}
					@change=${() => this._selectOption(qIdx, OTHER_SENTINEL)}>`
			: html`<input
					type="radio"
					class="sr-only"
					name=${`ask-q-${qIdx}-${this.toolUseId}`}
					value=${OTHER_SENTINEL}
					.checked=${checked}
					?disabled=${readOnly}
					@change=${() => this._selectOption(qIdx, OTHER_SENTINEL)}>`;
		return html`
			<label
				class=${cls}
				role=${role}
				aria-checked=${ariaChecked}
				tabindex=${readOnly ? "-1" : rovingTabindex}
				data-option-index=${optIdx}
				@focus=${() => { if (!readOnly) this._focusedOption = optIdx; }}>
				${inputEl}
				<span class="ask-option-index font-mono text-xs text-muted-foreground w-4 text-right select-none" aria-hidden="true">${optIdx + 1}.</span>
				<span class="ask-option-check inline-flex items-center justify-center w-4 h-4 rounded-full border pointer-events-none ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent"}" aria-hidden="true">
					${checked ? html`<span class="ask-check-glyph text-[10px] leading-none">✓</span>` : nothing}
				</span>
				<span class="ask-option-text">Other</span>
				${checked ? html`
					<input
						type="text"
						class="ask-other-input ml-2 flex-1 px-2 py-1 text-xs border border-border rounded bg-background"
						placeholder="Type your answer…"
						.value=${otherText}
						?disabled=${readOnly}
						@input=${(e: Event) => this._setOtherText(qIdx, (e.target as HTMLInputElement).value)}>
				` : nothing}
			</label>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ask-user-choices-widget": AskUserChoicesWidget;
	}
}
