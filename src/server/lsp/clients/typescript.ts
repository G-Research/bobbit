/**
 * typescript-language-server adapter.
 *
 * Spawns the server, drives JSON-RPC initialize, exposes the typed methods
 * the supervisor surfaces. Diagnostics are accumulated from
 * `textDocument/publishDiagnostics` notifications; callers `diagnostics()`
 * triggers a brief settle window before returning the latest snapshot.
 */
import fs from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
	resolveTypescriptLanguageServer,
	spawnLspChild,
	type LspProcess,
} from "../server-process.js";
import type { LspClient, LspClientFactory, SpawnOpts, ClientState, SandboxLspBridge } from "../client.js";
import type {
	Diagnostic, DocumentSymbol, HoverResult, Language, Location,
	Range, SymbolInformation, WorkspaceEdit,
} from "../types.js";

function uriToPath(uri: string): string {
	if (uri.startsWith("file://")) return fileURLToPath(uri);
	return uri;
}
function pathToUri(p: string): string {
	return pathToFileURL(p).href;
}

function lspSeverity(n?: number): Diagnostic["severity"] {
	switch (n) {
		case 1: return "error";
		case 2: return "warning";
		case 3: return "info";
		case 4: return "hint";
		default: return "info";
	}
}

interface DocState { version: number; }

class TypescriptLspClient implements LspClient {
	readonly language: Language = "typescript";
	readonly worktreePath: string;
	state: ClientState = "starting";
	private proc!: LspProcess;
	/** Stable per-client bridge (never overwritten after start). Resolved from
	 *  the multi-project bridge at startup so concurrent clients don't share
	 *  mutable path-translation state. */
	private bridge?: SandboxLspBridge;

	/** Host absolute path → URI for sending to the LSP server (container-translated when sandboxed). */
	private toUri(absPath: string): string {
		return this.bridge ? pathToUri(this.bridge.toContainerPath(absPath)) : pathToUri(absPath);
	}
	/** URI from LSP server → host absolute path (container-translated back when sandboxed). */
	private fromUri(uri: string): string {
		const p = uriToPath(uri);
		return this.bridge ? this.bridge.toHostPath(p) : p;
	}

	private openDocs = new Map<string, DocState>(); // absPath → state
	private diagnosticsByUri = new Map<string, Diagnostic[]>();
	private diagVersionByUri = new Map<string, number>();
	private diagListeners = new Map<string, Set<() => void>>();
	/** Finding #3: set to true when shutdown() is invoked so the exit handler
	 *  reports a graceful close instead of a crash. */
	private shutdownRequested = false;
	private onClose?: (graceful: boolean) => void;

	constructor(worktreePath: string) {
		this.worktreePath = worktreePath;
	}

