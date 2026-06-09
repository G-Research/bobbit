/**
 * Unit tests for the SERVER extension host's ActionDispatcher
 * (src/server/extension-host/action-dispatcher.ts) — design
 * docs/design/extension-host.md §4b / §5 control iv.
 *
 * Pinned invariants:
 *   - Module resolution honors the WINNING provider's {baseDir, groupDir}
 *     (precedence/shadowing is decided by ToolManager; the dispatcher loads from
 *     whatever provider it is handed).
 *   - actions.module path defaults to "actions.js" and honors a custom value.
 *   - Unknown action / missing module → 404; handler throw → 500; timeout → 504.
 *   - Global concurrency cap → 429; per-session rate limit → 429.
 *   - Cache: a hot module is reused; invalidate() forces a fresh import that
 *     picks up updated handler source (install/update/uninstall path).
 *
 * Fixtures are written under a temp dir (file:// ESM imports) and removed after.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ActionDispatcher,
	ActionError,
	resolveActionToolManager,
	type ActionHandlerCtx,
	type ActionToolLocationResolver,
} from "../src/server/extension-host/action-dispatcher.ts";

let tmp: string;

/** Build a stub ToolManager whose single tool resolves to {baseDir, groupDir}.
 *  `actionsModule` mirrors what ToolManager.resolveToolLocation supplies from
 *  the tool YAML's `actions.module` (undefined ⇒ dispatcher defaults to actions.js). */
function resolver(
	baseDir: string,
	groupDir: string,
	opts: { tool?: string; actionsModule?: string } = {},
): ActionToolLocationResolver {
	const tool = opts.tool ?? "sample_action";
	return {
		resolveToolLocation: (name) =>
			name === tool ? { baseDir, groupDir, actionsModule: opts.actionsModule } : undefined,
	};
}

function writeTool(baseDir: string, groupDir: string, opts: { yaml?: string; actionsJs?: string; moduleName?: string } = {}): void {
	const dir = path.join(baseDir, groupDir);
	fs.mkdirSync(dir, { recursive: true });
	const moduleName = opts.moduleName ?? "actions.js";
	fs.writeFileSync(
		path.join(dir, "sample_action.yaml"),
		opts.yaml ?? `name: sample_action\ndescription: demo\ngroup: Demo\nrenderer: SampleActionRenderer.js\nactions:\n  module: ${moduleName}\n  names: [retry]\n`,
	);
	if (opts.actionsJs !== undefined) {
		fs.writeFileSync(path.join(dir, moduleName), opts.actionsJs);
	}
}

const ctx = (): ActionHandlerCtx => ({
	host: {} as ActionHandlerCtx["host"],
	sessionId: "sess-1",
	toolUseId: "tu-1",
	tool: "sample_action",
});

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-host-dispatch-"));
});
after(() => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("ActionDispatcher — resolution + happy path", () => {
	it("loads actions.js from the winning provider dir and returns the handler result", async () => {
		const base = path.join(tmp, "case-happy");
		writeTool(base, "demo", {
			actionsJs: `export const actions = { retry: async (ctx, args) => ({ ok: true, echo: args, tool: ctx.tool }) };`,
		});
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null });
		const result = await d.dispatch("sample_action", "retry", ctx(), { n: 7 });
		assert.deepEqual(result, { ok: true, echo: { n: 7 }, tool: "sample_action" });
	});

	it("honors a custom actions.module path from the YAML", async () => {
		const base = path.join(tmp, "case-custom-module");
		writeTool(base, "demo", {
			moduleName: "handlers.js",
			yaml: `name: sample_action\ndescription: d\ngroup: Demo\nactions:\n  module: handlers.js\n`,
			actionsJs: `export const actions = { retry: async () => ({ from: "handlers.js" }) };`,
		});
		const d = new ActionDispatcher(resolver(base, "demo", { actionsModule: "handlers.js" }), { rate: null });
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { from: "handlers.js" });
	});

	it("supports a default-exported actions module", async () => {
		const base = path.join(tmp, "case-default-export");
		writeTool(base, "demo", {
			actionsJs: `export default { actions: { retry: async () => ({ via: "default" }) } };`,
		});
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null });
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { via: "default" });
	});

	it("loads from whatever (winning) provider dir it is handed (precedence/shadowing)", async () => {
		// Simulate a market pack that shadowed a builtin: the resolver returns the
		// PACK baseDir, so the PACK actions.js is what loads.
		const builtin = path.join(tmp, "case-precedence", "builtin");
		const pack = path.join(tmp, "case-precedence", "market-packs", "demo", "tools-root");
		writeTool(builtin, "demo", { actionsJs: `export const actions = { retry: async () => ({ from: "builtin" }) };` });
		writeTool(pack, "demo", { actionsJs: `export const actions = { retry: async () => ({ from: "pack" }) };` });
		const d = new ActionDispatcher(resolver(pack, "demo"), { rate: null });
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { from: "pack" });
	});
});

