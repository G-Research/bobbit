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
import { PREVIEW_SNAPSHOT_MARKER, PREVIEW_SNAPSHOT_MARKER_V2, parseSnapshot } from "../defaults/tools/html/snapshot.ts";

type ToolReg = {
	name: string;
	execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

const registered: ToolReg[] = [];
const pi = { registerTool: (t: ToolReg) => { registered.push(t); } } as any;

let origFetch: typeof fetch;
let fetchResponder: ((url: string, init: any) => { status: number; body: any }) | null = null;
const fetchCalls: Array<{ url: string; init: any }> = [];

before(() => {
	process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:1/";
	process.env.BOBBIT_TOKEN = "test-token";
	process.env.BOBBIT_SESSION_ID = "11111111-1111-1111-1111-111111111111";
	origFetch = globalThis.fetch;
	// Default: every fetch call is a 200 OK
	globalThis.fetch = (async (url: any, init: any) => {
		fetchCalls.push({ url: String(url), init });
		if (fetchResponder) {
			const r = fetchResponder(String(url), init);
			return new Response(JSON.stringify(r.body), { status: r.status });
		}
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
	fetchResponder = null;
	delete process.env.BOBBIT_HOST_CWD;
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

	it("execute({file}) emits v2 marker carrying the path (not file contents) on success", async () => {
		const tool = getTool();
		const dir = mkdtempSync(join(tmpdir(), "bobbit-preview-ext-"));
		const filePath = join(dir, "snap.html");
		const fileContents = "<!DOCTYPE html><body>from-disk</body>";
		writeFileSync(filePath, fileContents, "utf-8");
		try {
			const res = await tool.execute("call-2", { file: filePath });
			assert.strictEqual(res.content.length, 2);
			assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER_V2));
			// The snapshot block must NOT carry file contents — only the path.
			assert.ok(!res.content[1].text.includes("from-disk"));
			const parsed = parseSnapshot(res.content[1].text);
			assert.ok(parsed && parsed.kind === "file");
			if (parsed && parsed.kind === "file") assert.strictEqual(parsed.path, filePath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("error (bad file path, server falls back to inline & read fails) returns a single status block, no snapshot", async () => {
		const tool = getTool();
		// Server rejects file mode → extension falls back to inline → fs.readFileSync fails.
		fetchResponder = (_url, init) => {
			if (init?.method === "POST") return { status: 400, body: { error: "baseDir not host-visible" } };
			return { status: 200, body: { ok: true } };
		};
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

	it("file: mode tries kind:file POST first and emits v2 marker on success", async () => {
		const tool = getTool();
		const dir = mkdtempSync(join(tmpdir(), "bobbit-preview-ext-v2-"));
		const filePath = join(dir, "report.html");
		writeFileSync(filePath, "<html><body>x</body></html>", "utf-8");
		try {
			fetchResponder = (_url, init) => {
				if (init?.method === "POST") return { status: 200, body: { ok: true, kind: "file" } };
				return { status: 200, body: { ok: true } };
			};
			const res = await tool.execute("call-v2-1", { file: filePath });
			assert.strictEqual(res.content.length, 2);
			assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER_V2));
			// The marker must NOT carry full bytes — only a JSON path payload.
			assert.ok(!res.content[1].text.includes("<body>x</body>"));
			const parsed = parseSnapshot(res.content[1].text);
			assert.ok(parsed && parsed.kind === "file");
			if (parsed && parsed.kind === "file") assert.strictEqual(parsed.path, filePath);
			// POST body must be {kind:"file", path:...}
			const posts = fetchCalls.filter(c => c.init?.method === "POST" && String(c.url).includes("/api/preview"));
			assert.ok(posts.length >= 1);
			const body = JSON.parse(posts[0].init.body);
			assert.strictEqual(body.kind, "file");
			assert.strictEqual(body.path, filePath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("v2 marker is < 1 KB regardless of (fake-)file size", async () => {
		const tool = getTool();
		const dir = mkdtempSync(join(tmpdir(), "bobbit-preview-ext-size-"));
		// 256-char filename is plenty long for the path-length invariant test.
		const longName = "a".repeat(200) + ".html";
		const filePath = join(dir, longName);
		writeFileSync(filePath, "<html></html>", "utf-8");
		try {
			fetchResponder = (_url, init) => {
				if (init?.method === "POST") return { status: 200, body: { ok: true, kind: "file" } };
				return { status: 200, body: { ok: true } };
			};
			const res = await tool.execute("call-v2-size", { file: filePath });
			assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER_V2));
			assert.ok(
				res.content[1].text.length < 1024,
				`v2 marker block must be < 1 KB, got ${res.content[1].text.length}`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("file: mode falls back to inline when server returns 400 (baseDir not host-visible)", async () => {
		const tool = getTool();
		const dir = mkdtempSync(join(tmpdir(), "bobbit-preview-ext-fb-"));
		const filePath = join(dir, "report.html");
		const rawHtml = "<html><body>fallback</body></html>";
		writeFileSync(filePath, rawHtml, "utf-8");
		try {
			let postCount = 0;
			fetchResponder = (_url, init) => {
				if (init?.method === "POST") {
					postCount++;
					if (postCount === 1) {
						return { status: 400, body: { error: "baseDir not host-visible" } };
					}
					return { status: 200, body: { ok: true } };
				}
				return { status: 200, body: { ok: true } };
			};
			const res = await tool.execute("call-v2-fb", { file: filePath });
			assert.strictEqual(res.content.length, 2);
			// Fallback should produce a v1 marker carrying the bytes.
			assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER));
			assert.strictEqual(res.content[1].text, PREVIEW_SNAPSHOT_MARKER + rawHtml);
			assert.match(res.content[0].text, /falling back to inline/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("file: mode falls back to inline when BOBBIT_HOST_CWD is set but path is outside cwd", async () => {
		const tool = getTool();
		const dir = mkdtempSync(join(tmpdir(), "bobbit-preview-ext-outside-"));
		const filePath = join(dir, "report.html");
		writeFileSync(filePath, "<html></html>", "utf-8");
		try {
			// Force the translation to bail (path is *not* under process.cwd).
			process.env.BOBBIT_HOST_CWD = "/host/workspace";
			// process.cwd() is the project root — the tmp dir is somewhere else.
			const res = await tool.execute("call-v2-outside", { file: filePath });
			assert.strictEqual(res.content.length, 2);
			assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER));
			assert.match(res.content[0].text, /falling back to inline|could not translate/);
			// No file-mode POST should have been attempted.
			const posts = fetchCalls.filter(c => c.init?.method === "POST" && String(c.url).includes("/api/preview"));
			for (const p of posts) {
				const body = JSON.parse(p.init.body || "{}");
				assert.notStrictEqual(body.kind, "file", "should not POST kind:file when path is outside cwd");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
