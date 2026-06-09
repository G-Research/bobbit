// src/server/extension-host/confinement-loader.ts
//
// Slice C3 — the module-load DENY+CONFINE hook half of the server-module
// confinement (Extension Host Phase 2, design docs/design/extension-host-phase2.md
// §9 / C3.2).
//
// This module exports a SYNCHRONOUS `resolve` hook + a `configure` setter that the
// worker BOOTSTRAP (`module-host-bootstrap.ts`) installs via Node's IN-THREAD
// `module.registerHooks({ resolve })` BEFORE the pack server module (an
// `actions`/`routes` module) is dynamic-imported. In-thread (synchronous) hooks
// run in the SAME worker thread as the bootstrap — NOT a separate hooks thread —
// which is deliberate: it lets the bootstrap import the SHARED `path-guard` helper
// normally (resolved by the worker's own loader) and call it synchronously from
// the hook, with no cross-thread marshalling and no module-customization-graph
// `.ts`/`.js` resolution gap. The bootstrap imports `path-guard` (and its
// `node:fs`/`node:path` deps) + `worker_threads`/`module` BEFORE installing the
// hook, so the deny-list never blocks the confinement plumbing itself — only the
// pack module graph loaded afterward.
//
// The hook enforces TWO things on every resolution the pack module graph makes:
//
//   1. DENY-LIST — reject the dangerous Node built-ins (`node:fs`,
//      `node:child_process`, `node:net`, `node:http(s)`, `node:worker_threads`,
//      `node:process`, … and their escape-vector relatives), so the ONLY
//      capability pack code is handed is the host-API proxy over the parent
//      MessagePort (v1 §5 no-ambient-access).
//
//   2. PACK-ROOT CONTAINMENT — every resolved `file:` URL must be realpath-
//      contained within the validated pack group directory (the SAME root the
//      dispatcher used to load + validate the entry module). Without this, a pack
//      module could `import`/`require` a file OUTSIDE its own pack via a `../`
//      walk, an absolute path, a symlink escape, or a bare specifier that resolves
//      into an ancestor `node_modules` — none of which hit a denied built-in, yet
//      all of which reach arbitrary host files outside the pack, weakening the
//      "no ambient access except the Host API" boundary (design §9). Containment
//      reuses the SHARED `isPackPathWithinGroup` path-guard helper so the lexical +
//      realpath checks stay byte-consistent with the HTTP entry-serving endpoints.
//
// This deny+confine hook is one of THREE confinement layers (the other two — empty
// env + terminate/resource caps — live in module-host-worker.ts). Together they
// are what "isolation" means in design §9; a bare worker_threads.Worker is NOT a
// sandbox on its own (it inherits env + can require built-ins / read sibling files
// unless denied + confined).

import { fileURLToPath } from "node:url";
import { isPackPathWithinGroup } from "./path-guard.js";

/** The configuration passed by the bootstrap before installing the hook. */
export interface ConfinementConfig {
	/** First-path-segment deny-list (normalized, `node:` prefix stripped). */
	denied: string[];
	/** Absolute path of the validated pack group root (the dispatcher's `groupDir`).
	 *  Every resolved `file:` URL in the pack module graph must stay realpath-
	 *  contained within it. Absent ⇒ no file-containment enforcement (defensive
	 *  default; the production dispatchers ALWAYS supply it). */
	packRoot?: string;
}

let deniedSegments = new Set<string>();
let packRoot: string | undefined;

/** Configure the hook BEFORE installing it (called by the bootstrap once, before
 *  any pack module is imported). */
export function configure(config: ConfinementConfig): void {
	deniedSegments = new Set(config?.denied ?? []);
	packRoot = typeof config?.packRoot === "string" && config.packRoot.length > 0 ? config.packRoot : undefined;
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
	importAttributes: Record<string, string | undefined>;
	parentURL?: string;
}
interface ResolveResult {
	url: string;
	format?: string | null;
	shortCircuit?: boolean;
	importAttributes?: Record<string, string | undefined>;
}
type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;

/**
 * The DENY + CONFINE chokepoint (a SYNCHRONOUS `module.registerHooks` resolve
 * hook). Runs FIRST in the chain so it can reject a dangerous built-in before any
 * downstream loader resolves it. For every other specifier it lets the chain
 * resolve to a concrete URL, then rejects any `file:` URL that escapes the
 * validated pack root. A denied/escaping specifier throws a loud, prefixed error
 * so misuse is never silent; everything safe falls through unchanged.
 */
export function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): ResolveResult {
	const seg = firstSegment(specifier);
	if (deniedSegments.has(seg) || deniedSegments.has(specifier)) {
		throw new Error(`[confinement] import of "${specifier}" is denied to pack server modules (Extension Host §9 isolation)`);
	}
	const resolved = nextResolve(specifier, context);
	if (!packRoot) return resolved;
	return enforceContainment(specifier, resolved);
}

/**
 * Reject any resolution whose `file:` URL escapes the validated pack root. Runs
 * AFTER the chain has resolved the specifier to a concrete URL (so it sees the
 * real target of a `../` walk / absolute path / symlink / `node_modules`
 * traversal, not the lexical specifier). Non-`file:` URLs (`node:` built-ins that
 * survived the deny-list, `data:` URLs) keep their current handling — they reach
 * no host file. Uses the SHARED path-guard helper (lexical + realpath containment)
 * so the check matches the HTTP entry-serving endpoints exactly.
 */
function enforceContainment(specifier: string, result: ResolveResult): ResolveResult {
	const url = result?.url;
	if (typeof url !== "string" || !url.startsWith("file:")) return result;

	let fileAbs: string;
	try {
		// Strip any cache-bust query/hash (the dispatcher's `?v=&e=`) before mapping
		// to a path — fileURLToPath uses the pathname only, but be explicit.
		const u = new URL(url);
		u.search = "";
		u.hash = "";
		fileAbs = fileURLToPath(u);
	} catch {
		throw new Error(`[confinement] could not resolve a file path for "${url}" (Extension Host §9 isolation)`);
	}
	if (!isPackPathWithinGroup(packRoot as string, fileAbs)) {
		throw new Error(
			`[confinement] import of "${specifier}" resolves to "${fileAbs}" which escapes the pack root "${packRoot}" (Extension Host §9 isolation)`,
		);
	}
	return result;
}