describe("ActionDispatcher — error isolation + blast-radius", () => {
	it("unknown tool provider → 404", async () => {
		const d = new ActionDispatcher({ resolveToolLocation: () => undefined }, { rate: null });
		await assert.rejects(() => d.dispatch("nope", "retry", ctx(), {}), (e) => e instanceof ActionError && e.status === 404);
	});

	it("missing actions module file → 404", async () => {
		const base = path.join(tmp, "case-missing-module");
		writeTool(base, "demo", { /* no actionsJs written */ });
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null });
		await assert.rejects(() => d.dispatch("sample_action", "retry", ctx(), {}), (e) => e instanceof ActionError && e.status === 404);
	});

	it("unknown action name → 404", async () => {
		const base = path.join(tmp, "case-unknown-action");
		writeTool(base, "demo", { actionsJs: `export const actions = { retry: async () => ({}) };` });
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null });
		await assert.rejects(() => d.dispatch("sample_action", "doesnotexist", ctx(), {}), (e) => e instanceof ActionError && e.status === 404);
	});

	it("inherited property name (constructor/toString) is rejected as unknown, never executed", async () => {
		// A module WITHOUT an `actions.names` allowlist: `module.actions[action]` for
		// `constructor`/`toString` would resolve an inherited Object.prototype member
		// (a function!) and execute it. The own-property guard must reject it as 404.
		const base = path.join(tmp, "case-inherited");
		writeTool(base, "demo", {
			yaml: `name: sample_action\ndescription: d\ngroup: Demo\nactions:\n  module: actions.js\n`,
			actionsJs: `export const actions = { retry: async () => ({ ok: 1 }) };`,
		});
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null });
		for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			await assert.rejects(
				() => d.dispatch("sample_action", evil, ctx(), {}),
				(e) => e instanceof ActionError && e.status === 404,
				`expected ${evil} to be rejected as unknown action`,
			);
		}
		// The real own action still works.
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { ok: 1 });
	});

	it("module without an actions export → 500", async () => {
		const base = path.join(tmp, "case-no-export");
		writeTool(base, "demo", { actionsJs: `export const notActions = {};` });
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null });
		await assert.rejects(() => d.dispatch("sample_action", "retry", ctx(), {}), (e) => e instanceof ActionError && e.status === 500);
	});

	it("handler throw → 500 and the dispatcher survives (process not torn down)", async () => {
		const base = path.join(tmp, "case-throw");
		writeTool(base, "demo", { actionsJs: `export const actions = { retry: async () => { throw new Error("boom"); } };` });
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null });
		await assert.rejects(() => d.dispatch("sample_action", "retry", ctx(), {}), (e) => e instanceof ActionError && e.status === 500 && /boom/.test(e.message));
		// Isolation held: an independent good handler still runs afterward.
		const ok = path.join(tmp, "case-throw-ok");
		writeTool(ok, "demo", { actionsJs: `export const actions = { retry: async () => ({ ok: 1 }) };` });
		const d2 = new ActionDispatcher(resolver(ok, "demo"), { rate: null });
		assert.deepEqual(await d2.dispatch("sample_action", "retry", ctx(), {}), { ok: 1 });
	});

	it("handler exceeding the per-call timeout → 504, slot released", async () => {
		const base = path.join(tmp, "case-timeout");
		writeTool(base, "demo", { actionsJs: `export const actions = { retry: () => new Promise(() => {}) };` });
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null, timeoutMs: 40 });
		await assert.rejects(() => d.dispatch("sample_action", "retry", ctx(), {}), (e) => e instanceof ActionError && e.status === 504);
		// Slot released: another (fast) handler from an independent fixture runs.
		const ok = path.join(tmp, "case-timeout-ok");
		writeTool(ok, "demo", { actionsJs: `export const actions = { retry: async () => ({ ok: 1 }) };` });
		const d2 = new ActionDispatcher(resolver(ok, "demo"), { rate: null });
		assert.deepEqual(await d2.dispatch("sample_action", "retry", ctx(), {}), { ok: 1 });
	});

	it("global concurrency cap → 429 for the over-cap call", async () => {
		const base = path.join(tmp, "case-concurrency");
		writeTool(base, "demo", { actionsJs: `export const actions = { retry: () => new Promise((r) => setTimeout(() => r({ ok: 1 }), 80)) };` });
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null, maxConcurrent: 1 });
		const first = d.dispatch("sample_action", "retry", ctx(), {});
		// Second dispatch while the first is in-flight exceeds the cap.
		await assert.rejects(() => d.dispatch("sample_action", "retry", ctx(), {}), (e) => e instanceof ActionError && e.status === 429);
		assert.deepEqual(await first, { ok: 1 });
	});

	it("a hung handler is TERMINATED on timeout (Slice C3) → its permit is released, NOT held forever", async () => {
		// Slice C3 contract (server-module isolation, design §9): the SINGLE invocation
		// seam now runs handlers in a CONFINED worker that the dispatcher TERMINATES on
		// timeout (true cancellation). This SUPERSEDES the Phase-1 permit-held-forever
		// behavior: a runaway handler no longer occupies its slot indefinitely — once it
		// times out, the worker is killed, `work` settles, and the permit is RELEASED.
		// The invariant "permit released exactly once when work settles" is intact; what
		// changes is that termination makes a hung handler's work SETTLE (it cannot hang
		// forever). The fixture handler runs in the worker (separate process/global), so
		// it hangs purely on its own — no parent-process injection.
		const base = path.join(tmp, "case-permit-terminate");
		writeTool(base, "demo", {
			actionsJs: `export const actions = { retry: () => new Promise(() => {}) };`,
		});
		const maxConcurrent = 3;
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null, timeoutMs: 60, maxConcurrent });

		// Fire `maxConcurrent` dispatches; each hangs in its worker and times out 504.
		const hung = Array.from({ length: maxConcurrent }, () => d.dispatch("sample_action", "retry", ctx(), {}));
		// While they are in-flight (workers spawned, handlers hanging), the cap is
		// saturated → an extra dispatch is rejected over-capacity (permit held DURING
		// execution, exactly like Phase 1).
		await assert.rejects(
			() => d.dispatch("sample_action", "retry", ctx(), {}),
			(e) => e instanceof ActionError && e.status === 429,
		);
		// Every hung call returns 504 to the caller once the timeout fires + the worker
		// is terminated.
		await Promise.all(
			hung.map((p) => assert.rejects(() => p, (e) => e instanceof ActionError && e.status === 504)),
		);
		// Let the terminate + permit-decrement settle.
		await new Promise((r) => setTimeout(r, 150));

		// THE C3 PINNING ASSERTION: the permits are now RELEASED (the workers were
		// terminated). A fresh dispatch is ADMITTED past the concurrency gate — it runs
		// its (hanging) handler and times out 504, NOT 429. Under the OLD Phase-1
		// permit-held-forever behavior this would have been 429 (slots never freed).
		await assert.rejects(
			() => d.dispatch("sample_action", "retry", ctx(), {}),
			(e) => e instanceof ActionError && e.status === 504,
		);
		await new Promise((r) => setTimeout(r, 150));
	});

	it("a hung MODULE IMPORT (top-level await) times out promptly (504) and holds its permit until the import settles", async () => {
		// GAP COVERAGE: the per-call timeout must bound MODULE LOAD + EVALUATION,
		// not just handler execution. Before the fix, dispatch() did an UNBOUNDED
		// `await loadModule(...)` and only THEN wrapped the handler in the timeout —
		// so a pack actions module with a hanging top-level `await` (or a stalled
		// dynamic import) left dispatch() awaiting forever, never returning a 504 and
		// holding its permit indefinitely. The existing timeout tests only hang
		// INSIDE the handler (after import succeeds), so this load path was uncovered.
		//
		// The fixture's `.mjs` parks MODULE EVALUATION at a top-level await the test
		// controls via a process-global resolver — so the dynamic import() never
		// settles, exercising the LOAD path (not the handler). All dispatches share
		// the same URL, so Node evaluates the module once (one parked resolver) while
		// every in-flight import() awaits that single evaluation.
		const G = globalThis as Record<string, unknown>;
		const KEY = "__extHostHungImportResolvers";
		G[KEY] = [] as ((v: unknown) => void)[];
		const resolvers = () => G[KEY] as ((v: unknown) => void)[];

		const base = path.join(tmp, "case-hung-import");
		// The top-level await is GATED on the parent-process injection global being
		// present: in the PARENT (loadModule, which still runs in-process — Slice C3
		// only moves HANDLER execution into the worker) the global exists, so module
		// evaluation PARKS (exercising the LOAD-timeout path). When the CONFINED worker
		// re-imports the SAME module to execute the handler, the global is absent in
		// the worker's isolated realm, so the await is skipped and the module evaluates
		// immediately — the handler runs and returns { ok: 1 }.
		writeTool(base, "demo", {
			moduleName: "actions.mjs",
			actionsJs:
				`const __park = globalThis["${KEY}"];\n` +
				`if (__park && typeof __park.push === "function") { await new Promise((resolve) => { __park.push(resolve); }); }\n` +
				`export const actions = { retry: async () => ({ ok: 1 }) };`,
		});
		const maxConcurrent = 3;
		const d = new ActionDispatcher(resolver(base, "demo", { actionsModule: "actions.mjs" }), { rate: null, timeoutMs: 40, maxConcurrent });

		// Fire maxConcurrent dispatches. Each increments inFlight synchronously at
		// entry, then parks at the hanging import (LOAD) → each times out promptly
		// with 504 instead of hanging dispatch() forever.
		const hung = Array.from({ length: maxConcurrent }, () => d.dispatch("sample_action", "retry", ctx(), {}));
		await Promise.all(
			hung.map((p) => assert.rejects(() => p, (e) => e instanceof ActionError && e.status === 504)),
		);

		// The cap is saturated by the still-LOADING modules → the next dispatch is
		// rejected over-capacity (429), proving a hung LOAD counts toward the cap
		// exactly like a hung handler (permit held, not leaked early, no unbounded
		// await). At least one resolver is parked (one shared module evaluation).
		await assert.rejects(
			() => d.dispatch("sample_action", "retry", ctx(), {}),
			(e) => e instanceof ActionError && e.status === 429,
		);
		assert.ok(resolvers().length >= 1, "module evaluation should be parked at the top-level await");

		// Settle the parked import → module finishes evaluating, every in-flight load
		// completes, and its work (now routed to the CONFINED worker) settles → every
		// permit is released.
		for (const r of resolvers().splice(0)) r(undefined);
		// Allow the loads to complete + their worker invocations to settle (Slice C3
		// runs the handler in a worker; with this fixture's tiny 40ms timeout the
		// worker spawn itself exceeds the budget, so the invocations settle via
		// terminate-on-timeout — which still releases the permit).
		await new Promise((r) => setTimeout(r, 300));

		// Capacity has freed: a fresh dispatch is ADMITTED past the concurrency gate.
		// (We assert it is NOT rejected over-capacity; whether it then succeeds or
		// hits the sub-worker-spawn 40ms timeout is immaterial — a still-full cap
		// would have rejected with 429 BEFORE ever loading/invoking.)
		const outcome = await d.dispatch("sample_action", "retry", ctx(), {}).then(
			(value) => ({ value }),
			(err: unknown) => ({ err }),
		);
		assert.ok(
			!("err" in outcome && outcome.err instanceof ActionError && outcome.err.status === 429),
			"capacity should have freed after the parked loads settled (admitted, not 429)",
		);
		delete G[KEY];
		await new Promise((r) => setTimeout(r, 150));
	});

	it("per-session rate limit → 429 once the bucket drains", async () => {
		const base = path.join(tmp, "case-rate");
		writeTool(base, "demo", { actionsJs: `export const actions = { retry: async () => ({ ok: 1 }) };` });
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: { capacity: 2, refillPerSec: 0 } });
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { ok: 1 });
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { ok: 1 });
		await assert.rejects(() => d.dispatch("sample_action", "retry", ctx(), {}), (e) => e instanceof ActionError && e.status === 429);
	});
});

