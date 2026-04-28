/**
 * Unit test for the outputPath containment check in
 * `defaults/tools/images/extension.ts`.
 *
 * `outputPath` is model-controlled. The extension must reject paths that
 * escape the session worktree (parent traversal or absolute paths outside
 * `process.cwd()`).
 *
 * The containment guard lives inside `outputPathFor()`, which is a module-
 * private helper. We exercise it end-to-end through the registered tool's
 * `execute()` method, mocking `fetch` so the gateway call returns one fake
 * image whose save attempt triggers the path validation.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
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

before(() => {
	originalCwd = process.cwd();
	// Resolve symlinks (macOS /var → /private/var) so process.chdir + path.resolve
	// agree on the canonical cwd — otherwise an absolute path inside the tempdir
	// looks like an escape attempt to the containment check.
	workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "bobbit-outpath-cwd-")));
	stateDir = path.join(workDir, ".bobbit", "state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(path.join(stateDir, "gateway-url"), "http://127.0.0.1:1\n");
	writeFileSync(path.join(stateDir, "token"), "test-token\n");
	process.env.BOBBIT_DIR = path.join(workDir, ".bobbit");
	process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:1";
	process.env.BOBBIT_TOKEN = "test-token";
	process.env.BOBBIT_SESSION_ID = "11111111-1111-1111-1111-111111111111";
	process.chdir(workDir);

	origFetch = globalThis.fetch;
	// Mock /api/image-generation/generate to return one tiny image.
	globalThis.fetch = (async () => new Response(JSON.stringify({
		model: { provider: "openai", id: "gpt-image-2" },
		images: [
			{ data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" },
		],
	}), { status: 200 })) as any;

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

function getTool(): ToolReg {
	const t = registered.find(r => r.name === "generate_image");
	if (!t) throw new Error("generate_image tool not registered");
	return t;
}

beforeEach(() => {
	// Restore default mock between tests in case a previous test overrode it.
	globalThis.fetch = (async () => new Response(JSON.stringify({
		model: { provider: "openai", id: "gpt-image-2" },
		images: [
			{ data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" },
		],
	}), { status: 200 })) as any;
});

async function runWithOutputPath(outputPath: string): Promise<{ result: any; thrown?: Error }> {
	const tool = getTool();
	try {
		const result = await tool.execute("call-1", { prompt: "test", outputPath });
		return { result };
	} catch (err) {
		return { result: undefined, thrown: err as Error };
	}
}

describe("outputPath containment (generate_image extension)", () => {
	it("relative path under cwd resolves and writes successfully", async () => {
		const target = path.join(".bobbit", "state", "ok.png");
		const { result, thrown } = await runWithOutputPath(target);
		assert.equal(thrown, undefined, `unexpected throw: ${thrown?.message}`);
		// Tool returned no isError flag; the saved-paths line is in the text content.
		assert.ok(result, "result should be defined");
		assert.equal(result.isError, undefined);
		const text = result.content.map((c: any) => c.text).filter(Boolean).join("\n");
		assert.match(text, /Saved: /);
		// File must exist under workDir, not anywhere outside it.
		const written = path.resolve(workDir, target);
		assert.ok(existsSync(written), `expected written file at ${written}`);
	});

	it("parent-traversal `../foo.png` throws 'outputPath escapes worktree'", async () => {
		const { thrown } = await runWithOutputPath("../foo.png");
		assert.ok(thrown, "should have thrown");
		assert.match(thrown!.message, /outputPath escapes worktree/);
	});

	it("absolute path outside cwd `/etc/passwd` throws", async () => {
		const { thrown } = await runWithOutputPath("/etc/passwd");
		assert.ok(thrown, "should have thrown");
		assert.match(thrown!.message, /outputPath escapes worktree/);
	});

	it("multi-level traversal `../../sibling/file.png` throws", async () => {
		const { thrown } = await runWithOutputPath("../../sibling-worktree/file.png");
		assert.ok(thrown, "should have thrown");
		assert.match(thrown!.message, /outputPath escapes worktree/);
	});

	it("absolute path that happens to be inside cwd is accepted", async () => {
		// Edge case: an absolute path that resolves under cwd should NOT be
		// rejected by the containment check (path.relative returns a non-`..`
		// non-absolute string in that case).
		const inside = path.join(workDir, ".bobbit", "state", "inside.png");
		const { result, thrown } = await runWithOutputPath(inside);
		assert.equal(thrown, undefined, `unexpected throw: ${thrown?.message}`);
		assert.ok(result);
		assert.equal(result.isError, undefined);
	});
});
