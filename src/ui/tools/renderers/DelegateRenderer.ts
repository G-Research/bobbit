import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { icon } from "@mariozechner/mini-lit";
import { Bot, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Loader } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import {
	type DelegateCardEntry,
	formatDuration,
	statusColor,
	summarizeInstructions,
	renderRunningCard,

	renderDelegateCardList,
	renderSessionLink,
} from "./delegate-cards.js";

interface DelegateParams {
	instructions: string;
	parallel?: Array<{ instructions: string; context?: Record<string, string> }>;
	context?: Record<string, string>;
	timeout_minutes?: number;
}

interface DelegateDetailsEntry {
	id: string;
	sessionId?: string;
	instructions: string;
	status: string;
	durationMs: number;
}

interface DelegateDetails {
	delegates: DelegateDetailsEntry[];
}

function getTextOutput(result: ToolResultMessage<any> | undefined): string {
	if (!result) return "";
	return result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
}

// Claude SDK child activity is deliberately rendered here, within the existing
// tool renderer path. These structural types tolerate snapshots from older
// gateways while the client projection is being rolled out; the exact parent
// key is still mandatory before anything is mounted.
interface EmbeddedAgentActivity {
	parentToolUseId?: string;
	parent_tool_use_id?: string;
	agentId?: string;
	agent_id?: string;
	agentType?: string;
	displayLabel?: string;
	state?: string;
	startedAt?: number;
	stoppedAt?: number;
	error?: string;
	failureReason?: string;
	orderedMessages?: unknown[];
	messages?: unknown[];
}

const CANONICAL_SDK_TOOL_NAMES = new Set([
	"bash", "readonly_bash", "read", "write", "edit", "ls", "find", "grep",
	"browser_screenshot", "browser_navigate", "browser_click", "browser_type", "browser_eval", "browser_wait",
	"web_search", "web_fetch", "bash_bg",
]);

function canonicalToolName(name: unknown): string {
	if (typeof name !== "string") return "unknown";
	const match = /^mcp__bobbit__([a-z0-9_]+)$/.exec(name);
	return match && CANONICAL_SDK_TOOL_NAMES.has(match[1]) ? match[1] : name;
}

function asRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

/** Return only activity explicitly keyed to this exact root tool-use id. */
function workForParent(source: unknown, parentToolUseId: string): EmbeddedAgentActivity[] {
	let candidate: unknown;
	if (source instanceof Map) candidate = source.get(parentToolUseId);
	else {
		const record = asRecord(source);
		if (!record) return [];
		candidate = record.byParentToolUseId?.[parentToolUseId]
			?? record.byParent?.[parentToolUseId]
			?? record[parentToolUseId]
			?? (record.parentToolUseId === parentToolUseId ? record : undefined);
	}
	const record = asRecord(candidate);
	const parent = record?.parentToolUseId ?? record?.parent_tool_use_id;
	// A keyed map is an authoritative partition; a direct object must carry its
	// own matching parent id so proximity can never attach work to the wrong card.
	if (parent !== undefined && parent !== parentToolUseId) return [];
	const activities = Array.isArray(candidate)
		? candidate
		: record?.children ?? record?.agents ?? record?.activities ?? [];
	return Array.isArray(activities) ? activities.filter((activity): activity is EmbeddedAgentActivity => {
		const child = asRecord(activity);
		if (!child) return false;
		const childParent = child.parentToolUseId ?? child.parent_tool_use_id ?? parent;
		return childParent === parentToolUseId;
	}) : [];
}

function safeLabel(activity: EmbeddedAgentActivity): string {
	const label = typeof activity.displayLabel === "string" ? activity.displayLabel.trim() : "";
	return label && label.length <= 120 ? label : "Agent helper";
}

function displayState(state: unknown): string {
	switch (state) {
		case "starting": return "Starting";
		case "working": return "Working";
		case "completed": return "Completed";
		case "failed": return "Failed";
		case "stopped": return "Stopped";
		default: return "Status unavailable";
	}
}

function isTerminal(activity: EmbeddedAgentActivity): boolean {
	return activity.state === "completed" || activity.state === "failed" || activity.state === "stopped";
}

function stableDomId(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
	return `embedded-agent-activity-${(hash >>> 0).toString(36)}`;
}

