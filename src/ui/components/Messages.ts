import type {
	AssistantMessage as AssistantMessageType,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage as ToolResultMessageType,
	UserMessage as UserMessageType,
} from "@earendil-works/pi-ai";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { ensureMarkdownBlock } from "../lazy/markdown-block.js";
import { renderTool } from "../tools/index.js";
import { TOOL_RENDERER_LOADED_EVENT, TOOL_RENDER_REQUESTED_EVENT } from "../tools/renderer-registry.js";
import type { Attachment } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import { fetchToolContent } from "../utils/fetch-tool-content.js";
import { state as appState, renderApp } from "../../app/state.js";
import { getHostApi } from "../../app/host-api.js";
import { packIdForTool } from "../../app/pack-renderers.js";
import "./ThinkingBlock.js";
import "./LiveTimer.js";
import "./ToolGroup.js";
import "./SkillChip.js";
import type { SkillChipData } from "./SkillChip.js";
import "./FileMentionChip.js";
import type { FileMentionChipData, FileMentionKind } from "./FileMentionChip.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BobbitMessage, MessageAuthor } from "../../shared/message-author.js";
import type { PromptAuthorAppearance } from "../../app/message-author-appearance.js";
import { getAccessoryDef, renderStaticSidebarBobbitCanvas } from "../bobbit-render.js";
import { presentPromptAuthor } from "../message-author-presentation.js";

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
const GROUPABLE_TOOLS = new Set(["read", "edit", "write", "bash", "ls", "find", "grep", "team_delegate"]);

/**
 * Persisted record of a user-typed slash-skill invocation. Mirrors the
 * server-side SkillExpansion shape — `range` uses UTF-16 code-unit offsets
 * into the original `text`, matching `String.prototype.slice`.
 */
export interface SkillExpansion {
	name: string;
	args: string;
	source?: string;
	filePath?: string;
	range: [number, number];
	expanded: string;
}

/**
 * Persisted record of a user-typed `@path` file reference. Mirrors the
 * server-side `FileMention` shape — `range` uses UTF-16 code-unit offsets
 * into the original `text`, matching `String.prototype.slice`. The UI
 * re-declares this structurally-identical interface (it does NOT import the
 * server module) so the JSON crosses the wire unchanged.
 */
export interface FileMention {
	path: string;
	absPath?: string;
	range: [number, number];
	kind: FileMentionKind;
	content?: string;
	data?: string;
	mimeType?: string;
	bytes?: number;
	reason?: string;
}

export type UserMessageWithAttachments = {
	role: "user-with-attachments";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	attachments?: Attachment[];
	skillExpansions?: SkillExpansion[];
	fileMentions?: FileMention[];
	author?: MessageAuthor;
};

// Artifact message type for session persistence
export interface ArtifactMessage {
	role: "artifact";
	action: "create" | "update" | "delete";
	filename: string;
	content?: string;
	title?: string;
	timestamp: string;
	author?: MessageAuthor;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		"user-with-attachments": UserMessageWithAttachments;
		artifact: ArtifactMessage;
	}
}

/**
 * A single chip to splice into the user text at a recorded UTF-16 range.
 * Generalised so both `<skill-chip>` (slash skills) and `<file-mention-chip>`
 * (`@path` references) flow through one robust splice path.
 */
interface ChipItem {
	range: [number, number];
	render: () => TemplateResult;
}

let markedParseInline: ((text: string) => string) | null = null;
let markedInlineLoadStarted = false;

function ensureMarkedInlineLoaded(): void {
	if (markedParseInline || markedInlineLoadStarted) return;
	markedInlineLoadStarted = true;
	void import("marked")
		.then(({ marked }) => {
			markedParseInline = (text: string) => marked.parseInline(text, { async: false }) as string;
			renderApp();
		})
		.catch((err) => {
			markedInlineLoadStarted = false;
			console.warn("[Messages] failed to load marked inline renderer", err);
		});
}

function renderPlainInlineWithBreaks(text: string): TemplateResult {
	const lines = text.split("\n");
	return html`${lines.map((line, index) => html`${index > 0 ? html`<br>` : ""}${line}`)}`;
}

/**
 * Render `text` with chip elements spliced in at each item's recorded UTF-16
 * character range. Plain-text gaps are rendered as inline HTML so user
 * formatting is preserved exactly as today; line breaks become `<br>` via the
 * trailing-spaces trick used in render().
 *
 * Robustness: any item whose range is invalid (out of bounds, inverted, or
 * overlapping a previously-accepted item) is dropped with a warning — the
 * surrounding plain text still renders. This guarantees we never crash a user
 * bubble because of a malformed sidecar entry.
 */
