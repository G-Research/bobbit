/**
 * Unit tests for Slice C3 — server-module worker isolation
 * (src/server/extension-host/module-host-worker.ts + module-host-bootstrap.ts +
 * confinement-loader.ts), design docs/design/extension-host-phase2.md §9.
 *
 * Pinned invariants (the C3 acceptance set):
 *   - CPU control: a `while(1)` runaway is TERMINATED on timeout (504) — wall-time
 *     termination IS the CPU-cap control (worker_threads has no per-core throttle).
 *   - Memory cap: a handler that exceeds `resourceLimits.maxOldGenerationSizeMb`
 *     crashes the worker → ActionError, never an unbounded parent allocation.
 *   - Module-load deny-hook: a pack module CANNOT import `node:fs`,
 *     `node:child_process`, or network built-ins (`node:net`/`node:http`).
 *   - Empty env: a pack module CANNOT read `process.env` secrets.
 *   - Crash isolation: a thrown/crashing handler becomes an error, the host
 *     survives, and the NEXT invocation still works.
 *   - Host-API proxy: the ONLY capability handed to pack code is the host proxy,
 *     whose store/session calls are marshalled to (and authorized in) the parent.
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
import { ModuleHost, DENIED_BUILTINS, type InvokeRequest } from "../src/server/extension-host/module-host-worker.ts";
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

function req(url: string, member: string, ctx: ActionHandlerCtx, arg: unknown = {}): InvokeRequest {
	return { url, epoch: 0, exportKind: "actions", member, ctx, arg };
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

describe("ModuleHost — module-load deny-hook (no ambient fs/network/exec)", () => {
	for (const builtin of ["node:fs", "node:child_process", "node:net", "node:http", "node:https"]) {
		it(`a pack module CANNOT import ${builtin}`, async () => {
			const mh = new ModuleHost({ timeoutMs: 10_000 });
			try {
				const url = writeModule(`export const actions = { evil: async () => { await import(${JSON.stringify(builtin)}); return "should-not-reach"; } };`);
				await assert.rejects(
					() => mh.invoke(req(url, "evil", bareCtx())),
					(e) => e instanceof ActionError && /denied|confinement/i.test(e.message),
				);
			} finally {
				mh.dispose();
			}
		});
	}

	it("the bare specifier form (no node: prefix) and subpaths are denied too", async () => {
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const urlBare = writeModule(`export const actions = { evil: async () => { await import("child_process"); } };`);
			await assert.rejects(() => mh.invoke(req(urlBare, "evil", bareCtx())), (e) => e instanceof ActionError && /denied/i.test(e.message));
			const urlSub = writeModule(`export const actions = { evil: async () => { await import("node:fs/promises"); } };`);
			await assert.rejects(() => mh.invoke(req(urlSub, "evil", bareCtx())), (e) => e instanceof ActionError && /denied/i.test(e.message));
		} finally {
			mh.dispose();
		}
	});

	it("the deny-list covers every dangerous built-in named in design §9", () => {
		for (const b of ["fs", "child_process", "net", "http", "https", "worker_threads", "process", "module"]) {
			assert.ok(DENIED_BUILTINS.includes(b), `expected ${b} to be denied`);
		}
	});
});

describe("ModuleHost — empty env (no host secrets)", () => {
	it("a pack module CANNOT read process.env secrets (the worker is started with env: {})", async () => {
		const SECRET = "super-secret-token-" + Math.random().toString(36).slice(2);
		process.env.BOBBIT_TEST_ISOLATION_SECRET = SECRET;
		const mh = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeModule(`export const actions = { peek: async () => ({ secret: process.env.BOBBIT_TEST_ISOLATION_SECRET ?? null, envKeys: Object.keys(process.env).length }) };`);
			const result = (await mh.invoke(req(url, "peek", bareCtx()))) as { secret: string | null; envKeys: number };
			assert.equal(result.secret, null, "the host secret must NOT be visible in the worker");
			assert.equal(result.envKeys, 0, "the worker env must be empty");
		} finally {
			mh.dispose();
			delete process.env.BOBBIT_TEST_ISOLATION_SECRET;
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
