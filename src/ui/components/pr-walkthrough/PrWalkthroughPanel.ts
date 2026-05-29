import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { buildPrWalkthroughDraft, cardRequiresCommentForDislike, defaultDiffModeForWidth, type PrWalkthroughCard, type PrWalkthroughChangesetRef, type PrWalkthroughComment, type PrWalkthroughDecision, type PrWalkthroughDiffBlock, type PrWalkthroughDiffLine, type PrWalkthroughDiffMode, type PrWalkthroughPhaseId, type PrWalkthroughReviewDraft, type PrWalkthroughSuggestedComment } from "./types.js";
import { fixturePrWalkthroughChangeset, getFixturePrWalkthroughCards } from "./fixtures.js";

const PHASES: Array<{ id: PrWalkthroughPhaseId; label: string }> = [
	{ id: "orientation", label: "Orientation" },
	{ id: "design", label: "Key design choices" },
	{ id: "significant", label: "Significant changes" },
	{ id: "other", label: "Other + omissions" },
	{ id: "audit", label: "Audit" },
];

interface SideBySidePair {
	left: PrWalkthroughDiffLine | null;
	right: PrWalkthroughDiffLine | null;
}

@customElement("pr-walkthrough-panel")
export class PrWalkthroughPanel extends LitElement {
	@property({ attribute: false }) changeset?: PrWalkthroughChangesetRef;
	@property({ attribute: false }) cards: PrWalkthroughCard[] = getFixturePrWalkthroughCards();
	@property({ type: Boolean, reflect: true }) narrow = false;

	@state() private _activeCardId = "";
	@state() private _panelWidth = 1024;
	@state() private _observedNarrow = false;
	@state() private _diffModeOverride?: PrWalkthroughDiffMode;
	@state() private _comments: PrWalkthroughComment[] = [];
	@state() private _decisions: Record<string, PrWalkthroughDecision> = {};
	@state() private _completedCardIds: string[] = [];
	@state() private _editingLineKey?: string;
	@state() private _lineDrafts: Record<string, string> = {};
	@state() private _cardDrafts: Record<string, string> = {};
	@state() private _dismissedSuggestionIds: string[] = [];
	@state() private _copied = false;

	private _resizeObserver?: ResizeObserver;