function renderTextWithChips(
	text: string,
	items: ChipItem[],
): TemplateResult {
	const valid: ChipItem[] = [];
	let lastEnd = 0;
	// Sort by range start so we can splice left-to-right and detect overlap.
	// Skill and file-mention items cannot overlap by construction (`/` vs `@`
	// triggers), but the guard below drops any that do regardless of source.
	const sorted = [...items].sort((a, b) => a.range[0] - b.range[0]);
	for (const item of sorted) {
		const [start, end] = item.range;
		if (
			typeof start !== "number" ||
			typeof end !== "number" ||
			start < 0 ||
			end > text.length ||
			start >= end ||
			start < lastEnd
		) {
			console.warn("[Messages] dropping invalid chip range", item.range);
			continue;
		}
		valid.push(item);
		lastEnd = end;
	}

	if (valid.length === 0) {
		const c = text.replace(/\n/g, "  \n");
		return html`<markdown-block .content=${c}></markdown-block>`;
	}

	// Render gap text as inline HTML so it flows next to the chip on the same
	// line. Block-level markdown (headers/lists) is unusual in user messages;
	// `parseInline` covers emphasis, code, links, and line breaks via the
	// trailing-spaces trick. We emit a <span> per gap so the wrapping flex
	// container can break between words naturally on mobile.
	const parts: TemplateResult[] = [];
	let cursor = 0;
	const renderGap = (slice: string): TemplateResult => {
		const withBreaks = slice.replace(/\n/g, "  \n");
		if (!markedParseInline) {
			ensureMarkedInlineLoaded();
			return html`<span class="skill-chip-gap">${renderPlainInlineWithBreaks(slice)}</span>`;
		}
		const inlineHtml = markedParseInline(withBreaks);
		return html`<span class="skill-chip-gap">${unsafeHTML(inlineHtml)}</span>`;
	};
	for (const item of valid) {
		const [s, eIdx] = item.range;
		if (s > cursor) parts.push(renderGap(text.slice(cursor, s)));
		parts.push(item.render());
		cursor = eIdx;
	}
	if (cursor < text.length) parts.push(renderGap(text.slice(cursor)));
	return html`<div class="skill-chip-flow flex flex-wrap items-baseline gap-x-1 gap-y-1 markdown-content">${parts}</div>`;
}

/** Build the merged chip list from a user message's skill expansions and file
 *  mentions. Each entry carries its splice `range` plus a renderer for the chip
 *  element. Kept pure so the splice path stays the single source of truth. */
function buildChipItems(
	expansions: SkillExpansion[] | undefined,
	mentions: FileMention[] | undefined,
): ChipItem[] {
	const items: ChipItem[] = [];
	for (const e of expansions ?? []) {
		const data: SkillChipData = {
			name: e.name,
			args: e.args,
			source: e.source,
			filePath: e.filePath,
			expanded: e.expanded,
		};
		items.push({ range: e.range, render: () => html`<skill-chip .data=${data}></skill-chip>` });
	}
	for (const m of mentions ?? []) {
		const data: FileMentionChipData = {
			path: m.path,
			kind: m.kind,
			content: m.content,
			data: m.data,
			mimeType: m.mimeType,
			bytes: m.bytes,
			reason: m.reason,
		};
		items.push({ range: m.range, render: () => html`<file-mention-chip .data=${data}></file-mention-chip>` });
	}
	return items;
}

@customElement("user-message")
export class UserMessage extends LitElement {
	@property({ type: Object }) message!: BobbitMessage<UserMessageWithAttachments | UserMessageType>;
	@property({ type: Boolean }) showAuthorLabel = false;
	@property({ attribute: false }) authorAppearance?: PromptAuthorAppearance;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		ensureMarkdownBlock();
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

		const withAttachments = this.message as UserMessageWithAttachments;
		const chipItems = buildChipItems(withAttachments.skillExpansions, withAttachments.fileMentions);
		const body =
			chipItems.length
				? renderTextWithChips(rawContent, chipItems)
				: html`<markdown-block .content=${content}></markdown-block>`;
		// Rich attachments (optimistic preview / restored) win; otherwise derive
		// tiles from server-authoritative image content blocks so a bare role:user
		// echo still renders its image live (WP1 / RC2 / S6).
		const richAttachments =
			this.message.role === "user-with-attachments" && this.message.attachments
				? this.message.attachments
				: [];
		const tiles = richAttachments.length > 0
			? richAttachments
			: imageAttachmentsFromContent(this.message.content);
		const attachments = tiles.length > 0
			? html`
				<div class="mt-3 flex flex-wrap gap-2">
					${tiles.map(
						(attachment) => html` <attachment-tile .attachment=${attachment}></attachment-tile> `,
					)}
				</div>
			`
			: "";

