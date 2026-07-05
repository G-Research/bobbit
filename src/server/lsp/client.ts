// src/server/lsp/client.ts
//
// Shared JSON-RPC-over-stdio LSP client + formatting helpers, extracted from
// `scripts/lsp-cli.mjs` per docs/design/lsp-product-tools.md §4(b). This is
// the ONLY copy of `LspClient` and the pure formatting/flattening functions —
// both `scripts/lsp-cli.mjs` (one-shot CLI, Bash-only subagent fallback) and
// `src/server/lsp/supervisor.ts` (persistent, gateway-owned TsServerSupervisor)
// import from here so the two never drift.
//
// Nothing in this module is CLI-specific or supervisor-specific: `LspClient`
// (JSON-RPC framing, request/notify, pending-map, notification handling) has
// zero dependency on process lifetime, and the formatters/flattener are pure
// functions over LSP response shapes.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

// ── JSON-RPC-over-stdio client ──────────────────────────────────────────────

interface PendingEntry {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
}

/**
 * Minimal JSON-RPC-over-stdio client for an LSP server (originally
 * `lsp-cli.mjs`'s `LspClient`). Framing, request/notify, and notification
 * handling only — no knowledge of *which* language server it's talking to.
 */
export class LspClient {
	proc: ChildProcessWithoutNullStreams;
	private buf: Buffer;
	private nextId: number;
	private pending: Map<number, PendingEntry>;
	/** Called for every server->client notification (e.g. publishDiagnostics). Wave 1 does not use this (diagnostics deferred — design doc §5), but it's exposed so callers aren't forced to ignore notifications silently like the CLI does. */
	onNotification?: (method: string, params: any) => void;

	constructor(proc: ChildProcessWithoutNullStreams) {
		this.proc = proc;
		this.buf = Buffer.alloc(0);
		this.nextId = 1;
		this.pending = new Map();
		proc.stdout.on("data", (chunk: Buffer) => this._onData(chunk));
		proc.on("error", (err: Error) => this._rejectAll(err));
	}

	private _onData(chunk: Buffer): void {
		this.buf = Buffer.concat([this.buf, chunk]);
		for (;;) {
			const headerEnd = this.buf.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buf.subarray(0, headerEnd).toString("utf8");
			const match = /Content-Length: (\d+)/i.exec(header);
			if (!match) {
				// Malformed frame — drop the buffer rather than spin forever on it.
				// A real one-shot CLI treats this as fatal (`fail(...)`); the
				// persistent supervisor instead surfaces it via `_rejectAll` so a
				// tool call gets a clear error rather than hanging (design doc §6).
				this._rejectAll(new Error("malformed LSP frame from server (no Content-Length)"));
				this.buf = Buffer.alloc(0);
				return;
			}
			const len = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (this.buf.length < bodyStart + len) return; // wait for more data
			const body = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
			this.buf = this.buf.subarray(bodyStart + len);
			try {
				this._onMessage(JSON.parse(body));
			} catch (err) {
				this._rejectAll(err instanceof Error ? err : new Error(String(err)));
			}
		}
	}

	private _onMessage(msg: any): void {
		if (msg.id !== undefined && this.pending.has(msg.id)) {
			const { resolve, reject } = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
			else resolve(msg.result);
			return;
		}
		if (msg.method) this.onNotification?.(msg.method, msg.params);
	}

	/** Reject every pending request (used on process error/exit/malformed-frame — never leave a caller hanging). */
	_rejectAll(err: Error): void {
		for (const { reject } of this.pending.values()) reject(err);
		this.pending.clear();
	}

	private _write(obj: unknown): void {
		const json = JSON.stringify(obj);
		const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
		this.proc.stdin.write(header + json);
	}

	request(method: string, params: unknown): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this._write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this._write({ jsonrpc: "2.0", method, params });
	}
}

// ── Pure helpers (language-id mapping, polling, formatting) ────────────────

