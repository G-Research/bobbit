// src/server/lsp/supervisor.ts
//
// TsServerSupervisor — the gateway-owned, persistent replacement for
// `lsp-cli.mjs`'s spawn-query-shutdown-per-call shape (design doc
// docs/design/lsp-product-tools.md §1 + §4(b)).
//
// One `typescript-language-server` instance per worktree root, lazily
// spawned on the first `code_*` call for that worktree, idle-shut-down after
// `idleMs` of inactivity. Never pre-warmed (that would race
// `WorktreePool.claim()`'s rename-before-return — see design doc §1).
//
// Fail-open, unconditionally (design doc §6): every public method returns a
// typed `{ available: false, reason, retryable? }` outcome rather than
// throwing or hanging — missing tsconfig, an unspawnable
// typescript-language-server binary, an init/query timeout, and a mid-session
// tsserver crash are all ordinary, expected outcomes, not exceptional ones.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	LspClient,
	LspTimeoutError,
	buildInitializeParams,
	flattenSymbols,
	formatLocationWithWorkspace,
	formatWorkspaceSymbol,
	languageIdFor,
	pollQuery,
	type FlatSymbol,
	type FormattedLocationWithWorkspace,
	type FormattedWorkspaceSymbol,
} from "./client.js";

// ── Public request/outcome types ────────────────────────────────────────────

export interface LspFileRequest {
	/** Git worktree root (or session cwd for non-worktree sessions) — the supervisor's instance key. */
	worktreeRoot: string;
	/** Absolute path to the target file. Must be resolved (and worktree-membership-checked) by the caller — the supervisor does no path escaping/normalization of its own. */
	absFile: string;
}

export interface LspPositionRequest extends LspFileRequest {
	/** 1-based line number (editor convention — converted to LSP's 0-based internally). */
	line: number;
	/** 1-based column number. */
	col: number;
}

export interface LspSymbolsRequest extends LspFileRequest {
	/** When set, runs a project-wide `workspace/symbol` search instead of a single-file `documentSymbol`. */
	query?: string;
}

export type LspUnavailable = {
	available: false;
	reason: string;
	/** True if the SAME call is likely to succeed on retry (e.g. cold-load timeout, transient crash) — false for structural gaps (no tsconfig, non-existent file). */
	retryable?: boolean;
};

export type LspLocationsOutcome =
	| { available: true; locations: FormattedLocationWithWorkspace[]; truncated: boolean; totalCount: number }
	| LspUnavailable;

export type LspHoverOutcome =
	| { available: true; contents: string; truncated: boolean; totalChars: number }
	| LspUnavailable;

export type LspSymbolsOutcome =
	| { available: true; mode: "file" | "workspace"; symbols: Array<FlatSymbol | FormattedWorkspaceSymbol>; truncated: boolean; totalCount: number }
	| LspUnavailable;

export interface TsServerSupervisorOptions {
	/** Idle-shutdown TTL in ms. Default 10 minutes (design doc §1). */
	idleMs?: number;
	/** Query timeout for the FIRST query against a freshly spawned instance (project still loading). Default 60s, matching `lsp-cli.mjs`. */
	coldTimeoutMs?: number;
	/** Query timeout for every query after the first against a given instance. Default 15s (design doc §6 — a warm instance should answer fast). */
	warmTimeoutMs?: number;
	/** Timeout for the `initialize` handshake itself. Default 60s. */
	initTimeoutMs?: number;
	/** Max locations returned by `definition`/`references`. Default 50 (design doc §2). */
	locationsCap?: number;
	/** Max symbols returned by `symbols`. Default 50. */
	symbolsCap?: number;
	/** Max characters of hover content returned. Default 4000 (~4KB, design doc §2). */
	hoverCharCap?: number;
	/** Injectable process factory — unit tests substitute a stubbed tsserver-like process here instead of spawning the real binary. */
	spawnProcess?: (worktreeRoot: string) => ChildProcessWithoutNullStreams;
}

// ── Internal instance bookkeeping ───────────────────────────────────────────

