import { icon } from "@mariozechner/mini-lit";
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { PanelLeftClose, PanelLeftOpen } from "lucide";
import { buildPrWalkthroughDraft, cardRequiresCommentForDislike, defaultDiffModeForWidth, type PrWalkthroughCard, type PrWalkthroughCardSection, type PrWalkthroughChangesetRef, type PrWalkthroughComment, type PrWalkthroughDecision, type PrWalkthroughDiffBlock, type PrWalkthroughDiffLine, type PrWalkthroughDiffMode, type PrWalkthroughOrientationConcern, type PrWalkthroughOrientationFileRole, type PrWalkthroughOrientationVerdict, type PrWalkthroughPhaseId, type PrWalkthroughReviewDraft, type PrWalkthroughSuggestedComment } from "./types.js";
import { fixturePrWalkthroughChangeset, getFixturePrWalkthroughCards } from "./fixtures.js";
import { gatewayFetch } from "../../../app/gateway-fetch.js";
import { safeExternalUrl } from "../../../shared/pr-walkthrough/url-safety.js";
import { deriveNavLabel } from "../../../shared/pr-walkthrough/nav-label.js";

const PHASES: Array<{ id: PrWalkthroughPhaseId; label: string }> = [
	{ id: "orientation", label: "Orientation" },
	{ id: "design", label: "Key design choices" },
	{ id: "significant", label: "Significant changes" },
	{ id: "other", label: "Other + omissions" },
	{ id: "audit", label: "Audit" },
];

const DEFAULT_DIFF_CONTEXT_LINES = 3;
const DIFF_CONTEXT_EXPAND_LINES = 20;

interface SideBySidePair {
	left: PrWalkthroughDiffLine | null;
	right: PrWalkthroughDiffLine | null;
}

interface DiffContextEntry {
	kind: "context";
	start: number;
	end: number;
	gapStart: number;
	gapEnd: number;
	hiddenCount: number;
	canExpandAbove: boolean;
	canExpandBelow: boolean;
}

interface DiffLineEntry {
	kind: "lines";
	start: number;
	end: number;
	lines: PrWalkthroughDiffLine[];
}

type DiffRenderEntry = DiffContextEntry | DiffLineEntry;

type DiffContextDirection = "above" | "below";

interface DiffContextExpansion {
	above?: number;
	below?: number;
}

type PrWalkthroughStatus = "fixture" | "loading" | "waiting_for_yaml" | "validation_failed" | "ready" | "error";

type WalkthroughWarningSeverity = "info" | "warning" | "error";

interface WalkthroughWarning {
	code: string;
	severity: WalkthroughWarningSeverity;
	message: string;
	filePath?: string;
}

interface WalkthroughExportCapability {
	provider?: string;
	available?: boolean;
	canSubmit?: boolean;
	enabled?: boolean;
	reason?: string;
	message?: string;
}

interface WalkthroughValidationIssue {
	path?: string;
	message?: string;
	[key: string]: unknown;
}

interface WalkthroughValidationSummary {
	message?: string;
	errors?: WalkthroughValidationIssue[];
	issues?: WalkthroughValidationIssue[];
	[key: string]: unknown;
}

interface WalkthroughExportPreviewRow {
	path?: string;
	filePath?: string;
	side?: string;
	line?: number;
	body?: string;
	valid?: boolean;
	reason?: string;
	kind?: string;
}

interface WalkthroughExportPreview {
	body?: string;
	reviewBody?: string;
	rows?: WalkthroughExportPreviewRow[];
	comments?: WalkthroughExportPreviewRow[];
	warnings?: WalkthroughWarning[];
	validCount?: number;
	invalidCount?: number;
	canSubmit?: boolean;
}

interface WalkthroughExportResult {
	ok?: boolean;
	url?: string;
	message?: string;
	error?: string;
}

interface PersistedPrWalkthroughState {
	schemaVersion?: number;
	cardsChecksum?: string;
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
	@property({ attribute: false }) status: PrWalkthroughStatus = "fixture";
	@property({ attribute: false }) warnings: WalkthroughWarning[] = [];
	@property({ attribute: false }) error?: string;
	@property({ attribute: false }) exportCapability?: WalkthroughExportCapability;
	@property({ attribute: false }) validationError?: WalkthroughValidationSummary;
	@property({ attribute: "job-id" }) jobId = "";
	@property({ attribute: "changeset-id" }) changesetId = "";
	@property({ type: Boolean, reflect: true }) narrow = false;
	@property({ attribute: "persistence-key" }) persistenceKey = "";

