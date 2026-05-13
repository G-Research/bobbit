/**
 * LSP supervisor — gateway-singleton.
 *
 * Owns the lifecycle of LSP child processes:
 *   • lazy spawn per (worktreePath, language)
 *   • LRU eviction at `maxServers` cap
 *   • idle-TTL shutdown
 *   • refcount-based release tied to session terminate
 *   • crash backoff with a stderr ring buffer surfaced through errors
 *
 * Adapters (typescript, pyright…) register a `LspClientFactory` at
 * construction. No language-specific code lives here.
 */
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import type { LspClient, LspClientFactory, SandboxLspBridge } from "./client.js";
import { languageForFile, findProjectRoot, detectLanguages } from "./language-detect.js";
import type { Language, Location } from "./types.js";
import { LspCapacityError, LspUnavailableError } from "./error.js";

export interface ServerKey { worktreePath: string; language: Language; }

export interface LspSupervisorOptions {
	maxServers?: number;
	idleTtlMs?: number;
	sandbox?: SandboxLspBridge | undefined;
	factories?: LspClientFactory[];
}

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
}

export interface LspStats {
	maxServers: number;
	idleTtlMs: number;
	entries: Array<{
		worktreePath: string;
		language: Language;
		state: string;
		lastActivityAt: number;
		refcount: number;
		inFlight: number;
		crashCount: number;
	}>;
	evictedTotal: number;
}

function keyOf(k: ServerKey): string { return `${k.language}::${k.worktreePath}`; }

export class LspSupervisor {
	readonly maxServers: number;
	readonly idleTtlMs: number;
	private sandbox?: SandboxLspBridge | undefined;
	private factories = new Map<Language, LspClientFactory>();
	private entries = new Map<string, Entry>();
	private evictedTotal = 0;
	private shuttingDown = false;

	constructor(opts: LspSupervisorOptions = {}) {
		this.maxServers = opts.maxServers ?? 4;
		this.idleTtlMs = opts.idleTtlMs ?? 10 * 60_000;
		this.sandbox = opts.sandbox;
		for (const f of opts.factories ?? []) this.factories.set(f.language, f);
	}

	registerFactory(f: LspClientFactory): void {
		this.factories.set(f.language, f);
	}

	hasFactory(language: Language): boolean {
		return this.factories.has(language) && this.factories.get(language)!.isInstalled();
	}

	stats(): LspStats {
		return {
			maxServers: this.maxServers,
			idleTtlMs: this.idleTtlMs,
			evictedTotal: this.evictedTotal,
			entries: [...this.entries.values()].map(e => ({
				worktreePath: e.key.worktreePath,
				language: e.key.language,
				state: e.client?.state ?? "starting",
				lastActivityAt: e.lastActivityAt,
				refcount: e.refcount,
				inFlight: e.inFlight,
				crashCount: e.crashCount,
			})),
		};
	}

	/**
	 * Acquire a warm client. Increments refcount; pair with `release()` when
	 * the holder is done.  Note: tool calls do **not** need to release —
	 * they are short-lived and refcount is for session-scope holders.
	 */
	async ensure(key: ServerKey): Promise<LspClient> {
		if (this.shuttingDown) throw new LspUnavailableError("supervisor shutting down");
		const factory = this.factories.get(key.language);
		if (!factory) throw new LspUnavailableError(`no LSP adapter for ${key.language}`);
		if (!factory.isInstalled()) {
			throw new LspUnavailableError(`${key.language} LSP server not installed`);
		}
		const id = keyOf(key);
		let entry = this.entries.get(id);
		if (entry) {
			if (entry.disabledUntil > Date.now()) {
				throw new LspUnavailableError(`${key.language} disabled (recent crashes); retry later`);
			}
			entry.lastActivityAt = Date.now();
			return entry.clientP;
		}
		// LRU eviction
		if (this.entries.size >= this.maxServers) {
			this.evictLru(id);
		}
		const newEntry: Entry = {
			key,
			clientP: factory.spawn({ worktreePath: key.worktreePath, sandbox: this.sandbox })
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
		return newEntry.clientP;
	}

	/** Best-effort pre-warm. Errors logged at warn, never thrown. */
	preWarm(worktreePath: string, _projectId?: string): void {
		if (this.shuttingDown) return;
		const wp = path.resolve(worktreePath);
		const langs = detectLanguages(wp);
		for (const lang of langs) {
			if (!this.hasFactory(lang)) continue;
			queueMicrotask(() => {
				this.ensure({ worktreePath: wp, language: lang }).catch(err => {
					console.warn(`[lsp] pre-warm failed for ${lang} ${wp}: ${err?.message ?? err}`);
				});
			});
		}
	}

	/** Increment refcount (called by session attach paths). */
	acquire(worktreePath: string): void {
		const wp = path.resolve(worktreePath);
		for (const entry of this.entries.values()) {
			if (entry.key.worktreePath === wp) entry.refcount++;
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
		const promises: Promise<void>[] = [];
		for (const [id, entry] of [...this.entries.entries()]) {
			if (entry.key.worktreePath !== wp) continue;
			this.entries.delete(id);
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			promises.push(this.shutdownEntry(entry));
		}
		await Promise.allSettled(promises);
	}

	async shutdownAll(): Promise<void> {
		this.shuttingDown = true;
		const promises: Promise<void>[] = [];
		for (const [, entry] of [...this.entries.entries()]) {
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
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
		const cwd = path.resolve(args.cwd);
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
		console.log(`[lsp] evicting ${id} to make room`);
		this.shutdownEntry(oldest).catch(() => { /* logged in entry */ });
	}

	private maybeArmIdleTimer(entry: Entry): void {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		if (entry.refcount > 0 || entry.inFlight > 0) return;
		entry.idleTimer = setTimeout(() => {
			const id = keyOf(entry.key);
			if (this.entries.get(id) !== entry) return;
			if (entry.refcount > 0 || entry.inFlight > 0) {
				this.maybeArmIdleTimer(entry);
				return;
			}
			this.entries.delete(id);
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
}

// Re-export utilities used by gateway HTTP route + adapters.
export { pathToFileURL, fileURLToPath };
