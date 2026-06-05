/**
 * Unit tests for the `preview_open` tool extension — v3 mount-endpoint contract.
 *
 * The extension always POSTs to /api/preview/mount?sessionId=<sid> with one of
 * {html} or {file:absolutePath}, then stamps a v3 marker block into the result.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../defaults/tools/html/extension.ts";
import {
	PREVIEW_SNAPSHOT_MARKER_V3,
	parseSnapshot,
	buildPreviewSnapshotV3Block,
} from "../defaults/tools/html/snapshot.ts";

type ToolReg = {
	name: string;
	execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

const registered: ToolReg[] = [];
const pi = { registerTool: (t: ToolReg) => { registered.push(t); } } as any;

let origFetch: typeof fetch;
let fetchResponder: ((url: string, init: any) => { status: number; body: any }) | null = null;
const fetchCalls: Array<{ url: string; init: any }> = [];

const SID = "11111111-1111-1111-1111-111111111111";
const HASH = "a".repeat(64);
const ARTIFACT_ID = "pa_abc123xyz";

before(() => {
	process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:1/";
	process.env.BOBBIT_TOKEN = "test-token";
	process.env.BOBBIT_SESSION_ID = SID;
	origFetch = globalThis.fetch;
	// Default: every fetch call is a 200 OK with a v3-shaped mount response.
	globalThis.fetch = (async (url: any, init: any) => {
		fetchCalls.push({ url: String(url), init });
		if (fetchResponder) {
			const r = fetchResponder(String(url), init);
			return new Response(JSON.stringify(r.body), { status: r.status });
		}
		// Default mount response.
		if (String(url).includes("/api/preview/mount")) {
			return new Response(
				JSON.stringify({
					url: `/preview/${SID}/inline.html`,
					path: `/state/preview/${SID}/inline.html`,
					relPath: `${SID}/inline.html`,
					entry: "inline.html",
					mtime: 1714512345678,
					contentHash: HASH,
					artifactId: ARTIFACT_ID,
				}),
				{ status: 200 },
			);
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
});

function getTool(): ToolReg {
	const t = registered.find(r => r.name === "preview_open");
	if (!t) throw new Error("preview_open tool not registered");
	return t;
}

describe("preview_open extension (v3 mount contract)", () => {
	it("execute({html}) PATCHes the session, POSTs /api/preview/mount with {html}, and returns a v3 snapshot", async () => {
		const tool = getTool();
		const rawHtml = "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>";
		const res = await tool.execute("call-1", { html: rawHtml });

		assert.strictEqual(res.content.length, 2);
		assert.strictEqual(res.content[0].type, "text");
		assert.match(res.content[0].text, /Preview panel is open/);

		assert.strictEqual(res.content[1].type, "text");
		assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3));
		const parsed = parseSnapshot(res.content[1].text);
		assert.ok(parsed && parsed.kind === "preview");
		if (parsed && parsed.kind === "preview") {
			assert.strictEqual(parsed.contentHash, HASH);
			assert.strictEqual(parsed.artifactId, ARTIFACT_ID);
			assert.strictEqual(parsed.entry, "inline.html");
		}

		// Body bytes must NEVER appear in the snapshot.
		assert.ok(!res.content[1].text.includes("<h1>Hello</h1>"));

		// Verify the wire calls.
		const patches = fetchCalls.filter(c => c.init?.method === "PATCH");
		assert.ok(patches.length >= 1, "expected at least one PATCH /api/sessions/:id");

		const mountPosts = fetchCalls.filter(
			c => c.init?.method === "POST" && String(c.url).includes("/api/preview/mount"),
		);
		assert.strictEqual(mountPosts.length, 1, "expected exactly one POST /api/preview/mount");
		assert.match(String(mountPosts[0].url), /sessionId=/);
		const body = JSON.parse(mountPosts[0].init.body);
		assert.strictEqual(body.html, rawHtml);
		assert.strictEqual(body.file, undefined);
	});

	it("execute({file}) sends absolute path to /api/preview/mount and returns a v3 snapshot", async () => {
		const tool = getTool();
		const dir = mkdtempSync(join(tmpdir(), "bobbit-preview-ext-v3-"));
		const filePath = join(dir, "report.html");
		const fileContents = "<!DOCTYPE html><body>from-disk</body>";
		writeFileSync(filePath, fileContents, "utf-8");

		fetchResponder = (url, init) => {
			if (init?.method === "POST" && String(url).includes("/api/preview/mount")) {
				return {
					status: 200,
					body: {
						url: `/preview/${SID}/report.html`,
						path: filePath,
						relPath: `${SID}/report.html`,
						entry: "report.html",
						mtime: 1714512345678,
						contentHash: HASH,
						artifactId: ARTIFACT_ID,
					},
				};
			}
			return { status: 200, body: { ok: true } };
		};

		try {
			const res = await tool.execute("call-2", { file: filePath });

			assert.strictEqual(res.content.length, 2);
			assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3));

			// File contents are NEVER in the snapshot.
			assert.ok(!res.content[1].text.includes("from-disk"));

			const parsed = parseSnapshot(res.content[1].text);
			assert.ok(parsed && parsed.kind === "preview");
			if (parsed && parsed.kind === "preview") {
				assert.match(parsed.url, /^\/preview\//);
				// Artifact-backed v3 snapshots keep the entry explicit. The builder may
				// compact `path` to the entry filename to preserve the 250 B marker cap.
				assert.strictEqual(parsed.path, "report.html");
				assert.strictEqual(parsed.entry, "report.html");
				assert.strictEqual(parsed.artifactId, ARTIFACT_ID);
			}

			const mountPosts = fetchCalls.filter(
				c => c.init?.method === "POST" && String(c.url).includes("/api/preview/mount"),
			);
			assert.strictEqual(mountPosts.length, 1);
			const body = JSON.parse(mountPosts[0].init.body);
			assert.strictEqual(body.file, filePath);
			assert.strictEqual(body.html, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("execute({file}) with relative path resolves against process.cwd() before sending", async () => {
		const tool = getTool();
		// Pick a file that exists relative to cwd — package.json is fine.
		await tool.execute("call-rel", { file: "package.json" });
		const mountPosts = fetchCalls.filter(
			c => c.init?.method === "POST" && String(c.url).includes("/api/preview/mount"),
		);
		assert.strictEqual(mountPosts.length, 1);
		const body = JSON.parse(mountPosts[0].init.body);
		assert.ok(body.file && body.file.length > 0, "file should be set");
		assert.ok(
			body.file.endsWith("package.json") && (body.file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(body.file)),
			`expected absolute path, got ${body.file}`,
		);
	});

	it("error: no html/file → single block with no snapshot", async () => {
		const tool = getTool();
		const res = await tool.execute("call-3", {});
		assert.strictEqual(res.content.length, 1);
		assert.match(res.content[0].text, /At least one of 'html' or 'file'/);
	});

	it("error: PATCH session failure surfaces error", async () => {
		const tool = getTool();
		fetchResponder = (_url, init) => {
			if (init?.method === "PATCH") return { status: 500, body: "server error" };
			return { status: 200, body: { ok: true } };
		};
		const res = await tool.execute("call-4", { html: "<p>x</p>" });
		assert.strictEqual(res.content.length, 1);
		assert.match(res.content[0].text, /Error enabling preview mode/);
	});

	it("error: mount endpoint 404 (file not found) surfaces verbatim with no snapshot", async () => {
		const tool = getTool();
		fetchResponder = (url, init) => {
			if (init?.method === "POST" && String(url).includes("/api/preview/mount")) {
				return { status: 404, body: { error: "file not found" } };
			}
			return { status: 200, body: { ok: true } };
		};
		const res = await tool.execute("call-5", { file: "/nonexistent/path/does-not-exist.html" });
		assert.strictEqual(res.content.length, 1);
		assert.match(res.content[0].text, /Error opening preview/);
		assert.match(res.content[0].text, /404/);
	});

	it("`html` wins when both `html` and `file` are provided", async () => {
		const tool = getTool();
		await tool.execute("call-both", { html: "<p>inline</p>", file: "/some/path.html" });
		const mountPosts = fetchCalls.filter(
			c => c.init?.method === "POST" && String(c.url).includes("/api/preview/mount"),
		);
		assert.strictEqual(mountPosts.length, 1);
		const body = JSON.parse(mountPosts[0].init.body);
		assert.strictEqual(body.html, "<p>inline</p>");
		assert.strictEqual(body.file, undefined);
	});

	it("v3 marker block is constant-size and ≤ 250 bytes for the canonical normalised path", async () => {
		// Canonical normalised form — `<sid>/<entry>` regardless of host OS.
		// This is what the extension feeds the builder in production.
		const url = `/preview/${SID}/report.html`;
		const relPath = `${SID}/report.html`;
		const block = buildPreviewSnapshotV3Block(url, relPath, HASH, { artifactId: ARTIFACT_ID, entry: "report.html" });
		assert.ok(
			block.length <= 250,
			`v3 block must be ≤ 250 bytes, got ${block.length} (${block})`,
		);
		assert.ok(block.startsWith(PREVIEW_SNAPSHOT_MARKER_V3));
		const parsed = parseSnapshot(block);
		assert.ok(parsed && parsed.kind === "preview");
		if (parsed && parsed.kind === "preview") {
			assert.strictEqual(parsed.path, "report.html");
			assert.strictEqual(parsed.entry, "report.html");
			assert.strictEqual(parsed.contentHash, HASH);
			assert.strictEqual(parsed.artifactId, ARTIFACT_ID);
		}
	});

	it("v3 builder omits contentHash when it would exceed the 250 byte cap", async () => {
		const entry = "x".repeat(8) + ".html";
		const url = `/preview/${SID}/${entry}`;
		const relPath = `${SID}/${entry}`;
		const withHashPayload = PREVIEW_SNAPSHOT_MARKER_V3 + JSON.stringify({
			kind: "preview",
			url,
			path: relPath,
			contentHash: HASH,
		}) + "\n";
		assert.ok(withHashPayload.length > 250, `fixture must exceed cap with hash, got ${withHashPayload.length}`);

		const block = buildPreviewSnapshotV3Block(url, relPath, HASH);
		assert.ok(block.length <= 250, `fallback block must stay ≤ 250 bytes, got ${block.length} (${block})`);
		assert.ok(block.startsWith(PREVIEW_SNAPSHOT_MARKER_V3));
		const parsed = parseSnapshot(block);
		assert.ok(parsed && parsed.kind === "preview");
		if (parsed && parsed.kind === "preview") {
			assert.strictEqual(parsed.path, relPath);
			assert.strictEqual(parsed.contentHash, undefined);
		}
	});

	it("builder still round-trips on long legacy host-absolute paths (contract preserved)", async () => {
		// The builder accepts any non-empty string for backwards compatibility
		// with archived sessions that recorded the legacy host-abs `path` form.
		// Such blocks may be > 250 B — the cap only holds when callers pass the
		// canonical relPath form. This test pins the parse-round-trip contract.
		const url = `/preview/${SID}/report.html`;
		const legacyHostPath =
			"/Users/jane.developer/Library/Application Support/bobbit/state/preview/" +
			SID +
			"/report.html";
		const block = buildPreviewSnapshotV3Block(url, legacyHostPath);
		assert.ok(block.startsWith(PREVIEW_SNAPSHOT_MARKER_V3));
		const parsed = parseSnapshot(block);
		assert.ok(parsed && parsed.kind === "preview");
		if (parsed && parsed.kind === "preview") {
			assert.strictEqual(parsed.path, legacyHostPath);
		}
	});

	it("token cost: snapshot block is constant-size for huge HTML payloads", async () => {
		const tool = getTool();
		const huge = "<p>" + "x".repeat(100_000) + "</p>";
		const res = await tool.execute("call-huge", { html: huge });
		assert.strictEqual(res.content.length, 2);
		// Snapshot block must NOT scale with input size, AND must stay under the
		// canonical 250 B per-block cap because the extension now feeds the
		// builder the host-invariant relPath form rather than the host-absolute
		// path. See `defaults/tools/html/extension.ts`.
		assert.ok(
			res.content[1].text.length <= 250,
			`snapshot was ${res.content[1].text.length} bytes (cap 250)`,
		);
		assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3));
	});

	it("extension falls back to host-absolute path when gateway response omits relPath (older gateway)", async () => {
		const tool = getTool();
		// Simulate an older gateway build that doesn't populate `relPath`.
		fetchResponder = (url, init) => {
			if (init?.method === "POST" && String(url).includes("/api/preview/mount")) {
				return {
					status: 200,
					body: {
						url: `/preview/${SID}/inline.html`,
						path: `/old-gateway/state/preview/${SID}/inline.html`,
						// no relPath field
						entry: "inline.html",
						mtime: 1714512345678,
					},
				};
			}
			return { status: 200, body: { ok: true } };
		};
		const res = await tool.execute("call-fallback", { html: "<p>x</p>" });
		assert.strictEqual(res.content.length, 2);
		assert.ok(res.content[1].text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3));
		const parsed = parseSnapshot(res.content[1].text);
		assert.ok(parsed && parsed.kind === "preview");
		if (parsed && parsed.kind === "preview") {
			assert.strictEqual(parsed.path, `/old-gateway/state/preview/${SID}/inline.html`);
		}
	});
});
