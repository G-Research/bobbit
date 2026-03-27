import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/api.js";

interface PromptSection {
	label: string;
	source: string;
	content: string;
}

@customElement("system-prompt-dialog")
export class SystemPromptDialog extends DialogBase {
	@state() private sections: PromptSection[] = [];
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
			const resp = await gatewayFetch(`/api/sessions/${this.sessionId}/prompt-sections`);
			if (!resp.ok) {
				this.error = `Failed to load prompt sections (${resp.status})`;
				this.loading = false;
				return;
			}
			const data = await resp.json();
			this.sections = data.sections ?? [];
		} catch (err) {
			this.error = `Failed to load prompt sections: ${err}`;
		} finally {
			this.loading = false;
		}
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

	private renderSection(section: PromptSection, index: number) {
		const expanded = this.expandedSections.has(index);
		return html`
			<div class="border border-border rounded-lg overflow-hidden">
				<button
					class="w-full flex items-center gap-2 p-3 text-left hover:bg-secondary/50 transition-colors"
					@click=${() => this.toggleSection(index)}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						class="shrink-0 transition-transform ${expanded ? "rotate-90" : ""}"
					>
						<path d="m9 18 6-6-6-6"></path>
					</svg>
					<div class="flex-1 min-w-0">
						<span class="font-medium text-sm text-foreground">${section.label}</span>
						<span class="text-xs text-muted-foreground ml-2">${section.source}</span>
					</div>
					<span class="text-xs text-muted-foreground shrink-0">${this.formatSize(section.content.length)}</span>
				</button>
				${expanded
					? html`
							<div class="border-t border-border">
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

	private formatSize(chars: number): string {
		if (chars < 1000) return `${chars} chars`;
		return `${(chars / 1000).toFixed(1)}k chars`;
	}

	protected override renderContent() {
		return html`
			${DialogContent({
				className: "h-full flex flex-col",
				children: html`
					${DialogHeader({
						title: "System Prompt Inspector",
						description: `Assembled prompt sections for this session`,
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
