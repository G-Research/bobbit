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
}

type PrefixComponent = "system" | "tools" | "dynamic-context" | "skills";
type ProviderCacheTelemetry = "hit" | "miss" | "unknown";

interface PrefixComponentFingerprint {
	kind: PrefixComponent;
	sha256: string;
	bytes: number;
}

/** Hash-only diagnostic data from the prompt-prefix-attribution API. */
interface PrefixAttribution {
	ts: number;
	sequence: number;
	comparison: "first" | "stable" | "changed" | "boundary";
	culprit?: PrefixComponent | "multiple" | "unattributable";
	changed?: PrefixComponent[];
	comparableTo?: number;
	components: PrefixComponentFingerprint[];
	providerCacheTelemetry?: ProviderCacheTelemetry;
	// The recorder uses this for an explicit model/compaction baseline. Keep the
	// client tolerant of older rows that predate the reason field.
	boundaryReason?: "model-switch" | "compaction";
}

const COMPONENT_LABELS: Record<PrefixComponent, string> = {
	system: "System prompt",
	tools: "Tools",
	"dynamic-context": "Dynamic context",
	skills: "Skills",
};

@customElement("system-prompt-dialog")
export class SystemPromptDialog extends DialogBase {
	@state() private sections: PromptSection[] = [];
	@state() private totalTokens = 0;
	@state() private attribution: PrefixAttribution | null = null;
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
		const sectionsRequest = gatewayFetch(gatewayRoute(`/api/sessions/${this.sessionId}/prompt-sections`));
		const attributionRequest = gatewayFetch(gatewayRoute(`/api/sessions/${this.sessionId}/prompt-prefix-attribution?limit=20`));
		try {
			const [sectionsResult, attributionResult] = await Promise.allSettled([sectionsRequest, attributionRequest]);
			if (sectionsResult.status === "rejected") throw sectionsResult.reason;
			if (!sectionsResult.value.ok) {
				this.error = `Failed to load prompt sections (${sectionsResult.value.status})`;
				return;
			}

			const data = await sectionsResult.value.json();
			this.sections = data.sections ?? [];
			this.totalTokens = data.totalTokens ?? 0;

			// Attribution is an optional diagnostic. An unavailable diagnostic endpoint
			// must never make the existing prompt inspector unavailable.
			if (attributionResult.status === "fulfilled" && attributionResult.value.ok) {
				const attributionData = await attributionResult.value.json().catch(() => null);
				const entries = Array.isArray(attributionData?.entries) ? attributionData.entries : [];
				this.attribution = entries.length > 0 ? entries[entries.length - 1] as PrefixAttribution : null;
			}
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
					<div class="flex-1 min-w-0 flex items-center gap-2">
						${(() => { const p = this.truncatePath(section.source); return html`
						<span
							class="text-sm text-foreground truncate ${p.isPath ? 'font-mono' : 'font-medium'}"
							title="${p.full}"
							style="max-width: 70%"
						>${p.display}</span>
						<span class="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">${section.label}</span>
						`; })()}
					</div>
					<span class="text-xs text-muted-foreground shrink-0">${this.formatTokens(section.tokens)}</span>
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

	private formatTokens(tokens: number): string {
		if (tokens < 1000) return `~${tokens} tokens`;
		return `~${(tokens / 1000).toFixed(1)}k tokens`;
	}

	private isPrefixComponent(value: unknown): value is PrefixComponent {
		return typeof value === "string" && value in COMPONENT_LABELS;
	}

	private changedComponents(entry: PrefixAttribution): PrefixComponent[] {
		return Array.isArray(entry.changed)
			? entry.changed.filter((component): component is PrefixComponent => this.isPrefixComponent(component))
			: [];
	}

	private prefixStatus(entry: PrefixAttribution): string {
		if (entry.comparison === "stable") return "Stable prefix";
		if (entry.comparison === "first") return "Prefix baseline: first request";
		if (entry.comparison === "boundary") {
			return entry.boundaryReason === "compaction"
				? "Prefix baseline changed after compaction"
				: "Prefix baseline changed at model switch";
		}

		const changed = entry.culprit && this.isPrefixComponent(entry.culprit)
			? [entry.culprit]
			: this.changedComponents(entry);
		if (entry.culprit === "multiple" || changed.length > 1) return "Prefix changed: multiple components";
		if (entry.culprit === "unattributable" || changed.length === 0) return "Prefix changed: unattributable";
		return `Prefix changed: ${COMPONENT_LABELS[changed[0]]}`;
	}

	private telemetryLabel(telemetry: ProviderCacheTelemetry | undefined): string {
		return `Provider cache: ${telemetry === "hit" || telemetry === "miss" ? telemetry : "unknown"}`;
	}

	private digestPrefix(digest: unknown): string {
		return typeof digest === "string" && /^[a-f\d]{64}$/i.test(digest) ? digest.slice(0, 12).toLowerCase() : "Unavailable";
	}

	private displayNumber(value: unknown): string {
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "Unavailable";
	}

	private timestamp(value: unknown): string {
		if (typeof value !== "number" || !Number.isFinite(value)) return "Unavailable";
		try { return new Date(value).toISOString(); } catch { return "Unavailable"; }
	}

	private renderAttribution() {
		const entry = this.attribution;
		if (!entry) return nothing;
		const changed = this.changedComponents(entry).map((component) => COMPONENT_LABELS[component]);
		const components = Array.isArray(entry.components)
			? entry.components.filter((component): component is PrefixComponentFingerprint => this.isPrefixComponent(component?.kind))
			: [];
		return html`
			<section class="border border-border rounded-lg p-3 space-y-2" aria-label="Prompt prefix attribution" data-testid="prompt-prefix-attribution">
				<div class="flex flex-wrap items-center justify-between gap-2 text-sm" role="status" data-testid="prompt-prefix-attribution-status">
					<span class="font-medium text-foreground">${this.prefixStatus(entry)}</span>
					<span class="text-muted-foreground" data-testid="prompt-prefix-cache-status">${this.telemetryLabel(entry.providerCacheTelemetry)}</span>
				</div>
				<details data-testid="prompt-prefix-attribution-details">
					<summary class="cursor-pointer text-xs text-muted-foreground">Fingerprint details</summary>
					<div class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="prompt-prefix-attribution-metadata">
						<span class="text-muted-foreground">Sequence</span><span>${this.displayNumber(entry.sequence)}</span>
						<span class="text-muted-foreground">Timestamp</span><span>${this.timestamp(entry.ts)}</span>
						<span class="text-muted-foreground">Comparison sequence</span><span>${this.displayNumber(entry.comparableTo)}</span>
						<span class="text-muted-foreground">Changed groups</span><span>${changed.length > 0 ? changed.join(", ") : "None"}</span>
						<span class="text-muted-foreground">Provider cache</span><span>${this.telemetryLabel(entry.providerCacheTelemetry).replace("Provider cache: ", "")}</span>
						${components.map((component) => html`
							<span class="text-muted-foreground">${COMPONENT_LABELS[component.kind] ?? "Component"}</span>
							<span data-testid="prompt-prefix-component" data-component=${component.kind}>${this.digestPrefix(component.sha256)} · ${this.displayNumber(component.bytes)} bytes</span>
						`)}
					</div>
				</details>
			</section>
		`;
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
						${!this.loading ? this.renderAttribution() : nothing}
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
