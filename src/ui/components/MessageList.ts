import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type {
	AssistantMessage as AssistantMessageType,
	ToolCall,
	ToolResultMessage as ToolResultMessageType,
} from "@mariozechner/pi-ai";
import { html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { renderMessage } from "./message-renderer-registry.js";
import "./ErrorMessage.js";
import "./ToolGroup.js";
import "./ToolPermissionCard.js";

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
	@property({ attribute: false }) onRetry?: () => void;

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

			// Render error messages as dismissable banners
			if ((msg as any).role === "error") {
				const errMsg = msg as any;
				items.push({
					key: `err:${errMsg.id}`,
					template: html`<error-message
						.message=${errMsg}
						.onDismiss=${this.onDismissError}
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
						.grantPolicy=${perm.grantPolicy || ""}
						.onGrant=${(scope: "tool" | "group") => this.dispatchEvent(new CustomEvent("grant-tool-permission", { detail: { toolName: perm.toolName, scope, group: perm.group, lastPromptText: perm.lastPromptText, grantPolicy: perm.grantPolicy }, bubbles: true, composed: true }))}
						.onDeny=${() => this.dispatchEvent(new CustomEvent("deny-tool-permission", { detail: { id: perm.id }, bubbles: true, composed: true }))}
					></tool-permission-card>`,
				});
				i++;
				continue;
			}

			// Try custom renderer first
			const customTemplate = renderMessage(msg);
			if (customTemplate) {
				items.push({ key: `msg:${i}`, template: customTemplate });
				i++;
				continue;
			}

			if (msg.role === "user" || msg.role === "user-with-attachments") {
				items.push({
					key: `msg:${i}`,
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
							key: `group:${i}`,
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
				items.push({
					key: `msg:${i}`,
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
