#!/usr/bin/env node
// scripts/lsp-cli.mjs
//
// A minimal LSP client for `typescript-language-server --stdio`, so Bash-only
// sessions (subagents have no interactive LSP tool) can run one-shot TS LSP
// queries. Zero new deps — plain Node child_process + JSON-RPC framing.
//
// Usage:
//   node scripts/lsp-cli.mjs symbols <file>
//   node scripts/lsp-cli.mjs workspace <file> <query>
//   node scripts/lsp-cli.mjs refs <file> <line> <col>
//   node scripts/lsp-cli.mjs def <file> <line> <col>
//   node scripts/lsp-cli.mjs hover <file> <line> <col>
//
// <line>/<col> are 1-based (editor convention) and converted to LSP's
// 0-based positions internally. The workspace root is resolved as the git
// toplevel of the target file (worktree-safe: a file in a worktree gets that
// worktree's own tsconfig, not the primary checkout's).
//
// The server needs time to load the TS project before semantic queries
// (references/definition) return full, cross-file results — under load this
// can take ~30s. This CLI polls the same query until it gets a non-empty
// result or --timeout (default 60000ms) elapses, then exits non-zero with a
// clear message.
//
// Prints compact JSON to stdout on success.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const USAGE = `lsp-cli.mjs — one-shot TypeScript LSP queries over stdio

Usage:
  node scripts/lsp-cli.mjs symbols <file>
  node scripts/lsp-cli.mjs workspace <file> <query>
  node scripts/lsp-cli.mjs refs <file> <line> <col>
  node scripts/lsp-cli.mjs def <file> <line> <col>
  node scripts/lsp-cli.mjs hover <file> <line> <col>

Options:
  --timeout <ms>   Max time to wait for a non-empty result (default 60000)
  -h, --help       Show this help

<line>/<col> are 1-based. Workspace root = git toplevel of <file>.
`;

function fail(msg) {
	process.stderr.write(`lsp-cli: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const args = [];
	let timeoutMs = 60000;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") {
			process.stdout.write(USAGE);
			process.exit(0);
		} else if (a === "--timeout") {
			timeoutMs = Number(argv[++i]);
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout must be a positive number");
		} else {
			args.push(a);
		}
	}
	return { args, timeoutMs };
}

function languageIdFor(filePath) {
	const ext = path.extname(filePath);
	if (ext === ".tsx") return "typescriptreact";
	if (ext === ".jsx") return "javascriptreact";
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
	return "typescript";
}

function gitToplevel(filePath) {
	const dir = path.dirname(path.resolve(filePath));
	try {
		return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	} catch {
		fail(`could not resolve git toplevel for ${filePath} (not in a git repo?)`);
	}
}

/** Minimal JSON-RPC-over-stdio client for an LSP server. */
class LspClient {
	constructor(proc) {
		this.proc = proc;
		this.buf = Buffer.alloc(0);
		this.nextId = 1;
		this.pending = new Map();
		this.notifications = [];
		proc.stdout.on("data", (chunk) => this._onData(chunk));
		proc.on("error", (err) => this._rejectAll(err));
	}

	_onData(chunk) {
		this.buf = Buffer.concat([this.buf, chunk]);
		for (;;) {
			const headerEnd = this.buf.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buf.subarray(0, headerEnd).toString("utf8");
			const match = /Content-Length: (\d+)/i.exec(header);
			if (!match) {
				fail("malformed LSP frame from server (no Content-Length)");
			}
			const len = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (this.buf.length < bodyStart + len) return; // wait for more data
			const body = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
			this.buf = this.buf.subarray(bodyStart + len);
			this._onMessage(JSON.parse(body));
		}
	}

	_onMessage(msg) {
		if (msg.id !== undefined && this.pending.has(msg.id)) {
			const { resolve, reject } = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
			else resolve(msg.result);
		}
		// Notifications (diagnostics, logs, etc.) are ignored — this CLI runs one
		// query and exits; it does not surface server-side diagnostics.
	}

	_rejectAll(err) {
		for (const { reject } of this.pending.values()) reject(err);
		this.pending.clear();
	}

	_write(obj) {
		const json = JSON.stringify(obj);
		const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
		this.proc.stdin.write(header + json);
	}

