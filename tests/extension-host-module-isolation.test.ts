/**
 * Unit tests for server-module worker isolation
 * (src/server/extension-host/module-host-worker.ts + module-host-bootstrap.ts +
 * confinement-loader.ts).
 *
 * Pack server code is TRUSTED (the tool/MCP tier) and runs with FULL ambient parity
 * — there is NO capability sandbox. The only isolation kept is the genuine kind:
 * resource/crash isolation + module-import containment (loader hygiene).
 *
 * Pinned invariants:
 *   - Ambient parity: a pack module may `import("node:child_process")` /
 *     `import("node:fs")`, `fetch` is a function, `process.env` is readable with no
 *     declaration, and `process.cwd()` returns the supplied `workingDir`.
 *   - CPU control: a `while(1)` runaway is TERMINATED on timeout (504) — wall-time
 *     termination IS the CPU-cap control (worker_threads has no per-core throttle).
 *   - Memory cap: a handler that exceeds `resourceLimits.maxOldGenerationSizeMb`
 *     crashes the worker → ActionError, never an unbounded parent allocation.
 *   - Crash isolation: a thrown/crashing handler becomes an error, the host
 *     survives, and the NEXT invocation still works.
 *   - Host-API proxy: store/session calls are marshalled to (and authorized in) the
 *     parent.
 *   - File-resolution confinement (module-import hygiene): a pack module may import a
 *     SIBLING within its own pack root, but a `../` walk / absolute `file:` URL /
 *     symlink escaping the pack root is REJECTED (every resolved `file:` URL must be
 *     realpath-contained within the validated pack root forwarded into `workerData`).
 *
 * Fixtures are `.mjs` ESM modules under a temp dir (the worker dynamic-imports
 * them by file:// URL, exactly as the dispatcher builds it).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ModuleHost, type InvokeRequest } from "../src/server/extension-host/module-host-worker.ts";
import { ActionError, type ActionHandlerCtx } from "../src/server/extension-host/action-dispatcher.ts";

let tmp: string;
let seq = 0;

/** Write an `actions` pack module and return the file:// URL the worker imports. */
function writeModule(body: string): string {
	const file = path.join(tmp, `mod-${seq++}.mjs`);
	fs.writeFileSync(file, body);
	return pathToFileURL(file).href;
}

/** A bare ctx whose `host` is empty (handlers that don't touch the host). */
const bareCtx = (): ActionHandlerCtx => ({
	host: {} as ActionHandlerCtx["host"],
	sessionId: "sess-1",
	toolUseId: "tu-1",
	tool: "demo_tool",
});

function req(url: string, member: string, ctx: ActionHandlerCtx, arg: unknown = {}, packRoot: string = tmp, workingDir?: string): InvokeRequest {
	return { url, packRoot, epoch: 0, exportKind: "actions", member, ctx, arg, workingDir };
}

/** Write `body` to `dir/name` (creating `dir`), returning its file:// URL — for
 *  the file-confinement tests that need a specific pack root + siblings. */
function writeInDir(dir: string, name: string, body: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return pathToFileURL(file).href;
}

/** Create a symlink, returning false (so the test can skip) when the platform
 *  forbids it (e.g. Windows without the create-symlink privilege). */
function trySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath);
		return true;
	} catch (err: any) {
		if (err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "ENOSYS")) return false;
		throw err;
	}
}

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-host-iso-"));
});
after(() => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("ModuleHost — confined execution (happy path + identity)", () => {
	it("runs a handler in a worker and returns its (structured-cloned) result", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(`export const actions = { run: async (ctx, arg) => ({ ok: true, echo: arg, tool: ctx.tool, sid: ctx.sessionId }) };`);
			const result = await mh.invoke(req(url, "run", bareCtx(), { n: 7 }));
			assert.deepEqual(result, { ok: true, echo: { n: 7 }, tool: "demo_tool", sid: "sess-1" });
		} finally {
			mh.dispose();
		}
	});

	it("an unknown member resolves to a 404 (own-function check inside the worker)", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(`export const actions = { run: async () => ({}) };`);
			await assert.rejects(
				() => mh.invoke(req(url, "constructor", bareCtx())),
				(e) => e instanceof ActionError && e.status === 404,
			);
		} finally {
			mh.dispose();
		}
	});
});

