/**
 * LSP supervisor — gateway-singleton.
 *
 * Owns the lifecycle of LSP child processes:
 *   • lazy spawn per (worktreePath, language)
 *   • LRU eviction at `maxServers` cap
 *   • idle-TTL shutdown
 *   • refcount-based release tied to session terminate
 *   • crash backoff with a stderr ring buffer surfaced through errors
 *   • config-file watcher → graceful shutdown (lazy respawn) on tsconfig change
 *
 * Adapters (typescript, pyright…) register a `LspClientFactory` at
 * construction. No language-specific code lives here.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import type { LspClient, LspClientFactory, SandboxLspBridge, SpawnOpts } from "./client.js";
import { languageForFile, findProjectRoot, detectLanguages } from "./language-detect.js";
import type { Language, Location } from "./types.js";
import { LspCapacityError, LspUnavailableError } from "./error.js";

export interface ServerKey { worktreePath: string; language: Language; }

export interface LspSupervisorOptions {
	maxServers?: number;
	idleTtlMs?: number;
	sandbox?: SandboxLspBridge | undefined;
	factories?: LspClientFactory[];
	/** Globally disable LSP — every tool call returns `lsp_unavailable`. */
	disabled?: boolean;
	/** Globally disable pre-warm (still allows on-demand `ensure`). */
	preWarmEnabled?: boolean;
	/** Filenames (relative to worktree) that should trigger a debounced restart. */
	watchFiles?: string[];
	/** Debounce window for config-file changes. */
	configChangeDebounceMs?: number;
}

/** Default config files that trigger a TS server restart on change. */
const DEFAULT_WATCH_FILES = [
	"tsconfig.json", "jsconfig.json", "package.json",
	// `fs.watch(dir)` reports any change in the dir; we filter by name below
	// so wildcards like tsconfig.*.json are honoured via the filter, not
	// individual watches.
];

interface Entry {
	key: ServerKey;
	clientP: Promise<LspClient>;
	client?: LspClient;
	lastActivityAt: number;
	refcount: number;
	idleTimer?: NodeJS.Timeout;
	inFlight: number;
	crashCount: number;
	lastCrashAt: number;
	disabledUntil: number;
	configWatcher?: fs.FSWatcher;
	configDebounce?: NodeJS.Timeout;
}

export type LspCallStatus = "ok" | "lsp_unavailable" | "lsp_capacity" | "lsp_timeout" | "lsp_route_missing" | "error";

/**
 * Process-local adoption telemetry. Owned by `LspSupervisor`, reset on every
 * gateway restart — no persistence. Exposed via `GET /api/lsp/stats.counters`
 * so we can measure whether LSP-vs-grep nudges are moving adoption.
 */
export interface LspTelemetryCounters {
	lspCallsTotal: number;
	lspCallsByMethod: Record<string, number>;
	lspCallsByStatus: Record<LspCallStatus, number>;
	/** Incremented by `recordHintEmitted()` from the grep/bash LSP hint tools
	 *  via `POST /api/lsp/_internal/hint-emitted`. */
	grepLspHintEmittedTotal: number;
}

/** Known LSP methods routed through `dispatch()`. Pre-seeded with 0 so the
 *  stats response has a stable shape even before any calls. */
const KNOWN_LSP_METHODS: readonly string[] = [
	"definition", "references", "hover", "diagnostics",
	"document_symbols", "workspace_symbol", "rename",
];

const KNOWN_LSP_STATUSES: readonly LspCallStatus[] = [
	"ok", "lsp_unavailable", "lsp_capacity", "lsp_timeout", "lsp_route_missing", "error",
];

