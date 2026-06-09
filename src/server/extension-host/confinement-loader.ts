// src/server/extension-host/confinement-loader.ts
//
// The module-IMPORT containment hook half of the server-module isolation. This is
// loader / stability hygiene — NOT a security boundary. Pack server code is TRUSTED
// (tool/MCP tier) and runs with full ambient parity (normal `node:` built-ins, incl.
// `fs`); confining the pack's module GRAPH to its own root just keeps a pack from
// accidentally (or sloppily) reaching into another pack's files via the loader, and
// keeps the loader graph predictable. It does not — and is not meant to — stop a
// trusted pack from reading arbitrary files (it can `import("node:fs")` and read
// anything the gateway can).
//
// This module exports a SYNCHRONOUS `resolve` hook + a `configure` setter that the
// worker BOOTSTRAP (`module-host-bootstrap.ts`) installs via Node's IN-THREAD
// `module.registerHooks({ resolve })` BEFORE the pack server module (an
// `actions`/`routes` module) is dynamic-imported. In-thread (synchronous) hooks
// run in the SAME worker thread as the bootstrap — NOT a separate hooks thread —
// which is deliberate: it lets the guard run synchronously from the hook with no
// cross-thread marshalling and no module-customization-graph `.ts`/`.js`
// resolution gap. The realpath-containment guard (`path-guard`) is INJECTED by the
// bootstrap via `configure({ isWithin })` rather than imported here directly: the
// bootstrap loads `path-guard` (and its `node:fs` dep) only AFTER it has applied
// the session-dir module wraps, so the `node:fs` ESM facade is created AFTER the
// fs relative-path rebasing wrap is in place (importing it here would pre-build the
// facade during the static-import phase and defeat the wrap).
//
// The hook enforces ONE thing on every resolution the pack module graph makes:
//
//   PACK-ROOT CONTAINMENT — every resolved `file:` URL must be realpath-contained
//   within the validated pack group directory (the SAME root the dispatcher used to
//   load + validate the entry module). Without this, a pack module could
//   `import`/`require` a file OUTSIDE its own pack via a `../` walk, an absolute
//   path, a symlink escape, or a bare specifier that resolves into an ancestor
//   `node_modules`. Containment reuses the SHARED `isPackPathWithinGroup` path-guard
//   helper so the lexical + realpath checks stay byte-consistent with the HTTP
//   entry-serving endpoints.
//
// This containment hook is one half of the isolation; the other (terminate /
// resource caps / spawned-child kill) lives in module-host-worker.ts — that is the
// genuine, defensible boundary. This hook is import hygiene only.

import { fileURLToPath } from "node:url";

/** The realpath-containment check, INJECTED by the bootstrap (it imports the
 *  shared `path-guard` helper). The bootstrap injects it instead of this module
 *  importing `path-guard` directly so that NO `node:fs` (path-guard's dependency)
 *  ESM facade is created during the worker's static-import phase — that would
 *  pre-build the `node:fs` facade BEFORE the bootstrap can wrap it for fs
 *  relative-path rebasing. The bootstrap loads path-guard AFTER applying the
 *  session-dir wraps and passes its `isPackPathWithinGroup` here. */
type PackPathGuard = (groupAbs: string, fileAbs: string) => boolean;

/** The configuration passed by the bootstrap before installing the hook. */
export interface ConfinementConfig {
	/** Absolute path of the validated pack group root (the dispatcher's `groupDir`).
	 *  Every resolved `file:` URL in the pack module graph must stay realpath-
	 *  contained within it. Absent ⇒ no containment enforcement (defensive default;
	 *  the production dispatchers ALWAYS supply it). */
	packRoot?: string;
	/** The realpath-containment check (the shared `path-guard` helper), injected by
	 *  the bootstrap. REQUIRED whenever `packRoot` is set — a missing guard with a
	 *  set root is treated as unsafe (every escaping import is rejected). */
	isWithin?: PackPathGuard;
}

let packRoot: string | undefined;
let isWithin: PackPathGuard | undefined;

/** Configure the hook BEFORE installing it (called by the bootstrap once, before
 *  any pack module is imported). */
export function configure(config: ConfinementConfig): void {
	packRoot = typeof config?.packRoot === "string" && config.packRoot.length > 0 ? config.packRoot : undefined;
	isWithin = typeof config?.isWithin === "function" ? config.isWithin : undefined;
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
 * The module-import containment chokepoint (a SYNCHRONOUS `module.registerHooks`
 * resolve hook). It lets the chain resolve every specifier to a concrete URL, then
 * rejects any `file:` URL that escapes the validated pack root. An escaping
 * specifier throws a loud, prefixed error so misuse is never silent; everything
 * else falls through unchanged. This is import hygiene, not a security boundary.
 */
export function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): ResolveResult {
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
	if (typeof isWithin !== "function") {
		// A set pack root with no injected guard is unsafe — fail closed.
		throw new Error(
			`[confinement] no path-guard injected while a pack root "${packRoot}" is set; cannot prove containment for "${specifier}" (Extension Host §9 isolation)`,
		);
	}
	if (!isWithin(packRoot as string, fileAbs)) {
		throw new Error(
			`[confinement] import of "${specifier}" resolves to "${fileAbs}" which escapes the pack root "${packRoot}" (Extension Host §9 isolation)`,
		);
	}
	return result;
}
