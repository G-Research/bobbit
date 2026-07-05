/**
 * Pinning test for F1(b): `generate_image` must NOT return the full base64
 * image payload in the tool result once the image has already been saved to
 * disk via `outputPath` — that wastes tokens on every image call. Bytes are
 * only returned inline when either (a) no `outputPath` was given (there is
 * no other way to get the pixels back), or (b) the caller explicitly opts in
 * via `returnInline: true` (e.g. a model that wants to visually inspect what
 * it just generated).
 *
 * See `defaults/tools/images/extension.ts` (the `images.map(...)` block
 * building the tool result's `content` array) and
 * `~/Documents/dev/bobbit-fable-refactor/RECONCILIATION-2026-07-05.md` F1(b).
 *
 * Mirrors the mocking approach in `tests/output-path-containment.test.ts`.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import extensionFactory from "../defaults/tools/images/extension.ts";

type ToolReg = {
	name: string;
	execute: (toolCallId: string, params: any) => Promise<any>;
};

const registered: ToolReg[] = [];
const pi = { registerTool: (t: ToolReg) => { registered.push(t); } } as any;

let originalCwd = process.cwd();
let workDir: string;
let stateDir: string;
let origFetch: typeof fetch;

const FAKE_IMAGE_B64 = Buffer.from("fake-png-bytes").toString("base64");

function mockFetchWithImages(count: number) {
	globalThis.fetch = (async () => new Response(JSON.stringify({
		model: { provider: "openai", id: "gpt-image-2" },
		images: Array.from({ length: count }, () => ({ data: FAKE_IMAGE_B64, mimeType: "image/png" })),
	}), { status: 200 })) as any;
}

before(() => {
	originalCwd = process.cwd();
	// Resolve symlinks (macOS /var -> /private/var) so process.chdir + path.resolve
	// agree on the canonical cwd.
	workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "bobbit-inline-payload-cwd-")));
	stateDir = path.join(workDir, ".bobbit", "state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(path.join(stateDir, "gateway-url"), "http://127.0.0.1:1\n");
	writeFileSync(path.join(stateDir, "token"), "test-token\n");
	process.env.BOBBIT_DIR = path.join(workDir, ".bobbit");
	process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:1";
	process.env.BOBBIT_TOKEN = "test-token";
	process.env.BOBBIT_SESSION_ID = "22222222-2222-2222-2222-222222222222";
	process.chdir(workDir);

	origFetch = globalThis.fetch;
	mockFetchWithImages(1);

	extensionFactory(pi);
});

after(() => {
	globalThis.fetch = origFetch;
	process.chdir(originalCwd);
	rmSync(workDir, { recursive: true, force: true });
	delete process.env.BOBBIT_DIR;
	delete process.env.BOBBIT_GATEWAY_URL;
	delete process.env.BOBBIT_TOKEN;
	delete process.env.BOBBIT_SESSION_ID;
});

beforeEach(() => {
	mockFetchWithImages(1);
});

function getTool(): ToolReg {
	const t = registered.find(r => r.name === "generate_image");
	if (!t) throw new Error("generate_image tool not registered");
	return t;
}

function imageBlocks(result: any): any[] {
	return (result.content || []).filter((c: any) => c.type === "image");
}

function textOf(result: any): string {
	return (result.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

describe("generate_image inline-payload token savings (F1(b))", () => {
	it("no outputPath: still returns the base64 image inline (unchanged default behavior)", async () => {
		const tool = getTool();
		const result = await tool.execute("call-1", { prompt: "a cat" });
		assert.equal(result.isError, undefined);
		const images = imageBlocks(result);
		assert.equal(images.length, 1, "expected one inline image block");
		assert.equal(images[0].data, FAKE_IMAGE_B64);
		assert.equal(images[0].mimeType, "image/png");
	});

	it("outputPath set, no returnInline: omits base64 image blocks from content", async () => {
		const tool = getTool();
		const result = await tool.execute("call-2", { prompt: "a cat", outputPath: "out/cat.png" });
		assert.equal(result.isError, undefined);
		const images = imageBlocks(result);
		assert.equal(images.length, 0, "outputPath save succeeded; base64 body must not be duplicated in the result");
		// The save + path must still be reported so the caller knows where it landed.
		assert.match(textOf(result), /Saved: /);
		assert.ok(Array.isArray(result.details?.savedPaths) && result.details.savedPaths.length === 1);
	});

	it("outputPath set with returnInline:true: still returns base64 image blocks", async () => {
		const tool = getTool();
		const result = await tool.execute("call-3", { prompt: "a cat", outputPath: "out/cat2.png", returnInline: true });
		assert.equal(result.isError, undefined);
		const images = imageBlocks(result);
		assert.equal(images.length, 1, "returnInline:true must opt back into inline bytes even with outputPath set");
		assert.equal(images[0].data, FAKE_IMAGE_B64);
		assert.match(textOf(result), /Saved: /);
	});

	it("outputPath set, returnInline:false explicitly: omits base64 image blocks (same as unset)", async () => {
		const tool = getTool();
		const result = await tool.execute("call-4", { prompt: "a cat", outputPath: "out/cat3.png", returnInline: false });
		assert.equal(result.isError, undefined);
		assert.equal(imageBlocks(result).length, 0);
	});

	it("multiple images + outputPath, no returnInline: omits all base64 blocks, still saves all files", async () => {
		mockFetchWithImages(3);
		const tool = getTool();
		const result = await tool.execute("call-5", { prompt: "a cat", outputPath: "out/multi.png" });
		assert.equal(result.isError, undefined);
		assert.equal(imageBlocks(result).length, 0);
		assert.equal(result.details?.savedPaths?.length, 3);
	});
});