	@state() private _activeCardId = "";
	@state() private _orientationBeatIndex = 0;
	@state() private _panelWidth = 1024;
	@state() private _observedNarrow = false;
	@state() private _railCollapsed = false;
	@state() private _railWidth = 240;
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
	@state() private _contextExpansions: Record<string, DiffContextExpansion> = {};
	@state() private _copied = false;
	@state() private _exportPreviewOpen = false;
	@state() private _exportPreviewLoading = false;
	@state() private _exportPreview?: WalkthroughExportPreview;
	@state() private _exportError = "";
	@state() private _exportSubmitting = false;
	@state() private _exportResult?: WalkthroughExportResult;

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
			gap: 14px;
			min-width: 0;
			height: 58px;
			padding: 0 18px;
			border-bottom: 1px solid var(--border, ButtonBorder);
			background: var(--card, Canvas);
		}

		.title-row { display: contents; }
		.title-wrap { min-width: 0; display: grid; gap: 5px; flex: 1 1 auto; }
		.title-meta-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
		.kicker { display: none; }
		.title { margin: 0; font-size: 14px; line-height: 1.25; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.meta { color: var(--muted-foreground, GrayText); font-size: 12px; margin-top: 4px; }
		.header-spacer { display: none; }
		.stats { display: inline-flex; align-items: center; gap: 7px; min-width: 0; color: var(--muted-foreground, GrayText); font-size: 11px; line-height: 1.2; white-space: nowrap; }
		.stat-files { color: var(--muted-foreground, GrayText); }
		.stat-sep { color: var(--muted-foreground, GrayText); opacity: 0.7; }
		.stat-lines { display: inline-flex; align-items: center; gap: 8px; }
		.stat-add { color: var(--positive, var(--chart-3, green)); font-weight: 700; }
		.stat-del { color: var(--negative, var(--chart-5, red)); font-weight: 700; }
		.github-mark { width: 14px; height: 14px; flex: 0 0 auto; fill: currentColor; }
		.pr-link { display: inline-flex; align-items: center; gap: 5px; max-width: min(32vw, 300px); padding: 2px 8px; border: 1px solid var(--border, ButtonBorder); border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground, GrayText) 8%, transparent); color: var(--muted-foreground, GrayText); font-size: 11px; line-height: 1.35; text-decoration: none; white-space: nowrap; }
		.pr-link:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--primary, Highlight) 10%, transparent); border-color: color-mix(in oklch, var(--primary, Highlight) 25%, var(--border, ButtonBorder)); }
		.pr-link span { overflow: hidden; text-overflow: ellipsis; }
		.progress-wrap { display: inline-grid; align-items: center; justify-items: stretch; gap: 4px; min-width: 0; }
		.progress-label { color: var(--muted-foreground, GrayText); font-size: 11px; white-space: nowrap; }
		.progress-track { width: 100%; height: 6px; overflow: hidden; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground, GrayText) 18%, transparent); }
		.progress-fill { height: 100%; border-radius: inherit; background: var(--primary, Highlight); transition: width 160ms ease; }
		.submit-button { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 7px; padding: 7px 12px; font-weight: 700; background: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); white-space: nowrap; }
		.submit-icon { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
		.submit-button:disabled { background: color-mix(in oklch, var(--muted-foreground, GrayText) 18%, transparent); color: var(--muted-foreground, GrayText); opacity: 1; }
		.banner-stack { display: grid; gap: 8px; margin: 0 0 14px; max-width: none; }
		.banner { padding: 10px 12px; border: 1px solid var(--border, ButtonBorder); border-radius: 10px; background: var(--card, Canvas); color: var(--foreground, CanvasText); }
		.banner strong { display: block; margin-bottom: 2px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
		.banner.info { border-color: color-mix(in oklch, var(--info, var(--primary, Highlight)) 28%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--info, var(--primary, Highlight)) 7%, transparent); }
		.banner.warning { border-color: color-mix(in oklch, var(--warning, orange) 34%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--warning, orange) 8%, transparent); }
		.banner.error { border-color: color-mix(in oklch, var(--negative, red) 32%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--negative, red) 7%, transparent); }
		.banner .file { margin-top: 3px; color: var(--muted-foreground, GrayText); font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

		.state-card { max-width: 760px; margin: 32px auto; padding: 24px; border: 1px solid var(--border, ButtonBorder); border-radius: 16px; background: var(--card, Canvas); box-shadow: 0 10px 30px color-mix(in oklch, var(--foreground, CanvasText) 7%, transparent); }
		.state-card h2 { margin: 0 0 8px; font-size: 20px; }
		.state-card p { margin: 0; color: var(--muted-foreground, GrayText); }
		.state-card .state-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
		.validation-list { margin: 14px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
		.validation-list li { padding: 8px 10px; border: 1px solid color-mix(in oklch, var(--warning, orange) 34%, var(--border, ButtonBorder)); border-radius: 8px; background: color-mix(in oklch, var(--warning, orange) 7%, transparent); }
		.validation-path { display: block; margin-bottom: 2px; color: var(--muted-foreground, GrayText); font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
		.skeleton { display: grid; gap: 12px; }
		.skeleton-line { height: 12px; border-radius: 999px; background: linear-gradient(90deg, color-mix(in oklch, var(--muted-foreground, GrayText) 10%, transparent), color-mix(in oklch, var(--muted-foreground, GrayText) 20%, transparent), color-mix(in oklch, var(--muted-foreground, GrayText) 10%, transparent)); background-size: 220% 100%; animation: pr-walkthrough-pulse 1.4s ease-in-out infinite; }
		.skeleton-line.short { width: 45%; }
		.skeleton-line.medium { width: 72%; }
		.skeleton-box { height: 180px; border-radius: 12px; background: color-mix(in oklch, var(--muted-foreground, GrayText) 10%, transparent); animation: pr-walkthrough-pulse 1.4s ease-in-out infinite; }
		@keyframes pr-walkthrough-pulse { from { background-position: 0 0; } to { background-position: -220% 0; } }

		.export-backdrop { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 18px; background: color-mix(in oklch, var(--background, Canvas) 72%, transparent); backdrop-filter: blur(2px); }
		.export-dialog { width: min(920px, 96vw); max-height: min(780px, 92vh); display: grid; grid-template-rows: auto 1fr auto; border: 1px solid var(--border, ButtonBorder); border-radius: 16px; background: var(--background, Canvas); box-shadow: 0 20px 80px color-mix(in oklch, var(--foreground, CanvasText) 20%, transparent); overflow: hidden; }
		.export-head, .export-actions { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border, ButtonBorder); background: var(--card, Canvas); }
		.export-head h2 { margin: 0; font-size: 16px; }
		.export-actions { justify-content: flex-end; border-top: 1px solid var(--border, ButtonBorder); border-bottom: 0; }
		.export-body { overflow: auto; padding: 16px; display: grid; gap: 14px; }
		.export-body pre { margin: 0; max-height: 220px; overflow: auto; padding: 12px; border: 1px solid var(--border, ButtonBorder); border-radius: 10px; background: var(--card, Canvas); white-space: pre-wrap; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
		.export-summary { display: flex; gap: 8px; flex-wrap: wrap; color: var(--muted-foreground, GrayText); }
		.export-row { display: grid; gap: 5px; padding: 10px; border: 1px solid var(--border, ButtonBorder); border-radius: 10px; background: var(--card, Canvas); }
		.export-row.invalid { border-color: color-mix(in oklch, var(--negative, red) 32%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--negative, red) 6%, transparent); }
		.export-row .anchor { font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted-foreground, GrayText); }
		.export-row .reason { color: var(--negative, red); font-size: 12px; }
		.export-actions button { padding: 8px 12px; border: 1px solid var(--border, ButtonBorder); border-radius: 8px; background: var(--card, Canvas); color: inherit; }
		.export-actions .primary { border-color: var(--primary, Highlight); background: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); font-weight: 700; }

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
			grid-template-columns: var(--walkthrough-rail-width, 240px) minmax(0, 1fr);
			min-height: 0;
		}

		.body.narrow { grid-template-columns: 38px minmax(0, 1fr); }

		.rail {
			position: relative;
			overflow: auto;
			padding: 12px;
			border-right: 1px solid var(--border, ButtonBorder);
			background: color-mix(in oklch, var(--card, Canvas) 62%, var(--background, Canvas));
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
			box-sizing: border-box;
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
		.original-description {
			margin-top: 14px;
			border: 1px solid var(--border, ButtonBorder);
			border-radius: 12px;
			background: var(--card, Canvas);
			overflow: hidden;
		}
		.original-description summary {
			padding: 10px 12px;
			cursor: pointer;
			font-weight: 700;
			color: var(--foreground, CanvasText);
		}
		.original-description summary:hover { background: color-mix(in oklch, var(--primary, Highlight) 7%, transparent); }
		.original-description-meta {
			display: block;
			margin-top: 2px;
			font-size: 11px;
			font-weight: 500;
			color: var(--muted-foreground, GrayText);
		}
		.original-description-body {
			margin: 0;
			max-height: 360px;
			overflow: auto;
			padding: 12px;
			border-top: 1px solid var(--border, ButtonBorder);
			background: var(--background, Canvas);
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		}

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
			display: grid;
			grid-template-columns: 78px minmax(0, 1fr);
			min-width: max-content;
			font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
			color: var(--muted-foreground, GrayText);
			background: color-mix(in oklch, var(--info, var(--primary, Highlight)) 10%, transparent);
		}
		.hunk-context-cell {
			min-height: 24px;
			padding: 3px;
			display: inline-flex;
			flex-direction: column;
			align-items: stretch;
			justify-content: center;
			gap: 2px;
		}
		.hunk-signature { min-width: 0; padding: 3px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.45; }
		.split-grid { min-width: 820px; }
		.split-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			width: 100%;
			min-width: 100%;
		}
		.inline-lines { min-width: 620px; }
		.diff-line {
			width: 100%;
			min-width: 0;
			min-height: 24px;
			padding: 0;
			border: 0;
			border-radius: 0;
			display: grid;
			overflow: hidden;
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
		.line-text { min-width: 0; padding: 3px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
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
		.actions button { min-height: 32px; padding: 6px 12px; border-color: var(--border, ButtonBorder); background: var(--card, Canvas); }
		.actions .decision-icon, .actions .nav-icon { width: 15px; height: 15px; flex: 0 0 auto; display: inline-block; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vertical-align: -2px; }
		.actions .decision-icon { margin-right: 6px; }
		.actions .nav-icon.prev-icon { margin-right: 6px; }
		.actions .nav-icon.next-icon { margin-left: 6px; }
		.actions button:hover:not(:disabled), .actions button:focus-visible:not(:disabled) { background: color-mix(in oklch, var(--primary, Highlight) 10%, transparent); }
		.actions .like { border-color: color-mix(in oklch, var(--primary, Highlight) 62%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--primary, Highlight) 7%, var(--card, Canvas)); color: var(--primary, Highlight); font-weight: 750; box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary, Highlight) 14%, transparent); }
		.actions .like:hover:not(:disabled), .actions .like:focus-visible:not(:disabled) { background: color-mix(in oklch, var(--primary, Highlight) 14%, var(--card, Canvas)); color: var(--primary, Highlight); filter: none; box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary, Highlight) 22%, transparent), 0 6px 16px color-mix(in oklch, var(--primary, Highlight) 12%, transparent); }
		.actions .dislike.enabled:hover, .actions .dislike.enabled:focus-visible { color: var(--negative, Mark); border-color: var(--negative, Mark); background: color-mix(in oklch, var(--negative, Mark) 12%, transparent); }
		.actions .decision-selected { outline: 2px solid color-mix(in oklch, currentColor 38%, transparent); outline-offset: 2px; box-shadow: 0 0 0 3px color-mix(in oklch, currentColor 10%, transparent), 0 8px 18px color-mix(in oklch, currentColor 16%, transparent); }
		.actions .dislike.decision-selected { color: var(--negative, Mark); border-color: color-mix(in oklch, var(--negative, Mark) 72%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--negative, Mark) 10%, var(--card, Canvas)); }
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
		.rail:not(.collapsed) { display: flex; flex-direction: column; gap: 6px; padding: 6px 6px 6px 8px; overflow-x: hidden; }
		.phase { width: 100%; display: grid; gap: 5px; margin: 0; padding: 0 0 5px; border-radius: 6px; }
		.phase::before { content: ""; width: 22px; height: 1px; background: var(--border, ButtonBorder); opacity: 0.75; }
		.rail:not(.collapsed) .phase:first-of-type::before { content: none; display: none; }
		.phase-button { width: 100%; min-height: 13px; display: flex; align-items: center; gap: 4px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--muted-foreground, GrayText); }
		.phase-button::after { content: none; }
		.phase-button.active { color: var(--muted-foreground, GrayText); background: transparent; }
		.phase-button:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--foreground, CanvasText) 5%, transparent); }
		.rail:not(.collapsed) .phase-pip { width: 10px; height: 13px; padding: 0; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border: 0 !important; border-radius: 0; outline: 0; box-shadow: none; background: transparent; color: var(--muted-foreground, GrayText); font-size: 9px; font-weight: 900; letter-spacing: 0; }
		.rail:not(.collapsed) .phase-pip.active, .rail:not(.collapsed) .phase-pip.complete { background: transparent; color: var(--muted-foreground, GrayText); }
		.phase-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground, GrayText); font-size: 0.8333em; font-weight: 500; letter-spacing: 0.05em; text-transform: uppercase; }
		.phase-count { display: none; }
		.phase-cards { display: grid; gap: 5px; padding: 0 0 0 8px; }
		.card-button { width: 100%; min-height: 16px; display: flex; align-items: center; gap: 8px; padding: 0; border: 0; border-radius: 5px; color: var(--muted-foreground, GrayText); font-size: 13px; font-weight: 400; text-align: left; }
		.card-button::before { content: none; }
		.card-button:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--foreground, CanvasText) 5%, transparent); }
		.card-button.active { color: var(--foreground, CanvasText); background: transparent; }
		.rail:not(.collapsed) .card-dot { position: relative; width: 14px; height: 14px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border-width: 2px; border-style: solid; border-color: currentColor; border-radius: 999px; background-color: transparent; color: var(--foreground, CanvasText); opacity: 0.95; padding: 0; }
		.rail:not(.collapsed) .card-dot .dot-icon { position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; display: block; pointer-events: none; transform: translate(-50%, -50%); fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
		.rail:not(.collapsed) .card-dot.liked { background-color: var(--primary, Highlight); border-color: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); opacity: 1; }
		.rail:not(.collapsed) .card-dot.disliked { background-color: var(--negative, #dc2626); border-color: var(--negative, #dc2626); color: var(--negative-foreground, #fff); opacity: 1; }
		.rail:not(.collapsed) .card-dot.active { box-shadow: 0 0 0 2px color-mix(in oklch, var(--primary, Highlight) 24%, transparent); opacity: 1; transform: scale(1.06); }
		.rail:not(.collapsed) .card-dot.active:not(.liked):not(.disliked) { background-color: transparent; border-color: var(--primary, Highlight); color: var(--primary, Highlight); }
		.card-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; }
		.card-decision { display: none; }
		.rail-toggle { margin-top: auto; align-self: flex-end; padding: 8px; display: flex; align-items: center; gap: 0.375rem; border: 0; border-radius: 6px; background: transparent; color: var(--muted-foreground, GrayText); transition: color 120ms ease, background 120ms ease; }
		.rail-toggle:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--secondary, var(--muted-foreground, GrayText)) 50%, transparent); }
		.rail-toggle svg { width: 16px; height: 16px; }
		.walkthrough-rail-resize-handle { position: absolute; top: 0; right: -2px; width: 6px; height: 100%; z-index: 5; cursor: col-resize; background: transparent; transition: background 120ms ease; touch-action: none; }
		.walkthrough-rail-resize-handle:hover, .walkthrough-rail-resize-handle:active { background: color-mix(in oklch, var(--primary, Highlight) 25%, transparent); }
		/* Collapsed rail reuses the labelled rail DOM; it only centres the column and hides text. */
		.rail.collapsed { gap: 6px; padding: 6px 3px; overflow-x: hidden; }
		.rail.collapsed .phase { justify-items: center; }
		.rail.collapsed .phase:first-of-type::before { content: none; display: none; }
		.rail.collapsed .phase-button { justify-content: center; gap: 0; }
		.rail.collapsed .phase-cards { padding: 0; justify-items: center; }
		.rail.collapsed .card-button { justify-content: center; gap: 0; min-height: 18px; }
		.rail.collapsed .phase-name, .rail.collapsed .card-title { display: none; }
		.rail.collapsed .phase-pip { width: 24px; height: 13px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0 !important; border-radius: 0; outline: 0; box-shadow: none; background: transparent; color: var(--muted-foreground, GrayText); font-size: 9px; font-weight: 900; letter-spacing: 0.08em; }
		.rail.collapsed .phase-pip.active, .rail.collapsed .phase-pip.complete { background: transparent; color: var(--muted-foreground, GrayText); }
		.rail.collapsed .card-dot { position: relative; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; border-width: 2px; border-style: solid; border-color: currentColor; background-color: transparent; color: var(--foreground, CanvasText); opacity: 0.95; padding: 0; }
		.rail.collapsed .card-dot .dot-icon { position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; display: block; pointer-events: none; transform: translate(-50%, -50%); fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
		.rail.collapsed .card-dot.liked { background-color: var(--primary, Highlight); border-color: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); opacity: 1; }
		.rail.collapsed .card-dot.disliked { background-color: var(--negative, #dc2626); border-color: var(--negative, #dc2626); color: var(--negative-foreground, #fff); opacity: 1; }
		.rail.collapsed .card-dot.active { box-shadow: 0 0 0 2px color-mix(in oklch, var(--primary, Highlight) 24%, transparent); opacity: 1; transform: scale(1.06); }
		.rail.collapsed .card-dot.active:not(.liked):not(.disliked) { background-color: transparent; border-color: var(--primary, Highlight); color: var(--primary, Highlight); }
		.rail.collapsed .rail-toggle { align-self: center; margin-bottom: 8px; padding: 8px; }
		.rail.collapsed .walkthrough-rail-resize-handle { display: none; }
		.content { --walkthrough-content-x: clamp(12px, 1.6vw, 24px); padding: 14px var(--walkthrough-content-x) 0; }
		.inner { width: 100%; max-width: none; min-height: 100%; margin: 0; display: flex; flex-direction: column; }
		.card { display: flex; flex-direction: column; max-width: none; min-height: 100%; }
		.card-head { display: block; padding: 0; border: 0; border-radius: 0; background: transparent; }
		.card-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
		.phase-label { display: inline-block; min-width: 0; padding: 3px 9px; border-radius: 5px; background: color-mix(in oklch, var(--chart-1, var(--primary, Highlight)) 12%, transparent); color: var(--chart-1, var(--primary, Highlight)); font-size: 10.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
		.card h2 { margin: 10px 0 5px; font-size: 24px; letter-spacing: -0.015em; }
		.summary, .rationale { max-width: 850px; line-height: 1.65; }
		.original-description { max-width: 850px; background: color-mix(in oklch, var(--card, Canvas) 86%, var(--background, Canvas)); }
		.modebar { display: flex; align-items: center; gap: 0; margin: 0; flex: 0 0 auto; }
		.modebar .mode-toggle { gap: 2px; padding: 2px; border-radius: 7px; background: color-mix(in oklch, var(--background, Canvas) 62%, transparent); }
		.modebar .mode-toggle button { width: 25px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px; color: var(--muted-foreground, GrayText); }
		.modebar .mode-toggle button.active { background: color-mix(in oklch, var(--primary, Highlight) 22%, transparent); color: var(--primary, Highlight); outline: 1px solid color-mix(in oklch, var(--primary, Highlight) 42%, var(--border, ButtonBorder)); }
		.modebar .mode-icon { width: 15px; height: 15px; display: block; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
		.diff-block { margin: 12px 0; border-radius: 9px; }
		.diff-block.closed .diff-overflow { display: none; }
		.context-toggle { width: 100%; height: 18px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: color-mix(in oklch, var(--info, var(--primary, Highlight)) 10%, transparent); color: var(--muted-foreground, GrayText); }
		.context-toggle:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--primary, Highlight) 18%, transparent); }
		.context-toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
		.diff-file-header-row { display: flex; align-items: stretch; border-bottom: 1px solid var(--border, ButtonBorder); }
		.diff-block.closed .diff-file-header-row { border-bottom: 0; }
		.diff-file-header { display: flex; align-items: center; gap: 9px; flex: 1 1 auto; min-width: 0; padding: 9px 12px; border: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
		.diff-external-link { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 36px; padding: 0; border-left: 1px solid var(--border, ButtonBorder); color: var(--muted-foreground, GrayText); text-decoration: none; }
		.diff-external-link:hover { color: var(--foreground, CanvasText); background: color-mix(in oklch, var(--primary, Highlight) 7%, transparent); }
		.diff-external-link svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
		.caret { width: 12px; color: var(--muted-foreground, GrayText); transition: transform 140ms ease; font-family: ui-monospace, monospace; }
		.diff-block.open .caret { transform: rotate(90deg); }
		.diff-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted-foreground, GrayText); }
		.diff-path b { color: var(--foreground, CanvasText); }
		.diff-counts { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 800; }
		.diff-add-count { color: var(--positive, green); }
		.diff-del-count { color: var(--negative, red); }
		.diff-comment-count { font-size: 11px; color: var(--negative, red); background: color-mix(in oklch, var(--negative, red) 12%, transparent); border-radius: 999px; padding: 2px 7px; font-weight: 800; }
		.split-grid { min-width: 980px; }
		.hunk-header { grid-template-columns: 60px minmax(0, 1fr); font-size: 11.5px; line-height: 1.6; }
		.split-row .diff-line:first-child { border-right: 1px solid var(--border, ButtonBorder); }
		.diff-line { position: relative; grid-template-columns: 42px 18px minmax(280px, 1fr) 26px; font-size: 11.5px; line-height: 1.6; }
		.diff-line:hover, .diff-line:focus-visible { background: color-mix(in oklch, var(--primary, Highlight) 6%, transparent); }
		.diff-line.commented .line-no::before { content: "●"; position: absolute; left: 3px; color: var(--primary, Highlight); font-size: 8px; }
		.line-no { position: relative; text-align: right; }
		.tok-keyword { color: var(--chart-4, var(--primary, Highlight)); }
		.tok-string { color: var(--chart-2, var(--positive, green)); }
		.tok-number { color: var(--chart-3, var(--info, Highlight)); }
		.tok-comment { color: var(--muted-foreground, GrayText); font-style: italic; }
		.tok-property { color: var(--chart-1, var(--primary, Highlight)); }
		.tok-function { color: var(--chart-6, var(--primary, Highlight)); }
		.comment-cue { align-self: center; justify-self: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); line-height: 18px; font-weight: 800; }
		.diff-line.editing .comment-cue, .diff-line.commented .comment-cue { opacity: 1; }
		.card-comments { margin: 18px 0 0; border-color: color-mix(in oklch, var(--warning, orange) 22%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--warning, orange) 5%, transparent); }
		.card-comments h3 { font-size: 11px; color: var(--muted-foreground, GrayText); text-transform: uppercase; letter-spacing: 0.07em; }
		.card-comment-chips { display: flex; flex-wrap: wrap; gap: 5px; }
		.chip { display: inline-flex; align-items: center; padding: 5px 9px; border: 1px solid color-mix(in oklch, var(--warning, orange) 32%, var(--border, ButtonBorder)); border-radius: 7px; background: var(--card, Canvas); color: var(--foreground, CanvasText); font-size: 12px; line-height: 1.35; }
		.chip:hover { background: color-mix(in oklch, var(--warning, orange) 14%, transparent); }
		.card-comment-card { margin-top: 10px; padding: 10px 12px; border-left: 3px solid var(--negative, red); background: color-mix(in oklch, var(--negative, red) 5%, transparent); border-radius: 0 6px 6px 0; }
		.actions { margin: auto calc(-1 * var(--walkthrough-content-x)) 0; padding: 16px var(--walkthrough-content-x) 10px; border-top: 0; background: transparent; isolation: isolate; flex-wrap: nowrap; }
		.actions::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: linear-gradient(to bottom, transparent 0 12px, color-mix(in oklch, var(--background, Canvas) 94%, transparent) 12px); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); mask-image: linear-gradient(to bottom, transparent 0, rgba(0, 0, 0, 0.16) 6px, black 16px); -webkit-mask-image: linear-gradient(to bottom, transparent 0, rgba(0, 0, 0, 0.16) 6px, black 16px); }
		.actions .prev { border-color: transparent; color: var(--muted-foreground, GrayText); background: transparent; }
		.body.narrow .decision-note { display: none; }
		.body.narrow .actions { gap: 6px; justify-content: flex-end; }
		.body.narrow .actions button { flex: 0 0 auto; padding-left: 9px; padding-right: 9px; }

		/* ===== Orientation guided steps ===== */
		.guide-card .inner { min-height: 100%; }
		.guide { max-width: 720px; margin: 0 auto; min-height: 100%; display: flex; flex-direction: column; flex: 1 1 auto; }
		.guide-top { display: flex; align-items: center; gap: 12px; }
		.guide .eyebrow { display: inline-block; padding: 3px 9px; border-radius: 5px; background: color-mix(in oklch, var(--chart-1, var(--primary, Highlight)) 14%, transparent); color: var(--chart-1, var(--primary, Highlight)); font-size: 10.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
		.guide-count { margin-left: auto; color: var(--muted-foreground, GrayText); font-size: 11px; font-weight: 600; }
		.guide-stage { flex: 1 1 auto; display: grid; align-content: start; gap: 14px; padding: 26px 2px 10px; }
		.beat { display: grid; gap: 12px; animation: pr-walkthrough-beat-in 180ms ease; }
		@keyframes pr-walkthrough-beat-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
		.beat h2 { margin: 4px 0 0; font-size: 26px; line-height: 1.18; letter-spacing: -0.015em; }
		.beat p { margin: 0; font-size: 15px; line-height: 1.7; color: color-mix(in oklch, var(--foreground, CanvasText) 88%, var(--muted-foreground, GrayText)); max-width: 640px; }
		.beat-verdict { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
		.beat-stats { display: inline-flex; align-items: center; gap: 7px; color: var(--muted-foreground, GrayText); font-size: 12px; }
		.beat-stats .stat-add { color: var(--positive, var(--chart-3, green)); font-weight: 700; }
		.beat-stats .stat-del { color: var(--negative, var(--chart-5, red)); font-weight: 700; }
		.verdict { display: inline-flex; align-items: center; gap: 10px; padding: 7px 12px 7px 10px; border: 1px solid color-mix(in oklch, var(--positive, green) 40%, var(--border, ButtonBorder)); border-radius: 999px; background: color-mix(in oklch, var(--positive, green) 12%, transparent); }
		.verdict .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--positive, green); }
		.verdict b { color: var(--positive, green); font-weight: 800; letter-spacing: 0.04em; }
		.verdict .conf { color: var(--muted-foreground, GrayText); font-size: 12px; }
		.verdict.verdict-request_changes { border-color: color-mix(in oklch, var(--negative, red) 40%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--negative, red) 12%, transparent); }
		.verdict.verdict-request_changes .dot { background: var(--negative, red); }
		.verdict.verdict-request_changes b { color: var(--negative, red); }
		.verdict.verdict-comment { border-color: color-mix(in oklch, var(--warning, orange) 40%, var(--border, ButtonBorder)); background: color-mix(in oklch, var(--warning, orange) 12%, transparent); }
		.verdict.verdict-comment .dot { background: var(--warning, orange); }
		.verdict.verdict-comment b { color: var(--warning, orange); }
		.verdict.verdict-unknown { border-color: var(--border, ButtonBorder); background: color-mix(in oklch, var(--muted-foreground, GrayText) 10%, transparent); }
		.verdict.verdict-unknown .dot { background: var(--muted-foreground, GrayText); }
		.verdict.verdict-unknown b { color: var(--muted-foreground, GrayText); }
		.sec-label { color: var(--muted-foreground, GrayText); font-size: 10.5px; font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase; }
		.concern-list { display: grid; gap: 8px; }
		.filemap { display: grid; gap: 6px; }
		.filerow { display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 10px; padding: 8px 10px; border: 1px solid var(--border, ButtonBorder); border-radius: 9px; background: var(--card, Canvas); }
		.filerow code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--foreground, CanvasText); }
		.filerow .role { font-size: 10px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 7px; border-radius: 5px; white-space: nowrap; }
		.filerow .role.core { color: var(--chart-1, var(--primary, Highlight)); background: color-mix(in oklch, var(--chart-1, var(--primary, Highlight)) 15%, transparent); }
		.filerow .role.support { color: var(--chart-2, var(--info, Highlight)); background: color-mix(in oklch, var(--chart-2, var(--info, Highlight)) 16%, transparent); }
		.filerow .role.verify { color: var(--chart-3, var(--positive, green)); background: color-mix(in oklch, var(--chart-3, var(--positive, green)) 16%, transparent); }
		.filerow .role.docs { color: var(--muted-foreground, GrayText); background: color-mix(in oklch, var(--muted-foreground, GrayText) 14%, transparent); }
		.filerow .note { grid-column: 2; color: var(--muted-foreground, GrayText); font-size: 12px; }
		.concern { display: grid; grid-template-columns: auto 1fr; gap: 10px; padding: 10px 12px; border: 1px solid var(--border, ButtonBorder); border-left-width: 3px; border-radius: 8px; background: var(--card, Canvas); }
		.concern.blocking { border-left-color: var(--negative, red); }
		.concern.non-blocking { border-left-color: var(--info, var(--primary, Highlight)); }
		.concern.q { border-left-color: var(--warning, orange); }
		.concern.nit { border-left-color: var(--muted-foreground, GrayText); }
		.concern .tag { align-self: start; margin-top: 1px; font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 7px; border-radius: 5px; }
		.concern.blocking .tag { color: var(--negative, red); background: color-mix(in oklch, var(--negative, red) 14%, transparent); }
		.concern.non-blocking .tag { color: var(--info, var(--primary, Highlight)); background: color-mix(in oklch, var(--info, var(--primary, Highlight)) 16%, transparent); }
		.concern.q .tag { color: var(--warning, orange); background: color-mix(in oklch, var(--warning, orange) 16%, transparent); }
		.concern.nit .tag { color: var(--muted-foreground, GrayText); background: color-mix(in oklch, var(--muted-foreground, GrayText) 14%, transparent); }
		.concern p { margin: 0; line-height: 1.55; }
		.guide-nav { display: flex; align-items: center; gap: 10px; padding: 14px 0 4px; border-top: 1px solid var(--border, ButtonBorder); }
		.guide-nav .spacer { flex: 1 1 auto; }
		.guide-nav button { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 7px 14px; border: 1px solid var(--border, ButtonBorder); border-radius: 9px; background: var(--card, Canvas); color: inherit; font: inherit; font-weight: 600; }
		.guide-nav button:hover:not(:disabled) { background: color-mix(in oklch, var(--primary, Highlight) 10%, transparent); }
		.guide-nav button:disabled { opacity: 0.45; cursor: not-allowed; }
		.guide-nav .next { border-color: color-mix(in oklch, var(--primary, Highlight) 55%, var(--border, ButtonBorder)); background: var(--primary, Highlight); color: var(--primary-foreground, HighlightText); }
		.guide-nav .ghost { border-color: transparent; background: transparent; color: var(--muted-foreground, GrayText); }
		/* Per-beat orientation rail circles: visited beats use a clean transparent tick (no filled disc). */
		.rail .card-dot.orientation-dot.done { background-color: transparent; border-color: color-mix(in oklch, var(--primary, Highlight) 65%, transparent); color: var(--primary, Highlight); opacity: 1; }

		@media (max-width: 760px) {
			.header { padding: 12px; }
			.title-row { display: grid; }
			.progress-wrap { min-width: 0; }
			.progress-label { text-align: left; }
			.content { padding: 12px; }
			.beat h2 { font-size: 22px; }
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
		if (changed.has("jobId") || changed.has("cards")) {
			this._orientationBeatIndex = 0;
		}
		if (changed.has("persistenceKey")) {
			this.restorePersistedState();
			return;
		}
		if (changed.has("cards") && this.persistenceKey) {
			this.restorePersistedState();
			return;
		}
		if (changed.has("status") && (this.status === "loading" || this.status === "waiting_for_yaml" || this.status === "validation_failed" || this.status === "error")) {
			this._exportPreviewOpen = false;
			this._exportPreview = undefined;
			this._exportError = "";
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

	private get isRailCollapsed(): boolean {
		return this.isNarrowLayout || this._railCollapsed;
	}

	private get railWidth(): number {
		return Math.max(150, Math.min(360, Math.round(this._railWidth)));
	}

	private get effectiveDiffMode(): PrWalkthroughDiffMode {
		return this._diffModeOverride ?? defaultDiffModeForWidth(this.isNarrowLayout ? 0 : this._panelWidth);
	}

	private renderGithubMark(): TemplateResult {
		return html`<svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg>`;
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

	private get orientationCard(): PrWalkthroughCard | undefined {
		return this.cards.find(card => card.phaseId === "orientation");
	}

	/** True when the orientation card uses the guided step-through (`sections`) model. */
	private get isOrientationGuided(): boolean {
		return !!this.orientationCard?.sections?.length;
	}

	private isGuidedOrientationCard(card: PrWalkthroughCard | undefined): boolean {
		return !!card && card.phaseId === "orientation" && !!card.sections?.length;
	}

	private clampBeatIndex(index: number): number {
		const count = this.orientationCard?.sections?.length ?? 0;
		if (count <= 0) return 0;
		return Math.max(0, Math.min(count - 1, index));
	}

	private selectOrientationBeat(index: number): void {
		const orientation = this.orientationCard;
		if (!orientation) return;
		this._orientationBeatIndex = this.clampBeatIndex(index);
		if (this._activeCardId !== orientation.id) {
			this.selectCard(orientation.id);
		} else {
			this.persistState();
		}
	}

	private goOrientationBack = (): void => {
		this._orientationBeatIndex = this.clampBeatIndex(this._orientationBeatIndex - 1);
	};

	private goOrientationNext = (): void => {
		const sections = this.orientationCard?.sections ?? [];
		if (this._orientationBeatIndex >= sections.length - 1) {
			this.completeOrientationAndAdvance();
			return;
		}
		this._orientationBeatIndex = this.clampBeatIndex(this._orientationBeatIndex + 1);
	};

	private completeOrientationAndAdvance(): void {
		const orientation = this.orientationCard;
		if (!orientation) return;
		if (!this._completedCardIds.includes(orientation.id)) {
			this._completedCardIds = [...this._completedCardIds, orientation.id];
			this.emitDraftChange();
		}
		this.persistState();
		const next = this.nextCardId(orientation.id);
		if (next) this.selectCard(next);
		else this.emitComplete();
	}

	private resetInteractionState(): void {
		this._activeCardId = this.firstAvailableCardId();
		this._orientationBeatIndex = 0;
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
		this._contextExpansions = {};
		this._copied = false;
		this._exportPreviewOpen = false;
		this._exportPreviewLoading = false;
		this._exportPreview = undefined;
		this._exportError = "";
		this._exportSubmitting = false;
		this._exportResult = undefined;
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

	private get canUseExportApi(): boolean {
		if (!this.exportCapability) return false;
		if (this.exportCapability.available === false || this.exportCapability.enabled === false || this.exportCapability.canSubmit === false) return false;
		return true;
	}

	private get exportUnavailableReason(): string {
		return this.exportCapability?.reason || this.exportCapability?.message || "GitHub export is not available for this walkthrough. You can copy the draft review instead.";
	}

	private get apiChangesetId(): string {
		if (this.changesetId.trim()) return this.changesetId.trim();
		const key = this.persistenceKey.replace(/^walkthrough:/, "").trim();
		if (key) {
			try { return decodeURIComponent(key); }
			catch { return key; }
		}
		const changeset = this.effectiveChangeset;
		return `${changeset.baseSha}..${changeset.headSha}`;
	}

	private get prIdentity(): { kicker: string; title: string; linkLabel: string; url: string } {
		const changeset = this.effectiveChangeset;
		const url = safeExternalUrl(changeset.prUrl) || safeExternalUrl(changeset.externalUrl) || "";
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
		const derived = { files: new Set(blocks.map(block => block.filePath)).size, additions: 0, deletions: 0 };
		for (const block of blocks) {
			for (const hunk of block.hunks) {
				for (const line of hunk.lines) {
					if (line.kind === "add") derived.additions += 1;
					if (line.kind === "del") derived.deletions += 1;
				}
			}
		}
		return {
			files: Math.max(changeset.filesChanged ?? derived.files, 0),
			additions: Math.max(changeset.additions ?? derived.additions, 0),
			deletions: Math.max(changeset.deletions ?? derived.deletions, 0),
		};
	}

	private formatNumber(value: number): string {
		return new Intl.NumberFormat("en-US").format(value);
	}

	override render(): TemplateResult {
		const active = this.activeCard;
		const activeCardId = this.status === "ready" && !this.cards.length ? "empty" : active?.id ?? this.status;
		return html`
			<section class="shell" data-testid="pr-walkthrough-panel" data-active-card-id=${activeCardId} data-diff-mode=${this.effectiveDiffMode} data-status=${this.status}>
				${this.renderHeader()}
				<div class="body ${this.isRailCollapsed ? "narrow" : ""}" style=${`--walkthrough-rail-width: ${this.railWidth}px;`}>
					${this.renderRail()}
					<main class="content">${this.renderMainContent(active)}</main>
				</div>
				${this._exportPreviewOpen ? this.renderExportDialog() : nothing}
			</section>
		`;
	}

	private renderHeader(): TemplateResult {
		const completed = this._completedCardIds.filter(id => this.reviewCards.some(card => card.id === id)).length;
		const total = Math.max(this.reviewCards.length, 1);
		const percent = Math.round((completed / total) * 100);
		const identity = this.prIdentity;
		const stats = this.changesetStats;
		const submitTitle = completed < this.reviewCards.length
			? "Review every non-audit card before export."
			: this.canUseExportApi ? "Preview GitHub review comments before submitting." : this.exportUnavailableReason;
		const githubLinkLabel = "Open on GitHub";
		return html`
			<header class="header" data-testid="pr-walkthrough-header" data-legacy-testid="pr-walkthrough-review-header">
				<div class="title-wrap" data-testid="pr-walkthrough-pr-title">
					<h1 class="title" title=${identity.title}>${identity.title}</h1>
					<div class="title-meta-row">
						<div class="stats" data-testid="pr-walkthrough-pr-stats">
							<span class="stat-files" data-testid="pr-walkthrough-stat-files">${stats.files} files</span>
							<span class="stat-sep" aria-hidden="true">·</span>
							<span class="stat-lines" aria-label="Line changes">
								<span class="stat-add" data-testid="pr-walkthrough-stat-additions">+${this.formatNumber(stats.additions)}</span>
								<span class="stat-del" data-testid="pr-walkthrough-stat-deletions">-${this.formatNumber(stats.deletions)}</span>
							</span>
						</div>
						${identity.url ? html`
							<a class="pr-link" data-testid="pr-walkthrough-pr-link" href=${identity.url} target="_blank" rel="noopener noreferrer" title=${`Open ${identity.linkLabel} on GitHub`}>${this.renderGithubMark()}<span>${githubLinkLabel}</span></a>
						` : nothing}
					</div>
				</div>
				<span class="header-spacer"></span>
				<div class="progress-wrap" aria-label="Walkthrough progress" data-testid="pr-walkthrough-progress">
					<div class="progress-track"><div class="progress-fill" style="width: ${percent}%"></div></div>
					<div class="progress-label">${completed} / ${this.reviewCards.length} reviewed</div>
				</div>
				<button class="submit-button" data-testid="pr-walkthrough-submit-review" type="button" title=${submitTitle} ?disabled=${completed < this.reviewCards.length || this.status === "loading" || this.status === "waiting_for_yaml" || this.status === "validation_failed" || this.status === "error"} @click=${this.openExportPreview}><svg class="submit-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4 20-7Z"></path></svg><span>Submit</span></button>
			</header>
		`;
	}

	private renderRail(): TemplateResult {
		if (!this.cards.length && (this.status === "loading" || this.status === "waiting_for_yaml" || this.status === "validation_failed" || this.status === "error" || this.status === "ready")) return this.renderPlaceholderRail();
		const collapsed = this.isRailCollapsed;
		return html`
			<nav class="rail ${collapsed ? "collapsed" : ""}" data-testid=${collapsed ? "pr-walkthrough-collapsed-rail" : "pr-walkthrough-labelled-rail"} aria-label="PR walkthrough phases">
				${collapsed ? nothing : html`<div class="walkthrough-rail-resize-handle" data-testid="pr-walkthrough-rail-resize" title="Drag to resize walkthrough sidebar" @pointerdown=${this.onRailResizePointerDown} @dblclick=${this.resetRailWidth}></div>`}
				${PHASES.map((phase, index) => {
					const cards = this.cardsForPhase(phase.id);
					if (cards.length === 0) return nothing;
					const phaseActive = cards.some(card => card.id === this.activeCard?.id);
					const complete = cards.every(card => this._completedCardIds.includes(card.id) || card.phaseId === "audit");
					const guidedOrientationPhase = phase.id === "orientation" && this.isOrientationGuided;
					return html`
						<section class="phase ${phaseActive ? "active" : ""} ${complete && !phaseActive ? "complete" : ""}" data-phase-id=${phase.id}>
							<button class="phase-button ${phaseActive ? "active" : ""}" data-testid="pr-walkthrough-phase-button" type="button" aria-label=${`Open ${phase.label}`} title=${`Phase ${index}: ${phase.label}`} @click=${() => guidedOrientationPhase ? this.selectOrientationBeat(0) : this.selectCard(cards[0].id)}>
								<span class="phase-pip ${phaseActive ? "active" : ""} ${complete && !phaseActive ? "complete" : ""}" data-testid="pr-walkthrough-phase-pip" aria-hidden="true">${index}</span><span class="phase-name">${phase.label}</span><span class="phase-count">${cards.filter(card => this._completedCardIds.includes(card.id)).length}/${cards.length}</span>
							</button>
							<div class="phase-cards ${guidedOrientationPhase ? "orientation-steps" : ""}" data-testid=${guidedOrientationPhase ? "pr-walkthrough-orientation-rail" : nothing}>${guidedOrientationPhase ? this.renderOrientationRailSteps() : cards.map(card => this.renderRailCardButton(card))}</div>
						</section>
					`;
				})}
				${this.renderRailControls()}
			</nav>
		`;
	}

	private renderPlaceholderRail(): TemplateResult {
		return html`
			<nav class="rail ${this.isRailCollapsed ? "collapsed" : ""}" data-testid=${this.isRailCollapsed ? "pr-walkthrough-collapsed-rail" : "pr-walkthrough-labelled-rail"} aria-label="PR walkthrough phases">
				${this.isRailCollapsed ? html`<span class="phase-pip ${this.status === "error" ? "error" : "active"}" title=${this.status}>!</span>` : html`
					<div class="empty">${this.status === "loading" ? "Resolving changeset…" : this.status === "waiting_for_yaml" || this.status === "validation_failed" ? "Waiting for walkthrough" : this.status === "error" ? "Walkthrough unavailable" : "No changed files"}</div>
				`}
				${this.renderRailControls()}
			</nav>
		`;
	}

	private renderRailControls(): TemplateResult {
		const collapsed = this.isRailCollapsed;
		return html`
			<button class="rail-toggle" data-testid="pr-walkthrough-rail-toggle" type="button" title=${collapsed ? "Expand walkthrough sidebar" : "Collapse walkthrough sidebar"} @click=${this.toggleRailCollapsed}>
				${collapsed ? icon(PanelLeftOpen, "sm") : icon(PanelLeftClose, "sm")}
			</button>
		`;
	}

	private toggleRailCollapsed = (): void => {
		if (this.isNarrowLayout) return;
		this._railCollapsed = !this._railCollapsed;
	};

	private resetRailWidth = (event?: Event): void => {
		event?.preventDefault();
		this._railWidth = 240;
	};

	private onRailResizePointerDown = (event: PointerEvent): void => {
		event.preventDefault();
		if (this.isRailCollapsed) return;
		const handle = event.currentTarget as HTMLElement;
		const startX = event.clientX;
		const startWidth = this.railWidth;
		try { handle.setPointerCapture(event.pointerId); } catch {}
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		const onMove = (moveEvent: PointerEvent) => {
			this._railWidth = Math.max(150, Math.min(360, Math.round(startWidth + moveEvent.clientX - startX)));
		};
		const onUp = (upEvent: PointerEvent) => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			try { handle.releasePointerCapture(upEvent.pointerId); } catch {}
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
	};

	private renderRailCardButton(card: PrWalkthroughCard): TemplateResult {
		const decision = this._decisions[card.id]?.value;
		const comments = this.commentCountForCard(card.id);
		return html`
			<button class="card-button ${card.id === this.activeCard?.id ? "active" : ""} ${this._completedCardIds.includes(card.id) ? "complete" : ""} ${decision === "liked" ? "liked" : ""} ${decision === "disliked" ? "disliked" : ""}" data-testid="pr-walkthrough-card-step" data-card-id=${card.id} type="button" aria-label=${card.title} title=${card.title} @click=${() => this.selectCard(card.id)}>
				<span class="card-dot card-dot-rail ${card.id === this.activeCard?.id ? "active" : ""} ${decision === "liked" ? "liked" : ""} ${decision === "disliked" ? "disliked" : ""}" aria-hidden="true">${decision === "liked" ? html`<svg class="dot-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 10v12"></path><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"></path></svg>` : decision === "disliked" ? html`<svg class="dot-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17 14V2"></path><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"></path></svg>` : nothing}</span>
				<span class="card-title">${card.navLabel ?? deriveNavLabel(card.title)}</span>
				<span class="card-decision">${comments ? comments : decision ? decision : card.phaseId === "audit" ? "draft" : "pending"}</span>
			</button>
		`;
	}

	private renderOrientationRailSteps(): TemplateResult | typeof nothing {
		const orientation = this.orientationCard;
		const sections = orientation?.sections ?? [];
		if (!orientation || sections.length === 0) return nothing;
		const orientationActive = this.activeCard?.id === orientation.id;
		const orientationComplete = this._completedCardIds.includes(orientation.id);
		const beatIndex = this.clampBeatIndex(this._orientationBeatIndex);
		return html`${sections.map((section, idx) => {
			const current = orientationActive && idx === beatIndex;
			const done = orientationActive ? idx < beatIndex : orientationComplete;
			return html`
				<button
					class="card-button orientation-step ${current ? "active" : ""}"
					data-testid="pr-walkthrough-orientation-step"
					data-beat-index=${idx}
					data-state=${current ? "current" : done ? "visited" : "upcoming"}
					type="button"
					title=${section.heading}
					aria-label=${section.navLabel}
					@click=${() => this.selectOrientationBeat(idx)}
				>
					<span class="card-dot orientation-dot ${current ? "active" : ""} ${done && !current ? "done" : ""}" aria-hidden="true">${done && !current ? html`<svg class="dot-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>` : nothing}</span>
					<span class="card-title">${section.navLabel}</span>
				</button>
			`;
		})}`;
	}

	private renderMainContent(active: PrWalkthroughCard | undefined): TemplateResult {
		if (this.status === "waiting_for_yaml") return html`${this.renderWarningBanners()}${this.renderWaitingState()}`;
		if (this.status === "validation_failed") return html`${this.renderWarningBanners()}${this.renderValidationFailedState()}`;
		if (this.status === "loading" && active) return html`${this.renderWarningBanners()}${this.renderLoadingState()}${this.renderCard(active)}`;
		if (this.status === "loading") return html`${this.renderWarningBanners()}${this.renderLoadingState()}`;
		if (this.status === "error" && active) return html`${this.renderWarningBanners()}${this.renderErrorState()}${this.renderCard(active)}`;
		if (this.status === "error") return html`${this.renderWarningBanners()}${this.renderErrorState()}`;
		if (this.status === "ready" && this.cards.length === 0) return html`${this.renderWarningBanners()}${this.renderEmptyState()}`;
		if (!active) return html`${this.renderWarningBanners()}<div class="state-card" data-testid="pr-walkthrough-empty-state"><h2>No walkthrough cards are available.</h2><p>There are no logical review cards for this changeset.</p></div>`;
		return html`${this.renderWarningBanners()}${this.renderCard(active)}`;
	}

	private renderWarningBanners(extraWarnings: WalkthroughWarning[] = []): TemplateResult | typeof nothing {
		const warnings = [...this.warnings, ...extraWarnings].filter(warning => warning && warning.message);
		if (!warnings.length) return nothing;
		return html`
			<div class="banner-stack" data-testid="pr-walkthrough-warning-list">
				${warnings.map(warning => html`
					<div class="banner ${warning.severity}" data-testid="pr-walkthrough-warning" data-warning-code=${warning.code}>
						<strong>${warning.severity === "error" ? "Error" : warning.severity === "warning" ? "Warning" : "Notice"}${warning.code ? ` · ${warning.code}` : ""}</strong>
						<div>${warning.message}</div>
						${warning.filePath ? html`<div class="file">${warning.filePath}</div>` : nothing}
					</div>
				`)}
			</div>
		`;
	}

	private validationIssues(): WalkthroughValidationIssue[] {
		const summary = this.validationError;
		if (!summary || typeof summary !== "object") return [];
		const issues = Array.isArray(summary.errors) ? summary.errors : Array.isArray(summary.issues) ? summary.issues : [];
		return issues.filter((issue): issue is WalkthroughValidationIssue => !!issue && typeof issue === "object").slice(0, 8);
	}

	private validationSummaryMessage(): string {
		const summary = this.validationError;
		if (summary && typeof summary.message === "string" && summary.message.trim()) return summary.message.trim();
		const first = this.validationIssues().find(issue => typeof issue.message === "string" && issue.message.trim());
		return first?.message?.trim() || "The submitted YAML did not match the walkthrough schema.";
	}

	private renderWaitingState(): TemplateResult {
		return html`
			<section class="state-card" data-testid="pr-walkthrough-waiting" aria-live="polite">
				<span data-testid="pr-walkthrough-waiting-state" hidden></span>
				<h2>Waiting for walkthrough</h2>
				<p>The read-only walkthrough agent is reviewing the PR. Cards appear here only after it calls <code>submit_pr_walkthrough_yaml</code> with valid YAML.</p>
				<p>Progress updates will appear in the chat while the panel waits.</p>
				<div class="skeleton" aria-hidden="true">
					<div class="skeleton-line short"></div>
					<div class="skeleton-line medium"></div>
					<div class="skeleton-box"></div>
				</div>
			</section>
		`;
	}

	private renderValidationFailedState(): TemplateResult {
		const issues = this.validationIssues();
		return html`
			<section class="state-card" data-testid="pr-walkthrough-validation-failed" role="status" aria-live="polite">
				<span data-testid="pr-walkthrough-validation-failed-state" hidden></span>
				<h2>YAML needs changes</h2>
				<p>${this.validationSummaryMessage()}</p>
				${issues.length ? html`
					<ul class="validation-list" data-testid="pr-walkthrough-validation-errors">
						${issues.map(issue => html`
							<li data-testid="pr-walkthrough-validation-error">
								${issue.path ? html`<span class="validation-path">${issue.path}</span>` : nothing}
								<span>${issue.message || "Invalid field"}</span>
							</li>
						`)}
					</ul>
				` : nothing}
				<div class="state-actions">
					<button type="button" class="copy-button" data-testid="pr-walkthrough-validation-view-chat" @click=${this.focusChat}>View details in chat</button>
				</div>
			</section>
		`;
	}

	private focusChat(): void {
		this.dispatchEvent(new CustomEvent("pr-walkthrough-focus-chat", { bubbles: true, composed: true, detail: { jobId: this.jobId } }));
	}

	private renderOriginalPrDescription(card: PrWalkthroughCard): TemplateResult | typeof nothing {
		const body = this.effectiveChangeset.prBody ?? "";
		if (card.phaseId !== "orientation" || !body.trim()) return nothing;
		return html`
			<details class="original-description" data-testid="pr-walkthrough-original-description">
				<summary data-testid="pr-walkthrough-original-description-toggle">
					Original PR description
					<span class="original-description-meta">Source material from the PR body. Compare this with the inferred author intent above.</span>
				</summary>
				<pre class="original-description-body" data-testid="pr-walkthrough-original-description-body">${body}</pre>
			</details>
		`;
	}

	private renderLoadingState(): TemplateResult {
		return html`
			<section class="state-card" data-testid="pr-walkthrough-loading" aria-live="polite">
				<span data-testid="pr-walkthrough-loading-state" hidden></span>
				<h2>Resolving walkthrough…</h2>
				<p>Loading PR metadata, changed files, diff hunks, and logical review cards.</p>
				<div class="skeleton" aria-hidden="true">
					<div class="skeleton-line short"></div>
					<div class="skeleton-line medium"></div>
					<div class="skeleton-box"></div>
				</div>
			</section>
		`;
	}

	private retryWalkthroughResolve(): void {
		this.dispatchEvent(new CustomEvent("open-pr-walkthrough", {
			bubbles: true,
			composed: true,
			detail: { ...(this.changeset || {}), changesetId: this.changesetId || undefined },
		}));
	}

	private renderErrorState(): TemplateResult {
		const message = this.error || "Unable to resolve this walkthrough.";
		const isAuth = /auth|permission|rate|token/i.test(message);
		return html`
			<section class="state-card" data-testid="pr-walkthrough-error" role="alert">
				<span data-testid="pr-walkthrough-error-state" hidden></span>
				<h2>${/not found/i.test(message) ? "Pull request not found" : "Walkthrough unavailable"}</h2>
				<p>${message}</p>
				${isAuth ? html`<p>Check GitHub credentials or repository permissions, then retry from the walkthrough command.</p>` : nothing}
				<button type="button" class="copy-button" @click=${this.retryWalkthroughResolve}>Retry</button>
			</section>
		`;
	}

	private renderEmptyState(): TemplateResult {
		return html`
			<section class="state-card" data-testid="pr-walkthrough-empty-state">
				<h2>No changed files</h2>
				<p>This changeset resolved successfully but there are no diff hunks to review. Use Submit review to preview or copy a draft summary without publishing anything.</p>
			</section>
		`;
	}

	private renderCard(card: PrWalkthroughCard): TemplateResult {
		if (this.isGuidedOrientationCard(card)) return this.renderOrientationGuideCard(card);
		const phaseIndex = PHASES.findIndex(item => item.id === card.phaseId);
		const phase = PHASES[phaseIndex]?.label ?? card.phaseId;
		const dislikeDisabled = cardRequiresCommentForDislike({ comments: this._comments }, card.id);
		const commentCount = this.commentCountForCard(card.id);
		const decision = this._decisions[card.id]?.value;
		return html`
			<article class="card" data-testid="pr-walkthrough-card" data-active="true" data-card-id=${card.id} data-phase-id=${card.phaseId}>
				<div class="inner">
					<section class="card-head">
						<div class="card-top">
							<div class="phase-label" data-testid="pr-walkthrough-card-phase-tag">Phase ${Math.max(phaseIndex, 0)} · ${phase}</div>
							${card.diffBlocks.length ? this.renderDiffModeChooser() : nothing}
						</div>
						<h2 data-testid="pr-walkthrough-card-title">${card.title}</h2>
						<p class="summary" data-testid="pr-walkthrough-card-summary">${card.summary}</p>
						${card.rationale ? html`<p class="rationale">${card.rationale}</p>` : nothing}
						${card.checklist?.length ? html`<ul class="checklist">${card.checklist.map(item => html`<li>${item}</li>`)}</ul>` : nothing}
						${this.renderOriginalPrDescription(card)}
					</section>
					${card.diffBlocks.map(block => this.renderDiffBlockSafe(card, block))}
					${this.renderCardComments(card)}
					${card.phaseId === "audit" ? this.renderAuditDraftSection() : nothing}
					<div class="actions">
						<span class="decision-note">${commentCount ? html`<b>${commentCount}</b> comment${commentCount === 1 ? "" : "s"} drafted on this card.` : dislikeDisabled ? "Add a comment to enable Dislike." : "Ready for a decision."}</span>
						<button data-testid="pr-walkthrough-prev" class="prev" type="button" @click=${this.goPrev} ?disabled=${!this.previousCardId()}><svg class="nav-icon prev-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 18-6-6 6-6"></path></svg>Prev</button>
						<button data-testid="pr-walkthrough-dislike" class="dislike ${dislikeDisabled ? "" : "enabled"} ${decision === "disliked" ? "decision-selected" : ""}" type="button" aria-pressed=${decision === "disliked"} ?disabled=${dislikeDisabled} @click=${() => this.recordDecision(card, "disliked")}><svg class="decision-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17 14V2"></path><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"></path></svg>Dislike${commentCount ? ` (${commentCount})` : ""}<svg class="nav-icon next-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"></path></svg></button>
						<button data-testid="pr-walkthrough-like" class="like ${decision === "liked" ? "decision-selected" : ""}" type="button" aria-pressed=${decision === "liked"} @click=${() => this.recordDecision(card, "liked")}><svg class="decision-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 10v12"></path><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"></path></svg>Like<svg class="nav-icon next-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"></path></svg></button>
					</div>
				</div>
			</article>
		`;
	}

	private renderOrientationGuideCard(card: PrWalkthroughCard): TemplateResult {
		const sections = card.sections ?? [];
		const index = this.clampBeatIndex(this._orientationBeatIndex);
		const section = sections[index];
		const isLast = index >= sections.length - 1;
		return html`
			<article class="card guide-card" data-testid="pr-walkthrough-card" data-active="true" data-card-id=${card.id} data-phase-id=${card.phaseId}>
				<div class="inner">
					<div class="guide" data-testid="pr-walkthrough-orientation-guide">
						<div class="guide-top">
							<span class="eyebrow" data-testid="pr-walkthrough-guide-eyebrow">Phase 0 · Orientation</span>
							<span class="guide-count" data-testid="pr-walkthrough-guide-counter">${index + 1} / ${sections.length}</span>
						</div>
						<div class="guide-stage">
							${section ? this.renderOrientationBeat(card, section) : nothing}
						</div>
						<div class="guide-nav" data-testid="pr-walkthrough-guide-nav">
							<button class="ghost" data-testid="pr-walkthrough-guide-back" type="button" ?disabled=${index === 0} @click=${this.goOrientationBack}>‹ Back</button>
							<div class="spacer"></div>
							<button class="next" data-testid="pr-walkthrough-guide-next" type="button" @click=${this.goOrientationNext}>${isLast ? "Start review →" : "Next →"}</button>
						</div>
					</div>
				</div>
			</article>
		`;
	}

	private renderOrientationBeat(card: PrWalkthroughCard, section: PrWalkthroughCardSection): TemplateResult {
		const paragraphs = (section.body ?? "").split(/\n{2,}|\n/).map(part => part.trim()).filter(Boolean);
		return html`
			<div class="beat show" data-testid="pr-walkthrough-beat" data-beat-id=${section.id}>
				${section.verdict ? this.renderOrientationVerdict(section.verdict, section.showStats === true) : section.showStats ? html`<div class="beat-verdict">${this.renderOrientationStats()}</div>` : nothing}
				${section.eyebrow ? html`<span class="sec-label" data-testid="pr-walkthrough-beat-eyebrow">${section.eyebrow}</span>` : nothing}
				<h2 data-testid="pr-walkthrough-beat-heading">${section.heading}</h2>
				${paragraphs.map(text => html`<p>${text}</p>`)}
				${section.concerns?.length ? this.renderOrientationConcerns(section.concerns) : nothing}
				${section.fileRoles?.length ? this.renderOrientationFileRoles(section.fileRoles) : nothing}
				${section.showOriginalDescription ? this.renderOriginalPrDescription(card) : nothing}
			</div>
		`;
	}

	private renderOrientationVerdict(verdict: PrWalkthroughOrientationVerdict, showStats: boolean): TemplateResult {
		const label = verdict.recommendation === "approve" ? "APPROVE"
			: verdict.recommendation === "request_changes" ? "REQUEST CHANGES"
			: verdict.recommendation === "comment" ? "COMMENT"
			: "UNKNOWN";
		return html`
			<div class="beat-verdict">
				<span class="verdict verdict-${verdict.recommendation}" data-testid="pr-walkthrough-beat-verdict">
					<span class="dot" aria-hidden="true"></span>
					<b>${label}</b>
					<span class="conf">· ${verdict.confidence} confidence</span>
				</span>
				${showStats ? this.renderOrientationStats() : nothing}
			</div>
		`;
	}

	private renderOrientationStats(): TemplateResult {
		const stats = this.changesetStats;
		return html`
			<span class="beat-stats" data-testid="pr-walkthrough-beat-stats">
				<span class="stat-files">${stats.files} files</span>
				<span class="stat-sep" aria-hidden="true">·</span>
				<span class="stat-add">+${this.formatNumber(stats.additions)}</span>
				<span class="stat-del">-${this.formatNumber(stats.deletions)}</span>
			</span>
		`;
	}

	private renderOrientationConcerns(concerns: PrWalkthroughOrientationConcern[]): TemplateResult {
		const blocking = concerns.filter(concern => concern.severity === "blocking").length;
		const nonBlocking = concerns.filter(concern => concern.severity === "non_blocking").length;
		const severityClass: Record<PrWalkthroughOrientationConcern["severity"], string> = {
			blocking: "blocking",
			non_blocking: "non-blocking",
			question: "q",
			nit: "nit",
		};
		const severityTag: Record<PrWalkthroughOrientationConcern["severity"], string> = {
			blocking: "Blocking",
			non_blocking: "Non-blocking",
			question: "Question",
			nit: "Nit",
		};
		return html`
			<div class="concern-list" data-testid="pr-walkthrough-beat-concerns">
				<span class="sec-label" data-testid="pr-walkthrough-beat-concern-count">${blocking} blocking, ${nonBlocking} non-blocking</span>
				${concerns.map(concern => html`
					<div class="concern ${severityClass[concern.severity]}" data-testid="pr-walkthrough-beat-concern" data-severity=${concern.severity}>
						<span class="tag">${severityTag[concern.severity]}</span>
						<p>${concern.text}</p>
					</div>
				`)}
			</div>
		`;
	}

	private renderOrientationFileRoles(fileRoles: PrWalkthroughOrientationFileRole[]): TemplateResult {
		const roleLabel: Record<PrWalkthroughOrientationFileRole["role"], string> = {
			core: "Core",
			support: "Support",
			verify: "Verify",
			docs: "Docs",
		};
		return html`
			<div class="filemap" data-testid="pr-walkthrough-beat-filemap">
				${fileRoles.map(entry => html`
					<div class="filerow" data-testid="pr-walkthrough-beat-filerow">
						<span class="role ${entry.role}">${roleLabel[entry.role]}</span>
						<code>${entry.file}</code>
						${entry.note ? html`<span class="note">${entry.note}</span>` : nothing}
					</div>
				`)}
			</div>
		`;
	}

	private renderDiffModeChooser(): TemplateResult {
		return html`
			<div class="modebar" data-testid="pr-walkthrough-diff-mode-chooser">
				<span class="mode-toggle" role="radiogroup" aria-label="Diff display mode">
					<button id="diff-mode-split" data-testid="diff-mode-split" class=${this.effectiveDiffMode === "split" ? "active" : ""} type="button" role="radio" aria-label="Split diff" title="Split diff" aria-checked=${this.effectiveDiffMode === "split"} @click=${() => this.setDiffMode("split")}><svg class="mode-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="3" width="5" height="10" rx="1"></rect><rect x="9" y="3" width="5" height="10" rx="1"></rect></svg></button>
					<button id="diff-mode-inline" data-testid="diff-mode-inline" class=${this.effectiveDiffMode === "inline" ? "active" : ""} type="button" role="radio" aria-label="Inline diff" title="Inline diff" aria-checked=${this.effectiveDiffMode === "inline"} @click=${() => this.setDiffMode("inline")}><svg class="mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 6h4"></path><path d="M13 6h8"></path><path d="M5 12h4"></path><path d="M13 12h8"></path><path d="M5 18h4M7 16v4"></path><path d="M13 18h8"></path></svg></button>
				</span>
			</div>
		`;
	}

	private diffBlockLineStats(block: PrWalkthroughDiffBlock): { additions: number; deletions: number } {
		let additions = 0;
		let deletions = 0;
		for (const hunk of block.hunks) {
			for (const line of hunk.lines) {
				if (line.kind === "add") additions += 1;
				else if (line.kind === "del") deletions += 1;
			}
		}
		return { additions, deletions };
	}

	private renderDiffBlockSafe(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		try {
			return this.renderDiffBlock(card, block);
		} catch (error) {
			console.warn(`PrWalkthroughPanel: failed to render diff block for ${block?.filePath ?? "<unknown file>"}`, error);
			return html`
				<section class="diff-block diff-block-error" data-testid="pr-walkthrough-diff-block-error" data-file-path=${block?.filePath ?? ""}>
					<p class="diff-error-note">Could not render the diff for <b>${block?.filePath ?? "this file"}</b>.</p>
				</section>
			`;
		}
	}

	private renderDiffBlock(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		const collapsed = this._collapsedDiffBlockIds.includes(block.id);
		const comments = this._comments.filter(comment => comment.cardId === card.id && comment.diffBlockId === block.id).length;
		const stats = this.diffBlockLineStats(block);
		return html`
			<section class="diff-block ${collapsed ? "closed" : "open"}" data-testid="pr-walkthrough-diff-block" data-diff-block-id=${block.id} data-file-path=${block.filePath} data-diff-mode=${this.effectiveDiffMode} data-expanded=${collapsed ? "false" : "true"}>
				<div class="diff-file-header-row">
					<button class="diff-file-header" data-testid="pr-walkthrough-diff-toggle" type="button" aria-expanded=${!collapsed} @click=${() => this.toggleDiffBlock(block.id)}>
						<span class="caret">▸</span>
						<span class="diff-path"><b>${block.oldPath && block.oldPath !== block.filePath ? `${block.oldPath} → ${block.filePath}` : block.filePath}</b></span>
						${comments ? html`<span class="diff-comment-count">${comments} comment${comments === 1 ? "" : "s"}</span>` : nothing}
						<span class="diff-counts" data-testid="pr-walkthrough-diff-counts" aria-label=${`${stats.additions} additions, ${stats.deletions} deletions`}><span class="diff-add-count" data-testid="pr-walkthrough-diff-additions">+${stats.additions}</span><span class="diff-del-count" data-testid="pr-walkthrough-diff-deletions">-${stats.deletions}</span></span>
					</button>
					${this.externalFileUrl(block) ? html`<a class="diff-external-link" href=${this.externalFileUrl(block)!} target="_blank" rel="noreferrer" data-testid="pr-walkthrough-external-file-link" title="Open file" aria-label=${`Open ${block.filePath}`}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg></a>` : nothing}
				</div>
				${collapsed ? nothing : this.effectiveDiffMode === "split" ? this.renderSplitDiff(card, block) : this.renderInlineDiff(card, block)}
			</section>
		`;
	}

	private renderSplitDiff(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		return html`
			<div class="diff-overflow" data-testid="pr-walkthrough-diff-scroll">
				<div class="split-grid">
					${block.hunks.map(hunk => this.renderSplitHunk(card, block, hunk))}
				</div>
			</div>
		`;
	}

	private renderSplitHunk(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock, hunk: PrWalkthroughDiffBlock["hunks"][number]): TemplateResult {
		const entries = this.diffRenderEntriesForHunk(card, block, hunk);
		return html`${entries.map((entry, index) => {
			if (entry.kind === "context") return nothing;
			const previous = entries[index - 1];
			const next = entries[index + 1];
			const previousContext = previous?.kind === "context" ? previous : undefined;
			const nextContext = next?.kind === "context" ? next : undefined;
			const aboveControl = previousContext?.canExpandAbove ? this.renderContextButton(card, block, hunk, previousContext, "above") : nothing;
			const belowControl = nextContext?.canExpandBelow ? this.renderContextButton(card, block, hunk, nextContext, "below") : nothing;
			const header = this.sectionSignature(hunk, entry, previousContext);
			return html`
				${this.renderHunkHeader(header, aboveControl)}
				${this.buildSideBySidePairs(entry.lines).map(pair => html`
					<div class="split-row">
						${this.renderDiffLine(card, block, pair.left, "old")}
						${this.renderDiffLine(card, block, pair.right, "new")}
					</div>
					${pair.left?.id === pair.right?.id
						? this.renderLineDetails(card, block, pair.left)
						: html`${this.renderLineDetails(card, block, pair.left)}${this.renderLineDetails(card, block, pair.right)}`}
				`)}
				${belowControl === nothing ? nothing : this.renderHunkHeader("", belowControl)}
			`;
		})}`;
	}

	private renderInlineDiff(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock): TemplateResult {
		return html`
			<div class="diff-overflow" data-testid="pr-walkthrough-diff-scroll">
				<div class="inline-lines">
					${block.hunks.map(hunk => this.renderInlineHunk(card, block, hunk))}
				</div>
			</div>
		`;
	}

	private renderInlineHunk(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock, hunk: PrWalkthroughDiffBlock["hunks"][number]): TemplateResult {
		const entries = this.diffRenderEntriesForHunk(card, block, hunk);
		return html`${entries.map((entry, index) => {
			if (entry.kind === "context") return nothing;
			const previous = entries[index - 1];
			const next = entries[index + 1];
			const previousContext = previous?.kind === "context" ? previous : undefined;
			const nextContext = next?.kind === "context" ? next : undefined;
			const aboveControl = previousContext?.canExpandAbove ? this.renderContextButton(card, block, hunk, previousContext, "above") : nothing;
			const belowControl = nextContext?.canExpandBelow ? this.renderContextButton(card, block, hunk, nextContext, "below") : nothing;
			const header = this.sectionSignature(hunk, entry, previousContext);
			return html`
				${this.renderHunkHeader(header, aboveControl)}
				${entry.lines.map(line => html`${this.renderDiffLine(card, block, line, "inline")}${this.renderLineDetails(card, block, line)}`)}
				${belowControl === nothing ? nothing : this.renderHunkHeader("", belowControl)}
			`;
		})}`;
	}

	private renderHunkHeader(header: string, controls: TemplateResult | typeof nothing = nothing): TemplateResult | typeof nothing {
		const signature = this.hunkSignature(header);
		if (!signature && controls === nothing) return nothing;
		const label = signature || "Expand hidden diff context";
		return html`
			<div class="hunk-header" data-testid="pr-walkthrough-hunk-header" aria-label=${label} title=${signature}>
				<div class="hunk-context-cell">${controls}</div>
				<div class="hunk-signature">${signature}</div>
			</div>
		`;
	}

	private hunkSignature(header: string): string {
		const text = typeof header === "string" ? header : "";
		return text.match(/^@@[^@]*@@\s*(.*)$/)?.[1]?.trim() ?? text;
	}

	private sectionSignature(hunk: PrWalkthroughDiffBlock["hunks"][number], entry: DiffLineEntry, previousContext?: DiffContextEntry): string {
		const scopedSignature = previousContext ? this.scopeSignatureBeforeIndex(hunk, entry.start) : undefined;
		return scopedSignature ?? this.hunkSignature(hunk.header ?? "");
	}

	private scopeSignatureBeforeIndex(hunk: PrWalkthroughDiffBlock["hunks"][number], anchorIndex: number): string | undefined {
		const stack: Array<{ opener: "{" | "[" | "("; lineIndex: number }> = [];
		for (let lineIndex = 0; lineIndex < anchorIndex; lineIndex += 1) {
			const code = this.maskStringsAndLineComments(hunk.lines[lineIndex]?.text ?? "");
			for (const char of code) {
				if (char === "{" || char === "[" || char === "(") stack.push({ opener: char, lineIndex });
				else if (char === "}" || char === "]" || char === ")") this.popScopeFrame(stack, char);
			}
		}
		for (let index = stack.length - 1; index >= 0; index -= 1) {
			const frame = stack[index]!;
			if (frame.opener === "(") continue;
			const signature = this.scopeStartSignature(hunk, frame.lineIndex);
			if (signature) return signature;
		}
		return undefined;
	}

	private popScopeFrame(stack: Array<{ opener: "{" | "[" | "("; lineIndex: number }>, closer: string): void {
		const opener = closer === "}" ? "{" : closer === "]" ? "[" : "(";
		for (let index = stack.length - 1; index >= 0; index -= 1) {
			if (stack[index]?.opener === opener) {
				stack.length = index;
				return;
			}
		}
	}

	private scopeStartSignature(hunk: PrWalkthroughDiffBlock["hunks"][number], lineIndex: number): string | undefined {
		for (let index = lineIndex; index >= Math.max(0, lineIndex - 3); index -= 1) {
			const line = hunk.lines[index]?.text ?? "";
			const signature = this.signatureLikeLine(line);
			if (signature) return signature;
			if (index !== lineIndex && /[;}\]]\s*,?\s*$/.test(line.trim())) break;
		}
		return undefined;
	}

	private maskStringsAndLineComments(line: string): string {
		let masked = "";
		let quote: '"' | "'" | "`" | undefined;
		let escaped = false;
		for (let index = 0; index < line.length; index += 1) {
			const char = line[index]!;
			const next = line[index + 1];
			if (!quote && char === "/" && next === "/") break;
			if (quote) {
				masked += " ";
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === quote) quote = undefined;
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
				masked += " ";
				continue;
			}
			masked += char;
		}
		return masked;
	}

	private signatureLikeLine(line: string): string | undefined {
		const trimmed = line.trim();
		if (!trimmed || trimmed.length > 180) return undefined;
		if (/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\b/.test(trimmed)) return trimmed;
		if (/^(?:export\s+)?(?:const|let|var)\s+[\w$]+(?:\s*:[^=]+)?\s*=/.test(trimmed)) return trimmed;
		if (/^[\w$.]+\s*\([^)]*\)\s*=>\s*\{?$/.test(trimmed)) return trimmed;
		if (/^[\w$.]+\s*\([^)]*\)\s*[,;]?\s*$/.test(trimmed)) return trimmed;
		return undefined;
	}

	private diffRenderEntriesForHunk(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock, hunk: PrWalkthroughDiffBlock["hunks"][number]): DiffRenderEntry[] {
		const importantIndexes = hunk.lines
			.map((line, index) => this.isImportantDiffLine(card, block, line) ? index : -1)
			.filter(index => index >= 0);
		if (importantIndexes.length === 0) return [{ kind: "lines", start: 0, end: hunk.lines.length - 1, lines: hunk.lines }];

		const baseVisible = new Set<number>();
		for (const index of importantIndexes) {
			const start = Math.max(0, index - DEFAULT_DIFF_CONTEXT_LINES);
			const end = Math.min(hunk.lines.length - 1, index + DEFAULT_DIFF_CONTEXT_LINES);
			for (let lineIndex = start; lineIndex <= end; lineIndex += 1) baseVisible.add(lineIndex);
		}

		const visible = new Set(baseVisible);
		const baseGaps = this.hiddenContextRanges(baseVisible, hunk.lines.length);
		for (const gap of baseGaps) {
			const key = this.contextGapKey(card.id, block.id, hunk.id, gap.start, gap.end);
			const expansion = this._contextExpansions[key] ?? {};
			const hiddenCount = gap.end - gap.start + 1;
			const belowCount = Math.min(expansion.below ?? 0, hiddenCount);
			const aboveCount = Math.min(expansion.above ?? 0, Math.max(0, hiddenCount - belowCount));
			for (let index = gap.start; index < gap.start + belowCount; index += 1) visible.add(index);
			for (let index = gap.end - aboveCount + 1; index <= gap.end; index += 1) visible.add(index);
		}

		const entries: DiffRenderEntry[] = [];
		let index = 0;
		while (index < hunk.lines.length) {
			if (visible.has(index)) {
				const start = index;
				const lines: PrWalkthroughDiffLine[] = [];
				while (index < hunk.lines.length && visible.has(index)) {
					lines.push(hunk.lines[index]!);
					index += 1;
				}
				entries.push({ kind: "lines", start, end: index - 1, lines });
				continue;
			}
			const start = index;
			while (index < hunk.lines.length && !visible.has(index)) index += 1;
			const end = index - 1;
			const baseGap = baseGaps.find(gap => start >= gap.start && end <= gap.end) ?? { start, end };
			const canExpandAbove = baseGap.end < hunk.lines.length - 1;
			const canExpandBelow = baseGap.start > 0;
			if (!canExpandAbove && !canExpandBelow) continue;
			entries.push({
				kind: "context",
				start,
				end,
				gapStart: baseGap.start,
				gapEnd: baseGap.end,
				hiddenCount: end - start + 1,
				canExpandAbove,
				canExpandBelow,
			});
		}
		return entries;
	}

	private hiddenContextRanges(visible: Set<number>, totalLines: number): Array<{ start: number; end: number }> {
		const ranges: Array<{ start: number; end: number }> = [];
		let index = 0;
		while (index < totalLines) {
			if (visible.has(index)) {
				index += 1;
				continue;
			}
			const start = index;
			while (index < totalLines && !visible.has(index)) index += 1;
			ranges.push({ start, end: index - 1 });
		}
		return ranges;
	}

	private isImportantDiffLine(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock, line: PrWalkthroughDiffLine): boolean {
		if (line.kind !== "context") return true;
		const key = this.lineKey(card.id, block.id, line.id);
		return this._editingLineKey === key || this.commentsForLine(card.id, block.id, line.id).length > 0 || this.pendingSuggestionsForLine(card, block.id, line.id).length > 0;
	}

	private renderContextButton(card: PrWalkthroughCard, block: PrWalkthroughDiffBlock, hunk: PrWalkthroughDiffBlock["hunks"][number], entry: DiffContextEntry, direction: DiffContextDirection): TemplateResult {
		const count = Math.min(DIFF_CONTEXT_EXPAND_LINES, entry.hiddenCount);
		const label = `Show ${count} more line${count === 1 ? "" : "s"} ${direction}`;
		return html`
			<button class="context-toggle" data-testid="pr-walkthrough-context-toggle" data-context-direction=${direction} type="button" title=${label} aria-label=${`${label} in ${block.filePath}`} @click=${() => this.expandHunkContext(card.id, block.id, hunk.id, entry, direction)}>
				${direction === "above" ? html`
					<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3v9"></path><path d="M4.5 6.5 8 3l3.5 3.5"></path><path d="M4.5 13h7"></path></svg>
				` : html`
					<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 4v9"></path><path d="M4.5 9.5 8 13l3.5-3.5"></path><path d="M4.5 3h7"></path></svg>
				`}
			</button>
		`;
	}

	private expandHunkContext(cardId: string, blockId: string, hunkId: string, entry: DiffContextEntry, direction: DiffContextDirection): void {
		const key = this.contextGapKey(cardId, blockId, hunkId, entry.gapStart, entry.gapEnd);
		const current = this._contextExpansions[key] ?? {};
		this._contextExpansions = {
			...this._contextExpansions,
			[key]: { ...current, [direction]: (current[direction] ?? 0) + DIFF_CONTEXT_EXPAND_LINES },
		};
	}

	private contextGapKey(cardId: string, blockId: string, hunkId: string, start: number, end: number): string {
		return `${cardId}::${blockId}::${hunkId}::${start}-${end}`;
	}

	private externalFileUrl(block: PrWalkthroughDiffBlock): string | undefined {
		const linked = block as PrWalkthroughDiffBlock & { externalUrl?: string; blobUrl?: string; rawUrl?: string; contentsUrl?: string };
		return safeExternalUrl(linked.externalUrl) || safeExternalUrl(linked.blobUrl) || safeExternalUrl(linked.rawUrl) || safeExternalUrl(linked.contentsUrl);
	}

	private renderHighlightedLine(text: string): TemplateResult[] {
		const tokenPattern = /(\/\/.*$|`(?:\\.|[^`])*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|export|import|from|async|await|new|private|public|protected|readonly|extends|implements|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\()|\b[A-Za-z_$][\w$]*(?=\??\s*:))/g;
		const parts: TemplateResult[] = [];
		let lastIndex = 0;
		for (const match of text.matchAll(tokenPattern)) {
			const index = match.index ?? 0;
			if (index > lastIndex) parts.push(html`${text.slice(lastIndex, index)}`);
			const token = match[0];
			const className = token.startsWith("//")
				? "tok-comment"
				: token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")
					? "tok-string"
					: /^\d/.test(token)
						? "tok-number"
						: /^(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|export|import|from|async|await|new|private|public|protected|readonly|extends|implements|true|false|null|undefined)$/.test(token)
							? "tok-keyword"
							: text.slice(index + token.length).match(/^\s*\(/)
								? "tok-function"
								: "tok-property";
			parts.push(html`<span class=${className}>${token}</span>`);
			lastIndex = index + token.length;
		}
		if (lastIndex < text.length) parts.push(html`${text.slice(lastIndex)}`);
		return parts;
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
				<span class="line-text">${this.renderHighlightedLine(line.text)}</span>
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

	private renderAuditDraftSection(): TemplateResult {
		const draftText = this.buildAuditText();
		return html`
			<section class="audit" data-testid="pr-walkthrough-audit">
				<h3>Draft review</h3>
				<pre data-testid="pr-walkthrough-draft">${draftText}</pre>
				<div class="comment-actions">
					<button class="copy-button" type="button" @click=${() => this.copyAudit(draftText)}>${this._copied ? "Copied" : "Copy draft"}</button>
				</div>
			</section>
		`;
	}

	private openExportPreview = (): void => {
		this._exportPreviewOpen = true;
		this._exportResult = undefined;
		this._exportError = "";
		if (this.canUseExportApi) {
			void this.loadExportPreview();
			return;
		}
		this._exportPreview = this.buildLocalExportPreview();
	};

	private closeExportPreview = (): void => {
		this._exportPreviewOpen = false;
		this._exportPreviewLoading = false;
		this._exportSubmitting = false;
	};

	private async loadExportPreview(): Promise<void> {
		this._exportPreviewLoading = true;
		this._exportError = "";
		try {
			const res = await gatewayFetch(`/api/pr-walkthrough/${encodeURIComponent(this.apiChangesetId)}/export/preview`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(this.currentDraft),
			});
			const data = await this.readJsonResponse(res);
			if (!res.ok) throw new Error(this.errorMessageFromResponse(data, `Preview failed (${res.status})`));
			this._exportPreview = this.normalizeExportPreview(data);
		} catch (err) {
			this._exportError = err instanceof Error ? err.message : "Failed to build export preview.";
			this._exportPreview = this.buildLocalExportPreview();
		} finally {
			this._exportPreviewLoading = false;
		}
	}

	private renderExportDialog(): TemplateResult {
		const preview = this._exportPreview;
		const rows = this.previewRows(preview);
		const validRows = rows.filter(row => row.valid !== false);
		const invalidRows = rows.length - validRows.length;
		const canSubmit = this.canUseExportApi && !this._exportPreviewLoading && !this._exportSubmitting && !!preview && (preview.canSubmit !== false);
		const body = preview?.body || preview?.reviewBody || this.buildAuditText();
		const reviewUrl = safeExternalUrl(this._exportResult?.url);
		return html`
			<div class="export-backdrop" data-testid="pr-walkthrough-export-preview" role="dialog" aria-modal="true" aria-label="Review export preview">
				<section class="export-dialog">
					<header class="export-head">
						<h2>Review export preview</h2>
						<span class="header-spacer"></span>
						<button class="copy-button" type="button" @click=${() => this.copyAudit(body)}>${this._copied ? "Copied" : "Copy draft"}</button>
					</header>
					<div class="export-body">
						${!this.canUseExportApi ? html`<div class="banner info" data-testid="pr-walkthrough-export-unavailable"><strong>Export unavailable</strong><div>${this.exportUnavailableReason}</div></div>` : nothing}
						${this._exportError ? html`<div class="banner error" data-testid="pr-walkthrough-export-error"><strong>Export preview failed</strong><div>${this._exportError}</div></div>` : nothing}
						${this._exportResult ? html`<div class="banner ${this._exportResult.ok === false ? "error" : "info"}" data-testid="pr-walkthrough-export-result"><strong>${this._exportResult.ok === false ? "Submission failed" : "Submitted"}</strong><div>${this._exportResult.message || this._exportResult.error || "GitHub review submitted."}</div>${reviewUrl ? html`<div><a href=${reviewUrl} target="_blank" rel="noopener noreferrer">Open review ↗</a></div>` : nothing}</div>` : nothing}
						${this._exportPreviewLoading ? this.renderLoadingState() : html`
							<div class="export-summary" data-testid="pr-walkthrough-export-summary">
								<span>${validRows.length} mapped comment${validRows.length === 1 ? "" : "s"}</span>
								<span>${invalidRows} unmappable</span>
								<span>${this.currentDraftHasConcerns ? "Request changes" : "Approve"}</span>
							</div>
							${this.renderWarningBanners(preview?.warnings ?? [])}
							<section>
								<h3>Review body</h3>
								<pre data-testid="pr-walkthrough-export-body">${body}</pre>
							</section>
							<section>
								<h3>Line comments</h3>
								${rows.length ? rows.map(row => this.renderExportRow(row)) : html`<div class="empty">No line comments are queued.</div>`}
							</section>
						`}
					</div>
					<footer class="export-actions">
						<button type="button" @click=${this.closeExportPreview}>Close</button>
						<button class="primary" type="button" data-testid="pr-walkthrough-export-submit" ?disabled=${!canSubmit} title=${canSubmit ? "Submit this review to GitHub." : "Preview must be ready and GitHub export must be available."} @click=${this.submitExportReview}>${this._exportSubmitting ? "Submitting…" : "Confirm submit to GitHub"}</button>
					</footer>
				</section>
			</div>
		`;
	}

	private renderExportRow(row: WalkthroughExportPreviewRow): TemplateResult {
		const path = row.path || row.filePath || "Unmapped comment";
		const anchor = row.line != null ? `${path}:${row.line}` : path;
		return html`
			<div class="export-row ${row.valid === false ? "invalid" : ""}" data-testid="pr-walkthrough-export-row" data-valid=${row.valid === false ? "false" : "true"}>
				<div class="anchor">${row.kind || "line"} · ${anchor}${row.side ? ` · ${row.side}` : ""}</div>
				<div>${row.body || "No comment body."}</div>
				${row.valid === false && row.reason ? html`<div class="reason">${row.reason}</div>` : nothing}
			</div>
		`;
	}

	private async submitExportReview(): Promise<void> {
		if (!this.canUseExportApi || !this._exportPreview || this._exportSubmitting) return;
		this._exportSubmitting = true;
		this._exportError = "";
		this._exportResult = undefined;
		try {
			const res = await gatewayFetch(`/api/pr-walkthrough/${encodeURIComponent(this.apiChangesetId)}/export/submit`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ draft: this.currentDraft, confirm: true, event: this.currentDraftHasConcerns ? "REQUEST_CHANGES" : "APPROVE" }),
			});
			const data = await this.readJsonResponse(res);
			if (!res.ok) throw new Error(this.errorMessageFromResponse(data, `Submit failed (${res.status})`));
			this._exportResult = this.normalizeExportResult(data);
		} catch (err) {
			this._exportResult = { ok: false, error: err instanceof Error ? err.message : "Failed to submit GitHub review." };
		} finally {
			this._exportSubmitting = false;
		}
	}

	private async readJsonResponse(res: Response): Promise<unknown> {
		try {
			return await res.json();
		} catch {
			return null;
		}
	}

	private errorMessageFromResponse(data: unknown, fallback: string): string {
		if (data && typeof data === "object") {
			const record = data as Record<string, unknown>;
			const message = record.message || record.error || record.reason;
			if (typeof message === "string" && message.trim()) return message.trim();
		}
		return fallback;
	}

	private normalizeExportPreview(data: unknown): WalkthroughExportPreview {
		if (!data || typeof data !== "object") return this.buildLocalExportPreview();
		const record = data as Record<string, unknown>;
		return {
			body: typeof record.body === "string" ? record.body : undefined,
			reviewBody: typeof record.reviewBody === "string" ? record.reviewBody : undefined,
			rows: Array.isArray(record.rows) ? record.rows.map(row => this.normalizeExportRow(row)) : undefined,
			comments: Array.isArray(record.comments) ? record.comments.map(row => this.normalizeExportRow(row)) : undefined,
			warnings: Array.isArray(record.warnings) ? record.warnings.map(warning => this.normalizeWarning(warning)).filter((warning): warning is WalkthroughWarning => !!warning) : undefined,
			validCount: typeof record.validCount === "number" ? record.validCount : undefined,
			invalidCount: typeof record.invalidCount === "number" ? record.invalidCount : undefined,
			canSubmit: typeof record.canSubmit === "boolean" ? record.canSubmit : undefined,
		};
	}

	private normalizeExportResult(data: unknown): WalkthroughExportResult {
		if (!data || typeof data !== "object") return { ok: true, message: "GitHub review submitted." };
		const record = data as Record<string, unknown>;
		return {
			ok: typeof record.ok === "boolean" ? record.ok : true,
			url: typeof record.url === "string" ? record.url : typeof record.reviewUrl === "string" ? record.reviewUrl : undefined,
			message: typeof record.message === "string" ? record.message : "GitHub review submitted.",
			error: typeof record.error === "string" ? record.error : undefined,
		};
	}

	private normalizeWarning(data: unknown): WalkthroughWarning | undefined {
		if (!data || typeof data !== "object") return undefined;
		const record = data as Record<string, unknown>;
		const message = typeof record.message === "string" ? record.message : "Walkthrough warning";
		const severity = record.severity === "error" || record.severity === "info" || record.severity === "warning" ? record.severity : "warning";
		return {
			code: typeof record.code === "string" ? record.code : "warning",
			severity,
			message,
			filePath: typeof record.filePath === "string" ? record.filePath : undefined,
		};
	}

	private normalizeExportRow(data: unknown): WalkthroughExportPreviewRow {
		if (!data || typeof data !== "object") return { valid: false, reason: "Invalid preview row" };
		const record = data as Record<string, unknown>;
		return {
			path: typeof record.path === "string" ? record.path : undefined,
			filePath: typeof record.filePath === "string" ? record.filePath : undefined,
			side: typeof record.side === "string" ? record.side : undefined,
			line: typeof record.line === "number" ? record.line : undefined,
			body: typeof record.body === "string" ? record.body : undefined,
			valid: typeof record.valid === "boolean" ? record.valid : undefined,
			reason: typeof record.reason === "string" ? record.reason : undefined,
			kind: typeof record.kind === "string" ? record.kind : undefined,
		};
	}

	private previewRows(preview: WalkthroughExportPreview | undefined): WalkthroughExportPreviewRow[] {
		return preview?.rows ?? preview?.comments ?? [];
	}

	private buildLocalExportPreview(): WalkthroughExportPreview {
		const draft = this.currentDraft;
		const rows: WalkthroughExportPreviewRow[] = draft.comments
			.filter(comment => comment.diffBlockId && comment.lineId)
			.map(comment => {
				const anchor = this.findLineAnchor(comment);
				const valid = anchor.filePath !== "Card-level" && typeof anchor.line === "number";
				return {
					path: anchor.filePath,
					line: typeof anchor.line === "number" ? anchor.line : undefined,
					body: comment.body,
					valid,
					reason: valid ? undefined : "This comment does not map to a changed GitHub line.",
				};
			});
		return {
			body: this.buildAuditText(),
			rows,
			warnings: this.canUseExportApi ? [] : [{ code: "export-unavailable", severity: "info", message: this.exportUnavailableReason }],
			canSubmit: false,
		};
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

	private cardsChecksum(): string {
		return this.cards.map(card => `${card.id}:${card.phaseId}:${card.diffBlocks.map(block => `${block.id}:${block.filePath}:${block.hunks.length}`).join("|")}`).join(";");
	}

	private hasCard(cardId: string | undefined): boolean {
		return !!cardId && this.cards.some(card => card.id === cardId);
	}

	private hasLineAnchor(cardId: string, diffBlockId: string, lineId: string): boolean {
		const card = this.cards.find(candidate => candidate.id === cardId);
		return !!card?.diffBlocks.some(block => block.id === diffBlockId && block.hunks.some(hunk => hunk.lines.some(line => line.id === lineId)));
	}

	private canRestorePersistedState(parsed: PersistedPrWalkthroughState): boolean {
		if (this.status === "fixture" || parsed.cardsChecksum === this.cardsChecksum()) return true;
		const decisionIds = parsed.decisions && typeof parsed.decisions === "object" ? Object.keys(parsed.decisions) : [];
		const completedIds = Array.isArray(parsed.completedCardIds) ? parsed.completedCardIds : [];
		const commentCardIds = Array.isArray(parsed.comments) ? parsed.comments.map(comment => comment?.cardId) : [];
		return [parsed.activeCardId, ...decisionIds, ...completedIds, ...commentCardIds].some(id => this.hasCard(id));
	}

	private restoreComments(parsed: PersistedPrWalkthroughState, checksumMatches: boolean): PrWalkthroughComment[] {
		if (!Array.isArray(parsed.comments)) return [];
		return parsed.comments.filter(comment => {
			if (!comment || typeof comment.id !== "string" || typeof comment.cardId !== "string" || typeof comment.body !== "string") return false;
			if (!this.hasCard(comment.cardId)) return false;
			if (checksumMatches || !comment.diffBlockId || !comment.lineId) return true;
			return this.hasLineAnchor(comment.cardId, comment.diffBlockId, comment.lineId);
		});
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
			if (!this.canRestorePersistedState(parsed)) return;
			const checksumMatches = this.status === "fixture" || parsed.cardsChecksum === this.cardsChecksum();
			if (this.hasCard(parsed.activeCardId)) this._activeCardId = parsed.activeCardId!;
			if (parsed.diffModeOverride === "split" || parsed.diffModeOverride === "inline") this._diffModeOverride = parsed.diffModeOverride;
			this._comments = this.restoreComments(parsed, checksumMatches);
			if (parsed.decisions && typeof parsed.decisions === "object") {
				this._decisions = Object.fromEntries(Object.entries(parsed.decisions).filter(([cardId, decision]) => this.hasCard(cardId) && (decision?.value === "liked" || decision?.value === "disliked")));
			}
			if (Array.isArray(parsed.completedCardIds)) this._completedCardIds = parsed.completedCardIds.filter(id => this.hasCard(id));
			if (Array.isArray(parsed.dismissedSuggestionIds)) this._dismissedSuggestionIds = parsed.dismissedSuggestionIds.filter(id => typeof id === "string");
			if (Array.isArray(parsed.collapsedDiffBlockIds)) this._collapsedDiffBlockIds = parsed.collapsedDiffBlockIds.filter(id => typeof id === "string" && this.cards.some(card => card.diffBlocks.some(block => block.id === id)));
			this.reconcileDecisionCommentInvariants();
		} catch (err) {
			console.warn("[pr-walkthrough] failed to restore persisted state", err);
		}
	}

	private persistState(): void {
		const key = this.persistenceStorageKey();
		if (!key || this._loadedPersistenceKey !== this.persistenceKey || typeof localStorage === "undefined") return;
		const persisted: PersistedPrWalkthroughState = {
			schemaVersion: 2,
			cardsChecksum: this.cardsChecksum(),
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