export interface LspStats {
	maxServers: number;
	idleTtlMs: number;
	disabled: boolean;
	preWarmEnabled: boolean;
	sandbox: boolean;
	entries: Array<{
		worktreePath: string;
		language: Language;
		state: string;
		lastActivityAt: number;
		refcount: number;
		inFlight: number;
		crashCount: number;
		disabledUntil: number;
	}>;
	evictedTotal: number;
	/** Post-boot loopback self-check result. "ok" = all /api/lsp/* routes responded correctly;
	 *  "pending" = check has not completed yet; "failed:<route>:<status>" = route returned unexpected status.
	 *  Note: external callers of /api/lsp/stats await the in-flight self-check promise with a
	 *  bounded timeout (see LSP_ROUTE_SELF_CHECK_STATS_CAP_MS in server.ts, goal
	 *  fix-routes-1db8c87b). "pending" may still be surfaced if the bounded wait expires
	 *  before the post-boot probe completes — e.g. a pathologically slow or hung probe. */
	routeSelfCheck: string;
	/** Adoption telemetry — see `LspTelemetryCounters`. */
	counters: LspTelemetryCounters;
}

function keyOf(k: ServerKey): string { return `${k.language}::${k.worktreePath}`; }

export class LspSupervisor {
	readonly maxServers: number;
	readonly idleTtlMs: number;
	readonly disabled: boolean;
	readonly preWarmEnabled: boolean;
	private sandbox?: SandboxLspBridge | undefined;
	private factories = new Map<Language, LspClientFactory>();
	private entries = new Map<string, Entry>();
	/** Finding #3: crash state persists across entry deletions so 3 crashes
	 *  in 60s reliably trips the cooldown even though we delete the dead
	 *  entry on every exit. */
	private crashState = new Map<string, { count: number; lastAt: number; disabledUntil: number }>();
	/** Worktrees whose sessions run inside a sandbox container. LSP spawns
	 *  for these worktrees are required to use the sandbox bridge — host
	 *  fallback is refused (`LspSandboxRequiredError`). Populated by
	 *  session-setup AFTER `applySandboxWiring` returns and the project
	 *  container is live. */
	private sandboxedWorktrees = new Set<string>();
	private evictedTotal = 0;
	private shuttingDown = false;
	private watchFiles: string[];
	private configChangeDebounceMs: number;
	private _routeSelfCheck = "pending";
	private _routeSelfCheckPromise: Promise<void> | undefined;
	private _counters: LspTelemetryCounters = {
		lspCallsTotal: 0,
		lspCallsByMethod: Object.fromEntries(KNOWN_LSP_METHODS.map(m => [m, 0])),
		lspCallsByStatus: Object.fromEntries(KNOWN_LSP_STATUSES.map(s => [s, 0])) as Record<LspCallStatus, number>,
		grepLspHintEmittedTotal: 0,
	};

	constructor(opts: LspSupervisorOptions = {}) {
		this.maxServers = opts.maxServers ?? 4;
		this.idleTtlMs = opts.idleTtlMs ?? 10 * 60_000;
		this.disabled = opts.disabled ?? false;
		this.preWarmEnabled = opts.preWarmEnabled ?? true;
		this.sandbox = opts.sandbox;
		this.watchFiles = opts.watchFiles ?? DEFAULT_WATCH_FILES;
		this.configChangeDebounceMs = opts.configChangeDebounceMs ?? 1500;
		for (const f of opts.factories ?? []) this.factories.set(f.language, f);
	}

	registerFactory(f: LspClientFactory): void {
		this.factories.set(f.language, f);
	}

	hasFactory(language: Language): boolean {
		return this.factories.has(language) && this.factories.get(language)!.isInstalled();
	}

	/** Install or replace the sandbox bridge after construction (finding #6:
	 *  the SandboxManager is wired later in server boot than the supervisor). */
	setSandboxBridge(bridge: SandboxLspBridge | undefined): void {
		this.sandbox = bridge;
		this._sandboxLogged = false;
	}

	/** Whether a sandbox bridge is configured (finding #6 plumbing check). */
	hasSandboxBridge(): boolean { return !!this.sandbox; }

