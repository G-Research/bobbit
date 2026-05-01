import { icon } from "@mariozechner/mini-lit";
import { isAskResponseEnvelope } from "../../shared/ask-envelope.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { streamSimple, type ToolResultMessage, type Usage } from "@mariozechner/pi-ai";
import { html, LitElement, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { ArrowDown, Brain, Image as ImageIcon, Sparkles } from "lucide";
import { ModelSelector } from "../dialogs/ModelSelector.js";
import { ImageModelSelector } from "../dialogs/ImageModelSelector.js";
import type { MessageEditor } from "./MessageEditor.js";
import "./MessageEditor.js";
import "./MessageList.js";
import "./GitStatusWidget.js";
import "./BgProcessPill.js";
import type { BgProcessInfo } from "./BgProcessPill.js";
import "./Messages.js"; // Import for side effects to register the custom elements
import "./CostPopover.js";
import { getAppStorage } from "../storage/app-storage.js";
import "./StreamingMessageContainer.js";
import "./ContinueSessionChooser.js";
import { estimateTranscriptBytes } from "./ContinueSessionChooser.js";
import { state as appState } from "../../app/state.js";
import { gatewayFetch } from "../../app/api.js";
import { setHashRoute } from "../../app/routing.js";
import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Attachment } from "../utils/attachment-utils.js";
import { formatCost, formatTokenCount, formatModelCost } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { createStreamFn } from "../utils/proxy-utils.js";
import type { UserMessageWithAttachments } from "./Messages.js";
import type { StreamingMessageContainer } from "./StreamingMessageContainer.js";

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
		isOnPrimary: boolean;
		summary: string;
		clean: boolean;
		hasUpstream: boolean;
		ahead: number;
		behind: number;
		aheadOfPrimary: number;
		behindPrimary: number;
		mergedIntoPrimary: boolean;
		unpushed: boolean;
		status: Array<{ file: string; status: string }>;
	};
	@property({ type: Boolean }) gitStatusLoading = false;
	/** Tri-state repo detection — widget renders whenever this is not 'no'.
	 *  Only flipped to 'no' on explicit HTTP 400 "Not a git repository". */
	@property({ attribute: false }) gitRepoKnown: 'yes' | 'no' | 'unknown' = 'unknown';
	/** True when the server returned Phase A data but porcelain timed out. */
	@property({ type: Boolean }) partial = false;
	// PR status properties for goal-linked sessions
	@property() prState?: string;
	@property() prUrl?: string;
	@property({ type: Number }) prNumber?: number;
	@property() prTitle?: string;
	@property() prMergeable?: string;
	@property({ type: Boolean }) viewerIsAdmin?: boolean;
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
		if (!this.readOnly) return false;
		// These fields live on the REST PersistedSession — threaded via
		// session-manager's connectToSession, not on the remote-agent _state.
		if (this.goalId) return false;
		if (this.delegateOf) return false;
		if (this.assistantType) return false;
		if (this.teamGoalId) return false;
		if (!this.projectId) return false;
		const known = appState?.projects?.some((p: any) => p.id === this.projectId);
		return !!known;
	}

	private async _openContinueChooser() {
		const chooser = document.createElement("continue-session-chooser") as any;
		chooser.sessionId = this.session?.sessionId ?? "";
		chooser.messageCount = this.session?.state?.messages?.length ?? 0;
		chooser.transcriptBytes = estimateTranscriptBytes(this.session?.state);
		document.body.appendChild(chooser);

		const cleanup = () => {
			if (chooser.parentElement) chooser.parentElement.removeChild(chooser);
		};

		chooser.addEventListener("cancel", () => cleanup());
		chooser.addEventListener("continue", async (e: Event) => {
			const { mode } = (e as CustomEvent).detail || {};
			cleanup();
			const archivedId = this.session?.sessionId;
			if (!archivedId) return;
			try {
				const resp = await gatewayFetch(`/api/sessions/${archivedId}/continue`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ mode }),
				});
				if (!resp.ok) {
					const text = await resp.text().catch(() => "");
					console.error("Continue in new session failed:", resp.status, text);
					this._showContinueError(`Failed to continue (${resp.status}): ${text || resp.statusText}`);
					return;
				}
				const data = await resp.json();
				const id = data?.id;
				if (!id) {
					this._showContinueError("Server returned no session id");
					return;
				}
				setHashRoute("session", id);
				window.dispatchEvent(new CustomEvent("focus-editor"));
			} catch (err) {
				console.error("Continue in new session threw:", err);
				this._showContinueError(String(err));
			}
		});
	}

	private _showContinueError(message: string) {
		const host = document.createElement("div");
		host.setAttribute("data-continue-error", "");
		host.style.cssText =
			"position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;padding:10px 14px;border-radius:6px;font-size:13px;max-width:90vw;background:var(--destructive,#b91c1c);color:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.2);";
		host.textContent = message;
		document.body.appendChild(host);
		setTimeout(() => {
			if (host.parentElement) host.parentElement.removeChild(host);
		}, 5000);
	}

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _contextPopoverOpen = false;
	private _costPopoverOpen = false;
	private _stickToBottom = true;
	// Deterministic programmatic-scroll detection: when we set scrollTop
	// programmatically, capture the resulting (scrollTop, scrollHeight) pair.
	// The next scroll event matching exactly that pair is the browser-emitted
	// echo of our own assignment and is ignored. Cleared on first match so a
	// later coincidental match still counts as a real user scroll. No timers.
	private _lastProgrammaticScrollTop: number | null = null;
	private _lastProgrammaticScrollHeight: number | null = null;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _lastScrollHeight = 0;

	// Change 3 — `wasAtBottom` carry-over for `state_update`.
	// Captures the pre-recompute value of `_stickToBottom` at every non-echo
	// scroll event. Consulted by the `state_update` branch so a transient
	// scroll-up that flips `_stickToBottom` false right before a server-driven
	// state refresh still re-anchors to the bottom. Reset on explicit user
	// intent (`_handleUserIntent`/`_handleScrollKeydown`).
	private _wasAtBottomAtLastUserScroll = true;

	// Change 4 — session-load settle window. While active, the ResizeObserver
	// re-asserts `_scrollToBottom()` on every tick (capped at 2 s, exits early
	// on stable scrollHeight or user-intent). Re-armed on every
	// `setupSessionSubscription` call.
	private _settleWindowActive = false;
	private _settleWindowDeadline = 0;
	private _lastSettleScrollHeight = -1;
	// Counts consecutive ResizeObserver ticks where scrollHeight has been
	// stable AND we re-pinned successfully. The window exits early once we
	// hit two such ticks, but width-only reflows / no-op ticks no longer
	// short-circuit it (the previous logic exited as soon as two ticks
	// reported the same height, which fired before any real growth).
	private _settleQuietTickCount = 0;

	// Change 5 — Jump-to-bottom button visibility. True when the viewport is
	// more than half a screen from the bottom. Recomputed in `_handleScroll`.
	private _showJumpToBottom = false;
	// Timestamp (performance.now ms) until which `_handleScroll` must NOT
	// re-show the jump button. Set when the user clicks the button so the
	// echo of the programmatic scroll — plus any content-growth race during
	// the subsequent re-render — can't briefly flip _showJumpToBottom back
	// to true before _scrollToBottom's rAF re-pins the bottom.
	private _suppressJumpUntilTs = 0;

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
	/** ID of a pill currently animating out */
	private _dismissingId: string | null = null;
	/** IDs of pills promoted from hidden to visible (animate in) */
	private _promotedIds: Set<string> = new Set();
	/** Whether initial render is done (skip animations on first paint) */
	private _pillsInitialized = false;
	private _unsubscribeSession?: () => void;

	// Tracks viewport <640px (Tailwind sm breakpoint) for mobile-only label abbreviation.
	private _isMobileViewport = typeof window !== "undefined" && typeof window.matchMedia === "function"
		? !window.matchMedia("(min-width: 640px)").matches
		: false;
	private _mobileMediaQuery?: MediaQueryList;
	private _handleMobileMediaChange = (e: MediaQueryListEvent) => {
		const next = !e.matches;
		if (next !== this._isMobileViewport) {
			this._isMobileViewport = next;
			this.requestUpdate();
		}
	};
	// Server-authoritative queue state, updated via onQueueUpdate callback
	private _serverQueue: Array<{ id: string; text: string; isSteered: boolean; createdAt: number; images?: any[]; attachments?: any[] }> = [];
	private _cachedToolResults?: Map<string, ToolResultMessage>;
	private _cachedMessagesRef?: AgentMessage[];

	public setInput(text: string, attachments?: Attachment[]) {
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = attachments || [];
			}
		};
		update();
	}

	public setAutoScroll(enabled: boolean) {
		this._stickToBottom = enabled;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);

		// Re-subscribe when session property changes
		if (changedProperties.has("session")) {
			this.setupSessionSubscription();
		}
	}

	override async connectedCallback() {
		super.connectedCallback();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			this._lastScrollHeight = this._scrollContainer.scrollHeight;

			// When content changes size, scroll to bottom if we're already there.
			// Uses _stickToBottom flag — no keyboard/focus/viewport tracking needed.
			// Programmatic-scroll echoes are filtered deterministically in
			// _handleScroll via the (_lastProgrammaticScrollTop, _lastProgrammaticScrollHeight)
			// latch — no timers.
			this._resizeObserver = new ResizeObserver(() => {
				if (!this._scrollContainer) return;
				const newScrollHeight = this._scrollContainer.scrollHeight;
				const delta = newScrollHeight - this._lastScrollHeight;

				// Change 4 — session-load settle window. Re-assert bottom on every
				// tick while active. Exit on deadline, stable height across two
				// consecutive ticks, or user intent (handled elsewhere).
				if (this._settleWindowActive) {
					if (performance.now() > this._settleWindowDeadline) {
						this._settleWindowActive = false;
						this._settleQuietTickCount = 0;
					} else if (this._lastSettleScrollHeight === newScrollHeight) {
						// Same height as last tick — stable. Re-pin (defensively) and
						// require two consecutive stable ticks before exiting so a
						// width-only reflow followed by real growth doesn't fool us.
						if (this._stickToBottom) {
							this._scrollToBottom();
							this._lastScrollHeight = newScrollHeight;
						}
						this._settleQuietTickCount++;
						if (this._settleQuietTickCount >= 2) {
							this._settleWindowActive = false;
							this._settleQuietTickCount = 0;
						}
						return;
					} else {
						// Height changed — reset quiet-tick counter and re-pin.
						this._lastSettleScrollHeight = newScrollHeight;
						this._settleQuietTickCount = 0;
						if (this._stickToBottom) {
							this._scrollToBottom();
							this._lastScrollHeight = newScrollHeight;
							return;
						}
					}
				}

				if (delta < 0) {
					// Content shrunk (collapse) — apply post-collapse clamp.
					// Let the browser naturally adjust scrollTop, then check:
					// if bottom of content is above the viewport midpoint, scroll
					// so latest message is at the bottom of the viewport.
					this._lastScrollHeight = newScrollHeight;
					const { scrollTop, clientHeight } = this._scrollContainer;
					const contentBottom = newScrollHeight - scrollTop;
					if (contentBottom < clientHeight / 2) {
						const target = newScrollHeight - clientHeight;
						this._lastProgrammaticScrollTop = target;
						this._lastProgrammaticScrollHeight = newScrollHeight;
						this._scrollContainer.scrollTop = target;
					}
					return;
				}

				if (delta === 0) {
					// No actual height change — width/border-box reflow only.
					// Do nothing. Don't touch scrollTop, don't update
					// _lastScrollHeight (it's already accurate), don't flip
					// _stickToBottom. This is the fix for the vibration loop.
					return;
				}

				// delta > 0: real growth.
				if (this._stickToBottom) {
					this._lastScrollHeight = newScrollHeight;
					const target = newScrollHeight - this._scrollContainer.clientHeight;
					this._lastProgrammaticScrollTop = target;
					this._lastProgrammaticScrollHeight = newScrollHeight;
					this._scrollContainer.scrollTop = newScrollHeight;
				} else {
					this._lastScrollHeight = newScrollHeight;
				}
			});

			const contentContainer = this._scrollContainer.querySelector(".max-w-5xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Track user scroll to decide stick-to-bottom state
			this._scrollContainer.addEventListener("scroll", this._handleScroll, { passive: true });
			// Explicit user-intent listeners — any of these immediately
			// unsticks. Geometry alone can't reliably distinguish a user
			// scroll-up from a programmatic scroll, so we trust intent.
			this._scrollContainer.addEventListener("wheel", this._handleUserIntent, { passive: true });
			this._scrollContainer.addEventListener("touchstart", this._handleUserIntent, { passive: true });
			this._scrollContainer.addEventListener("keydown", this._handleScrollKeydown);
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();

		// Track viewport for mobile-only label abbreviation in the thinking selector.
		if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
			this._mobileMediaQuery = window.matchMedia("(min-width: 640px)");
			this._isMobileViewport = !this._mobileMediaQuery.matches;
			this._mobileMediaQuery.addEventListener("change", this._handleMobileMediaChange);
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Change 4 — tear down settle window state alongside other observers.
		this._settleWindowActive = false;
		this._settleWindowDeadline = 0;
		this._lastSettleScrollHeight = -1;

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
		}

		if (this._pillResizeObserver) {
			this._pillResizeObserver.disconnect();
			this._pillResizeObserver = undefined;
		}

		if (this._mobileMediaQuery) {
			this._mobileMediaQuery.removeEventListener("change", this._handleMobileMediaChange);
			this._mobileMediaQuery = undefined;
		}

		document.removeEventListener("click", this._handleMoreClickOutside, true);

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
		this._stickToBottom = true;
		this._wasAtBottomAtLastUserScroll = true;
		if (this._showJumpToBottom) {
			this._showJumpToBottom = false;
			// _showJumpToBottom isn't @state(), so mutating it doesn't trigger a
			// re-render on its own. _handleScroll calls requestUpdate() after
			// changing it, but on session navigate we may never get a scroll
			// event (e.g. short session that already fits in the viewport),
			// so the stale `true` from the previous session would linger.
			this.requestUpdate();
		}
		// Re-pin to the bottom across multiple frames. updateComplete only
		// awaits Lit's first render — async content (lazy markdown, syntax
		// highlighting, image dimensions, hydrated tool-content blocks) lands
		// over subsequent frames, growing scrollHeight after our initial pin.
		// Three rAF passes catch the common cases without the cost of a long
		// timer; the ResizeObserver settle window below is the safety net for
		// later growth.
		this.updateComplete.then(() => {
			this._scrollToBottom();
			requestAnimationFrame(() => {
				this._scrollToBottom();
				requestAnimationFrame(() => this._scrollToBottom());
			});
		});

		// Change 4 — arm the settle window for this session load. Bumped to
		// 3 s (was 2 s) and the early-exit condition tightened in the observer
		// to require two consecutive *quiet* ticks rather than two same-height
		// ticks (a width-only reflow + a growth tick used to close the window
		// prematurely on session navigate).
		this._settleWindowActive = true;
		this._settleWindowDeadline = performance.now() + 3000;
		this._lastSettleScrollHeight = -1;
		this._settleQuietTickCount = 0;

		// Set default streamFn with proxy support if not already set
		if (this.session.streamFn === streamSimple) {
			this.session.streamFn = createStreamFn(async () => {
				const enabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
				return enabled ? (await getAppStorage().settings.get<string>("proxy.url")) || undefined : undefined;
			});
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
				this.requestUpdate();
				return;
			}
			if ((ev as any).type === "compaction_end") {
				if (this._streamingContainer) this._streamingContainer.endCompacting();
				this.requestUpdate();
				return;
			}
			if ((ev as any).type === "state_update") {
				// Server state refresh (e.g. after compaction or reconnect) — re-render stats
				// and scroll to bottom if we were tracking bottom (content may have been
				// bulk-replaced without triggering a ResizeObserver change).
				// Change 3 — also honour `_wasAtBottomAtLastUserScroll` so a transient
				// scroll-up that just flipped `_stickToBottom` false doesn't lose the bottom.
				this.requestUpdate();
				if (this._stickToBottom || this._wasAtBottomAtLastUserScroll) {
					this.updateComplete.then(() => this._scrollToBottom());
				}
				return;
			}
			if ((ev as any).type === "tool_execution_update") {
				// Partial results from long-running tools (delegate, skill invocations)
				// Force streaming container to re-render with updated delegate cards
				this.requestUpdate();
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
				this.requestUpdate();
				return;
			}
			switch (ev.type) {
				case "turn_end":
				case "agent_start":
					this.requestUpdate();
					break;
				case "turn_start":
				case "message_start":
					this.requestUpdate();
					break;
				case "message_end":
					// When a message finishes, sync the streaming container
					// with the current streamingMessage state.  If the agent
					// cleared streamingMessage (e.g. message without tool calls),
					// we clear the container so the finalized message only
					// appears in message-list.  If streamingMessage is still set
					// (deferred tool-call message), the container keeps it.
					if (this._streamingContainer) {
						const sm = this.session?.state.streamingMessage;
						if (!sm) {
							this._streamingContainer.setMessage(null, true);
						}
					}
					this.requestUpdate();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.turnStartTime = null;
						this._streamingContainer.setMessage(null, true);
					}
					// Queue draining is handled server-side now
					this.requestUpdate();
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = this.session?.state.isStreaming || false;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.turnStartTime = (this.session?.state as any).turnStartTime ?? null;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					break;
			}
		});
	}

	private _scrollToBottom() {
		this._stickToBottom = true;
		// We're definitionally at the bottom now — hide the jump button.
		// Necessary because a browser clamp scroll event (e.g. content swap on
		// session navigate) can flip _showJumpToBottom back to true between
		// content render and this call. After our programmatic scrollTop write,
		// the echo latch consumes the next scroll event so _handleScroll won't
		// re-evaluate — leaving a stale `true` that keeps the button visible.
		if (this._showJumpToBottom) {
			this._showJumpToBottom = false;
			this.requestUpdate();
		}
		if (this._scrollContainer) {
			const sh = this._scrollContainer.scrollHeight;
			const target = sh - this._scrollContainer.clientHeight;
			this._lastProgrammaticScrollTop = target;
			this._lastProgrammaticScrollHeight = sh;
			this._scrollContainer.scrollTop = sh;
		}
		// Re-assert after next frame (layout may not have settled yet)
		requestAnimationFrame(() => {
			if (this._scrollContainer) {
				const sh = this._scrollContainer.scrollHeight;
				const target = sh - this._scrollContainer.clientHeight;
				this._lastProgrammaticScrollTop = target;
				this._lastProgrammaticScrollHeight = sh;
				this._scrollContainer.scrollTop = sh;
			}
			if (this._showJumpToBottom) {
				this._showJumpToBottom = false;
				this.requestUpdate();
			}
		});
	}

	/**
	 * Stick-to-bottom: deterministic programmatic-scroll filter, no timers.
	 *
	 * The single scroll event whose (scrollTop, scrollHeight) exactly matches
	 * the values we just programmatically wrote is the browser-emitted echo
	 * of our own assignment — ignore it once, then clear the latch so a later
	 * coincidental match still counts as a real user scroll.
	 *
	 * Anything else is user intent. We only re-stick if the user is within
	 * 5 px of the bottom (the prior 50 px tail enabled the vibration symptom).
	 */
	private _handleScroll = () => {
		if (!this._scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = this._scrollContainer;
		if (
			this._lastProgrammaticScrollTop !== null &&
			this._lastProgrammaticScrollHeight !== null &&
			// Change 1 — sub-pixel echo-latch tolerance. HiDPI / device-pixel
			// rounding can produce fractional offsets between the scrollTop we
			// programmatically set and the value the browser reports back; a
			// strict equality check would miss the echo and treat it as user
			// intent. < 1 px is well below any meaningful gesture.
			Math.abs(scrollTop - this._lastProgrammaticScrollTop) < 1 &&
			Math.abs(scrollHeight - this._lastProgrammaticScrollHeight) < 1
		) {
			// Consume the echo exactly once.
			this._lastProgrammaticScrollTop = null;
			this._lastProgrammaticScrollHeight = null;
			return;
		}
		// Change 3 — capture pre-recompute value so a transient scroll-up that
		// flips `_stickToBottom` false in the next line still gets honoured by
		// the `state_update` branch.
		this._wasAtBottomAtLastUserScroll = this._stickToBottom;
		// Stick-to-bottom grace: 10% of viewport height (min 10 px). If the
		// user is within that band of the bottom, treat new content as
		// continued tailing rather than "they've scrolled up". The 10 px floor
		// preserves the original HiDPI-jitter tolerance for very short viewports.
		const stickGracePx = Math.max(10, clientHeight * 0.1);
		const geometricallyAtBottom = scrollHeight - scrollTop - clientHeight < stickGracePx;
		// During the session-load settle window, browser-emitted scroll events
		// from the DOM swap (old session content unmounted, new session content
		// rendering with async markdown / syntax highlighting growth) can
		// transiently report `scrollTop` lagging behind a freshly-grown
		// `scrollHeight`. Geometry alone would flip `_stickToBottom` to false,
		// breaking the subsequent ResizeObserver re-pin and leaving the user
		// stranded mid-scroll. Only allow geometry-driven false during the
		// settle window — explicit user intent (wheel/touchstart/keydown)
		// continues to release stickiness via _handleUserIntent.
		if (this._settleWindowActive && !geometricallyAtBottom) {
			// Don't change _stickToBottom — keep it true so the observer re-pins.
		} else {
			this._stickToBottom = geometricallyAtBottom;
		}
		// Change 5 — Jump-to-bottom visibility (more than half a screen from bottom).
		let nextShow = scrollHeight - scrollTop - clientHeight > clientHeight * 0.5;
		// Honour the post-click suppression window: the user just asked us to
		// jump, so we don't want a transient height-growth race to re-show the
		// button before the rAF/ResizeObserver re-pins to the bottom.
		if (nextShow && performance.now() < this._suppressJumpUntilTs) {
			nextShow = false;
		}
		if (nextShow !== this._showJumpToBottom) {
			this._showJumpToBottom = nextShow;
			this.requestUpdate();
		}
	};

	/** Any direct user-input gesture on the scroll container immediately
	 *  releases the stickiness. We don't second-guess the user via geometry. */
	private _handleUserIntent = () => {
		this._stickToBottom = false;
		// Change 3 — explicit user intent clears the carry-over.
		this._wasAtBottomAtLastUserScroll = false;
		// Change 4 — explicit user intent cancels the settle window immediately.
		this._settleWindowActive = false;
	};

	private _handleScrollKeydown = (e: KeyboardEvent) => {
		switch (e.key) {
			case "PageUp":
			case "ArrowUp":
			case "Home":
			case "PageDown":
			case "ArrowDown":
			case "End":
				this._stickToBottom = false;
				// Change 3 — explicit user intent clears the carry-over.
				this._wasAtBottomAtLastUserScroll = false;
				// Change 4 — explicit user intent cancels the settle window immediately.
				this._settleWindowActive = false;
				break;
		}
	};

	// Change 5 — Jump-to-bottom click handler.
	private _handleJumpToBottomClick = () => {
		// Open a 600 ms suppression window during which _handleScroll cannot
		// re-show the button. _scrollToBottom + the size-observer's stick-to-
		// bottom re-pin both run within that window, so by the time it expires
		// the geometry is genuinely at the bottom and `nextShow` evaluates false.
		this._suppressJumpUntilTs = performance.now() + 600;
		this._scrollToBottom();
		this._stickToBottom = true;
		this._wasAtBottomAtLastUserScroll = true;
		if (this._showJumpToBottom) {
			this._showJumpToBottom = false;
			this.requestUpdate();
		}
	};

	public async sendMessage(input: string, attachments?: Attachment[]) {
		if (!input.trim() && (!attachments || attachments.length === 0)) return;
		const session = this.session;
		if (!session) throw new Error("No session set on AgentInterface");

		// Handle /compact slash command
		if (input.trim().toLowerCase() === "/compact") {
			if ("compact" in session && typeof (session as any).compact === "function") {
				this._messageEditor.value = "";
				this._messageEditor.attachments = [];
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
		// Snap to bottom when sending a message.
		// Set flag and scroll immediately, then re-assert after render
		// (scroll events from layout changes can race and unset the flag).
		this._stickToBottom = true;
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
		const visibleMessages = (this.session.state.messages || []).filter(
			(m: any) => !isAskResponseEnvelope(m) &&
				(!streamingMessageId || m.id !== streamingMessageId),
		);
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${visibleMessages}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.hasStreamMessage=${!!state.streamingMessage}
					.toolPartialResults=${(state as any).toolPartialResults}
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
					@grant-tool-permission=${(e: CustomEvent) => {
						if (!this.session) return;
						const { toolName, scope, group, lastPromptText, mode } = e.detail;
						(this.session as any).grantToolPermission?.(toolName, scope, group, lastPromptText, mode);
					}}
					@deny-tool-permission=${(e: CustomEvent) => {
						if (!this.session) return;
						const { id, toolName } = e.detail;
						(this.session as any).denyToolPermission?.(id, toolName);
					}}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.archived=${this.readOnly && !this.nonInteractive}
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.toolPartialResults=${(state as any).toolPartialResults}
					.onCostClick=${this.onCostClick}
					.turnStartTime=${(state as any).turnStartTime ?? null}
				></streaming-message-container>

				${(state as any).isPreparing ? html`
					<div class="flex items-center gap-2 px-4 py-2 text-muted-foreground text-sm">
						<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
						</svg>
						<span>Setting up worktree…</span>
					</div>
				` : nothing}

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

		// Prefer server-authoritative cost when available (via cost_update WS messages)
		const serverCost = (this.session as any)?.state?.serverCost;
		const costValue = serverCost?.totalCost ?? totals.cost?.total;
		const costText = costValue ? formatCost(costValue) : "";

		// Compute context usage from the last assistant message's usage
		let contextHtml = html``;
		const model = state.model;
		// After compaction, the last assistant message's usage reflects the old
		// (pre-compaction) context size.  Show "?" until the next real LLM
		// response provides fresh usage data (matches the TUI behaviour).
		const usageStale = (this.session as any)?._usageStaleAfterCompaction === true;
		if (model?.contextWindow) {
			if (usageStale) {
				// Show an empty bar with "?" — exact token count unknown until next response
				contextHtml = html`
					<span class="flex items-center gap-1.5" title="Context usage unknown until next response">
						<span style="display:inline-flex;align-items:center;width:48px;height:6px;background:var(--muted,#27272a);border-radius:3px;overflow:hidden">
							<span style="width:0%;height:100%;background:var(--primary,#3b82f6);border-radius:3px;transition:width 0.3s"></span>
						</span>
						<span>—</span>
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
		const fullLabels = {
			off: i18n("Off"),
			minimal: i18n("Minimal"),
			low: i18n("Low"),
			medium: i18n("Medium"),
			high: i18n("High"),
		};
		const thinkingTitle = fullLabels[(state.thinkingLevel as keyof typeof fullLabels) ?? "off"] ?? fullLabels.off;

		const thinkingSelect = supportsThinking && this.enableThinkingSelector
			// Outer button gap (label → chevron) tightened to 2px; inner span gap
			// (brain icon → label) stays at 4px so the icon doesn't crowd the text.
			? html`<span class="thinking-select-compact [&_button]:!gap-0.5 [&_button]:!px-1.5 [&_button>span]:!gap-1" title="${thinkingTitle}">${Select({
				value: state.thinkingLevel,
				placeholder: fullLabels.off,
				options: [
					{ value: "off", label: fullLabels.off, icon: icon(Brain, "sm") },
					{ value: "minimal", label: fullLabels.minimal, icon: icon(Brain, "sm") },
					{ value: "low", label: fullLabels.low, icon: icon(Brain, "sm") },
					{ value: "medium", label: fullLabels.medium, icon: icon(Brain, "sm") },
					{ value: "high", label: fullLabels.high, icon: icon(Brain, "sm") },
				] as SelectOption[],
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
					ModelSelector.open(state.model, (m) => {
						if (typeof (session as any).setModel === 'function') (session as any).setModel(m);
						else session.state.model = m;
					});
				},
				children: html`
					${icon(Sparkles, "sm")}
					<span class="ml-0 sm:ml-0.5">${state.model.id}</span>
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
					ImageModelSelector.open(imageModel, (m) => {
						if (typeof (session as any).setImageGenerationModel === "function") {
							(session as any).setImageGenerationModel(m);
						} else {
							(session.state as any).imageGenerationModel = m;
						}
					});
				},
				children: html`
					${icon(ImageIcon, "sm")}
					<span class="ml-0.5 hidden sm:inline">${imageModel.id}</span>
				`,
				className: "h-6 text-xs truncate",
			})
			: "";

		const cwdHtml = this.cwd ? (() => {
			const parts = this.cwd!.split(/[/\\]/).filter(Boolean);
			const short = parts.length <= 2 ? parts.join("/") : "…/" + parts.slice(-2).join("/");
			return html`<span class="font-mono opacity-60 flex items-center gap-1 truncate" style="max-width:280px;" title="${this.cwd}">${short}</span>`;
		})() : "";

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
						${row("Total cost", totals.cost?.total ? formatCost(totals.cost.total) : "—")}
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
			<div class="text-xs text-muted-foreground flex justify-between items-center mt-0.5 pl-2 pr-2 sm:pl-0 sm:pr-0">
				<div class="flex items-center">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
					${thinkingSelect}
					${modelButton}
					${imageModelButton}
				</div>
				${cwdHtml ? html`<div class="hidden sm:flex items-center pl-4">${cwdHtml}</div>` : ""}
				<div class="flex ml-auto items-center gap-3 relative" style="position:relative">
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
					<div class="absolute inset-0 overflow-y-auto overflow-x-hidden">
						<div class="max-w-5xl mx-auto p-2 sm:p-4 pb-0 min-w-0">${this.renderMessages()}</div>
					</div>
					${this._renderJumpToBottom()}
				</div>

				<!-- Input Area -->
				<div class="shrink-0 pt-0 pb-1">
					<div data-input-container class="max-w-5xl mx-auto px-2 relative">
						${this.bgProcesses.length > 0 || this.gitRepoKnown !== 'no' ? html`
						<div data-pill-strip class="absolute right-2 bottom-full mb-1.5 z-10 pointer-events-auto" style="max-width:calc(100% - 1rem); --pill-h: 22px">
							<!-- Real pills with a CSS drop-shadow filter for the glow. Drop-shadow
							     follows the actual rendered shape per-element, so wrapping or
							     differently-sized children (git-status-widget vs bash_bg pills)
							     stay aligned on every viewport — unlike the previous parallel
							     glow-placeholder layer which mismatched on mobile. -->
							<div data-pill-content class="flex items-center gap-1.5 flex-wrap justify-end" style="position:relative;z-index:1;filter:drop-shadow(0 0 4px var(--background)) drop-shadow(0 0 8px var(--background))">
							${this._renderPillStrip()}
							${this.gitRepoKnown !== 'no' ? html`<git-status-widget
								.sessionId=${this.session?.sessionId ?? ''}
								.token=${localStorage.getItem("gateway.token") || ""}
								.branch=${this.gitStatus?.branch ?? ''}
								.primaryBranch=${this.gitStatus?.primaryBranch ?? 'master'}
								.isOnPrimary=${this.gitStatus?.isOnPrimary ?? true}
								.summary=${this.gitStatus?.summary ?? ''}
								.clean=${this.gitStatus?.clean ?? true}
								.hasUpstream=${this.gitStatus?.hasUpstream ?? false}
								.ahead=${this.gitStatus?.ahead ?? 0}
								.behind=${this.gitStatus?.behind ?? 0}
								.aheadOfPrimary=${this.gitStatus?.aheadOfPrimary ?? 0}
								.behindPrimary=${this.gitStatus?.behindPrimary ?? 0}
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
							<button
								type="button"
								class="px-3 py-1.5 text-sm rounded-md text-white"
								style="background:var(--primary,#3b82f6);border:1px solid var(--primary,#3b82f6);"
								data-action="continue-archived"
								@click=${() => this._openContinueChooser()}
							>Continue in New Session</button>
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
								ModelSelector.open(state.model, (model) => {
								if (typeof (session as any).setModel === 'function') (session as any).setModel(model);
								else session.state.model = model;
							});
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: "off" | "minimal" | "low" | "medium" | "high") => {
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

	// Jump-to-bottom floating button. Reuses small-floating-button vocabulary
	// (rounded-full, border-input, bg-background, shadow-sm). Centred above
	// the composer with the label always visible — previously sat bottom-right
	// where it was hidden by the git-status widget / pill strip on mobile.
	private _renderJumpToBottom() {
		const show = this._showJumpToBottom;
		// Base offset matches the pill strip's bottom-edge gap (1rem). When the
		// strip is rendered, lift the button above its measured height plus an
		// 8px breathing gap so wrapped/stacked pills don't obscure it.
		const baseOffsetPx = 16;
		const stripGapPx = this._pillStripHeight > 0 ? this._pillStripHeight + 8 : 0;
		const bottomPx = baseOffsetPx + stripGapPx;
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
				<div class="relative" style="display:inline-flex;align-items:center;position:relative;top:1px">
					<span class="inline-flex items-center rounded-full bg-card border border-border text-[11px] leading-tight" data-more-btn style="height:var(--pill-h, auto)">
						<button
							class="inline-flex items-center gap-1 px-1.5 py-0.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer font-mono rounded-l-full"
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
						<div class="absolute bottom-full z-50 flex flex-col gap-1 pill-more-popover" style="left:-8px; min-width:max-content; padding:14px; margin:-8px; margin-bottom:-7px; backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); --m:linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent), linear-gradient(to bottom, transparent, black 14px, black calc(100% - 14px), transparent); -webkit-mask-image:var(--m); mask-image:var(--m); -webkit-mask-composite:destination-in; mask-composite:intersect">
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
	 */
	private _measurePillOverflow() {
		const parentContainer = this.querySelector('[data-input-container]') as HTMLElement;
		if (!parentContainer) return;
		let maxWidth = parentContainer.clientWidth * 0.75;

		const pillStrip = this.querySelector('[data-pill-strip]') as HTMLElement;
		if (!pillStrip) return;

		// The content layer is the second child (z-index:1) inside the pill strip
		const contentLayer = pillStrip.querySelector('[data-pill-content]') as HTMLElement;
		if (!contentLayer) return;

		const gap = 6; // gap-1.5 = 0.375rem ≈ 6px

		// Subtract git-status-widget width from available space
		const gitWidget = contentLayer.querySelector('git-status-widget') as HTMLElement;
		if (gitWidget) {
			maxWidth -= gitWidget.offsetWidth + gap;
		}

		const pillWidths: number[] = [];

		// Collect widths of visible pill wrappers — each visible pill is in a <div> wrapper
		// The "more" button is in a <div class="relative">, skip it.
		// git-status-widget is a direct child, skip it too.
		for (const child of contentLayer.children) {
			const el = child as HTMLElement;
			if (el.querySelector('bg-process-pill') && !el.querySelector('.pill-more-popover')) {
				pillWidths.push(el.offsetWidth);
			}
		}

		if (pillWidths.length === 0) {
			this._visiblePillCount = Infinity;
			return;
		}

		// The "more" button itself takes ~60px when shown
		const moreBtnWidth = 60;

		// Count from right (newest) how many pills fit
		let fitCount = 0;
		let usedWidth = 0;
		for (let i = pillWidths.length - 1; i >= 0; i--) {
			const needed = pillWidths[i] + (fitCount > 0 ? gap : 0);
			const wouldNeedMore = i > 0; // still have pills to hide
			const reserveForMore = wouldNeedMore ? moreBtnWidth + gap : 0;
			if (usedWidth + needed + reserveForMore <= maxWidth) {
				usedWidth += needed;
				fitCount++;
			} else {
				break;
			}
		}

		// At least 1 pill must be visible
		const newCount = Math.max(1, fitCount);
		if (newCount !== this._visiblePillCount) {
			this._visiblePillCount = newCount;
			this.requestUpdate();
		}

		if (!this._pillsInitialized) {
			this._pillsInitialized = true;
		}
	}

	override updated(changedProperties: Map<string, any>) {
		super.updated(changedProperties);

		// Mobile-only: rewrite the thinking-selector trigger label to an abbreviation.
		// The Select component reuses option.label for both the trigger and the popover
		// items, so we keep options on full labels and only retarget the trigger's
		// visible text node here. Re-runs on every render and on viewport changes
		// (which call requestUpdate via _handleMobileMediaChange).
		this._syncThinkingTriggerLabel();

		// Setup pill overflow observer once the pill strip is rendered
		if (this.bgProcesses.length > 0) {
			const pillStrip = this.querySelector('[data-pill-strip]') as HTMLElement;
			if (pillStrip && !this._pillResizeObserver) {
				this._pillResizeObserver = new ResizeObserver(() => {
					this._measurePillOverflow();
				});
				// Observe the input container for size changes
				const parent = this.querySelector('[data-input-container]') as HTMLElement;
				if (parent) this._pillResizeObserver.observe(parent);
			}
			// Measure after renders that change pill count
			if (changedProperties.has('bgProcesses')) {
				requestAnimationFrame(() => this._measurePillOverflow());
			}


		} else {
			// No pills — reset
			this._visiblePillCount = Infinity;
			this._moreExpanded = false;
			this._pillsInitialized = false;
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
		const abbrev: Record<string, string> = { off: "Off", minimal: "Min", low: "Low", medium: "Med", high: "Hi" };
		const full: Record<string, string> = { off: i18n("Off"), minimal: i18n("Minimal"), low: i18n("Low"), medium: i18n("Medium"), high: i18n("High") };
		const desired = this._isMobileViewport ? (abbrev[level] ?? abbrev.off) : (full[level] ?? full.off);
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
