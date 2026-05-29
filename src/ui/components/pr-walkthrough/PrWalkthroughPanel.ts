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

interface PersistedPrWalkthroughState {
	activeCardId?: string;
	diffModeOverride?: PrWalkthroughDiffMode;
	comments?: PrWalkthroughComment[];
	decisions?: Record<string, PrWalkthroughDecision>;
	completedCardIds?: string[];
	dismissedSuggestionIds?: string[];
	collapsedDiffBlockIds?: string[];
}

@customElement("pr-walkthrough-panel")
export class PrWalkthroughPanel extends LitElement {
	@property({ attribute: false }) changeset?: PrWalkthroughChangesetRef;
	@property({ attribute: false }) cards: PrWalkthroughCard[] = getFixturePrWalkthroughCards();
	@property({ type: Boolean, reflect: true }) narrow = false;
	@property({ attribute: "persistence-key" }) persistenceKey = "";

	@state() private _activeCardId = "";
	@state() private _panelWidth = 1024;
	@state() private _observedNarrow = false;
	@state() private _diffModeOverride?: PrWalkthroughDiffMode;
	@state() private _comments: PrWalkthroughComment[] = [];
	@state() private _decisions: Record<string, PrWalkthroughDecision> = {};
	@state() private _completedCardIds: string[] = [];
	@state() private _editingLineKey?: string;
	@state() private _editingCardId?: string;
	@state() private _lineDrafts: Record<string, string> = {};
	@state() private _cardDrafts: Record<string, string> = {};
	@state() private _dismissedSuggestionIds: string[] = [];
	@state() private _collapsedDiffBlockIds: string[] = [];
	@state() private _copied = false;