	/**
	 * Mark a worktree as sandboxed so subsequent LSP spawns refuse the host
	 * fallback. Must only be called AFTER `applySandboxWiring()` has succeeded
	 * — otherwise the sandbox bridge has no container ID yet and the very next
	 * `ensure()`/`preWarm()` will fail closed unnecessarily. session-setup
	 * owns the ordering.
	 */
	markSandboxed(worktreePath: string): void {
		this.sandboxedWorktrees.add(path.resolve(worktreePath));
	}

	/** Reverse `markSandboxed`. Called by session-setup on teardown so a
	 *  re-used worktree path (after cleanup) doesn't keep the sandbox-only
	 *  flag set indefinitely. */
	unmarkSandboxed(worktreePath: string): void {
		this.sandboxedWorktrees.delete(path.resolve(worktreePath));
	}

	/** Test/debug accessor. */
	isSandboxed(worktreePath: string): boolean {
		return this.sandboxedWorktrees.has(path.resolve(worktreePath));
	}

	/** Set the result of the post-boot route self-check. Called by the server boot loop. */
	setRouteSelfCheck(value: string): void {
		this._routeSelfCheck = value;
	}

	/** Store the in-flight post-boot route self-check promise so the /api/lsp/stats
	 *  route handler can await its settlement (with a bounded timeout) before reporting
	 *  routeSelfCheck. See goal fix-routes-1db8c87b. */
	setRouteSelfCheckPromise(promise: Promise<void> | undefined): void {
		this._routeSelfCheckPromise = promise;
	}

	/** Return the in-flight route self-check promise, or undefined if none is registered
	 *  (lsp disabled, or already-resolved-and-cleared). */
	getRouteSelfCheckPromise(): Promise<void> | undefined {
		return this._routeSelfCheckPromise;
	}

	/** Increment the grep/bash LSP-hint counter. Called via
	 *  `POST /api/lsp/_internal/hint-emitted` from tool extensions. */
	recordHintEmitted(): void {
		this._counters.grepLspHintEmittedTotal++;
	}

	/** Defensive deep copy of the telemetry counters so callers can't mutate
	 *  supervisor state through the `stats()` response. */
	private snapshotCounters(): LspTelemetryCounters {
		return {
			lspCallsTotal: this._counters.lspCallsTotal,
			lspCallsByMethod: { ...this._counters.lspCallsByMethod },
			lspCallsByStatus: { ...this._counters.lspCallsByStatus } as Record<LspCallStatus, number>,
			grepLspHintEmittedTotal: this._counters.grepLspHintEmittedTotal,
		};
	}

	stats(): LspStats {
		return {
			maxServers: this.maxServers,
			idleTtlMs: this.idleTtlMs,
			disabled: this.disabled,
			preWarmEnabled: this.preWarmEnabled,
			sandbox: !!this.sandbox,
			evictedTotal: this.evictedTotal,
			routeSelfCheck: this._routeSelfCheck,
			counters: this.snapshotCounters(),
			entries: [...this.entries.values()].map(e => {
				const cs = this.crashState.get(keyOf(e.key));
				return {
					worktreePath: e.key.worktreePath,
					language: e.key.language,
					state: e.client?.state ?? "starting",
					lastActivityAt: e.lastActivityAt,
					refcount: e.refcount,
					inFlight: e.inFlight,
					crashCount: cs?.count ?? 0,
					disabledUntil: cs?.disabledUntil ?? 0,
				};
			}),
		};
	}

	/**
	 * Public state lookup used by the progress-signal HTTP route (finding #2).
	 * Returns the entry's current client state, or `"cold"` if no entry exists.
	 */
	stateFor(key: ServerKey): string {
		const e = this.entries.get(keyOf(key));
		if (!e) return "cold";
		return e.client?.state ?? "starting";
	}