	request(method, params) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this._write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method, params) {
		this._write({ jsonrpc: "2.0", method, params });
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEmptyResult(method, result) {
	if (result === null || result === undefined) return true;
	if (method === "textDocument/hover") {
		const value = result.contents?.value ?? result.contents;
		return !value || (typeof value === "string" && value.trim() === "");
	}
	if (Array.isArray(result)) return result.length === 0;
	return false; // a single Location object from textDocument/definition, etc.
}

/** Poll `method` with `params` until non-empty or `timeoutMs` elapses. */
async function pollQuery(client, method, params, timeoutMs) {
	const start = Date.now();
	let last;
	for (;;) {
		last = await client.request(method, params);
		if (!isEmptyResult(method, last)) return last;
		if (Date.now() - start >= timeoutMs) {
			fail(
				`timed out after ${timeoutMs}ms waiting for a non-empty ${method} result ` +
					`(the TS project may still be loading, or the query point is invalid)`,
			);
		}
		await sleep(1000);
	}
}

const SYMBOL_KIND_NAMES = [
	"", "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
	"Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
	"Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct",
	"Event", "Operator", "TypeParameter",
];

function symbolKindName(kind) {
	return SYMBOL_KIND_NAMES[kind] || `Unknown(${kind})`;
}

/** Flatten a DocumentSymbol tree (or a flat SymbolInformation[] list) to {name, kind, line}. */
function flattenSymbols(result) {
	const out = [];
	const visit = (sym) => {
		const line = (sym.range ?? sym.location?.range)?.start.line;
		out.push({ name: sym.name, kind: symbolKindName(sym.kind), line: line + 1 });
		for (const child of sym.children ?? []) visit(child);
	};
	for (const sym of result ?? []) visit(sym);
	return out;
}

function uriToPath(uri) {
	try {
		return new URL(uri).pathname;
	} catch {
		return uri;
	}
}

function formatLocation(loc) {
	const uri = loc.uri ?? loc.targetUri;
	const range = loc.range ?? loc.targetRange;
	return { file: uriToPath(uri), line: range.start.line + 1, col: range.start.character + 1 };
}

function formatLocationWithWorkspace(loc, workspaceRoot) {
	const formatted = formatLocation(loc);
	const rel = path.relative(workspaceRoot, formatted.file);
	return {
		...formatted,
		relativeFile: rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : formatted.file,
	};
}

function formatWorkspaceSymbol(sym, workspaceRoot) {
	const loc = formatLocationWithWorkspace(sym.location, workspaceRoot);
	return {
		name: sym.name,
		kind: symbolKindName(sym.kind),
		...loc,
	};
}

async function main() {
	const { args, timeoutMs } = parseArgs(process.argv.slice(2));
	const [cmd, fileArg, lineArg, colArg] = args;

	if (!cmd) {
		process.stderr.write(USAGE);
		process.exit(1);
	}
	if (!["symbols", "workspace", "refs", "def", "hover"].includes(cmd)) {
		fail(`unknown subcommand "${cmd}". Run with --help for usage.`);
	}
	if (!fileArg) fail(`missing <file> argument for "${cmd}"`);
	const filePath = path.resolve(process.cwd(), fileArg);
	if (!existsSync(filePath)) fail(`file not found: ${filePath}`);

	let line, col;
	if (cmd === "workspace") {
		if (!lineArg) fail('"workspace" requires <query>');
	} else if (cmd !== "symbols") {
		if (lineArg === undefined || colArg === undefined) fail(`"${cmd}" requires <line> and <col>`);
		line = Number(lineArg);
		col = Number(colArg);
		if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) {
			fail("<line> and <col> must be 1-based positive integers");
		}
	}

	const workspaceRoot = gitToplevel(filePath);
	const fileUri = pathToFileURL(filePath).toString();
	const rootUri = pathToFileURL(workspaceRoot).toString();

	const proc = spawn("typescript-language-server", ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
	const client = new LspClient(proc);

	const shutdown = async (code) => {
		try {
			await Promise.race([client.request("shutdown", null), sleep(2000)]);
			client.notify("exit", null);
		} catch {
			// best-effort — fall through to kill
		}
		proc.kill();
		process.exit(code);
	};

	proc.on("error", (err) => fail(`failed to spawn typescript-language-server: ${err.message}`));

	try {
		await client.request("initialize", {
			processId: process.pid,
			rootUri,
			rootPath: workspaceRoot,
			capabilities: {
				textDocument: {
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					hover: { contentFormat: ["markdown", "plaintext"] },
				},
			},
			// Critical: without this, a partialSemantic sidecar answers requests
			// with single-file results while the full project is still loading.
			initializationOptions: { tsserver: { useSyntaxServer: "never" } },
		});
		client.notify("initialized", {});

		const text = readFileSync(filePath, "utf8");
		client.notify("textDocument/didOpen", {
			textDocument: { uri: fileUri, languageId: languageIdFor(filePath), version: 1, text },
		});

		let output;
		if (cmd === "symbols") {
			const result = await pollQuery(client, "textDocument/documentSymbol", { textDocument: { uri: fileUri } }, timeoutMs);
			output = flattenSymbols(result);
		} else if (cmd === "workspace") {
			// Warm the file/project first. workspace/symbol depends on tsserver's
			// project-wide nav index; under load it can initially answer [] even
			// after the LSP server accepts requests, while documentSymbol succeeds.
			await pollQuery(client, "textDocument/documentSymbol", { textDocument: { uri: fileUri } }, Math.min(timeoutMs, 30000));
			const result = await pollQuery(client, "workspace/symbol", { query: lineArg }, timeoutMs);
			output = result
				.filter((sym) => sym?.location?.uri)
				.map((sym) => formatWorkspaceSymbol(sym, workspaceRoot));
		} else {
			const position = { line: line - 1, character: col - 1 };
			if (cmd === "refs") {
				const result = await pollQuery(
					client,
					"textDocument/references",
					{ textDocument: { uri: fileUri }, position, context: { includeDeclaration: true } },
					timeoutMs,
				);
				output = result.map(formatLocation);
			} else if (cmd === "def") {
				const result = await pollQuery(client, "textDocument/definition", { textDocument: { uri: fileUri }, position }, timeoutMs);
				output = (Array.isArray(result) ? result : [result]).map(formatLocation);
			} else if (cmd === "hover") {
				const result = await pollQuery(client, "textDocument/hover", { textDocument: { uri: fileUri }, position }, timeoutMs);
				output = { contents: result.contents?.value ?? result.contents, range: result.range ? formatLocation({ uri: fileUri, range: result.range }) : undefined };
			}
		}

		process.stdout.write(JSON.stringify(output) + "\n");
		await shutdown(0);
	} catch (err) {
		process.stderr.write(`lsp-cli: ${err.message}\n`);
		await shutdown(1);
	}
}

main();
