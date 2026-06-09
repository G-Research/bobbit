/**
 * Lazy wrapper for `app/proposal-panels.ts`.
 *
 * The proposal-panel subsystem is ~80 kB of cold-path UI code that only
 * matters once the user views a goal / role / tool / staff / project
 * proposal. Keeping it out of the entry chunk lets the cold start render
 * the sidebar + chat shell without paying for the proposal-form rendering
 * graph.
 *
 * On first call to `proposalPanelContent()` we return a placeholder
 * (bouncing-bobbit) and kick off the dynamic import; once the module
 * lands `renderApp()` is invoked so the next paint shows the full panel.
 * Fire-and-forget action wrappers (`setSelectedWorkflowId`,
 * `resetProposalAnnCount`, `showProposalToast`, `resetProjectProposalPanel`,
 * `dismissTypedProposal`) eagerly load the module and forward / queue the
 * call so callers don't need to await.
 */
import type { PanelWorkspaceTab } from "./panel-workspace.js";
import type { ProposalType } from "./proposal-registry.js";
import { renderProposalPanelPlaceholder } from "./proposal-panel-placeholder.js";
import { renderApp } from "./state.js";

let _mod: typeof import("./proposal-panels.js") | null = null;
let _loadPromise: Promise<typeof import("./proposal-panels.js")> | null = null;
// Last chunk-load failure. A rejected dynamic import (network blip, deploy
// skew, corrupt dev-server optimizer cache) must NOT leave the panel spinning
// forever — we surface the error + a retry/reload affordance instead.
let _loadError: unknown = null;

function load(): Promise<typeof import("./proposal-panels.js")> {
	if (_loadPromise) return _loadPromise;
	_loadError = null;
	_loadPromise = import("./proposal-panels.js").then((m) => {
		_mod = m;
		// Drain any pending forwarded calls.
		if (_pendingWorkflowId != null) {
			m.setSelectedWorkflowId(_pendingWorkflowId);
			_pendingWorkflowId = null;
		}
		if (_pendingToast != null) {
			m.showProposalToast(_pendingToast);
			_pendingToast = null;
		}
		for (const t of _pendingResetCounts) m.resetProposalAnnCount(t);
		_pendingResetCounts.length = 0;
		if (_pendingResetProjectPanel) {
			m.resetProjectProposalPanel();
			_pendingResetProjectPanel = false;
		}
		for (const t of _pendingDismiss) m.dismissTypedProposal(t);
		_pendingDismiss.length = 0;
		renderApp();
		return m;
	}).catch((err) => {
		// Record the failure, reset the memoised promise so the next call (e.g.
		// the user clicking "Retry") re-attempts the import, and re-render so the
		// placeholder swaps to the error state instead of an endless spinner.
		console.error("[proposal-panels-lazy] failed to load proposal panel chunk", err);
		_loadError = err;
		_loadPromise = null;
		renderApp();
		throw err;
	});
	// Swallow the rejection on this internal handle — fire-and-forget callers
	// (`void load()`) must not produce an unhandled-rejection; the error is
	// surfaced via `_loadError` + the retry UI instead.
	_loadPromise.catch(() => {});
	return _loadPromise;
}

function retryLoad() {
	_loadError = null;
	void load();
	renderApp();
}

function loadingPlaceholder() {
	return renderProposalPanelPlaceholder({
		error: _loadError,
		onRetry: () => retryLoad(),
		onReload: () => window.location.reload(),
	});
}

/** Sync entry — returns a placeholder (or an error + retry UI) until the chunk lands. */
export function proposalPanelContent(
	tab: PanelWorkspaceTab,
	currentAssistantProposalType: () => ProposalType | null,
) {
	if (_mod) return _mod.proposalPanelContent(tab, currentAssistantProposalType);
	if (!_loadError) void load();
	return loadingPlaceholder();
}

// ── Fire-and-forget action wrappers ──────────────────────────────────

let _pendingWorkflowId: string | null = null;
export function setSelectedWorkflowId(id: string): void {
	if (_mod) {
		_mod.setSelectedWorkflowId(id);
		return;
	}
	_pendingWorkflowId = id;
	void load();
}

let _pendingToast: string | null = null;
export function showProposalToast(text: string): void {
	if (_mod) {
		_mod.showProposalToast(text);
		return;
	}
	_pendingToast = text;
	void load();
}

const _pendingResetCounts: Array<"goal" | "role" | "staff"> = [];
export function resetProposalAnnCount(type: "goal" | "role" | "staff"): void {
	if (_mod) {
		_mod.resetProposalAnnCount(type);
		return;
	}
	_pendingResetCounts.push(type);
	void load();
}

let _pendingResetProjectPanel = false;
export function resetProjectProposalPanel(): void {
	if (_mod) {
		_mod.resetProjectProposalPanel();
		return;
	}
	_pendingResetProjectPanel = true;
	void load();
}

const _pendingDismiss: ProposalType[] = [];
export function dismissTypedProposal(type: ProposalType): void {
	if (_mod) {
		_mod.dismissTypedProposal(type);
		return;
	}
	_pendingDismiss.push(type);
	void load();
}
