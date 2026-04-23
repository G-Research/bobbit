import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

export type AigwModelEntry = {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
};

/**
 * Read-only modal that lists the raw AI Gateway model IDs so users can debug
 * provider-prefix drift. Mirrors ModelSelector's dialog chrome but is not
 * selectable. Includes a footnote about the `aws/` prefix-stripping rule
 * applied elsewhere in the UI.
 */
@customElement("aigw-models-dialog")
export class AigwModelsDialog extends DialogBase {
	@state() private models: AigwModelEntry[] = [];

	protected override modalWidth = "min(500px, 92vw)";
	protected override modalHeight = "min(640px, 90vh)";

	static open(models: AigwModelEntry[]): AigwModelsDialog {
		const dialog = new AigwModelsDialog();
		dialog.models = Array.isArray(models) ? models.slice() : [];
		dialog.open();
		return dialog;
	}

	private formatTokens(tokens: number): string {
		if (!tokens || tokens <= 0) return "—";
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
		if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
		return String(tokens);
	}

	/**
	 * For each aigw model ID, compute the stripped form used in Settings-UI prefs.
	 * This mirrors the logic in `model-registry.ts` (Claude models have their
	 * provider prefix stripped).
	 */
	private strippedId(id: string): string | null {
		if (!id.toLowerCase().includes("claude")) return null;
		const slash = id.indexOf("/");
		if (slash <= 0) return null;
		return id.slice(slash + 1);
	}

	protected override renderContent(): TemplateResult {
		const list = this.models;
		return html`
			<div class="p-6 pb-4 border-b border-border flex-shrink-0">
				${DialogHeader({ title: "Available Gateway Models" })}
				<p class="text-xs text-muted-foreground mt-2">
					Raw model IDs as reported by the AI Gateway's <code>/v1/models</code> endpoint.
				</p>
			</div>
			<div class="flex-1 overflow-y-auto" data-testid="aigw-models-list">
				${list.length === 0
					? html`<div class="flex items-center justify-center py-8 text-muted-foreground text-sm">
							No models reported by the gateway.
						</div>`
					: list.map(
							(m) => html`
								<div class="px-4 py-3 border-b border-border" data-model-id=${m.id}>
									<div class="flex items-center justify-between gap-2 mb-1">
										<span class="text-sm font-medium text-foreground truncate">${m.name || m.id}</span>
										<div class="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
											${m.reasoning
												? html`<span class="px-1.5 py-0.5 rounded bg-secondary">Reasoning</span>`
												: ""}
											<span>${this.formatTokens(m.contextWindow)} ctx</span>
										</div>
									</div>
									<div class="text-[11px] text-muted-foreground font-mono break-all">${m.id}</div>
									${this.strippedId(m.id)
										? html`<div class="text-[11px] text-muted-foreground mt-0.5">
												UI pref ID: <code class="font-mono">${this.strippedId(m.id)}</code>
											</div>`
										: ""}
								</div>
							`,
						)}
			</div>
			<div class="px-4 py-3 border-t border-border text-[11px] text-muted-foreground leading-relaxed flex-shrink-0">
				Claude model IDs have the <code>aws/</code> (or similar) provider prefix stripped
				when surfaced to the rest of Bobbit, so that Bedrock routing works transparently.
				If a stored default model looks like <code>aigw/aws/…</code>, it is a stale
				preference — clear and re-pick it.
			</div>
		`;
	}
}