	static override styles = css`
		:host {
			display: block;
			height: 100%;
			min-height: 0;
			color: var(--foreground, CanvasText);
			background: var(--background, Canvas);
			font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}

		* { box-sizing: border-box; }
		button, textarea { font: inherit; }
		button { cursor: pointer; }
		button:disabled { cursor: not-allowed; opacity: 0.55; }

		.shell {
			display: grid;
			grid-template-rows: auto 1fr;
			height: 100%;
			min-height: 0;
		}

		.header {
			display: grid;
			gap: 12px;
			padding: 16px;
			border-bottom: 1px solid var(--border, ButtonBorder);
			background: color-mix(in oklch, var(--card, Canvas) 94%, var(--background, Canvas));
		}

		.title-row {
			display: flex;
			gap: 12px;
			align-items: flex-start;
			justify-content: space-between;
		}

		.title { margin: 0; font-size: 16px; line-height: 1.2; }
		.meta { color: var(--muted-foreground, GrayText); font-size: 12px; margin-top: 4px; }
		.progress-wrap { display: grid; gap: 6px; min-width: 170px; }
		.progress-label { color: var(--muted-foreground, GrayText); font-size: 12px; text-align: right; }
		.progress-track { height: 7px; overflow: hidden; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground, GrayText) 18%, transparent); }
		.progress-fill { height: 100%; border-radius: inherit; background: var(--primary, Highlight); transition: width 160ms ease; }

		.mode-toggle {
			display: inline-flex;
			width: fit-content;
			padding: 3px;
			gap: 2px;
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 10px;
			background: var(--card, Canvas);
		}

		.mode-toggle button,
		.rail button,
		.actions button,
		.comment-actions button,
		.suggestion button,
		.copy-button {
			border: 1px solid transparent;
			border-radius: 8px;
			background: transparent;
			color: inherit;
			transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
		}

		.mode-toggle button { padding: 5px 10px; color: var(--muted-foreground, GrayText); }
		.mode-toggle button.active { color: var(--primary, Highlight); background: color-mix(in oklch, var(--primary, Highlight) 13%, transparent); border-color: color-mix(in oklch, var(--primary, Highlight) 28%, transparent); }

		.body {
			display: grid;
			grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
			min-height: 0;
		}

		.body.narrow { grid-template-columns: 44px minmax(0, 1fr); }

		.rail {
			overflow: auto;
			padding: 12px;
			border-right: 1px solid var(--border, ButtonBorder);
			background: color-mix(in oklch, var(--card, Canvas) 82%, var(--background, Canvas));
		}

		.phase { display: grid; gap: 6px; margin-bottom: 14px; }
		.phase-button {
			width: 100%;
			padding: 8px 10px;
			text-align: left;
			font-weight: 650;
			color: var(--muted-foreground, GrayText);
		}
		.phase-button.active, .phase-button:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--primary, Highlight) 10%, transparent); }
		.card-button {
			width: 100%;
			padding: 7px 10px 7px 22px;
			text-align: left;
			color: var(--muted-foreground, GrayText);
			position: relative;
		}
		.card-button::before {
			content: "";
			position: absolute;
			left: 8px;
			top: 14px;
			width: 6px;
			height: 6px;
			border-radius: 999px;
			background: color-mix(in oklch, var(--muted-foreground, GrayText) 50%, transparent);
		}
		.card-button.complete::before { background: var(--positive, var(--primary, Highlight)); }
		.card-button.active { color: var(--foreground, CanvasText); border-color: color-mix(in oklch, var(--primary, Highlight) 28%, transparent); background: color-mix(in oklch, var(--primary, Highlight) 12%, transparent); }
		.card-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.card-decision { color: var(--muted-foreground, GrayText); font-size: 11px; }

		.rail.collapsed {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 14px;
			padding: 12px 6px;
		}
		.collapsed-phase { display: grid; justify-items: center; gap: 6px; }
		.phase-pip {
			width: 12px;
			height: 12px;
			border-radius: 999px;
			border: 2px solid color-mix(in oklch, var(--muted-foreground, GrayText) 40%, transparent);
			background: var(--background, Canvas);
		}
		.phase-pip.active { border-color: var(--primary, Highlight); background: color-mix(in oklch, var(--primary, Highlight) 24%, transparent); }
		.card-dot {
			width: 20px;
			height: 20px;
			padding: 0;
			border-radius: 999px;
			border-color: var(--border, ButtonBorder);
			background: var(--card, Canvas);
		}
		.card-dot.complete { background: color-mix(in oklch, var(--positive, var(--primary, Highlight)) 22%, transparent); border-color: var(--positive, var(--primary, Highlight)); }
		.card-dot.active { background: var(--primary, Highlight); border-color: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); transform: scale(1.06); }

		.content {
			overflow: auto;
			min-width: 0;
			padding: 16px;
		}

		.empty {
			padding: 24px;
			border: 1px dashed var(--border, ButtonBorder);
			border-radius: 14px;
			color: var(--muted-foreground, GrayText);
		}

		.card {
			display: grid;
			gap: 16px;
			max-width: 1180px;
		}
		.card-head {
			display: grid;
			gap: 8px;
			padding: 16px;
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 14px;
			background: var(--card, Canvas);
		}
		.phase-label { color: var(--primary, Highlight); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
		.card h2 { margin: 0; font-size: 20px; line-height: 1.2; }
		.summary, .rationale { margin: 0; color: var(--muted-foreground, GrayText); }
		.checklist { margin: 4px 0 0; padding-left: 18px; color: var(--muted-foreground, GrayText); }

		.diff-block {
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 12px;
			overflow: hidden;
			background: var(--card, Canvas);
		}
		.diff-file-header {
			padding: 8px 12px;
			border-bottom: 1px solid var(--border, ButtonBorder);
			font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
			color: var(--muted-foreground, GrayText);
			background: color-mix(in oklch, var(--muted-foreground, GrayText) 8%, transparent);
		}
		.diff-overflow { overflow-x: auto; overflow-y: hidden; }
		.hunk-header {
			padding: 6px 10px;
			min-width: max-content;
			font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
			color: var(--info, var(--primary, Highlight));
			background: color-mix(in oklch, var(--info, var(--primary, Highlight)) 10%, transparent);
		}
		.split-grid { min-width: 820px; }
		.split-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			min-width: max-content;
		}
		.inline-lines { min-width: 620px; }
		.diff-line {
			width: 100%;
			min-height: 24px;
			padding: 0;
			border: 0;
			border-radius: 0;
			display: grid;
			grid-template-columns: 54px 24px minmax(280px, 1fr) 72px;
			align-items: stretch;
			text-align: left;
			font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
			color: var(--foreground, CanvasText);
			background: transparent;
		}
		.diff-line.empty { pointer-events: none; color: transparent; }
		.diff-line:hover, .diff-line:focus-visible { outline: none; box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary, Highlight) 38%, transparent); }
		.diff-line.add { background: color-mix(in oklch, var(--positive, var(--chart-2, var(--primary, Highlight))) 15%, transparent); }
		.diff-line.del { background: color-mix(in oklch, var(--negative, var(--chart-5, var(--primary, Highlight))) 13%, transparent); }
		.line-no, .prefix, .comment-cue { padding: 3px 6px; color: var(--muted-foreground, GrayText); user-select: none; }
		.line-text { padding: 3px 8px; white-space: pre; }
		.comment-cue { opacity: 0; font-family: inherit; }
		.diff-line:hover .comment-cue, .diff-line:focus-visible .comment-cue { opacity: 1; }
		.line-comments, .line-editor, .suggestions { display: grid; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border, ButtonBorder); background: color-mix(in oklch, var(--card, Canvas) 88%, var(--background, Canvas)); }
		.comment, .suggestion {
			padding: 8px 10px;
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 10px;
			background: var(--background, Canvas);
		}
		.comment-meta { margin-bottom: 4px; color: var(--muted-foreground, GrayText); font-size: 11px; }
		.comment-body { white-space: pre-wrap; }
		.comment-actions, .suggestion-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
		.comment-actions button, .suggestion button, .copy-button { padding: 4px 8px; border-color: var(--border, ButtonBorder); color: var(--muted-foreground, GrayText); }
		.comment-actions button:hover, .suggestion button:hover, .copy-button:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--primary, Highlight) 10%, transparent); }
		.comment-actions button.delete:hover, .suggestion button.delete:hover { color: var(--negative, Mark); background: color-mix(in oklch, var(--negative, Mark) 12%, transparent); }

		textarea {
			width: 100%;
			min-height: 72px;
			resize: vertical;
			padding: 10px;
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 10px;
			background: var(--background, Canvas);
			color: var(--foreground, CanvasText);
		}
		textarea:focus { outline: 2px solid color-mix(in oklch, var(--primary, Highlight) 45%, transparent); outline-offset: 1px; }

		.card-comments {
			display: grid;
			gap: 10px;
			padding: 14px;
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 12px;
			background: var(--card, Canvas);
		}
		.card-comments h3, .audit h3 { margin: 0; font-size: 14px; }

		.actions {
			display: flex;
			gap: 10px;
			align-items: center;
			justify-content: flex-end;
			position: sticky;
			bottom: 0;
			padding: 12px 0 0;
			background: linear-gradient(transparent, var(--background, Canvas) 30%);
		}
		.actions button { padding: 9px 14px; border-color: var(--border, ButtonBorder); background: var(--card, Canvas); }
		.actions button:hover:not(:disabled), .actions button:focus-visible:not(:disabled) { background: color-mix(in oklch, var(--primary, Highlight) 10%, transparent); }
		.actions .like {
			border-color: var(--primary, Highlight);
			background: var(--primary, Highlight);
			color: var(--primary-foreground, HighlightText);
			font-weight: 700;
		}
		.actions .like:hover:not(:disabled), .actions .like:focus-visible:not(:disabled) { filter: brightness(1.04); }
		.actions .dislike.enabled:hover, .actions .dislike.enabled:focus-visible { color: var(--negative, Mark); border-color: var(--negative, Mark); background: color-mix(in oklch, var(--negative, Mark) 12%, transparent); }
		.decision-note { margin-right: auto; color: var(--muted-foreground, GrayText); font-size: 12px; }

		.audit {
			display: grid;
			gap: 12px;
			padding: 16px;
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 14px;
			background: var(--card, Canvas);
		}
		.audit pre {
			margin: 0;
			padding: 14px;
			overflow: auto;
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 10px;
			background: var(--background, Canvas);
			white-space: pre-wrap;
			font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		}

		@media (max-width: 760px) {
			.header { padding: 12px; }
			.title-row { display: grid; }
			.progress-wrap { min-width: 0; }
			.progress-label { text-align: left; }
			.content { padding: 12px; }
		}
	`;

