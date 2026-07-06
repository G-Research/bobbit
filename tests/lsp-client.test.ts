/**
 * Unit tests for the pure extracted pieces of `src/server/lsp/client.ts`
 * (docs/design/lsp-product-tools.md §4(b)): the JSON-RPC-over-stdio framing
 * in `LspClient`, and the formatting/flattening/polling helpers shared by
 * `scripts/lsp-cli.mjs` and `src/server/lsp/supervisor.ts`.
 *
 * `LspClient` is exercised against a minimal fake child-process object (an
 * EventEmitter standing in for `.stdout`/`.stdin`/process events) rather
 * than a real spawned tsserver — no network/process dependency, matching the
 * repo convention of pure-function/fixture unit tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
	LspClient,
	LspTimeoutError,
	buildInitializeParams,
	flattenSymbols,
	formatLocation,
	formatLocationWithWorkspace,
	formatWorkspaceSymbol,
	isEmptyResult,
	languageIdFor,
	pollQuery,
	symbolKindName,
	uriToPath,
} from "../src/server/lsp/client.ts";

// ── Fake child process ──────────────────────────────────────────────────────

function makeFakeProc() {
	const stdout = new EventEmitter();
	const written: string[] = [];
	const proc: any = new EventEmitter();
	proc.stdout = stdout;
	proc.stdin = { write: (data: string) => { written.push(data); return true; } };
	return { proc, stdout, written };
}

function frame(obj: unknown): string {
	const json = JSON.stringify(obj);
	return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

describe("LspClient — JSON-RPC-over-stdio framing", () => {
	it("request() resolves on a matching-id response", async () => {
		const { proc, stdout, written } = makeFakeProc();
		const client = new LspClient(proc);
		const promise = client.request("foo/bar", { x: 1 });
		// The written frame should be a well-formed JSON-RPC request with id 1.
		assert.equal(written.length, 1);
		assert.match(written[0], /^Content-Length: \d+\r\n\r\n/);
		const sentBody = JSON.parse(written[0].split("\r\n\r\n")[1]);
		assert.equal(sentBody.method, "foo/bar");
		assert.equal(sentBody.id, 1);

		stdout.emit("data", Buffer.from(frame({ jsonrpc: "2.0", id: 1, result: { ok: true } })));
		assert.deepEqual(await promise, { ok: true });
	});

	it("request() rejects on a JSON-RPC error response", async () => {
		const { proc, stdout } = makeFakeProc();
		const client = new LspClient(proc);
		const promise = client.request("foo/bar", {});
		stdout.emit("data", Buffer.from(frame({ jsonrpc: "2.0", id: 1, error: { message: "boom" } })));
		await assert.rejects(promise, /boom/);
	});

	it("handles a frame split across multiple data events", async () => {
		const { proc, stdout } = makeFakeProc();
		const client = new LspClient(proc);
		const promise = client.request("foo/bar", {});
		const full = frame({ jsonrpc: "2.0", id: 1, result: 42 });
		stdout.emit("data", Buffer.from(full.slice(0, 20)));
		stdout.emit("data", Buffer.from(full.slice(20)));
		assert.equal(await promise, 42);
	});

	it("handles two frames delivered in a single data event", async () => {
		const { proc, stdout } = makeFakeProc();
		const client = new LspClient(proc);
		const p1 = client.request("a", {});
		const p2 = client.request("b", {});
		const combined = frame({ jsonrpc: "2.0", id: 1, result: "one" }) + frame({ jsonrpc: "2.0", id: 2, result: "two" });
		stdout.emit("data", Buffer.from(combined));
		assert.equal(await p1, "one");
		assert.equal(await p2, "two");
	});

	it("notify() sends a frame with no id", () => {
		const { proc, written } = makeFakeProc();
		const client = new LspClient(proc);
		client.notify("initialized", {});
		const sentBody = JSON.parse(written[0].split("\r\n\r\n")[1]);
		assert.equal(sentBody.id, undefined);
		assert.equal(sentBody.method, "initialized");
	});

	it("routes id-less messages to onNotification", () => {
		const { proc, stdout } = makeFakeProc();
		const client = new LspClient(proc);
		const seen: Array<{ method: string; params: unknown }> = [];
		client.onNotification = (method, params) => seen.push({ method, params });
		stdout.emit("data", Buffer.from(frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///x" } })));
		assert.equal(seen.length, 1);
		assert.equal(seen[0].method, "textDocument/publishDiagnostics");
	});

	it("proc 'error' event rejects every pending request (never hangs)", async () => {
		const { proc } = makeFakeProc();
		const client = new LspClient(proc);
		const promise = client.request("foo/bar", {});
		proc.emit("error", new Error("spawn ENOENT"));
		await assert.rejects(promise, /ENOENT/);
	});
});

describe("languageIdFor", () => {
	it("maps common TS/JS extensions", () => {
		assert.equal(languageIdFor("a/b.ts"), "typescript");
		assert.equal(languageIdFor("a/b.tsx"), "typescriptreact");
		assert.equal(languageIdFor("a/b.js"), "javascript");
		assert.equal(languageIdFor("a/b.mjs"), "javascript");
		assert.equal(languageIdFor("a/b.cjs"), "javascript");
		assert.equal(languageIdFor("a/b.jsx"), "javascriptreact");
	});
	it("defaults unknown extensions to typescript", () => {
		assert.equal(languageIdFor("a/b.weird"), "typescript");
	});
});

describe("isEmptyResult", () => {
	it("null/undefined are empty for any method", () => {
		assert.equal(isEmptyResult("textDocument/definition", null), true);
		assert.equal(isEmptyResult("textDocument/definition", undefined), true);
	});
	it("empty array is empty; non-empty array is not", () => {
		assert.equal(isEmptyResult("textDocument/references", []), true);
		assert.equal(isEmptyResult("textDocument/references", [{ uri: "file:///x" }]), false);
	});
	it("a single non-array object (e.g. definition Location) is not empty", () => {
		assert.equal(isEmptyResult("textDocument/definition", { uri: "file:///x" }), false);
	});
	it("hover with no contents value is empty", () => {
		assert.equal(isEmptyResult("textDocument/hover", { contents: "" }), true);
		assert.equal(isEmptyResult("textDocument/hover", { contents: { value: "   " } }), true);
		assert.equal(isEmptyResult("textDocument/hover", { contents: { value: "some type" } }), false);
	});
});

describe("symbolKindName", () => {
	it("maps known LSP SymbolKind numbers", () => {
		assert.equal(symbolKindName(5), "Class");
		assert.equal(symbolKindName(12), "Function");
	});
	it("falls back to Unknown(n) for out-of-range kinds", () => {
		assert.equal(symbolKindName(999), "Unknown(999)");
	});
});

describe("flattenSymbols", () => {
	it("flattens a nested DocumentSymbol tree with 1-based lines", () => {
		const tree = [
			{
				name: "Outer",
				kind: 5,
				range: { start: { line: 9 } },
				children: [{ name: "inner", kind: 6, range: { start: { line: 10 } }, children: [] }],
			},
		];
		const flat = flattenSymbols(tree);
		assert.deepEqual(flat, [
			{ name: "Outer", kind: "Class", line: 10 },
			{ name: "inner", kind: "Method", line: 11 },
		]);
	});
	it("handles a flat SymbolInformation[] list (location.range instead of range)", () => {
		const flat = flattenSymbols([{ name: "sym", kind: 12, location: { range: { start: { line: 0 } } } }]);
		assert.deepEqual(flat, [{ name: "sym", kind: "Function", line: 1 }]);
	});
	it("returns [] for null/undefined input", () => {
		assert.deepEqual(flattenSymbols(null), []);
		assert.deepEqual(flattenSymbols(undefined), []);
	});
});

describe("uriToPath", () => {
	it("converts a file:// URI to a filesystem path", () => {
		assert.equal(uriToPath("file:///repo/src/x.ts"), "/repo/src/x.ts");
	});
	it("returns the input unchanged when it isn't a valid URL", () => {
		assert.equal(uriToPath("not a uri"), "not a uri");
	});
});

describe("formatLocation / formatLocationWithWorkspace", () => {
	it("formatLocation converts 0-based LSP range to 1-based line/col", () => {
		const loc = formatLocation({ uri: "file:///repo/src/x.ts", range: { start: { line: 4, character: 2 } } });
		assert.deepEqual(loc, { file: "/repo/src/x.ts", line: 5, col: 3 });
	});
	it("formatLocation supports targetUri/targetRange (definition-link shape)", () => {
		const loc = formatLocation({ targetUri: "file:///repo/src/y.ts", targetRange: { start: { line: 0, character: 0 } } });
		assert.deepEqual(loc, { file: "/repo/src/y.ts", line: 1, col: 1 });
	});
	it("formatLocationWithWorkspace adds a repo-relative path inside the workspace", () => {
		const loc = formatLocationWithWorkspace(
			{ uri: "file:///repo/src/x.ts", range: { start: { line: 0, character: 0 } } },
			"/repo",
		);
		assert.equal(loc.relativeFile, "src/x.ts");
	});
	it("formatLocationWithWorkspace falls back to the absolute path outside the workspace", () => {
		const loc = formatLocationWithWorkspace(
			{ uri: "file:///elsewhere/x.ts", range: { start: { line: 0, character: 0 } } },
			"/repo",
		);
		assert.equal(loc.relativeFile, "/elsewhere/x.ts");
	});
});

describe("formatWorkspaceSymbol", () => {
	it("combines name/kind with a workspace-relative location", () => {
		const sym = formatWorkspaceSymbol(
			{ name: "Foo", kind: 5, location: { uri: "file:///repo/src/x.ts", range: { start: { line: 0, character: 0 } } } },
			"/repo",
		);
		assert.deepEqual(sym, { name: "Foo", kind: "Class", file: "/repo/src/x.ts", line: 1, col: 1, relativeFile: "src/x.ts" });
	});
});

describe("buildInitializeParams", () => {
	it("includes the critical useSyntaxServer:never option", () => {
		const params: any = buildInitializeParams({ processId: 123, rootUri: "file:///repo", rootPath: "/repo" });
		assert.equal(params.initializationOptions.tsserver.useSyntaxServer, "never");
		assert.equal(params.processId, 123);
		assert.equal(params.rootUri, "file:///repo");
		assert.equal(params.rootPath, "/repo");
	});
});

describe("pollQuery", () => {
	it("returns the first non-empty result without waiting out the timeout", async () => {
		let calls = 0;
		const fakeClient: any = {
			request: async () => {
				calls++;
				return calls < 3 ? [] : [{ uri: "file:///x" }];
			},
		};
		const result = await pollQuery(fakeClient, "textDocument/references", {}, 5000, 1);
		assert.equal(calls, 3);
		assert.deepEqual(result, [{ uri: "file:///x" }]);
	});

	it("throws LspTimeoutError when the result never becomes non-empty", async () => {
		const fakeClient: any = { request: async () => [] };
		await assert.rejects(pollQuery(fakeClient, "textDocument/references", {}, 20, 5), LspTimeoutError);
	});
});
