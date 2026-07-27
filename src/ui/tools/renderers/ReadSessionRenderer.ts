/**
 * ReadSessionRenderer — bounded transcript cards with an optional direct-REST
 * transcript modal. Loaded lazily from `src/ui/tools/index.ts`.
 */
import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, render as renderLit, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { ExternalLink, History } from "lucide";
import type { MessageAuthor } from "../../../shared/message-author.js";
import { getToolState, renderCollapsibleHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderSessionLink } from "./delegate-cards.js";

interface ReadSessionParams {
	session_id: string;
	offset?: number;
	limit?: number;
	pattern?: string;
	case_sensitive?: boolean;
	context?: number;
	verbose?: boolean;
}

interface ResultSize {
	type?: string;
	chars?: number;
	lines?: number;
	bytes?: number;
	blocks?: number;
}

interface ResultExcerpt {
	start?: number;
	end?: number;
	text?: string;
	nextCursor?: number | null;
	complete?: boolean;
}

interface TranscriptToolResult {
	name?: string;
	preview?: string;
	omitted?: boolean;
	status?: string;
	handle?: string;
	size?: ResultSize;
	excerpt?: ResultExcerpt;
}

interface TranscriptToolCall {
	name?: string;
	argumentsPreview?: string;
	argumentsTruncated?: boolean;
	inputPreview?: string;
}

interface TranscriptMessage {
	index?: number;
	role?: string;
	roleTruncated?: boolean;
	ts?: string | null;
	text?: string;
	textTruncated?: boolean;
	thinking?: string;
	thinkingTruncated?: boolean;
	stopReason?: string;
	stopReasonTruncated?: boolean;
	error?: string;
	errorSummary?: string;
	errorTruncated?: boolean;
	errorSummaryTruncated?: boolean;
	author?: MessageAuthor;
	authorRef?: string;
	toolCalls?: TranscriptToolCall[];
	/** Legacy compact projection compatibility. */
	toolUses?: TranscriptToolCall[];
	toolResults?: TranscriptToolResult[];
	projectionOmitted?: true;
	toolCallCount?: number;
	toolResultCount?: number;
}

interface ContinuationRequest {
	kind?: string;
	offset?: number;
	result_cursor?: number;
	result_limit?: number;
	retrySameRequest?: boolean;
}

interface TranscriptEnvelope {
	session_id?: string;
	total?: number;
	matchCount?: number;
	returned?: number;
	offsetStart?: number;
	offsetEnd?: number;
	nextOffset?: number | null;
	messages: TranscriptMessage[];
	authors?: Record<string, MessageAuthor>;
	partial?: boolean;
	truncatedBy?: string;
	continuationRequest?: ContinuationRequest;
}

/** Canonical tool details deliberately carry scalars only — never messages. */
interface ReadSessionDetails {
	session_id?: string;
	sessionIdTruncated?: boolean;
	total?: number;
	matchCount?: number;
	returned?: number;
	offsetStart?: number;
	offsetEnd?: number;
	nextOffset?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	const number = finiteInteger(value);
	return number !== undefined && number >= 0 ? number : undefined;
}

function isTranscriptEnvelope(value: unknown): value is TranscriptEnvelope {
	if (!isRecord(value) || !Array.isArray(value.messages)) return false;
	const total = nonNegativeInteger(value.total);
	const returned = nonNegativeInteger(value.returned);
	return total !== undefined && returned !== undefined && returned === value.messages.length;
}

/** Find the first self-contained canonical envelope; unrelated text is ignored. */
function parseEnvelope(result: ToolResultMessage<ReadSessionDetails> | undefined): TranscriptEnvelope | undefined {
	for (const block of result?.content ?? []) {
		if (block.type !== "text" || typeof (block as { text?: unknown }).text !== "string") continue;
		try {
			const candidate = JSON.parse((block as { text: string }).text);
			if (isTranscriptEnvelope(candidate)) return candidate;
		} catch {
			// A tool result may contain explanatory text before the canonical JSON.
		}
	}
	return undefined;
}

