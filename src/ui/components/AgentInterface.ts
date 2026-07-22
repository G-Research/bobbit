import { icon } from "@mariozechner/mini-lit";
import { isAskResponseEnvelope } from "../../shared/ask-envelope.js";
import { getSupportedThinkingLevels, clampThinkingLevel, type ThinkingLevel } from "../../shared/thinking-levels.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { html, LitElement, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { AlertTriangle, ArrowDown, ArrowUp, Brain, Check, ChevronsDown, Copy, Image as ImageIcon, Sparkles } from "lucide";
import type { ModelSelector } from "../dialogs/ModelSelector.js";
import type { ImageModelSelector } from "../dialogs/ImageModelSelector.js";

// `ModelSelector` statically imports `modelsAreEqual` from `@earendil-works/pi-ai`,
// which has a top-level side effect that materialises the 553 kB generated
// model catalog. Static-importing it from this eagerly-loaded component would
// drag the catalog into the entry chunk — see `src/app/pi-ai-lazy.ts` and
// `docs/design/shrink-initial-bundle.md` (Task A). Lazy-load both dialogs at
// click time instead. Type-only imports above are erased by `tsc`.
async function openModelSelector(...args: Parameters<typeof ModelSelector.open>): Promise<void> {
	const mod = await import("../dialogs/ModelSelector.js");
	mod.ModelSelector.open(...args);
}
async function openImageModelSelector(...args: Parameters<typeof ImageModelSelector.open>): Promise<void> {
	const mod = await import("../dialogs/ImageModelSelector.js");
	mod.ImageModelSelector.open(...args);
}
import type { MessageEditor } from "./MessageEditor.js";
import "./MessageEditor.js";
import "./MessageList.js";
// <git-status-widget> is loaded on demand via `app/lazy-widgets.ts` to
// keep its 52 kB chunk out of the entry bundle. AgentInterface's
// connectedCallback fires the import; goal-dashboard mirrors the same
// trigger. Lit upgrades the unknown `<git-status-widget>` tag once
// the chunk lands; property bindings are preserved across upgrade.
// All four of these elements are conditional-render (bg pill strip,
// cost popover, continue-session chooser, git-status). Static imports
// would force their chunks into the entry bundle even when the user
// never sees them on a given session view. Lazy via `app/lazy-widgets`
// instead — connectedCallback below fires the imports as fire-and-
// forget, Lit upgrades the unknown tags when each chunk lands.
import { ensureGitStatusWidget, ensureGoalStatusWidget, ensureBgProcessPill, ensureCostPopover, ensureContinueSessionChooser } from "../../app/lazy-widgets.js";
import type { BgProcessInfo } from "./BgProcessPill.js";
import "./Messages.js"; // Import for side effects to register the custom elements
import { getAppStorage } from "../storage/app-storage.js";
import "./StreamingMessageContainer.js";
import "./BellToggle.js";
import { state as appState, renderApp, type GatewaySession } from "../../app/state.js";
import { copyTextToClipboard, gatewayFetch } from "../../app/api.js";
import { selectProposalWorkspaceTab } from "../../app/preview-panel.js";
import { setHashRoute } from "../../app/routing.js";
import { canContinueArchivedSession, continueArchivedSession } from "../../app/session-actions.js";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Attachment } from "../utils/attachment-utils.js";
import { formatCost, formatTokenCount, formatModelCost } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { createStreamFn } from "../utils/proxy-utils.js";
import type { UserMessageWithAttachments } from "./Messages.js";
import type { StreamingMessageContainer } from "./StreamingMessageContainer.js";
import type { GitRepoKnown } from "../../app/git-status-refresh.js";

@customElement("agent-interface")
export class AgentInterface extends LitElement {
	// Optional external session: when provided, this component becomes a view over the session
	@property({ attribute: false }) session?: Agent;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	// Working directory shown in the stats bar
	@property() cwd?: string;
	// Project ID for palette resolution
	@property() projectId?: string;
	// Session metadata from REST PersistedSession (not on remote-agent _state)
	@property() goalId?: string;
	@property() delegateOf?: string;
	@property() teamGoalId?: string;
	@property() assistantType?: string;
	// Git branch name shown in the stats bar
	@property() branch?: string;
	// Git status data for the widget
	@property({ attribute: false }) gitStatus?: {
		branch: string;
		primaryBranch: string;
		primaryRef?: string;
		isOnPrimary: boolean;
		summary: string;
		clean: boolean;
		hasUpstream: boolean;
		ahead: number;
		behind: number;
		aheadOfPrimary: number;
		behindPrimary: number;
		mergedIntoPrimary: boolean;
		insertionsVsPrimary?: number;
		deletionsVsPrimary?: number;
		unpushed: boolean;
		status: Array<{ file: string; status: string }>;
	};
	@property({ type: Boolean }) gitStatusLoading = false;
	/** Repo detection hint. 'no' and 'hidden' suppress the git pill until a quiet recheck reveals showable content. */
	@property({ attribute: false }) gitRepoKnown: GitRepoKnown = 'unknown';
	/** True when the server returned Phase A data but porcelain timed out. */
	@property({ type: Boolean }) partial = false;
	// PR status properties for goal-linked sessions
	@property() prState?: string;
	@property() prUrl?: string;
	@property({ type: Number }) prNumber?: number;
	@property() prTitle?: string;
	@property() prMergeable?: string;
	@property({ type: Boolean }) viewerIsAdmin?: boolean;
	@property({ type: Boolean }) viewerCanMergeAsAdmin?: boolean;
	@property() reviewDecision?: string;
	@property() headRefName?: string;
	// Background processes for this session
	@property({ attribute: false }) bgProcesses: BgProcessInfo[] = [];
	@property({ attribute: false }) onBgProcessKill?: (id: string) => void;
	@property({ attribute: false }) onBgProcessDismiss?: (id: string) => void;
	@property({ attribute: false }) onPrMerge?: (method: string, admin?: boolean, branch?: string) => Promise<string | undefined>;
	@property({ attribute: false }) onGitPull?: () => Promise<string | undefined>;
	@property({ attribute: false }) onGitPush?: () => Promise<string | undefined>;
	@property({ attribute: false }) onGitFetch?: () => void;
	@property({ attribute: false }) onGitMergePrimary?: () => Promise<string | undefined>;
	@property({ attribute: false }) onGitSquashPush?: () => Promise<string | undefined>;
	@property({ attribute: false }) onAskAgentCommit?: () => void;
	@property({ attribute: false }) onAskAgentPr?: () => void;
	// Optional custom API key prompt handler - if not provided, uses default dialog
	@property({ attribute: false }) onApiKeyRequired?: (provider: string) => Promise<boolean>;
	// Optional callback called before sending a message
	@property({ attribute: false }) onBeforeSend?: () => void | Promise<void>;
	// Optional callback called before executing a tool call - return false to prevent execution
	@property({ attribute: false }) onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
	// Optional callback called when cost display is clicked
	@property({ attribute: false }) onCostClick?: () => void;
	private get _showGitStatusWidget(): boolean { return this.gitRepoKnown !== 'no' && this.gitRepoKnown !== 'hidden'; }
	// When true, hide the message editor (for archived/read-only sessions)
	@property({ type: Boolean }) readOnly = false;
	// When true, show the editor only while agent is streaming (steer-only mode)
	@property({ type: Boolean }) nonInteractive = false;

	/**
	 * Scope gate for the archived-continue button. The button is hidden for
	 * goal-linked, delegate, team, or assistant sessions — and for sessions
	 * whose source project is no longer registered. The server enforces the
	 * same rules; this is defence-in-depth UX.
	 */
	private get canContinueArchived(): boolean {
		const record = this._archivedSessionRecord();
		return !!record && canContinueArchivedSession(record);
	}

	private _archivedSessionRecord(): GatewaySession | null {
		const sid = this.session?.sessionId;
		if (!sid) return null;
		const fromState = appState.archivedSessions.find((s) => s.id === sid)
			|| appState.gatewaySessions.find((s) => s.id === sid);
		if (fromState) return { ...fromState, readOnly: fromState.readOnly || this.readOnly };
		return {
			id: sid,
			title: (this.session as any)?.title || "Archived session",
			cwd: this.cwd || "",
			projectId: this.projectId,
			status: "archived",
			createdAt: 0,
			lastActivity: 0,
			clientCount: 0,
			goalId: this.goalId,
			delegateOf: this.delegateOf,
			teamGoalId: this.teamGoalId,
			readOnly: this.readOnly,
			nonInteractive: this.nonInteractive,
		};
	}

	/**
	 * Proposal types currently present on disk for this archived session
	 * (e.g. `["goal"]`, `["role"]`). Populated lazily once `canContinueArchived`
	 * becomes truthy via a one-shot `GET /api/sessions/:id/proposals`. Drives
	 * the context-aware archived footer: when non-empty the footer surfaces a
	 * "Resubmit <type> proposal" button alongside the standard
	 * "Continue in new session" button.
	 */
	@state() private _archivedProposalTypes: string[] = [];
	/** Tracks the session id we last fetched proposals for, to prevent re-entry. */
	private _archivedProposalsFetchedFor: string | null = null;

	private async _refreshArchivedProposalTypes(sessionId: string): Promise<void> {
		if (this._archivedProposalsFetchedFor === sessionId) return;
		this._archivedProposalsFetchedFor = sessionId;
		try {
			const resp = await gatewayFetch(`/api/sessions/${sessionId}/proposals`);
			if (!resp.ok) {
				this._archivedProposalTypes = [];
				return;
			}
			const data = await resp.json().catch(() => null);
			const proposals = Array.isArray(data?.proposals) ? data.proposals : Array.isArray(data) ? data : [];
			const types: string[] = [];
			for (const p of proposals) {
				let t: string | undefined;
				if (typeof p === "string") t = p;
				else if (p && typeof p === "object") {
					if (typeof p.proposalType === "string") t = p.proposalType;
					else if (typeof p.type === "string") t = p.type;
				}
				if (t && !types.includes(t)) types.push(t);
			}
			this._archivedProposalTypes = types;
		} catch {
			this._archivedProposalTypes = [];
		}
	}

	private _maybeRefreshArchivedProposals(): void {
		if (!this.canContinueArchived || this.nonInteractive) return;
		const sid = this.session?.sessionId;
		if (!sid) return;
		if (this._archivedProposalsFetchedFor === sid) return;
		// Fire-and-forget — render() does not await.
		void this._refreshArchivedProposalTypes(sid);
	}

	/**
	 * Path A — surface the existing proposal panel in the preview pane without
	 * spawning a new session. Drafts have already been rehydrated into
	 * `state.activeProposals[type]` by `connectToSession`; we just need to flip
	 * the visible tab.
	 */
	private _openProposalPanel(type: string): void {
		const s = appState as any;
		const sessionId = this.session?.sessionId || s.selectedSessionId || "";
		s.previewPanelActiveTab = type;
		s.previewPanelTab = type;
		if (this.assistantType) {
			s.assistantTab = "preview";
		}
		try {
			selectProposalWorkspaceTab(type, { sessionId, select: true, setAssistantTab: true });
		} catch { /* legacy fields above still select the proposal */ }
		renderApp();
		this.requestUpdate();
	}

	private async _openContinueChooser() {
		const record = this._archivedSessionRecord();
		if (!record) return;
		await continueArchivedSession(record, {
			messageCount: this.session?.state?.messages?.length ?? 0,
			proposalTypes: [...this._archivedProposalTypes],
		});
	}

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _contextPopoverOpen = false;
	private _costPopoverOpen = false;
	private _permissionGrantClickLocked = false;

	// --- Scroll-lock state — vanilla-TS port of `use-stick-to-bottom`
	// (https://github.com/stackblitz-labs/use-stick-to-bottom, 731⭐, powers
	// bolt.new). See `docs/design/tail-chat-redesign.md` § "Outcome of the
	// use-stick-to-bottom port" for the algorithm rationale.
	//
	// Two-flag intent model:
	//   _isAtBottom       — sticky intent. Toggleable. Default true.
	//   _escapedFromLock  — true ONLY after a user-initiated upward gesture
	//                       (wheel/touch/keydown). Cleared by jump-to-bottom
	//                       click, sendMessage, session navigate, near-bottom
	//                       auto-relock, or `setAutoScroll(true)`.
	//
	// Re-pin invariant: programmatic re-pin (RO growth, image-load, drift
	// recovery) runs only when `_isAtBottom && !_escapedFromLock`. User-
	// gesture handlers flip both flags synchronously BEFORE the resulting
	// scroll event is dispatched, so geometry never has to second-guess
	// intent.
	private _isAtBottom = true;
	private _escapedFromLock = false;
	/** Set by the ResizeObserver callback on every height delta; reset via
	 * `requestAnimationFrame(() => setTimeout(..., 1))` so a `scroll` event
	 * fired during the resize is recognised and skipped (resize-vs-scroll
	 * disambiguation — Bug B in the issue analysis). */
	private _resizeDifference = 0;
	/** scrollTop at the most recent scroll event, used by the deferred
	 * scroll-handler classifier and to suppress re-pin while the user is
	 * scrolling down toward the bottom. */
	private _lastScrollTop = 0;
	/** Single-value latch set immediately before any programmatic scrollTop
	 * write. The deferred scroll handler matches the resulting browser
	 * `scroll` event by exact value and clears the latch — replaces the
	 * 4-entry `_programmaticEchoes` ring buffer (the ring was an over-
	 * correction for a problem the deferred handler solves more cleanly,
	 * since within one task only one programmatic write commits). */
	private _ignoreScrollToTop: number | null = null;
	/** `performance.now()` of the most recent user gesture (wheel / touch /
	 * keydown of nav keys). Used by the deferred scroll handler to
	 * distinguish a real user-driven scroll-up (escape lock) from a
	 * programmatic scroll-up issued elsewhere on the page (e.g. another
	 * component, or test-harness `el.scrollTop = X`). Without this gate,
	 * any non-echo scroll event would be treated as user intent and
	 * permanently escape the lock — breaking the reproducing test's
	 * `_stickToBottom = true` + programmatic scroll-up sanity check. */
	private _lastUserGestureTs = 0;
	private static readonly USER_GESTURE_WINDOW_MS = 500;
	/** Live spring animation state. `null` when no animation is in flight.
	 * Defaults: damping 0.7, stiffness 0.05, mass 1.25 (use-stick-to-bottom
	 * defaults). */
	private _animation: { current: number; target: number; velocity: number; rafId: number; resolve: () => void } | null = null;
	/** Pending setTimeout for the deferred scroll handler. Queued at most
	 * once per scroll event; cleared when the handler runs. */
	private _scrollDeferTimer: ReturnType<typeof setTimeout> | null = null;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _lastScrollHeight = 0;
	/** Capture-phase `load` listener installed once per session navigate on
	 * the scroll container. Catches `<img>`/`<iframe>` decode reflows that
	 * fire BEFORE the ResizeObserver sees the resulting size change (real
	 * paint-vs-RO race window — image decode + paint can land between
	 * frames). NOT redundant with RO `delta>0` re-pin: load fires earlier on
	 * the same task and pins synchronously, so the user never sees the
	 * intermediate frame where the inserted image grew the layout but RO
	 * hasn't ticked yet. */
	private _imageLoadHandler?: (e: Event) => void;

	/** Jump-to-bottom button visibility (single OR split-bottom variant).
	 * Recomputed in `_refreshJumpToLastPromptButton` as a function of DOM
	 * geometry: true iff at least one `<user-message>` is below the
	 * viewport OR the scroll position is more than half a viewport away
	 * from the bottom (`dist > clientHeight * 0.5`). The half-viewport
	 * threshold (vs a strict `dist > 1`) preserves the pre-existing UX of
	 * not flashing the big "Jump to bottom" pill on tiny scroll deltas;
	 * the split-bottom and top-button variants still use pure-geometric
	 * classification against the viewport edges. */
	private _showJumpToBottom = false;

	/** Jump-to-previous-prompt (top button) visibility. Pure function of
	 * DOM geometry: true iff at least one `<user-message>` has its bottom
	 * edge above the scroll container's top edge. */
	private _showJumpToLastPrompt = false;

