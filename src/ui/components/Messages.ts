import type {
	AssistantMessage as AssistantMessageType,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage as ToolResultMessageType,
	UserMessage as UserMessageType,
} from "@mariozechner/pi-ai";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { renderTool } from "../tools/index.js";
import type { Attachment } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import "./ThinkingBlock.js";
import "./LiveTimer.js";
import "./ToolGroup.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";

/** Format a message timestamp for display (locale-appropriate time). */
export function formatTimestamp(ts: number | string | undefined): string {
	if (!ts) return "";
	const date = typeof ts === "string" ? new Date(ts) : new Date(ts);
	if (isNaN(date.getTime())) return "";
	return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Minimum consecutive same-name completed tool calls to form a group */
const MIN_GROUP_SIZE = 2;

/** Tool names eligible for grouping */
const GROUPABLE_TOOLS = new Set(["read", "edit", "write", "bash", "ls", "find", "grep", "delegate"]);

export type UserMessageWithAttachments = {
	role: "user-with-attachments";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	attachments?: Attachment[];
};

// Artifact message type for session persistence
export interface ArtifactMessage {
	role: "artifact";
	action: "create" | "update" | "delete";
	filename: string;
	content?: string;
	title?: string;
	timestamp: string;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"user-with-attachments": UserMessageWithAttachments;
		artifact: ArtifactMessage;
	}
}

@customElement("user-message")
export class UserMessage extends LitElement {
	@property({ type: Object }) message!: UserMessageWithAttachments | UserMessageType;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		const rawContent =
			typeof this.message.content === "string"
				? this.message.content
				: (this.message.content ?? []).find((c) => c.type === "text")?.text || "";
		// Preserve user line breaks: append two trailing spaces before each newline
		// so markdown renders them as <br> instead of collapsing to a single space.
		const content = rawContent.replace(/\n/g, "  \n");

		return html`
			<div class="flex justify-start mx-2 sm:mx-4 my-1">
				<div class="user-message-container py-2 px-3 sm:px-4">
					<markdown-block .content=${content}></markdown-block>
					${
						this.message.role === "user-with-attachments" &&
						this.message.attachments &&
						this.message.attachments.length > 0
							? html`
								<div class="mt-3 flex flex-wrap gap-2">
									${this.message.attachments.map(
										(attachment) => html` <attachment-tile .attachment=${attachment}></attachment-tile> `,
									)}
								</div>
							`
							: ""
					}
				</div>
				<span class="message-timestamp">${formatTimestamp(this.message.timestamp)}</span>
			</div>
		`;
	}
}