function toolResultFor(message: Record<string, any>): ToolResultMessage<any> | undefined {
	if (message.role !== "toolResult" && message.type !== "toolResult" && message.type !== "tool_result") return undefined;
	const toolCallId = message.toolCallId ?? message.tool_use_id ?? message.toolUseId;
	if (typeof toolCallId !== "string") return undefined;
	return {
		role: "toolResult",
		toolCallId,
		toolName: canonicalToolName(message.toolName ?? message.name),
		isError: message.isError === true || message.error === true,
		content: Array.isArray(message.content) ? message.content : typeof message.text === "string" ? [{ type: "text", text: message.text }] : [],
		timestamp: message.timestamp ?? Date.now(),
		details: message.details,
	};
}

/** Activity body: child-local messages are rendered through existing markdown,
 * thinking, and tool-message components, never the root assistant renderer. */
class EmbeddedAgentActivitySection extends LitElement {
	@property({ type: Object }) activity!: EmbeddedAgentActivity;
	@property({ type: Boolean }) parentStreaming = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment { return this; }

	override connectedCallback(): void { super.connectedCallback(); this.style.display = "block"; }

	private _messages(): Record<string, any>[] {
		const messages = this.activity?.orderedMessages ?? this.activity?.messages ?? [];
		return Array.isArray(messages) ? messages.map(asRecord).filter((m): m is Record<string, any> => !!m) : [];
	}

	override render(): TemplateResult {
		const messages = this._messages();
		const results = new Map<string, ToolResultMessage<any>>();
		for (const message of messages) {
			const result = toolResultFor(message);
			if (result) results.set(result.toolCallId, result);
		}
		const parts: TemplateResult[] = [];
		for (const message of messages) {
			if (toolResultFor(message)) continue;
			const blocks = message.role === "assistant" && Array.isArray(message.content)
				? message.content : [message];
			for (const block of blocks) {
				if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
					parts.push(html`<markdown-block .content=${block.text}></markdown-block>`);
				} else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
					parts.push(html`<thinking-block .content=${block.thinking} .isStreaming=${this.parentStreaming && !isTerminal(this.activity)}></thinking-block>`);
				} else if (block?.type === "toolCall" || block?.type === "tool_call") {
					const id = block.id ?? block.toolUseId ?? block.tool_use_id;
					if (typeof id !== "string") continue;
					const result = results.get(id);
					const terminalWithoutResult = isTerminal(this.activity) && !result;
					const call = { ...block, id, name: canonicalToolName(block.name ?? block.toolName), arguments: block.arguments ?? block.input ?? {} } as ToolCall;
					const dangling = terminalWithoutResult ? {
						role: "toolResult", toolCallId: id, toolName: call.name, isError: true,
						content: [{ type: "text", text: "Tool call ended before a result was received." }], timestamp: Date.now(),
						} as ToolResultMessage<any> : result;
					parts.push(html`<div class="py-1.5"><tool-message
						.toolCall=${call}
						.result=${dangling}
						.pending=${!dangling && !isTerminal(this.activity)}
						.isStreaming=${this.parentStreaming && !isTerminal(this.activity)}
						.embedded=${true}
					></tool-message></div>`);
				}
			}
		}
		const failure = this.activity.error ?? this.activity.failureReason;
		return html`
			<section class="border-l border-border pl-3" data-subagent-agent-id=${this.activity.agentId ?? this.activity.agent_id ?? "unknown"}>
				<div class="flex items-center gap-2 text-xs font-medium">
					<span class="truncate" title=${safeLabel(this.activity)}>${safeLabel(this.activity)}</span>
					<span class="text-muted-foreground">${displayState(this.activity.state)}</span>
				</div>
				${failure ? html`<p class="mt-1 text-sm text-destructive break-words" role="alert">${String(failure).slice(0, 500)}</p>` : nothing}
				${parts.length ? html`<div class="mt-2 flex flex-col gap-2">${parts}</div>` : nothing}
			</section>`;
	}
}

class EmbeddedAgentCard extends LitElement {
	@property({ type: String }) parentToolUseId = "";
	@property({ type: Array }) activities: EmbeddedAgentActivity[] = [];
	@property({ type: String }) parentState = "starting";
	@property({ type: String }) parentOutput = "";
	@state() private _expanded = true;
	@state() private _userToggled = false;
	private _lastParent = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment { return this; }