	/**
	 * Resolve `(worktree, language)` from a tool-call arg shape so the route
	 * can query state without performing a full dispatch. Mirrors the head of
	 * `dispatch()`.
	 */
	resolveKey(cwd: string, relPath?: string): ServerKey {
		const absInput = relPath ? path.resolve(cwd, relPath) : path.resolve(cwd);
		let lang: Language | null = relPath ? languageForFile(relPath) : null;
		if (!lang) {
			const root = findProjectRoot(path.resolve(cwd), "typescript");
			lang = detectLanguages(root)[0] ?? "typescript";
		}
		const worktreePath = findProjectRoot(relPath ? path.dirname(absInput) : path.resolve(cwd), lang);
		return { worktreePath, language: lang };
	}

	/**
	 * Acquire a warm client. Increments refcount; pair with `release()` when
	 * the holder is done.  Note: tool calls do **not** need to release —
	 * they are short-lived and refcount is for session-scope holders.
	 */
	async ensure(key: ServerKey): Promise<LspClient> {
		if (this.disabled) throw new LspUnavailableError("disabled by project config");
		if (this.shuttingDown) throw new LspUnavailableError("supervisor shutting down");
		const factory = this.factories.get(key.language);
		if (!factory) throw new LspUnavailableError(`no LSP adapter for ${key.language}`);
		if (!factory.isInstalled()) {
			throw new LspUnavailableError(`${key.language} LSP server not installed`);
		}
		const id = keyOf(key);
	const cs = this.crashState.get(id);
		if (cs && cs.disabledUntil > Date.now()) {
			throw new LspUnavailableError(`${key.language} disabled (recent crashes); retry later`);
		}
		let entry = this.entries.get(id);
		if (entry) {
			entry.lastActivityAt = Date.now();
			return entry.clientP;
		}
		// LRU eviction
		if (this.entries.size >= this.maxServers) {
			this.evictLru(id);
		}
	const spawnOpts: SpawnOpts = {
			worktreePath: key.worktreePath,
			sandbox: this.sandbox,
			// Finding #3: factories that honour `onClose` will invoke this on
			// unexpected child exit so the supervisor can drop the dead entry.
			onClose: (graceful: boolean) => this.handleEntryClose(id, graceful),
			// Security: when this worktree belongs to a sandboxed session, the
			// adapter must refuse host-fallback if no container is available.
			// Prevents untrusted sandbox files from being evaluated by a
			// host-side language server (e.g. tsserver) when sandbox wiring
			// is racing with preWarm or has not yet bound the container.
			requireSandbox: this.sandboxedWorktrees.has(key.worktreePath),
		};
		const newEntry: Entry = {
			key,
			clientP: factory.spawn(spawnOpts)
				.then(c => { newEntry.client = c; return c; })
				.catch(err => {
					// Failed to spawn — drop the entry so a retry will respawn.
					this.entries.delete(id);
					throw err instanceof Error ? err : new Error(String(err));
				}),
			lastActivityAt: Date.now(),
			refcount: 0,
			inFlight: 0,
			crashCount: 0,
			lastCrashAt: 0,
			disabledUntil: 0,
		};
		this.entries.set(id, newEntry);
		// Finding #5: watch tsconfig/package.json so we restart on schema
		// changes. Only meaningful for typescript adapters; cheap no-op for
		// other languages where the watch dir won't have these markers.
		this.installConfigWatcher(newEntry);
		// Finding #6: surface the sandbox-bridge presence once, the first
		// time we spawn an entry.
		if (this.sandbox && !this._sandboxLogged) {
			console.log(`[lsp] sandbox bridge active`);
			this._sandboxLogged = true;
		}
		return newEntry.clientP;
	}

	private _sandboxLogged = false;

	/** Best-effort pre-warm. Errors logged at warn, never thrown. */
	preWarm(worktreePath: string, _projectId?: string): void {
		if (this.shuttingDown || this.disabled || !this.preWarmEnabled) return;
		const wp = path.resolve(worktreePath);
		const langs = detectLanguages(wp);
		for (const lang of langs) {
			if (!this.hasFactory(lang)) continue;
			// Call ensure() directly (no queueMicrotask) so the entry exists before
			// any immediately-following acquire() call can increment its refcount.
			this.ensure({ worktreePath: wp, language: lang }).catch(err => {
				console.warn(`[lsp] pre-warm failed for ${lang} ${wp}: ${err?.message ?? err}`);
			});
		}
	}

