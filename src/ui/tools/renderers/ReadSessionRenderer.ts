/**
 * ReadSessionRenderer — compact list of transcript messages with an
 * "Open full transcript" button that lazy-fetches more via
 * `GET /api/sessions/:id/transcript`.
 *
 * Loaded lazily via `registerLazyToolRenderer` from `src/ui/tools/index.ts`.
 */
import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { History, ExternalLink } from "lucide";
import { renderCollapsibleHeader, getToolState } from "../renderer-registry.js";
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

interface CompactMessage {
	index: number;
	role: string;
	ts: string | null;
	text: string;
	toolUses?: Array<{ name: string; inputPreview: string }>;
	toolResults?: Array<{ name?: string; preview: string }>;
}

interface ReadSessionDetails {
	session_id?: string;
	total?: number;
	matchCount?: number;
	returned?: number;
	offsetStart?: number;
	offsetEnd?: number;
	messages?: CompactMessage[];
}

function fmtTs(ts: string | null | undefined): string {
	if (!ts) return "";
	try {
		const d = new Date(ts);
		if (Number.isNaN(d.getTime())) return "";
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	} catch { return ""; }
}

function roleBadgeClass(role: string): string {
	switch (role) {
		case "user": return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
		case "assistant": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
		default: return "bg-muted text-muted-foreground";
	}
}

function renderCompactMessage(m: CompactMessage): TemplateResult {
	return html`
		<div class="border-l-2 border-border pl-2 py-1">
			<div class="flex items-center gap-2 text-xs">
				<span class="font-mono text-muted-foreground">#${m.index}</span>
				<span class="px-1.5 py-0.5 rounded ${roleBadgeClass(m.role)}">${m.role}</span>
				${m.ts ? html`<span class="text-muted-foreground">${fmtTs(m.ts)}</span>` : ""}
			</div>
			${m.text ? html`<div class="mt-1 text-sm whitespace-pre-wrap break-words">${m.text}</div>` : ""}
			${m.toolUses?.length
				? html`<div class="mt-1 text-xs text-muted-foreground">
					${m.toolUses.map(t => html`<div class="font-mono">→ ${t.name}(${t.inputPreview})</div>`)}
				</div>`
				: ""}
			${m.toolResults?.length
				? html`<div class="mt-1 text-xs text-muted-foreground">
					${m.toolResults.map(t => html`<div class="font-mono">← ${t.name ?? "result"}: ${t.preview}</div>`)}
				</div>`
				: ""}
		</div>
	`;
}