	async start(sandbox: SpawnOpts["sandbox"], onClose?: (graceful: boolean) => void, requireSandbox?: boolean): Promise<void> {
		// Resolve a stable per-client bridge to avoid shared mutable state
		// (lastBridge) when multiple projects have concurrent LSP processes.
		// Only attach the bridge when a sandbox container is actually running for
		// this worktree; otherwise spawnLspChild() falls back to a host process and
		// bridge.toUri() would translate host paths to container paths (e.g.
		// /workspace-wt/<branch>) that don't exist on the host, breaking
		// `initialize` with ENOENT. Do not simplify back to an unconditional cache
		// — bug surfaced by coder sessions 03afb128 / 9150a1de on 2026-05-14.
		const resolvedBridge = sandbox?.resolveForWorktree?.(this.worktreePath) ?? sandbox;
		const containerId = resolvedBridge?.containerIdForWorktree?.(this.worktreePath) ?? null;
		this.bridge = containerId ? resolvedBridge : undefined;
		this.onClose = onClose;
		const resolved = resolveTypescriptLanguageServer();
		if (!resolved) throw new Error("typescript-language-server not installed");
		this.proc = await spawnLspChild({
			worktreePath: this.worktreePath,
			command: resolved.node,
			args: [resolved.cliMjs, "--stdio"],
			// In a sandbox container, use the globally-installed binary from PATH
			// (Dockerfile: RUN npm install -g typescript typescript-language-server).
			sandboxCmd: ["typescript-language-server", "--stdio"],
			sandbox,
			requireSandbox,
		});

		this.proc.child.on("exit", (code) => {
			const wasWarm = this.state !== "stopping" && this.state !== "stopped";
			this.state = "stopped";
			if (code !== 0 && code !== null) {
				console.warn(`[lsp:ts] child exited code=${code}\n${this.proc.stderrTail().slice(-2048)}`);
			}
			// Finding #3: notify supervisor on every exit so it can drop the dead
			// entry. `graceful=true` if we explicitly asked the child to stop.
			if (wasWarm) {
				try { this.onClose?.(this.shutdownRequested); } catch { /* ignore */ }
			}
		});

		this.proc.connection.onNotification("textDocument/publishDiagnostics", (p: any) => {
			const rawUri = p?.uri as string;
			if (!rawUri) return;
			// Translate container URI → host path, then re-serialise as host URI
			// so diagnosticsByUri is always keyed by host-side URIs (matching
			// the pathToUri(absPath) used in diagnostics() lookup).
			const hostPath = this.fromUri(rawUri);
			const uri = pathToUri(hostPath);
			const list: Diagnostic[] = (p.diagnostics as any[]).map(d => ({
				path: hostPath,
				range: d.range as Range,
				severity: lspSeverity(d.severity),
				message: String(d.message ?? ""),
				source: d.source,
				code: d.code,
			}));
			this.diagnosticsByUri.set(uri, list);
			this.diagVersionByUri.set(uri, (this.diagVersionByUri.get(uri) ?? 0) + 1);
			const listeners = this.diagListeners.get(uri);
			if (listeners) for (const fn of listeners) fn();
		});

		// initialize
		const rootUri = this.toUri(this.worktreePath);
		await this.proc.connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: "workspace" }],
			capabilities: {
				textDocument: {
					synchronization: { dynamicRegistration: false, didSave: false },
					definition: {},
					references: {},
					hover: { contentFormat: ["markdown", "plaintext"] },
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					rename: { prepareSupport: false },
					publishDiagnostics: {},
				},
				workspace: {
					symbol: {},
					workspaceFolders: true,
				},
			},
			initializationOptions: {},
		});
		this.proc.connection.sendNotification("initialized", {});
		this.state = "warm";
	}

	private async readText(absPath: string): Promise<string> {
		try { return await fs.readFile(absPath, "utf-8"); }
		catch { return ""; }
	}

	async ensureDocOpen(absPath: string): Promise<void> {
		if (this.openDocs.has(absPath)) {
			// refresh on disk → didChange (full sync)
			const text = await this.readText(absPath);
			const state = this.openDocs.get(absPath)!;
			state.version++;
			this.proc.connection.sendNotification("textDocument/didChange", {
				textDocument: { uri: this.toUri(absPath), version: state.version },
				contentChanges: [{ text }],
			});
			return;
		}
		const text = await this.readText(absPath);
		this.openDocs.set(absPath, { version: 1 });
		this.proc.connection.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri: this.toUri(absPath),
				languageId: absPath.endsWith(".tsx") || absPath.endsWith(".jsx") ? "typescriptreact" : "typescript",
				version: 1,
				text,
			},
		});
	}

	async definition(absPath: string, line: number, character: number): Promise<Location | null> {
		await this.ensureDocOpen(absPath);
		const res: any = await this.proc.connection.sendRequest("textDocument/definition", {
			textDocument: { uri: this.toUri(absPath) },
			position: { line, character },
		});
		const first = Array.isArray(res) ? res[0] : res;
		if (!first) return null;
		const uri = first.uri ?? first.targetUri;
		const range = first.range ?? first.targetSelectionRange ?? first.targetRange;
		if (!uri || !range) return null;
		return { path: this.fromUri(uri), range };
	}

	async references(absPath: string, line: number, character: number, includeDecl: boolean): Promise<Location[]> {
		await this.ensureDocOpen(absPath);
		const res: any[] = await this.proc.connection.sendRequest("textDocument/references", {
			textDocument: { uri: this.toUri(absPath) },
			position: { line, character },
			context: { includeDeclaration: includeDecl },
		}) ?? [];
		return res.map(r => ({ path: this.fromUri(r.uri), range: r.range }));
	}

	async hover(absPath: string, line: number, character: number): Promise<HoverResult | null> {
		await this.ensureDocOpen(absPath);
		const res: any = await this.proc.connection.sendRequest("textDocument/hover", {
			textDocument: { uri: this.toUri(absPath) },
			position: { line, character },
		});
		if (!res?.contents) return null;
		let text = "";
		const c = res.contents;
		if (typeof c === "string") text = c;
		else if (Array.isArray(c)) text = c.map((x: any) => typeof x === "string" ? x : x.value).join("\n");
		else if (c.value) text = String(c.value);
		return { contents: text, range: res.range };
	}

	async diagnostics(absPath?: string): Promise<Diagnostic[]> {
		if (absPath) {
			const uri = pathToUri(absPath);
			const before = this.diagVersionByUri.get(uri) ?? 0;
			await this.ensureDocOpen(absPath);
			await this.waitForDiagnostics(uri, before, 1500, 200);
			return this.diagnosticsByUri.get(uri) ?? [];
		}
		// workspace-wide aggregate
		const out: Diagnostic[] = [];
		for (const list of this.diagnosticsByUri.values()) out.push(...list);
		return out;
	}

	/**
	 * Wait for at least one publishDiagnostics newer than `beforeVersion`, then
	 * for an additional `settleMs` of quiet (no further publishes). Bails out
	 * after `maxWait` ms regardless.
	 */
	private waitForDiagnostics(uri: string, beforeVersion: number, maxWait: number, settleMs: number): Promise<void> {
		return new Promise<void>(resolve => {
			let settled = false;
			let lastReceiveAt = 0;
			let listeners = this.diagListeners.get(uri);
			if (!listeners) { listeners = new Set(); this.diagListeners.set(uri, listeners); }
			const listener = () => { lastReceiveAt = Date.now(); };
			listeners.add(listener);

			const finish = () => {
				if (settled) return;
				settled = true;
				listeners!.delete(listener);
				clearInterval(poll);
				clearTimeout(hardTimeout);
				resolve();
			};
			const poll = setInterval(() => {
				if (settled) return;
				const cur = this.diagVersionByUri.get(uri) ?? 0;
				if (cur > beforeVersion && lastReceiveAt && Date.now() - lastReceiveAt >= settleMs) finish();
			}, 30);
			(poll as any).unref?.();
			const hardTimeout = setTimeout(finish, maxWait);
			(hardTimeout as any).unref?.();
		});
	}

	async documentSymbols(absPath: string): Promise<DocumentSymbol[]> {
		await this.ensureDocOpen(absPath);
		const res: any[] = await this.proc.connection.sendRequest("textDocument/documentSymbol", {
			textDocument: { uri: this.toUri(absPath) },
		}) ?? [];
		// Could be DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat). Pass through.
		return res as DocumentSymbol[];
	}

	async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
		const res: any[] = await this.proc.connection.sendRequest("workspace/symbol", { query }) ?? [];
		return res.slice(0, 100).map(s => ({
			name: s.name,
			kind: s.kind,
			path: this.fromUri(s.location?.uri ?? s.location),
			range: s.location?.range ?? s.range,
			containerName: s.containerName,
		}));
	}

	async rename(absPath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit> {
		await this.ensureDocOpen(absPath);
		const res: any = await this.proc.connection.sendRequest("textDocument/rename", {
			textDocument: { uri: this.toUri(absPath) },
			position: { line, character },
			newName,
		});
		const out: WorkspaceEdit = { changes: {} };
		const changes = res?.changes;
		if (changes) {
			for (const [uri, edits] of Object.entries(changes)) {
				out.changes[this.fromUri(uri)] = edits as any;
			}
		}
		// documentChanges variant
		const docChanges = res?.documentChanges as any[] | undefined;
		if (docChanges) {
			for (const dc of docChanges) {
				if (dc.textDocument && Array.isArray(dc.edits)) {
					const p = this.fromUri(dc.textDocument.uri);
					out.changes[p] = (out.changes[p] ?? []).concat(dc.edits);
				}
			}
		}
		return out;
	}

	async shutdown(graceful: boolean): Promise<void> {
		this.shutdownRequested = true;
		this.state = "stopping";
		try {
			if (this.proc) await this.proc.stop(graceful);
		} finally {
			this.state = "stopped";
		}
	}
}

export class TypescriptLspFactory implements LspClientFactory {
	readonly language: Language = "typescript";
	isInstalled(): boolean {
		return resolveTypescriptLanguageServer() !== null;
	}
	async spawn(opts: SpawnOpts): Promise<LspClient> {
		const client = new TypescriptLspClient(opts.worktreePath);
		await client.start(opts.sandbox, opts.onClose, opts.requireSandbox);
		return client;
	}
}