	override connectedCallback(): void {
		super.connectedCallback();
		this._resizeObserver = new ResizeObserver(entries => {
			const width = entries[0]?.contentRect.width ?? this.clientWidth;
			this._panelWidth = width;
			this._observedNarrow = width < 760;
		});
		this._resizeObserver.observe(this);
	}

	override disconnectedCallback(): void {
		this._resizeObserver?.disconnect();
		super.disconnectedCallback();
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("cards") || !this._activeCardId) {
			const firstCard = this.reviewCards[0] ?? this.cards[0];
			if (firstCard && !this.cards.some(card => card.id === this._activeCardId)) {
				this._activeCardId = firstCard.id;
			}
		}
	}

	private get effectiveChangeset(): PrWalkthroughChangesetRef {
		return this.changeset ?? fixturePrWalkthroughChangeset;
	}

	private get isNarrowLayout(): boolean {
		return this.narrow || this._observedNarrow;
	}

	private get effectiveDiffMode(): PrWalkthroughDiffMode {
		return this._diffModeOverride ?? defaultDiffModeForWidth(this.isNarrowLayout ? 0 : this._panelWidth);
	}

	private get reviewCards(): PrWalkthroughCard[] {
		return this.cards.filter(card => card.phaseId !== "audit");
	}

	private get activeCard(): PrWalkthroughCard | undefined {
		return this.cards.find(card => card.id === this._activeCardId) ?? this.reviewCards[0] ?? this.cards[0];
	}

	private get currentDraft(): PrWalkthroughReviewDraft {
		return buildPrWalkthroughDraft({
			changeset: this.effectiveChangeset,
			decisions: this._decisions,
			comments: this._comments,
			completedCardIds: this._completedCardIds,
		});
	}

	override render(): TemplateResult {
		const active = this.activeCard;
		if (!active) {
			return html`<section class="shell" data-testid="pr-walkthrough-panel"><div class="empty">No walkthrough cards are available.</div></section>`;
		}

		return html`
			<section class="shell" data-testid="pr-walkthrough-panel">
				${this.renderHeader()}
				<div class="body ${this.isNarrowLayout ? "narrow" : ""}">
					${this.renderRail()}
					<main class="content">${active.phaseId === "audit" ? this.renderAudit(active) : this.renderCard(active)}</main>
				</div>
			</section>
		`;
	}

	private renderHeader(): TemplateResult {
		const changeset = this.effectiveChangeset;
		const completed = this._completedCardIds.filter(id => this.reviewCards.some(card => card.id === id)).length;
		const total = Math.max(this.reviewCards.length, 1);
		const percent = Math.round((completed / total) * 100);
		return html`
			<header class="header">
				<div class="title-row">
					<div>
						<h1 class="title">${changeset.title ?? "PR walkthrough"}</h1>
						<div class="meta">${changeset.provider ? `${changeset.provider} · ` : ""}${changeset.baseSha} → ${changeset.headSha}${changeset.externalUrl ? ` · ${changeset.externalUrl}` : ""}</div>
					</div>
					<div class="progress-wrap" aria-label="Walkthrough progress">
						<div class="progress-label">${completed}/${this.reviewCards.length} cards complete</div>
						<div class="progress-track"><div class="progress-fill" style="width: ${percent}%"></div></div>
					</div>
				</div>
				<div class="mode-toggle" aria-label="Diff mode">
					<button id="diff-mode-split" data-testid="diff-mode-split" class=${this.effectiveDiffMode === "split" ? "active" : ""} type="button" aria-pressed=${this.effectiveDiffMode === "split"} @click=${() => this.setDiffMode("split")}>Split</button>
					<button id="diff-mode-inline" data-testid="diff-mode-inline" class=${this.effectiveDiffMode === "inline" ? "active" : ""} type="button" aria-pressed=${this.effectiveDiffMode === "inline"} @click=${() => this.setDiffMode("inline")}>Inline</button>
				</div>
			</header>
		`;
	}

	private renderRail(): TemplateResult {
		return this.isNarrowLayout ? this.renderCollapsedRail() : this.renderLabelledRail();
	}

	private renderLabelledRail(): TemplateResult {
		return html`
			<nav class="rail" data-testid="walkthrough-rail" aria-label="PR walkthrough phases">
				${PHASES.map(phase => {
					const cards = this.cardsForPhase(phase.id);
					if (cards.length === 0) return nothing;
					const phaseActive = cards.some(card => card.id === this.activeCard?.id);
					return html`
						<section class="phase">
							<button class="phase-button ${phaseActive ? "active" : ""}" type="button" @click=${() => this.selectCard(cards[0].id)}>${phase.label} · ${cards.length}</button>
							${cards.map(card => this.renderRailCardButton(card))}
						</section>
					`;
				})}
			</nav>
		`;
	}

	private renderCollapsedRail(): TemplateResult {
		return html`
			<nav class="rail collapsed" data-testid="walkthrough-rail-collapsed" aria-label="PR walkthrough phases">
				${PHASES.map(phase => {
					const cards = this.cardsForPhase(phase.id);
					if (cards.length === 0) return nothing;
					const phaseActive = cards.some(card => card.id === this.activeCard?.id);
					return html`
						<div class="collapsed-phase" title=${phase.label}>
							<button class="phase-pip ${phaseActive ? "active" : ""}" type="button" aria-label=${`Open ${phase.label}`} title=${phase.label} @click=${() => this.selectCard(cards[0].id)}></button>
							${cards.map(card => html`
								<button
									class="card-dot ${card.id === this.activeCard?.id ? "active" : ""} ${this._completedCardIds.includes(card.id) ? "complete" : ""}"
									data-testid="walkthrough-card-dot"
									type="button"
									aria-label=${`Open ${phase.label}: ${card.title}`}
									title=${`${phase.label}: ${card.title}`}
									@click=${() => this.selectCard(card.id)}
								>${this._decisionGlyph(card.id)}</button>
							`)}
						</div>
					`;
				})}
			</nav>
		`;
	}

	private renderRailCardButton(card: PrWalkthroughCard): TemplateResult {
		const decision = this._decisions[card.id]?.value;
		return html`
			<button class="card-button ${card.id === this.activeCard?.id ? "active" : ""} ${this._completedCardIds.includes(card.id) ? "complete" : ""}" type="button" @click=${() => this.selectCard(card.id)}>
				<span class="card-title">${card.title}</span>
				<span class="card-decision">${decision ? decision : card.phaseId === "audit" ? "draft" : "pending"}</span>
			</button>
		`;
	}

	private renderCard(card: PrWalkthroughCard): TemplateResult {
		const phase = PHASES.find(item => item.id === card.phaseId)?.label ?? card.phaseId;
		const dislikeDisabled = cardRequiresCommentForDislike({ comments: this._comments }, card.id);
		return html`
			<article class="card">
				<section class="card-head">
					<div class="phase-label">${phase}</div>
					<h2>${card.title}</h2>
					<p class="summary">${card.summary}</p>
					${card.rationale ? html`<p class="rationale">${card.rationale}</p>` : nothing}
					${card.checklist?.length ? html`<ul class="checklist">${card.checklist.map(item => html`<li>${item}</li>`)}</ul>` : nothing}
				</section>
				${card.diffBlocks.map(block => this.renderDiffBlock(card, block))}
				${this.renderCardComments(card)}
				<div class="actions">
					<span class="decision-note">${this._decisions[card.id] ? `Current: ${this._decisions[card.id].value}` : dislikeDisabled ? "Add a comment to enable Dislike." : "Ready for a decision."}</span>
					<button data-testid="walkthrough-prev" type="button" @click=${this.goPrev} ?disabled=${!this.previousCardId()}>Prev</button>
					<button data-testid="walkthrough-dislike" class="dislike ${dislikeDisabled ? "" : "enabled"}" type="button" ?disabled=${dislikeDisabled} @click=${() => this.recordDecision(card, "disliked")}>Dislike</button>
					<button data-testid="walkthrough-like" class="like" type="button" @click=${() => this.recordDecision(card, "liked")}>Like</button>
				</div>
			</article>
		`;
	}

	private renderDiffBlock(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		return html`
			<section class="diff-block">
				<div class="diff-file-header">${block.oldPath && block.oldPath !== block.filePath ? `${block.oldPath} → ${block.filePath}` : block.filePath}</div>
				${this.effectiveDiffMode === "split" ? this.renderSplitDiff(card, block) : this.renderInlineDiff(card, block)}
			</section>
		`;
	}

	private renderSplitDiff(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		return html`
			<div class="diff-overflow">
				<div class="split-grid">
					${block.hunks.map(hunk => html`
						<div class="hunk-header">${hunk.header}</div>
						${this.buildSideBySidePairs(hunk.lines).map(pair => html`
							<div class="split-row">
								${this.renderDiffLine(card, block, pair.left, "old")}
								${this.renderDiffLine(card, block, pair.right, "new")}
							</div>
							${this.renderLineDetails(card, block, pair.left ?? pair.right)}
						`)}
					`)}
				</div>
			</div>
		`;
	}

	private renderInlineDiff(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		return html`
			<div class="diff-overflow">
				<div class="inline-lines">
					${block.hunks.map(hunk => html`
						<div class="hunk-header">${hunk.header}</div>
						${hunk.lines.map(line => html`${this.renderDiffLine(card, block, line, "inline")}${this.renderLineDetails(card, block, line)}`)}
					`)}
				</div>
			</div>
		`;
	}

	private renderDiffLine(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock, line: PrWalkthroughDiffLine | null, column: "old" | "new" | "inline"): TemplateResult {
		if (!line) {
			return html`<div class="diff-line empty"><span></span><span></span><span></span><span></span></div>`;
		}
		const lineNo = column === "old" ? line.oldLine : column === "new" ? line.newLine : line.newLine ?? line.oldLine;
		const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
		return html`
			<button
				class="diff-line ${line.kind}"
				data-testid="walkthrough-diff-line"
				type="button"
				aria-label=${`Comment on ${block.filePath} line ${lineNo ?? "context"}`}
				@click=${() => this.openLineEditor(card.id, block.id, line.id)}
			>
				<span class="line-no">${lineNo ?? ""}</span>
				<span class="prefix">${prefix}</span>
				<span class="line-text">${line.text}</span>
				<span class="comment-cue">Comment</span>
			</button>
		`;
	}

	private renderLineDetails(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock, line: PrWalkthroughDiffLine | null): TemplateResult | typeof nothing {
		if (!line) return nothing;
		const comments = this.commentsForLine(card.id, block.id, line.id);
		const suggestions = this.pendingSuggestionsForLine(card, block.id, line.id);
		const key = this.lineKey(card.id, block.id, line.id);
		return html`
			${suggestions.length ? html`<div class="suggestions">${suggestions.map(suggestion => this.renderSuggestion(suggestion))}</div>` : nothing}
			${comments.length ? html`<div class="line-comments">${comments.map(comment => this.renderComment(comment, "line"))}</div>` : nothing}
			${this._editingLineKey === key ? html`
				<div class="line-editor">
					<textarea data-testid="line-comment-editor" .value=${this._lineDrafts[key] ?? ""} placeholder="Add a line comment…" @input=${(event: InputEvent) => this.updateLineDraft(key, event)}></textarea>
					<div class="comment-actions">
						<button type="button" @click=${() => this.saveLineComment(card.id, block.id, line.id)}>Save comment</button>
						<button type="button" @click=${() => this.closeLineEditor()}>Cancel</button>
					</div>
				</div>
			` : nothing}
		`;
	}

	private renderSuggestion(suggestion: PrWalkthroughSuggestedComment): TemplateResult {
		return html`
			<div class="suggestion">
				<div class="comment-meta">LLM suggested line comment</div>
				<div class="comment-body">${suggestion.body}</div>
				<div class="suggestion-actions">
					<button type="button" @click=${() => this.acceptSuggestion(suggestion, false)}>Accept</button>
					<button type="button" @click=${() => this.acceptSuggestion(suggestion, true)}>Edit</button>
					<button class="delete" type="button" @click=${() => this.dismissSuggestion(suggestion.id)}>Delete</button>
				</div>
			</div>
		`;
	}

	private renderCardComments(card: PrWalkthroughCard): TemplateResult {
		const key = `card:${card.id}`;
		const comments = this._comments.filter(comment => comment.cardId === card.id && !comment.diffBlockId && !comment.lineId);
		return html`
			<section class="card-comments">
				<h3>Card-level comments</h3>
				<textarea data-testid="card-comment-editor" .value=${this._cardDrafts[card.id] ?? ""} placeholder="Add a broad concern or note for this card…" @input=${(event: InputEvent) => this.updateCardDraft(card.id, event)}></textarea>
				<div class="comment-actions">
					<button type="button" @click=${() => this.saveCardComment(card.id)}>Save card comment</button>
					${this._cardDrafts[card.id] ? html`<button type="button" @click=${() => this.clearCardDraft(card.id)}>Clear</button>` : nothing}
				</div>
				${comments.length ? html`<div class="line-comments" aria-label=${key}>${comments.map(comment => this.renderComment(comment, "card"))}</div>` : nothing}
			</section>
		`;
	}

	private renderComment(comment: PrWalkthroughComment, scope: "line" | "card"): TemplateResult {
		return html`
			<div class="comment">
				<div class="comment-meta">${comment.source === "suggested" ? "Accepted suggestion" : scope === "line" ? "Line comment" : "Card comment"}</div>
				<div class="comment-body">${comment.body}</div>
				<div class="comment-actions">
					<button type="button" @click=${() => this.editComment(comment)}>Edit</button>
					<button class="delete" type="button" @click=${() => this.deleteComment(comment.id)}>Delete</button>
				</div>
			</div>
		`;
	}

	private renderAudit(card: PrWalkthroughCard): TemplateResult {
		const draftText = this.buildAuditText();
		return html`
			<article class="card">
				<section class="card-head">
					<div class="phase-label">Audit</div>
					<h2>${card.title}</h2>
					<p class="summary">${card.summary}</p>
				</section>
				<section class="audit">
					<h3>Draft review</h3>
					<pre data-testid="walkthrough-audit-draft">${draftText}</pre>
					<div class="comment-actions">
						<button class="copy-button" type="button" @click=${() => this.copyAudit(draftText)}>${this._copied ? "Copied" : "Copy draft"}</button>
					</div>
				</section>
				<div class="actions">
					<span class="decision-note">Review draft updates as you revise previous cards.</span>
					<button data-testid="walkthrough-prev" type="button" @click=${this.goPrev}>Prev</button>
				</div>
			</article>
		`;
	}

	private cardsForPhase(phaseId: PrWalkthroughPhaseId): PrWalkthroughCard[] {
		return this.cards.filter(card => card.phaseId === phaseId);
	}

	private selectCard(cardId: string): void {
		this._activeCardId = cardId;
		this._editingLineKey = undefined;
	}

	private setDiffMode(mode: PrWalkthroughDiffMode): void {
		this._diffModeOverride = mode;
	}

	private previousCardId(): string | undefined {
		const all = this.cards;
		const index = all.findIndex(card => card.id === this.activeCard?.id);
		return index > 0 ? all[index - 1].id : undefined;
	}

	private goPrev = (): void => {
		const previous = this.previousCardId();
		if (previous) this.selectCard(previous);
	};

	private nextCardId(cardId: string): string | undefined {
		const all = this.cards;
		const index = all.findIndex(card => card.id === cardId);
		return index >= 0 ? all[index + 1]?.id : undefined;
	}

	private recordDecision(card: PrWalkthroughCard, value: "liked" | "disliked"): void {
		const commentIds = value === "disliked" ? this._comments.filter(comment => comment.cardId === card.id).map(comment => comment.id) : [];
		this._decisions = {
			...this._decisions,
			[card.id]: { cardId: card.id, value, commentIds, updatedAt: new Date().toISOString() },
		};
		this._completedCardIds = this._completedCardIds.includes(card.id) ? this._completedCardIds : [...this._completedCardIds, card.id];
		this.emitDraftChange();
		const next = this.nextCardId(card.id);
		if (next) {
			this.selectCard(next);
			if (this.cards.find(nextCard => nextCard.id === next)?.phaseId === "audit") {
				this.emitComplete();
			}
		} else {
			this.emitComplete();
		}
	}

	private buildSideBySidePairs(lines: PrWalkthroughDiffLine[]): SideBySidePair[] {
		const pairs: SideBySidePair[] = [];
		let index = 0;
		while (index < lines.length) {
			const line = lines[index];
			if (line.kind === "context") {
				pairs.push({ left: line, right: line });
				index += 1;
				continue;
			}
			if (line.kind === "del") {
				const deleted: PrWalkthroughDiffLine[] = [];
				while (lines[index]?.kind === "del") deleted.push(lines[index++]);
				const added: PrWalkthroughDiffLine[] = [];
				while (lines[index]?.kind === "add") added.push(lines[index++]);
				const count = Math.max(deleted.length, added.length);
				for (let i = 0; i < count; i += 1) pairs.push({ left: deleted[i] ?? null, right: added[i] ?? null });
				continue;
			}
			pairs.push({ left: null, right: line });
			index += 1;
		}
		return pairs;
	}

	private lineKey(cardId: string, diffBlockId: string, lineId: string): string {
		return `${cardId}::${diffBlockId}::${lineId}`;
	}

	private commentsForLine(cardId: string, diffBlockId: string, lineId: string): PrWalkthroughComment[] {
		return this._comments.filter(comment => comment.cardId === cardId && comment.diffBlockId === diffBlockId && comment.lineId === lineId);
	}

	private pendingSuggestionsForLine(card: PrWalkthroughCard, diffBlockId: string, lineId: string): PrWalkthroughSuggestedComment[] {
		return (card.suggestedComments ?? []).filter(suggestion => suggestion.diffBlockId === diffBlockId && suggestion.lineId === lineId && !this._dismissedSuggestionIds.includes(suggestion.id) && !this._comments.some(comment => comment.id === this.suggestedCommentId(suggestion.id)));
	}

	private suggestedCommentId(suggestionId: string): string {
		return `suggested:${suggestionId}`;
	}

	private openLineEditor(cardId: string, diffBlockId: string, lineId: string): void {
		const key = this.lineKey(cardId, diffBlockId, lineId);
		const existing = this.commentsForLine(cardId, diffBlockId, lineId)[0];
		this._lineDrafts = { ...this._lineDrafts, [key]: existing?.body ?? this._lineDrafts[key] ?? "" };
		this._editingLineKey = key;
	}

	private closeLineEditor(): void {
		this._editingLineKey = undefined;
	}

	private updateLineDraft(key: string, event: InputEvent): void {
		this._lineDrafts = { ...this._lineDrafts, [key]: (event.target as HTMLTextAreaElement).value };
	}

	private saveLineComment(cardId: string, diffBlockId: string, lineId: string): void {
		const key = this.lineKey(cardId, diffBlockId, lineId);
		const body = (this._lineDrafts[key] ?? "").trim();
		if (!body) return;
		const existing = this.commentsForLine(cardId, diffBlockId, lineId)[0];
		if (existing) {
			this._comments = this._comments.map(comment => comment.id === existing.id ? { ...comment, body, updatedAt: new Date().toISOString() } : comment);
		} else {
			this._comments = [...this._comments, { id: `custom:${crypto.randomUUID()}`, cardId, diffBlockId, lineId, body, source: "custom", createdAt: new Date().toISOString() }];
		}
		this._editingLineKey = undefined;
		this.emitDraftChange();
	}

	private updateCardDraft(cardId: string, event: InputEvent): void {
		this._cardDrafts = { ...this._cardDrafts, [cardId]: (event.target as HTMLTextAreaElement).value };
	}

	private clearCardDraft(cardId: string): void {
		const next = { ...this._cardDrafts };
		delete next[cardId];
		this._cardDrafts = next;
	}

	private saveCardComment(cardId: string): void {
		const body = (this._cardDrafts[cardId] ?? "").trim();
		if (!body) return;
		const existing = this._comments.find(comment => comment.cardId === cardId && !comment.diffBlockId && !comment.lineId && comment.source === "custom");
		if (existing) {
			this._comments = this._comments.map(comment => comment.id === existing.id ? { ...comment, body, updatedAt: new Date().toISOString() } : comment);
		} else {
			this._comments = [...this._comments, { id: `custom:${crypto.randomUUID()}`, cardId, body, source: "custom", createdAt: new Date().toISOString() }];
		}
		this.clearCardDraft(cardId);
		this.emitDraftChange();
	}

	private acceptSuggestion(suggestion: PrWalkthroughSuggestedComment, edit: boolean): void {
		const id = this.suggestedCommentId(suggestion.id);
		if (!this._comments.some(comment => comment.id === id)) {
			this._comments = [...this._comments, { id, cardId: suggestion.cardId, diffBlockId: suggestion.diffBlockId, lineId: suggestion.lineId, body: suggestion.body, source: "suggested", createdAt: new Date().toISOString() }];
		}
		this.emitDraftChange();
		if (edit) this.openLineEditor(suggestion.cardId, suggestion.diffBlockId, suggestion.lineId);
	}

	private dismissSuggestion(suggestionId: string): void {
		this._dismissedSuggestionIds = this._dismissedSuggestionIds.includes(suggestionId) ? this._dismissedSuggestionIds : [...this._dismissedSuggestionIds, suggestionId];
	}

	private editComment(comment: PrWalkthroughComment): void {
		if (comment.diffBlockId && comment.lineId) {
			const key = this.lineKey(comment.cardId, comment.diffBlockId, comment.lineId);
			this._lineDrafts = { ...this._lineDrafts, [key]: comment.body };
			this._editingLineKey = key;
			return;
		}
		this._cardDrafts = { ...this._cardDrafts, [comment.cardId]: comment.body };
	}

	private deleteComment(commentId: string): void {
		const deleted = this._comments.find(comment => comment.id === commentId);
		this._comments = this._comments.filter(comment => comment.id !== commentId);
		if (deleted?.source === "suggested" && deleted.id.startsWith("suggested:")) {
			this._dismissedSuggestionIds = [...this._dismissedSuggestionIds, deleted.id.slice("suggested:".length)];
		}
		this._decisions = Object.fromEntries(Object.entries(this._decisions).map(([cardId, decision]) => [cardId, { ...decision, commentIds: decision.commentIds.filter(id => id !== commentId) }]));
		this.emitDraftChange();
	}

	private _decisionGlyph(cardId: string): string {
		const decision = this._decisions[cardId]?.value;
		if (decision === "liked") return "✓";
		if (decision === "disliked") return "!";
		return "";
	}

	private emitDraftChange(): void {
		this.dispatchEvent(new CustomEvent<PrWalkthroughReviewDraft>("pr-walkthrough-draft-change", { detail: this.currentDraft, bubbles: true, composed: true }));
	}

	private emitComplete(): void {
		this.dispatchEvent(new CustomEvent<PrWalkthroughReviewDraft>("pr-walkthrough-complete", { detail: this.currentDraft, bubbles: true, composed: true }));
	}

	private findLineAnchor(comment: PrWalkthroughComment): { filePath: string; line: number | string } {
		const card = this.cards.find(item => item.id === comment.cardId);
		const block = card?.diffBlocks.find(item => item.id === comment.diffBlockId);
		const line = block?.hunks.flatMap(hunk => hunk.lines).find(item => item.id === comment.lineId);
		return { filePath: block?.filePath ?? "Card-level", line: line?.newLine ?? line?.oldLine ?? comment.lineId ?? "card" };
	}

	private buildAuditText(): string {
		const draft = this.currentDraft;
		const liked = this.reviewCards.filter(card => draft.decisions[card.id]?.value === "liked");
		const disliked = this.reviewCards.filter(card => draft.decisions[card.id]?.value === "disliked");
		const lineComments = draft.comments.filter(comment => comment.diffBlockId && comment.lineId);
		const cardComments = draft.comments.filter(comment => !comment.diffBlockId && !comment.lineId);
		const lines: string[] = [];
		lines.push(`# Review draft: ${draft.changeset.title ?? "PR walkthrough"}`);
		lines.push(`Changeset: ${draft.changeset.baseSha} → ${draft.changeset.headSha}`);
		if (draft.changeset.externalUrl) lines.push(`Source: ${draft.changeset.externalUrl}`);
		lines.push("");
		lines.push("## Approved context");
		if (liked.length === 0) lines.push("- None yet.");
		for (const card of liked) lines.push(`- ${card.title}: ${card.summary}`);
		lines.push("");
		lines.push("## Concerns");
		if (disliked.length === 0) lines.push("- None queued.");
		for (const card of disliked) {
			lines.push(`- ${card.title}`);
			for (const comment of draft.comments.filter(item => item.cardId === card.id)) lines.push(`  - ${comment.body}`);
		}
		lines.push("");
		lines.push("## Queued line comments");
		if (lineComments.length === 0) lines.push("- None queued.");
		for (const comment of lineComments) {
			const anchor = this.findLineAnchor(comment);
			lines.push(`- ${anchor.filePath}:${anchor.line} — ${comment.body}`);
		}
		lines.push("");
		lines.push("## Broad card-level comments");
		if (cardComments.length === 0) lines.push("- None queued.");
		for (const comment of cardComments) {
			const card = this.cards.find(item => item.id === comment.cardId);
			lines.push(`- ${card?.title ?? comment.cardId}: ${comment.body}`);
		}
		return lines.join("\n");
	}

	private async copyAudit(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this._copied = true;
			window.setTimeout(() => { this._copied = false; }, 1400);
		} catch {
			this._copied = false;
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"pr-walkthrough-panel": PrWalkthroughPanel;
	}
}