	/** Increment refcount (called by session attach paths). */
	acquire(worktreePath: string): void {
		const wp = path.resolve(worktreePath);
		for (const entry of this.entries.values()) {
			if (entry.key.worktreePath === wp) {
				entry.refcount++;
				if (entry.idleTimer) {
					clearTimeout(entry.idleTimer);
					entry.idleTimer = undefined;
				}
			}
		}
	}

	/**
	 * Decrement refcount. If reaches 0 and no inFlight calls, start idle timer.
	 * Operates across all language entries for the worktree.
	 */
	release(worktreePath: string): void {
		const wp = path.resolve(worktreePath);
		for (const entry of this.entries.values()) {
			if (entry.key.worktreePath !== wp) continue;
			if (entry.refcount > 0) entry.refcount--;
			this.maybeArmIdleTimer(entry);
		}
	}

	/** Force-stop every server rooted at the worktree path. */
	async shutdownForWorktree(worktreePath: string): Promise<void> {
		const wp = path.resolve(worktreePath);
		this.sandboxedWorktrees.delete(wp);
		const promises: Promise<void>[] = [];
		for (const [id, entry] of [...this.entries.entries()]) {
			if (entry.key.worktreePath !== wp) continue;
			this.entries.delete(id);
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			this.disposeWatcher(entry);
			promises.push(this.shutdownEntry(entry));
		}
		await Promise.allSettled(promises);
	}

	async shutdownAll(): Promise<void> {
		this.shuttingDown = true;
		const promises: Promise<void>[] = [];
		for (const [, entry] of [...this.entries.entries()]) {
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			this.disposeWatcher(entry);
			promises.push(this.shutdownEntry(entry));
		}
		this.entries.clear();
		await Promise.allSettled(promises);
	}

	// ── Dispatch helpers used by gateway HTTP route ──────────────────────

	/**
	 * Dispatch a tool method to the right adapter. Resolves paths via
	 * `findProjectRoot` walking up from cwd. Input paths are relative to
	 * cwd; output `path` fields are returned relative to cwd.
	 */
	async dispatch(method: string, args: {
		cwd: string;
		path?: string;
		line?: number;
		character?: number;
		query?: string;
		newName?: string;
		includeDeclaration?: boolean;
	}): Promise<unknown> {
		// Telemetry: every dispatch entry counts toward the totals, regardless
		// of whether it succeeds. Status is recorded once via `recordStatus()`.
		this._counters.lspCallsTotal++;
		this._counters.lspCallsByMethod[method] = (this._counters.lspCallsByMethod[method] ?? 0) + 1;
		try {
			const out = await this.dispatchInner(method, args);
			this.recordStatus("ok");
			return out;
		} catch (err: any) {
			const code = err?.code;
			if (code === "lsp_unavailable" || code === "lsp_capacity" || code === "lsp_timeout" || code === "lsp_route_missing") {
				this.recordStatus(code as LspCallStatus);
			} else {
				this.recordStatus("error");
			}
			throw err;
		}
	}

	private recordStatus(status: LspCallStatus): void {
		this._counters.lspCallsByStatus[status] = (this._counters.lspCallsByStatus[status] ?? 0) + 1;
	}

