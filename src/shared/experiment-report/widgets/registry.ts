// The widget registry — the SINGLE registry (docs/design/experiment-runner-
// reporting.md §6). It lives ONLY here; the pack's lib/widgets.mjs is a thin
// adapter that exposes listWidgets metadata and optional pack registrations
// THROUGH this registry. The dashboard spec binds widgets by `type` string, so a
// single registry is the only way the panel, the report route, and the tests
// resolve the same renderer — "registration, not refactor".

import type { ReportModel, WidgetDescriptor, WidgetSpec } from "../types.js";

/** A pure widget renderer: a model + spec → HTML string (theme tokens only). */
export interface WidgetRenderer {
	type: string;
	/** Human label + supported modes for registry introspection (listWidgets). */
	descriptor?: Omit<WidgetDescriptor, "type">;
	render(ctx: { model: ReportModel; spec: WidgetSpec }): string;
}

const registry = new Map<string, WidgetRenderer>();

/** Register (or replace) a widget renderer by its `type` id. */
export function registerWidget(renderer: WidgetRenderer): void {
	registry.set(renderer.type, renderer);
}

/** Resolve a widget renderer by `type`, or undefined if unregistered. */
export function getWidget(type: string): WidgetRenderer | undefined {
	return registry.get(type);
}

/** True if a widget type is registered. */
export function hasWidget(type: string): boolean {
	return registry.has(type);
}

/** Descriptors for every registered widget (dashboard-editor introspection). */
export function listWidgets(): WidgetDescriptor[] {
	const out: WidgetDescriptor[] = [];
	for (const r of registry.values()) {
		out.push({
			type: r.type,
			label: r.descriptor?.label ?? r.type,
			modes: r.descriptor?.modes ?? ["ab", "autoresearch"],
			description: r.descriptor?.description,
		});
	}
	return out;
}

/** Test/seam helper: remove a renderer (used to assert clean registration). */
export function unregisterWidget(type: string): void {
	registry.delete(type);
}