function fmtTs(ts: string | null | undefined): string {
	if (!ts) return "";
	try {
		const date = new Date(ts);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	} catch {
		return "";
	}
}

function roleBadgeClass(role: string): string {
	switch (role) {
		case "user": return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
		case "assistant": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
		default: return "bg-muted text-muted-foreground";
	}
}

function resultStatusClass(status: string): string {
	switch (status) {
		case "ok": return "text-positive";
		case "error": return "text-destructive";
		default: return "text-muted-foreground";
	}
}

function authorFor(message: TranscriptMessage, authors: TranscriptEnvelope["authors"]): MessageAuthor | undefined {
	if (message.authorRef && isRecord(authors) && isRecord(authors[message.authorRef])) {
		const candidate = authors[message.authorRef];
		if (typeof candidate.kind === "string" && typeof candidate.id === "string" && typeof candidate.label === "string") {
			return candidate as MessageAuthor;
		}
	}
	if (isRecord(message.author)
		&& typeof message.author.kind === "string"
		&& typeof message.author.id === "string"
		&& typeof message.author.label === "string") return message.author as MessageAuthor;
	return undefined;
}

function formatResultSize(size: ResultSize | undefined): string {
	if (!isRecord(size)) return "";
	const parts: string[] = [];
	if (typeof size.type === "string" && size.type) parts.push(size.type);
	if (nonNegativeInteger(size.chars) !== undefined) parts.push(`${size.chars} chars`);
	if (nonNegativeInteger(size.lines) !== undefined) parts.push(`${size.lines} lines`);
	if (nonNegativeInteger(size.bytes) !== undefined) parts.push(`${size.bytes} bytes`);
	if (nonNegativeInteger(size.blocks) !== undefined) parts.push(`${size.blocks} blocks`);
	return parts.join(" · ");
}

function toolCallsFor(message: TranscriptMessage): TranscriptToolCall[] {
	if (Array.isArray(message.toolCalls)) return message.toolCalls.filter(isRecord);
	if (Array.isArray(message.toolUses)) return message.toolUses.filter(isRecord);
	return [];
}

function renderToolCall(call: TranscriptToolCall): TemplateResult {
	const name = typeof call.name === "string" && call.name ? call.name : "unknown";
	const preview = typeof call.argumentsPreview === "string"
		? call.argumentsPreview
		: typeof call.inputPreview === "string" ? call.inputPreview : "";
	return html`
		<div class="font-mono break-words" data-testid="read-session-tool-call">
			→ ${name}(${preview}${call.argumentsTruncated ? html`<span class="text-warning">…</span>` : ""})
			${call.argumentsTruncated ? html`<span class="ml-1 font-sans text-warning">arguments truncated</span>` : ""}
		</div>
	`;
}

function renderToolResult(result: TranscriptToolResult): TemplateResult {
	const name = typeof result.name === "string" && result.name ? result.name : "result";
	const status = typeof result.status === "string" ? result.status : "unknown";
	const size = formatResultSize(result.size);
	const excerpt = isRecord(result.excerpt) && typeof result.excerpt.text === "string" ? result.excerpt : undefined;
	const preview = typeof result.preview === "string" ? result.preview : undefined;
	const handle = typeof result.handle === "string" ? result.handle : "";
	const start = excerpt ? nonNegativeInteger(excerpt.start) : undefined;
	const end = excerpt ? nonNegativeInteger(excerpt.end) : undefined;

	return html`
		<div class="font-mono break-words" data-testid="read-session-tool-result" data-result-handle=${handle}>
			<div>
				← ${name}
				<span class="${resultStatusClass(status)}">[${status}]</span>
				${size ? html`<span class="text-muted-foreground"> · ${size}</span>` : ""}
			</div>
			${excerpt
				? html`
					<div class="mt-1 pl-3 border-l border-border font-sans">
						<div class="text-muted-foreground">
							excerpt${start !== undefined && end !== undefined ? ` ${start}–${end}` : ""}${excerpt.complete === false || typeof excerpt.nextCursor === "number" ? " · more available" : ""}
						</div>
						<div class="whitespace-pre-wrap break-words text-foreground" data-testid="read-session-result-excerpt">${excerpt.text}</div>
					</div>
				`
				: preview !== undefined
					? html`<div class="mt-1 pl-3 border-l border-border font-sans whitespace-pre-wrap break-words text-foreground">${preview}</div>`
					: result.omitted
						? html`<div class="mt-1 pl-3 font-sans text-muted-foreground">output omitted${handle ? html` · <span title=${handle}>bounded slice available</span>` : ""}</div>`
						: ""}
		</div>
	`;
}

