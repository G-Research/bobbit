import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage as AssistantMessageType,
	ToolCall,
	ToolResultMessage as ToolResultMessageType,
} from "@earendil-works/pi-ai";
import { html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { renderMessage } from "./message-renderer-registry.js";
import "./ErrorMessage.js";
import "./ToolGroup.js";
import "./ToolPermissionCard.js";
// <bobbit-pre-compaction-history> is loaded on demand the first time a
// compaction-summary card appears in the transcript. Most chat sessions
// never compact, so keeping this 8 kB element out of entry saves cold
// load. Lit upgrades the unknown tag once the chunk's customElement
// landing fires.
import { ensurePreCompactionHistory } from "../../app/lazy-widgets.js";
import "./DeferredBlock.js";
import { COMPACTION_TOOL_NAME } from "../../app/compaction-types.js";
import {
	isPerfFlagEnabled,
	PERF_FLAG_DEFER_OFFSCREEN_RENDER,
} from "../../app/perf-flags.js";
import { isAccountablePromptMessage, type BobbitMessage } from "../../shared/message-author.js";
import type { PromptAuthorAppearance } from "../../app/message-author-appearance.js";
import {
	NO_PROMPT_AUTHOR_LABELS,
	type PromptAuthorDisplayMode,
} from "../message-author-presentation.js";

/** Number of items at the bottom of the transcript that render eagerly
 *  even when the defer-offscreen perf flag is on. The transcript auto-scrolls
 *  to the bottom on session activation, so the tail is what the user sees at
 *  first paint — deferring it would cause visible pop-in. Older messages
 *  (above index `items.length - DEFER_EAGER_TAIL`) start as placeholders and
 *  resolve via IntersectionObserver as the user scrolls up. */
const DEFER_EAGER_TAIL = 8;

/** Per-message height heuristic for placeholder `min-height`. Rough — when
 *  it misses, <deferred-block> preserves scroll anchoring for above-viewport
 *  swaps and preloads far enough ahead to keep visible shifts rare. */
function estimateMessageHeight(msg: any): number {
	if (!msg || typeof msg !== "object") return 80;
	if (msg.role === "user" || msg.role === "user-with-attachments") return 60;
	if (msg.role === "assistant") {
		let textChars = 0;
		let toolBlocks = 0;
		const content = Array.isArray(msg.content) ? msg.content : [];
		for (const block of content) {
			if (block && block.type === "text" && typeof block.text === "string") {
				textChars += block.text.length;
			} else if (block && block.type === "toolCall") {
				toolBlocks++;
			}
		}
		// ~80 chars / wrapped line, ~24px line-height, 48px chrome + 60px per tool block.
		return 48 + Math.ceil(textChars / 80) * 24 + toolBlocks * 60;
	}
	if (msg.role === "toolResult") return 80;
	return 100;
}

/** Detect a compaction-summary synthetic assistant message and pull out
 *  the sidecar id. The arguments payload is whatever
 *  `buildCompactionSummaryMessages()` stuffed in; persisted rows carry
 *  `compactionId`, live-only rows do not. */
function getCompactionSidecarId(msg: any): string | null {
	if (!msg || msg.role !== "assistant") return null;
	const content = msg.content;
	if (!Array.isArray(content) || content.length !== 1) return null;
	const block = content[0];
	if (!block || block.type !== "toolCall" || block.name !== COMPACTION_TOOL_NAME) return null;
	const cid = block.arguments?.compactionId;
	return typeof cid === "string" && cid.length > 0 ? cid : null;
}

/** Live (in-progress / no-sidecar-id-yet) compaction-summary detection —
 *  separate from `getCompactionSidecarId` which only matches persisted rows.
 *  Used to suppress the destructive "Request aborted" banner on the assistant
 *  message that the agent self-aborted to make room for compaction. */
function isLiveCompactionSummary(msg: any): boolean {
	if (!msg || msg.role !== "assistant") return false;
	const content = msg.content;
	if (!Array.isArray(content) || content.length !== 1) return false;
	const block = content[0];
	return !!(block && block.type === "toolCall" && block.name === COMPACTION_TOOL_NAME);
}

/** Build a stable render key for a message — id-based with a synthetic
 *  fallback that includes reducer metadata when available. */
function keyFor(msg: any, group?: string): string {
	const id = typeof msg.id === "string" && msg.id.length > 0
		? msg.id
		: `synth:${msg._origin ?? "unknown"}:${msg._order ?? 0}:${msg._insertionTick ?? 0}`;
	return group ? `${group}:${id}` : id;
}

/** Tool names eligible for cross-message grouping */
const GROUPABLE_TOOLS = new Set(["read", "edit", "write", "bash", "ls", "find", "grep", "team_delegate"]);

/**
 * Check if an assistant message is groupable — contains tool calls of a single type
 * with no visible user-facing text (thinking blocks are ignored since they're
 * collapsed in history). Returns the tool name, or null if not groupable.
 */
function getGroupableToolName(msg: AssistantMessageType): string | null {
	let toolName: string | null = null;
	for (const chunk of msg.content) {
		if (chunk.type === "text" && chunk.text.trim()) return null;
		// Thinking blocks are always collapsed in history — don't let them break groups
		if (chunk.type === "toolCall") {
			if (toolName === null) toolName = chunk.name;
			else if (chunk.name !== toolName) return null; // mixed tool types
		}
	}
	return toolName;
}

/** Extract all ToolCall objects from an assistant message */
function getToolCalls(msg: AssistantMessageType): ToolCall[] {
	return (msg.content ?? []).filter((c): c is ToolCall => c.type === "toolCall");
}

function isPermissionActionable(msg: any): boolean {
	const status = typeof msg?.status === "string" ? msg.status : "active";
	return msg?.role === "tool_permission_needed"
		&& msg.actionable !== false
		&& (status === "active" || status === "granting");
}

export class MessageList extends LitElement {
	@property({ type: Array }) messages: BobbitMessage<AgentMessage>[] = [];
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Boolean }) isStreaming: boolean = false;
	/** True when the streaming container has a message — only then should we hide pending tool calls */
	@property({ type: Boolean }) hasStreamMessage: boolean = false;
	/** Partial results from long-running tools (delegate progress, etc.) */
	@property({ type: Object }) toolPartialResults?: Record<string, any>;
	@property({ attribute: false }) onCostClick?: () => void;
	@property({ attribute: false }) onDismissError?: (id: string) => void;
	@property({ attribute: false }) onRestartAgent?: () => void;
	@property({ attribute: false }) onRetry?: () => void;
	/** Hide active permission request cards when the same controls are pinned near the prompt. */
	@property({ type: Boolean }) hideActionablePermissionRows: boolean = false;
	/** Session id — forwarded to `<bobbit-pre-compaction-history>` when a
	 *  compaction card appears in the transcript, so the inline expand
	 *  affordance can call the orphan-transcript API. */
	@property({ type: String }) sessionId: string = "";
	/** One immutable decision owned by AgentInterface for every loaded slice. */
	@property({ attribute: false }) promptAuthorDisplayMode: PromptAuthorDisplayMode = NO_PROMPT_AUTHOR_LABELS;
	@property({ attribute: false }) resolvePromptAuthorAppearance?: (author: unknown) => PromptAuthorAppearance;
	@property({ attribute: false }) reportPromptAuthorSlice?: (
		sessionId: string,
		compactionId: string,
		messages: readonly unknown[] | undefined,
	) => void;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	private buildRenderItems() {
		// Map tool results by call id for quick lookup
		const resultByCallId = new Map<string, BobbitMessage<ToolResultMessageType>>();
		for (const message of this.messages) {
			if (message.role === "toolResult") {
				resultByCallId.set(message.toolCallId, message as BobbitMessage<ToolResultMessageType>);
			}
		}

		const permissionBlockedTools = new Set<string>();
		for (const message of this.messages) {
			if (isPermissionActionable(message) && typeof (message as any).toolName === "string") {
				permissionBlockedTools.add((message as any).toolName);
			}
		}

		const items: Array<{ key: string; template: TemplateResult; eager?: boolean }> = [];
		let i = 0;
		const msgs = this.messages;

		while (i < msgs.length) {
			const msg = msgs[i];

			// Skip artifact messages
			if (msg.role === "artifact") { i++; continue; }

			// Inline pre-compaction history affordance: when this row is the
			// synthetic compaction-summary card AND the sidecar persisted a
			// compactionId for it, prepend the expand-history component so
			// the orphaned messages render directly in the transcript (above
			// the card) rather than nested inside it. Pre-count + expand state
			// is component-local; no impact on collapsed-by-default UX.
			const compactionId = getCompactionSidecarId(msg);
			if (compactionId && this.sessionId) {
				void ensurePreCompactionHistory();
				items.push({
					key: `precompact:${compactionId}`,
					template: html`<bobbit-pre-compaction-history
						compaction-id=${compactionId}
						session-id=${this.sessionId}
						.promptAuthorDisplayMode=${this.promptAuthorDisplayMode}
						.resolvePromptAuthorAppearance=${this.resolvePromptAuthorAppearance}
						.reportPromptAuthorSlice=${this.reportPromptAuthorSlice}
					></bobbit-pre-compaction-history>`,
				});
			}

			// Render error messages as dismissable banners
			if ((msg as any).role === "error") {
				const errMsg = msg as any;
				items.push({
					key: `err:${errMsg.id}`,
					template: html`<error-message
						.message=${errMsg}
						.onDismiss=${this.onDismissError}
						.onRestartAgent=${this.onRestartAgent}
					></error-message>`,
				});
				i++;
				continue;
			}

			// Render settled permission request cards as transcript history. Active rows
			// can be suppressed when AgentInterface pins the actionable controls above
			// the prompt, avoiding duplicate grant/deny cards for the same request.
			if ((msg as any).role === "tool_permission_needed") {
				const perm = msg as any;
				if (this.hideActionablePermissionRows && isPermissionActionable(perm)) {
					i++;
					continue;
				}
				items.push({
					key: `perm:${perm.id}`,
					eager: true,
					template: html`<div class="px-2 sm:px-4">
						<tool-permission-card
							.permissionId=${perm.id}
							.toolName=${perm.toolName}
							.group=${perm.group}
							.roleName=${perm.roleName}
							.roleLabel=${perm.roleLabel}
							.status=${perm.status ?? "active"}
							.mode=${perm.mode ?? "session-only"}
							.error=${perm.error ?? ""}
							.actionable=${perm.actionable !== false}
							.onModeChange=${(mode: string) => this.dispatchEvent(new CustomEvent("permission-mode-change", { detail: { id: perm.id, mode }, bubbles: true, composed: true }))}
							.onGrant=${(scope: "tool" | "group", mode?: string) => this.dispatchEvent(new CustomEvent("grant-tool-permission", { detail: { id: perm.id, toolName: perm.toolName, scope, group: perm.group, lastPromptText: perm.lastPromptText, mode }, bubbles: true, composed: true }))}
							.onDeny=${() => this.dispatchEvent(new CustomEvent("deny-tool-permission", { detail: { id: perm.id, toolName: perm.toolName }, bubbles: true, composed: true }))}
						></tool-permission-card>
					</div>`,
				});
				i++;
				continue;
			}

			// Try custom renderer first
			const customTemplate = renderMessage(msg);
			if (customTemplate) {
				items.push({ key: keyFor(msg), template: customTemplate });
				i++;
				continue;
			}

			if (msg.role === "user" || msg.role === "user-with-attachments") {
				const isAccountablePrompt = isAccountablePromptMessage(msg);
				items.push({
					key: keyFor(msg),
					template: html`<user-message
						.message=${msg}
						.showAuthorLabel=${this.promptAuthorDisplayMode.showLabels && isAccountablePrompt}
						.authorAppearance=${isAccountablePrompt
							? this.resolvePromptAuthorAppearance?.(msg.author)
							: undefined}
					></user-message>`,
				});
				i++;
				continue;
			}

			if (msg.role === "assistant") {
				const amsg = msg as AssistantMessageType;
				const toolName = getGroupableToolName(amsg);

				// Try to build a cross-message group of pure tool-only assistant messages
				if (toolName && GROUPABLE_TOOLS.has(toolName) && !this.isStreaming) {
					const groupCalls: ToolCall[] = [];
					let j = i;

					while (j < msgs.length) {
						const m = msgs[j];
						// Skip non-rendering message types between tool turns
						if (m.role === "toolResult" || m.role === "artifact") {
							j++;
							continue;
						}
						if (m.role !== "assistant") break;
						const name = getGroupableToolName(m as AssistantMessageType);
						if (name !== toolName) break;
						groupCalls.push(...getToolCalls(m as AssistantMessageType));
						j++;
					}

					if (groupCalls.length >= 2) {
						items.push({
							key: keyFor(msg, "group"),
							template: html`<div class="px-4">
								<tool-group
									.toolName=${toolName}
									.toolCalls=${groupCalls}
									.tools=${this.tools}
									.toolResultsById=${resultByCallId}
								></tool-group>
							</div>`,
						});
						i = j;
						continue;
					}
				}

				// Single assistant message — render normally
				// Only show the retry button on the very last errored assistant message
				// (check that no further assistant messages follow, skipping toolResult/artifact)
				let isLastAssistant = true;
				for (let k = i + 1; k < msgs.length; k++) {
					if (msgs[k].role === "assistant") { isLastAssistant = false; break; }
				}
				const showRetry = isLastAssistant && amsg.stopReason === "error" && this.onRetry;
				// Hide the destructive "Request aborted" banner when the agent
				// aborted its own turn to make room for auto-compaction — detected
				// by an immediately-following synthetic compaction-summary row.
				// A user-initiated Stop has no compaction following it, so the
				// banner still shows in that case.
				let suppressAbortedBanner = false;
				if (amsg.stopReason === "aborted") {
					for (let k = i + 1; k < msgs.length; k++) {
						const next = msgs[k];
						if (next.role === "toolResult" || next.role === "artifact") continue;
						if (getCompactionSidecarId(next) || isLiveCompactionSummary(next)) {
							suppressAbortedBanner = true;
						}
						break;
					}
				}
				items.push({
					key: keyFor(msg),
					template: html`<assistant-message
						.message=${amsg}
						.tools=${this.tools}
						.isStreaming=${false}
						.pendingToolCalls=${this.pendingToolCalls}
						.permissionBlockedTools=${permissionBlockedTools}
						.toolResultsById=${resultByCallId}
						.toolPartialResults=${this.toolPartialResults}
						.hideToolCalls=${false}
						.hidePendingToolCalls=${this.isStreaming && this.hasStreamMessage}
						.onCostClick=${this.onCostClick}
						.onRetry=${showRetry ? this.onRetry : undefined}
						.suppressAbortedBanner=${suppressAbortedBanner}
					></assistant-message>`,
				});
				i++;
				continue;
			}

			// Skip standalone toolResult messages and unknown roles
			i++;
		}
		return items;
	}

	override render() {
		const items = this.buildRenderItems();
		const defer = isPerfFlagEnabled(PERF_FLAG_DEFER_OFFSCREEN_RENDER);

		// Perf flag OFF — render every item synchronously (the historical path).
		// Zero overhead: no <deferred-block> wrapper, no observer machinery.
		if (!defer) {
			return html`<div class="flex flex-col gap-3">
				${repeat(
					items,
					(it) => it.key,
					(it) => it.template,
				)}
			</div>`;
		}

		// Perf flag ON — wrap each item in <deferred-block>. The bottom
		// DEFER_EAGER_TAIL items render eagerly (visible at first paint after
		// scroll-to-bottom); older items render a placeholder and resolve when
		// IntersectionObserver fires.
		const tailStart = Math.max(0, items.length - DEFER_EAGER_TAIL);
		// Align deferral with the message-source array so per-item est-heights
		// match the underlying message. `items.length` can differ from
		// `msgs.length` because of tool-grouping / synthetic precompact rows;
		// the heuristic only needs to be roughly right.
		const msgs = this.messages;
		return html`<div class="flex flex-col gap-3">
			${repeat(
				items,
				(it) => it.key,
				(it, idx) => {
					const eager = it.eager === true || idx >= tailStart;
					const srcIdx = Math.min(
						msgs.length - 1,
						Math.max(0, Math.round((idx / Math.max(1, items.length - 1)) * (msgs.length - 1))),
					);
					const estHeight = estimateMessageHeight(msgs[srcIdx]);
					return html`<deferred-block
						.template=${it.template}
						.eager=${eager}
						est-height=${estHeight}
					></deferred-block>`;
				},
			)}
		</div>`;
	}
}

// Register custom element
if (!customElements.get("message-list")) {
	customElements.define("message-list", MessageList);
}
