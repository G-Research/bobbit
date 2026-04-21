/**
 * Interactive widget rendered inline in the chat for the `ask_user_choices` tool.
 *
 * - Tabs across the top (one per question).
 * - Options render as radio/checkbox cards. The native input is visually hidden
 *   (sr-only) and card styling (border-primary + a ✓ badge) signals selection.
 * - Single-select: selecting a non-"Other" option auto-advances to the next tab.
 * - Multi-select (`multi: true`): checkboxes; no auto-advance.
 * - "Other" (when enabled) reveals a text input; does NOT auto-advance.
 * - Submit is disabled until every question has a valid selection (respecting
 *   min/max for multi-select).
 * - Once submitted (or `answers` prop is populated), the widget is read-only.
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
		}
	}

	private _selectTab(idx: number): void {
		if (idx < 0 || idx >= this.questions.length) return;
		this._activeTab = idx;
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
		// Auto-advance unless "Other" was selected or this is the last question.
		// Defer one tick so the current touch/click gesture settles on the Q1
		// label before Q2 mounts — otherwise mobile browsers can deliver the
		// synthetic click to the freshly-rendered Q2 option at the same
		// coordinates ("ghost click") and either pre-select or swallow the
		// user's intended first real tap on Q2.
		if (option !== OTHER_SENTINEL && qIdx < this.questions.length - 1) {
			const nextIdx = qIdx + 1;
			setTimeout(() => {
				if (this._activeTab === qIdx) this._activeTab = nextIdx;
			}, 250);
		}
	}

	private _setOtherText(qIdx: number, text: string): void {
		if (this._isReadOnly()) return;
		this._draft = this._draft.map((d, i) => i === qIdx ? { ...d, other_text: text } : d);
	}

	private _canSubmit(): boolean {
		if (this._draft.length !== this.questions.length) return false;
		return this._draft.every((d, i) => {
			const q = this.questions[i];
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
		});
	}

	private _isReadOnly(): boolean {
		return Array.isArray(this.answers) || this.errored;
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

	// ── Rendering ──────────────────────────────────────────────────────

	override render(): TemplateResult | typeof nothing {
		if (this.errored) {
			return html`<div class="text-xs text-destructive">${this.errorText || "ask_user_choices failed."}</div>`;
		}
		if (!Array.isArray(this.questions) || this.questions.length === 0) return nothing;
		const readOnly = this._isReadOnly();
		return html`
			<div class="ask-widget border border-border rounded p-3 bg-card">
				<div role="tablist" class="flex flex-wrap gap-1 border-b border-border mb-3">
					${this.questions.map((_, i) => this._renderTab(i))}
				</div>
				${this._renderActivePanel(readOnly)}
				${!readOnly ? html`
					<div class="mt-3 flex items-center gap-2 justify-end">
						${this._submitError
							? html`<span class="ask-submit-error text-xs text-destructive">${this._submitError}</span>`
							: nothing}
						<button
							type="button"
							class="ask-submit px-3 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-opacity"
							?disabled=${!this._canSubmit() || this._submitting}
							@click=${this._submit}>
							${this._submitting ? "Submitting…" : "Submit"}
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
		const label = (q?.question || `Q${idx + 1}`).slice(0, 40);
		const cls = [
			"ask-tab px-2 py-1 text-xs rounded-t cursor-pointer border border-b-0",
			isActive ? "bg-background border-border font-medium" : "bg-transparent border-transparent text-muted-foreground hover:text-foreground",
		].join(" ");
		return html`
			<button
				type="button"
				role="tab"
				aria-selected=${isActive ? "true" : "false"}
				data-tab-index=${idx}
				class=${cls}
				@click=${() => this._selectTab(idx)}>
				<span class="ask-tab-index">${idx + 1}.</span>
				<span class="ask-tab-label">${label}</span>
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

		// Key options by `${idx}::${opt}` so Lit rebuilds option DOM when the
		// active tab changes. Without keying, the <label>/<input> nodes are
		// reused across panels, which on mobile leaves stale radio state (the
		// browser treats the "same" radio as already-interacted-with and the
		// next tap may not fire a `change` event).
		return html`
			<div role="tabpanel" data-panel-index=${idx} class="ask-panel">
				<div class="ask-question text-sm font-medium mb-2">${q.question}</div>
				<div class="ask-options flex flex-col gap-1.5">
					${repeat(
						q.options,
						(opt) => `${idx}::${opt}`,
						(opt) => this._renderOption(idx, opt, this._isOptionChecked(idx, opt, readOnly), readOnly),
					)}
					${q.allow_other
						? repeat(
							[OTHER_SENTINEL],
							() => `${idx}::__other__`,
							() => this._renderOtherOption(idx, otherChecked, otherText, readOnly),
						)
						: nothing}
				</div>
			</div>`;
	}

	private _renderOption(qIdx: number, option: string, checked: boolean, readOnly: boolean): TemplateResult {
		const q = this.questions[qIdx];
		const multi = !!q?.multi;
		const cls = [
			"ask-option flex items-center gap-2 p-2 text-sm rounded border",
			checked ? "border-primary bg-primary/10" : "border-border",
			readOnly ? "cursor-default opacity-90" : "cursor-pointer hover:bg-muted",
		].join(" ");
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
			<label class=${cls}>
				${inputAttrs}
				<span class="ask-option-check inline-flex items-center justify-center w-4 h-4 rounded-full border pointer-events-none ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent"}" aria-hidden="true">
					${checked ? html`<span class="ask-check-glyph text-[10px] leading-none">✓</span>` : nothing}
				</span>
				<span class="ask-option-text">${option}</span>
			</label>`;
	}

	private _renderOtherOption(qIdx: number, checked: boolean, otherText: string, readOnly: boolean): TemplateResult {
		const q = this.questions[qIdx];
		const multi = !!q?.multi;
		const cls = [
			"ask-option ask-option-other flex items-center gap-2 p-2 text-sm rounded border",
			checked ? "border-primary bg-primary/10" : "border-border",
			readOnly ? "cursor-default opacity-90" : "cursor-pointer hover:bg-muted",
		].join(" ");
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
			<label class=${cls}>
				${inputEl}
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
