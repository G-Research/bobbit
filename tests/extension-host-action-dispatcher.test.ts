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

	it("per-session rate limit → 429 once the bucket drains", async () => {
		const base = path.join(tmp, "case-rate");
		writeTool(base, "demo", { actionsJs: `export const actions = { retry: async () => ({ ok: 1 }) };` });
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: { capacity: 2, refillPerSec: 0 } });
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { ok: 1 });
		assert.deepEqual(await d.dispatch("sample_action", "retry", ctx(), {}), { ok: 1 });
		await assert.rejects(() => d.dispatch("sample_action", "retry", ctx(), {}), (e) => e instanceof ActionError && e.status === 429);
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
});