	override connectedCallback(): void { super.connectedCallback(); this.style.display = "block"; this._applyDefault(); }
	override updated(changed: Map<string, unknown>): void {
		if (changed.has("parentToolUseId") && this._lastParent !== this.parentToolUseId) this._applyDefault();
	}

	private _applyDefault(): void {
		this._lastParent = this.parentToolUseId;
		if (this._userToggled) return;
		this._expanded = this.parentState !== "completed";
	}

	private _toggle(): void { this._userToggled = true; this._expanded = !this._expanded; }

	override render(): TemplateResult {
		const count = this.activities.reduce((total, activity) => total + (activity.orderedMessages ?? activity.messages ?? []).flatMap((m: any) => m?.content ?? [m]).filter((b: any) => b?.type === "toolCall" || b?.type === "tool_call").length, 0);
		const failed = this.activities.filter((activity) => activity.state === "failed").length;
		const role = safeLabel(this.activities[0] ?? {});
		const status = this.parentState === "completed" ? "Completed"
			: this.parentState === "failed" ? "Failed"
			: this.parentState === "stopped" ? "Stopped"
			: failed ? `Working · ${failed} failed`
			: this.activities.some((activity) => !isTerminal(activity)) ? `Working${count ? ` · ${count} tools` : ""}`
			: this.activities.length ? `Finishing…${count ? ` · ${count} tools` : ""}`
			: "Starting…";
		const regionId = stableDomId(this.parentToolUseId);
		const iconName = this.parentState === "completed" ? CheckCircle2 : this.parentState === "failed" ? CircleAlert : Bot;
		const iconClass = this.parentState === "completed" ? "text-green-600 dark:text-green-500" : this.parentState === "failed" ? "text-destructive" : "text-foreground";
		const busy = this.parentState === "starting" || this.parentState === "working";
		return html`
			<div data-subagent-parent-tool-use-id=${this.parentToolUseId} data-subagent-state=${this.parentState} data-subagent-count=${String(this.activities.length)}>
				<button
					type="button"
					class="w-full min-h-11 flex items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] rounded"
					aria-expanded=${String(this._expanded)}
					aria-controls=${regionId}
					aria-label=${`Agent, ${role}, ${status.toLowerCase()}, ${count} tools`}
					@click=${this._toggle}
				>
					<span class=${iconClass} aria-hidden="true">${icon(iconName, "sm")}</span>
					<span class="min-w-0 truncate"><strong>Agent</strong> · <span title=${role}>${role}</span></span>
					<span class="ml-auto shrink-0 text-xs">${status}</span>
					${busy ? html`<span class="text-foreground animate-spin" aria-hidden="true">${icon(Loader, "sm")}</span>` : nothing}
					<span aria-hidden="true">${icon(this._expanded ? ChevronUp : ChevronDown, "sm")}</span>
				</button>
				<span class="sr-only" role="status" aria-live="polite" aria-atomic="true">${status}</span>
				<div id=${regionId} ?hidden=${!this._expanded} aria-busy=${String(busy)} class="mt-3 space-y-3">
					${this.activities.map((activity) => html`<embedded-agent-activity-section .activity=${activity} .parentStreaming=${busy}></embedded-agent-activity-section>`)}
					${this.parentOutput ? html`<div class="text-sm ${this.parentState === "failed" ? "text-destructive" : "text-muted-foreground"}"><markdown-block .content=${this.parentOutput}></markdown-block></div>` : nothing}
				</div>
			</div>`;
	}
}

if (!customElements.get("embedded-agent-activity-section")) customElements.define("embedded-agent-activity-section", EmbeddedAgentActivitySection);
if (!customElements.get("embedded-agent-card")) customElements.define("embedded-agent-card", EmbeddedAgentCard);