		const presentation = this.showAuthorLabel
			? presentPromptAuthor(this.message.author)
			: undefined;
		if (!presentation) {
			// Keep the historical all-human/legacy markup and compact geometry exact.
			return html`
				<div class="flex justify-start mx-2 sm:mx-4 my-1">
					<div class="user-message-container py-2 px-3 sm:px-4">
						${body}
						${attachments}
					</div>
					<span class="message-timestamp">${formatTimestamp(this.message.timestamp)}</span>
				</div>
			`;
		}

		const isAgent = presentation.kind === "agent";
		return html`
			<div class="prompt-row prompt-row--labelled flex justify-start mx-2 sm:mx-4 my-1">
				<div class="prompt-bubble-shell">
					<div
						class="prompt-author-badge"
						aria-label=${presentation.accessibleName}
						title=${presentation.visibleName}
					>
						${isAgent ? html`
							<span class="prompt-author-avatar" aria-hidden="true">
								${renderStaticSidebarBobbitCanvas({
									hueRotate: this.authorAppearance?.hueRotate ?? 0,
									accessory: getAccessoryDef(this.authorAppearance?.accessoryId),
								})}
							</span>
							<span class="prompt-author-name">${presentation.normalizedAgentLabel}</span>
							<span class="prompt-author-divider" aria-hidden="true">|</span>
							<span class="prompt-author-kind">Agent</span>
						` : html`
							<span class="prompt-author-name">${presentation.visibleName}</span>
						`}
					</div>
					<div class="user-message-container user-message-container--labelled py-2 px-3 sm:px-4">
						${body}
						${attachments}
					</div>
				</div>
				<span class="message-timestamp">${formatTimestamp(this.message.timestamp)}</span>
			</div>
		`;
	}
}

