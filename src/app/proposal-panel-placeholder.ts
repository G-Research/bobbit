/**
 * Placeholder / error rendering for the lazily-loaded proposal panel chunk.
 *
 * Split out of `proposal-panels-lazy.ts` so the error-state contract can be
 * unit-tested without importing the heavy `proposal-panels.ts` graph: a failed
 * dynamic import (network blip, deploy skew, a corrupt dev-server optimizer
 * cache) must surface an error + retry/reload affordance — NEVER an indefinite
 * spinner. This mirrors the same invariant the tool-renderer registry already
 * pins (see tests/lazy-renderer-placeholder.spec.ts, "loader rejection renders
 * error fallback instead of indefinite spinner").
 */
import { html, type TemplateResult } from "lit";
import { bobbitLoadingAnimation } from "../ui/components/BobbitLoadingAnimation.js";

export interface ProposalPanelPlaceholderOptions {
	/** The last chunk-load failure, or null/undefined while still loading. */
	error: unknown;
	/** Re-attempt the dynamic import. */
	onRetry: () => void;
	/** Hard-reload the page. */
	onReload: () => void;
}

/**
 * Returns the proposal-panel placeholder: the bouncing-bobbit spinner while the
 * chunk is in flight, or an error card with Retry / Reload buttons once a load
 * has failed.
 */
export function renderProposalPanelPlaceholder(opts: ProposalPanelPlaceholderOptions): TemplateResult {
	if (opts.error != null) {
		const detail = opts.error instanceof Error ? opts.error.message : String(opts.error);
		return html`<div
			class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
			data-testid="proposal-panel-load-error"
		>
			<div class="text-sm font-medium text-foreground">Couldn't load the proposal panel</div>
			<div class="text-xs text-muted-foreground max-w-md break-words">${detail}</div>
			<div class="flex gap-2">
				<button
					class="px-3 py-1.5 rounded text-sm bg-primary text-primary-foreground hover:opacity-90"
					data-testid="proposal-panel-retry"
					@click=${() => opts.onRetry()}
				>
					Retry
				</button>
				<button
					class="px-3 py-1.5 rounded text-sm border border-border text-foreground hover:bg-secondary/80"
					@click=${() => opts.onReload()}
				>
					Reload page
				</button>
			</div>
		</div>`;
	}
	return html`<div class="flex-1 min-h-0 flex items-center justify-center">${bobbitLoadingAnimation()}</div>`;
}