export function languageIdFor(filePath: string): string {
	const ext = path.extname(filePath);
	if (ext === ".tsx") return "typescriptreact";
	if (ext === ".jsx") return "javascriptreact";
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
	return "typescript";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * tsserver can accept a request and answer `[]`/`null` while the project is
 * still indexing, before genuinely returning nothing. `isEmptyResult` +
 * `pollQuery` are how `lsp-cli.mjs` avoids misreporting "no references"
 * during warmup — keep this semantics verbatim (design doc §4).
 */
export function isEmptyResult(method: string, result: any): boolean {
	if (result === null || result === undefined) return true;
	if (method === "textDocument/hover") {
		const value = result.contents?.value ?? result.contents;
		return !value || (typeof value === "string" && value.trim() === "");
	}
	if (Array.isArray(result)) return result.length === 0;
	return false; // a single Location object from textDocument/definition, etc.
}

export class LspTimeoutError extends Error {
	constructor(method: string, timeoutMs: number) {
		super(
			`timed out after ${timeoutMs}ms waiting for a non-empty ${method} result ` +
				`(the TS project may still be loading, or the query point is invalid)`,
		);
		this.name = "LspTimeoutError";
	}
}

/** Poll `method` with `params` until non-empty or `timeoutMs` elapses. Throws {@link LspTimeoutError} on timeout instead of process.exit (unlike the CLI's `fail()`), so callers (supervisor) can turn it into a typed tool result. */
export async function pollQuery(
	client: LspClient,
	method: string,
	params: unknown,
	timeoutMs: number,
	pollIntervalMs = 1000,
): Promise<any> {
	const start = Date.now();
	for (;;) {
		const last = await client.request(method, params);
		if (!isEmptyResult(method, last)) return last;
		if (Date.now() - start >= timeoutMs) throw new LspTimeoutError(method, timeoutMs);
		await sleep(pollIntervalMs);
	}
}

export const SYMBOL_KIND_NAMES = [
	"", "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
	"Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
	"Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct",
	"Event", "Operator", "TypeParameter",
];

export function symbolKindName(kind: number): string {
	return SYMBOL_KIND_NAMES[kind] || `Unknown(${kind})`;
}

export interface FlatSymbol {
	name: string;
	kind: string;
	line: number;
}

/** Flatten a DocumentSymbol tree (or a flat SymbolInformation[] list) to {name, kind, line}. */
export function flattenSymbols(result: any): FlatSymbol[] {
	const out: FlatSymbol[] = [];
	const visit = (sym: any) => {
		const line = (sym.range ?? sym.location?.range)?.start.line;
		out.push({ name: sym.name, kind: symbolKindName(sym.kind), line: line + 1 });
		for (const child of sym.children ?? []) visit(child);
	};
	for (const sym of result ?? []) visit(sym);
	return out;
}

export function uriToPath(uri: string): string {
	try {
		return new URL(uri).pathname;
	} catch {
		return uri;
	}
}

export interface FormattedLocation {
	file: string;
	line: number;
	col: number;
}

export function formatLocation(loc: any): FormattedLocation {
	const uri = loc.uri ?? loc.targetUri;
	const range = loc.range ?? loc.targetRange;
	return { file: uriToPath(uri), line: range.start.line + 1, col: range.start.character + 1 };
}

export interface FormattedLocationWithWorkspace extends FormattedLocation {
	relativeFile: string;
}

export function formatLocationWithWorkspace(loc: any, workspaceRoot: string): FormattedLocationWithWorkspace {
	const formatted = formatLocation(loc);
	const rel = path.relative(workspaceRoot, formatted.file);
	return {
		...formatted,
		relativeFile: rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : formatted.file,
	};
}

export interface FormattedWorkspaceSymbol extends FormattedLocationWithWorkspace {
	name: string;
	kind: string;
}

export function formatWorkspaceSymbol(sym: any, workspaceRoot: string): FormattedWorkspaceSymbol {
	const loc = formatLocationWithWorkspace(sym.location, workspaceRoot);
	return {
		name: sym.name,
		kind: symbolKindName(sym.kind),
		...loc,
	};
}

/**
 * Initialization params tsserver needs, shared by the CLI and the
 * supervisor. Critical: `useSyntaxServer: "never"` — without it, a
 * partialSemantic sidecar answers requests with single-file results while
 * the full project is still loading (design doc §4, a real bug `lsp-cli.mjs`
 * already paid to find). Keep verbatim.
 */
export function buildInitializeParams(opts: { processId: number; rootUri: string; rootPath: string }): Record<string, unknown> {
	return {
		processId: opts.processId,
		rootUri: opts.rootUri,
		rootPath: opts.rootPath,
		capabilities: {
			textDocument: {
				documentSymbol: { hierarchicalDocumentSymbolSupport: true },
				hover: { contentFormat: ["markdown", "plaintext"] },
			},
		},
		initializationOptions: { tsserver: { useSyntaxServer: "never" } },
	};
}