@customElement("assistant-message")
export class AssistantMessage extends LitElement {
	@property({ type: Object }) message!: AssistantMessageType;
	@property({ type: Array }) tools?: AgentTool<any>[];
	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Boolean }) hideToolCalls = false;
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessageType>;
	@property({ type: Object }) toolPartialResults?: Record<string, any>;
	@property({ type: Boolean }) isStreaming: boolean = false;
	@property({ type: Boolean }) hidePendingToolCalls = false;
	@property({ attribute: false }) onCostClick?: () => void;
	@property({ attribute: false }) onRetry?: () => void;
	@property({ type: Number }) turnStartTime: number | null = null;
	@state() private _retrying = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		// Render content in the order it appears
		const orderedParts: TemplateResult[] = [];

		// Detect <suggest_goal/> tag in text content
		const content = this.message.content ?? [];
		const hasSuggestGoal = content.some(
			c => c.type === 'text' && /<suggest_goal\s*\/?>/.test(c.text)
		);

		// Collect tool calls into runs for grouping (only when not streaming)
		let i = 0;
		while (i < content.length) {
			const chunk = content[i];

			if (chunk.type === "text" && chunk.text.trim() !== "") {
				const displayText = chunk.text.replace(/<suggest_goal\s*\/?>/g, '');
				if (displayText.trim() !== '') {
					orderedParts.push(html`<markdown-block .content=${displayText}></markdown-block>`);
				}
				i++;
			} else if (chunk.type === "thinking" && chunk.thinking.trim() !== "") {
				orderedParts.push(
					html`<thinking-block .content=${chunk.thinking} .isStreaming=${this.isStreaming}></thinking-block>`,
				);
				i++;
			} else if (chunk.type === "toolCall") {
				if (this.hideToolCalls) {
					i++;
					continue;
				}

				// Try to build a run of consecutive same-name, completed tool calls.
				// Skip over invisible chunks (empty text / empty thinking) that the
				// agent may emit between tool calls — they render nothing but would
				// otherwise break the consecutive run.
				const run: ToolCall[] = [];
				let j = i;
				while (j < content.length) {
					const c = content[j];
					// Skip invisible chunks
					if (c.type === "text" && !c.text.trim()) { j++; continue; }
					if (c.type === "thinking" && !(c as any).thinking?.trim()) { j++; continue; }
					// Stop at any non-toolCall visible chunk
					if (c.type !== "toolCall") break;
					const tc = c as ToolCall;
					// Only group if same name as first
					if (run.length > 0 && tc.name !== run[0].name) break;
					const pending = this.pendingToolCalls?.has(tc.id) ?? false;
					const result = this.toolResultsById?.get(tc.id);
					if (pending && !result) break; // still in-flight — stop grouping here
					run.push(tc);
					j++;
				}

				const canGroup =
					!this.isStreaming &&
					run.length >= MIN_GROUP_SIZE &&
					GROUPABLE_TOOLS.has(run[0].name) &&
					run.every((tc) => {
						const pending = this.pendingToolCalls?.has(tc.id) ?? false;
						const result = this.toolResultsById?.get(tc.id);
						return !pending && !!result;
					});

				if (canGroup) {
					orderedParts.push(
						html`<tool-group
							.toolName=${run[0].name}
							.toolCalls=${run}
							.tools=${this.tools || []}
							.toolResultsById=${this.toolResultsById}
						></tool-group>`,
					);
					i = j;
				} else {
					// Render individually (single call, or streaming, or not groupable)
					const tc = chunk as ToolCall;
					const tool = this.tools?.find((t) => t.name === tc.name);
					const pending = this.pendingToolCalls?.has(tc.id) ?? false;
					const result = this.toolResultsById?.get(tc.id);
					if (this.hidePendingToolCalls && pending && !result) {
						i++;
						continue;
					}
					const aborted = this.message.stopReason === "aborted" && !result;
					orderedParts.push(
						html`<tool-message
							.tool=${tool}
							.toolCall=${tc}
							.result=${result}
							.partialResult=${this.toolPartialResults?.[tc.id]}
							.pending=${pending}
							.aborted=${aborted}
							.isStreaming=${this.isStreaming}
						></tool-message>`,
					);
					i++;
				}
			} else {
				i++;
			}
		}

		if (hasSuggestGoal) {
			orderedParts.push(html`
				<button class="suggest-goal-btn" @click=${(e: Event) => {
					e.stopPropagation();
					this.dispatchEvent(new CustomEvent('suggest-goal', { bubbles: true, composed: true }));
				}}>+ Create Goal</button>
			`);
		}

		return html`
			<div>
				${orderedParts.length ? html` <div class="px-2 sm:px-4 flex flex-col gap-3">${orderedParts}</div> ` : ""}
				${!this.isStreaming && this.message.timestamp ? html`<div class="px-2 sm:px-4 text-right"><span class="message-timestamp">${formatTimestamp(this.message.timestamp)}</span></div>` : ""}
				${
					this.isStreaming && this.turnStartTime
						? html` <div class="px-2 sm:px-4 -mt-2 text-xs text-muted-foreground text-right tabular-nums">
							<live-timer .startTime=${this.turnStartTime} .running=${true}></live-timer>
						</div> `
						: ""
				}
				${
					this.message.stopReason === "error" && this.message.errorMessage
						? html`
							<div class="mx-2 sm:mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden">
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0">
										<strong>${i18n("Error:")}</strong> ${this.message.errorMessage}
									</div>
									${this.onRetry ? html`
										<button
											class="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${this._retrying ? 'bg-destructive/10 text-destructive/60' : 'bg-destructive/15 hover:bg-destructive/25 text-destructive'}"
											?disabled=${this._retrying}
											@click=${() => { this._retrying = true; this.onRetry!(); }}
										>
											${this._retrying ? html`
												<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
													<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
													<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
												</svg>
												Retrying…
											` : html`
												<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
													<path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M20.015 4.356v4.992" />
												</svg>
												Retry
											`}
										</button>
									` : ""}
								</div>
							</div>
						`
						: ""
				}
				${
					this.message.stopReason === "aborted"
						? html`<span class="text-sm text-destructive italic">${i18n("Request aborted")}</span>`
						: ""
				}
			</div>
		`;
	}
}

@customElement("tool-message-debug")
export class ToolMessageDebugView extends LitElement {
	@property({ type: Object }) callArgs: any;
	@property({ type: Object }) result?: ToolResultMessageType;
	@property({ type: Boolean }) hasResult: boolean = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM for shared styles
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	private pretty(value: unknown): { content: string; isJson: boolean } {
		try {
			if (typeof value === "string") {
				const maybeJson = JSON.parse(value);
				return { content: JSON.stringify(maybeJson, null, 2), isJson: true };
			}
			return { content: JSON.stringify(value, null, 2), isJson: true };
		} catch {
			return { content: typeof value === "string" ? value : String(value), isJson: false };
		}
	}