describe("ModuleHost — module eval runs in the worker (parent NEVER imports pack code)", () => {
	it("a module whose TOP-LEVEL code spins forever (while(1)) is TERMINATED on timeout → 504", async () => {
		// PROOF for Fix 1: the runaway is in MODULE EVALUATION (before any export), so
		// it can only be bounded if the IMPORT happens in the terminate-able worker. If
		// the parent imported pack code, this top-level while(1) would hang the
		// privileged gateway process forever (no termination). A prompt 504 proves
		// load+eval runs in the worker.
		const mh = new ModuleHost({ timeoutMs: 400 });
		try {
			const url = writeModule(`while (true) { /* runaway top-level eval */ }\nexport const actions = { run: async () => "x" };`);
			const t0 = Date.now();
			await assert.rejects(
				() => mh.invoke(req(url, "run", bareCtx())),
				(e) => e instanceof ActionError && e.status === 504,
			);
			assert.ok(Date.now() - t0 < 5_000, "the worker running module eval should be terminated promptly");
		} finally {
			mh.dispose();
		}
	});

	it("a module with NO actions export resolves to a structured 500 (export-map validation moved into the worker)", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(`export const notActions = {};`);
			await assert.rejects(
				() => mh.invoke(req(url, "anything", bareCtx())),
				(e) => e instanceof ActionError && e.status === 500,
			);
		} finally {
			mh.dispose();
		}
	});
});

describe("ModuleHost — ambient parity (trusted pack = tool/MCP tier; acceptance #1)", () => {
	it("a pack module may import node:child_process and node:fs with no declaration", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(
				`export const actions = { probe: async () => {` +
				` const cp = await import("node:child_process");` +
				` const fs = await import("node:fs");` +
				` return { cp: typeof cp.execFile, fs: typeof fs.readFileSync }; } };`,
			);
			const r = (await mh.invoke(req(url, "probe", bareCtx()))) as Record<string, unknown>;
			assert.equal(r.cp, "function", "node:child_process must be importable (ambient)");
			assert.equal(r.fs, "function", "node:fs must be importable (ambient)");
		} finally {
			mh.dispose();
		}
	});

	it("fetch is a function and process.env is readable with no declaration", async () => {
		const SECRET = "tl-secret-" + Math.random().toString(36).slice(2);
		process.env.BOBBIT_TEST_TL_SECRET = SECRET;
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(
				`export const actions = { probe: async () => ({` +
				` fetch: typeof fetch,` +
				` env: process.env.BOBBIT_TEST_TL_SECRET ?? null, envKeys: Object.keys(process.env).length` +
				` }) };`,
			);
			const r = (await mh.invoke(req(url, "probe", bareCtx()))) as Record<string, unknown>;
			assert.equal(r.fetch, "function", "fetch must be ambient");
			assert.equal(r.env, SECRET, "process.env must be readable (full env parity)");
			assert.ok((r.envKeys as number) > 0, "process.env must be non-empty");
		} finally {
			mh.dispose();
			delete process.env.BOBBIT_TEST_TL_SECRET;
		}
	});

	it("process.cwd() returns the supplied workingDir (tool-parity override)", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const wd = fs.realpathSync(tmp);
			const url = writeModule(`export const actions = { cwd: async () => process.cwd() };`);
			const r = await mh.invoke(req(url, "cwd", bareCtx(), {}, tmp, wd));
			assert.equal(r, wd, "process.cwd() must be overridden to the session working dir");
		} finally {
			mh.dispose();
		}
	});

	it("ctx.workingDir is surfaced on the handler ctx (the workingDir contract)", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const wd = fs.realpathSync(tmp);
			// The handler ctx must carry workingDir (threaded from req.ctx.workingDir),
			// not just the process.cwd() override — a pack may read ctx.workingDir directly.
			const ctx: ActionHandlerCtx = { ...bareCtx(), workingDir: wd };
			const url = writeModule(`export const actions = { wd: async (ctx) => ctx.workingDir };`);
			const r = await mh.invoke(req(url, "wd", ctx, {}, tmp, wd));
			assert.equal(r, wd, "ctx.workingDir must reach the reconstructed handler ctx");
		} finally {
			mh.dispose();
		}
	});
});

describe("ModuleHost — CPU / wall-time termination (design §9: terminate-on-timeout IS the CPU control)", () => {
	it("a while(1) CPU spin is TERMINATED on timeout → 504 (true cancellation, not a hung permit)", async () => {
		const mh = new ModuleHost({ timeoutMs: 400 });
		try {
			const url = writeModule(`export const actions = { spin: () => { while (true) { /* runaway */ } } };`);
			const t0 = Date.now();
			await assert.rejects(
				() => mh.invoke(req(url, "spin", bareCtx())),
				(e) => e instanceof ActionError && e.status === 504,
			);
			// The worker was KILLED promptly (not left spinning forever).
			assert.ok(Date.now() - t0 < 5_000, "timeout should fire and terminate the worker promptly");
		} finally {
			mh.dispose();
		}
	});
});