	/** True iff the bottom button should render as the split "Next prompt |
	 * Bottom" pill. Pure function of DOM geometry: true iff at least one
	 * `<user-message>` has its top edge below the scroll container's bottom
	 * edge. */
	private _showSplitBottom = false;

	// --- Legacy backward-compat shims ---
	// Several E2E tests directly poke `ai._stickToBottom = true` and push
	// into `ai._programmaticEchoes` as part of test setup. These keep the
	// fixtures working without a flood of test edits — production code paths
	// have been migrated to the two-flag model above.
	public set _stickToBottom(v: boolean) {
		this._isAtBottom = v;
		if (v) this._escapedFromLock = false;
	}
	public get _stickToBottom(): boolean { return this._isAtBottom; }
	/** Legacy ring buffer — production no longer reads this. Tests still
	 * `.push()` to it during setup; that's a harmless no-op now. */
	public _programmaticEchoes: Array<{ top: number; height: number }> = [];

	// Measured height (px) of the pill strip floating above the composer. The
	// jump-to-bottom button uses this to position itself just above the strip
	// so stacked / wrapped bash_bg pills don't obscure it on mobile. 0 when
	// no strip is rendered.
	@state() private _pillStripHeight = 0;
	private _pillStripObserver?: ResizeObserver;

	// --- Pill overflow collapsing state ---
	/** Number of pills visible before overflow (rest collapse into "More") */
	private _visiblePillCount = Infinity;
	/** Whether the "More" popover is expanded */
	private _moreExpanded = false;
	/** ResizeObserver for the pill container overflow check */
	private _pillResizeObserver?: ResizeObserver;
	/**
	 * Last measured offsetWidth per pill id. We cache because hidden pills
	 * (inside the "more" popover) aren't in the strip's flex flow and would
	 * otherwise be invisible to the fit algorithm — preventing pills from
	 * being promoted back when space frees up (e.g. after a pill is dismissed,
	 * after a resize, or after the git-status-widget shrinks).
	 */
	private _pillWidths: Map<string, number> = new Map();
	/** Coalesce multiple re-measure requests into one rAF. */
	private _measureScheduled = false;
	/** ID of a pill currently animating out */
	private _dismissingId: string | null = null;
	/** IDs of pills promoted from hidden to visible (animate in) */
	private _promotedIds: Set<string> = new Set();
	/** Whether initial render is done (skip animations on first paint) */
	private _pillsInitialized = false;
	private _unsubscribeSession?: () => void;

	// Tracks host container width <640px for compact label rendering. This catches
	// both the mobile viewport case AND desktop with a side panel open shrinking
	// the chat column below the threshold.
	private _isNarrow = typeof window !== "undefined" && typeof window.matchMedia === "function"
		? !window.matchMedia("(min-width: 640px)").matches
		: false;
	private _narrowResizeObserver?: ResizeObserver;
	@state() private _cwdCopied = false;
	private _cwdCopyResetTimer?: ReturnType<typeof setTimeout>;
	private _updateNarrow = (width: number) => {
		const next = width > 0 && width < 640;
		if (next !== this._isNarrow) {
			this._isNarrow = next;
			this.requestUpdate();
		}
	};

	private async _copyCwd(event: Event): Promise<void> {
		event.preventDefault();
		event.stopPropagation();
		if (!this.cwd || !await copyTextToClipboard(this.cwd)) return;
		this._cwdCopied = true;
		if (this._cwdCopyResetTimer) clearTimeout(this._cwdCopyResetTimer);
		this._cwdCopyResetTimer = setTimeout(() => {
			this._cwdCopied = false;
			this._cwdCopyResetTimer = undefined;
		}, 1500);
	}

	/**
	 * Window-level Escape handler. Aborts the streaming agent regardless of
	 * which element has focus, matching the Stop button. Suppressed when a
	 * modal/popover is open so Escape can dismiss those instead.
	 *
	 * The MessageEditor textarea also handles Escape locally via its own
	 * keydown listener — when focus is in the textarea both handlers fire,
	 * which is harmless because session.abort() is idempotent server-side.
	 */
	private _handleGlobalEscape = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		if (e.defaultPrevented) return;
		const session = this.session;
		if (!session || !session.state?.isStreaming) return;

		// Bail out if any modal/popover is open. Covers ARIA-tagged dialogs,
		// known dialog custom elements, lightbox overlays, and any element
		// signalling "open" via [data-popover-open] / [open].
		// Bail out if a real modal/popover is currently open. We only check
		// markers that are present *only when an overlay is mounted*: ARIA
		// dialog roles, the lightbox attachment overlay, modals appended to
		// document.body by Lit dialogs, and popover-open state markers. Inline
		// footer components like <search-box> / <agent-model-selector> are NOT
		// included — they're always in the DOM and don't represent open state.
		if (typeof document !== "undefined") {
			const dialogSelector = [
				'[role="dialog"]',
				'[aria-modal="true"]',
				"attachment-overlay",
				"verification-output-modal",
				"annotation-popover",
				"project-picker-popover",
				"sidebar-actions-popover",
				"continue-session-chooser",
				"copy-link-fallback-dialog",
			].join(",");
			if (document.querySelector(dialogSelector)) return;
		}

		// Don't double-fire when MessageEditor's local handler will already abort.
		// MessageEditor sits inside this component; let its existing focused-textarea
		// path handle that case (it already calls onAbort).
		const active = (typeof document !== "undefined" ? document.activeElement : null) as HTMLElement | null;
		if (active?.tagName === "TEXTAREA" || active?.tagName === "INPUT") return;

