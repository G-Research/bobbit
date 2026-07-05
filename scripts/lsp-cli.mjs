#!/usr/bin/env node
// scripts/lsp-cli.mjs
//
// A minimal LSP client for `typescript-language-server --stdio`, so Bash-only
// sessions (subagents have no interactive LSP tool) can run one-shot TS LSP
// queries. The one-shot spawn/query/shutdown shape here is still what this
// CLI is actually used for (a rare, one-shot query from a Bash-only subagent
// session) — the productized, persistent-per-worktree version for chat-turn
// latency lives in `src/server/lsp/supervisor.ts` as the gateway-owned
// `TsServerSupervisor` (see `defaults/tools/code/`,
// docs/design/lsp-product-tools.md).
//
// The JSON-RPC framing (`LspClient`) and formatting helpers below are
// imported from `src/server/lsp/client.ts` (compiled to
// `dist/server/lsp/client.js`) rather than duplicated here, so this CLI and
// the gateway supervisor never drift (design doc §4(b)). That means this
// script needs `npm run build:server` to have run at least once — it fails
// with a clear message telling you to do that if `dist/` is missing.
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

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLIENT_MODULE = path.join(REPO_ROOT, "dist", "server", "lsp", "client.js");

/**
 * Load the shared LSP client module lazily — only once argument parsing has
 * confirmed a real LSP query is about to run. `--help`, usage errors, and
 * unknown-subcommand rejection must stay cheap and buildless (pinned by
 * tests/lsp-cli-usage.test.ts), so this is NOT a top-level await: importing
 * eagerly would make even `--help` require `npm run build:server` first.
 */
async function loadClientModule() {
	try {
		return await import(pathToFileURL(CLIENT_MODULE).href);
	} catch (err) {
		fail(
			`could not load ${CLIENT_MODULE} (${err.message}). ` +
				`Run "npm run build:server" first — lsp-cli.mjs shares its LSP client with the gateway's TsServerSupervisor.`,
		);
	}
}

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

function gitToplevel(filePath) {
	const dir = path.dirname(path.resolve(filePath));
	try {
		return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	} catch {
		fail(`could not resolve git toplevel for ${filePath} (not in a git repo?)`);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

	// Only loaded once we know a real query is about to run — see
	// loadClientModule()'s doc comment for why this isn't a top-level import.
	const { LspClient, buildInitializeParams, languageIdFor, pollQuery, flattenSymbols, formatLocation, formatLocationWithWorkspace, formatWorkspaceSymbol } =
		await loadClientModule();

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
		await client.request("initialize", buildInitializeParams({ processId: process.pid, rootUri, rootPath: workspaceRoot }));
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
