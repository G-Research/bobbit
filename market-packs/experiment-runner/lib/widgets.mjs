// THIN ADAPTER over the shared widget registry (lib/experiment-report.mjs).
//
// This is NOT a second registry. The one widget registry lives in the shared lib
// (src/shared/experiment-report/widgets/* when bundled); this module exposes its
// `listWidgets` metadata for the dashboard editor and forwards optional
// pack-contributed registrations THROUGH the shared registry. It defines no chart
// HTML of its own (the no-fork guard enforces this).

import { listWidgets as sharedListWidgets, registerWidget as sharedRegisterWidget, getWidget } from "./experiment-report.mjs";

export { getWidget } from "./experiment-report.mjs";

/** Canonical built-in widget type ids (stable, bound by DashboardSpec.type). */
export const BUILTIN_WIDGET_TYPES = ["comparison-table", "score-bars", "objective-curve", "ledger-table", "summary-cards", "raw-drilldown"];

/** Registry introspection for the dashboard editor (the `listWidgets` route). */
export function listWidgets() {
	return sharedListWidgets();
}

/**
 * Contribute a custom widget renderer THROUGH the shared registry. A registration,
 * not a refactor — the spec then references it by `type` and every surface (panel,
 * report route, tests) resolves the same renderer.
 */
export function registerWidget(renderer) {
	return sharedRegisterWidget(renderer);
}

/** Whether a widget `type` resolves to a registered renderer. */
export function hasWidget(type) {
	return !!getWidget(type);
}
