/**
 * Unit tests for the `preview_open` tool extension — specifically that a
 * successful execute() returns a two-block tool_result with a snapshot block
 * containing the resolved HTML prefixed with the versioned marker.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../defaults/tools/html/extension.ts";
import { PREVIEW_SNAPSHOT_MARKER } from "../defaults/tools/html/snapshot.ts";

type ToolReg = {
	name: string;
	execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

const registered: ToolReg[] = [];
const pi = { registerTool: (t: ToolReg) => { registered.push(t); } } as any;

let origFetch: typeof fetch;
const fetchCalls: Array<{ url: string; init: any }> = [];

before(() => {
	process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:1/";
	process.env.BOBBIT_TOKEN = "test-token";
	process.env.BOBBIT_SESSION_ID = "11111111-1111-1111-1111-111111111111";
	origFetch = globalThis.fetch;
	// Default: every fetch call is a 200 OK
	globalThis.fetch = (async (url: any, init: any) => {
		fetchCalls.push({ url: String(url), init });
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	}) as any;
	extensionFactory(pi);
});

after(() => {
	globalThis.fetch = origFetch;
	delete process.env.BOBBIT_SESSION_ID;
});

beforeEach(() => {
	fetchCalls.length = 0;
});

function getTool(): ToolReg {
	const t = registered.find(r => r.name === "preview_open");
	if (!t) throw new Error("preview_open tool not registered");
	return t;
}

describe("preview_open extension", () => {
	it("execute({html}) returns 2 blocks: status + snapshot (marker + html verbatim)", async () => {
		const tool = getTool();
		const rawHtml = "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>";
		const res = await tool.execute("call-1", { html: rawHtml });
		assert.strictEqual(res.content.length, 2);
		assert.strictEqual(res.content[0].type, "text");
		assert.match(res.content[0].text, /Preview panel is open/);
		assert.strictEqual(res.content[1].type, "text");
		assert.strictEqual(res.content[1].text, PREVIEW_SNAPSHOT_MARKER + rawHtml);
	});

	it("execute({file}) stores file contents (not the path) in the snapshot", async () => {
		const tool = getTool();
		const dir = mkdtempSync(join(tmpdir(), "bobbit-preview-ext-"));
		const filePath = join(dir, "snap.html");
		const fileContents = "<!DOCTYPE html><body>from-disk</body>";
		writeFileSync(filePath, fileContents, "utf-8");
		try {
			const res = await tool.execute("call-2", { file: filePath });
			assert.strictEqual(res.content.length, 2);
			assert.strictEqual(res.content[1].text, PREVIEW_SNAPSHOT_MARKER + fileContents);
			// Snapshot must NOT contain the file path literal
			assert.ok(!res.content[1].text.includes(filePath));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("error (bad file path) returns a single status block, no snapshot", async () => {
		const tool = getTool();
		const res = await tool.execute("call-3", { file: "/nonexistent/path/does-not-exist.html" });
		assert.strictEqual(res.content.length, 1);
		assert.strictEqual(res.content[0].type, "text");
		assert.match(res.content[0].text, /Error reading file/);
	});

	it("error (no html/file provided) returns a single block, no snapshot", async () => {
		const tool = getTool();
		const res = await tool.execute("call-4", {});
		assert.strictEqual(res.content.length, 1);
		assert.match(res.content[0].text, /At least one of 'html' or 'file'/);
	});

	it("error path from HTTP PATCH failure returns a single block", async () => {
		const tool = getTool();
		const prevFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
		try {
			const res = await tool.execute("call-5", { html: "<p>x</p>" });
			assert.strictEqual(res.content.length, 1);
			assert.match(res.content[0].text, /Error enabling preview mode|Error writing preview HTML|Error opening preview/);
		} finally {
			globalThis.fetch = prevFetch;
		}
	});

	it("on success, PATCH then POST /api/preview are called", async () => {
		const tool = getTool();
		await tool.execute("call-6", { html: "<p>ok</p>" });
		// At least 2 gateway calls: PATCH session, POST preview
		const patches = fetchCalls.filter(c => c.init?.method === "PATCH");
		const posts = fetchCalls.filter(c => c.init?.method === "POST");
		assert.ok(patches.length >= 1, "expected at least one PATCH");
		assert.ok(posts.length >= 1, "expected at least one POST");
		assert.ok(posts.some(c => c.url.includes("/api/preview")), "POST should target /api/preview");
	});
});