@customElement("assistant-message")
export class AssistantMessage extends LitElement {
	@property({ type: Object }) message!: BobbitMessage<AssistantMessageType>;
	@property({ type: Array }) tools?: AgentTool<any>[];
	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Object }) permissionBlockedTools?: Set<string>;
	@property({ type: Boolean }) hideToolCalls = false;
	@property({ type: Object }) toolResultsById?: Map<string, BobbitMessage<ToolResultMessageType>>;
	@property({ type: Object }) toolPartialResults?: Record<string, any>;
	@property({ type: Boolean }) isStreaming: boolean = false;
	@property({ type: Boolean }) hidePendingToolCalls = false;
	@property({ attribute: false }) onCostClick?: () => void;
	@property({ attribute: false }) onRetry?: () => void;
	@property({ type: Number }) turnStartTime: number | null = null;
	/** Hide the destructive-red "Request aborted" banner. Set by the
	 *  message list when the abort was caused by the agent self-aborting to
	 *  run auto-compaction (detected via an immediately-following synthetic
	 *  compaction-summary row) — not a user-initiated Stop. */
	@property({ type: Boolean }) suppressAbortedBanner = false;
	@state() private _retrying = false;

	private _throttledContent: string = "";
	private _contentThrottleTimer: ReturnType<typeof setTimeout> | null = null;

	private _getThrottledContent(text: string): string {
		// Reset throttle when content diverges completely from the snapshot
		// (i.e. a different message was assigned to this element).
		// During streaming, text grows but shares a common prefix with the snapshot.
		const prefix = this._throttledContent.slice(0, 20);
		if (this._contentThrottleTimer && prefix && !text.startsWith(prefix)) {
			clearTimeout(this._contentThrottleTimer);
			this._contentThrottleTimer = null;
		}
		if (!this._contentThrottleTimer) {
			this._throttledContent = text;
			this._contentThrottleTimer = setTimeout(() => {
				this._contentThrottleTimer = null;
			}, 250);
		}
		return this._throttledContent;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		ensureMarkdownBlock();
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		// Hide the spurious overflow-retry error that pi-coding-agent emits
		// from its in-flight pre-compaction transcript right as compaction
		// commits — see remote-agent.ts overflow-recovery suppression. The
		// next clean turn will surface real state.
		if ((this.message as any)._suppressedByOverflowRecovery) {
			return html``;
		}
		// Reset throttle state when streaming stops so final content renders immediately
		if (!this.isStreaming && this._contentThrottleTimer) {
			clearTimeout(this._contentThrottleTimer);
			this._contentThrottleTimer = null;
		}

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
					const mdContent = this.isStreaming ? this._getThrottledContent(displayText) : displayText;
					orderedParts.push(html`<markdown-block .content=${mdContent}></markdown-block>`);
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
					const permissionBlocked = !result && (this.permissionBlockedTools?.has(tc.name) || (this.message as any)._permissionBlocked === true);
					if (this.hidePendingToolCalls && pending && !result && !permissionBlocked) {
						i++;
						continue;
					}
					const aborted = this.message.stopReason === "aborted" && !result;
					orderedParts.push(
						html`<tool-message
							.tool=${tool}
							.toolCall=${tc}
							.callStartTime=${this.message.timestamp}
							.result=${result}
							.partialResult=${this.toolPartialResults?.[tc.id]}
							.pending=${pending}
							.permissionBlocked=${permissionBlocked}
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
					this.message.stopReason === "aborted" && !this.suppressAbortedBanner
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
	@property({ type: Object }) result?: BobbitMessage<ToolResultMessageType>;
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
	@property({ type: Object }) result?: BobbitMessage<ToolResultMessageType>;
	@property({ type: Object }) partialResult?: any;
	@property({ type: Boolean }) pending: boolean = false;
	@property({ type: Boolean }) permissionBlocked: boolean = false;
	@property({ type: Boolean }) aborted: boolean = false;
	@property({ type: Boolean }) isStreaming: boolean = false;
	/** Server-stamped timestamp of the assistant message that issued this call.
	 *  Threaded to renderers as a reload-stable timer anchor (e.g. bash_bg wait). */
	@property({ type: Number }) callStartTime?: number;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private _onPreviewReady = () => { this.requestUpdate(); };

	// When a lazy tool renderer's chunk resolves, the registry dispatches
	// `bobbit-tool-renderer-loaded` on document. Pull our own update so the
	// placeholder is replaced even if a top-level renderApp() short-circuits.
	private _onRendererLoaded = (e: Event) => {
		const detail = (e as CustomEvent).detail;
		const name = this.tool?.name || this.toolCall?.name;
		if (detail?.toolName && name && detail.toolName === name) {
			this.requestUpdate();
		}
	};

	// host.requestRender() (a pack renderer repainting after an action resolves)
	// dispatches this. Pull our own update so the renderer re-runs and paints its
	// updated renderer-local state — props are unchanged so renderApp() alone
	// would not re-run it (design §4a).
	private _onRenderRequested = () => { this.requestUpdate(); };

	// For the non-blocking ask_user_choices widget: when a new message arrives,
	// the tool_use card may need to flip to Answered mode because the transcript
	// now contains a matching `[ask_user_choices_response ...]` envelope.
	// ToolMessage's reactive properties (toolCall, result) don't change on new
	// messages, so we listen explicitly and requestUpdate.
	private _onTranscriptMessage = () => {
		if (this.toolCall?.name === "ask_user_choices") this.requestUpdate();
	};

	private _onLoadFullContent = (e: Event) => {
		e.stopPropagation();
		this._loadFullContent();
	};

	private async _loadFullContent(): Promise<void> {
		const sessionId = appState.remoteAgent?.gatewaySessionId;
		if (!sessionId) return;

		// Find the message index and block index for this tool call
		const messages = appState.remoteAgent?.state?.messages;
		if (!messages) return;

		let messageIndex = -1;
		let blockIndex = -1;
		for (let mi = 0; mi < messages.length; mi++) {
			const msg = messages[mi];
			if (!Array.isArray(msg.content)) continue;
			for (let bi = 0; bi < msg.content.length; bi++) {
				const block = msg.content[bi];
				if (block.type === "toolCall" && block.id === this.toolCall.id) {
					messageIndex = mi;
					blockIndex = bi;
					break;
				}
			}
			if (messageIndex >= 0) break;
		}

		if (messageIndex < 0 || blockIndex < 0) return;

		try {
			const fullContent = await fetchToolContent(sessionId, messageIndex, blockIndex);
			// Replace truncated content with full content in the arguments
			if (this.toolCall.arguments) {
				this.toolCall.arguments.content = fullContent;
			}
			this.requestUpdate();
		} catch {
			// Reset button state so user can retry
			this.requestUpdate();
		}
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		document.addEventListener("bobbit-tool-preview-ready", this._onPreviewReady);
		document.addEventListener("bobbit-transcript-message", this._onTranscriptMessage);
		document.addEventListener(TOOL_RENDERER_LOADED_EVENT, this._onRendererLoaded);
		document.addEventListener(TOOL_RENDER_REQUESTED_EVENT, this._onRenderRequested);
		this.addEventListener("load-full-content", this._onLoadFullContent);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener("bobbit-tool-preview-ready", this._onPreviewReady);
		document.removeEventListener("bobbit-transcript-message", this._onTranscriptMessage);
		document.removeEventListener(TOOL_RENDERER_LOADED_EVENT, this._onRendererLoaded);
		document.removeEventListener(TOOL_RENDER_REQUESTED_EVENT, this._onRenderRequested);
		this.removeEventListener("load-full-content", this._onLoadFullContent);
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
		const sessionIdCtx = appState.remoteAgent?.gatewaySessionId;
		const getAskResponseAnswers = appState.remoteAgent?.findAskResponseAnswers?.bind(appState.remoteAgent);
		// Thread current session's goalId so renderers (e.g. goal_plan_propose's
		// approval flow) can target the right goal. Looked up via the session
		// record (single source of truth) rather than tracked on remote-agent.
		let goalIdCtx: string | undefined;
		if (sessionIdCtx) {
			const rec = appState.gatewaySessions.find((s: any) => s.id === sessionIdCtx)
				?? appState.archivedSessions.find((s: any) => s.id === sessionIdCtx);
			goalIdCtx = (rec as any)?.goalId || (rec as any)?.teamGoalId || undefined;
		}
		const renderResult = renderTool(
			toolName,
			this.toolCall.arguments,
			result,
			!this.aborted && (this.isStreaming || this.pending || this.permissionBlocked),
			{
				toolUseId: this.toolCall.id,
				toolCallInput: (this.toolCall as any).input,
				toolCallStartTime: this.callStartTime,
				sessionId: sessionIdCtx,
				goalId: goalIdCtx,
				getAskResponseAnswers,
				packTool: toolName,
				host: getHostApi(sessionIdCtx, this.toolCall.id, { kind: "tool", tool: toolName, packId: packIdForTool(toolName) }),
			},
		);

		// Handle custom rendering (no card wrapper)
		if (renderResult.isCustom) {
			return renderResult.content;
		}

		// Default: wrap in card
		return html`
			<div data-tool-name="${toolName}" class="p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs">
				${this.permissionBlocked ? html`
					<div class="mb-2 px-2 py-1 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400">
						Waiting for permission before running this tool.
					</div>
				` : nothing}
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

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

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
 * Build attachment tiles from a user message's image content blocks. Mirrors
 * message-reducer.ts::enrichUserMessage field-for-field so a live `role:"user"`
 * echo renders identically to a reloaded one (WP1 / RC2 — removes the render's
 * dependency on the racy `_pendingAttachments` slot; closes S6).
 */
export function imageAttachmentsFromContent(content: unknown): Attachment[] {
	if (!Array.isArray(content)) return [];
	const out: Attachment[] = [];
	let i = 0;
	for (const c of content) {
		const img = c as { type?: string; data?: string; mimeType?: string; media_type?: string };
		if (img && img.type === "image" && img.data) {
			out.push({
				id: `restored_${i}`,
				type: "image",
				fileName: `image-${i + 1}.png`,
				mimeType: img.mimeType || img.media_type || "image/png",
				size: img.data.length || 0,
				content: img.data,
				preview: img.data,
			});
			i++;
		}
	}
	return out;
}

/**
 * Check if a message is a UserMessageWithAttachments.
 */
export function isUserMessageWithAttachments(msg: BobbitMessage<AgentMessage>): msg is BobbitMessage<UserMessageWithAttachments> {
	return (msg as UserMessageWithAttachments).role === "user-with-attachments";
}

/**
 * Check if a message is an ArtifactMessage.
 */
export function isArtifactMessage(msg: BobbitMessage<AgentMessage>): msg is BobbitMessage<ArtifactMessage> {
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
export function defaultConvertToLlm(messages: BobbitMessage<AgentMessage>[]): Message[] {
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

			// Pass through standard LLM roles, defensively removing Bobbit-only
			// metadata before a message can cross the provider boundary.
			if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
				const { author: _author, ...providerMessage } = m;
				return providerMessage as Message;
			}

			// Filter out unknown message types
			return null;
		})
		.filter((m): m is Message => m !== null);
}
