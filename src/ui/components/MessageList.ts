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
import "./PreCompactionHistory.js";
import { COMPACTION_TOOL_NAME } from "../../app/compaction-types.js";

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
const GROUPABLE_TOOLS = new Set(["read", "edit", "write", "bash", "ls", "find", "grep", "delegate"]);

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

export class MessageList extends LitElement {
	@property({ type: Array }) messages: AgentMessage[] = [];
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
	/** Session id — forwarded to `<bobbit-pre-compaction-history>` when a
	 *  compaction card appears in the transcript, so the inline expand
	 *  affordance can call the orphan-transcript API. */
	@property({ type: String }) sessionId: string = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	private buildRenderItems() {
		// Map tool results by call id for quick lookup
		const resultByCallId = new Map<string, ToolResultMessageType>();
		for (const message of this.messages) {
			if (message.role === "toolResult") {
				resultByCallId.set(message.toolCallId, message);
			}
		}

		const items: Array<{ key: string; template: TemplateResult }> = [];
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
				items.push({
					key: `precompact:${compactionId}`,
					template: html`<bobbit-pre-compaction-history
						compaction-id=${compactionId}
						session-id=${this.sessionId}
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

			// Render tool permission request cards
			if ((msg as any).role === "tool_permission_needed") {
				const perm = msg as any;
				items.push({
					key: `perm:${perm.id}`,
					template: html`<tool-permission-card
						.toolName=${perm.toolName}
						.group=${perm.group}
						.roleName=${perm.roleName}
						.roleLabel=${perm.roleLabel}
						.onGrant=${(scope: "tool" | "group", mode?: string) => this.dispatchEvent(new CustomEvent("grant-tool-permission", { detail: { toolName: perm.toolName, scope, group: perm.group, lastPromptText: perm.lastPromptText, mode }, bubbles: true, composed: true }))}
						.onDeny=${() => this.dispatchEvent(new CustomEvent("deny-tool-permission", { detail: { id: perm.id, toolName: perm.toolName }, bubbles: true, composed: true }))}
					></tool-permission-card>`,
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
				items.push({
					key: keyFor(msg),
					template: html`<user-message .message=${msg}></user-message>`,
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
		return html`<div class="flex flex-col gap-3">
			${repeat(
				items,
				(it) => it.key,
				(it) => it.template,
			)}
		</div>`;
	}
}

// Register custom element
if (!customElements.get("message-list")) {
	customElements.define("message-list", MessageList);
}
