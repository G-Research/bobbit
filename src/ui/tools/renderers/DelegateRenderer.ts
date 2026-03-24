import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Bot } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import {
	type DelegateCardEntry,
	formatDuration,
	statusColor,
	summarizeInstructions,
	renderDelegateCard,
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

/** Convert DelegateDetailsEntry to shared DelegateCardEntry */
function toCardEntry(d: DelegateDetailsEntry): DelegateCardEntry {
	return { id: d.id, sessionId: d.sessionId, name: summarizeInstructions(d.instructions), status: d.status, durationMs: d.durationMs };
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
			const cards = delegates.map(toCardEntry);
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
