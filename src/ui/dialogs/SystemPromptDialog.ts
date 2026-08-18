import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";
import { gatewayRoute } from "../../shared/base-path.js";

interface PromptSection {
	label: string;
	source: string;
	content: string;
	tokens: number;
	/** Additive extension attribution; absent in legacy persisted snapshots. */
	kind?: "extension";
	packId?: string;
	packName?: string;
	sectionId?: string;
	sectionTitle?: string;
	/** Authoritative UTF-8 byte counts supplied by the prompt layout. */
	contentBytes?: number;
	renderedBytes?: number;
	totalPromptBytes?: number;
}

@customElement("system-prompt-dialog")
export class SystemPromptDialog extends DialogBase {
	@state() private sections: PromptSection[] = [];
	@state() private totalTokens = 0;
	@state() private loading = true;
	@state() private error = "";
	@state() private expandedSections = new Set<number>();
	@state() private copied = false;

	private sessionId = "";

	protected modalWidth = "min(700px, 90vw)";
	protected modalHeight = "min(80vh, 800px)";

	createRenderRoot() {
		return this;
	}

	static show(sessionId: string) {
		const dialog = new SystemPromptDialog();
		dialog.sessionId = sessionId;
		document.body.appendChild(dialog);
		dialog.open();
		dialog.fetchSections();
	}

	private async fetchSections() {
		try {
			const resp = await gatewayFetch(gatewayRoute(`/api/sessions/${this.sessionId}/prompt-sections`));
			if (!resp.ok) {
				this.error = `Failed to load prompt sections (${resp.status})`;
				this.loading = false;
				return;
			}
			const data = await resp.json();
			this.sections = data.sections ?? [];
			this.totalTokens = data.totalTokens ?? 0;
		} catch (err) {
			this.error = `Failed to load prompt sections: ${err}`;
		} finally {
			this.loading = false;
		}
	}

	private truncatePath(source: string): { display: string; full: string; isPath: boolean } {
		const isPath = source.includes('/') || source.includes('\\');
		if (!isPath) return { display: source, full: source, isPath: false };

		const normalized = source.replace(/\\/g, '/');
		const segments = normalized.split('/');
		const display = segments.length > 3
			? '…/' + segments.slice(-3).join('/')
			: source;
		return { display, full: source, isPath: true };
	}

	private toggleSection(index: number) {
		const next = new Set(this.expandedSections);
		if (next.has(index)) {
			next.delete(index);
		} else {
			next.add(index);
		}
		this.expandedSections = next;
	}

	private async copyAll() {
		const text = this.sections
			.map((s) => `# ${s.label}\n\n${s.content}`)
			.join("\n\n---\n\n");
		try {
			await navigator.clipboard.writeText(text);
			this.copied = true;
			setTimeout(() => {
				this.copied = false;
			}, 2000);
		} catch {
			// Fallback
			const ta = document.createElement("textarea");
			ta.value = text;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			document.body.removeChild(ta);
			this.copied = true;
			setTimeout(() => {
				this.copied = false;
			}, 2000);
		}
	}

	private formatBytes(bytes: number): string {
		return `${bytes.toLocaleString()} UTF-8 byte${bytes === 1 ? "" : "s"}`;
	}

