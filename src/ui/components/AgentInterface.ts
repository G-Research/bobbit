import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { streamSimple, type ToolResultMessage, type Usage } from "@mariozechner/pi-ai";
import { html, LitElement, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { Brain, Sparkles } from "lucide";
import { ModelSelector } from "../dialogs/ModelSelector.js";
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
	// PR status properties for goal-linked sessions
	@property() prState?: string;
	@property() prUrl?: string;
	@property({ type: Number }) prNumber?: number;
	@property() prTitle?: string;
	@property() prMergeable?: string;
	@property({ type: Boolean }) viewerIsAdmin?: boolean;
	@property() reviewDecision?: string;
	// Background processes for this session
	@property({ attribute: false }) bgProcesses: BgProcessInfo[] = [];
	@property({ attribute: false }) onBgProcessKill?: (id: string) => void;
	@property({ attribute: false }) onBgProcessDismiss?: (id: string) => void;
	@property({ attribute: false }) onPrMerge?: (method: string, admin?: boolean) => Promise<string | undefined>;
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

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _contextPopoverOpen = false;
	private _costPopoverOpen = false;
	private _stickToBottom = true;
	private _isAutoScrolling = false;
	private _autoScrollTimer?: ReturnType<typeof setTimeout>;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _lastScrollHeight = 0;

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
			// We set _isAutoScrolling to prevent the scroll event handler from
			// misinterpreting the programmatic scroll as a user scroll-up (which
			// can happen when content grows between the programmatic scroll and
			// the resulting scroll event).
			this._resizeObserver = new ResizeObserver(() => {
				if (!this._scrollContainer) return;
				const newScrollHeight = this._scrollContainer.scrollHeight;
				const delta = newScrollHeight - this._lastScrollHeight;

				if (delta < 0) {
					// Content shrunk (collapse) — apply post-collapse clamp.
					// Let the browser naturally adjust scrollTop, then check:
					// if bottom of content is above the viewport midpoint, scroll
					// so latest message is at the bottom of the viewport.
					this._lastScrollHeight = newScrollHeight;
					const { scrollTop, clientHeight } = this._scrollContainer;
					const contentBottom = newScrollHeight - scrollTop;
					if (contentBottom < clientHeight / 2) {
						this._isAutoScrolling = true;
						this._scrollContainer.scrollTop = newScrollHeight - clientHeight;
						clearTimeout(this._autoScrollTimer);
						this._autoScrollTimer = setTimeout(() => { this._isAutoScrolling = false; }, 150);
					}
					return;
				}

				if (this._stickToBottom) {
					this._lastScrollHeight = newScrollHeight;
					this._isAutoScrolling = true;
					this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
					clearTimeout(this._autoScrollTimer);
					this._autoScrollTimer = setTimeout(() => { this._isAutoScrolling = false; }, 150);
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
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Clean up timers, observers, and listeners
		clearTimeout(this._autoScrollTimer);
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
		}

		if (this._pillResizeObserver) {
			this._pillResizeObserver.disconnect();
			this._pillResizeObserver = undefined;
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

		// Reset scroll state for new session and scroll to bottom once rendered
		this._stickToBottom = true;
		this.updateComplete.then(() => this._scrollToBottom());

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
				this.requestUpdate();
				if (this._stickToBottom) {
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
					// with the current streamMessage state.  If the agent
					// cleared streamMessage (e.g. message without tool calls),
					// we clear the container so the finalized message only
					// appears in message-list.  If streamMessage is still set
					// (deferred tool-call message), the container keeps it.
					if (this._streamingContainer) {
						const sm = this.session?.state.streamMessage;
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
		this._isAutoScrolling = true;
		if (this._scrollContainer) {
			this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
		}
		// Re-assert after next frame (layout may not have settled yet)
		requestAnimationFrame(() => {
			if (this._scrollContainer) {
				this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
			}
		});
		// Clear auto-scroll guard on a timeout that outlasts the browser's
		// scroll event dispatch (see ResizeObserver comment for rationale).
		clearTimeout(this._autoScrollTimer);
		this._autoScrollTimer = setTimeout(() => {
			this._isAutoScrolling = false;
		}, 150);
	}

	/**
	 * Simple stick-to-bottom: if the user is near the bottom, stay there.
	 * If they've scrolled up, don't pull them back down.
	 * No keyboard/focus/viewport tracking — just geometry.
	 */
	private _handleScroll = () => {
		if (!this._scrollContainer || this._isAutoScrolling) return;
		const { scrollTop, scrollHeight, clientHeight } = this._scrollContainer;
		// Only update stickToBottom on genuine user scrolls, not browser-initiated
		// scroll clamps during content resize. When content shrinks, the browser
		// clamps scrollTop to the new max and fires a scroll event before the
		// ResizeObserver runs — if we updated _stickToBottom here, it would
		// incorrectly flip to true and prevent shrink compensation.
		if (scrollHeight === this._lastScrollHeight) {
			this._stickToBottom = scrollHeight - scrollTop - clientHeight < 50;
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
				session.state.messages = [...session.state.messages, userMsg];
				// Store as synthetic so it survives the server's messages refresh
				if ((session as any)._compactionSyntheticMessages) {
					(session as any)._compactionSyntheticMessages = [userMsg];
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

		// Always send to the server — it handles queuing when the agent is busy
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

		if ((state as any).isPreparing) {
			return html`
				<div class="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
					<svg class="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
					</svg>
					<span class="text-sm">Creating worktree…</span>
				</div>
			`;
		}
		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = this._getToolResultsById();
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${this.session.state.messages}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.hasStreamMessage=${!!state.streamMessage}
					.toolPartialResults=${(state as any).toolPartialResults}
					.onCostClick=${this.onCostClick}
					.onDismissError=${(id: string) => {
						if (!this.session) return;
						this.session.state.messages = this.session.state.messages.filter(
							(m: any) => !(m.role === "error" && m.id === id)
						);
						this.requestUpdate();
					}}
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
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.toolPartialResults=${(state as any).toolPartialResults}
					.onCostClick=${this.onCostClick}
					.turnStartTime=${(state as any).turnStartTime ?? null}
				></streaming-message-container>

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

		const costText = totals.cost?.total ? formatCost(totals.cost.total) : "";

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

		const thinkingSelect = supportsThinking && this.enableThinkingSelector
			? Select({
				value: state.thinkingLevel,
				placeholder: i18n("Off"),
				options: [
					{ value: "off", label: i18n("Off"), icon: icon(Brain, "sm") },
					{ value: "minimal", label: i18n("Minimal"), icon: icon(Brain, "sm") },
					{ value: "low", label: i18n("Low"), icon: icon(Brain, "sm") },
					{ value: "medium", label: i18n("Medium"), icon: icon(Brain, "sm") },
					{ value: "high", label: i18n("High"), icon: icon(Brain, "sm") },
				] as SelectOption[],
				onChange: (value: string) => {
					session.setThinkingLevel(value as any);
				},
				width: "80px",
				size: "sm",
				variant: "ghost",
				fitContent: true,
			})
			: "";

		const modelButton = this.enableModelSelector && state.model
			? Button({
				variant: "ghost",
				size: "sm",
				onClick: () => {
					ModelSelector.open(state.model, (m) => session.setModel(m));
				},
				children: html`
					${icon(Sparkles, "sm")}
					<span class="ml-1.5">${state.model.id}</span>
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
			<div class="text-xs text-muted-foreground flex justify-between items-center mt-0.5">
				<div class="flex items-center">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
					${thinkingSelect}
					${modelButton}
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
				<div class="flex-1 overflow-y-auto overflow-x-hidden">
					<div class="max-w-5xl mx-auto p-2 sm:p-4 pb-0 min-w-0">${this.renderMessages()}</div>
				</div>

				<!-- Input Area -->
				<div class="shrink-0 pt-0 pb-1">
					<div data-input-container class="max-w-5xl mx-auto px-2 relative">
						${this.bgProcesses.length > 0 || this.gitStatus || this.gitStatusLoading ? html`
						<div data-pill-strip class="absolute right-2 bottom-full mb-1.5 z-10 pointer-events-auto" style="max-width:calc(100% - 1rem); --pill-h: 22px">
							<!-- Layer 0: Glow shadows only — no content, no interaction -->
							<div class="flex items-center gap-1.5 flex-wrap justify-end pointer-events-none" aria-hidden="true" style="position:absolute;inset:0;z-index:0">
								${this._renderGlowLayer()}
							</div>
							<!-- Layer 1: Real interactive pills -->
							<div class="flex items-center gap-1.5 flex-wrap justify-end" style="position:relative;z-index:1">
							${this._renderPillStrip()}
							${this.gitStatus || this.gitStatusLoading ? html`<git-status-widget
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
								.loading=${this.gitStatusLoading}
								.prState=${this.prState}
								.prUrl=${this.prUrl}
								.prNumber=${this.prNumber}
								.prTitle=${this.prTitle}
								.prMergeable=${this.prMergeable}
								.viewerIsAdmin=${this.viewerIsAdmin ?? false}
								.reviewDecision=${this.reviewDecision}
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
						${(this.readOnly && !(this.nonInteractive && state.isStreaming)) || (state as any).isPreparing ? nothing : html`<message-editor style="position:relative;z-index:20"
							.sessionId=${this.session?.sessionId}
							.cwd=${this.cwd}
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
							.onModelSelect=${() => {
								ModelSelector.open(state.model, (model) => session.setModel(model));
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: "off" | "minimal" | "low" | "medium" | "high") => {
											session.setThinkingLevel(level);
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

	private async _handlePrMerge(e: CustomEvent<{ method: string; admin?: boolean }>): Promise<void> {
		if (!this.onPrMerge) return;
		const widget = e.target as import('./GitStatusWidget.js').GitStatusWidget;
		try {
			const error = await this.onPrMerge(e.detail.method, e.detail.admin);
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

	// --- Pill glow layer ---

	/**
	 * Render invisible pill-shaped shadows that sit behind the real pills.
	 * Same flex layout ensures alignment; transparent content means only the box-shadow is visible.
	 */
	private _renderGlowLayer() {
		const sorted = this._getSortedProcesses();
		if (sorted.length === 0) return nothing;

		const count = Math.min(this._visiblePillCount, sorted.length);
		let visibleCount = Math.max(1, count);
		let hiddenCount = sorted.length - visibleCount;
		if (hiddenCount === 1) { visibleCount++; hiddenCount = 0; }

		const glowStyle = "height:var(--pill-h, auto); border-radius:9999px; box-shadow:0 0 12px 8px var(--background), 0 0 4px 2px var(--background); background:transparent; border:1px solid transparent";

		const glowPills = [];

		// "N more" glow placeholder
		if (hiddenCount > 0) {
			glowPills.push(html`<div style="${glowStyle}; position:relative; top:1px"><span class="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono" style="visibility:hidden">${hiddenCount} more<span style="min-width:16px"></span></span></div>`);
		}

		// Visible pill glow placeholders
		for (const p of sorted.slice(hiddenCount)) {
			glowPills.push(html`<div style="${glowStyle}; position:relative; top:1px"><span class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono" style="visibility:hidden"><span>●</span>${p.name || p.id}<span style="min-width:16px"></span></span></div>`);
		}

		// Git status glow placeholder
		if (this.gitStatus || this.gitStatusLoading) {
			glowPills.push(html`<div style="${glowStyle}"><span class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px]" style="visibility:hidden">⎇ ${this.gitStatus?.branch ?? ''}</span></div>`);
		}

		return glowPills;
	}

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
						<div class="absolute bottom-full left-0 z-50 flex flex-col gap-1 pill-more-popover" style="min-width:max-content; border-radius:16px; box-shadow:0 0 12px 8px var(--background), 0 0 4px 2px var(--background); padding:2px; margin:-2px; margin-bottom:8px">
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
		const visibleCount = Math.max(1, count);
		const hiddenCount = sorted.length - visibleCount;

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
		let maxWidth = parentContainer.clientWidth * 0.6;

		const pillContainer = this.querySelector('[data-pill-strip]') as HTMLElement;
		if (!pillContainer) return;

		const gap = 6; // gap-1.5 = 0.375rem ≈ 6px

		// Subtract git-status-widget width from available space
		const gitWidget = pillContainer.querySelector('git-status-widget') as HTMLElement;
		if (gitWidget) {
			maxWidth -= gitWidget.offsetWidth + gap;
		}

		const pillWidths: number[] = [];

		// Collect widths of visible pill wrappers — each visible pill is in a <div> wrapper
		// The "more" button is in a <div class="relative">, skip it.
		// git-status-widget is a direct child, skip it too.
		for (const child of pillContainer.children) {
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
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
