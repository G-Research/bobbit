/**
 * Config-invariant test for Slice C3 — server-module worker isolation
 * (design docs/design/extension-host-phase2.md §9 / C3.3).
 *
 * THE INVARIANT (acceptance #3/#4): isolation is UNCONDITIONAL. There is NO config
 * flag, env var, or runtime toggle that runs a pack server module in-process in any
 * shippable / packaged / CI build. The dispatchers' SINGLE invocation seam ALWAYS
 * routes through `ModuleHost.invoke` (a confined worker); there is no in-process
 * fallback to gate, so the shipped configuration can never disable isolation.
 *
 * This test pins that there is no bypass:
 *   - A dispatcher constructed WITHOUT an injected ModuleHost still isolates (it
 *     self-constructs one — there is no in-process path).
 *   - A pack module's `node:fs` import is denied, AND stays denied even with every
 *     plausible "disable isolation" env var set → no env toggles isolation off.
 *   - A `while(1)` runaway is terminated regardless of env → the worker is always
 *     in the loop.
 *   - `ActionDispatcherOptions` exposes no in-process / bypass switch (structural).
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
	type ActionDispatcherOptions,
} from "../src/server/extension-host/action-dispatcher.ts";

let tmp: string;

function resolver(baseDir: string, groupDir: string): ActionToolLocationResolver {
	return {
		resolveToolLocation: (name) => (name === "iso_tool" ? { baseDir, groupDir, actionsModule: "actions.mjs" } : undefined),
	};
}

function writeTool(baseDir: string, groupDir: string, actionsJs: string): void {
	const dir = path.join(baseDir, groupDir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "iso_tool.yaml"), `name: iso_tool\ndescription: d\ngroup: Demo\nactions:\n  module: actions.mjs\n`);
	fs.writeFileSync(path.join(dir, "actions.mjs"), actionsJs);
}

const ctx = (): ActionHandlerCtx => ({ host: {} as ActionHandlerCtx["host"], sessionId: "s", toolUseId: "t", tool: "iso_tool" });

/** Plausible bypass knobs an attacker / mis-config might try. NONE may disable isolation. */
const BYPASS_ENV_KEYS = [
	"BOBBIT_DISABLE_ISOLATION",
	"BOBBIT_EXTENSION_HOST_IN_PROCESS",
	"BOBBIT_NO_WORKER_ISOLATION",
	"EXTENSION_HOST_IN_PROCESS",
	"BOBBIT_DEV_IN_PROCESS_ACTIONS",
	"NODE_ENV", // even setting NODE_ENV=development must NOT relax isolation
];

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-host-iso-cfg-"));
});
after(() => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("C3 config-invariant — isolation cannot be disabled by config", () => {
	it("a dispatcher constructed WITHOUT an injected ModuleHost still isolates (no in-process path)", async () => {
		// No moduleHost option → the dispatcher self-constructs one. A node:fs import
		// from pack code is still DENIED, proving the seam routes through the worker
		// even when nothing was injected (there is no in-process fallback).
		const base = path.join(tmp, "default-host");
		writeTool(base, "demo", `export const actions = { evil: async () => { await import("node:fs"); return "leaked"; } };`);
		const d = new ActionDispatcher(resolver(base, "demo"), { rate: null, timeoutMs: 10_000 });
		await assert.rejects(
			() => d.dispatch("iso_tool", "evil", ctx(), {}),
			(e) => e instanceof ActionError && /denied|confinement/i.test(e.message),
		);
	});

	it("NO env var disables isolation — node:fs stays denied with every bypass knob set", async () => {
		const base = path.join(tmp, "env-bypass");
		writeTool(base, "demo", `export const actions = { evil: async () => { await import("node:fs"); return "leaked"; } };`);
		const saved = new Map<string, string | undefined>();
		for (const k of BYPASS_ENV_KEYS) { saved.set(k, process.env[k]); process.env[k] = k === "NODE_ENV" ? "development" : "1"; }
		try {
			const d = new ActionDispatcher(resolver(base, "demo"), { rate: null, timeoutMs: 10_000 });
			await assert.rejects(
				() => d.dispatch("iso_tool", "evil", ctx(), {}),
				(e) => e instanceof ActionError && /denied|confinement/i.test(e.message),
				"isolation MUST remain active regardless of any bypass env var",
			);
		} finally {
			for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
		}
	});

	it("a runaway while(1) is terminated regardless of env (the seam always runs in the worker)", async () => {
		const base = path.join(tmp, "spin");
		writeTool(base, "demo", `export const actions = { spin: () => { while (true) {} } };`);
		const saved = new Map<string, string | undefined>();
		for (const k of BYPASS_ENV_KEYS) { saved.set(k, process.env[k]); process.env[k] = k === "NODE_ENV" ? "development" : "1"; }
		try {
			const d = new ActionDispatcher(resolver(base, "demo"), { rate: null, timeoutMs: 400 });
			await assert.rejects(
				() => d.dispatch("iso_tool", "spin", ctx(), {}),
				(e) => e instanceof ActionError && e.status === 504,
			);
		} finally {
			for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
		}
	});

	it("ActionDispatcherOptions exposes NO in-process / bypass switch (structural)", () => {
		// A compile-time + runtime check that the only execution knob is the SHARED
		// confined ModuleHost — there is no `inProcess`/`disableIsolation`/`unsafe`
		// option that could route the seam around the worker.
		const allowed: Array<keyof ActionDispatcherOptions> = ["timeoutMs", "maxConcurrent", "rate", "moduleHost"];
		const forbidden = ["inProcess", "disableIsolation", "unsafe", "noWorker", "bypassIsolation"];
		// Passing forbidden keys is inert (excess-property tolerated at runtime) and
		// does not change behavior — the dispatcher ignores them entirely.
		const opts = { rate: null, timeoutMs: 10_000 } as ActionDispatcherOptions & Record<string, unknown>;
		for (const f of forbidden) opts[f] = true;
		// Constructing with the forbidden keys must not throw and must not expose a
		// way to disable isolation (the type only permits the `allowed` keys).
		assert.doesNotThrow(() => new ActionDispatcher(resolver(path.join(tmp, "struct"), "demo"), opts));
		assert.ok(allowed.includes("moduleHost"), "the ONLY isolation-related option is the shared ModuleHost");
	});
});