describe("resolveActionToolManager — project-scope precedence (no split-brain, design §4b)", () => {
	it("returns the PROJECT tool manager when one is present (project pack wins)", () => {
		const server = { id: "server" } as unknown as ActionToolLocationResolver;
		const project = { id: "project" } as unknown as ActionToolLocationResolver;
		assert.equal(resolveActionToolManager(server, project), project);
	});

	it("falls back to the SERVER manager when there is no project (server/global scope)", () => {
		const server = { id: "server" } as unknown as ActionToolLocationResolver;
		assert.equal(resolveActionToolManager(server, undefined), server);
		assert.equal(resolveActionToolManager(server, null), server);
	});

	it("dispatch honors the per-call (project) resolver over the constructor (server) one", async () => {
		// The constructor resolver points at a BUILTIN actions.js; a per-call
		// resolver points at a PROJECT-pack actions.js that shadows it. The pack
		// winner must run — proving the endpoint's session-project resolver wins.
		const builtin = path.join(tmp, "case-percall", "builtin");
		const projectPack = path.join(tmp, "case-percall", "project-pack");
		writeTool(builtin, "demo", { actionsJs: `export const actions = { retry: async () => ({ from: "server" }) };` });
		writeTool(projectPack, "demo", { actionsJs: `export const actions = { retry: async () => ({ from: "project" }) };` });
		const d = new ActionDispatcher(resolver(builtin, "demo"), { rate: null });
		// Default (constructor) resolver → builtin.
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { from: "server" });
		// Per-call project resolver → project pack winner.
		assert.deepEqual(
			await d.dispatch("sample_action", "retry", ctx(), {}, resolver(projectPack, "demo")),
			{ from: "project" },
		);
	});
});