	override render() {
		const textOutput =
			this.result?.content
				?.filter((c) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";
		const output = this.pretty(textOutput);
		const details = this.pretty(this.result?.details);

		return html`
			<div class="mt-3 flex flex-col gap-2">
				<div>
					<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Call")}</div>
					<code-block .code=${this.pretty(this.callArgs).content} language="json"></code-block>
				</div>
				<div>
					<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Result")}</div>
					${
						this.hasResult
							? html`<code-block .code=${output.content} language="${output.isJson ? "json" : "text"}"></code-block>
								<code-block .code=${details.content} language="${details.isJson ? "json" : "text"}"></code-block>`
							: html`<div class="text-xs text-muted-foreground">${i18n("(no result)")}</div>`
					}
				</div>
			</div>
		`;
	}
}

@customElement("tool-message")
export class ToolMessage extends LitElement {
	@property({ type: Object }) toolCall!: ToolCall;
	@property({ type: Object }) tool?: AgentTool<any>;
	@property({ type: Object }) result?: ToolResultMessageType;
	@property({ type: Object }) partialResult?: any;
	@property({ type: Boolean }) pending: boolean = false;
	@property({ type: Boolean }) aborted: boolean = false;
	@property({ type: Boolean }) isStreaming: boolean = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private _onPreviewReady = () => { this.requestUpdate(); };

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		document.addEventListener("bobbit-tool-preview-ready", this._onPreviewReady);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener("bobbit-tool-preview-ready", this._onPreviewReady);
	}

	override render() {
		const toolName = this.tool?.name || this.toolCall.name;

		// Render tool content (renderer handles errors and styling)
		// Use partialResult as a synthetic ToolResultMessage during streaming
		// so renderers can show progress (e.g., delegate cards completing one by one)
		let result: ToolResultMessageType<any> | undefined;
		if (this.aborted) {
			result = { role: "toolResult", isError: true, content: [], toolCallId: this.toolCall.id, toolName: this.toolCall.name, timestamp: Date.now() };
		} else if (this.result) {
			result = this.result;
		} else if (this.partialResult) {
			result = {
				role: "toolResult",
				isError: false,
				content: this.partialResult.content || [],
				toolCallId: this.toolCall.id,
				toolName: this.toolCall.name,
				timestamp: Date.now(),
				details: this.partialResult.details,
			} as ToolResultMessageType<any>;
		}
		const renderResult = renderTool(
			toolName,
			this.toolCall.arguments,
			result,
			!this.aborted && (this.isStreaming || this.pending),
		);

		// Handle custom rendering (no card wrapper)
		if (renderResult.isCustom) {
			return renderResult.content;
		}

		// Default: wrap in card
		return html`
			<div class="p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs">
				${renderResult.content}
			</div>
		`;
	}
}

@customElement("aborted-message")
export class AbortedMessage extends LitElement {
	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	protected override render(): unknown {
		return html`<span class="text-sm text-destructive italic">${i18n("Request aborted")}</span>`;
	}
}

// ============================================================================
// Default Message Transformer
// ============================================================================

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

/**
 * Convert attachments to content blocks for LLM.
 * - Images become ImageContent blocks
 * - Documents with extractedText become TextContent blocks with filename header
 */
export function convertAttachments(attachments: Attachment[]): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	for (const attachment of attachments) {
		if (attachment.type === "image") {
			content.push({
				type: "image",
				data: attachment.content,
				mimeType: attachment.mimeType,
			} as ImageContent);
		} else if (attachment.type === "document" && attachment.extractedText) {
			content.push({
				type: "text",
				text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
			} as TextContent);
		}
	}
	return content;
}

/**
 * Check if a message is a UserMessageWithAttachments.
 */
export function isUserMessageWithAttachments(msg: AgentMessage): msg is UserMessageWithAttachments {
	return (msg as UserMessageWithAttachments).role === "user-with-attachments";
}

/**
 * Check if a message is an ArtifactMessage.
 */
export function isArtifactMessage(msg: AgentMessage): msg is ArtifactMessage {
	return (msg as ArtifactMessage).role === "artifact";
}

/**
 * Default convertToLlm for web-ui apps.
 *
 * Handles:
 * - UserMessageWithAttachments: converts to user message with content blocks
 * - ArtifactMessage: filtered out (UI-only, for session reconstruction)
 * - Standard LLM messages (user, assistant, toolResult): passed through
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.filter((m) => {
			// Filter out artifact messages - they're for session reconstruction only
			if (isArtifactMessage(m)) {
				return false;
			}
			return true;
		})
		.map((m): Message | null => {
			// Convert user-with-attachments to user message with content blocks
			if (isUserMessageWithAttachments(m)) {
				const textContent: (TextContent | ImageContent)[] =
					typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];

				if (m.attachments) {
					textContent.push(...convertAttachments(m.attachments));
				}

				return {
					role: "user",
					content: textContent,
					timestamp: m.timestamp,
				} as Message;
			}

			// Pass through standard LLM roles
			if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
				return m as Message;
			}

			// Filter out unknown message types
			return null;
		})
		.filter((m): m is Message => m !== null);
}