describe("ModuleHost — memory cap (resourceLimits)", () => {
	it("a handler that exceeds the heap cap crashes the worker → ActionError, not an unbounded parent alloc", async () => {
		// Tight heap cap; a generous timeout so the OOM (not the timer) is what fires.
		const mh = new ModuleHost({ timeoutMs: 15_000, maxOldGenerationSizeMb: 16 });
		try {
			const url = writeModule(`export const actions = { hog: async () => { const a = []; for (;;) { a.push(new Array(1e6).fill(7)); } } };`);
			await assert.rejects(
				() => mh.invoke(req(url, "hog", bareCtx())),
				(e) => e instanceof ActionError && /memory|heap/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});
});

describe("ModuleHost — file-resolution confinement (pack module graph is confined to its pack root)", () => {
	let caseSeq = 0;
	const packDir = (): string => path.join(tmp, `pack-${caseSeq++}`);

	it("a pack module importing a SIBLING within its pack root resolves", async () => {
		const dir = packDir();
		writeInDir(dir, "helper.mjs", `export const v = 42;`);
		const url = writeInDir(dir, "entry.mjs", `import { v } from "./helper.mjs";\nexport const actions = { run: async () => v };`);
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			assert.equal(await mh.invoke(req(url, "run", bareCtx(), {}, dir)), 42);
		} finally {
			mh.dispose();
		}
	});

	it("a STATIC import of `../outside.mjs` (relative walk out of the pack root) is REJECTED", async () => {
		const dir = packDir();
		// The escape target lives in `tmp`, OUTSIDE the pack root `dir`.
		fs.writeFileSync(path.join(tmp, `outside-rel-${caseSeq}.mjs`), `export const x = "stolen";`);
		const url = writeInDir(dir, "entry.mjs", `import { x } from "../outside-rel-${caseSeq}.mjs";\nexport const actions = { run: async () => x };`);
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			await assert.rejects(
				() => mh.invoke(req(url, "run", bareCtx(), {}, dir)),
				(e) => e instanceof ActionError && /escape|confinement/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});

	it("a DYNAMIC import of an absolute `file:` URL outside the pack root is REJECTED", async () => {
		const dir = packDir();
		const secret = path.join(tmp, `abs-secret-${caseSeq}.mjs`);
		fs.writeFileSync(secret, `export const s = "abs-stolen";`);
		const secretUrl = pathToFileURL(secret).href;
		const url = writeInDir(
			dir,
			"entry.mjs",
			`export const actions = { run: async () => { await import(${JSON.stringify(secretUrl)}); return "leaked"; } };`,
		);
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			await assert.rejects(
				() => mh.invoke(req(url, "run", bareCtx(), {}, dir)),
				(e) => e instanceof ActionError && /escape|confinement/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});

	it("a symlink that is lexically inside the pack root but RESOLVES outside is REJECTED", async (t) => {
		const dir = packDir();
		fs.mkdirSync(dir, { recursive: true });
		const secret = path.join(tmp, `sym-secret-${caseSeq}.mjs`);
		fs.writeFileSync(secret, `export const s = "sym-stolen";`);
		// A pack entry lexically inside `dir` that symlinks to the out-of-pack secret.
		const link = path.join(dir, "link.mjs");
		if (!trySymlink(secret, link)) {
			t.skip("symlink creation not permitted on this platform");
			return;
		}
		const url = writeInDir(dir, "entry.mjs", `import { s } from "./link.mjs";\nexport const actions = { run: async () => s };`);
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			await assert.rejects(
				() => mh.invoke(req(url, "run", bareCtx(), {}, dir)),
				(e) => e instanceof ActionError && /escape|confinement/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});

	it("a node:fs import is ALLOWED with a pack root set, but a `../` file-escape import is still REJECTED", async () => {
		const dir = packDir();
		// node:fs is ambient now — importing it must succeed (no deny-list).
		const okUrl = writeInDir(dir, "entry-fs.mjs", `import * as fs from "node:fs";\nexport const actions = { run: async () => typeof fs.readFileSync };`);
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			assert.equal(await mh.invoke(req(okUrl, "run", bareCtx(), {}, dir)), "function");
			// But module-import containment still rejects a file: escape out of the pack root.
			fs.writeFileSync(path.join(tmp, `escape-${caseSeq}.mjs`), `export const x = "stolen";`);
			const escUrl = writeInDir(dir, "entry-escape.mjs", `import { x } from "../escape-${caseSeq}.mjs";\nexport const actions = { run: async () => x };`);
			await assert.rejects(
				() => mh.invoke(req(escUrl, "run", bareCtx(), {}, dir)),
				(e) => e instanceof ActionError && /escape|confinement/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});
});

describe("ModuleHost — crash isolation", () => {
	it("a thrown handler becomes a 500 (message preserved) and the host survives for the NEXT invoke", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const boom = writeModule(`export const actions = { boom: async () => { throw new Error("kaboom"); } };`);
			await assert.rejects(
				() => mh.invoke(req(boom, "boom", bareCtx())),
				(e) => e instanceof ActionError && e.status === 500 && /kaboom/.test(e.message),
			);
			// Isolation held: an independent handler still runs afterward.
			const ok = writeModule(`export const actions = { run: async () => ({ alive: true }) };`);
			assert.deepEqual(await mh.invoke(req(ok, "run", bareCtx())), { alive: true });
		} finally {
			mh.dispose();
		}
	});

	it("a synchronous process-level crash (e.g. a top-level throw on import) is isolated → ActionError", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(`throw new Error("module-eval-crash");\nexport const actions = {};`);
			await assert.rejects(
				() => mh.invoke(req(url, "anything", bareCtx())),
				(e) => e instanceof ActionError,
			);
			// The parent (this test process) is still alive and serving.
			const ok = writeModule(`export const actions = { run: async () => 42 };`);
			assert.equal(await mh.invoke(req(ok, "run", bareCtx())), 42);
		} finally {
			mh.dispose();
		}
	});
});

describe("ModuleHost — host-API proxy (the ONLY capability over the MessagePort)", () => {
	it("store.put/get calls are marshalled to (and serviced by) the parent's LIVE host", async () => {
		// The parent host records calls; the worker reaches it ONLY through the proxy.
		const stored = new Map<string, unknown>();
		const calls: string[] = [];
		const host = {
			version: 1,
			contractVersion: 1,
			capabilities: { callRoute: false, session: false, store: true, has: (n: string) => n === "store" },
			store: {
				put: async (k: string, v: unknown) => { calls.push(`put:${k}`); stored.set(k, v); },
				get: async (k: string) => { calls.push(`get:${k}`); return stored.get(k) ?? null; },
				list: async () => [...stored.keys()],
			},
			session: {
				readTranscript: async () => ({}),
				readToolCall: async () => null,
				postMessage: async () => {},
			},
		} as unknown as ActionHandlerCtx["host"];
		const ctx: ActionHandlerCtx = { host, sessionId: "sess-9", toolUseId: "tu-9", tool: "demo_tool" };

		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(
				`export const actions = { roundtrip: async (ctx, arg) => {` +
				` await ctx.host.store.put("k", arg);` +
				` const back = await ctx.host.store.get("k");` +
				` return { back, hasStore: ctx.host.capabilities.has("store") };` +
				` } };`,
			);
			const result = (await mh.invoke(req(url, "roundtrip", ctx, { v: 123 }))) as { back: unknown; hasStore: boolean };
			assert.deepEqual(result.back, { v: 123 }, "value round-trips through the host proxy");
			assert.equal(result.hasStore, true, "capability flags cross the proxy");
			assert.deepEqual(calls, ["put:k", "get:k"], "calls were serviced by the parent host, in order");
			assert.deepEqual(stored.get("k"), { v: 123 });
		} finally {
			mh.dispose();
		}
	});

	it("a host call that the parent rejects surfaces as an error to the pack handler", async () => {
		const host = {
			version: 1,
			contractVersion: 1,
			capabilities: { callRoute: false, session: false, store: true, has: () => true },
			store: {
				get: async () => { throw new Error("cross-pack read rejected"); },
				put: async () => {},
				list: async () => [],
			},
			session: { readTranscript: async () => ({}), readToolCall: async () => null, postMessage: async () => {} },
		} as unknown as ActionHandlerCtx["host"];
		const ctx: ActionHandlerCtx = { host, sessionId: "s", toolUseId: "t", tool: "demo_tool" };
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(
				`export const actions = { tryget: async (ctx) => {` +
				` try { await ctx.host.store.get("denied"); return "no-throw"; }` +
				` catch (e) { return "caught:" + e.message; } } };`,
			);
			const result = await mh.invoke(req(url, "tryget", ctx));
			assert.equal(result, "caught:cross-pack read rejected");
		} finally {
			mh.dispose();
		}
	});
});