interface TsServerInstance {
	client: LspClient;
	proc: ChildProcessWithoutNullStreams;
	worktreeRoot: string;
	openedFiles: Set<string>;
	idleTimer: NodeJS.Timeout | null;
	dead: boolean;
	/** Set true after the instance has served (or attempted) its first query — gates cold vs. warm timeout selection. */
	queriedOnce: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Walk from `startDir` up to (and including) `stopAtInclusive` looking for a tsconfig.json. Mirrors `lsp-cli.mjs`'s git-toplevel-style upward resolution, but for tsconfig instead of .git (design doc §6). */
export function hasTsconfigUpward(startDir: string, stopAtInclusive: string): boolean {
	const stop = path.resolve(stopAtInclusive);
	let dir = path.resolve(startDir);
	for (;;) {
		if (fs.existsSync(path.join(dir, "tsconfig.json"))) return true;
		if (dir === stop) return false;
		const parent = path.dirname(dir);
		if (parent === dir) return false; // reached filesystem root without finding stop — safety bound
		dir = parent;
	}
}

function capList<T>(items: T[], cap: number): { items: T[]; truncated: boolean; totalCount: number } {
	return { items: items.slice(0, cap), truncated: items.length > cap, totalCount: items.length };
}

function capText(text: string, capChars: number): { text: string; truncated: boolean; totalChars: number } {
	if (text.length <= capChars) return { text, truncated: false, totalChars: text.length };
	return {
		text: `${text.slice(0, capChars)}\n… [truncated, ${text.length - capChars} more chars — call code_hover again on a narrower type if you need the rest]`,
		truncated: true,
		totalChars: text.length,
	};
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_COLD_TIMEOUT_MS = 60_000;
const DEFAULT_WARM_TIMEOUT_MS = 15_000;
const DEFAULT_INIT_TIMEOUT_MS = 60_000;
const DEFAULT_LOCATIONS_CAP = 50;
const DEFAULT_SYMBOLS_CAP = 50;
const DEFAULT_HOVER_CHAR_CAP = 4000;

export class TsServerSupervisor {
	private instances = new Map<string, TsServerInstance>();
	private spawning = new Map<string, Promise<TsServerInstance>>();
	private readonly idleMs: number;
	private readonly coldTimeoutMs: number;
	private readonly warmTimeoutMs: number;
	private readonly initTimeoutMs: number;
	private readonly locationsCap: number;
	private readonly symbolsCap: number;
	private readonly hoverCharCap: number;
	private readonly spawnProcessFn: (worktreeRoot: string) => ChildProcessWithoutNullStreams;

	constructor(opts: TsServerSupervisorOptions = {}) {
		this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
		this.coldTimeoutMs = opts.coldTimeoutMs ?? DEFAULT_COLD_TIMEOUT_MS;
		this.warmTimeoutMs = opts.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS;
		this.initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
		this.locationsCap = opts.locationsCap ?? DEFAULT_LOCATIONS_CAP;
		this.symbolsCap = opts.symbolsCap ?? DEFAULT_SYMBOLS_CAP;
		this.hoverCharCap = opts.hoverCharCap ?? DEFAULT_HOVER_CHAR_CAP;
		this.spawnProcessFn =
			opts.spawnProcess ??
			((worktreeRoot: string) =>
				spawn("typescript-language-server", ["--stdio"], { stdio: ["pipe", "pipe", "pipe"], cwd: worktreeRoot }));
	}

	/** Test/introspection helper — number of live (non-dead) instances. */
	get instanceCount(): number {
		return this.instances.size;
	}

	/** Test/introspection helper — true if `worktreeRoot` currently has a live instance. */
	hasInstance(worktreeRoot: string): boolean {
		return this.instances.has(worktreeRoot);
	}

	async definition(req: LspPositionRequest): Promise<LspLocationsOutcome> {
		const prep = await this.prepare(req);
		if ("available" in prep) return prep;
		const { instance, fileUri, timeoutMs } = prep;
		const position = { line: req.line - 1, character: req.col - 1 };
		try {
			const result = await pollQuery(instance.client, "textDocument/definition", { textDocument: { uri: fileUri }, position }, timeoutMs);
			const locations = (Array.isArray(result) ? result : [result]).map((loc: any) =>
				formatLocationWithWorkspace(loc, req.worktreeRoot),
			);
			const capped = capList(locations, this.locationsCap);
			return { available: true, locations: capped.items, truncated: capped.truncated, totalCount: capped.totalCount };
		} catch (err) {
			return this.queryErrorToOutcome(err);
		}
	}

	async references(req: LspPositionRequest): Promise<LspLocationsOutcome> {
		const prep = await this.prepare(req);
		if ("available" in prep) return prep;
		const { instance, fileUri, timeoutMs } = prep;
		const position = { line: req.line - 1, character: req.col - 1 };
		try {
			const result = await pollQuery(
				instance.client,
				"textDocument/references",
				{ textDocument: { uri: fileUri }, position, context: { includeDeclaration: true } },
				timeoutMs,
			);
			const resultArr: any[] = result ?? [];
			const locations = resultArr.map((loc: any) => formatLocationWithWorkspace(loc, req.worktreeRoot));
			const capped = capList(locations, this.locationsCap);
			return { available: true, locations: capped.items, truncated: capped.truncated, totalCount: capped.totalCount };
		} catch (err) {
			return this.queryErrorToOutcome(err);
		}
	}

	async hover(req: LspPositionRequest): Promise<LspHoverOutcome> {
		const prep = await this.prepare(req);
		if ("available" in prep) return prep;
		const { instance, fileUri, timeoutMs } = prep;
		const position = { line: req.line - 1, character: req.col - 1 };
		try {
			const result = await pollQuery(instance.client, "textDocument/hover", { textDocument: { uri: fileUri }, position }, timeoutMs);
			const raw = result?.contents?.value ?? result?.contents ?? "";
			const text = typeof raw === "string" ? raw : JSON.stringify(raw);
			const capped = capText(text, this.hoverCharCap);
			return { available: true, contents: capped.text, truncated: capped.truncated, totalChars: capped.totalChars };
		} catch (err) {
			return this.queryErrorToOutcome(err);
		}
	}

	async symbols(req: LspSymbolsRequest): Promise<LspSymbolsOutcome> {
		const prep = await this.prepare(req);
		if ("available" in prep) return prep;
		const { instance, fileUri, timeoutMs } = prep;
		try {
			if (req.query) {
				// Warm the anchor file first — workspace/symbol depends on tsserver's
				// project-wide nav index; under load it can initially answer []
				// even after the server accepts requests, while documentSymbol
				// succeeds (mirrors lsp-cli.mjs's `workspace` two-step, design doc §2).
				await pollQuery(instance.client, "textDocument/documentSymbol", { textDocument: { uri: fileUri } }, Math.min(timeoutMs, 30_000)).catch(
					() => undefined,
				);
				const result = await pollQuery(instance.client, "workspace/symbol", { query: req.query }, timeoutMs);
				const resultArr: any[] = result ?? [];
				const symbols = resultArr
					.filter((sym: any) => sym?.location?.uri)
					.map((sym: any) => formatWorkspaceSymbol(sym, req.worktreeRoot));
				const capped = capList(symbols, this.symbolsCap);
				return { available: true, mode: "workspace", symbols: capped.items, truncated: capped.truncated, totalCount: capped.totalCount };
			}
			const result = await pollQuery(instance.client, "textDocument/documentSymbol", { textDocument: { uri: fileUri } }, timeoutMs);
			const symbols = flattenSymbols(result);
			const capped = capList(symbols, this.symbolsCap);
			return { available: true, mode: "file", symbols: capped.items, truncated: capped.truncated, totalCount: capped.totalCount };
		} catch (err) {
			return this.queryErrorToOutcome(err);
		}
	}

	/** Gracefully tear down every live instance — call on gateway shutdown. Also used by tests to reset state between cases. */
	async shutdownAll(): Promise<void> {
		const all = [...this.instances.values()];
		this.instances.clear();
		await Promise.all(all.map((instance) => this.killInstance(instance)));
	}

	// ── Internals ──────────────────────────────────────────────────────────

	private queryErrorToOutcome(err: unknown): LspUnavailable {
		if (err instanceof LspTimeoutError) {
			return { available: false, reason: err.message, retryable: true };
		}
		const message = err instanceof Error ? err.message : String(err);
		// Any other query-time failure (client rejected due to a mid-query crash,
		// a malformed frame, etc.) is treated as retryable: the NEXT call gets a
		// fresh instance because a dead one is never left in `this.instances`
		// (design doc §6 — "an exited process is never silently reused").
		return { available: false, reason: message, retryable: true };
	}

	private async prepare(
		req: LspFileRequest,
	): Promise<{ instance: TsServerInstance; fileUri: string; timeoutMs: number } | LspUnavailable> {
		if (!fs.existsSync(req.absFile)) {
			return { available: false, reason: `file not found: ${req.absFile}` };
		}
		if (!hasTsconfigUpward(path.dirname(req.absFile), req.worktreeRoot)) {
			return { available: false, reason: `no tsconfig.json found under ${req.worktreeRoot}` };
		}
		const got = await this.getOrSpawn(req.worktreeRoot);
		if ("error" in got) {
			return { available: false, reason: got.error, retryable: true };
		}
		const instance = got;
		try {
			this.ensureOpen(instance, req.absFile);
		} catch (err) {
			return { available: false, reason: `could not read file: ${err instanceof Error ? err.message : String(err)}` };
		}
		const timeoutMs = instance.queriedOnce ? this.warmTimeoutMs : this.coldTimeoutMs;
		instance.queriedOnce = true;
		const fileUri = pathToFileURL(req.absFile).toString();
		return { instance, fileUri, timeoutMs };
	}

	private async getOrSpawn(worktreeRoot: string): Promise<TsServerInstance | { error: string }> {
		const existing = this.instances.get(worktreeRoot);
		if (existing && !existing.dead) {
			this.touch(existing);
			return existing;
		}
		let inflight = this.spawning.get(worktreeRoot);
		if (!inflight) {
			inflight = this.spawnInstance(worktreeRoot);
			this.spawning.set(worktreeRoot, inflight);
			// `.finally()` returns a NEW promise that mirrors `inflight`'s
			// rejection. `inflight` itself is properly handled below (awaited in
			// a try/catch), but this derived promise is discarded — without the
			// `.catch(() => {})`, a spawn failure would ALSO reject this discarded
			// promise and surface as an unrelated unhandledRejection.
			inflight.finally(() => this.spawning.delete(worktreeRoot)).catch(() => {});
		}
		try {
			const instance = await inflight;
			this.instances.set(worktreeRoot, instance);
			this.touch(instance);
			return instance;
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	private async spawnInstance(worktreeRoot: string): Promise<TsServerInstance> {
		const proc = this.spawnProcessFn(worktreeRoot);
		const client = new LspClient(proc);
		let initialized = false;
		const instance: TsServerInstance = {
			client,
			proc,
			worktreeRoot,
			openedFiles: new Set(),
			idleTimer: null,
			dead: false,
			queriedOnce: false,
		};

		const earlyFailure = new Promise<never>((_, reject) => {
			proc.once("error", (err) => reject(new Error(`failed to spawn typescript-language-server: ${err.message}`)));
			proc.once("exit", (code) => {
				if (!initialized) reject(new Error(`typescript-language-server exited before initializing (code ${code ?? "null"})`));
			});
		});

		const initTimeout = new Promise<never>((_, reject) => {
			const t = setTimeout(
				() => reject(new Error(`typescript-language-server did not initialize within ${this.initTimeoutMs}ms`)),
				this.initTimeoutMs,
			);
			t.unref?.();
		});

		const doInit = (async () => {
			const rootUri = pathToFileURL(worktreeRoot).toString();
			await client.request("initialize", buildInitializeParams({ processId: process.pid, rootUri, rootPath: worktreeRoot }));
			client.notify("initialized", {});
			initialized = true;
		})();

		// Promise.race never "cancels" the losing promises — whichever of
		// doInit/earlyFailure/initTimeout doesn't win the race keeps running
		// and, since these are all failure-shaped promises, will very likely
		// reject LATER (e.g. initTimeout's setTimeout still fires even after
		// earlyFailure already won). Without a handler attached directly to
		// each one, that belated rejection surfaces as an `unhandledRejection`
		// at an arbitrary later point instead of being contained here. `guard`
		// attaches a no-op `.catch` to the promise itself (not a copy) so a
		// later rejection is silently observed without changing what
		// `Promise.race` resolves/rejects with.
		const guard = <T>(p: Promise<T>): Promise<T> => {
			p.catch(() => {});
			return p;
		};

		try {
			await Promise.race([guard(doInit), guard(earlyFailure), guard(initTimeout)]);
		} catch (err) {
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
			throw err;
		}

		this.wireCrashHandlers(instance);
		return instance;
	}

	private ensureOpen(instance: TsServerInstance, absFile: string): void {
		if (instance.openedFiles.has(absFile)) return;
		const text = fs.readFileSync(absFile, "utf8");
		const fileUri = pathToFileURL(absFile).toString();
		instance.client.notify("textDocument/didOpen", {
			textDocument: { uri: fileUri, languageId: languageIdFor(absFile), version: 1, text },
		});
		instance.openedFiles.add(absFile);
	}

	private wireCrashHandlers(instance: TsServerInstance): void {
		const onDown = (reason: Error) => {
			if (instance.dead) return;
			instance.dead = true;
			if (this.instances.get(instance.worktreeRoot) === instance) this.instances.delete(instance.worktreeRoot);
			if (instance.idleTimer) clearTimeout(instance.idleTimer);
			instance.client._rejectAll(reason);
		};
		instance.proc.on("exit", (code) => onDown(new Error(`typescript-language-server exited unexpectedly (code ${code ?? "null"})`)));
		instance.proc.on("error", (err) => onDown(err));
	}

	private touch(instance: TsServerInstance): void {
		if (instance.idleTimer) clearTimeout(instance.idleTimer);
		const timer = setTimeout(() => this.evictIdle(instance), this.idleMs);
		timer.unref?.();
		instance.idleTimer = timer;
	}

	private evictIdle(instance: TsServerInstance): void {
		if (this.instances.get(instance.worktreeRoot) !== instance) return;
		this.instances.delete(instance.worktreeRoot);
		void this.killInstance(instance);
	}

	private async killInstance(instance: TsServerInstance): Promise<void> {
		if (instance.idleTimer) clearTimeout(instance.idleTimer);
		instance.dead = true;
		try {
			await Promise.race([instance.client.request("shutdown", null), sleep(2000)]);
			instance.client.notify("exit", null);
		} catch {
			/* best-effort — fall through to kill */
		}
		try {
			instance.proc.kill();
		} catch {
			/* already dead */
		}
	}
}