		e.preventDefault();
		session.abort();
	};
	// Server-authoritative queue state, updated via onQueueUpdate callback
	private _serverQueue: Array<{ id: string; text: string; isSteered: boolean; createdAt: number; images?: any[]; attachments?: any[] }> = [];
	/**
	 * Per-session composer attachment draft, lifted out of the transient
	 * <message-editor> element so it survives element recreation (slow-path
	 * session switch, reload, readOnly/isPreparing re-render). Bound INTO the
	 * editor via `.attachments` and updated back via `.onFilesChange`. Durable
	 * across reload via the IndexedDB PromptDraftAttachmentsStore.
	 * See docs/design/composer-draft-persistence.md.
	 */
	@state() private _attachments: Attachment[] = [];
	/** Session id the currently-loaded `_attachments` belong to — guards against
	 *  applying a stale async load after the session prop changed. */
	private _attachmentDraftSessionId?: string;
	/** Monotonic token bumped on every load/set/clear of the attachment draft.
	 *  An in-flight async load captures this and only applies its result if the
	 *  token is unchanged — so a clear-after-send (same session id, empty
	 *  `_attachments`) cannot let a stale read resurrect sent attachments. */
	private _attachmentDraftGen = 0;
	private _cachedToolResults?: Map<string, ToolResultMessage>;
	private _cachedMessagesRef?: AgentMessage[];

	public setInput(text: string, attachments?: Attachment[]) {
		// Keep the lifted per-session draft in sync so the editor binding and the
		// persisted store reflect the externally-supplied attachments.
		this._setAttachmentDraft(attachments || []);
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = this._attachments;
			}
		};
		update();
	}

	/** Load the persisted attachment draft for `sessionId` into `_attachments`.
	 *  Fire-and-forget; ignores the result if the session changed meanwhile. */
	private _loadAttachmentDraft(sessionId: string | undefined): void {
		this._attachmentDraftSessionId = sessionId;
		const gen = ++this._attachmentDraftGen;
		this._attachments = [];
		if (!sessionId) return;
		void (async () => {
			try {
				const files = await getAppStorage().promptDraftAttachments.getAttachments(sessionId);
				// Only apply if neither the session nor the draft generation changed
				// since this load was scheduled. The generation guard catches a
				// clear/set on the SAME session (e.g. send-then-clear) that the
				// session-id check alone would miss, preventing a stale read from
				// resurrecting cleared or replaced attachments.
				if (this._attachmentDraftSessionId !== sessionId) return;
				if (this._attachmentDraftGen !== gen) return;
				if (files.length > 0 && this._attachments.length === 0) {
					this._attachments = files;
					this.requestUpdate();
				}
			} catch {
				/* best effort */
			}
		})();
	}

	/** Update the lifted attachment draft and persist it (debounce-free; these
	 *  events are user-initiated and infrequent). */
	private _setAttachmentDraft(files: Attachment[]): void {
		this._attachments = files;
		++this._attachmentDraftGen;
		const sid = this.session?.sessionId;
		if (!sid) return;
		this._attachmentDraftSessionId = sid;
		void getAppStorage().promptDraftAttachments.setAttachments(sid, files).catch(() => {});
	}

	/** Clear the lifted attachment draft and remove it from the durable store.
	 *  Called on successful send / compact so a sent attachment never resurrects. */
	private _clearAttachmentDraft(): void {
		this._attachments = [];
		++this._attachmentDraftGen;
		const sid = this.session?.sessionId;
		if (sid) void getAppStorage().promptDraftAttachments.deleteAttachments(sid).catch(() => {});
	}

	public setAutoScroll(enabled: boolean) {
		this._isAtBottom = enabled;
		if (enabled) {
			this._escapedFromLock = false;
			this._scrollToBottomNow({ animate: false });
		}
		this._refreshJumpButton();
	}

	// --- use-stick-to-bottom core helpers ---

	/** Near-bottom band, in pixels. Within this distance from the bottom we
	 * consider the user "effectively pinned" — small reflows can't unstick
	 * (`isAtBottom = isAtBottom || isNearBottom` semantically) and a user-
	 * driven scroll back into the band re-engages stickiness automatically.
	 * Matches upstream `use-stick-to-bottom`'s STICK_TO_BOTTOM_OFFSET_PX. */
	private static readonly STICK_TO_BOTTOM_OFFSET_PX = 70;

	/** `scrollHeight - 1 - clientHeight`. The `-1` is intentional and
	 * matches upstream — avoids float-rounding edge cases where the browser
	 * clamps `scrollTop` 1 sub-pixel above the integer target and the
	 * deferred handler then sees "not at bottom" and chases its own tail. */
	private _targetScrollTop(): number {
		if (!this._scrollContainer) return 0;
		return this._scrollContainer.scrollHeight - 1 - this._scrollContainer.clientHeight;
	}

	private _scrollDifference(): number {
		if (!this._scrollContainer) return 0;
		return this._targetScrollTop() - this._scrollContainer.scrollTop;
	}

	private _isNearBottom(): boolean {
		return this._scrollDifference() <= AgentInterface.STICK_TO_BOTTOM_OFFSET_PX;
	}

	/** Cancel any in-flight spring animation. Safe to call repeatedly. */
	private _cancelAnimation() {
		if (this._animation) {
			cancelAnimationFrame(this._animation.rafId);
			const resolve = this._animation.resolve;
			this._animation = null;
			try { resolve(); } catch { /* ignore */ }
		}
	}

	/** Programmatic write helper — sets scrollTop and latches
	 * `_ignoreScrollToTop` so the resulting browser scroll event is consumed
	 * cleanly by the deferred handler. */
	private _writeScrollTop(value: number) {
		if (!this._scrollContainer) return;
		const clamped = Math.max(0, Math.min(value, this._scrollContainer.scrollHeight - this._scrollContainer.clientHeight));
		this._ignoreScrollToTop = clamped;
		this._scrollContainer.scrollTop = clamped;
		// Also keep the legacy ring populated so any test setup that scans
		// it (none in production) still finds the latest write.
		this._programmaticEchoes.push({ top: clamped, height: this._scrollContainer.scrollHeight });
		if (this._programmaticEchoes.length > 4) this._programmaticEchoes.shift();
	}

	/**
	 * Scroll to the bottom. With `animate: false` (default — used by RO
	 * growth, image-load handler, session navigate, sendMessage), writes
	 * scrollTop=target synchronously and resolves on the next rAF. With
	 * `animate: true`, runs a spring rAF loop (damping 0.7, stiffness 0.05,
	 * mass 1.25 — upstream defaults) until `|delta| < 0.5 && |velocity| < 0.5`.
	 */
	private _scrollToBottomNow(opts: { animate?: boolean } = {}): Promise<void> {
		if (!this._scrollContainer) return Promise.resolve();
		this._cancelAnimation();
		const el = this._scrollContainer;
		const target = this._targetScrollTop();
		if (!opts.animate) {
			if (Math.abs(el.scrollTop - target) >= 1) {
				this._writeScrollTop(target);
			}
			return new Promise((resolve) => requestAnimationFrame(() => resolve()));
		}
		// Spring animation path — re-read the goalpost each tick so RO
		// growth during animation can drag the target along (jump-to-bottom
		// keeps chasing the new bottom if the transcript is still growing).
		return this._springScrollTo(() => this._targetScrollTop());
	}

	/** Shared spring scroll animation. Used by the explicit jump-to-bottom
	 * click (re-reading `_targetScrollTop()` each tick to chase RO growth)
	 * and by the prompt-nav clicks (fixed target — pre-computed scrollTop
	 * for the target <user-message>). Same damping/stiffness/mass constants for
	 * both so the feel is identical.
	 *
	 * `targetGetter` can be a number (fixed target) or a function (re-read
	 * each tick).
	 */
	private _springScrollTo(targetGetter: number | (() => number)): Promise<void> {
		if (!this._scrollContainer) return Promise.resolve();
		const el = this._scrollContainer;
		const readTarget = typeof targetGetter === "function" ? targetGetter : () => targetGetter;
		const DAMPING = 0.7;
		const STIFFNESS = 0.05;
		const MASS = 1.25;
		return new Promise<void>((resolve) => {
			const step = () => {
				if (!this._scrollContainer || !this._animation) {
					resolve();
					return;
				}
				const anim = this._animation;
				anim.target = readTarget();
				const diff = anim.target - anim.current;
				anim.velocity = (DAMPING * anim.velocity + STIFFNESS * diff) / MASS;
				anim.current += anim.velocity;
				if (Math.abs(diff) < 0.5 && Math.abs(anim.velocity) < 0.5) {
					this._writeScrollTop(anim.target);
					this._animation = null;
					resolve();
					return;
				}
				this._writeScrollTop(Math.round(anim.current));
				anim.rafId = requestAnimationFrame(step);
			};
			this._animation = {
				current: el.scrollTop,
				target: readTarget(),
				velocity: 0,
				rafId: requestAnimationFrame(step),
				resolve,
			};
		});
	}

	/** Pin to bottom IFF intent says we want to be there. The single
	 * programmatic re-pin gate. Prompt-nav clicks set `_escapedFromLock`
	 * so this short-circuits while the user is reading older history. */
	private _pinIfSticking() {
		if (!this._isAtBottom || this._escapedFromLock) return;
		this._scrollToBottomNow({ animate: false });
	}

	/** Recompute all three jump-button visibility booleans from pure DOM
	 * geometry. Thin wrapper around `_refreshJumpToLastPromptButton` — the
	 * latter is the single source of truth for `_showJumpToBottom`,
	 * `_showJumpToLastPrompt`, and `_showSplitBottom`. Kept as a separate
	 * entry point because many scroll-handler / RO / image-load sites call
	 * it. */
	private _refreshJumpButton() {
		this._refreshJumpToLastPromptButton();
	}

	/** Recompute all jump-button visibility from pure DOM geometry.
	 *
	 * For each `<user-message>`, classify its rect vs the scroll container's:
	 *   - above viewport: `userRect.bottom < containerRect.top`
	 *   - below viewport: `userRect.top > containerRect.bottom`
	 *   - in viewport: otherwise
	 *
	 * Then apply the spec rendering rules:
	 *   1. Top button         visible iff `aboveExists` (pure geometry).
	 *   2. Bottom-centre split visible iff `belowExists` (pure geometry).
	 *   3. Bottom-centre single visible iff `farFromBottom && !belowExists`.
	 *   4. Nothing rendered  iff neither `aboveExists` nor `belowExists`
	 *                            and the scroll position is near the bottom.
	 *
	 * Combined: `_showJumpToBottom = belowExists || farFromBottom`, where
	 * `farFromBottom` is the pre-existing half-viewport threshold
	 * (`dist > clientHeight * 0.5`) carried over from the legacy
	 * implementation. The threshold is intentionally scoped to the
	 * bottom-single "Jump to bottom" variant only — it preserves the
	 * UX of not flashing the big pill on tiny scroll deltas (pinned by
	 * `tests/ui-fixtures/chat-scroll.spec.ts`). The top button and the
	 * split-bottom variant remain purely geometric so they track
	 * viewport edges with no state.
	 *
	 * No state machine — every scroll / resize / mutation tick recomputes
	 * from current geometry. Intent flags (`_isAtBottom`,
	 * `_escapedFromLock`) play no role in button visibility. */
	private _refreshJumpToLastPromptButton() {
		if (!this._scrollContainer) return;
		const container = this._scrollContainer;
		const userMessages = container.querySelectorAll("user-message");
		const containerRect = container.getBoundingClientRect();

		let aboveExists = false;
		let belowExists = false;
		for (const node of userMessages) {
			const r = (node as HTMLElement).getBoundingClientRect();
			if (r.bottom < containerRect.top) aboveExists = true;
			else if (r.top > containerRect.bottom) belowExists = true;
			if (aboveExists && belowExists) break;
		}

		// Half-viewport "far from bottom" threshold for the bottom-single
		// pill. `_targetScrollTop()` clamps to `scrollHeight - 1 -
		// clientHeight` (the -1 absorbs sub-pixel rounding), so the
		// canonical pinned state has `dist === 1`. The legacy
		// `dist > clientHeight * 0.5` threshold is preserved here so the
		// big "Jump to bottom" pill does not flash on tiny scroll deltas
		// (pinned by `tests/ui-fixtures/chat-scroll.spec.ts`). The top
		// button (`aboveExists`) and split-bottom variant (`belowExists`)
		// keep pure-geometric semantics against the viewport edges.
		const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
		const farFromBottom = dist > container.clientHeight * 0.5;
		const nextBottom = belowExists || farFromBottom;

		let changed = false;
		if (aboveExists !== this._showJumpToLastPrompt) {
			this._showJumpToLastPrompt = aboveExists;
			changed = true;
		}
		if (belowExists !== this._showSplitBottom) {
			this._showSplitBottom = belowExists;
			changed = true;
		}
		if (nextBottom !== this._showJumpToBottom) {
			this._showJumpToBottom = nextBottom;
			changed = true;
		}
		if (changed) this.requestUpdate();
	}

	/**
	 * Request a Lit update and re-pin once layout has committed. Used by
	 * transcript-mutating session events (message_update, tool_execution_update,
	 * state_update, turn/agent/compaction events) so growth from the resulting
	 * re-render is followed to the bottom even when the change happens outside
	 * an observed RO target subtree.
	 */
	private _updateAndPin() {
		this.requestUpdate();
		this.updateComplete.then(() => {
			this._pinIfSticking();
			// Transcript mutated — re-evaluate jump-button geometry after
			// Lit commits. This is what makes "sending a new prompt hides the
			// button" work: the new <user-message> is now the last one and
			// lives at the bottom of the transcript. Call the parent
			// (`_refreshJumpButton`) which chains into `_refreshJumpToLastPromptButton`
			// so all three booleans are recomputed consistently.
			this._refreshJumpButton();
		});
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);

		// Re-subscribe when session property changes
		if (changedProperties.has("session")) {
			this.setupSessionSubscription();
			const newSid = this.session?.sessionId;
			// Restore the per-session composer attachment draft (lifted out of the
			// transient <message-editor>) whenever the bound session changes —
			// covers slow-path switch, reload, and readOnly/isPreparing re-renders.
			if (this._attachmentDraftSessionId !== newSid) {
				this._loadAttachmentDraft(newSid);
			}
			// Reset cached proposal-type fetch — the next render's effect will
			// refetch under the new session id (or no-op if the session is live).
			if (this._archivedProposalsFetchedFor !== newSid) {
				this._archivedProposalsFetchedFor = null;
				this._archivedProposalTypes = [];
			}
		}
		// Lazily populate the archived-session proposal-type list when we know
		// the session is read-only and continuable. Fire-and-forget; the result
		// triggers a follow-up render via @state.
		this._maybeRefreshArchivedProposals();
	}

	override async connectedCallback() {
		super.connectedCallback();
		// Fire-and-forget the conditional-render widget chunks on first
		// chat mount so they're ready by the time the corresponding
		// state flips on (gitRepoKnown, bgProcesses populated, cost
		// popover opened, continue-session prompt shown).
		void ensureGitStatusWidget();
		void ensureGoalStatusWidget();
		void ensureBgProcessPill();
		void ensureCostPopover();
		void ensureContinueSessionChooser();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			this._lastScrollHeight = this._scrollContainer.scrollHeight;
			this._lastScrollTop = this._scrollContainer.scrollTop;

			// ResizeObserver — ported from use-stick-to-bottom. Records the
			// height delta into `_resizeDifference` so a `scroll` event fired
			// during the same task is recognised as a resize-driven scroll
			// (the deferred handler bails). Overscroll-clamps `scrollTop` if
			// the browser left it above target after a rapid shrink-then-grow.
			// On positive delta + sticky intent, pin synchronously. On
			// negative delta within the near-bottom band, re-engage stick.
			this._resizeObserver = new ResizeObserver(() => {
				if (!this._scrollContainer) return;
				const el = this._scrollContainer;
				const newScrollHeight = el.scrollHeight;
				const delta = newScrollHeight - this._lastScrollHeight;
				this._lastScrollHeight = newScrollHeight;

				if (delta === 0) {
					// width/border-box reflow only — don't perturb the queue.
					return;
				}

				// Mark the resize and schedule a deferred reset (rAF +
				// setTimeout(1ms)) — matches upstream. The deferred scroll
				// handler reads this flag and skips classification while it
				// is non-zero, eliminating Bug B (resize-vs-scroll ambiguity).
				this._resizeDifference = delta;
				requestAnimationFrame(() => {
					setTimeout(() => {
						if (this._resizeDifference === delta) this._resizeDifference = 0;
					}, 1);
				});

				// Overscroll clamp (Bug E): browser sometimes leaves scrollTop
				// above the new target after rapid shrink-then-grow.
				const target = this._targetScrollTop();
				if (el.scrollTop > target) {
					this._writeScrollTop(target);
				}

				if (delta > 0) {
					// Positive growth — if intent says we want bottom, pin.
					// `_escapedFromLock` gates this off while the user is
					// reading history (prompt-nav clicks set it).
					if (this._isAtBottom && !this._escapedFromLock) {
						this._scrollToBottomNow({ animate: false });
					}
				} else {
					// Negative shrink — if we're now in the near-bottom band
					// and the user hasn't explicitly escaped, re-engage stick.
					if (this._isNearBottom() && !this._escapedFromLock) {
						this._isAtBottom = true;
						this._refreshJumpButton();
						// Apply the post-collapse clamp inherited from the old
						// algorithm (tests/collapse-scroll-bugs.spec.ts). If
						// content bottom rose above the viewport midpoint after
						// the shrink, snap to target.
						const { scrollTop, clientHeight } = el;
						const contentBottom = newScrollHeight - scrollTop;
						if (contentBottom < clientHeight / 2) {
							this._writeScrollTop(this._targetScrollTop());
						}
					}
				}
			});

			const contentContainer = this._scrollContainer.querySelector(".max-w-5xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Track user scroll to decide stick-to-bottom state.
			this._scrollContainer.addEventListener("scroll", this._handleScroll, { passive: true });
			// Explicit user-intent listeners — any of these immediately
			// unsticks (synchronously, BEFORE the resulting scroll event
			// reaches the deferred handler).
			this._scrollContainer.addEventListener("wheel", this._handleUserIntent, { passive: true });
			this._scrollContainer.addEventListener("touchstart", this._handleUserIntent, { passive: true });
			this._scrollContainer.addEventListener("keydown", this._handleScrollKeydown);

			// Capture-phase `load` listener for `<img>`/`<iframe>` decode
			// reflows. NOT redundant with the RO `delta>0` branch: image
			// decode + layout can land BEFORE the next RO tick, leaving a
			// visible frame where the image grew the page but the viewport
			// hasn't been re-pinned yet. The capture-phase listener runs on
			// the same task as the layout commit and pins synchronously, so
			// the user never sees the intermediate frame.
			this._imageLoadHandler = (_e: Event) => {
				if (this._isAtBottom && !this._escapedFromLock) {
					this._scrollToBottomNow({ animate: false });
				}
			};
			this._scrollContainer.addEventListener("load", this._imageLoadHandler, { capture: true });
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();

		// Track host container width so the prompt-bar row compacts when the chat
		// column is narrowed (mobile viewport OR desktop side-panel-open).
		if (typeof ResizeObserver !== "undefined") {
			this._narrowResizeObserver = new ResizeObserver((entries) => {
				const w = entries[0]?.contentRect?.width ?? 0;
				this._updateNarrow(w);
			});
			this._narrowResizeObserver.observe(this);
			this._updateNarrow(this.getBoundingClientRect().width);
		}

		// Global Escape handler: abort the streaming agent regardless of focus,
		// unless a modal/popover is open. Capture phase so a focused textarea's
		// own Escape handler still runs (it calls onAbort too — server-side
		// abort is idempotent), but unfocused users get the same Stop behaviour.
		if (typeof document !== "undefined") {
			document.addEventListener("keydown", this._handleGlobalEscape, true);
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Clean up observers and listeners
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
			this._scrollContainer.removeEventListener("wheel", this._handleUserIntent);
			this._scrollContainer.removeEventListener("touchstart", this._handleUserIntent);
			this._scrollContainer.removeEventListener("keydown", this._handleScrollKeydown);
			if (this._imageLoadHandler) {
				this._scrollContainer.removeEventListener("load", this._imageLoadHandler, { capture: true } as any);
				this._imageLoadHandler = undefined;
			}
		}
		this._cancelAnimation();
		if (this._scrollDeferTimer) {
			clearTimeout(this._scrollDeferTimer);
			this._scrollDeferTimer = null;
		}
		if (this._cwdCopyResetTimer) {
			clearTimeout(this._cwdCopyResetTimer);
			this._cwdCopyResetTimer = undefined;
		}

		if (this._pillResizeObserver) {
			this._pillResizeObserver.disconnect();
			this._pillResizeObserver = undefined;
		}

		if (this._narrowResizeObserver) {
			this._narrowResizeObserver.disconnect();
			this._narrowResizeObserver = undefined;
		}

		document.removeEventListener("click", this._handleMoreClickOutside, true);
		document.removeEventListener("keydown", this._handleGlobalEscape, true);

		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
	}

	private setupSessionSubscription() {
		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
		if (!this.session) return;

		// Reset scroll state for new session and scroll to bottom once rendered.
		// Also clear the jump-to-bottom button — a leftover `true` from the
		// previous session would render the button on session navigate even
		// though we're at the bottom (the next scroll event would clear it,
		// but if the session is already short enough that no scroll fires,
		// the stale state lingers).
		this._isAtBottom = true;
		this._escapedFromLock = false;
		this._ignoreScrollToTop = null;
		this._resizeDifference = 0;
		this._programmaticEchoes = [];
		this._cancelAnimation();
		if (this._showJumpToBottom) {
			this._showJumpToBottom = false;
			this.requestUpdate();
		}
		if (this._showJumpToLastPrompt) {
			this._showJumpToLastPrompt = false;
			this.requestUpdate();
		}
		if (this._showSplitBottom) {
			this._showSplitBottom = false;
			this.requestUpdate();
		}
		// Single re-pin path on session navigate: instant scrollTo bottom
		// once after Lit's first commit. Subsequent async growth (markdown,
		// syntax highlighting, hydrated tool-content, image decode) is
		// caught by the ResizeObserver `delta>0` branch and the capture-
		// phase `load` handler, both of which call `_scrollToBottomNow`.
		this.updateComplete.then(() => this._pinIfSticking());

		// Install the proxy-aware default on the stream property exposed by the
		// session implementation. Normal UI sessions are RemoteAgent instances and
		// expose `streamFn`; Pi 0.81 Agent instances expose `streamFunction` (while
		// still accepting `streamFn` in AgentOptions). Prefer the Pi property when it
		// exists, otherwise use RemoteAgent's bridge property.
		//
		// We can't identity-compare against pi-ai's `streamSimple` without statically
		// importing it (which pulls the 553 kB model catalog into the entry chunk —
		// see src/app/pi-ai-lazy.ts). Instead, mark our wrapper at construction and
		// re-check the selected property on subsequent subscriptions to avoid wrapping
		// the default repeatedly.
		const streamSession = this.session as Agent & { streamFn?: Agent["streamFunction"] };
		const streamProperty = "streamFunction" in streamSession ? "streamFunction" : "streamFn";
		if (!(streamSession[streamProperty] as { __isDefault?: boolean } | undefined)?.__isDefault) {
			const wrapped = createStreamFn(async () => {
				const enabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
				return enabled ? (await getAppStorage().settings.get<string>("proxy.url")) || undefined : undefined;
			});
			(wrapped as { __isDefault?: boolean }).__isDefault = true;
			streamSession[streamProperty] = wrapped;
		}

		// Set default getApiKey if not already set
		if (!this.session.getApiKey) {
			this.session.getApiKey = async (provider: string) => {
				const key = await getAppStorage().providerKeys.get(provider);
				return key ?? undefined;
			};
		}

		// One-time cleanup: remove old client-side queue keys from sessionStorage
		try {
			for (let i = sessionStorage.length - 1; i >= 0; i--) {
				const key = sessionStorage.key(i);
				if (key?.startsWith("bobbit_queue_")) sessionStorage.removeItem(key);
			}
		} catch { /* ignore */ }

		// Listen for server-authoritative queue updates
		if ((this.session as any).onQueueUpdate !== undefined || 'getQueue' in this.session) {
			(this.session as any).onQueueUpdate = (queue: any[]) => {
				this._serverQueue = queue;
				this.requestUpdate();
			};
			// Initialize from current queue state
			if (typeof (this.session as any).getQueue === 'function') {
				this._serverQueue = (this.session as any).getQueue() || [];
			}
		}

		// If the session is already compacting (e.g. page refresh mid-compaction),
		// start the animation once the DOM is ready — we missed the compaction_start event.
		if ((this.session as any)._isCompacting) {
			this.updateComplete.then(() => {
				if (this._streamingContainer) this._streamingContainer.startCompacting();
				this.requestUpdate();
			});
		}

		this._unsubscribeSession = this.session.subscribe(async (ev: AgentEvent) => {
			// Handle custom events not in AgentEvent union
			if ((ev as any).type === "compaction_start") {
				if (this._streamingContainer) this._streamingContainer.startCompacting();
				this._updateAndPin();
				return;
			}
			if ((ev as any).type === "compaction_end") {
				if (this._streamingContainer) this._streamingContainer.endCompacting();
				this._updateAndPin();
				return;
			}
			if ((ev as any).type === "state_update") {
				// Server state refresh (e.g. after compaction or reconnect) —
				// re-render stats and re-pin once layout commits. Content may
				// have been bulk-replaced without triggering a ResizeObserver
				// height change. The carry-over flag is gone: pinning is now a
				// pure function of `_stickToBottom`, which is mutated only by
				// observed user gestures.
				this._updateAndPin();
				return;
			}
			if ((ev as any).type === "tool_execution_update") {
				// Partial results from long-running tools (delegate, skill invocations)
				// Force streaming container to re-render with updated delegate cards
				this._updateAndPin();
				if (this._streamingContainer) {
					this._streamingContainer.toolPartialResults = (this.session?.state as any)?.toolPartialResults;
					this._streamingContainer.requestUpdate();
				}
				return;
			}
			if ((ev as any).type === "cost_update") {
				// Server-authoritative cost data — re-render stats bar
				this.requestUpdate();
				return;
			}
			if ((ev as any).type === "render") {
				// Generic re-render request (e.g. tool permission card added)
				this._clearStreamingIfPermissionBlocked();
				this._updateAndPin();
				return;
			}
			if ((ev as any).type === "auto_retry_pending" || (ev as any).type === "auto_retry_cancelled") {
				// Auto-retry banner state changed — re-render so the banner appears
				// (pending) or disappears (cancelled / consumed by next agent_start).
				this._updateAndPin();
				return;
			}
			if ((ev as any).type === "provider_auth_required") {
				// Provider-auth recovery state changed — re-render so the fix/retry
				// banner appears immediately instead of staying hidden in raw WS data.
				this._updateAndPin();
				return;
			}
			switch (ev.type) {
				case "turn_end":
				case "agent_start":
					this._updateAndPin();
					break;
				case "turn_start":
				case "message_start":
					this._updateAndPin();
					break;
				case "message_end":
					// When a message finishes, sync the streaming container with
					// the current streamingMessage state. If the agent cleared
					// streamingMessage (e.g. message without tool calls), clear the
					// container so the finalized message only appears in
					// message-list. If streamingMessage is set, push it into the
					// container now: some tool-only messages (notably parked
					// `bash_bg wait`) arrive as a final `message_end` without a
					// prior `message_update`.
					if (this._streamingContainer) {
						const sm = this.session?.state.streamingMessage;
						this._streamingContainer.setMessage(sm || null, true);
					}
					this._updateAndPin();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.turnStartTime = null;
						this._streamingContainer.setMessage(null, true);
					}
					// Queue draining is handled server-side now
					this._updateAndPin();
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = this.session?.state.isStreaming || false;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.turnStartTime = (this.session?.state as any).turnStartTime ?? null;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					// message_update doesn't go through Lit's `requestUpdate` (the
					// streaming container manages its own DOM), so route through
					// updateComplete + _pinIfSticking to follow growth.
					this._updateAndPin();
					break;
			}
		});
	}

	/**
	 * Force a re-pin. Used by `sendMessage` where the user typing in the
	 * composer is implicit "put me at the bottom" intent. Synchronous,
	 * non-animated.
	 */
	private _scrollToBottom() {
		this._isAtBottom = true;
		this._escapedFromLock = false;
		this._refreshJumpButton();
		this._scrollToBottomNow({ animate: false });
	}

	/**
	 * Scroll handler — deferred via `setTimeout(0)` per upstream
	 * `use-stick-to-bottom`. Captures `(scrollTop, ignoreScrollToTop)` at
	 * dispatch time, then runs the body in the next macrotask so any RO
	 * tick fired in the same frame has had a chance to set
	 * `_resizeDifference`.
	 *
	 * Body responsibilities:
	 *   1. Skip when a resize is in flight (`_resizeDifference !== 0`) —
	 *      the scroll event came from a layout shift, not user intent.
	 *   2. Consume the `_ignoreScrollToTop` echo latch.
	 *   3. Classify scrollTop vs `_lastScrollTop`:
	 *      • user up   → `_escapedFromLock = true; _isAtBottom = false`.
	 *      • user down → `_escapedFromLock = false`.
	 *      • not escaped + within 70 px band → `_isAtBottom = true`.
	 *   4. Recompute jump-button visibility (closes Bug A).
	 *
	 * NOTE: synchronous user-gesture handlers (`wheel`/`touch`/`keydown`)
	 * flip flags BEFORE the scroll event reaches us, so by the time the
	 * body runs the right values are already in place. The classifier
	 * here is what handles trackpad/touch INERTIAL scroll — the gesture
	 * end-event has fired but the scroll is still moving — and the
	 * user-driven downward scroll back into the band.
	 */
	private _handleScroll = () => {
		if (!this._scrollContainer) return;
		const el = this._scrollContainer;
		const scrollTop = el.scrollTop;
		const ignored = this._ignoreScrollToTop;
		let lastScrollTop = this._lastScrollTop;
		this._lastScrollTop = scrollTop;
		this._ignoreScrollToTop = null;

		if (ignored !== null && ignored > scrollTop) {
			// User scrolled up DURING an animation — use the ignored value
			// as the prior reference so up/down classification stays correct.
			lastScrollTop = ignored;
		}

		// Snapshot user-gesture freshness at SCROLL time (not deferred time)
		// so a wheel→scroll pair is treated atomically.
		const gestureFresh = (performance.now() - this._lastUserGestureTs) < AgentInterface.USER_GESTURE_WINDOW_MS;

		// Defer body via setTimeout(0) so RO can set `_resizeDifference`
		// before we classify. Coalesce: only one timer in flight.
		if (this._scrollDeferTimer) clearTimeout(this._scrollDeferTimer);
		this._scrollDeferTimer = setTimeout(() => {
			this._scrollDeferTimer = null;
			if (!this._scrollContainer) return;

			// (1) Resize-in-flight: this scroll event came from a layout
			// reflow, not user intent. Recompute jump button anyway and bail.
			if (this._resizeDifference !== 0) {
				this._refreshJumpButton();
				return;
			}

			// (2) Echo latch: programmatic write — don't classify, but DO
			// recompute the jump button (closes Bug A from the issue
			// analysis: the previous `return` here skipped button recompute
			// and stranded `_showJumpToBottom = true` at the tail).
			if (ignored !== null && Math.abs(scrollTop - ignored) < 1) {
				this._refreshJumpButton();
				return;
			}

			// (2b) No fresh user gesture — treat as a programmatic scroll
			// from elsewhere on the page (or test-harness direct
			// `scrollTop = X`). Don't escape; if we're sticky and drifted,
			// schedule a re-pin so the viewport snaps back to bottom on the
			// next rAF. This preserves the master-HEAD contract that
			// `_stickToBottom = true` plus a stray scroll event still keeps
			// us pinned — exercised by tail-chat-jump-button-false-positive.
			if (!gestureFresh) {
				// Suppress auto-relock while the user is reading history —
				// prompt-nav clicks set `_escapedFromLock` so this branch is
				// short-circuited.
				if (
					this._isAtBottom
					&& !this._escapedFromLock
					&& !this._isNearBottom()
				) {
					requestAnimationFrame(() => this._pinIfSticking());
				}
				this._refreshJumpButton();
				return;
			}

			// (3) Classify direction.
			const isUp = scrollTop < lastScrollTop;
			const isDown = scrollTop > lastScrollTop;
			const nearBottom = this._isNearBottom();

			if (isUp && !nearBottom) {
				// User scrolled up out of the band — explicit escape.
				// Inertial/trackpad continuation lands here too; the
				// synchronous wheel handler will already have flipped flags
				// once the user's first deltaY<0 fired.
				this._escapedFromLock = true;
				this._isAtBottom = false;
			}
			if (isDown) {
				this._escapedFromLock = false;
			}
			// Near-bottom DOMINATES — once the viewport is within the
			// 70 px band, intent is "stay at bottom" regardless of how
			// we got there. This is upstream's `isAtBottom || isNearBottom`
			// public-API semantic, internalised so RO `delta>0` re-pin
			// fires on subsequent growth without requiring a user-down
			// scroll. Closes Bug C from the issue analysis ("No near-
			// bottom tolerance band").
			if (nearBottom) {
				this._escapedFromLock = false;
				this._isAtBottom = true;
			}

			this._refreshJumpButton();
		}, 0);
	};

	/** Synchronous wheel handler. Upward `deltaY < 0` releases stickiness
	 * immediately — BEFORE the scroll event reaches the deferred handler. */
	private _handleUserIntent = (e: Event) => {
		this._lastUserGestureTs = performance.now();
		if (e.type === "wheel") {
			const we = e as WheelEvent;
			if (we.deltaY < 0) {
				// Soft release: flip `_isAtBottom = false` and cancel any in-
				// flight spring animation so the user's wheel isn't fighting
				// it. We do NOT set `_escapedFromLock` synchronously — that
				// decision is made by the deferred scroll handler once
				// scrollTop has actually moved, based on whether the wheel
				// carried us OUT of the near-bottom band. A 30 px wheel-up
				// that leaves us within the band must auto-relock on the next
				// content growth without requiring a Jump click.
				this._isAtBottom = false;
				this._cancelAnimation();
				this._refreshJumpButton();
			}
			return;
		}
		// touchstart — cancel any in-flight animation so the user's touch
		// isn't fighting it. Direction-based escape is decided by the
		// deferred scroll handler.
		this._cancelAnimation();
	};

	private _handleScrollKeydown = (e: KeyboardEvent) => {
		switch (e.key) {
			case "PageUp":
			case "ArrowUp":
			case "Home":
				this._lastUserGestureTs = performance.now();
				this._escapedFromLock = true;
				this._isAtBottom = false;
				this._cancelAnimation();
				this._refreshJumpButton();
				break;
			case "PageDown":
			case "ArrowDown":
			case "End":
				this._lastUserGestureTs = performance.now();
				this._cancelAnimation();
				break;
		}
	};

	/** Jump-to-bottom click handler. Spring-animated landing back to the
	 * tail; clears the escape latch so subsequent transcript growth re-pins
	 * automatically. */
	private _handleJumpToBottomClick = () => {
		this._isAtBottom = true;
		this._escapedFromLock = false;
		this._refreshJumpButton();
		this._scrollToBottomNow({ animate: true });
	};

	private _hasMobileHeaderOverlay(): boolean {
		if (typeof document === "undefined" || typeof window === "undefined") return false;
		const header = document.getElementById("app-header");
		return !!header && window.getComputedStyle(header).position === "fixed";
	}

	private _getMobileHeaderHeightPx(): number {
		if (!this._hasMobileHeaderOverlay() || typeof window === "undefined") return 0;
		const raw = window.getComputedStyle(document.documentElement).getPropertyValue("--mobile-header-height");
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
	}

	private _getTopPromptNavOffsetPx(): number {
		return 16 + this._getMobileHeaderHeightPx();
	}

	private _getTopPromptNavOffsetCss(): string {
		return this._hasMobileHeaderOverlay()
			? "calc(var(--mobile-header-height, 60px) + 16px)"
			: "16px";
	}

	/** Jump-to-previous-prompt click handler (top button). Walks the DOM
	 * live to find the bottom-most `<user-message>` whose bottom edge is
	 * above the viewport top — i.e. the one closest to the viewport top.
	 * Springs the viewport up so that prompt lands below the visible top
	 * chrome. Stateless: each click reads geometry fresh. */
	private _handleJumpToLastPromptClick = (): void => {
		if (!this._scrollContainer) return;
		const container = this._scrollContainer;
		const userMessages = container.querySelectorAll("user-message");
		if (userMessages.length === 0) return;
		const containerRect = container.getBoundingClientRect();
		let target: HTMLElement | null = null;
		// Walk forward; keep the LAST prompt that is above viewport (its
		// bottom edge above containerRect.top). DOM order is top-to-bottom
		// so the last match is the bottom-most above-viewport prompt.
		for (const node of userMessages) {
			const el = node as HTMLElement;
			if (el.getBoundingClientRect().bottom < containerRect.top) {
				target = el;
			} else {
				break;
			}
		}
		if (!target) return;
		// Mark the user as having escaped the tail-lock so `_pinIfSticking`
		// and the no-gesture re-pin branch don't yank us back mid-spring.
		this._isAtBottom = false;
		this._escapedFromLock = true;
		void this._scrollUserMessageIntoView(target);
	};

	/** Jump-to-next-prompt click handler (split-bottom left half). Walks the
	 * DOM live to find the top-most `<user-message>` whose top edge is below
	 * the viewport bottom — i.e. the one closest to the viewport bottom.
	 * Stateless: each click reads geometry fresh. */
	private _handleJumpToNextPromptClick = (): void => {
		if (!this._scrollContainer) return;
		const container = this._scrollContainer;
		const userMessages = container.querySelectorAll("user-message");
		if (userMessages.length === 0) return;
		const containerRect = container.getBoundingClientRect();
		let target: HTMLElement | null = null;
		for (const node of userMessages) {
			const el = node as HTMLElement;
			if (el.getBoundingClientRect().top > containerRect.bottom) {
				target = el;
				break;
			}
		}
		if (!target) return;
		this._isAtBottom = false;
		this._escapedFromLock = true;
		void this._scrollUserMessageIntoView(target);
	};

	/** Spring-scroll the given `<user-message>` so its top edge lands
	 * `TOP_MARGIN` below the scroll container's top. Cancels any in-flight
	 * spring before starting. Stateless — no walk-cursor is maintained. */
	private async _scrollUserMessageIntoView(targetEl: HTMLElement): Promise<void> {
		if (!this._scrollContainer) return;
		this._cancelAnimation();
		const container = this._scrollContainer;
		const containerRect = container.getBoundingClientRect();
		const targetRect = targetEl.getBoundingClientRect();
		const topMargin = this._getTopPromptNavOffsetPx(); // matches the button's top offset
		const targetScrollTop = Math.max(
			0,
			Math.round(container.scrollTop + (targetRect.top - containerRect.top) - topMargin),
		);
		// Echo-latch: classify the resulting scroll event as programmatic so
		// the deferred handler doesn't flip `_escapedFromLock = true`
		// (the click handler already set it).
		this._ignoreScrollToTop = targetScrollTop;
		await this._springScrollTo(targetScrollTop);
		this._refreshJumpButton();
	}

	public async sendMessage(input: string, attachments?: Attachment[]) {
		if (!input.trim() && (!attachments || attachments.length === 0)) return;
		const session = this.session;
		if (!session) throw new Error("No session set on AgentInterface");

		// Handle /compact slash command
		if (input.trim().toLowerCase() === "/compact") {
			if ("compact" in session && typeof (session as any).compact === "function") {
				this._messageEditor.value = "";
				this._messageEditor.attachments = [];
				this._clearAttachmentDraft();
				// Show the command as a user message in chat
				const userMsg = {
					role: "user" as const,
					content: "/compact",
					timestamp: Date.now(),
					id: `compact_cmd_${Date.now()}`,
				};
				// Append the /compact user message via the reducer's appendMessage path —
				// it persists across the post-compaction snapshot via the reducer's
				// optimistic-survivor rule (id not in snapshot ⇒ kept tail-positioned).
				if (typeof (session as any).appendMessage === "function") {
					(session as any).appendMessage(userMsg);
				} else {
					session.state.messages = [...session.state.messages, userMsg];
				}
				this.requestUpdate();

				// Drive the blob compaction animation from the client side.
				// We start the squash animation immediately, then listen for
				// the server's compaction_end event (or messages refresh) to
				// pop back and show the result.
				if (this._streamingContainer) {
					this._streamingContainer.startCompacting();
				}
				(session as any).compact();
			}
			return;
		}
		if (!session.state.model) throw new Error("No model set on AgentInterface");

		const isStreaming = session.state.isStreaming;

		// Check if API key exists for the provider (only needed in direct mode, skip for queued messages)
		if (!isStreaming) {
			const provider = session.state.model.provider;
			const apiKey = await getAppStorage().providerKeys.get(provider);

			// If no API key, prompt for it
			if (!apiKey) {
				if (!this.onApiKeyRequired) {
					console.error("No API key configured and no onApiKeyRequired handler set");
					return;
				}

				const success = await this.onApiKeyRequired(provider);

				// If still no API key, abort the send
				if (!success) {
					return;
				}
			}
		}

		// Call onBeforeSend hook before sending
		if (this.onBeforeSend) {
			await this.onBeforeSend();
		}

		// Only clear editor after we know we can send
		this._messageEditor.value = "";
		this._messageEditor.attachments = [];
		this._clearAttachmentDraft();
		// Snap to bottom when sending a message.
		// Set flag and scroll immediately, then re-assert after render
		// (scroll events from layout changes can race and unset the flag).
		this._scrollToBottom();

		// Always send to the server — it handles queuing when the agent is busy.
		// Steers are opt-in via the queue pill's Steer button, not automatic.
		if (attachments && attachments.length > 0) {
			const message: UserMessageWithAttachments = {
				role: "user-with-attachments",
				content: input,
				attachments,
				timestamp: Date.now(),
			};
			await session.prompt(message);
		} else {
			await session.prompt(input);
		}
	}



	private _getToolResultsById(): Map<string, ToolResultMessage> {
		const msgs = this.session?.state.messages;
		if (msgs === this._cachedMessagesRef && this._cachedToolResults) {
			return this._cachedToolResults;
		}
		this._cachedMessagesRef = msgs;
		const map = new Map<string, ToolResultMessage>();
		if (msgs) {
			for (const m of msgs) {
				if (m.role === "toolResult") map.set(m.toolCallId, m);
			}
		}
		this._cachedToolResults = map;
		return map;
	}

	private _providerAuthActionLabel(auth: any, type: string, fallback: string): string {
		const action = Array.isArray(auth?.actions)
			? auth.actions.find((a: any) => a?.type === type && typeof a.label === "string")
			: null;
		return action?.label || fallback;
	}

	private _hasProviderAuthAction(auth: any, type: string): boolean {
		const actions = Array.isArray(auth?.actions) ? auth.actions : [];
		return actions.length === 0 || actions.some((a: any) => a?.type === type);
	}

	private _formatProviderLabel(provider: string | undefined): string {
		if (!provider) return "Provider";
		const known: Record<string, string> = {
			openrouter: "OpenRouter",
			openai: "OpenAI",
			anthropic: "Anthropic",
			google: "Google",
			xai: "xAI",
			groq: "Groq",
			mistral: "Mistral",
		};
		return known[provider] || provider.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	}

	private _handleProviderAuthAction(type: "open_settings" | "retry" | "switch_provider" | "abort_respawn"): void {
		const session = this.session as any;
		if (type === "open_settings") {
			setHashRoute("settings", "system/models");
			return;
		}
		if (type === "retry") {
			session?.retry?.();
			this.requestUpdate();
			return;
		}
		if (type === "switch_provider") {
			const model = this.session?.state?.model;
			if (model) {
				void openModelSelector(model, (nextModel) => {
					session?.setModel?.(nextModel);
					this.requestUpdate();
				});
			}
			return;
		}
		if (type === "abort_respawn") {
			if (typeof session?.restartAgent === "function") session.restartAgent();
			else session?.abort?.();
			this.requestUpdate();
		}
	}

	private renderProviderAuthRequired(auth: any) {
		if (!auth) return nothing;
		const state = this.session?.state as any;
		const canRetry = !state?.isStreaming && typeof (this.session as any)?.retry === "function";
		const canSwitch = this.enableModelSelector && !!state?.model && typeof (this.session as any)?.setModel === "function";
		const canAbortRespawn = typeof (this.session as any)?.restartAgent === "function" || typeof (this.session as any)?.abort === "function";
		const provider = this._formatProviderLabel(auth.provider);
		const message = typeof auth.message === "string" && auth.message
			? auth.message
			: `${provider} API key is missing. Add or fix the key, switch provider, then retry.`;
		return html`
			<div
				class="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
				role="alert"
				data-testid="provider-auth-required-banner"
				data-provider=${auth.provider || "unknown"}
			>
				<div class="flex items-start gap-3">
					<div class="shrink-0 text-warning mt-0.5">${icon(AlertTriangle, "sm")}</div>
					<div class="min-w-0 flex-1">
						<div class="font-medium text-foreground">${provider} credentials required</div>
						<div class="mt-1 text-muted-foreground">${message}</div>
						<div class="mt-3 flex flex-wrap gap-2">
							${this._hasProviderAuthAction(auth, "open_settings") ? html`
								<button class="px-2.5 py-1 rounded border border-border bg-card hover:bg-secondary text-foreground text-xs" @click=${() => this._handleProviderAuthAction("open_settings")}>${this._providerAuthActionLabel(auth, "open_settings", "Fix API key")}</button>
							` : nothing}
							${this._hasProviderAuthAction(auth, "retry") && canRetry ? html`
								<button class="px-2.5 py-1 rounded border border-border bg-card hover:bg-secondary text-foreground text-xs" @click=${() => this._handleProviderAuthAction("retry")}>Retry</button>
							` : nothing}
							${this._hasProviderAuthAction(auth, "switch_provider") && canSwitch ? html`
								<button class="px-2.5 py-1 rounded border border-border bg-card hover:bg-secondary text-foreground text-xs" @click=${() => this._handleProviderAuthAction("switch_provider")}>Switch provider</button>
							` : nothing}
							${this._hasProviderAuthAction(auth, "abort_respawn") && canAbortRespawn ? html`
								<button class="px-2.5 py-1 rounded border border-border bg-card hover:bg-secondary text-foreground text-xs" @click=${() => this._handleProviderAuthAction("abort_respawn")}>Abort/respawn</button>
							` : nothing}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	private _permissionRows(): any[] {
		const rows = ((this.session?.state as any)?.messages || []) as any[];
		return rows.filter((m) => m?.role === "tool_permission_needed");
	}

	private _activePermissionRows(): any[] {
		return this._permissionRows().filter((m) => {
			const status = typeof m.status === "string" ? m.status : "active";
			return m.actionable !== false && (status === "active" || status === "granting");
		});
	}

	private _activePermissionToolNames(): Set<string> {
		return new Set(this._activePermissionRows().map((m) => m.toolName).filter((name): name is string => typeof name === "string" && name.length > 0));
	}

	private _clearStreamingIfPermissionBlocked() {
		const blockedTools = this._activePermissionToolNames();
		if (blockedTools.size === 0) return;
		const streaming = this.session?.state?.streamingMessage as any;
		const hasBlockedStreamingTool = streaming?.content?.some?.((c: any) => c?.type === "toolCall" && blockedTools.has(c.name));
		if (hasBlockedStreamingTool && this.session?.state) {
			(this.session.state as any).streamingMessage = null;
			(this.session as any).streamingMessageId = undefined;
		}
		// RemoteAgent clears state.streamingMessage before emitting render on the
		// permission path; clear the imperative container too so stale previews
		// cannot remain beside the frozen blocked placeholder.
		this._streamingContainer?.setMessage(null, true);
	}

	private _patchPermissionRow(id: string | undefined, patch: Record<string, unknown>) {
		if (!id || !this.session?.state) return;
		const current = ((this.session.state as any).messages || []) as any[];
		(this.session.state as any).messages = current.map((m) => m?.role === "tool_permission_needed" && m.id === id ? { ...m, ...patch } : m);
		this.requestUpdate();
	}

	private _patchPermissionRows(ids: string[], patch: Record<string, unknown>) {
		if (!this.session?.state || ids.length === 0) return;
		const idSet = new Set(ids);
		const current = ((this.session.state as any).messages || []) as any[];
		(this.session.state as any).messages = current.map((m) => m?.role === "tool_permission_needed" && idSet.has(m.id) ? { ...m, ...patch } : m);
		this.requestUpdate();
	}

	private _beginPermissionGrant(): boolean {
		if (this._permissionGrantClickLocked) return false;
		this._permissionGrantClickLocked = true;
		setTimeout(() => { this._permissionGrantClickLocked = false; }, 250);
		return true;
	}

	private _renderPinnedPermissions() {
		const rows = this._activePermissionRows();
		if (rows.length === 0) return nothing;
		const groups = new Map<string, any[]>();
		for (const row of rows) {
			const key = `${row.toolName || ""}\u0000${row.group || ""}`;
			groups.set(key, [...(groups.get(key) ?? []), row]);
		}
		const groupedRows = [...groups.values()].map((items) => {
			const first = items[0];
			const count = Math.max(items.length, ...items.map((m) => typeof m.requestCount === "number" ? m.requestCount : 1));
			return { first, ids: items.map((m) => m.id).filter(Boolean), count };
		});
		return html`
			<div
				data-permission-pinned
				data-pinned-permission-controls
				class="pinned-permission-controls mb-2 pointer-events-auto"
			>
				<div class="rounded-lg border border-amber-500/30 bg-background shadow-sm p-2 space-y-2 overflow-y-auto" style="max-height: min(45vh, 22rem); background: color-mix(in oklch, var(--background) 95%, transparent); backdrop-filter: blur(8px);">
					<div class="text-xs font-medium text-amber-600 dark:text-amber-400 px-1">Permission required</div>
					${groupedRows.map(({ first: perm, ids, count }) => html`<tool-permission-card
						.permissionId=${perm.id}
						.toolName=${perm.toolName}
						.group=${perm.group}
						.roleName=${perm.roleName}
						.roleLabel=${perm.roleLabel}
						.status=${perm.status ?? "active"}
						.mode=${perm.mode ?? "session-only"}
						.error=${perm.error ?? ""}
						.requestCount=${count}
						.actionable=${perm.actionable !== false}
						.onModeChange=${(mode: string) => this._patchPermissionRows(ids, { mode })}
						.onGrant=${(scope: "tool" | "group", mode?: string) => {
							if (!this._beginPermissionGrant()) return false;
							this._patchPermissionRows(ids, { status: "granting", actionable: true, mode: mode ?? perm.mode ?? "session-only" });
							(this.session as any)?.grantToolPermission?.(perm.toolName, scope, perm.group, perm.lastPromptText, mode ?? perm.mode ?? "session-only", perm.id);
							return true;
						}}
						.onDeny=${() => {
							this._patchPermissionRows(ids, { status: "denied", actionable: false });
							(this.session as any)?.denyToolPermission?.(perm.id, perm.toolName);
						}}
					></tool-permission-card>`)}
				</div>
			</div>
		`;
	}

	private renderMessages() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session available")}</div>`;
		const state = this.session.state;

		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = this._getToolResultsById();
		// Hide `[ask_user_choices_response tool_use_id=...]` user messages from the
		// rendered transcript — the matching tool_use card renders the user's
		// answers inline via the widget's Answered mode. The envelope message must
		// still reach the LLM (convertToLlm) so do NOT strip it from state.messages.
		// Hide the message currently owned by the streaming container —
		// otherwise the same row would render in both message-list and
		// streaming-container. The reducer publishes this id via RemoteAgent's
		// `_streamingMessageId` private field; we read it defensively.
		const streamingMessageId: string | undefined = (this.session as any)?.streamingMessageId;
		const streamingMessage: any = this.session?.state.streamingMessage;
		const visibleMessages = (this.session.state.messages || []).filter((m: any) => {
			if (isAskResponseEnvelope(m)) return false;
			// Belt-and-braces: hide a row that IS the same object reference as
			// the in-flight streaming message, even if streamingMessageId is
			// undefined (legacy fallback path). The id-equality check below is
			// the primary guard.
			if (streamingMessage && m === streamingMessage) return false;
			return !streamingMessageId || m.id !== streamingMessageId;
		});
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${visibleMessages}
					.sessionId=${this.session?.sessionId ?? ""}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.hasStreamMessage=${!!state.streamingMessage}
					.toolPartialResults=${(state as any).toolPartialResults}
					.hideActionablePermissionRows=${true}
					.onCostClick=${this.onCostClick}
					.onDismissError=${(id: string) => {
						if (!this.session) return;
						this.session.state.messages = this.session.state.messages.filter(
							(m: any) => !(m.role === "error" && m.id === id)
						);
						this.requestUpdate();
					}}
					.onRestartAgent=${typeof (this.session as any)?.restartAgent === 'function'
						? () => (this.session as any).restartAgent()
						: undefined}
					.onRetry=${!state.isStreaming && typeof (this.session as any)?.retry === 'function'
						? () => (this.session as any).retry()
						: undefined}
					@permission-mode-change=${(e: CustomEvent) => {
						const { id, mode } = e.detail;
						this._patchPermissionRow(id, { mode });
					}}
					@grant-tool-permission=${(e: CustomEvent) => {
						if (!this.session || !this._beginPermissionGrant()) return;
						const { id, toolName, scope, group, lastPromptText, mode } = e.detail;
						this._patchPermissionRow(id, { status: "granting", actionable: true, mode });
						(this.session as any).grantToolPermission?.(toolName, scope, group, lastPromptText, mode, id);
					}}
					@deny-tool-permission=${(e: CustomEvent) => {
						if (!this.session) return;
						const { id, toolName } = e.detail;
						this._patchPermissionRow(id, { status: "denied", actionable: false });
						(this.session as any).denyToolPermission?.(id, toolName);
					}}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.archived=${this.readOnly && !this.nonInteractive}
					.pendingToolCalls=${state.pendingToolCalls}
					.permissionBlockedTools=${this._activePermissionToolNames()}
					.toolResultsById=${toolResultsById}
					.toolPartialResults=${(state as any).toolPartialResults}
					.onCostClick=${this.onCostClick}
					.turnStartTime=${(state as any).turnStartTime ?? null}
				></streaming-message-container>

				${this.renderProviderAuthRequired((state as any).providerAuthRequired)}

				${(state as any).isPreparing ? html`
					<div class="flex items-center gap-2 px-4 py-2 text-muted-foreground text-sm">
						<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
						</svg>
						<span>Setting up worktree…</span>
					</div>
				` : nothing}

				${(() => {
					const pending = (state as any).autoRetryPending as null | {
						reason: "provider-overload" | "transient-error";
						retryDelayMs: number;
						attempt: number;
						scheduledAt: number;
						error?: string;
					};
					if (!pending) return nothing;
					const secs = Math.max(1, Math.round(pending.retryDelayMs / 1000));
					const label = pending.reason === "provider-overload"
						? `Retrying in ~${secs}s due to provider overload…`
						: `Retrying in ~${secs}s after transient error…`;
					const detail = `attempt #${pending.attempt}`;
					return html`
						<div
							class="flex items-center gap-2 px-4 py-2 text-muted-foreground text-sm"
							data-testid="auto-retry-banner"
							data-reason=${pending.reason}
							data-attempt=${String(pending.attempt)}
							data-retry-delay-ms=${String(pending.retryDelayMs)}
						>
							<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
							</svg>
							<span>${label}</span>
							<span class="opacity-60">(${detail})</span>
						</div>
					`;
				})()}

			</div>
		`;
	}

	private renderStats() {
		if (!this.session) return html`<div class="text-xs h-5"></div>`;

		const state = this.session.state;
		const totals = state.messages
			.filter((m) => m.role === "assistant")
			.reduce(
				(acc, msg: any) => {
					const usage = msg.usage;
					if (usage) {
						acc.input += usage.input;
						acc.output += usage.output;
						acc.cacheRead += usage.cacheRead;
						acc.cacheWrite += usage.cacheWrite;
						acc.cost.total += usage.cost.total;
					}
					return acc;
				},
				{
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} satisfies Usage,
			);

		// Server-authoritative cumulative cost is the only session-cost source of truth.
		// Visible message usage is a compacted-window subset and must not drive the footer.
		const serverCost = (this.session as any)?.state?.serverCost;
		const serverCostTotal = typeof serverCost?.totalCost === "number" && Number.isFinite(serverCost.totalCost)
			? serverCost.totalCost
			: undefined;
		const costText = serverCostTotal && serverCostTotal > 0 ? formatCost(serverCostTotal) : "";

		// Compute context usage from the last assistant message's usage
		let contextHtml = html``;
		const model = state.model;
		// After compaction the last assistant `usage` still reflects the
		// pre-compaction context size and pi-coding-agent doesn't expose a
		// post-compaction count anywhere. While the stale flag is set we
		// render a subtle shimmering placeholder bar so the user knows the
		// real number is pending without misleading them with stale data.
		const usageStale = (this.session as any)?._usageStaleAfterCompaction === true;
		if (model?.contextWindow) {
			if (usageStale) {
				// Deflation animation: bar starts at the pre-compaction fill
				// percentage (captured on `compaction_start`) and CSS-eases
				// down to the shimmer resting width (25%). Falls back to a
				// static 25% bar when we couldn't sample the original fill.
				const startPct = (this.session as any)?._compactionStartPct as number | null | undefined;
				const hasStart = typeof startPct === "number" && startPct > 25;
				const innerStyle = hasStart
					? `--from-pct:${startPct}%;height:100%;background:var(--primary,#3b82f6);border-radius:3px;opacity:0.4;`
					: `width:25%;height:100%;background:var(--primary,#3b82f6);border-radius:3px;opacity:0.4;`;
				const innerClass = hasStart ? "context-bar-deflate" : "";
				contextHtml = html`
					<span class="flex items-center gap-1.5" title="Context usage refreshing after compaction…">
						<span class="context-bar-shimmer" style="display:inline-flex;align-items:center;width:48px;height:6px;background:var(--muted,#27272a);border-radius:3px;overflow:hidden;">
							<span class=${innerClass} style=${innerStyle}></span>
						</span>
						<span style="opacity:0.6">-%</span>
					</span>
				`;
			} else {
				// Find last assistant message with usage (skip aborted/error)
				let lastUsage: Usage | undefined;
				for (let i = state.messages.length - 1; i >= 0; i--) {
					const msg = state.messages[i] as any;
					if (msg.role === "assistant" && msg.usage && msg.stopReason !== "aborted" && msg.stopReason !== "error") {
						lastUsage = msg.usage;
						break;
					}
				}

				if (lastUsage) {
					const contextTokens = lastUsage.totalTokens || (lastUsage.input + lastUsage.output + lastUsage.cacheRead + lastUsage.cacheWrite);
					const contextWindow = model.contextWindow;
					const pct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
					const barColor = pct >= 90 ? "var(--destructive, #ef4444)" : pct >= 75 ? "var(--warning, #f59e0b)" : "var(--primary, #3b82f6)";
					contextHtml = html`
						<span class="flex items-center gap-1.5" title="Context: ${formatTokenCount(contextTokens)} / ${formatTokenCount(contextWindow)} tokens (${pct}%)">
							<span style="display:inline-flex;align-items:center;width:48px;height:6px;background:var(--muted,#27272a);border-radius:3px;overflow:hidden">
								<span style="width:${pct}%;height:100%;background:${barColor};border-radius:3px;transition:width 0.3s"></span>
							</span>
							<span>${pct}%</span>
						</span>
					`;
				}
			}
		}

		const session = this.session!;
		const supportsThinking = (state.model as any)?.reasoning === true;

		// The dropdown popover always shows full labels; on mobile (<640px) the trigger
		// label is rewritten to an abbreviation in updated() (DOM post-processing) so the
		// popover items remain readable.
		const fullLabels: Record<ThinkingLevel, string> = {
			off: i18n("Off"),
			minimal: i18n("Minimal"),
			low: i18n("Low"),
			medium: i18n("Medium"),
			high: i18n("High"),
			xhigh: i18n("Extra high"),
			max: i18n("Max"),
		};
		const supportedLevels: ThinkingLevel[] = state.model
			? getSupportedThinkingLevels(state.model as any)
			: ["off", "minimal", "low", "medium", "high"];
		const thinkingTitle = fullLabels[(state.thinkingLevel as ThinkingLevel) ?? "off"] ?? fullLabels.off;

		const thinkingSelect = supportsThinking && this.enableThinkingSelector
			// Outer button gap (label → chevron) tightened to 2px; inner span gap
			// (brain icon → label) stays at 4px so the icon doesn't crowd the text.
			? html`<span class="thinking-select-compact [&_button]:!gap-0.5 [&_button]:!px-1.5 [&_button>span]:!gap-1" title="${thinkingTitle}">${Select({
				value: state.thinkingLevel,
				placeholder: fullLabels.off,
				options: supportedLevels.map(lvl => ({ value: lvl, label: fullLabels[lvl], icon: icon(Brain, "sm") })) as SelectOption[],
				onChange: (value: string) => {
					if (typeof (session as any).setThinkingLevel === 'function') (session as any).setThinkingLevel(value);
					else session.state.thinkingLevel = value as any;
				},
				width: "70px",
				size: "sm",
				variant: "ghost",
				fitContent: true,
			})}</span>`
			: "";

		const modelButton = this.enableModelSelector && state.model
			? Button({
				variant: "ghost",
				size: "sm",
				onClick: () => {
					void openModelSelector(state.model, (m) => {
						if (typeof (session as any).setModel === 'function') (session as any).setModel(m);
						else session.state.model = m;
						// After model change, clamp the current thinking level to one
						// supported by the new model. The server boundary re-clamps
						// defensively, but doing it here keeps the UI in sync.
						const current = session.state?.thinkingLevel as string | undefined;
						if (current) {
							const clamped = clampThinkingLevel(current, m as any);
							if (clamped && clamped !== current) {
								if (typeof (session as any).setThinkingLevel === 'function') (session as any).setThinkingLevel(clamped);
								else session.state.thinkingLevel = clamped as any;
							}
						}
					});
				},
				children: html`
					${icon(Sparkles, "sm")}
					<span class="ml-0 sm:ml-0.5" data-testid="footer-model-id">${state.model.id}</span>
				`,
				// Mobile: tighten gap (4px) and horizontal padding so the sparkles
				// icon sits closer to the model name. ! beats Button's defaults.
				className: "h-6 text-xs truncate !gap-1 sm:!gap-2 !px-1.5 sm:!px-3",
			})
			: "";

		const imageModel = (state as any).imageGenerationModel;
		const imageModelButton = this.enableModelSelector && imageModel
			? Button({
				variant: "ghost",
				size: "sm",
				onClick: () => {
					void openImageModelSelector(imageModel, (m) => {
						if (typeof (session as any).setImageGenerationModel === "function") {
							(session as any).setImageGenerationModel(m);
						} else {
							(session.state as any).imageGenerationModel = m;
						}
					});
				},
				children: html`
					${icon(ImageIcon, "sm")}
					<span class="ml-0.5 ${this._isNarrow ? "sr-only" : ""}" data-testid="footer-image-model-id">${imageModel.id}</span>
				`,
				className: "h-6 text-xs truncate",
			})
			: "";

		const cwdHtml = this.cwd ? html`
			<span
				class="font-mono opacity-60 truncate"
				data-testid="footer-cwd-path"
				title=${this.cwd}
			>${this.cwd}</span>
			<button
				type="button"
				class="shrink-0 rounded p-1 opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100 transition-colors"
				data-testid="footer-cwd-copy"
				aria-label=${this._cwdCopied ? "Working directory copied" : "Copy working directory"}
				title=${this._cwdCopied ? "Copied" : "Copy working directory"}
				@click=${(event: Event) => void this._copyCwd(event)}
			>${icon(this._cwdCopied ? Check : Copy, "xs")}</button>
		` : nothing;

		// Build context popover content
		const popoverContent = this._contextPopoverOpen ? (() => {
			const m = model as any;
			// Find last assistant usage (same logic as above)
			let lastUsage: Usage | undefined;
			if (!usageStale) {
				for (let i = state.messages.length - 1; i >= 0; i--) {
					const msg = state.messages[i] as any;
					if (msg.role === "assistant" && msg.usage && msg.stopReason !== "aborted" && msg.stopReason !== "error") {
						lastUsage = msg.usage;
						break;
					}
				}
			}
			const contextTokens = lastUsage ? (lastUsage.totalTokens || (lastUsage.input + lastUsage.output + lastUsage.cacheRead + lastUsage.cacheWrite)) : 0;
			const contextWindow = m?.contextWindow || 0;
			const pct = contextWindow ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
			const msgCount = state.messages.length;
			const turnCount = state.messages.filter((msg: any) => msg.role === "assistant").length;

			const row = (label: string, value: any) => html`
				<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">
					<span style="color:var(--muted-foreground)">${label}</span>
					<span style="font-weight:500;font-variant-numeric:tabular-nums">${value}</span>
				</div>`;

			return html`
				<div class="context-popover" style="
					position:absolute;bottom:100%;right:0;margin-bottom:6px;z-index:50;
					background:var(--popover);color:var(--popover-foreground);
					border:1px solid var(--border);border-radius:8px;
					padding:12px 14px;min-width:260px;max-width:320px;
					box-shadow:0 4px 12px rgba(0,0,0,0.15);font-size:12px;
				">
					${m ? html`
						<div style="font-weight:600;font-size:13px;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
							${icon(Sparkles, "sm")} ${m.id}
						</div>
						<div style="border-bottom:1px solid var(--border);margin-bottom:8px;padding-bottom:8px;">
							${row("Provider", m.provider)}
							${row("Context window", contextWindow ? formatTokenCount(contextWindow) + " tokens" : "—")}
							${row("Max output", m.maxTokens ? formatTokenCount(m.maxTokens) + " tokens" : "—")}
							${row("Cost", m.cost ? formatModelCost(m.cost) + "/M tokens" : "—")}
						</div>
					` : nothing}

					<div style="font-weight:600;margin-bottom:6px;">Context Usage</div>
					<div style="margin-bottom:8px;">
						<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
							<span style="flex:1;height:6px;background:var(--muted,#27272a);border-radius:3px;overflow:hidden;">
								<span style="display:block;width:${usageStale ? 0 : pct}%;height:100%;background:${pct >= 90 ? "var(--destructive, #ef4444)" : pct >= 75 ? "var(--warning, #f59e0b)" : "var(--primary, #3b82f6)"};border-radius:3px;transition:width 0.3s"></span>
							</span>
							<span style="font-weight:500;min-width:36px;text-align:right">${usageStale ? "—" : pct + "%"}</span>
						</div>
						${!usageStale && lastUsage ? html`
							<div style="color:var(--muted-foreground)">${formatTokenCount(contextTokens)} / ${formatTokenCount(contextWindow)} tokens</div>
						` : usageStale ? html`<div style="color:var(--muted-foreground)">Updating after compaction…</div>` : nothing}
					</div>

					${lastUsage ? html`
						<div style="border-top:1px solid var(--border);padding-top:8px;">
							<div style="font-weight:600;margin-bottom:6px;">Last Turn</div>
							${row("Input tokens", formatTokenCount(lastUsage.input))}
							${row("Output tokens", formatTokenCount(lastUsage.output))}
							${lastUsage.cacheRead ? row("Cache read", formatTokenCount(lastUsage.cacheRead)) : nothing}
							${lastUsage.cacheWrite ? row("Cache write", formatTokenCount(lastUsage.cacheWrite)) : nothing}
						</div>
					` : nothing}

					<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:8px;">
						<div style="font-weight:600;margin-bottom:6px;">Session</div>
						${row("Messages", msgCount)}
						${row("Turns", turnCount)}
						${row("Total cost", serverCostTotal && serverCostTotal > 0 ? formatCost(serverCostTotal) : "—")}
						${row("Total input", formatTokenCount(totals.input))}
						${row("Total output", formatTokenCount(totals.output))}
						${totals.cacheRead ? row("Total cache read", formatTokenCount(totals.cacheRead)) : nothing}
					</div>
				</div>
			`;
		})() : nothing;

		const togglePopover = () => {
			this._contextPopoverOpen = !this._contextPopoverOpen;
			this._costPopoverOpen = false;
			this.requestUpdate();
		};

		// Close popover when clicking outside
		const closePopover = () => {
			if (this._contextPopoverOpen || this._costPopoverOpen) {
				this._contextPopoverOpen = false;
				this._costPopoverOpen = false;
				this.requestUpdate();
			}
		};

		return html`
			<div class="text-xs text-muted-foreground flex items-center mt-0.5 pl-2 pr-2 sm:pl-0 sm:pr-0" data-testid="session-stats-bar">
				<div class="flex shrink-0 items-center">
					${this.showThemeToggle ? html`<bell-toggle></bell-toggle><theme-toggle></theme-toggle>` : html``}
					${thinkingSelect}
					${modelButton}
					${imageModelButton}
				</div>
				${this.cwd && !this._isNarrow ? html`<div class="flex min-w-0 flex-1 items-center gap-1 pl-4 pr-3">${cwdHtml}</div>` : ""}
				<div class="flex shrink-0 ml-auto items-center gap-3 relative" style="position:relative">
					${popoverContent}
					<span class="cursor-pointer hover:text-foreground transition-colors"
						@click=${(e: Event) => { e.stopPropagation(); togglePopover(); }}>
						${contextHtml}
					</span>
					${costText ? html`
						<span style="position:relative;">
							<span class="cursor-pointer hover:text-foreground transition-colors"
								@click=${(e: Event) => {
									e.stopPropagation();
									this._costPopoverOpen = !this._costPopoverOpen;
									this._contextPopoverOpen = false;
									this.requestUpdate();
								}}>${costText}</span>
							<cost-popover
								.open=${this._costPopoverOpen}
								.sessionId=${this.session?.sessionId || ""}
								@close=${() => { this._costPopoverOpen = false; this.requestUpdate(); }}
							></cost-popover>
						</span>
					` : ""}
				</div>
			</div>
			${this._contextPopoverOpen || this._costPopoverOpen ? html`<div style="position:fixed;inset:0;z-index:40;" @click=${closePopover}></div>` : nothing}
		`;
	}

	override render() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session set")}</div>`;

		const session = this.session;
		const state = this.session.state;
		return html`
			<div class="flex flex-col h-full bg-background text-foreground min-w-0">
				<!-- Messages Area -->
				<div class="flex-1 min-h-0 relative">
					<div class="absolute inset-0 overflow-y-auto overflow-x-hidden" style="overflow-anchor: none;">
						<div class="max-w-5xl mx-auto p-2 sm:p-4 pb-0 min-w-0">${this.renderMessages()}</div>
					</div>
					${this._renderJumpToLastPrompt()}
					${this._renderJumpToBottom()}
				</div>

				<!-- Input Area -->
				<div class="shrink-0 pt-0 pb-1 agent-input-area">
					<div data-input-container class="max-w-5xl mx-auto px-2 relative">
						${this._renderPinnedPermissions()}
						${this.bgProcesses.length > 0 || this._showGitStatusWidget || this.goalId || this.teamGoalId ? html`
						<div data-pill-strip class="absolute right-2 bottom-full mb-3 z-10 pointer-events-auto" style="max-width:${this._isNarrow ? '75%' : 'calc(100% - 8rem)'}; --pill-h: 22px">
							<!-- Real pills with a CSS drop-shadow filter for the glow. Drop-shadow
							     follows the actual rendered shape per-element, so wrapping or
							     differently-sized children (git-status-widget vs bash_bg pills)
							     stay aligned on every viewport — unlike the previous parallel
							     glow-placeholder layer which mismatched on mobile. -->