function renderCompactMessage(message: TranscriptMessage, authors?: TranscriptEnvelope["authors"]): TemplateResult {
	const role = typeof message.role === "string" && message.role ? message.role : "?";
	const index = nonNegativeInteger(message.index);
	const author = authorFor(message, authors);
	const calls = toolCallsFor(message);
	const results = Array.isArray(message.toolResults) ? message.toolResults.filter(isRecord) : [];
	const text = typeof message.text === "string" ? message.text : "";
	const thinking = typeof message.thinking === "string" ? message.thinking : "";
	const errorSummary = typeof message.errorSummary === "string"
		? message.errorSummary
		: typeof message.error === "string" ? message.error : "";
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";

	return html`
		<div class="border-l-2 border-border pl-2 py-1" data-testid="read-session-message">
			<div class="flex flex-wrap items-center gap-2 text-xs">
				<span class="font-mono text-muted-foreground">#${index ?? "?"}</span>
				<span class="px-1.5 py-0.5 rounded ${roleBadgeClass(role)}">${role}</span>
				${author ? html`<span class="text-muted-foreground" data-testid="read-session-author">${author.label || author.kind}</span>` : ""}
				${message.ts ? html`<span class="text-muted-foreground">${fmtTs(message.ts)}</span>` : ""}
			</div>
			${message.projectionOmitted
				? html`<div class="mt-1 text-xs text-warning" data-testid="read-session-projection-omitted">Message projection omitted · ${nonNegativeInteger(message.toolCallCount) ?? 0} calls · ${nonNegativeInteger(message.toolResultCount) ?? 0} results</div>`
				: ""}
			${text ? html`<div class="mt-1 text-sm whitespace-pre-wrap break-words">${text}${message.textTruncated ? html` <span class="text-xs text-warning">[truncated]</span>` : ""}</div>` : ""}
			${thinking ? html`<div class="mt-1 text-xs whitespace-pre-wrap break-words text-muted-foreground">Thinking: ${thinking}${message.thinkingTruncated ? " [truncated]" : ""}</div>` : ""}
			${errorSummary ? html`<div class="mt-1 text-xs whitespace-pre-wrap break-words text-destructive">Error: ${errorSummary}${message.errorTruncated || message.errorSummaryTruncated ? " [truncated]" : ""}</div>` : ""}
			${stopReason ? html`<div class="mt-1 text-xs text-muted-foreground">Stop reason: ${stopReason}${message.stopReasonTruncated ? " [truncated]" : ""}</div>` : ""}
			${calls.length ? html`<div class="mt-1 text-xs text-muted-foreground">${calls.map(renderToolCall)}</div>` : ""}
			${results.length ? html`<div class="mt-1 space-y-1 text-xs">${results.map(renderToolResult)}</div>` : ""}
		</div>
	`;
}

function continuationText(envelope: TranscriptEnvelope | undefined, details: ReadSessionDetails | undefined): string {
	const continuation = envelope?.continuationRequest;
	if (envelope?.truncatedBy === "extension_return_unrecognized") {
		return "Partial response: the extension return was not recognized. Retry after updating the extension.";
	}
	if (continuation?.kind === "result_slice") {
		const cursor = nonNegativeInteger(continuation.result_cursor);
		return `Partial result excerpt${cursor !== undefined ? `; continue at cursor ${cursor}` : ""}.`;
	}
	const offset = nonNegativeInteger(continuation?.offset)
		?? nonNegativeInteger(envelope?.nextOffset)
		?? nonNegativeInteger(details?.nextOffset);
	if (envelope?.partial) return `Partial response${offset !== undefined ? `; continue at offset ${offset}` : ""}.`;
	if (offset !== undefined) return `More messages available at offset ${offset}.`;
	return "";
}