	private async dispatchInner(method: string, args: {
		cwd: string;
		path?: string;
		line?: number;
		character?: number;
		query?: string;
		newName?: string;
		includeDeclaration?: boolean;
	}): Promise<unknown> {
		if (this.disabled) throw new LspUnavailableError("disabled by project config");
		const cwd = path.resolve(args.cwd);
		// Finding #7: clamp `path` to live inside `cwd`. Reject absolute or
		// upward-traversing inputs so a malicious agent cannot read files
		// outside its worktree via the LSP tool surface.
		if (args.path !== undefined) {
			if (typeof args.path !== "string" || args.path.length === 0) {
				throw new LspUnavailableError("path must be a non-empty string");
			}
			if (path.isAbsolute(args.path)) {
				throw new LspUnavailableError("path outside worktree");
			}
			const candidate = path.resolve(cwd, args.path);
			const rel = path.relative(cwd, candidate);
			if (rel.startsWith("..") || path.isAbsolute(rel)) {
				throw new LspUnavailableError("path outside worktree");
			}
		}
		const absInput = args.path ? path.resolve(cwd, args.path) : cwd;
		// Pick language: from file extension if a path is given, else default
		// to typescript for the worktree.
		let lang: Language | null = args.path ? languageForFile(args.path) : null;
		if (!lang) {
			// Fallback — pick the first detected language at the cwd's worktree.
			const root = findProjectRoot(cwd, "typescript");
			lang = detectLanguages(root)[0] ?? "typescript";
		}
		const worktreePath = findProjectRoot(args.path ? path.dirname(absInput) : cwd, lang);
		const client = await this.ensure({ worktreePath, language: lang });

		const entry = this.entries.get(keyOf({ worktreePath, language: lang }))!;
		entry.inFlight++;
		entry.lastActivityAt = Date.now();
		try {
			switch (method) {
				case "definition": {
					const loc = await client.definition(absInput, args.line ?? 0, args.character ?? 0);
					return loc ? this.relativise(loc, cwd) : null;
				}
				case "references": {
					const locs = await client.references(absInput, args.line ?? 0, args.character ?? 0, args.includeDeclaration ?? true);
					return locs.map(l => this.relativise(l, cwd));
				}
				case "hover":
					return await client.hover(absInput, args.line ?? 0, args.character ?? 0);
				case "diagnostics": {
					const diags = await client.diagnostics(args.path ? absInput : undefined);
					return diags.map(d => ({ ...d, path: path.relative(cwd, d.path) || path.basename(d.path) }));
				}
				case "document_symbols":
					return await client.documentSymbols(absInput);
				case "workspace_symbol": {
					const syms = await client.workspaceSymbol(args.query ?? "");
					return syms.map(s => ({ ...s, path: path.relative(cwd, s.path) || path.basename(s.path) }));
				}
				case "rename": {
					const we = await client.rename(absInput, args.line ?? 0, args.character ?? 0, args.newName ?? "");
					const out: Record<string, unknown> = {};
					for (const [absPath, edits] of Object.entries(we.changes)) {
						out[path.relative(cwd, absPath) || path.basename(absPath)] = edits;
					}
					return { changes: out };
				}
				default:
					throw new LspUnavailableError(`unknown method: ${method}`);
			}
		} finally {
			entry.inFlight--;
			entry.lastActivityAt = Date.now();
			this.maybeArmIdleTimer(entry);
		}
	}

	private relativise(loc: Location, cwd: string): Location {
		return { ...loc, path: path.relative(cwd, loc.path) || path.basename(loc.path) };
	}

	// ── Internal LRU / idle / shutdown ───────────────────────────────────

	private evictLru(_incomingId: string): void {
		let oldest: Entry | undefined;
		for (const e of this.entries.values()) {
			if (e.inFlight > 0) continue;
			if (!oldest || e.lastActivityAt < oldest.lastActivityAt) oldest = e;
		}
		if (!oldest) {
			throw new LspCapacityError(`LSP at capacity (${this.maxServers}); all in-flight`);
		}
		const id = keyOf(oldest.key);
		this.entries.delete(id);
		this.evictedTotal++;
		if (oldest.idleTimer) clearTimeout(oldest.idleTimer);
		this.disposeWatcher(oldest);
		console.log(`[lsp] evicting ${id} to make room`);
		this.shutdownEntry(oldest).catch(() => { /* logged in entry */ });
	}