	private _resizeObserver?: ResizeObserver;
	private _loadedPersistenceKey = "";

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
			display: flex;
			align-items: center;
			gap: 12px;
			min-width: 0;
			height: 48px;
			padding: 0 14px;
			border-bottom: 1px solid var(--border, ButtonBorder);
			background: var(--card, Canvas);
		}

		.title-row { display: contents; }
		.title-wrap { min-width: 0; display: grid; gap: 1px; }
		.kicker { font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted-foreground, GrayText); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.title { margin: 0; font-size: 14px; line-height: 1.25; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.meta { color: var(--muted-foreground, GrayText); font-size: 12px; margin-top: 4px; }
		.header-spacer { flex: 1 1 auto; min-width: 10px; }
		.stats { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; white-space: nowrap; }
		.stat-files { color: var(--muted-foreground, GrayText); }
		.stat-add { color: var(--positive, var(--chart-3, green)); font-weight: 700; }
		.stat-del { color: var(--negative, var(--chart-5, red)); font-weight: 700; }
		.header-pill,
		.pr-link { display: inline-flex; align-items: center; gap: 5px; max-width: min(32vw, 300px); padding: 2px 8px; border: 1px solid var(--border, ButtonBorder); border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground, GrayText) 8%, transparent); color: var(--muted-foreground, GrayText); font-size: 11px; line-height: 1.35; text-decoration: none; white-space: nowrap; }
		.pr-link:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--primary, Highlight) 10%, transparent); border-color: color-mix(in oklch, var(--primary, Highlight) 25%, var(--border, ButtonBorder)); }
		.pr-link span { overflow: hidden; text-overflow: ellipsis; }
		.progress-wrap { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
		.progress-label { color: var(--muted-foreground, GrayText); font-size: 11px; white-space: nowrap; }
		.progress-track { width: 150px; height: 6px; overflow: hidden; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground, GrayText) 18%, transparent); }
		.progress-fill { height: 100%; border-radius: inherit; background: var(--primary, Highlight); transition: width 160ms ease; }
		.submit-button { border: 0; border-radius: 7px; padding: 7px 12px; font-weight: 700; background: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); white-space: nowrap; }
		.submit-button:disabled { background: color-mix(in oklch, var(--muted-foreground, GrayText) 18%, transparent); color: var(--muted-foreground, GrayText); opacity: 1; }

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

		.body.narrow { grid-template-columns: 38px minmax(0, 1fr); }

		.rail {
			overflow: auto;
			padding: 12px;
			border-right: 1px solid var(--border, ButtonBorder);
			background: color-mix(in oklch, var(--card, Canvas) 62%, var(--background, Canvas));
		}
		.rail-prbox { padding-bottom: 12px; margin-bottom: 10px; border-bottom: 1px solid var(--border, ButtonBorder); }
		.rail-prbox .num { font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted-foreground, GrayText); }
		.rail-prbox .prtitle { margin-top: 3px; font-weight: 700; line-height: 1.25; }
		.rail-prbox .meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 11px; color: var(--muted-foreground, GrayText); }

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

		/* Prototype-density overrides for the production walkthrough surface. */
		.phase { border-radius: 8px; overflow: hidden; margin: 3px 0; }
		.phase.active { background: color-mix(in oklch, var(--primary, Highlight) 8%, transparent); }
		.phase.complete .phase-index { background: var(--positive, var(--primary, Highlight)); color: var(--positive-foreground, HighlightText); }
		.phase-button { display: flex; align-items: center; gap: 8px; border: 0; border-radius: 8px; }
		.phase-index { width: 20px; height: 20px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; background: color-mix(in oklch, var(--muted-foreground, GrayText) 18%, transparent); color: var(--muted-foreground, GrayText); font-size: 10px; font-weight: 800; }
		.phase.active .phase-index { background: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); }
		.phase-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.phase-count { font-size: 11px; color: var(--muted-foreground, GrayText); }
		.phase-cards { display: grid; gap: 1px; padding: 0 8px 7px 30px; }
		.card-button { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border: 0; border-radius: 5px; font-size: 11.5px; }
		.card-button::before { content: none; }
		.card-dot-rail { width: 7px; height: 7px; border-radius: 999px; flex: 0 0 auto; background: var(--muted-foreground, GrayText); opacity: 0.45; }
		.card-button.complete .card-dot-rail { background: var(--positive, var(--primary, Highlight)); opacity: 1; }
		.card-button.disliked .card-dot-rail { background: var(--negative, red); opacity: 1; }
		.card-button.active .card-dot-rail { background: var(--primary, Highlight); opacity: 1; box-shadow: 0 0 0 2px color-mix(in oklch, var(--primary, Highlight) 22%, transparent); }
		.rail.collapsed { gap: 8px; padding: 6px 3px; overflow-x: hidden; }
		.collapsed-phase { width: 100%; padding: 2px 0 5px; border-radius: 8px; }
		.collapsed-phase.active { background: color-mix(in oklch, var(--primary, Highlight) 8%, transparent); }
		.phase-pip { width: 24px; height: 24px; padding: 0; border: 0; font-size: 11px; font-weight: 800; }
		.phase-pip.complete { background: var(--positive, var(--primary, Highlight)); color: var(--positive-foreground, HighlightText); }
		.card-dot { width: 10px; height: 10px; border: 0; }
		.card-dot.disliked { background: var(--negative, red); opacity: 1; }
		.content { padding: 26px clamp(16px, 4vw, 54px) 38px; }
		.inner { max-width: 1120px; margin: 0 auto; }
		.card { display: block; max-width: none; }
		.card-head { display: block; padding: 0; border: 0; border-radius: 0; background: transparent; }
		.phase-label { display: inline-block; padding: 3px 9px; border-radius: 5px; background: color-mix(in oklch, var(--chart-1, var(--primary, Highlight)) 12%, transparent); color: var(--chart-1, var(--primary, Highlight)); font-size: 10.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
		.card h2 { margin: 10px 0 5px; font-size: 24px; letter-spacing: -0.015em; }
		.meta2 { color: var(--muted-foreground, GrayText); font-size: 12px; margin-bottom: 16px; }
		.summary, .rationale { max-width: 850px; line-height: 1.65; }
		.modebar { display: flex; align-items: center; gap: 8px; margin: 18px 0 8px; flex-wrap: wrap; }
		.modebar .label { font-size: 11px; color: var(--muted-foreground, GrayText); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 800; }
		.modebar .mode-toggle { overflow: hidden; border-radius: 7px; }
		.modebar .mode-toggle button { border-radius: 0; font-size: 12px; }
		.modebar .mode-toggle button.active { background: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); }
		.narrow-note { display: none; font-size: 12px; color: var(--muted-foreground, GrayText); }
		.body.narrow .narrow-note { display: inline; }
		.diff-block { margin: 12px 0; border-radius: 9px; }
		.diff-block.closed .diff-overflow { display: none; }
		.diff-file-header { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 12px; border: 0; border-bottom: 1px solid var(--border, ButtonBorder); font: inherit; color: inherit; text-align: left; cursor: pointer; }
		.diff-block.closed .diff-file-header { border-bottom: 0; }
		.caret { width: 12px; color: var(--muted-foreground, GrayText); transition: transform 140ms ease; font-family: ui-monospace, monospace; }
		.diff-block.open .caret { transform: rotate(90deg); }
		.diff-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted-foreground, GrayText); }
		.diff-path b { color: var(--foreground, CanvasText); }
		.diff-kind { margin-left: auto; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 7px; border-radius: 4px; color: var(--chart-1, var(--primary, Highlight)); background: color-mix(in oklch, var(--chart-1, var(--primary, Highlight)) 16%, transparent); }
		.diff-comment-count { font-size: 11px; color: var(--negative, red); background: color-mix(in oklch, var(--negative, red) 12%, transparent); border-radius: 999px; padding: 2px 7px; font-weight: 800; }
		.split-grid { min-width: 980px; }
		.split-row .diff-line:first-child { border-right: 1px solid var(--border, ButtonBorder); }
		.diff-line { position: relative; grid-template-columns: 42px 18px minmax(280px, 1fr) 26px; font-size: 11.5px; line-height: 1.6; }
		.diff-line:hover, .diff-line:focus-visible { background: color-mix(in oklch, var(--primary, Highlight) 6%, transparent); }
		.diff-line.commented .line-no::before { content: "●"; position: absolute; left: 3px; color: var(--primary, Highlight); font-size: 8px; }
		.line-no { position: relative; text-align: right; }
		.comment-cue { align-self: center; justify-self: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); line-height: 18px; font-weight: 800; }
		.diff-line.editing .comment-cue, .diff-line.commented .comment-cue { opacity: 1; }
		.editor-anchor { margin-bottom: 2px; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted-foreground, GrayText); }
		.card-comments { margin: 18px 0 0; border-color: color-mix(in oklch, var(--warning, orange) 22%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--warning, orange) 5%, transparent); }
		.card-comments h3 { font-size: 11px; color: var(--muted-foreground, GrayText); text-transform: uppercase; letter-spacing: 0.07em; }
		.card-comment-chips { display: flex; flex-wrap: wrap; gap: 5px; }
		.chip { display: inline-flex; align-items: center; padding: 5px 9px; border: 1px solid color-mix(in oklch, var(--warning, orange) 32%, var(--border, ButtonBorder)); border-radius: 7px; background: var(--card, Canvas); color: var(--foreground, CanvasText); font-size: 12px; line-height: 1.35; }
		.chip:hover { background: color-mix(in oklch, var(--warning, orange) 14%, transparent); }
		.card-comment-card { margin-top: 10px; padding: 10px 12px; border-left: 3px solid var(--negative, red); background: color-mix(in oklch, var(--negative, red) 5%, transparent); border-radius: 0 6px 6px 0; }
		.actions { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border, ButtonBorder); }
		.actions .prev { border-color: transparent; color: var(--muted-foreground, GrayText); background: transparent; }

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
		if (changed.has("persistenceKey")) {
			this.restorePersistedState();
			return;
		}
		if (changed.has("cards") && this.persistenceKey && this._loadedPersistenceKey !== this.persistenceKey) {
			this.restorePersistedState();
			return;
		}
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

	private firstAvailableCardId(): string {
		return (this.reviewCards[0] ?? this.cards[0])?.id ?? "";
	}

	private resetInteractionState(): void {
		this._activeCardId = this.firstAvailableCardId();
		this._diffModeOverride = undefined;
		this._comments = [];
		this._decisions = {};
		this._completedCardIds = [];
		this._editingLineKey = undefined;
		this._editingCardId = undefined;
		this._lineDrafts = {};
		this._cardDrafts = {};
		this._dismissedSuggestionIds = [];
		this._collapsedDiffBlockIds = [];
		this._copied = false;
	}

	private reconcileDecisionCommentInvariants(): void {
		const cardIds = new Set(this.cards.map(card => card.id));
		const completed = new Set(this._completedCardIds.filter(id => cardIds.has(id)));
		const decisions: Record<string, PrWalkthroughDecision> = {};
		for (const [cardId, decision] of Object.entries(this._decisions)) {
			if (!cardIds.has(cardId)) {
				completed.delete(cardId);
				continue;
			}
			if (decision.value === "disliked") {
				const commentIds = this._comments.filter(comment => comment.cardId === cardId && comment.body.trim()).map(comment => comment.id);
				if (commentIds.length === 0) {
					completed.delete(cardId);
					continue;
				}
				decisions[cardId] = { ...decision, commentIds };
				continue;
			}
			decisions[cardId] = { ...decision, commentIds: [] };
		}
		this._decisions = decisions;
		this._completedCardIds = [...completed];
	}

	private get currentDraft(): PrWalkthroughReviewDraft {
		return buildPrWalkthroughDraft({
			changeset: this.effectiveChangeset,
			decisions: this._decisions,
			comments: this._comments,
			completedCardIds: this._completedCardIds,
		});
	}

	private get currentDraftHasConcerns(): boolean {
		return Object.values(this._decisions).some(decision => decision.value === "disliked") || this._comments.length > 0;
	}

	private get prIdentity(): { kicker: string; title: string; linkLabel: string; url: string } {
		const changeset = this.effectiveChangeset;
		const url = changeset.prUrl || changeset.externalUrl || "";
		const urlNumber = url ? /\/pull\/(\d+)(?:\/|$)/i.exec(url)?.[1] : undefined;
		const titleNumber = changeset.title ? /^PR\s+#(\d+)/i.exec(changeset.title)?.[1] : undefined;
		const number = changeset.prNumber != null && String(changeset.prNumber).trim() ? String(changeset.prNumber) : urlNumber ?? titleNumber;
		const rawTitle = changeset.prTitle || changeset.title || "PR walkthrough";
		const title = number && !/^PR\s+#/i.test(rawTitle) ? `PR #${number}: ${rawTitle}` : rawTitle;
		const shortProvider = changeset.provider === "github" ? "GitHub" : changeset.provider ? changeset.provider : "Changeset";
		const kicker = `${number ? `PR #${number}` : "Changeset"} · ${shortProvider} · ${changeset.baseSha} → ${changeset.headSha}`;
		const linkLabel = number ? `PR #${number}${changeset.prTitle ? `: ${changeset.prTitle}` : ""}` : title;
		return { kicker, title, linkLabel, url };
	}

	private get changesetStats(): { files: number; additions: number; deletions: number } {
		const changeset = this.effectiveChangeset;
		const blocks = this.cards.flatMap(card => card.diffBlocks);
		const files = changeset.filesChanged ?? fixturePrWalkthroughChangeset.filesChanged ?? new Set(blocks.map(block => block.filePath)).size;
		let additions = changeset.additions ?? fixturePrWalkthroughChangeset.additions ?? 0;
		let deletions = changeset.deletions ?? fixturePrWalkthroughChangeset.deletions ?? 0;
		if (changeset.additions == null && fixturePrWalkthroughChangeset.additions == null || changeset.deletions == null && fixturePrWalkthroughChangeset.deletions == null) {
			for (const block of blocks) {
				for (const hunk of block.hunks) {
					for (const line of hunk.lines) {
						if (line.kind === "add" && changeset.additions == null) additions += 1;
						if (line.kind === "del" && changeset.deletions == null) deletions += 1;
					}
				}
			}
		}
		return { files: Math.max(files, 0), additions: Math.max(additions, 0), deletions: Math.max(deletions, 0) };
	}

	private formatNumber(value: number): string {
		return new Intl.NumberFormat("en-US").format(value);
	}

	override render(): TemplateResult {
		const active = this.activeCard;
		if (!active) {
			return html`<section class="shell" data-testid="pr-walkthrough-panel"><div class="empty">No walkthrough cards are available.</div></section>`;
		}

		return html`
			<section class="shell" data-testid="pr-walkthrough-panel" data-active-card-id=${active.id} data-diff-mode=${this.effectiveDiffMode}>
				${this.renderHeader()}
				<div class="body ${this.isNarrowLayout ? "narrow" : ""}">
					${this.renderRail()}
					<main class="content">${active.phaseId === "audit" ? this.renderAudit(active) : this.renderCard(active)}</main>
				</div>
			</section>
		`;
	}

	private renderHeader(): TemplateResult {
		const completed = this._completedCardIds.filter(id => this.reviewCards.some(card => card.id === id)).length;
		const total = Math.max(this.reviewCards.length, 1);
		const percent = Math.round((completed / total) * 100);
		const identity = this.prIdentity;
		const stats = this.changesetStats;
		const submitLabel = completed < this.reviewCards.length
			? `Submit review (${completed}/${this.reviewCards.length})`
			: this.currentDraftHasConcerns ? "Submit review · request changes" : "Submit review · approve";
		return html`
			<header class="header" data-testid="pr-walkthrough-review-header">
				<div class="title-wrap">
					<div class="kicker">${identity.kicker}</div>
					<h1 class="title" title=${identity.title}>${identity.title}</h1>
				</div>
				<span class="stats" data-testid="pr-walkthrough-pr-stats">
					<span class="stat-files">${stats.files} files</span>
					<span class="stat-add">+${this.formatNumber(stats.additions)}</span>
					<span class="stat-del">-${this.formatNumber(stats.deletions)}</span>
				</span>
				<span class="header-pill ask">Ask via Bobbit chat outside this pane</span>
				${identity.url ? html`
					<a class="pr-link" data-testid="pr-walkthrough-pr-link" href=${identity.url} target="_blank" rel="noopener noreferrer" title=${`Open ${identity.linkLabel} on GitHub`}><span>${identity.linkLabel}</span> ↗</a>
				` : nothing}
				<span class="header-spacer"></span>
				<div class="progress-wrap" aria-label="Walkthrough progress" data-testid="pr-walkthrough-progress">
					<div class="progress-label">${completed} / ${this.reviewCards.length} reviewed</div>
					<div class="progress-track"><div class="progress-fill" style="width: ${percent}%"></div></div>
				</div>
				<button class="submit-button" data-testid="pr-walkthrough-submit-review" type="button" ?disabled=${completed < this.reviewCards.length}>${submitLabel}</button>
			</header>
		`;
	}

	private renderRail(): TemplateResult {
		return this.isNarrowLayout ? this.renderCollapsedRail() : this.renderLabelledRail();
	}

	private renderLabelledRail(): TemplateResult {
		const identity = this.prIdentity;
		const stats = this.changesetStats;
		return html`
			<nav class="rail" data-testid="pr-walkthrough-labelled-rail" aria-label="PR walkthrough phases">
				<div class="rail-prbox">
					<div class="num">${identity.kicker}</div>
					<div class="prtitle">${identity.title}</div>
					<div class="meta"><span>${stats.files} files</span><span class="stat-add">+${this.formatNumber(stats.additions)}</span><span class="stat-del">-${this.formatNumber(stats.deletions)}</span></div>
				</div>
				${PHASES.map((phase, index) => {
					const cards = this.cardsForPhase(phase.id);
					if (cards.length === 0) return nothing;
					const phaseActive = cards.some(card => card.id === this.activeCard?.id);
					const complete = cards.every(card => this._completedCardIds.includes(card.id) || card.phaseId === "audit");
					return html`
						<section class="phase ${phaseActive ? "active" : ""} ${complete && !phaseActive ? "complete" : ""}" data-phase-id=${phase.id}>
							<button class="phase-button ${phaseActive ? "active" : ""}" data-testid="pr-walkthrough-phase-button" type="button" @click=${() => this.selectCard(cards[0].id)} title=${`Phase ${index}: ${phase.label}`}>
								<span class="phase-index">${index}</span><span class="phase-name">${phase.label}</span><span class="phase-count">${cards.filter(card => this._completedCardIds.includes(card.id)).length}/${cards.length}</span>
							</button>
							<div class="phase-cards">${cards.map(card => this.renderRailCardButton(card))}</div>
						</section>
					`;
				})}
			</nav>
		`;
	}

	private renderCollapsedRail(): TemplateResult {
		return html`
			<nav class="rail collapsed" data-testid="pr-walkthrough-collapsed-rail" aria-label="PR walkthrough phases">
				${PHASES.map((phase, index) => {
					const cards = this.cardsForPhase(phase.id);
					if (cards.length === 0) return nothing;
					const phaseActive = cards.some(card => card.id === this.activeCard?.id);
					const complete = cards.every(card => this._completedCardIds.includes(card.id) || card.phaseId === "audit");
					return html`
						<div class="collapsed-phase ${phaseActive ? "active" : ""}" title=${phase.label}>
							<button class="phase-pip ${phaseActive ? "active" : ""} ${complete && !phaseActive ? "complete" : ""}" data-testid="pr-walkthrough-phase-pip" type="button" aria-label=${`Open ${phase.label}`} title=${phase.label} @click=${() => this.selectCard(cards[0].id)}>${index}</button>
							${cards.map(card => html`
								<button
									class="card-dot ${card.id === this.activeCard?.id ? "active" : ""} ${this._completedCardIds.includes(card.id) ? "complete" : ""} ${this._decisions[card.id]?.value === "disliked" ? "disliked" : ""}"
									data-testid="pr-walkthrough-card-dot"
									type="button"
									aria-label=${`Open ${phase.label} card: ${card.title}`}
									title=${`${phase.label}: ${card.title}${this.commentCountForCard(card.id) ? ` · ${this.commentCountForCard(card.id)} comment(s)` : ""}`}
									@click=${() => this.selectCard(card.id)}
								></button>
							`)}
						</div>
					`;
				})}
			</nav>
		`;
	}

	private renderRailCardButton(card: PrWalkthroughCard): TemplateResult {
		const decision = this._decisions[card.id]?.value;
		const comments = this.commentCountForCard(card.id);
		return html`
			<button class="card-button ${card.id === this.activeCard?.id ? "active" : ""} ${this._completedCardIds.includes(card.id) ? "complete" : ""} ${decision === "disliked" ? "disliked" : ""}" data-testid="pr-walkthrough-card-step" data-card-id=${card.id} type="button" title=${card.title} @click=${() => this.selectCard(card.id)}>
				<span class="card-dot-rail" aria-hidden="true"></span>
				<span class="card-title">${card.title}</span>
				${comments ? html`<span class="card-decision">${comments}</span>` : html`<span class="card-decision">${decision ? decision : card.phaseId === "audit" ? "draft" : "pending"}</span>`}
			</button>
		`;
	}

	private renderCard(card: PrWalkthroughCard): TemplateResult {
		const phaseIndex = PHASES.findIndex(item => item.id === card.phaseId);
		const phase = PHASES[phaseIndex]?.label ?? card.phaseId;
		const phaseCards = this.cardsForPhase(card.phaseId);
		const cardIndex = phaseCards.findIndex(item => item.id === card.id);
		const dislikeDisabled = cardRequiresCommentForDislike({ comments: this._comments }, card.id);
		const commentCount = this.commentCountForCard(card.id);
		return html`
			<article class="card" data-testid="pr-walkthrough-card" data-active="true" data-card-id=${card.id} data-phase-id=${card.phaseId}>
				<div class="inner">
					<section class="card-head">
						<div class="phase-label">Phase ${Math.max(phaseIndex, 0)} · ${phase}</div>
						<h2>${card.title}</h2>
						<div class="meta2">Card ${cardIndex + 1} of ${phaseCards.length} · logical change set</div>
						<p class="summary">${card.summary}</p>
						${card.rationale ? html`<p class="rationale">${card.rationale}</p>` : nothing}
						${card.checklist?.length ? html`<ul class="checklist">${card.checklist.map(item => html`<li>${item}</li>`)}</ul>` : nothing}
					</section>
					${card.diffBlocks.length ? html`
						<div class="modebar">
							<span class="label">Diff display</span>
							<span class="mode-toggle" aria-label="Diff mode">
								<button id="diff-mode-split" data-testid="diff-mode-split" class=${this.effectiveDiffMode === "split" ? "active" : ""} type="button" aria-pressed=${this.effectiveDiffMode === "split"} @click=${() => this.setDiffMode("split")}>Split</button>
								<button id="diff-mode-inline" data-testid="diff-mode-inline" class=${this.effectiveDiffMode === "inline" ? "active" : ""} type="button" aria-pressed=${this.effectiveDiffMode === "inline"} @click=${() => this.setDiffMode("inline")}>Inline</button>
							</span>
							<span class="narrow-note">Inline defaults at half-width; split remains available.</span>
						</div>
					` : nothing}
					${card.diffBlocks.map(block => this.renderDiffBlock(card, block))}
					${this.renderCardComments(card)}
					<div class="actions">
						<span class="decision-note">${this._decisions[card.id] ? html`Current: <b>${this._decisions[card.id].value}</b>` : commentCount ? html`<b>${commentCount}</b> comment${commentCount === 1 ? "" : "s"} drafted on this card.` : dislikeDisabled ? "Add a comment to enable Dislike." : "Ready for a decision."}</span>
						<button data-testid="pr-walkthrough-prev" class="prev" type="button" @click=${this.goPrev} ?disabled=${!this.previousCardId()}>← Prev</button>
						<button data-testid="pr-walkthrough-dislike" class="dislike ${dislikeDisabled ? "" : "enabled"}" type="button" ?disabled=${dislikeDisabled} @click=${() => this.recordDecision(card, "disliked")}>Dislike${commentCount ? ` (${commentCount})` : ""}</button>
						<button data-testid="pr-walkthrough-like" class="like" type="button" @click=${() => this.recordDecision(card, "liked")}>${commentCount ? "Like anyway" : "Like"} →</button>
					</div>
				</div>
			</article>
		`;
	}

	private renderDiffBlock(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		const collapsed = this._collapsedDiffBlockIds.includes(block.id);
		const comments = this._comments.filter(comment => comment.cardId === card.id && comment.diffBlockId === block.id).length;
		return html`
			<section class="diff-block ${collapsed ? "closed" : "open"}" data-testid="pr-walkthrough-diff-block" data-diff-block-id=${block.id} data-file-path=${block.filePath} data-diff-mode=${this.effectiveDiffMode}>
				<button class="diff-file-header" data-testid="pr-walkthrough-diff-toggle" type="button" aria-expanded=${!collapsed} @click=${() => this.toggleDiffBlock(block.id)}>
					<span class="caret">▸</span>
					<span class="diff-path"><b>${block.oldPath && block.oldPath !== block.filePath ? `${block.oldPath} → ${block.filePath}` : block.filePath}</b></span>
					${comments ? html`<span class="diff-comment-count">${comments} comment${comments === 1 ? "" : "s"}</span>` : nothing}
					<span class="diff-kind">${block.hunks.length} hunk${block.hunks.length === 1 ? "" : "s"}</span>
				</button>
				${collapsed ? nothing : this.effectiveDiffMode === "split" ? this.renderSplitDiff(card, block) : this.renderInlineDiff(card, block)}
			</section>
		`;
	}

	private renderSplitDiff(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		return html`
			<div class="diff-overflow" data-testid="pr-walkthrough-diff-scroll">
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
			<div class="diff-overflow" data-testid="pr-walkthrough-diff-scroll">
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
		const key = this.lineKey(card.id, block.id, line.id);
		const commented = this.commentsForLine(card.id, block.id, line.id).length > 0;
		return html`
			<div
				class="diff-line ${line.kind} ${commented ? "commented" : ""} ${this._editingLineKey === key ? "editing" : ""}"
				data-testid="pr-walkthrough-diff-line"
				data-line-id=${line.id}
				data-line-kind=${line.kind}
				data-line-side=${line.side}
				data-old-line=${line.oldLine ?? ""}
				data-new-line=${line.newLine ?? ""}
				role="button"
				tabindex="0"
				aria-label=${`Comment on ${block.filePath} line ${lineNo ?? "context"}`}
				@click=${() => this.openLineEditor(card.id, block.id, line.id)}
				@keydown=${(event: KeyboardEvent) => this.onDiffLineKeydown(event, card.id, block.id, line.id)}
			>
				<span class="line-no">${lineNo ?? ""}</span>
				<span class="prefix">${prefix}</span>
				<span class="line-text">${line.text}</span>
				<button class="comment-cue" data-testid="pr-walkthrough-line-comment-button" type="button" aria-label="Add line comment" @click=${(event: Event) => { event.stopPropagation(); this.openLineEditor(card.id, block.id, line.id); }}>+</button>
			</div>
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
				<div class="line-editor" data-testid="pr-walkthrough-comment-editor" data-comment-scope="line" data-card-id=${card.id} data-diff-block-id=${block.id} data-line-id=${line.id}>
					<div class="editor-anchor">Comment anchors to <b>${block.filePath}:${line.newLine ?? line.oldLine ?? line.id}</b></div>
					<textarea data-testid="pr-walkthrough-comment-input" .value=${this._lineDrafts[key] ?? ""} placeholder="Or write your own comment…" @input=${(event: InputEvent) => this.updateLineDraft(key, event)}></textarea>
					<div class="comment-actions">
						<button data-testid="pr-walkthrough-comment-save" type="button" @click=${() => this.saveLineComment(card.id, block.id, line.id)}>Save comment</button>
						<button data-testid="pr-walkthrough-comment-cancel" type="button" @click=${() => this.closeLineEditor()}>Cancel</button>
					</div>
				</div>
			` : nothing}
		`;
	}

	private renderSuggestion(suggestion: PrWalkthroughSuggestedComment): TemplateResult {
		return html`
			<div class="suggestion" data-testid="pr-walkthrough-suggested-comment" data-suggestion-id=${suggestion.id} data-card-id=${suggestion.cardId} data-diff-block-id=${suggestion.diffBlockId} data-line-id=${suggestion.lineId}>
				<div class="comment-meta">LLM suggested line comment</div>
				<div class="comment-body">${suggestion.body}</div>
				<div class="suggestion-actions">
					<button data-testid="pr-walkthrough-suggested-comment-accept" type="button" @click=${() => this.acceptSuggestion(suggestion, false)}>Accept</button>
					<button data-testid="pr-walkthrough-suggested-comment-edit" type="button" @click=${() => this.acceptSuggestion(suggestion, true)}>Edit</button>
					<button data-testid="pr-walkthrough-suggested-comment-delete" class="delete" type="button" @click=${() => this.dismissSuggestion(suggestion.id)}>Delete</button>
				</div>
			</div>
		`;
	}

	private renderCardComments(card: PrWalkthroughCard): TemplateResult {
		const key = `card:${card.id}`;
		const comments = this._comments.filter(comment => comment.cardId === card.id && !comment.diffBlockId && !comment.lineId);
		const editing = this._editingCardId === card.id;
		const suggestions = card.cardSuggestions ?? [];
		return html`
			<section class="card-comments" data-testid="pr-walkthrough-card-comments" data-card-id=${card.id}>
				<h3>Card-level suggested concerns</h3>
				<div class="card-comment-chips">
					${suggestions.map(suggestion => html`<button class="chip" type="button" @click=${() => this.useCardSuggestion(card.id, suggestion)}>${suggestion}</button>`)}
					<button class="chip" data-testid="pr-walkthrough-add-card-comment" type="button" @click=${() => this.openCardEditor(card.id)}>+ Write your own…</button>
				</div>
				${editing ? html`
					<div class="line-editor" data-testid="pr-walkthrough-comment-editor" data-comment-scope="card" data-card-id=${card.id}>
						<textarea data-testid="pr-walkthrough-comment-input" .value=${this._cardDrafts[card.id] ?? ""} placeholder="A concern about this whole logical change…" @input=${(event: InputEvent) => this.updateCardDraft(card.id, event)}></textarea>
						<div class="comment-actions">
							<button data-testid="pr-walkthrough-comment-save" type="button" @click=${() => this.saveCardComment(card.id)}>Save card comment</button>
							<button data-testid="pr-walkthrough-comment-cancel" type="button" @click=${() => this.closeCardEditor(card.id)}>Cancel</button>
							${this._cardDrafts[card.id] ? html`<button type="button" @click=${() => this.clearCardDraft(card.id)}>Clear</button>` : nothing}
						</div>
					</div>
				` : nothing}
				${comments.length ? html`<div class="line-comments card-comment-card" aria-label=${key}>${comments.map(comment => this.renderComment(comment, "card"))}</div>` : nothing}
			</section>
		`;
	}

	private renderComment(comment: PrWalkthroughComment, scope: "line" | "card"): TemplateResult {
		return html`
			<div class="comment" data-testid="pr-walkthrough-comment" data-comment-id=${comment.id} data-comment-scope=${scope} data-card-id=${comment.cardId} data-diff-block-id=${comment.diffBlockId ?? ""} data-line-id=${comment.lineId ?? ""}>
				<div class="comment-meta">${comment.source === "suggested" ? "Accepted suggestion" : scope === "line" ? "Line comment" : "Card comment"}</div>
				<div class="comment-body">${comment.body}</div>
				<div class="comment-actions">
					<button data-testid="pr-walkthrough-comment-edit" type="button" @click=${() => this.editComment(comment)}>Edit</button>
					<button data-testid="pr-walkthrough-comment-delete" class="delete" type="button" @click=${() => this.deleteComment(comment.id)}>Delete</button>
				</div>
			</div>
		`;
	}

	private renderAudit(card: PrWalkthroughCard): TemplateResult {
		const draftText = this.buildAuditText();
		return html`
			<article class="card" data-testid="pr-walkthrough-card" data-active="true" data-card-id=${card.id} data-phase-id=${card.phaseId}>
				<section class="card-head">
					<div class="phase-label">Audit</div>
					<h2>${card.title}</h2>
					<p class="summary">${card.summary}</p>
				</section>
				<section class="audit" data-testid="pr-walkthrough-audit">
					<h3>Draft review</h3>
					<pre data-testid="pr-walkthrough-draft">${draftText}</pre>
					<div class="comment-actions">
						<button class="copy-button" type="button" @click=${() => this.copyAudit(draftText)}>${this._copied ? "Copied" : "Copy draft"}</button>
					</div>
				</section>
				<div class="actions">
					<span class="decision-note">Review draft updates as you revise previous cards.</span>
					<button data-testid="pr-walkthrough-prev" type="button" @click=${this.goPrev}>Prev</button>
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
		this._editingCardId = undefined;
		this.persistState();
	}

	private setDiffMode(mode: PrWalkthroughDiffMode): void {
		this._diffModeOverride = mode;
		this.persistState();
	}

	private toggleDiffBlock(blockId: string): void {
		this._collapsedDiffBlockIds = this._collapsedDiffBlockIds.includes(blockId)
			? this._collapsedDiffBlockIds.filter(id => id !== blockId)
			: [...this._collapsedDiffBlockIds, blockId];
		this.persistState();
	}

	private commentCountForCard(cardId: string): number {
		return this._comments.filter(comment => comment.cardId === cardId && comment.body.trim()).length;
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
		this.persistState();
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
		this._editingCardId = undefined;
		this._editingLineKey = key;
	}

	private closeLineEditor(): void {
		this._editingLineKey = undefined;
	}

	private onDiffLineKeydown(event: KeyboardEvent, cardId: string, diffBlockId: string, lineId: string): void {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		this.openLineEditor(cardId, diffBlockId, lineId);
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
		this.persistState();
	}

	private updateCardDraft(cardId: string, event: InputEvent): void {
		this._cardDrafts = { ...this._cardDrafts, [cardId]: (event.target as HTMLTextAreaElement).value };
	}

	private clearCardDraft(cardId: string): void {
		const next = { ...this._cardDrafts };
		delete next[cardId];
		this._cardDrafts = next;
	}

	private openCardEditor(cardId: string): void {
		this._editingLineKey = undefined;
		this._editingCardId = cardId;
	}

	private useCardSuggestion(cardId: string, suggestion: string): void {
		this._cardDrafts = { ...this._cardDrafts, [cardId]: suggestion };
		this.openCardEditor(cardId);
	}

	private closeCardEditor(cardId: string): void {
		this._editingCardId = undefined;
		if (!this._cardDrafts[cardId]?.trim()) this.clearCardDraft(cardId);
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
		this._editingCardId = undefined;
		this.emitDraftChange();
		this.persistState();
	}

	private acceptSuggestion(suggestion: PrWalkthroughSuggestedComment, edit: boolean): void {
		const id = this.suggestedCommentId(suggestion.id);
		if (!this._comments.some(comment => comment.id === id)) {
			this._comments = [...this._comments, { id, cardId: suggestion.cardId, diffBlockId: suggestion.diffBlockId, lineId: suggestion.lineId, body: suggestion.body, source: "suggested", createdAt: new Date().toISOString() }];
		}
		this.emitDraftChange();
		this.persistState();
		if (edit) this.openLineEditor(suggestion.cardId, suggestion.diffBlockId, suggestion.lineId);
	}

	private dismissSuggestion(suggestionId: string): void {
		this._dismissedSuggestionIds = this._dismissedSuggestionIds.includes(suggestionId) ? this._dismissedSuggestionIds : [...this._dismissedSuggestionIds, suggestionId];
		this.persistState();
	}

	private editComment(comment: PrWalkthroughComment): void {
		if (comment.diffBlockId && comment.lineId) {
			const key = this.lineKey(comment.cardId, comment.diffBlockId, comment.lineId);
			this._lineDrafts = { ...this._lineDrafts, [key]: comment.body };
			this._editingLineKey = key;
			return;
		}
		this._cardDrafts = { ...this._cardDrafts, [comment.cardId]: comment.body };
		this._editingCardId = comment.cardId;
	}

	private deleteComment(commentId: string): void {
		const deleted = this._comments.find(comment => comment.id === commentId);
		this._comments = this._comments.filter(comment => comment.id !== commentId);
		if (deleted?.source === "suggested" && deleted.id.startsWith("suggested:")) {
			this._dismissedSuggestionIds = [...this._dismissedSuggestionIds, deleted.id.slice("suggested:".length)];
		}
		this.reconcileDecisionCommentInvariants();
		this.emitDraftChange();
		this.persistState();
	}

	private persistenceStorageKey(): string {
		return this.persistenceKey ? `bobbit:pr-walkthrough:${this.persistenceKey}` : "";
	}

	private restorePersistedState(): void {
		this.resetInteractionState();
		const key = this.persistenceStorageKey();
		this._loadedPersistenceKey = this.persistenceKey;
		if (!key || typeof localStorage === "undefined") return;
		try {
			const raw = localStorage.getItem(key);
			if (!raw) return;
			const parsed = JSON.parse(raw) as PersistedPrWalkthroughState;
			if (parsed.activeCardId && this.cards.some(card => card.id === parsed.activeCardId)) this._activeCardId = parsed.activeCardId;
			if (parsed.diffModeOverride === "split" || parsed.diffModeOverride === "inline") this._diffModeOverride = parsed.diffModeOverride;
			if (Array.isArray(parsed.comments)) this._comments = parsed.comments.filter(comment => comment && typeof comment.id === "string" && typeof comment.cardId === "string" && typeof comment.body === "string");
			if (parsed.decisions && typeof parsed.decisions === "object") this._decisions = parsed.decisions;
			if (Array.isArray(parsed.completedCardIds)) this._completedCardIds = parsed.completedCardIds.filter(id => this.cards.some(card => card.id === id));
			if (Array.isArray(parsed.dismissedSuggestionIds)) this._dismissedSuggestionIds = parsed.dismissedSuggestionIds.filter(id => typeof id === "string");
			if (Array.isArray(parsed.collapsedDiffBlockIds)) this._collapsedDiffBlockIds = parsed.collapsedDiffBlockIds.filter(id => typeof id === "string");
			this.reconcileDecisionCommentInvariants();
		} catch (err) {
			console.warn("[pr-walkthrough] failed to restore persisted state", err);
		}
	}

	private persistState(): void {
		const key = this.persistenceStorageKey();
		if (!key || this._loadedPersistenceKey !== this.persistenceKey || typeof localStorage === "undefined") return;
		const persisted: PersistedPrWalkthroughState = {
			activeCardId: this._activeCardId,
			diffModeOverride: this._diffModeOverride,
			comments: this._comments,
			decisions: this._decisions,
			completedCardIds: this._completedCardIds,
			dismissedSuggestionIds: this._dismissedSuggestionIds,
			collapsedDiffBlockIds: this._collapsedDiffBlockIds,
		};
		try {
			localStorage.setItem(key, JSON.stringify(persisted));
		} catch (err) {
			console.warn("[pr-walkthrough] failed to persist state", err);
		}
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
