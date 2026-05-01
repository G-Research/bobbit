/**
 * Defensive coercion for `goal.workflow.gates[*]` shapes consumed by the
 * goal-dashboard renderer.
 *
 * Background:
 *   The goal store now lazy-migrates persisted snake_case `depends_on` ↔
 *   camelCase `dependsOn` on load (see `src/server/agent/goal-store.ts` —
 *   commit f68b1c36). However, the dashboard renderer (`renderGatesTab`,
 *   `renderGatePipeline`, `renderGateChecklist`) historically reached
 *   directly into `gate.dependsOn.length` / `.map` / `for…of`. Any
 *   workflow snapshot that escapes the migration — a future schema bump,
 *   a project-scoped inline workflow, an in-memory mutation glitch, or a
 *   regression in the migration itself — synchronously throws inside
 *   Lit's render call, which silently swallows the error and produces a
 *   completely blank Gates tab.
 *
 * Guard: this module exposes a single render-time coercion. It accepts
 * the raw `unknown` gate array and emits a stable, fully-typed shape
 * with `dependsOn: string[]`. The renderer relies on this shape and
 * never reads the raw fields again.
 *
 * Pure / no Lit imports — kept testable with the Node test runner.
 */

export interface SafeWorkflowGate {
	id: string;
	name: string;
	dependsOn: string[];
	content?: boolean;
	injectDownstream?: boolean;
	metadata?: Record<string, string>;
}

/** Best-effort string-array extractor.
 *  - `string[]` → kept verbatim, with non-string entries filtered out.
 *  - `null` / `undefined` / not-an-array → `[]`.
 *
 *  Never throws. Always returns a fresh array (callers may mutate). */
export function coerceDependsOn(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.length > 0) out.push(item);
	}
	return out;
}

/** Coerce a single raw gate object into a render-safe shape.
 *
 *  Resolution order for `dependsOn`:
 *    1. `gate.dependsOn` (camelCase — current canonical form)
 *    2. `gate.depends_on` (snake_case — pre-fix workflow snapshots
 *        and any future regression that re-introduces the original bug)
 *    3. `[]` (no dependencies)
 *
 *  Falsy / non-object inputs return `null` so the caller can filter
 *  malformed entries out of the gate list rather than render
 *  garbage. */
export function coerceWorkflowGate(raw: unknown): SafeWorkflowGate | null {
	if (!raw || typeof raw !== "object") return null;
	const g = raw as Record<string, unknown>;
	const id = typeof g.id === "string" ? g.id : "";
	const name = typeof g.name === "string" ? g.name : id;
	if (!id) return null;

	let dependsOn = coerceDependsOn(g.dependsOn);
	if (dependsOn.length === 0 && Array.isArray(g.depends_on)) {
		dependsOn = coerceDependsOn(g.depends_on);
	}

	const out: SafeWorkflowGate = { id, name, dependsOn };
	if (typeof g.content === "boolean") out.content = g.content;
	if (typeof g.injectDownstream === "boolean") {
		out.injectDownstream = g.injectDownstream;
	} else if (typeof g.inject_downstream === "boolean") {
		out.injectDownstream = g.inject_downstream;
	}
	if (g.metadata && typeof g.metadata === "object" && !Array.isArray(g.metadata)) {
		const md: Record<string, string> = {};
		for (const [k, v] of Object.entries(g.metadata as Record<string, unknown>)) {
			if (typeof v === "string") md[k] = v;
		}
		if (Object.keys(md).length > 0) out.metadata = md;
	}
	return out;
}

/** Coerce a raw gates array into render-safe form.
 *
 *  Filters out malformed entries (anything for which
 *  `coerceWorkflowGate` returns `null`). Never throws. Returns `[]` if
 *  `raw` is not an array. */
export function coerceWorkflowGatesForRender(raw: unknown): SafeWorkflowGate[] {
	if (!Array.isArray(raw)) return [];
	const out: SafeWorkflowGate[] = [];
	for (const g of raw) {
		const safe = coerceWorkflowGate(g);
		if (safe) out.push(safe);
	}
	return out;
}