async function fetchPage(sessionId: string, offset: number, limit: number, verbose: boolean): Promise<TranscriptEnvelope> {
	const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
	if (verbose) query.set("verbose", "1");
	const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${query.toString()}`, {
		credentials: "include",
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(`${response.status}: ${(isRecord(body) && typeof body.error === "string" && body.error) || "transcript fetch failed"}`);
	}
	const body: unknown = await response.json();
	if (!isTranscriptEnvelope(body)) throw new Error("transcript fetch returned an invalid envelope");
	return body;
}

function appendModalStatus(body: HTMLElement, text: string, className = "text-xs text-muted-foreground text-center py-2"): HTMLElement {
	const element = document.createElement("div");
	element.className = className;
	element.textContent = text;
	body.appendChild(element);
	return element;
}

function openTranscriptModal(sessionId: string): void {
	const pageLimit = 50;
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem;";
	overlay.tabIndex = -1;
	overlay.setAttribute("role", "dialog");
	overlay.setAttribute("aria-modal", "true");
	overlay.setAttribute("aria-label", "Session transcript");
	overlay.dataset.testid = "read-session-transcript-modal";

	const modal = document.createElement("div");
	modal.className = "bg-background text-foreground border border-border rounded-lg shadow-2xl";
	modal.style.cssText = "width:min(900px,100%);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;";

	const header = document.createElement("div");
	header.className = "flex items-center justify-between gap-2 px-4 py-2 border-b border-border";
	const title = document.createElement("div");
	title.className = "text-sm font-medium";
	title.append("Session transcript ");
	const shortId = document.createElement("span");
	shortId.className = "text-muted-foreground font-mono text-xs ml-2";
	shortId.textContent = sessionId.slice(0, 12);
	title.appendChild(shortId);
	header.appendChild(title);
	const closeButton = document.createElement("button");
	closeButton.className = "text-muted-foreground hover:text-foreground text-sm px-2 py-1";
	closeButton.textContent = "✕";
	closeButton.setAttribute("aria-label", "Close");
	closeButton.onclick = () => overlay.remove();
	header.appendChild(closeButton);

	const body = document.createElement("div");
	body.className = "flex-1 overflow-y-auto p-4 space-y-2";
	body.style.cssText = "scrollbar-width:thin;";
	const loadingStatus = appendModalStatus(body, "Loading…", "text-xs text-muted-foreground");

	modal.append(header, body);
	overlay.appendChild(modal);
	document.body.appendChild(overlay);

	overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
	overlay.addEventListener("keydown", (event: KeyboardEvent) => { if (event.key === "Escape") overlay.remove(); });
	setTimeout(() => overlay.focus(), 0);

	let nextOffset = 0;
	let total = Number.POSITIVE_INFINITY;
	let loading = false;
	let finished = false;

	async function loadMore(): Promise<void> {
		if (loading || finished || nextOffset >= total) return;
		loading = true;
		const requestedOffset = nextOffset;
		try {
			const envelope = await fetchPage(sessionId, requestedOffset, pageLimit, false);
			total = nonNegativeInteger(envelope.total) ?? 0;
			loadingStatus.remove();
			for (const message of envelope.messages) {
				if (!isRecord(message)) continue;
				const mount = document.createElement("div");
				mount.dataset.testid = "read-session-modal-message";
				renderLit(renderCompactMessage(message, envelope.authors), mount);
				body.appendChild(mount);
			}

			const returned = nonNegativeInteger(envelope.returned) ?? envelope.messages.length;
			const reportedNext = nonNegativeInteger(envelope.nextOffset);
			const candidateNext = reportedNext !== undefined && reportedNext > requestedOffset
				? reportedNext
				: requestedOffset + returned;
			if (candidateNext <= requestedOffset && requestedOffset < total) {
				finished = true;
				appendModalStatus(body, "Transcript pagination stopped because the server returned no progress.", "text-xs text-warning text-center py-2");
				return;
			}
			nextOffset = candidateNext;
			if (nextOffset >= total) {
				finished = true;
				appendModalStatus(body, `End of transcript (${total} messages)`);
			}
		} catch (error: unknown) {
			finished = true;
			const message = error instanceof Error ? error.message : String(error);
			appendModalStatus(body, `Failed to load: ${message}`, "text-xs text-destructive");
		} finally {
			loading = false;
		}
	}

	body.addEventListener("scroll", () => {
		if (body.scrollTop + body.clientHeight >= body.scrollHeight - 100) void loadMore();
	});
	void loadMore();
}

export class ReadSessionRenderer implements ToolRenderer<ReadSessionParams, ReadSessionDetails> {
	render(
		params: ReadSessionParams | undefined,
		result: ToolResultMessage<ReadSessionDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const details = result?.details;
		const envelope = parseEnvelope(result);
		const sid = (typeof envelope?.session_id === "string" && envelope.session_id)
			|| (typeof details?.session_id === "string" && details.session_id)
			|| params?.session_id
			|| "";
		const sidShort = sid ? sid.slice(0, 12) : "?";

		if (!result) {
			const target = params?.session_id ? params.session_id.slice(0, 12) : "?";
			const summary = params?.pattern
				? `pattern="${params.pattern}" offset=${params.offset ?? 0} limit=${params.limit ?? 20}`
				: `offset=${params?.offset ?? 0} limit=${params?.limit ?? 20}`;
			return {
				content: html`
					<div data-testid="read-session-card">
						${renderCollapsibleHeader(state, History,
							html`Reading session <span class="font-mono text-xs">${target}</span> — <span class="text-xs text-muted-foreground">${summary}</span>`,
							contentRef, chevronRef, false)}
					</div>
				`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const text = result.content?.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n") || "";
			return {
				content: html`
					<div data-testid="read-session-card">
						${renderCollapsibleHeader(state, History,
							html`read_session <span class="font-mono text-xs">${sidShort}</span> — <span class="text-destructive text-xs">error</span> ${sid ? renderSessionLink(sid) : ""}`,
							contentRef, chevronRef, true)}
						<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
							<div class="text-xs font-mono text-destructive whitespace-pre-wrap">${text}</div>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Messages are trusted only from the self-contained content envelope. The
		// details object is intentionally scalar-only and can never reintroduce raw
		// or duplicated result bodies.
		const messages = envelope?.messages ?? [];
		const total = nonNegativeInteger(envelope?.total) ?? nonNegativeInteger(details?.total) ?? 0;
		const matchCount = nonNegativeInteger(envelope?.matchCount) ?? nonNegativeInteger(details?.matchCount);
		const returned = nonNegativeInteger(envelope?.returned) ?? nonNegativeInteger(details?.returned) ?? messages.length;
		const continuation = continuationText(envelope, details);

		const summaryFragment = matchCount !== undefined
			? html`<span class="text-xs text-muted-foreground">${returned}/${matchCount} matches of ${total}</span>`
			: html`<span class="text-xs text-muted-foreground">${returned} of ${total}</span>`;
		const onOpen = () => { if (sid) openTranscriptModal(sid); };

		return {
			content: html`
				<div data-testid="read-session-card">
					${renderCollapsibleHeader(state, History,
						html`read_session <span class="font-mono text-xs">${sidShort}</span> — ${summaryFragment}${envelope?.partial ? html` <span class="text-xs text-warning">partial</span>` : ""} ${sid ? renderSessionLink(sid) : ""}`,
						contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${continuation ? html`<div class="mb-2 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning" data-testid="read-session-continuation">${continuation}</div>` : ""}
						<div class="space-y-1">
							${messages.length === 0
								? html`<div class="text-xs text-muted-foreground italic">No messages in window.</div>`
								: messages.filter(isRecord).map(message => renderCompactMessage(message, envelope?.authors))}
						</div>
						${sid
							? html`
								<button
									@click=${onOpen}
									class="mt-3 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors"
									data-testid="read-session-open-full"
								>
									Open full transcript
									<span class="inline-block">${icon(ExternalLink, "xs")}</span>
								</button>
							`
							: ""}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}

export default ReadSessionRenderer;