describe("ActionDispatcher — cache + invalidation", () => {
	it("reuses a hot module, and invalidate() picks up updated handler source", async () => {
		// NOTE: uses an `.mjs` module so the native ESM loader honors the
		// mtime+epoch query cache-bust under the tsx test runner (tsx caches
		// transpiled `.js` by path, ignoring the query — a runner artifact; the
		// production gateway runs plain node where the `.js` query-bust works).
		const base = path.join(tmp, "case-invalidate");
		writeTool(base, "demo", {
			moduleName: "actions.mjs",
			actionsJs: `export const actions = { retry: async () => ({ v: 1 }) };`,
		});
		const d = new ActionDispatcher(resolver(base, "demo", { actionsModule: "actions.mjs" }), { rate: null });
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { v: 1 });

		// Rewrite the handler source at the same path. Without invalidate the
		// cache (mtime+epoch keyed) may still serve v1 under coarse mtime; after
		// invalidate the bumped epoch forces a fresh import and v2 wins.
		fs.writeFileSync(path.join(base, "demo", "actions.mjs"), `export const actions = { retry: async () => ({ v: 2 }) };`);
		d.invalidate();
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { v: 2 });
	});

	it("an invalidate() during an in-flight import never caches the STALE module under the fresh epoch", async () => {
		// Regression for the TOCTOU race (analog of the client renderer race): if
		// invalidate() runs WHILE loadModule's `await import(url)` is in flight, a
		// late read of this.epoch would cache the just-imported (stale) module as if
		// it belonged to the FRESH epoch — and under coarse mtime resolution the next
		// dispatch would then serve it. The epoch-snapshot guard must re-load with
		// the advanced epoch instead, so the stale handler is never served.
		const base = path.join(tmp, "case-inflight-race");
		const modPath = path.join(base, "demo", "actions.mjs");
		// v1 pauses at a top-level await so its SOURCE is committed (read + parsed)
		// before we rewrite the file — the in-flight import stays v1 while we mutate
		// the on-disk file underneath it.
		writeTool(base, "demo", {
			moduleName: "actions.mjs",
			actionsJs: `await new Promise((r) => setTimeout(r, 200));\nexport const actions = { retry: async () => ({ v: 1 }) };`,
		});
		// Pin a clean whole-second mtime so utimesSync round-trips EXACTLY (no
		// sub-second truncation): we then force the SAME mtime on v2, making the
		// epoch guard the ONLY thing that can distinguish stale from fresh — i.e.
		// the coarse-mtime case the epoch exists for. Without the guard the cache
		// hit (same mtime + same post-invalidate epoch) would serve stale v1.
		const fixed = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
		fs.utimesSync(modPath, fixed, fixed);

		const d = new ActionDispatcher(resolver(base, "demo", { actionsModule: "actions.mjs" }), { rate: null });

		// Start a dispatch; its import pauses at v1's top-level await (epoch 0).
		const inflight = d.dispatch("sample_action", "retry", ctx(), {});
		// Let the loader read + begin evaluating v1 (now parked at the TLA) BEFORE
		// we mutate the file, so the in-flight import is committed to v1.
		await new Promise((r) => setTimeout(r, 60));
		// Rewrite the handler to v2, force the SAME mtime, then invalidate WHILE the
		// v1 import is still in flight (cache cleared + epoch bumped to 1).
		fs.writeFileSync(modPath, `export const actions = { retry: async () => ({ v: 2 }) };`);
		fs.utimesSync(modPath, fixed, fixed);
		d.invalidate();

		// Let the in-flight v1 import resolve. With the guard it observes the fresh
		// epoch and re-loads v2 (never caching stale v1); we don't assert its return
		// value (the contract only promises it is not stale-cached).
		await inflight;

		// The pinning assertion: the NEXT dispatch must serve v2. Without the guard,
		// stale v1 was cached under epoch 1 and (same mtime) is served here → v1.
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { v: 2 });
	});
});