<!-- Wrap policy is viewport-dependent:
							       Wide (>=640px host): flex-nowrap. The fit algorithm in
							       _measurePillOverflow truncates pills into the "more" popover
							       so the strip should never need to wrap. On the very first
							       render after bgProcesses populates, _visiblePillCount is
							       Infinity until rAF fires the measure — every pill is in the
							       DOM for one frame. Without flex-nowrap they'd briefly spill
							       onto a second row and the user would see a 2-line flash.
							       With flex-nowrap they overflow horizontally (off the left
							       edge of the strip's max-width box) for that frame instead,
							       which is far less visible.
							       Narrow (<640px, portrait/mobile): flex-wrap. On phones the
							       "force everything into one row" trade-off hurts — vertical
							       space is the cheap dimension, and pushing all pills into
							       "more" hides info the user wants at a glance. Allow a second
							       row instead.
							     We deliberately do NOT add overflow:hidden on the strip — that
							     would clip the in-tree "more" popover (absolute bottom-full
							     inside the .relative wrapper inside the strip). -->
							<div data-pill-content class="flex items-center gap-1.5 ${this._isNarrow ? 'flex-wrap' : 'flex-nowrap'} justify-end" style="position:relative;z-index:1;filter:drop-shadow(0 0 4px var(--background)) drop-shadow(0 0 8px var(--background))">
							${this._renderPillStrip()}
							${(this.goalId || this.teamGoalId) ? html`<goal-status-widget
								.goalId=${this.teamGoalId || this.goalId || ''}
								.token=${localStorage.getItem("gateway.token") || ""}
								.branch=${this.gitStatus?.branch ?? ''}
							></goal-status-widget>` : nothing}
							${this._showGitStatusWidget ? html`<git-status-widget
								.sessionId=${this.session?.sessionId ?? ''}
								.token=${localStorage.getItem("gateway.token") || ""}
								.branch=${this.gitStatus?.branch ?? ''}
								.primaryBranch=${this.gitStatus?.primaryBranch ?? 'master'}
								.primaryRef=${this.gitStatus?.primaryRef ?? `origin/${this.gitStatus?.primaryBranch ?? 'master'}`}
								.isOnPrimary=${this.gitStatus?.isOnPrimary ?? true}
								.summary=${this.gitStatus?.summary ?? ''}
								.clean=${this.gitStatus?.clean ?? true}
								.hasUpstream=${this.gitStatus?.hasUpstream ?? false}
								.ahead=${this.gitStatus?.ahead ?? 0}
								.behind=${this.gitStatus?.behind ?? 0}
								.aheadOfPrimary=${this.gitStatus?.aheadOfPrimary ?? 0}
								.behindPrimary=${this.gitStatus?.behindPrimary ?? 0}
								.insertionsVsPrimary=${this.gitStatus?.insertionsVsPrimary ?? 0}
								.deletionsVsPrimary=${this.gitStatus?.deletionsVsPrimary ?? 0}
								.mergedIntoPrimary=${this.gitStatus?.mergedIntoPrimary ?? false}
								.unpushed=${this.gitStatus?.unpushed ?? false}
								.statusFiles=${this.gitStatus?.status ?? []}
								.repos=${(this.gitStatus as { repos?: Record<string, unknown> } | null | undefined)?.repos as any}
								.loading=${this.gitStatusLoading}
								.partial=${this.partial}
								.prState=${this.prState}
								.prUrl=${this.prUrl}
								.prNumber=${this.prNumber}
								.prTitle=${this.prTitle}
								.prMergeable=${this.prMergeable}
								.viewerIsAdmin=${this.viewerIsAdmin ?? false}
								.viewerCanMergeAsAdmin=${this.viewerCanMergeAsAdmin ?? false}
								.reviewDecision=${this.reviewDecision}
								.headRefName=${this.headRefName}
								@pr-merge=${this._handlePrMerge}
								@git-pull=${this._handleGitPull}
								@git-push=${this._handleGitPush}
								@git-fetch=${this._handleGitFetch}
								@git-merge-primary=${this._handleGitMergePrimary}
								@git-squash-push=${this._handleGitSquashPush}
								@ask-agent-commit=${this._handleAskAgentCommit}
								@ask-agent-pr=${this._handleAskAgentPr}
							></git-status-widget>` : nothing}
							</div>
						</div>
						` : ''}
						${(this.session as any)?.isAborting ? html`
						<div class="flex items-center gap-2 px-4 py-1 text-muted-foreground text-sm">
							<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
							</svg>
							Aborting…
						</div>` : nothing}
						${this.canContinueArchived && !this.nonInteractive && !(state as any).isPreparing ? html`
						<div class="flex flex-col items-center gap-2 px-4 py-6" style="border-top:1px solid var(--border);" data-continue-archived-footer>
							<div class="text-xs text-muted-foreground">This session is archived.</div>
							<div class="flex items-center gap-2 flex-wrap justify-center">
								${this._archivedProposalTypes.length > 0 ? html`
								<button
									type="button"
									class="px-3 py-1.5 text-sm rounded-md text-white"
									style="background:var(--primary,#3b82f6);border:1px solid var(--primary,#3b82f6);"
									data-action="resubmit-proposal"
									data-proposal-type=${this._archivedProposalTypes[0]}
									@click=${() => this._openProposalPanel(this._archivedProposalTypes[0])}
								>Resubmit ${this._archivedProposalTypes[0]} proposal</button>
								` : nothing}
								<button
									type="button"
									class="px-3 py-1.5 text-sm rounded-md"
									style=${this._archivedProposalTypes.length > 0
										? "background:transparent;border:1px solid var(--border);color:var(--foreground);"
										: "background:var(--primary,#3b82f6);border:1px solid var(--primary,#3b82f6);color:#fff;"}
									data-action="continue-archived"
									@click=${() => this._openContinueChooser()}
								>Continue in New Session</button>
							</div>
						</div>
						` : nothing}
						${(this.readOnly && !(this.nonInteractive && state.isStreaming)) || (state as any).isPreparing ? nothing : html`<message-editor style="position:relative;z-index:20"
							.sessionId=${this.session?.sessionId}
							.cwd=${this.cwd}
							.projectId=${this.projectId}
							.isStreaming=${state.isStreaming}
							.currentModel=${state.model}
							.thinkingLevel=${state.thinkingLevel}
							.showAttachmentButton=${this.enableAttachments}
							.showModelSelector=${this.enableModelSelector}
							.showThinkingSelector=${this.enableThinkingSelector}
							.queuedMessages=${this._serverQueue}
							.attachments=${this._attachments}
							.onFilesChange=${(files: Attachment[]) => {
								this._setAttachmentDraft(files);
							}}
							.onSend=${(input: string, attachments: Attachment[]) => {
								this.sendMessage(input, attachments);
							}}
							.onAbort=${() => session.abort()}
							.onSteer=${(msg: any) => {
								if (typeof (session as any).steerQueued === 'function') {
									(session as any).steerQueued(msg.id);
								}
							}}
							.onRemoveQueued=${(id: string) => {
								if (typeof (session as any).removeQueued === 'function') {
									(session as any).removeQueued(id);
								}
							}}
							.onEditQueued=${(msg: any) => {
								// Remove pill from queue and place text back in textarea for editing
								if (typeof (session as any).removeQueued === 'function') {
									(session as any).removeQueued(msg.id);
								}
								this._messageEditor.value = msg.text || '';
								// Focus the textarea inside the editor
								const ta = this._messageEditor.shadowRoot?.querySelector('textarea');
								ta?.focus();
							}}
							.onReorder=${(messageIds: string[]) => {
								if (typeof (session as any).reorderQueue === 'function') {
									(session as any).reorderQueue(messageIds);
								}
							}}
							.onModelSelect=${() => {
								void openModelSelector(state.model, (model) => {
								if (typeof (session as any).setModel === 'function') (session as any).setModel(model);
								else session.state.model = model;
								// Clamp thinking-level against the newly selected model.
								const current = session.state?.thinkingLevel as string | undefined;
								if (current) {
									const clamped = clampThinkingLevel(current, model as any);
									if (clamped && clamped !== current) {
										if (typeof (session as any).setThinkingLevel === 'function') (session as any).setThinkingLevel(clamped);
										else session.state.thinkingLevel = clamped as any;
									}
								}
							});
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: ThinkingLevel) => {
											if (typeof (session as any).setThinkingLevel === 'function') (session as any).setThinkingLevel(level);
											else session.state.thinkingLevel = level;
										}
									: undefined
							}
						></message-editor>`}
						${this.renderStats()}
					</div>
				</div>
			</div>
		`;
	}

	// Jump-to-previous-prompt floating button. Mirror of jump-to-bottom,
	// anchored to the TOP-CENTRE of the visible messages region. On mobile
	// the app header is fixed over the chat, so offset below
	// --mobile-header-height as well as the normal 16px breathing room.
	// Visible iff at least one `<user-message>` is fully above the viewport.
	private _renderJumpToLastPrompt() {
		const show = this._showJumpToLastPrompt;
		const topOffset = this._getTopPromptNavOffsetCss();
		const text = "Jump to previous prompt";
		return html`
			<button
				type="button"
				data-testid="jump-to-previous-prompt"
				aria-label=${text}
				class="absolute left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full bg-background hover:bg-muted text-foreground border border-input shadow-sm whitespace-nowrap"
				style="top:${topOffset};opacity:${show ? "1" : "0"};pointer-events:${show ? "auto" : "none"};transition:opacity 150ms ease-out, top 150ms ease-out"
				tabindex="${show ? "0" : "-1"}"
				@click=${this._handleJumpToLastPromptClick}
			>
				${icon(ArrowUp, "sm")}
				<span>${text}</span>
			</button>
		`;
	}

	/** Shared bottom-offset math for jump-to-bottom (both single and split
	 * variants). Base 16 px + pill-strip height + 8 px breathing gap when
	 * the strip is rendered. */
	private _getBottomButtonOffsetPx(): number {
		const baseOffsetPx = 16;
		const stripGapPx = this._pillStripHeight > 0 ? this._pillStripHeight + 8 : 0;
		return baseOffsetPx + stripGapPx;
	}

	private _renderJumpToBottom() {
		const show = this._showJumpToBottom;
		const bottomPx = this._getBottomButtonOffsetPx();
		if (this._showSplitBottom) {
			// Split layout: one rounded-full pill, two inner buttons separated
			// by a vertical divider. Each half is independently clickable +
			// focusable. Each button carries its own inline opacity so tests
			// (and AT trees) can query either half consistently with the
			// single-button rendering.
			const btnStyle = `opacity:${show ? "1" : "0"};pointer-events:${show ? "auto" : "none"};transition:opacity 150ms ease-out`;
			return html`
				<div
					data-testid="jump-to-bottom-split"
					class="absolute left-1/2 -translate-x-1/2 z-10 inline-flex items-stretch rounded-full bg-background border border-input shadow-sm whitespace-nowrap overflow-hidden"
					style="bottom:${bottomPx}px;opacity:${show ? "1" : "0"};pointer-events:${show ? "auto" : "none"};transition:opacity 150ms ease-out, bottom 150ms ease-out"
				>
					<button
						type="button"
						data-testid="jump-to-next-prompt"
						aria-label="Jump to next prompt"
						class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs hover:bg-muted text-foreground"
						style=${btnStyle}
						tabindex="${show ? "0" : "-1"}"
						@click=${this._handleJumpToNextPromptClick}
					>
						${icon(ArrowDown, "sm")}
						<span>Next prompt</span>
					</button>
					<button
						type="button"
						data-testid="jump-to-bottom"
						aria-label="Jump to bottom"
						class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs hover:bg-muted text-foreground border-l border-input"
						style=${btnStyle}
						tabindex="${show ? "0" : "-1"}"
						@click=${this._handleJumpToBottomClick}
					>
						${icon(ChevronsDown, "sm")}
						<span>Bottom</span>
					</button>
				</div>
			`;
		}
		return html`
			<button
				type="button"
				data-testid="jump-to-bottom"
				aria-label="Jump to bottom"
				class="absolute left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full bg-background hover:bg-muted text-foreground border border-input shadow-sm whitespace-nowrap"
				style="bottom:${bottomPx}px;opacity:${show ? "1" : "0"};pointer-events:${show ? "auto" : "none"};transition:opacity 150ms ease-out, bottom 150ms ease-out"
				tabindex="${show ? "0" : "-1"}"
				@click=${this._handleJumpToBottomClick}
			>
				${icon(ArrowDown, "sm")}
				<span>Jump to bottom</span>
			</button>
		`;
	}

	private async _handlePrMerge(e: CustomEvent<{ method: string; admin?: boolean; branch?: string }>): Promise<void> {
		if (!this.onPrMerge) return;
		const widget = e.target as import('./GitStatusWidget.js').GitStatusWidget;
		try {
			const error = await this.onPrMerge(e.detail.method, e.detail.admin, e.detail.branch);
			widget.setMergeResult(error);
		} catch (err) {
			widget.setMergeResult(err instanceof Error ? err.message : 'Network error');
		}
	}

	private _handleGitFetch(): void {
		this.onGitFetch?.();
	}

	private async _handleGitPush(e: Event): Promise<void> {
		if (!this.onGitPush) return;
		const widget = e.target as import('./GitStatusWidget.js').GitStatusWidget;
		try {
			const error = await this.onGitPush();
			widget.setPushResult(error);
		} catch (err) {
			widget.setPushResult(err instanceof Error ? err.message : 'Network error');
		}
	}

	private async _handleGitPull(e: Event): Promise<void> {
		if (!this.onGitPull) return;
		const widget = e.target as import('./GitStatusWidget.js').GitStatusWidget;
		try {
			const error = await this.onGitPull();
			widget.setPullResult(error);
		} catch (err) {
			widget.setPullResult(err instanceof Error ? err.message : 'Network error');
		}
	}

	private async _handleGitMergePrimary(e: Event): Promise<void> {
		if (!this.onGitMergePrimary) return;
		const widget = e.target as import('./GitStatusWidget.js').GitStatusWidget;
		try {
			const error = await this.onGitMergePrimary();
			widget.setMergePrimaryResult(error);
		} catch (err) {
			widget.setMergePrimaryResult(err instanceof Error ? err.message : 'Network error');
		}
	}

	private async _handleGitSquashPush(e: Event): Promise<void> {
		if (!this.onGitSquashPush) return;
		const widget = e.target as import('./GitStatusWidget.js').GitStatusWidget;
		try {
			const error = await this.onGitSquashPush();
			widget.setSquashPushResult(error);
		} catch (err) {
			widget.setSquashPushResult(err instanceof Error ? err.message : 'Network error');
		}
	}

	private _handleAskAgentCommit(): void {
		this.onAskAgentCommit?.();
	}

	private _handleAskAgentPr(): void {
		this.onAskAgentPr?.();
	}

	// Glow effect now lives on the real pill content layer via a CSS
	// `filter: drop-shadow()` set inline in the render template. The previous
	// parallel-render approach used hidden placeholder pills with box-shadow
	// to fake the glow but the placeholders couldn't match the real shapes
	// (e.g. git-status-widget's PR badges + unpushed dots) so the layers
	// drifted apart on mobile when flex-wrap kicked in.

	// --- Pill overflow collapsing & animation ---

	/**
	 * Sort processes by startTime ascending (oldest first).
	 * Visible = newest N, Hidden = oldest (total - N).
	 */
	private _getSortedProcesses(): BgProcessInfo[] {
		return [...this.bgProcesses].sort((a, b) => a.startTime - b.startTime);
	}

	private _renderPillStrip() {
		const sorted = this._getSortedProcesses();
		if (sorted.length === 0) return nothing;

		const count = Math.min(this._visiblePillCount, sorted.length);
		// Ensure at least 1 pill is always visible; never show "1 more" — show the pill instead
		let visibleCount = Math.max(1, count);
		let hiddenCount = sorted.length - visibleCount;
		if (hiddenCount === 1) { visibleCount++; hiddenCount = 0; }
		const hidden = sorted.slice(0, hiddenCount);
		const visible = sorted.slice(hiddenCount);

		return html`
			<style>
				@keyframes pill-fade-out {
					0%   { opacity: 1; transform: scale(1) translateX(0); filter: blur(0); }
					50%  { opacity: 0.5; transform: scale(0.85) translateX(4px); filter: blur(1px); }
					100% { opacity: 0; transform: scale(0.6) translateX(12px); filter: blur(2px); }
				}
				@keyframes pill-slide-in {
					0%   { opacity: 0; transform: translateY(8px) scale(0.8); filter: blur(2px); }
					60%  { opacity: 1; transform: translateY(-2px) scale(1.03); filter: blur(0); }
					100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
				}
				.pill-dismissing {
					animation: pill-fade-out 300ms cubic-bezier(0.4, 0, 1, 1) forwards;
					pointer-events: none;
				}
				.pill-promoted {
					animation: pill-slide-in 350ms cubic-bezier(0.175, 0.885, 0.32, 1.275);
				}
				@keyframes popover-in {
					0%   { opacity: 0; transform: translateY(8px) scale(0.92); filter: blur(3px); }
					70%  { opacity: 1; transform: translateY(-1px) scale(1.005); filter: blur(0); }
					100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
				}
				.pill-more-popover {
					animation: popover-in 300ms cubic-bezier(0.175, 0.885, 0.32, 1.275);
				}
			</style>
			${hidden.length > 0 ? html`
				<div class="relative" style="display:inline-flex;align-items:center;position:relative;flex-shrink:0;height:var(--pill-h, auto);line-height:1;vertical-align:middle">
					<span class="inline-flex items-center rounded-full bg-card border border-border text-[12px] leading-tight whitespace-nowrap" data-more-btn style="box-sizing:border-box;height:var(--pill-h, auto)">
						<button
							class="inline-flex items-center gap-1 px-1.5 py-0.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer font-mono rounded-l-full whitespace-nowrap"
							@click=${this._toggleMore}
							aria-expanded=${this._moreExpanded}
							aria-haspopup="true"
							title="Show ${hidden.length} more background process${hidden.length > 1 ? 'es' : ''}"
						>
							<span>${hidden.length} more</span>
						</button>
						<button
							class="inline-flex items-center justify-center px-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer rounded-r-full border-l border-border"
							style="min-width:16px; align-self:stretch"
							@click=${this._toggleMore}
							title="Show ${hidden.length} more background process${hidden.length > 1 ? 'es' : ''}"
						><svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block${this._moreExpanded ? ';transform:rotate(180deg)' : ''}"><path d="M1.5 5.5L4 3L6.5 5.5"/></svg></button>
					</span>
					${this._moreExpanded ? html`
						<div class="absolute bottom-full z-50 flex flex-col items-start gap-1 pill-more-popover" style="left:-8px; min-width:max-content; padding:14px; margin:-8px; margin-bottom:-7px; backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); --m:linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent), linear-gradient(to bottom, transparent, black 14px, black calc(100% - 14px), transparent); -webkit-mask-image:var(--m); mask-image:var(--m); -webkit-mask-composite:destination-in; mask-composite:intersect">
							${hidden.map((p) => html`
								<bg-process-pill
									data-id="${p.id}"
									.process=${p}
									.sessionId=${this.session?.sessionId ?? ''}
									.onKill=${this.onBgProcessKill}
									.onDismiss=${this._handlePillDismiss}
								></bg-process-pill>
							`)}
						</div>
					` : nothing}
				</div>
			` : nothing}
			${visible.map((p) => {
				const isDismissing = this._dismissingId === p.id;
				const isPromoted = this._promotedIds.has(p.id);
				const cls = isDismissing ? 'pill-dismissing' : isPromoted ? 'pill-promoted' : '';
				return html`
					<div
						class="${cls}"
						style="display:inline-flex;align-items:center"
						@animationend=${(e: AnimationEvent) => this._handlePillAnimationEnd(e, p.id)}
					>
						<bg-process-pill
							data-id="${p.id}"
							.process=${p}
							.sessionId=${this.session?.sessionId ?? ''}
							.onKill=${this.onBgProcessKill}
							.onDismiss=${this._handlePillDismiss}
						></bg-process-pill>
					</div>
				`;
			})}
		`;
	}

	private _toggleMore = (e: MouseEvent) => {
		e.stopPropagation();
		this._moreExpanded = !this._moreExpanded;
		this.requestUpdate();
		if (this._moreExpanded) {
			// Defer adding click-outside so this click doesn't immediately close it
			requestAnimationFrame(() => {
				document.addEventListener("click", this._handleMoreClickOutside, true);
			});
		} else {
			document.removeEventListener("click", this._handleMoreClickOutside, true);
		}
	};

	private _handleMoreClickOutside = (e: MouseEvent) => {
		// Check if click is inside the "More" popover or its toggle button
		const target = e.target as Node;
		const moreContainer = this.querySelector('.pill-more-popover');
		const moreBtn = moreContainer?.parentElement?.querySelector('button');
		if (moreContainer?.contains(target) || moreBtn?.contains(target)) return;
		this._moreExpanded = false;
		this.requestUpdate();
		document.removeEventListener("click", this._handleMoreClickOutside, true);
	};

	private _handlePillDismiss = (id: string) => {
		if (!this._pillsInitialized) {
			// Not yet initialized — just dismiss directly
			this.onBgProcessDismiss?.(id);
			return;
		}

		// Figure out which pill will be promoted (become newly visible) after removal
		const sorted = this._getSortedProcesses();
		const count = Math.min(this._visiblePillCount, sorted.length);
		let visibleCount = Math.max(1, count);
		let hiddenCount = sorted.length - visibleCount;
		// Apply the same "never show 1 more" adjustment as _renderPillStrip
		if (hiddenCount === 1) { visibleCount++; hiddenCount = 0; }

		// Check if the pill is in the hidden (popover) set — no animation wrapper there
		if (hiddenCount > 0) {
			const hiddenIds = new Set(sorted.slice(0, hiddenCount).map(p => p.id));
			if (hiddenIds.has(id)) {
				// Pill is in the "More" popover — dismiss directly, no animation
				this.onBgProcessDismiss?.(id);
				requestAnimationFrame(() => this._measurePillOverflow());
				return;
			}
		}

		// After removing this pill, the first hidden pill may become visible
		if (hiddenCount > 0) {
			// The hidden pills are sorted[0..hiddenCount-1].
			// The last hidden one (sorted[hiddenCount-1]) will be promoted if the
			// dismissed pill is in the visible set.
			const visibleIds = new Set(sorted.slice(hiddenCount).map(p => p.id));
			if (visibleIds.has(id)) {
				const promotedPill = sorted[hiddenCount - 1];
				this._promotedIds.add(promotedPill.id);
			}
		}

		// Start dismiss animation
		this._dismissingId = id;
		this.requestUpdate();
	};

	private _handlePillAnimationEnd = (e: AnimationEvent, id: string) => {
		if (e.animationName === 'pill-fade-out' && this._dismissingId === id) {
			this._dismissingId = null;
			this.onBgProcessDismiss?.(id);
			// Recalculate overflow after removal
			requestAnimationFrame(() => this._measurePillOverflow());
		}
		if (e.animationName === 'pill-slide-in') {
			this._promotedIds.delete(id);
		}
	};

	/**
	 * Measure pill container vs parent and compute how many pills fit.
	 *
	 * Bugs this guards against:
	 * 1. Stale-cached widths: pills hidden inside the "more" popover aren't
	 *    in the strip's flex flow. We cache last-measured widths so the
	 *    algorithm can grow the visible count back when space opens up
	 *    (resize, pill dismissal, git-widget shrinking) — not just shrink it.
	 * 2. Available-width underestimate: the strip's actual CSS constraint is
	 *    `max-width: calc(100% - 1rem)`, not 75% of the parent.
	 * 3. Child re-layout races: when the bg-process-pill custom element
	 *    hasn't finished its own render cycle, its wrapper offsetWidth can be
	 *    near zero. We refuse to commit cache entries for zero-width pills.
	 */
	private _measurePillOverflow() {
		const parentContainer = this.querySelector('[data-input-container]') as HTMLElement;
		if (!parentContainer) return;

		const pillStrip = this.querySelector('[data-pill-strip]') as HTMLElement;
		if (!pillStrip) return;

		const contentLayer = pillStrip.querySelector('[data-pill-content]') as HTMLElement;
		if (!contentLayer) return;

		const gap = 6; // gap-1.5 = 0.375rem ≈ 6px

		// Total horizontal budget for pills + "more" + git-widget. Two modes:
		//   Wide (>=640px host): strip CSS uses `max-width: calc(100% - 8rem)`.
		//     Pill row is one line; algorithm packs content into
		//     `parent.clientWidth - 128 - 2`. The 7.5rem left reserve (120px)
		//     keeps the leftmost pill clear of the bobbit sprite that bleeds
		//     down from the message area.
		//   Narrow (<640px, portrait/mobile): strip CSS uses `max-width: 75%`.
		//     Pills wrap onto up to TWO rows (content layer is `flex-wrap`),
		//     so the algorithm budget is `1.85 * (parent.clientWidth * 0.75)`.
		//     The 1.85 factor (not 2.0) carries a worst-case-slack margin:
		//     flex-wrap wraps whole items, so when items don't pack tight
		//     each row leaves a little unused width. A flat * 2 budget can
		//     authorise content that overflows to a third row on cusp cases
		//     where item widths differ — e.g. three items at 60 %, 60 %, 60 %
		//     of the row each: total 180 % ≤ 2 * 100 % but only 1 item fits
		//     per row, so 3 rows render. 1.85 buys back ~15 % of slack
		//     headroom; content beyond that goes into "more" as intended.
		//     The 25 % on the left stays clear for the bobbit sprite.
		// Extra 2px is a safety margin for rounding/drop-shadow.
		let maxWidth = this._isNarrow
			? parentContainer.clientWidth * 0.75 * 1.85 - 2
			: parentContainer.clientWidth - 128 - 2;

		// Subtract git-status-widget width from available space.
		const gitWidget = contentLayer.querySelector('git-status-widget') as HTMLElement;
		if (gitWidget) {
			const gw = gitWidget.offsetWidth;
			if (gw > 0) maxWidth -= gw + gap;
		}
		// Subtract goal-status-widget width from available space (mirrors git widget).
		const goalWidget = contentLayer.querySelector('goal-status-widget') as HTMLElement;
		if (goalWidget) {
			const gow = goalWidget.offsetWidth;
			if (gow > 0) maxWidth -= gow + gap;
		}

		// Refresh the per-id width cache from every bg-process-pill currently
		// in the DOM — covers both the visible strip and the expanded popover.
		//
		// We measure the bg-process-pill custom element's own offsetWidth
		// (NOT its parent's). In the visible strip the wrapper <div> is one
		// per pill so parent-width happens to equal pill-width; but in the
		// "more" popover every hidden pill shares the same parent (the
		// `.pill-more-popover` flex-column container), so parent.offsetWidth
		// would be the popover's own width — dramatically larger than any
		// real pill — and writing that to the cache prevents promotion back
		// into the strip when space frees up.
		// Two further subtleties:
		//   1. The popover container itself uses `items-start` (flex
		//      align-items:flex-start), so individual `inline-flex` pill
		//      hosts inside it are NOT stretched to the popover's content-
		//      box width — each pill keeps its intrinsic width. Without that
		//      class the default `align-items:stretch` would size every
		//      popover pill to max(intrinsic widths), inflating the cache.
		//   2. The pill's render() roots in `<span class="inline-flex …">`
		//      so the custom element's own `offsetWidth` reflects that span's
		//      rendered width in both contexts.
		const allPillEls = pillStrip.querySelectorAll('bg-process-pill');
		for (const pillEl of allPillEls) {
			const id = pillEl.getAttribute('data-id');
			if (!id) continue;
			const measured = (pillEl as HTMLElement).offsetWidth;
			if (measured > 0) {
				this._pillWidths.set(id, measured);
			}
		}

		// Drop cache entries for pills no longer in bgProcesses.
		const sorted = this._getSortedProcesses();
		const liveIds = new Set(sorted.map((p) => p.id));
		for (const id of Array.from(this._pillWidths.keys())) {
			if (!liveIds.has(id)) this._pillWidths.delete(id);
		}

		if (sorted.length === 0) {
			this._visiblePillCount = Infinity;
			return;
		}

		// Default estimate for never-measured pills (e.g. just appeared
		// before their first paint). The next measure pass will replace it.
		const DEFAULT_PILL_WIDTH = 100;
		const widths = sorted.map((p) => this._pillWidths.get(p.id) ?? DEFAULT_PILL_WIDTH);

		// "more" button is ~60px when shown.
		const moreBtnWidth = 60;

		// Count from right (newest) how many pills fit.
		let fitCount = 0;
		let usedWidth = 0;
		for (let i = widths.length - 1; i >= 0; i--) {
			const needed = widths[i] + (fitCount > 0 ? gap : 0);
			const wouldNeedMore = i > 0; // still have pills to hide
			const reserveForMore = wouldNeedMore ? moreBtnWidth + gap : 0;
			if (usedWidth + needed + reserveForMore <= maxWidth) {
				usedWidth += needed;
				fitCount++;
			} else {
				break;
			}
		}

		// At least 1 pill must be visible.
		const newCount = Math.max(1, fitCount);
		if (newCount !== this._visiblePillCount) {
			this._visiblePillCount = newCount;
			this.requestUpdate();
		}

		if (!this._pillsInitialized) {
			this._pillsInitialized = true;
		}
	}

	/**
	 * Schedule a re-measure on the next animation frame, coalescing
	 * multiple calls within the same tick into one.
	 */
	private _scheduleMeasurePillOverflow() {
		if (this._measureScheduled) return;
		this._measureScheduled = true;
		requestAnimationFrame(() => {
			this._measureScheduled = false;
			this._measurePillOverflow();
		});
	}

	override updated(changedProperties: Map<string, any>) {
		super.updated(changedProperties);

		// Narrow-only: rewrite the thinking-selector trigger label to an abbreviation.
		// The Select component reuses option.label for both the trigger and the popover
		// items, so we keep options on full labels and only retarget the trigger's
		// visible text node here. Re-runs on every render and on host-width changes
		// (which call requestUpdate via the ResizeObserver in _updateNarrow).
		this._syncThinkingTriggerLabel();

		// Setup pill overflow observer once the pill strip is rendered
		if (this.bgProcesses.length > 0) {
			const pillStrip = this.querySelector('[data-pill-strip]') as HTMLElement;
			if (pillStrip && !this._pillResizeObserver) {
				this._pillResizeObserver = new ResizeObserver(() => {
					this._scheduleMeasurePillOverflow();
				});
				// Observe the input container for size changes (host width changes,
				// virtual keyboard, side panel toggles).
				const parent = this.querySelector('[data-input-container]') as HTMLElement;
				if (parent) this._pillResizeObserver.observe(parent);
				// Also observe the content layer — picks up child re-layouts the
				// parent observer misses (git-status-widget badges appearing,
				// bg-process-pill children doing their first paint, font changes).
				const contentLayer = pillStrip.querySelector('[data-pill-content]') as HTMLElement | null;
				if (contentLayer) this._pillResizeObserver.observe(contentLayer);
				const gitWidget = pillStrip.querySelector('git-status-widget') as HTMLElement | null;
				if (gitWidget) this._pillResizeObserver.observe(gitWidget);
				const goalWidget = pillStrip.querySelector('goal-status-widget') as HTMLElement | null;
				if (goalWidget) this._pillResizeObserver.observe(goalWidget);
			}
			// Measure after renders that change pill count or visible set.
			if (changedProperties.has('bgProcesses') || changedProperties.has('_moreExpanded')) {
				this._scheduleMeasurePillOverflow();
			}


		} else {
			// No pills — reset
			this._visiblePillCount = Infinity;
			this._moreExpanded = false;
			this._pillsInitialized = false;
			this._pillWidths.clear();
			if (this._pillResizeObserver) {
				this._pillResizeObserver.disconnect();
				this._pillResizeObserver = undefined;
			}
		}

		// Track pill-strip height so the jump-to-bottom button can sit above it.
		// The strip wraps to multiple rows on mobile when stacked bash_bg pills
		// don't fit — we want the button to lift correspondingly.
		const stripEl = this.querySelector('[data-pill-strip]') as HTMLElement | null;
		if (stripEl) {
			if (!this._pillStripObserver) {
				this._pillStripObserver = new ResizeObserver((entries) => {
					const h = entries[0]?.contentRect?.height ?? 0;
					if (Math.abs(h - this._pillStripHeight) >= 1) {
						this._pillStripHeight = h;
					}
				});
			}
			this._pillStripObserver.observe(stripEl);
			// Also pick up the initial height synchronously — RO fires async.
			const h = stripEl.offsetHeight;
			if (Math.abs(h - this._pillStripHeight) >= 1) this._pillStripHeight = h;
		} else {
			if (this._pillStripHeight !== 0) this._pillStripHeight = 0;
			if (this._pillStripObserver) {
				this._pillStripObserver.disconnect();
				this._pillStripObserver = undefined;
			}
		}
	}

	private _syncThinkingTriggerLabel() {
		const host = this.querySelector('.thinking-select-compact');
		if (!host) return;
		const labelSpan = host.querySelector('button > span') as HTMLElement | null;
		if (!labelSpan) return;
		const level = (this.session?.state?.thinkingLevel as string | undefined) ?? "off";
		const abbrev: Record<string, string> = { off: "Off", minimal: "Min", low: "Low", medium: "Med", high: "Hi", xhigh: "XHi", max: "Max" };
		const full: Record<string, string> = { off: i18n("Off"), minimal: i18n("Minimal"), low: i18n("Low"), medium: i18n("Medium"), high: i18n("High"), xhigh: i18n("Extra high"), max: i18n("Max") };
		const desired = this._isNarrow ? (abbrev[level] ?? abbrev.off) : (full[level] ?? full.off);
		// The label span contains: whitespace text nodes (from Lit template formatting),
		// an icon <span>, and the label text node. We want to update only the label —
		// i.e. the last text node containing non-whitespace content. Updating the first
		// text node (whitespace before the icon) was the bug that caused the abbreviated
		// label to appear to the left of the brain icon.
		let textNode: Text | null = null;
		for (const node of Array.from(labelSpan.childNodes)) {
			if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "") {
				textNode = node as Text;
			}
		}
		if (textNode) {
			if (textNode.textContent !== desired) textNode.textContent = desired;
		} else {
			labelSpan.appendChild(document.createTextNode(desired));
		}
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