	private maybeArmIdleTimer(entry: Entry): void {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		if (entry.refcount > 0 || entry.inFlight > 0) return;
		entry.idleTimer = setTimeout(() => {
			const id = keyOf(entry.key);
			if (this.entries.get(id) !== entry) return;
			if (entry.refcount > 0 || entry.inFlight > 0) {
				this.maybeArmIdleTimer(entry);
				return;
			}
			this.entries.delete(id);
			this.disposeWatcher(entry);
			this.shutdownEntry(entry).catch(() => { /* logged */ });
		}, this.idleTtlMs);
		(entry.idleTimer as any).unref?.();
	}

	private async shutdownEntry(entry: Entry): Promise<void> {
		try {
			const client = entry.client ?? await entry.clientP.catch(() => undefined);
			if (client) await client.shutdown(true);
		} catch (err) {
			console.warn(`[lsp] shutdown error for ${keyOf(entry.key)}: ${(err as Error)?.message ?? err}`);
		}
	}

	// ── Finding #3: crash detection + backoff ──────────────────────────

	/**
	 * Called by the client adapter when its child exits unexpectedly.
	 * `graceful=true` means we asked it to stop (no crash bookkeeping).
	 */
	private handleEntryClose(id: string, graceful: boolean): void {
		const entry = this.entries.get(id);
		if (entry) {
			this.entries.delete(id);
			this.disposeWatcher(entry);
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
		}
		if (graceful) return;
		const now = Date.now();
		let cs = this.crashState.get(id);
		if (!cs) cs = { count: 0, lastAt: 0, disabledUntil: 0 };
		// Reset crash window after 60s of quiet (per design).
		if (now - cs.lastAt > 60_000) cs.count = 0;
		cs.count++;
		cs.lastAt = now;
		if (cs.count >= 3) {
			cs.disabledUntil = now + 5 * 60_000;
			console.warn(`[lsp] ${id} disabled for 5min after ${cs.count} crashes`);
		}
		this.crashState.set(id, cs);
	}

	// ── Finding #5: tsconfig/package.json watcher ──────────────────────

	private installConfigWatcher(entry: Entry): void {
		if (entry.key.language !== "typescript") return;
		const dir = entry.key.worktreePath;
		try {
			const watcher = fs.watch(dir, { persistent: false }, (_evt, filename) => {
				if (!filename) return;
				const name = String(filename);
				// Match the explicit list + `tsconfig.*.json` family.
				const interesting =
					this.watchFiles.includes(name) ||
					/^tsconfig\..+\.json$/.test(name);
				if (!interesting) return;
				if (entry.configDebounce) clearTimeout(entry.configDebounce);
				entry.configDebounce = setTimeout(() => {
					if (this.entries.get(keyOf(entry.key)) !== entry) return;
					console.log(`[lsp] config change in ${dir}/${name} — graceful restart (lazy respawn)`);
					this.entries.delete(keyOf(entry.key));
					this.disposeWatcher(entry);
					if (entry.idleTimer) clearTimeout(entry.idleTimer);
					this.shutdownEntry(entry).catch(() => { /* logged */ });
				}, this.configChangeDebounceMs);
				(entry.configDebounce as any).unref?.();
			});
			watcher.on("error", () => { /* ignore — best-effort */ });
			entry.configWatcher = watcher;
		} catch (err) {
			console.warn(`[lsp] config watcher failed for ${dir}: ${(err as Error)?.message ?? err}`);
		}
	}

	private disposeWatcher(entry: Entry): void {
		if (entry.configDebounce) {
			clearTimeout(entry.configDebounce);
			entry.configDebounce = undefined;
		}
		if (entry.configWatcher) {
			try { entry.configWatcher.close(); } catch { /* ignore */ }
			entry.configWatcher = undefined;
		}
	}
}

// Re-export utilities used by gateway HTTP route + adapters.
export { pathToFileURL, fileURLToPath };
