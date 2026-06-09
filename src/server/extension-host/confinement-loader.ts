// src/server/extension-host/confinement-loader.ts
//
// Slice C3 — the module-load DENY-HOOK half of the server-module confinement
// (Extension Host Phase 2, design docs/design/extension-host-phase2.md §9 / C3.2).
//
// This file is an ESM module-customization-hooks module: it is registered (via
// `module.register`) by the worker BOOTSTRAP (`module-host-bootstrap.ts`) BEFORE
// the pack server module (an `actions`/`routes` module) is dynamic-imported. Its
// `resolve` hook DENIES the pack module graph access to the dangerous Node
// built-ins — `node:fs`, `node:child_process`, `node:net`, `node:http(s)`,
// `node:worker_threads`, `node:process`, and their escape-vector relatives — so
// the ONLY capability pack code is handed is the host-API proxy over the parent
// MessagePort (v1 §5 no-ambient-access). The bootstrap imports `worker_threads`
// + `module` BEFORE registering this hook, so the deny-list never blocks the
// confinement plumbing itself — only the pack module graph loaded afterward.
//
// This deny-hook is one of THREE confinement layers (the other two — empty env +
// terminate/resource caps — live in module-host-worker.ts). Together they are
// what "isolation" means in design §9; a bare worker_threads.Worker is NOT a
// sandbox on its own (it inherits env + can require built-ins unless denied).

/** The data passed from the bootstrap's `register(..., { data })` call. */
interface ConfinementData {
	/** First-path-segment deny-list (normalized, `node:` prefix stripped). */
	denied: string[];
}

let deniedSegments = new Set<string>();

/** Module-customization hook: receives the `register(..., { data })` payload. */
export function initialize(data: ConfinementData): void {
	deniedSegments = new Set(data?.denied ?? []);
}

/** Normalize a specifier to its first path segment, stripping any `node:` prefix.
 *  `node:fs/promises` → `fs`; `child_process` → `child_process`. */
function firstSegment(specifier: string): string {
	const noScheme = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
	const seg = noScheme.split("/", 1)[0];
	return seg;
}

interface ResolveContext {
	conditions: string[];
	importAttributes: Record<string, string>;
	parentURL?: string;
}
interface ResolveResult {
	url: string;
	format?: string | null;
	shortCircuit?: boolean;
	importAttributes?: Record<string, string>;
}
type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult | Promise<ResolveResult>;

/**
 * The DENY chokepoint. Runs FIRST in the hook chain (LIFO registration) so it can
 * reject a dangerous built-in before any downstream loader (e.g. the tsx loader
 * under the unit runner) resolves it. A denied specifier throws a loud, prefixed
 * error so misuse is never silent; everything else falls through to `nextResolve`.
 */
export function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): ResolveResult | Promise<ResolveResult> {
	const seg = firstSegment(specifier);
	if (deniedSegments.has(seg) || deniedSegments.has(specifier)) {
		throw new Error(`[confinement] import of "${specifier}" is denied to pack server modules (Extension Host §9 isolation)`);
	}
	return nextResolve(specifier, context);
}