async function fetchPage(sessionId: string, offset: number, limit: number, verbose: boolean): Promise<any> {
	const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
	if (verbose) qs.set("verbose", "1");
	const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript?${qs.toString()}`, {
		credentials: "include",
	});
	if (!resp.ok) {
		const body = await resp.json().catch(() => ({}));
		throw new Error(`${resp.status}: ${(body && body.error) || "transcript fetch failed"}`);
	}
	return resp.json();
}

function openTranscriptModal(sessionId: string): void {
	// Build a minimal modal with infinite-scroll pagination over the
	// /transcript endpoint. Compact mode by default (zero agent tokens).
	const PAGE = 50;
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem;";
	overlay.tabIndex = -1;

	const modal = document.createElement("div");
	modal.className = "bg-background text-foreground border border-border rounded-lg shadow-2xl";
	modal.style.cssText = "width:min(900px,100%);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;";

	const header = document.createElement("div");
	header.className = "flex items-center justify-between gap-2 px-4 py-2 border-b border-border";
	header.innerHTML = `<div class="text-sm font-medium">Session transcript <span class="text-muted-foreground font-mono text-xs ml-2">${sessionId.slice(0, 12)}</span></div>`;
	const closeBtn = document.createElement("button");
	closeBtn.className = "text-muted-foreground hover:text-foreground text-sm px-2 py-1";
	closeBtn.textContent = "✕";
	closeBtn.setAttribute("aria-label", "Close");
	closeBtn.onclick = () => overlay.remove();
	header.appendChild(closeBtn);

	const body = document.createElement("div");
	body.className = "flex-1 overflow-y-auto p-4 space-y-2";
	body.style.cssText = "scrollbar-width:thin;";

	const status = document.createElement("div");
	status.className = "text-xs text-muted-foreground";
	status.textContent = "Loading…";
	body.appendChild(status);

	modal.appendChild(header);
	modal.appendChild(body);
	overlay.appendChild(modal);
	document.body.appendChild(overlay);

	overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
	overlay.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Escape") overlay.remove(); });
	setTimeout(() => overlay.focus(), 0);

	let nextOffset = 0;
	let total = Infinity;
	let loading = false;

	async function loadMore() {
		if (loading || nextOffset >= total) return;
		loading = true;
		try {
			const env = await fetchPage(sessionId, nextOffset, PAGE, false);
			total = env.total ?? 0;
			status.remove();
			const messages: CompactMessage[] = env.messages ?? [];
			for (const m of messages) {
				const div = document.createElement("div");
				div.className = "border-l-2 border-border pl-3 py-1";
				const tsStr = fmtTs(m.ts);
				const role = m.role || "?";
				const badgeClass = roleBadgeClass(role);
				const head = `<div style="display:flex;gap:0.5rem;align-items:center;font-size:0.75rem;">
					<span style="font-family:monospace;color:var(--muted-foreground);">#${m.index}</span>
					<span class="${badgeClass}" style="padding:0.1rem 0.4rem;border-radius:0.25rem;">${role}</span>
					${tsStr ? `<span style="color:var(--muted-foreground);">${tsStr}</span>` : ""}
				</div>`;
				const text = m.text ? `<div style="margin-top:0.25rem;font-size:0.875rem;white-space:pre-wrap;word-break:break-word;">${escapeHtml(m.text)}</div>` : "";
				const tu = m.toolUses?.length
					? `<div style="margin-top:0.25rem;font-size:0.75rem;color:var(--muted-foreground);font-family:monospace;">${m.toolUses.map(t => `→ ${escapeHtml(t.name)}(${escapeHtml(t.inputPreview)})`).join("<br/>")}</div>`
					: "";
				const tr = m.toolResults?.length
					? `<div style="margin-top:0.25rem;font-size:0.75rem;color:var(--muted-foreground);font-family:monospace;">${m.toolResults.map(t => `← ${escapeHtml(t.name ?? "result")}: ${escapeHtml(t.preview)}`).join("<br/>")}</div>`
					: "";
				div.innerHTML = head + text + tu + tr;
				body.appendChild(div);
			}
			nextOffset += messages.length || PAGE;
			if (nextOffset >= total) {
				const end = document.createElement("div");
				end.className = "text-xs text-muted-foreground text-center py-2";
				end.textContent = `End of transcript (${total} messages)`;
				body.appendChild(end);
			}
		} catch (err: any) {
			const errEl = document.createElement("div");
			errEl.className = "text-xs text-destructive";
			errEl.textContent = `Failed to load: ${err?.message ?? String(err)}`;
			body.appendChild(errEl);
			nextOffset = total; // stop further loads
		} finally {
			loading = false;
		}
	}

	body.addEventListener("scroll", () => {
		if (body.scrollTop + body.clientHeight >= body.scrollHeight - 100) {
			loadMore();
		}
	});

	loadMore();
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
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
		const sid = details?.session_id ?? params?.session_id ?? "";
		const sidShort = sid ? sid.slice(0, 12) : "?";

		// Streaming
		if (!result) {
			const target = params?.session_id ? params.session_id.slice(0, 12) : "?";
			const summary = params?.pattern
				? `pattern="${params.pattern}" offset=${params.offset ?? 0} limit=${params.limit ?? 20}`
				: `offset=${params?.offset ?? 0} limit=${params?.limit ?? 20}`;
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, History,
							html`Reading session <span class="font-mono text-xs">${target}</span> — <span class="text-xs text-muted-foreground">${summary}</span>`,
							contentRef, chevronRef, false)}
					</div>
				`,
				isCustom: false,
			};
		}

		// Error
		if (result.isError) {
			const txt = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, History,
							html`read_session <span class="font-mono text-xs">${sidShort}</span> — <span class="text-destructive text-xs">error</span> ${sid ? renderSessionLink(sid) : ""}`,
							contentRef, chevronRef, true)}
						<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
							<div class="text-xs font-mono text-destructive whitespace-pre-wrap">${txt}</div>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const messages = details?.messages ?? [];
		const total = details?.total ?? 0;
		const matchCount = details?.matchCount;
		const returned = details?.returned ?? messages.length;

		const summaryFragment =
			matchCount !== undefined
				? html`<span class="text-xs text-muted-foreground">${returned}/${matchCount} matches of ${total}</span>`
				: html`<span class="text-xs text-muted-foreground">${returned} of ${total}</span>`;

		const onOpen = () => {
			if (sid) openTranscriptModal(sid);
		};

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, History,
						html`read_session <span class="font-mono text-xs">${sidShort}</span> — ${summaryFragment} ${sid ? renderSessionLink(sid) : ""}`,
						contentRef, chevronRef, true)}
					<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
						<div class="space-y-1">
							${messages.length === 0
								? html`<div class="text-xs text-muted-foreground italic">No messages in window.</div>`
								: messages.map(renderCompactMessage)}
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