/** Display-only renderer for the SDK-native Agent (and legacy Task) call. */
export class ClaudeSdkAgentRenderer implements ToolRenderer {
	render(params: unknown, result: ToolResultMessage<any> | undefined, isStreaming?: boolean, ctx?: unknown): ToolRenderResult {
		const parentToolUseId = (ctx as any)?.toolUseId;
		const source = (ctx as any)?.embeddedSubagentWork ?? (params as any)?.embeddedSubagentWork;
		const activities = typeof parentToolUseId === "string"
			? workForParent(source, parentToolUseId) : [];
		if (!parentToolUseId || activities.length === 0) {
			// Preserve the normal safe fallback for native calls with no confirmed child work.
			return new DefaultRenderer("Agent").render(params, result, isStreaming);
		}
		const parentState = result?.isError ? "failed" : result ? "completed" : isStreaming ? "working" : "starting";
		return {
			content: html`<embedded-agent-card
				.parentToolUseId=${parentToolUseId}
				.activities=${activities}
				.parentState=${parentState}
				.parentOutput=${getTextOutput(result)}
			></embedded-agent-card>`,
			isCustom: false,
		};
	}
}

export class DelegateRenderer implements ToolRenderer<DelegateParams, DelegateDetails> {
	render(
		params: DelegateParams | undefined,
		result: ToolResultMessage<DelegateDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const details = result?.details as DelegateDetails | undefined;

		// ── Streaming (no result yet) ──
		if (!result) {
			if (params?.parallel && params.parallel.length > 0) {
				return {
					content: html`
						<div>
							${renderHeader(state, Bot, `Delegating to ${params.parallel.length} agents`)}
							<div class="mt-2 space-y-1">
								${params.parallel.map((p) => renderRunningCard(summarizeInstructions(p.instructions)))}
							</div>
						</div>
					`,
					isCustom: false,
				};
			}
			const summary = params?.instructions ? summarizeInstructions(params.instructions) : "task";
			return {
				content: html`
					<div>
						${renderHeader(state, Bot, html`Delegating to agent — <span class="font-mono text-xs">${summary}</span>`)}
					</div>
				`,
				isCustom: false,
			};
		}

		// ── Completed with details ──
		if (details?.delegates && details.delegates.length > 0) {
			const delegates = details.delegates;
			const allOk = delegates.every((d) => d.status === "completed");

			if (delegates.length === 1) {
				// Single delegate — compact rendering
				const d = delegates[0];
				const instructions = params?.instructions || d.instructions;
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, Bot,
								html`Delegated — <span class="font-mono text-xs">${summarizeInstructions(instructions)}</span>
									<span class="${statusColor(d.status)} text-xs ml-1">(${formatDuration(d.durationMs)})</span>
									${renderSessionLink(d.sessionId)}`,
								contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
								<div class="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">${getTextOutput(result)}</div>
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Multiple delegates — show cards
			const completedCount = delegates.filter((d) => d.status === "completed").length;
			const failedCount = delegates.filter((d) => d.status !== "completed" && d.status !== "running" && d.status !== "starting").length;
			const headerContent = html`Delegated to ${delegates.length} agents —
				${allOk
					? html`<span class="text-green-500 text-xs ml-1">all completed</span>`
					: failedCount > 0
						? html`<span class="text-xs ml-1"><span class="text-green-500">${completedCount} done</span>, <span class="text-destructive">${failedCount} failed</span></span>`
						: html`<span class="text-xs text-muted-foreground ml-1">${completedCount}/${delegates.length} completed</span>`}`;

			const parallelInstructions = params?.parallel || [];
			const isRunning = isStreaming && delegates.some((d) => d.status === "running");

			// Build cards with better names from parallel instructions if available
			const namedCards: DelegateCardEntry[] = delegates.map((d, i) => {
				const instr = parallelInstructions[i]?.instructions || d.instructions;
				return { id: d.id, sessionId: d.sessionId, name: summarizeInstructions(instr), status: d.status, durationMs: d.durationMs };
			});

			// Show cards expanded by default (running or completed with session links)
			const showExpanded = isRunning || namedCards.some((c) => c.sessionId);

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Bot, headerContent, contentRef, chevronRef, showExpanded)}
						<div ${ref(contentRef)} class="${showExpanded ? "max-h-[2000px] mt-3" : "max-h-0"} overflow-hidden transition-all duration-300">
							${renderDelegateCardList(namedCards)}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// ── Fallback (no details) — show text output ──
		const output = getTextOutput(result);
		const summary = params?.instructions ? summarizeInstructions(params.instructions) : "task";
		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, Bot,
						html`Delegated — <span class="font-mono text-xs">${summary}</span>`,
						contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<div class="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">${output}</div>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