	private renderExtensionAttribution(section: PromptSection) {
		if (section.kind !== "extension") return nothing;

		const validBytes = (bytes: number | undefined): bytes is number =>
			typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0;
		const contentBytes = validBytes(section.contentBytes) ? section.contentBytes : undefined;
		const renderedBytes = validBytes(section.renderedBytes) ? section.renderedBytes : undefined;
		const totalPromptBytes = validBytes(section.totalPromptBytes) ? section.totalPromptBytes : undefined;
		const hasContentBytes = contentBytes !== undefined;
		const hasRenderedBytes = renderedBytes !== undefined;
		const hasTotalBytes = totalPromptBytes !== undefined;
		const share = hasRenderedBytes && hasTotalBytes && totalPromptBytes > 0
			? (renderedBytes / totalPromptBytes) * 100
			: undefined;
		const contributor = section.packName ?? section.packId ?? "Unknown pack";
		const contribution = section.sectionTitle ?? section.sectionId ?? section.label;

		return html`
			<div class="mt-2 text-xs text-muted-foreground space-y-1" aria-label="Extension contribution details">
				<div class="flex flex-wrap gap-x-1.5 gap-y-0.5">
					<span class="font-medium text-foreground">Extension</span>
					<span>Pack: ${contributor}</span>
					${section.packName && section.packId ? html`<span class="font-mono">(${section.packId})</span>` : nothing}
					<span aria-hidden="true">·</span>
					<span>Section: ${contribution}</span>
					${section.sectionTitle && section.sectionId ? html`<span class="font-mono">(${section.sectionId})</span>` : nothing}
				</div>
				${hasContentBytes || hasRenderedBytes || hasTotalBytes ? html`
					<div class="flex flex-wrap gap-x-1.5 gap-y-0.5" aria-label="Authoritative UTF-8 byte usage">
						${hasContentBytes ? html`<span>${this.formatBytes(contentBytes)} content</span>` : nothing}
						${hasContentBytes && (hasRenderedBytes || hasTotalBytes) ? html`<span aria-hidden="true">·</span>` : nothing}
						${hasRenderedBytes ? html`<span>${this.formatBytes(renderedBytes)} rendered</span>` : nothing}
						${hasRenderedBytes && hasTotalBytes ? html`<span aria-hidden="true">·</span>` : nothing}
						${hasTotalBytes ? html`<span>${this.formatBytes(totalPromptBytes)} total prompt</span>` : nothing}
						${share !== undefined ? html`<span aria-label="${share.toFixed(1)} percent of total prompt">· ${share.toFixed(1)}%</span>` : nothing}
					</div>
				` : nothing}
			</div>
		`;
	}

	private renderSection(section: PromptSection, index: number) {
		const expanded = this.expandedSections.has(index);
		const contentId = `system-prompt-section-${index}`;
		const path = this.truncatePath(section.source);
		return html`
			<div class="border border-border rounded-lg overflow-hidden">
				<button
					class="w-full flex items-start gap-2 p-3 text-left hover:bg-secondary/50 transition-colors"
					@click=${() => this.toggleSection(index)}
					aria-expanded="${expanded}"
					aria-controls="${contentId}"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						class="shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-90" : ""}"
					>
						<path d="m9 18 6-6-6-6"></path>
					</svg>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span
								class="text-sm text-foreground truncate ${path.isPath ? "font-mono" : "font-medium"}"
								title="${path.full}"
								style="max-width: 70%"
							>${path.display}</span>
							<span class="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">${section.label}</span>
						</div>
						${this.renderExtensionAttribution(section)}
					</div>
					<span class="text-xs text-muted-foreground shrink-0 mt-0.5">${this.formatTokens(section.tokens)}</span>
				</button>
				${expanded
					? html`
							<div id="${contentId}" class="border-t border-border">
								<pre
									class="text-xs text-foreground p-3 m-0 overflow-y-auto"
									style="white-space: pre-wrap; word-wrap: break-word; max-height: 400px; background: var(--muted);"
								>${section.content}</pre>
							</div>
						`
					: nothing}
			</div>
		`;
	}

	private formatTokens(tokens: number): string {
		if (tokens < 1000) return `~${tokens} tokens`;
		return `~${(tokens / 1000).toFixed(1)}k tokens`;
	}

	protected override renderContent() {
		return html`
			${DialogContent({
				className: "h-full flex flex-col",
				children: html`
					${DialogHeader({
						title: "System Prompt Inspector",
						description: this.totalTokens > 0
							? `Assembled prompt sections for this session — ~${this.formatTokens(this.totalTokens)} total`
							: `Assembled prompt sections for this session`,
					})}

					<div class="flex-1 overflow-y-auto mt-4 space-y-2">
						${this.loading
							? html`<div class="text-center py-8 text-muted-foreground">Loading...</div>`
							: this.error
								? html`<div class="text-center py-8 text-destructive">${this.error}</div>`
								: this.sections.length === 0
									? html`<div class="text-center py-8 text-muted-foreground">No prompt sections available</div>`
									: this.sections.map((s, i) => this.renderSection(s, i))}
					</div>

					${!this.loading && this.sections.length > 0
						? html`
								<div class="mt-4 flex justify-end border-t border-border pt-3">
									${Button({
										variant: "outline",
										size: "sm",
										onClick: () => this.copyAll(),
										children: this.copied ? "Copied!" : "Copy All",
									})}
								</div>
							`
						: nothing}
				`,
			})}
		`;
	}
}
