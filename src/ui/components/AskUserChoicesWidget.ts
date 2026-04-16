/**
 * Interactive widget rendered inline in the chat for the `ask_user_choices` tool.
 *
 * - Tabs across the top (one per question).
 * - Options render as radio-style cards.
 * - Selecting a non-"Other" option auto-advances to the next tab.
 * - "Other" (when enabled per question) reveals a text input; does NOT auto-advance.
 * - Submit is disabled until all questions have a valid selection.
 * - Once submitted (or `answers` prop is populated), the widget is read-only.
 */
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { getAuthToken } from "../utils/auth-token.js";

/** Sentinel value for the "Other" option — distinct from any real option text. */
export const OTHER_SENTINEL = "__OTHER__";

export interface AskQuestion {
	question: string;
	options: string[];
	allow_other?: boolean;
}

export interface AskAnswer {
	question: string;
	selected: string;
	other_text: string | null;
}

interface DraftEntry {
	selected: string | null;
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
		window.addEventListener("user-question-answered", this._onExternalAnswer as EventListener);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener("user-question-answered", this._onExternalAnswer as EventListener);
	}

	override willUpdate(changed: Map<string, unknown>): void {
		if (changed.has("questions")) {
			this._ensureDraft();
		}
	}

	private _ensureDraft(): void {
		if (!Array.isArray(this.questions)) return;
		if (this._draft.length !== this.questions.length) {
			this._draft = this.questions.map(() => ({ selected: null, other_text: "" }));
			this._activeTab = Math.min(this._activeTab, Math.max(0, this.questions.length - 1));
		}
	}

	private _onExternalAnswer = (e: Event) => {
		const detail = (e as CustomEvent).detail as { sessionId?: string; toolUseId?: string; answers?: AskAnswer[] } | undefined;
		if (!detail) return;
		if (detail.sessionId === this.sessionId && detail.toolUseId === this.toolUseId && Array.isArray(detail.answers)) {
			this.answers = detail.answers;
		}
	};

	private _selectTab(idx: number): void {
		if (idx < 0 || idx >= this.questions.length) return;
		this._activeTab = idx;
	}

	private _selectOption(qIdx: number, option: string): void {
		if (this._isReadOnly()) return;
		this._draft = this._draft.map((d, i) => i === qIdx ? { ...d, selected: option } : d);
		// Auto-advance unless "Other" was selected or this is the last question.
		if (option !== OTHER_SENTINEL && qIdx < this.questions.length - 1) {
			this._activeTab = qIdx + 1;
		}
	}

	private _setOtherText(qIdx: number, text: string): void {
		if (this._isReadOnly()) return;
		this._draft = this._draft.map((d, i) => i === qIdx ? { ...d, other_text: text } : d);
	}

	private _canSubmit(): boolean {
		if (this._draft.length !== this.questions.length) return false;
		return this._draft.every((d) => {
			if (!d.selected) return false;
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
			const isOther = d.selected === OTHER_SENTINEL;
			return {
				question: q.question,
				selected: isOther ? "Other" : (d.selected || ""),
				other_text: isOther ? d.other_text.trim() : null,
			};
		});
		try {
			const token = await getAuthToken();
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

	private _renderTab(idx: number): TemplateResult {
		const q = this.questions[idx];
		const isActive = idx === this._activeTab;
		const readOnly = this._isReadOnly();
		const answered = readOnly
			? Array.isArray(this.answers) && this.answers[idx] != null
			: !!this._draft[idx]?.selected;
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

	private _renderActivePanel(readOnly: boolean): TemplateResult | typeof nothing {
		const idx = this._activeTab;
		const q = this.questions[idx];
		if (!q) return nothing;
		const answer = readOnly && Array.isArray(this.answers) ? this.answers[idx] : null;
		const draft = this._draft[idx] || { selected: null, other_text: "" };
		const selected = readOnly && answer
			? (answer.selected === "Other" ? OTHER_SENTINEL : answer.selected)
			: draft.selected;
		const otherText = readOnly && answer && answer.selected === "Other"
			? (answer.other_text || "")
			: draft.other_text;

		return html`
			<div role="tabpanel" data-panel-index=${idx} class="ask-panel">
				<div class="ask-question text-sm font-medium mb-2">${q.question}</div>
				<div class="ask-options flex flex-col gap-1.5">
					${q.options.map(opt => this._renderOption(idx, opt, selected === opt, readOnly))}
					${q.allow_other ? this._renderOtherOption(idx, selected === OTHER_SENTINEL, otherText, readOnly) : nothing}
				</div>
			</div>`;
	}

	private _renderOption(qIdx: number, option: string, checked: boolean, readOnly: boolean): TemplateResult {
		const cls = [
			"ask-option flex items-center gap-2 p-2 text-sm rounded border",
			checked ? "border-primary bg-primary/10" : "border-border",
			readOnly ? "cursor-default opacity-90" : "cursor-pointer hover:bg-muted",
		].join(" ");
		return html`
			<label class=${cls}>
				<input
					type="radio"
					name=${`ask-q-${qIdx}-${this.toolUseId}`}
					value=${option}
					.checked=${checked}
					?disabled=${readOnly}
					@change=${() => this._selectOption(qIdx, option)}>
				<span class="ask-option-text">${option}</span>
			</label>`;
	}

	private _renderOtherOption(qIdx: number, checked: boolean, otherText: string, readOnly: boolean): TemplateResult {
		const cls = [
			"ask-option ask-option-other flex items-center gap-2 p-2 text-sm rounded border",
			checked ? "border-primary bg-primary/10" : "border-border",
			readOnly ? "cursor-default opacity-90" : "cursor-pointer hover:bg-muted",
		].join(" ");
		return html`
			<label class=${cls}>
				<input
					type="radio"
					name=${`ask-q-${qIdx}-${this.toolUseId}`}
					value=${OTHER_SENTINEL}
					.checked=${checked}
					?disabled=${readOnly}
					@change=${() => this._selectOption(qIdx, OTHER_SENTINEL)}>
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
